// Bearing Board — distribution server.
// Serves the static browser build AND the same-origin platform API:
//   GET  /api/v1/time                    platform time (round-trip sync)
//   POST /api/v1/sessions                create an authoritative table
//   GET  /api/v1/sessions/:id            snapshot (reconnect source of truth)
//   POST /api/v1/sessions/:id/commands   submit a validated command
//   GET  /api/v1/sessions/:id/replay     replay envelope
//
// The authoritative table runs the SAME rules.js as the client, in-process
// (the spec's "sandboxed authoritative JavaScript Game Script" role). All
// network input is validated for turn, bounds, payload size and rate;
// duplicate command IDs are rejected idempotently; client-supplied scores,
// winners and elapsed times are never trusted.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Rules from './js/rules.js';
import * as AI from './js/ai.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const MAX_SESSIONS = 500;
const MAX_BODY = 8 * 1024;
const HUMAN_SEAT = 0;

// ---------------------------------------------------------------------------
// Session store (in-memory, capped; compact JSON state)
// ---------------------------------------------------------------------------

const sessions = new Map();
let sessionCounter = 0;

function newSessionId() {
  sessionCounter += 1;
  return `bb-${Date.now().toString(36)}-${sessionCounter.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function evictOldSessions() {
  if (sessions.size <= MAX_SESSIONS) return;
  const byAge = [...sessions.values()].sort((a, b) => a.touchedAt - b.touchedAt);
  for (const s of byAge.slice(0, sessions.size - MAX_SESSIONS)) sessions.delete(s.id);
}

// Run every AI seat until a human action is required or the game ends.
function runAiOut(session) {
  let guard = 512;
  while (session.state.winner < 0 && guard-- > 0) {
    const st = session.state;
    const seat = st.phase === 'cube'
      ? (st.cube.pending.by + 1) % st.cfg.players
      : st.active;
    if (seat === HUMAN_SEAT) return;
    const cmd = AI.aiCommand(st, seat, session.aiDifficulty);
    if (!cmd) return;
    const r = Rules.applyCommand(st, cmd);
    if (!r.ok) return; // AI should never produce an illegal command
    session.state = r.state;
    session.log.push(cmd);
    session.eventLog.push(...r.events.map((e) => ({ ...e, tick: r.state.tick })));
    session.hashes.push(Rules.hashState(r.state));
    if (r.events.some((e) => e.type === 'gameOver')) return;
  }
}

function sessionView(session) {
  return {
    sessionId: session.id,
    state: session.state,
    hash: Rules.hashState(session.state),
    log: session.log,
    result: session.state.result,
    recentEvents: session.eventLog.slice(-30),
  };
}

// ---------------------------------------------------------------------------
// Rate limiting (per remote address, sliding window)
// ---------------------------------------------------------------------------

const rateBuckets = new Map();
function rateLimited(ip) {
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b || now - b.start > 10_000) { b = { start: now, count: 0 }; rateBuckets.set(ip, b); }
  b.count += 1;
  if (rateBuckets.size > 10_000) rateBuckets.clear();
  return b.count > 60;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function contentType(p) {
  switch (path.extname(p).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': case '.mjs': return 'application/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.opus': return 'audio/ogg';
    case '.txt': return 'text/plain; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('malformed JSON body')); }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const ip = req.socket.remoteAddress || 'unknown';
  if (rateLimited(ip)) return sendJSON(res, 429, { error: 'rate limited — slow down' });

  if (req.method === 'GET' && url === '/api/v1/time') {
    const now = Date.now();
    return sendJSON(res, 200, { epochMs: now, iso: new Date(now).toISOString() });
  }

  if (req.method === 'POST' && url === '/api/v1/sessions') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    const cfg = body?.cfg;
    const errors = Rules.validateConfig(cfg || {});
    if (errors.length) return sendJSON(res, 400, { error: `invalid config: ${errors.join('; ')}` });
    const id = newSessionId();
    const state = Rules.createGame(cfg);
    const session = {
      id, cfg: state.cfg, state,
      aiDifficulty: 'steady',
      log: [], hashes: [Rules.hashState(state)], eventLog: [],
      seenCmdIds: new Set(),
      createdAt: Date.now(), touchedAt: Date.now(),
    };
    // A seat-1 opening never happens (seat 0 starts), but keep the invariant.
    sessions.set(id, session);
    evictOldSessions();
    return sendJSON(res, 201, sessionView(session));
  }

  const m = url.match(/^\/api\/v1\/sessions\/([\w-]+)(\/commands|\/replay)?$/);
  if (!m) return sendJSON(res, 404, { error: 'unknown API route' });
  const session = sessions.get(m[1]);
  if (!session) return sendJSON(res, 404, { error: 'session not found or expired' });
  session.touchedAt = Date.now();

  if (req.method === 'GET' && !m[2]) return sendJSON(res, 200, sessionView(session));

  if (req.method === 'GET' && m[2] === '/replay') {
    return sendJSON(res, 200, {
      schema: 1,
      rulesVersion: Rules.RULES_VERSION,
      seed: session.cfg.seed,
      initialHash: session.hashes[0],
      commands: session.log,
      hashes: session.hashes,
      finalHash: session.hashes[session.hashes.length - 1],
      result: session.state.result,
    });
  }

  if (req.method === 'POST' && m[2] === '/commands') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    const cmd = body?.cmd;
    if (!cmd || typeof cmd.type !== 'string' || typeof cmd.id !== 'string' || cmd.id.length > 64) {
      return sendJSON(res, 400, { error: 'command must carry a type and a short id' });
    }
    // Clients may only ever speak for the human seat — never for rivals,
    // never claiming a winner, score, or elapsed time.
    if (cmd.player != null && cmd.player !== HUMAN_SEAT) {
      return sendJSON(res, 403, { error: 'commands may only act for seat 0' });
    }
    if (!['roll', 'move', 'pass', 'double', 'accept', 'decline', 'concede'].includes(cmd.type)) {
      return sendJSON(res, 400, { error: `unknown command "${cmd.type}"` });
    }
    // Idempotent duplicate rejection by command ID.
    if (session.seenCmdIds.has(cmd.id)) {
      return sendJSON(res, 200, { ...sessionView(session), duplicate: true, events: [] });
    }
    const before = session.eventLog.length;
    const r = Rules.applyCommand(session.state, cmd);
    if (!r.ok) {
      return sendJSON(res, 422, { error: r.events[0]?.reason || 'illegal command' });
    }
    session.seenCmdIds.add(cmd.id);
    if (session.seenCmdIds.size > 2000) {
      session.seenCmdIds = new Set([...session.seenCmdIds].slice(-1000));
    }
    session.state = r.state;
    session.log.push(cmd);
    session.eventLog.push(...r.events.map((e) => ({ ...e, tick: r.state.tick })));
    session.hashes.push(Rules.hashState(r.state));
    runAiOut(session);
    const events = session.eventLog.slice(before);
    return sendJSON(res, 200, { ...sessionView(session), events });
  }

  return sendJSON(res, 405, { error: 'method not allowed' });
}

async function serveStatic(req, res, urlPath) {
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(ROOT, urlPath.replace(/^\/+/, '')));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }
  try {
    const st = await stat(filePath);
    if (st.isDirectory()) throw Object.assign(new Error('dir'), { code: 'ENOENT' });
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': contentType(filePath) });
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    } else throw err;
  }
}

export function createAppServer(port = PORT) {
  const server = createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    const work = url.startsWith('/api/v1/') ? handleApi(req, res, url) : serveStatic(req, res, url);
    work.catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"internal error"}');
    });
  });
  server.listen(port, () => {
    console.log(`Bearing Board server listening on http://localhost:${port}`);
  });
  return server;
}

// Run directly: `node server.js` (imported by tests via createAppServer).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  createAppServer();
}
