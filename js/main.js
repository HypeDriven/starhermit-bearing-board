// Bearing Board — browser client: Three.js render, DOM UI shell, session
// controller, input (pointer/touch/keyboard/gamepad), persistence, platform.
//
// Architecture (per spec §5):
//   rules.js   — pure deterministic transitions (imported, never mutated here)
//   ai.js      — deterministic practice AI over the same legal-action API
//   content.js — versioned lessons/journey/daily/practice/challenge content
//   audio.js   — procedural buses; every cue has a visual/DOM twin
//   main.js    — session + render + ui + platform glue in this file.
// Rules state changes ONLY through Rules.applyCommand / the hosted session
// API. Rendering consumes immutable snapshots plus interpolation tweens.

import * as THREE from '../vendor/three.module.min.js';
import * as Rules from './rules.js';
import * as Content from './content.js';
import * as AI from './ai.js';
import * as Audio from './audio.js';

const BUILD_VERSION = '1.0.0';
const STORE_SETTINGS = 'bb.settings.v1';
const STORE_PROGRESS = 'bb.progress.v1';
const STORE_SNAPSHOT = 'bb.snapshot.v1';
const STORE_DAILY = 'bb.dailySession.v1';
const STORE_FUNNEL = 'bb.funnel.v1';

// ---------------------------------------------------------------------------
// Safe storage
// ---------------------------------------------------------------------------

const storage = (() => {
  try {
    const t = '__bb_test__';
    localStorage.setItem(t, '1');
    localStorage.removeItem(t);
    return localStorage;
  } catch (_) {
    const mem = new Map();
    return {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
    };
  }
})();

function readJSON(key, fallback) {
  try {
    const raw = storage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (_) { return fallback; }
}

function writeJSON(key, value) {
  try { storage.setItem(key, JSON.stringify(value)); } catch (_) {}
}

// Tiny FNV checksum for the cloud-save-style progress document.
function checksum(obj) {
  const s = JSON.stringify(obj);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Settings (per-game, persisted; declared defaults + player overrides)
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  audioEnabled: true,
  volume: { music: 0.45, effects: 0.8, ambience: 0.35, voice: 0.7 },
  quality: 'auto',            // auto | low | medium | high
  theme: 'caravan',
  reducedMotion: false,
  highContrast: false,
  bigText: false,
  leftHanded: false,
  haptics: true,
  toggleSelect: true,         // tap-tap selection vs press-and-hold drag
  timingAssist: 1,            // 1 | 1.5 | 2 multiplier for timed challenges
  bindings: {                 // desktop action bindings (declared defaults)
    roll: 'r', undo: 'u', hint: 'h', pause: 'Escape', cameraReset: 'c',
    confirm: 'Enter', cancel: 'Escape', prev: 'ArrowLeft', next: 'ArrowRight',
  },
  profile: { name: 'Guest Traveler' },
};

let settings = (() => {
  const loaded = readJSON(STORE_SETTINGS, {});
  const merged = { ...DEFAULT_SETTINGS, ...loaded };
  merged.volume = { ...DEFAULT_SETTINGS.volume, ...(loaded.volume || {}) };
  merged.bindings = { ...DEFAULT_SETTINGS.bindings, ...(loaded.bindings || {}) };
  merged.profile = { ...DEFAULT_SETTINGS.profile, ...(loaded.profile || {}) };
  return merged;
})();

function saveSettings() { writeJSON(STORE_SETTINGS, settings); }

function applySettings() {
  const b = document.body;
  b.classList.toggle('bb-high-contrast', !!settings.highContrast);
  b.classList.toggle('bb-reduced-motion', !!settings.reducedMotion);
  b.classList.toggle('bb-big-text', !!settings.bigText);
  b.classList.toggle('bb-left-handed', !!settings.leftHanded);
  Audio.setAudioEnabled(settings.audioEnabled);
  for (const bus of ['music', 'effects', 'ambience', 'voice']) Audio.setVolume(bus, settings.volume[bus]);
  if (rendererApi) rendererApi.setQuality(effectiveQuality());
}

function effectiveQuality() {
  if (settings.quality !== 'auto') return settings.quality;
  const coarse = matchMedia('(pointer: coarse)').matches;
  const small = Math.min(screen.width, screen.height) < 820;
  return coarse || small ? 'medium' : 'high';
}

// ---------------------------------------------------------------------------
// Progress: versioned, checksummed document. Never holds credentials.
// ---------------------------------------------------------------------------

const DEFAULT_PROGRESS = {
  version: 1,
  journey: {},          // defId -> {stars, bestTurns, goalsMet}
  lessons: {},          // defId -> {done}
  challenges: {},       // defId -> {done, best}
  daily: { days: [], lastDay: null },
  achievements: {},     // key -> {at}
  stats: { games: 0, wins: 0, hits: 0, sweeps: 0 },
};

function loadProgress() {
  const doc = readJSON(STORE_PROGRESS, null);
  if (!doc || doc.check !== checksum(doc.data)) return structuredClone(DEFAULT_PROGRESS);
  return { ...structuredClone(DEFAULT_PROGRESS), ...doc.data };
}

let progress = loadProgress();

function saveProgress() {
  writeJSON(STORE_PROGRESS, { data: progress, check: checksum(progress) });
}

function unlockAchievement(key) {
  if (progress.achievements[key]) return null; // idempotent
  const def = Content.ACHIEVEMENTS.find((a) => a.key === key);
  if (!def) return null;
  progress.achievements[key] = { at: new Date().toISOString() };
  saveProgress();
  Audio.playEvent('unlock');
  toast(`Achievement unlocked — ${def.label}`);
  announce(`Achievement unlocked: ${def.label}. ${def.desc}`, true);
  return def;
}

function journeyStars() {
  return Object.values(progress.journey).reduce((a, j) => a + (j.stars || 0), 0);
}

function masteryTitle() {
  const stars = journeyStars();
  let title = Content.MASTERY_TIERS[0].title;
  for (const tier of Content.MASTERY_TIERS) if (stars >= tier.stars) title = tier.title;
  return { stars, title };
}

// ---------------------------------------------------------------------------
// Anonymous funnel events (start, tutorial step, round end, retry, settings,
// error category). Random session id, aggregate only, no text payloads.
// ---------------------------------------------------------------------------

const funnel = (() => {
  let sid = readJSON(STORE_FUNNEL, null);
  if (!sid || sid.day !== Content.todayUTC()) {
    sid = { day: Content.todayUTC(), id: Math.random().toString(36).slice(2, 10), events: [] };
  }
  return {
    track(name, dim = '') {
      sid.events.push({ n: name, d: String(dim).slice(0, 24), t: Date.now() });
      if (sid.events.length > 200) sid.events.splice(0, sid.events.length - 200);
      writeJSON(STORE_FUNNEL, sid);
    },
  };
})();

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);
const screenEl = $('#bb-screen');
const liveEl = $('#bb-live');
const liveAssertiveEl = $('#bb-live-assertive');

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function announce(text, assertive = false) {
  const el = assertive ? liveAssertiveEl : liveEl;
  el.textContent = '';
  // Force a live-region change even for repeated text.
  requestAnimationFrame(() => { el.textContent = text; });
}

let toastTimer = 0;
function toast(text, ms = 2600) {
  const el = $('#bb-toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function vibrate(pattern) {
  if (settings.haptics && navigator.vibrate) navigator.vibrate(pattern);
}

function fmtClock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Platform: same-origin /api detection + server-time synchronization
// (round-trip adjusted). Offline start works fully without the API.
// ---------------------------------------------------------------------------

const platform = {
  available: false,
  timeOffsetMs: 0,
  async init() {
    try {
      const t0 = Date.now();
      const res = await fetch('api/v1/time', { cache: 'no-store' });
      const t1 = Date.now();
      if (!res.ok) return;
      const body = await res.json();
      if (typeof body.epochMs !== 'number') return;
      const rtt = t1 - t0;
      this.timeOffsetMs = body.epochMs - (t0 + rtt / 2);
      this.available = true;
    } catch (_) { this.available = false; }
  },
  now() { return new Date(Date.now() + this.timeOffsetMs); },
  todayUTC() { return Content.todayUTC(this.now()); },
  async api(path, opts = {}) {
    const res = await fetch(`api/v1/${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    let body = null;
    try { body = await res.json(); } catch (_) {}
    if (res.status === 429) throw new Error('The table is busy — try again in a moment.');
    if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
    return body;
  },
};

// ---------------------------------------------------------------------------
// Board layout model — single source shared by 3D meshes and DOM labels.
// Classic two-row travel board: points 0–11 near row (point 0 at the right),
// points 12–23 far row (point 12 at the left), rail as a center bar.
// ---------------------------------------------------------------------------

export const LAYOUT = {
  cols: 12,
  colGap: 0.82,
  barGap: 0.55,
  rowZ: 2.35,
  markR: 0.30,
  markH: 0.16,
  stackStep: 0.42,
  maxStackShown: 5,
};

function pointCol(point) { return point < 12 ? 11 - point : point - 12; }

function pointX(col) {
  const base = (col - 5.5) * LAYOUT.colGap;
  return base + (col >= 6 ? LAYOUT.barGap / 2 : -LAYOUT.barGap / 2);
}

// Center of a point column; `top` = far row.
function pointPos(point) {
  const col = pointCol(point);
  return { x: pointX(col), z: point < 12 ? LAYOUT.rowZ : -LAYOUT.rowZ, top: point >= 12 };
}

function markerPos(point, idx) {
  const p = pointPos(point);
  const dir = p.top ? 1 : -1; // stacks grow toward the bar
  const shown = Math.min(idx, LAYOUT.maxStackShown - 1);
  return { x: p.x, y: LAYOUT.markH / 2 + 0.001, z: p.z + dir * (0.34 + shown * LAYOUT.stackStep) };
}

function railPos(players, p, idx) {
  const lane = (p - (players - 1) / 2) * 0.34;
  const row = Math.floor(idx / 2);
  return { x: lane + (idx % 2 ? 0.17 : -0.17), y: LAYOUT.markH / 2, z: -1.55 + row * 0.42 };
}

function offPos(players, p, idx) {
  const laneZ = players <= 2 ? (p === 0 ? 1.6 : -1.6) : -2.4 + p * 1.6;
  return { x: 6.05, y: LAYOUT.markH / 2 + idx * (LAYOUT.markH + 0.01), z: laneZ };
}

// ---------------------------------------------------------------------------
// Session controller — owns one table from preparing → active → results.
// Local transport applies commands in-process; hosted transport posts them to
// the authoritative server and adopts the returned snapshots. In both cases
// the human only ever speaks in commands; state is rebuilt from snapshots.
// ---------------------------------------------------------------------------

const AI_THINK_MS = 650;

class Session {
  constructor(def, opts = {}) {
    this.def = def;
    this.cfg = defToConfig(def);
    this.transport = opts.transport || 'local';
    this.sessionId = opts.sessionId || null;
    this.humanSeats = new Set(opts.humanSeats || [0]);
    this.aiDifficulty = def.ai?.difficulty || 'steady';
    this.state = null;
    this.log = [];              // ordered commands (replay source of truth)
    this.snapshots = [];        // undo stack: {stateJSON, logLen, thinkingMs}
    this.events = [];           // recent events (for "while you were away")
    this.result = null;
    this.goalReport = null;
    this.thinkingMs = opts.thinkingMs || 0;
    this.thinkStart = 0;
    this.startedAt = Date.now();
    this.aiTimer = 0;
    this.paused = false;
    this.finished = false;
    this.tutorial = def.tutorial ? { step: 0, count: 0, done: false } : null;
  }

  start(snapshot) {
    if (snapshot && snapshot.cfg && Array.isArray(snapshot.log)) {
      // Deterministic resume: replay the command log onto a fresh game.
      const r = Rules.replay(snapshot.cfg, snapshot.log);
      if (r.finalHash === snapshot.hash) {
        this.state = r.state;
        this.log = snapshot.log.slice();
      }
    }
    if (!this.state) {
      this.state = Rules.createGame(this.cfg);
      this.log = [];
    }
    if (this.state.winner >= 0) this.finished = true;
    this.pushSnapshot();
  }

  get over() { return this.state.winner >= 0; }

  isHumanTurn() {
    if (this.over) return false;
    if (this.state.phase === 'cube') {
      const by = this.state.cube.pending?.by ?? 0;
      return this.humanSeats.has((by + 1) % this.state.cfg.players);
    }
    return this.humanSeats.has(this.state.active);
  }

  // Undo checkpoint: a human decision point (their roll phase or cube answer).
  pushSnapshot() {
    if (!this.def.mechanics?.undo || this.transport !== 'local') return;
    if (!this.isHumanTurn() || this.state.phase !== 'roll') return;
    this.snapshots.push({
      stateJSON: Rules.serialize(this.state),
      logLen: this.log.length,
      thinkingMs: this.thinkingMs,
    });
    if (this.snapshots.length > 40) this.snapshots.shift();
  }

  canUndo() {
    return this.def.mechanics?.undo === true && this.transport === 'local' &&
      this.snapshots.length > 1 && !this.over;
  }

  undo() {
    if (!this.canUndo()) return false;
    this.snapshots.pop(); // current position
    const snap = this.snapshots[this.snapshots.length - 1];
    this.state = Rules.deserialize(snap.stateJSON);
    this.log.length = snap.logLen;
    this.thinkingMs = snap.thinkingMs;
    this.thinkStart = this.isHumanTurn() ? Date.now() : 0;
    funnel.track('undo', this.def.kind);
    return true;
  }

  startThinking() {
    if (this.state.active === 0 || (this.state.phase === 'cube' && this.isHumanTurn())) {
      if (!this.thinkStart) this.thinkStart = Date.now();
    }
  }

  stopThinking() {
    if (this.thinkStart) {
      this.thinkingMs += Date.now() - this.thinkStart;
      this.thinkStart = 0;
    }
  }

  async dispatch(cmd) {
    if (this.over || this.paused) return { ok: false };
    cmd.id = cmd.id || Rules.makeCmdId('bb');
    this.stopThinking();
    if (this.transport === 'hosted') return this.dispatchHosted(cmd);
    const r = Rules.applyCommand(this.state, cmd);
    if (!r.ok) {
      const reason = r.events[0]?.reason || 'illegal action';
      Audio.playEvent('invalid');
      toast(`Not allowed: ${reason}`);
      announce(`Invalid action: ${reason}`, true);
      this.state = r.state; // invalid-action stats are authoritative
      return { ok: false, reason };
    }
    this.state = r.state;
    this.log.push(cmd);
    this.afterCommands(r.events);
    return { ok: true, events: r.events };
  }

  async dispatchHosted(cmd) {
    try {
      const body = await platform.api(`sessions/${this.sessionId}/commands`, {
        method: 'POST',
        body: JSON.stringify({ cmd }),
      });
      const newEvents = body.events || [];
      this.state = body.state;
      this.log = body.log || this.log;
      this.afterCommands(newEvents);
      return { ok: true, events: newEvents };
    } catch (err) {
      Audio.playEvent('invalid');
      toast(`Table error: ${err.message}`);
      announce(`Table error: ${err.message}`, true);
      return { ok: false, reason: err.message };
    }
  }

  afterCommands(events) {
    this.lastEvents = events;
    this.events.push(...events);
    if (this.events.length > 80) this.events.splice(0, this.events.length - 80);
    this.watchTutorial(events);
    for (const ev of events) {
      if (ev.type === 'gameOver') { this.finish(ev.result); break; }
    }
    if (!this.over) {
      this.pushSnapshot();
      this.startThinking();
      this.persistSnapshot();
    }
  }

  watchTutorial(events) {
    const t = this.tutorial;
    if (!t || t.done) return;
    const steps = this.def.tutorial.steps;
    const step = steps[t.step];
    if (!step) { t.done = true; return; }
    const matched = events.some((ev) => {
      if (ev.player !== undefined && !this.humanSeats.has(ev.player)) return false;
      switch (step.expect) {
        case 'roll': return ev.type === 'roll';
        case 'move': return ev.type === 'move';
        case 'hit': return ev.type === 'hit';
        case 'enter': return ev.type === 'move' && ev.from === 'rail';
        case 'bearOff': return ev.type === 'bearOff';
        case 'double': return ev.type === 'double';
        default: return false;
      }
    });
    if (!matched) return;
    t.count += 1;
    funnel.track('tutorial_step', `${this.def.id}:${t.step}`);
    if (t.count >= (step.times || 1)) {
      t.step += 1;
      t.count = 0;
      if (t.step >= steps.length) t.done = true;
    }
  }

  // Pause: freeze solo simulation and AI scheduling (spec: backgrounding
  // pauses solo play; hosted tables are read-only until the snapshot refresh).
  pause() {
    this.paused = true;
    clearTimeout(this.aiTimer);
    this.stopThinking();
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.startThinking();
    this.scheduleAI();
  }

  scheduleAI(delay = AI_THINK_MS) {
    clearTimeout(this.aiTimer);
    if (this.over || this.paused || this.transport !== 'local') return;
    if (this.isHumanTurn()) return;
    const ms = settings.reducedMotion ? 180 : delay;
    this.aiTimer = setTimeout(() => this.aiStep(), ms);
  }

  aiStep() {
    if (this.over || this.paused) return;
    const seat = this.state.phase === 'cube'
      ? (this.state.cube.pending.by + 1) % this.state.cfg.players
      : this.state.active;
    if (this.humanSeats.has(seat)) return;
    const cmd = AI.aiCommand(this.state, seat, this.aiDifficulty);
    if (!cmd) return;
    this.dispatch(cmd).then(() => {
      updateAfterStateChange();
      this.scheduleAI();
    });
  }

  persistSnapshot() {
    if (this.transport !== 'local' || this.over) return;
    writeJSON(STORE_SNAPSHOT, {
      version: 1,
      cfg: this.cfg,
      log: this.log,
      hash: Rules.hashState(this.state),
      defId: this.def.id,
      defKind: this.def.kind,
      def: this.def,
      thinkingMs: this.thinkingMs,
      savedAt: new Date().toISOString(),
    });
  }

  clearPersisted() { storage.removeItem(STORE_SNAPSHOT); }

  // Replay envelope per spec §5: schema, build/content version, seed, initial
  // hash, ordered commands, periodic hashes, terminal result.
  replayEnvelope() {
    const r = Rules.replay(this.cfg, this.log);
    return {
      schema: 1,
      build: BUILD_VERSION,
      contentVersion: Content.CONTENT_VERSION,
      rulesVersion: Rules.RULES_VERSION,
      seed: this.cfg.seed,
      initialHash: r.hashes[0],
      timestampOffset: new Date(this.startedAt).toISOString(),
      commands: this.log.slice(),
      hashes: r.hashes,
      finalHash: r.finalHash,
      result: this.state.result,
    };
  }

  hint() {
    if (!this.def.mechanics?.hint || !this.isHumanTurn()) return null;
    const h = AI.suggestHint(this.state, this.state.active);
    if (h) { toast(h.text); announce(`Hint: ${h.text}`); }
    return h;
  }

  finish(result) {
    this.stopThinking();
    this.finished = true;
    this.result = result;
    this.goalReport = evaluateGoals(this.def, this.state, this.thinkingMs);
    this.clearPersisted();
    this.newAchievements = applyOutcome(this, result) || [];
  }
}

function defToConfig(def) {
  return {
    id: def.id,
    version: def.version || 1,
    kind: def.kind,
    ruleset: def.ruleset,
    players: def.players,
    seed: def.seed >>> 0,
    options: def.options || {},
    goals: def.goals || { win: true },
    layout: def.layout,
    scriptedDice: def.scriptedDice,
  };
}

// ---------------------------------------------------------------------------
// Goals, stars, achievements
// ---------------------------------------------------------------------------

function evaluateGoals(def, state, thinkingMs) {
  const goals = def.goals || { win: true };
  const res = state.result;
  const me = 0;
  const won = res.winner === me;
  const hitsAgainst = state.stats.hits.reduce((a, h, p) => (p === me ? a : a + h), 0);
  const timeLimit = goals.maxTimeSec ? goals.maxTimeSec * settings.timingAssist : null;
  const items = [];
  const add = (key, label, met) => items.push({ key, label, met: !!met });
  if (goals.win !== false) add('win', won ? 'You won the table' : 'Win the table', won);
  if (goals.maxTurns) add('maxTurns', `Finish within ${goals.maxTurns} turns (${state.turnNum})`, state.turnNum <= goals.maxTurns);
  if (goals.minHits) add('minHits', `Strike at least ${goals.minHits} markers (${state.stats.hits[me]})`, state.stats.hits[me] >= goals.minHits);
  if (goals.minPoints) add('minPoints', `Win at stakes of ${goals.minPoints}+ (${res.points})`, won && res.points >= goals.minPoints);
  if (goals.maxHitsAgainst != null) add('maxHitsAgainst', `Be struck at most ${goals.maxHitsAgainst} times (${hitsAgainst})`, hitsAgainst <= goals.maxHitsAgainst);
  if (timeLimit) add('maxTimeSec', `Think for under ${Math.round(timeLimit / 60)} min (${fmtClock(thinkingMs)})`, thinkingMs <= timeLimit * 1000);
  const complete = items.length > 0 && items[0].met;
  const allMet = items.every((i) => i.met);
  return { items, won, complete, allMet };
}

function starsFor(def, report, state, thinkingMs) {
  if (!report.won) return 0;
  let stars = 1;
  if (report.allMet) stars += 1;
  const par = def.par || {};
  const parOk = (!par.turns || state.turnNum <= par.turns) &&
    (!par.timeSec || thinkingMs <= par.timeSec * 1000 * settings.timingAssist);
  if (parOk) stars += 1;
  return stars;
}

function applyOutcome(session, result) {
  const { def, state, goalReport } = session;
  const me = 0;
  const won = result.winner === me;

  progress.stats.games += 1;
  if (won) progress.stats.wins += 1;
  progress.stats.hits += state.stats.hits[me];

  const newly = [];
  const push = (key) => { const a = unlockAchievement(key); if (a) newly.push(a); };

  if (won) push('first_win');
  if (won && result.factor > 1) { progress.stats.sweeps += 1; push('first_sweep'); }
  if (progress.stats.hits >= 50) push('hitter_50');
  if (progress.stats.games >= 100) push('hundred_tables');
  if (won && state.cfg.ruleset === 'circuit' && state.cfg.players === 4) push('circuit_champion');
  if (won && result.cubeValue >= 4) push('cube_closer');

  if (def.kind === 'journey') {
    const stars = starsFor(def, goalReport, state, session.thinkingMs);
    const prev = progress.journey[def.id] || { stars: 0 };
    if (stars > prev.stars || !progress.journey[def.id]) {
      progress.journey[def.id] = {
        stars: Math.max(stars, prev.stars || 0),
        bestTurns: Math.min(prev.bestTurns ?? 9999, state.turnNum),
        goalsMet: goalReport.allMet || !!prev.goalsMet,
      };
    }
    const done = Object.keys(progress.journey).length;
    if (done >= 20) push('journey_half');
    if (done >= Content.JOURNEY.length) push('journey_full');
  }

  if (def.kind === 'learn' && (session.tutorial?.done || won)) {
    progress.lessons[def.id] = { done: true };
  }

  if (def.kind === 'challenge' && goalReport.complete && goalReport.allMet) {
    progress.challenges[def.id] = { done: true, best: state.turnNum };
  }

  if (def.kind === 'daily') {
    const day = def.id.replace('daily-', '');
    if (!progress.daily.days.includes(day) && won) {
      progress.daily.days.push(day);
      progress.daily.lastDay = day;
    }
    if (progress.daily.days.length >= 7) push('daily_streak_7');
  }

  saveProgress();
  funnel.track('round_end', `${def.kind}:${won ? 'win' : 'loss'}`);
  return newly;
}

// ---------------------------------------------------------------------------
// Renderer — Three.js scene: leather field, wood frame, brass fittings.
// Separate layers: environment (0), gameplay (1), selection/ghosts (2),
// effects (3). Raycasts only ever run against explicit interaction meshes.
// ---------------------------------------------------------------------------

const LAYER_ENV = 0, LAYER_GAME = 1, LAYER_SEL = 2, LAYER_FX = 3;

const FRAMING = { tiltDeg: 54, halfW: 7.1, halfH: 3.55, lookX: 0.35, lookZ: 0.1, fov: 42 };

function makeLeatherTexture(base = '#7a4a2a') {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, 128, 128);
  const rng = Rules.createRng(Rules.hashSeed('leather'));
  for (let i = 0; i < 2600; i++) {
    const v = rng.next();
    g.fillStyle = `rgba(${v > 0.5 ? '255,235,200' : '10,5,0'},${0.03 + rng.next() * 0.05})`;
    g.fillRect(rng.int(128), rng.int(128), 1 + rng.int(2), 1 + rng.int(2));
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 2);
  return tex;
}

function createRenderer(canvas) {
  let renderer = null;
  let scene = null;
  let camera = null;
  let quality = 'medium';
  let theme = Content.themeByKey('caravan');
  let contextLost = false;

  // Scene groups
  let boardGroup = null;      // environment
  let markerGroup = null;     // gameplay markers
  let selGroup = null;        // selection rings + target discs
  let fxGroup = null;         // particles
  let interactive = [];       // raycast targets only
  let markerMeshes = new Map(); // locationKey -> mesh
  let playerMats = [];
  let tweens = [];
  let camTween = null;
  let selPulse = 0;

  // Particles (bounded pool)
  const MAX_PARTICLES = 240;
  let particles = null;

  function init() {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: quality !== 'low', powerPreference: 'default' });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(FRAMING.fov, 1, 0.1, 100);
    camera.position.set(0, 12, 9);
    camera.lookAt(FRAMING.lookX, 0, FRAMING.lookZ);

    boardGroup = new THREE.Group();
    markerGroup = new THREE.Group();
    selGroup = new THREE.Group();
    fxGroup = new THREE.Group();
    scene.add(boardGroup, markerGroup, selGroup, fxGroup);

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      contextLost = true;
      announce('Graphics context lost — rebuilding the board.', true);
    });
    canvas.addEventListener('webglcontextrestored', () => {
      contextLost = false;
      rebuildAll();
    });

    buildLights();
    buildParticles();
    setTheme(theme.key);
    applyQuality();
    resize();
  }

  function buildLights() {
    // One dominant warm key, soft cool fill, contact-friendly ambient.
    const key = new THREE.DirectionalLight(0xfff1d6, 2.4);
    key.position.set(4, 9, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -9; key.shadow.camera.right = 9;
    key.shadow.camera.top = 6; key.shadow.camera.bottom = -6;
    key.name = 'keyLight';
    scene.add(key);
    const fill = new THREE.HemisphereLight(0x8fa3c8, 0x2a1c12, 0.55);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xc8d4f0, 0.5);
    rim.position.set(-5, 6, -4);
    scene.add(rim);
  }

  function setTheme(key) {
    theme = Content.themeByKey(key);
    scene.background = new THREE.Color(theme.sky);
    scene.fog = new THREE.Fog(theme.fog, 18, 34);
    playerMats = theme.players.map((color, i) => new THREE.MeshStandardMaterial({
      color, roughness: 0.32, metalness: i === 0 ? 0.05 : 0.12,
    }));
    rebuildBoard();
    rebuildMarkers();
  }

  function rebuildAll() {
    // GPU resources rebuilt from retained CPU descriptors (theme + state).
    disposeGroup(boardGroup);
    disposeGroup(markerGroup);
    disposeGroup(selGroup);
    markerMeshes.clear();
    buildParticles();
    setTheme(theme.key);
    applyQuality();
    resize();
    if (lastState) sync(lastState, []);
  }

  function disposeGroup(group) {
    group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    });
    group.clear();
    interactive = [];
  }

  function buildBoard() {
    const feltTex = makeLeatherTexture(`#${theme.felt.toString(16).padStart(6, '0')}`);
    const frameMat = new THREE.MeshStandardMaterial({ color: theme.frame, roughness: 0.55, metalness: 0.08 });
    const feltMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: feltTex, roughness: 0.9, metalness: 0 });
    const brassMat = new THREE.MeshStandardMaterial({ color: theme.accent, roughness: 0.3, metalness: 0.85 });
    const railMat = new THREE.MeshStandardMaterial({ color: theme.rail, roughness: 0.7 });

    // Wooden frame (four rails) + leather field.
    const W = 14.6, D = 7.6, rimW = 0.55;
    const mk = (w, d, x, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.42, d), frameMat);
      m.position.set(x, -0.21, z);
      m.receiveShadow = true;
      boardGroup.add(m);
    };
    mk(W, rimW, 0, -D / 2 + rimW / 2);
    mk(W, rimW, 0, D / 2 - rimW / 2);
    mk(rimW, D, -W / 2 + rimW / 2, 0);
    mk(rimW, D, W / 2 - rimW / 2, 0);

    const field = new THREE.Mesh(new THREE.BoxGeometry(W - rimW * 2, 0.3, D - rimW * 2), feltMat);
    field.position.y = -0.15;
    field.receiveShadow = true;
    boardGroup.add(field);

    // Center bar (the rail for struck markers).
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.34, D - rimW * 2), railMat);
    bar.position.y = 0.02;
    boardGroup.add(bar);

    // Brass corner caps + studs.
    const capGeo = new THREE.CylinderGeometry(0.22, 0.26, 0.1, 12);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const cap = new THREE.Mesh(capGeo, brassMat);
      cap.position.set(sx * (W / 2 - 0.3), 0.05, sz * (D / 2 - 0.3));
      boardGroup.add(cap);
    }

    // Triangular points: alternating two leathers, pointing toward the bar.
    const triGeo = new THREE.CylinderGeometry(0.015, 0.38, 2.0, 3, 1);
    triGeo.rotateY(Math.PI / 6);
    const matA = new THREE.MeshStandardMaterial({ color: theme.board, roughness: 0.8 });
    const matB = new THREE.MeshStandardMaterial({ color: theme.boardAlt, roughness: 0.8 });
    for (let point = 0; point < Rules.POINTS; point++) {
      const pos = pointPos(point);
      const tri = new THREE.Mesh(triGeo, (pointCol(point) % 2 ? matA : matB));
      tri.rotation.x = pos.top ? -Math.PI / 2 : Math.PI / 2;
      const dir = pos.top ? 1 : -1;
      tri.position.set(pos.x, 0.01, pos.z + dir * 1.0);
      tri.receiveShadow = true;
      boardGroup.add(tri);

      // Explicit interaction volume for this point (raycast layer only).
      const hit = new THREE.Mesh(
        new THREE.BoxGeometry(0.78, 0.9, 2.6),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      hit.position.set(pos.x, 0.3, pos.z + dir * 0.9);
      hit.userData = { kind: 'point', point };
      hit.layers.set(LAYER_GAME);
      boardGroup.add(hit);
      interactive.push(hit);
    }

    // Rail interaction volume.
    const railHit = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 6.2), new THREE.MeshBasicMaterial({ visible: false }));
    railHit.position.set(0, 0.3, 0);
    railHit.userData = { kind: 'rail' };
    railHit.layers.set(LAYER_GAME);
    boardGroup.add(railHit);
    interactive.push(railHit);

    // Off trays (one lane per seat, right-hand side).
    const trayGeo = new THREE.BoxGeometry(0.85, 0.1, 1.3);
    for (let p = 0; p < 4; p++) {
      const pos = offPos(4, p, 0);
      const tray = new THREE.Mesh(trayGeo, railMat);
      tray.position.set(pos.x, 0.0, pos.z);
      boardGroup.add(tray);
      const hit = new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.4, 1.4), new THREE.MeshBasicMaterial({ visible: false }));
      hit.position.set(pos.x, 0.5, pos.z);
      hit.userData = { kind: 'off' };
      hit.layers.set(LAYER_GAME);
      boardGroup.add(hit);
      interactive.push(hit);
    }
  }

  function rebuildBoard() {
    // Preserve marker group; rebuild environment only.
    const keepMarkers = markerGroup.children.slice();
    const keepSel = selGroup.children.slice();
    disposeGroup(boardGroup);
    buildBoard();
    keepMarkers.forEach((m) => markerGroup.add(m));
    keepSel.forEach((m) => selGroup.add(m));
  }

  // --- markers -------------------------------------------------------------

  const markerGeo = new THREE.CylinderGeometry(LAYOUT.markR, LAYOUT.markR, LAYOUT.markH, 22);
  const capRingGeo = new THREE.TorusGeometry(LAYOUT.markR * 0.62, 0.022, 8, 22);

  function desiredMarkers(state) {
    const out = [];
    for (let i = 0; i < Rules.POINTS; i++) {
      const cell = state.points[i];
      if (cell.owner < 0 || cell.count === 0) continue;
      const shown = Math.min(cell.count, LAYOUT.maxStackShown);
      for (let k = 0; k < shown; k++) {
        const pos = markerPos(i, k);
        if (cell.count > LAYOUT.maxStackShown && k === shown - 1) pos.y += 0.05;
        out.push({ key: `p${i}:${k}`, pos, player: cell.owner, point: i, overflow: cell.count > LAYOUT.maxStackShown && k === shown - 1 });
      }
    }
    state.rail.forEach((n, p) => {
      for (let k = 0; k < Math.min(n, 10); k++) {
        out.push({ key: `r${p}:${k}`, pos: railPos(state.cfg.players, p, k), player: p, rail: true });
      }
    });
    state.off.forEach((n, p) => {
      for (let k = 0; k < n; k++) {
        out.push({ key: `o${p}:${k}`, pos: offPos(state.cfg.players, p, k), player: p, off: true });
      }
    });
    return out;
  }

  function rebuildMarkers(state) {
    if (!state) return;
    disposeChildren(markerGroup);
    markerMeshes.clear();
    for (const d of desiredMarkers(state)) {
      const mesh = new THREE.Mesh(markerGeo, playerMats[d.player] || playerMats[0]);
      mesh.position.set(d.pos.x, d.pos.y, d.pos.z);
      mesh.castShadow = true;
      mesh.layers.set(LAYER_GAME);
      const ring = new THREE.Mesh(capRingGeo, new THREE.MeshStandardMaterial({
        color: theme.accent, roughness: 0.35, metalness: 0.8,
      }));
      ring.rotation.x = Math.PI / 2;
      ring.position.y = LAYOUT.markH / 2;
      mesh.add(ring);
      mesh.userData = { player: d.player, point: d.point, rail: d.rail, off: d.off };
      markerGroup.add(mesh);
      markerMeshes.set(d.key, mesh);
    }
  }

  function disposeChildren(group) {
    for (const child of [...group.children]) {
      child.traverse((o) => { if (o.material && o.geometry !== markerGeo && o.geometry !== capRingGeo) o.material.dispose?.(); });
      group.remove(child);
    }
  }

  let lastState = null;

  // Sync scene to an immutable snapshot; animate from event-implied origins.
  function sync(state, events = []) {
    lastState = state;
    const movedFrom = new Map(); // 'point:x' or 'rail:p' -> count of animated movers
    if (!settings.reducedMotion) {
      for (const ev of events) {
        if (ev.type === 'move' || ev.type === 'hit') {
          const k = ev.from === 'rail' ? `rail:${ev.player}` : `point:${ev.from}`;
          movedFrom.set(k, (movedFrom.get(k) || 0) + 1);
        }
      }
    }
    rebuildMarkers(state);
    // Slide moved markers from their origin toward their final slot.
    if (movedFrom.size) {
      for (const ev of events) {
        if (ev.type !== 'move' && ev.type !== 'hit') continue;
        const toKey = ev.to === 'off'
          ? `o${ev.player}:${Math.max(0, state.off[ev.player] - 1)}`
          : `p${ev.to}:${Math.max(0, Math.min(state.points[ev.to].count, LAYOUT.maxStackShown) - 1)}`;
        const mesh = markerMeshes.get(toKey);
        if (!mesh) continue;
        let from;
        if (ev.from === 'rail') from = railPos(state.cfg.players, ev.player, state.rail[ev.player]);
        else {
          const cell = state.points[ev.from];
          from = markerPos(ev.from, Math.max(0, Math.min(cell.count, LAYOUT.maxStackShown) - 1));
        }
        tweenPosition(mesh, new THREE.Vector3(from.x, from.y + 0.25, from.z), 320);
      }
    }
    // Event-tiered effects: hit/bearoff sparks, win confetti.
    for (const ev of events) {
      if (ev.type === 'hit') {
        const pos = pointPos(ev.point);
        burst(pos.x, 0.35, pos.z, theme.accent, 26);
        shakeCamera(0.06);
      } else if (ev.type === 'bearOff') {
        burst(6.05, 0.5, 0, 0xffe9a8, 12);
      } else if (ev.type === 'gameOver') {
        burst(0, 1.2, 0, theme.accent, 90);
        burst(2, 1.0, 1.5, 0xffffff, 50);
        shakeCamera(0.1);
      }
    }
  }

  // --- selection / target preview -------------------------------------------

  const originRingGeo = new THREE.RingGeometry(0.36, 0.5, 28);
  const targetDiscGeo = new THREE.CircleGeometry(0.3, 24);
  const targetRingGeo = new THREE.RingGeometry(0.3, 0.42, 24);

  function clearSelection() {
    disposeChildren(selGroup);
  }

  function setSelection(origin, targets, hitTargets) {
    clearSelection();
    const mkFlat = (geo, color, opacity) => {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color, transparent: true, opacity, depthWrite: false,
      }));
      m.rotation.x = -Math.PI / 2;
      m.layers.set(LAYER_SEL);
      return m;
    };
    if (origin) {
      const ring = mkFlat(originRingGeo, 0xffd97a, 0.95);
      ring.name = 'originRing';
      ring.position.set(origin.x, 0.02, origin.z);
      selGroup.add(ring);
    }
    for (const t of targets) {
      const isHit = hitTargets?.some((h) => h.x === t.x && h.z === t.z);
      const disc = mkFlat(targetDiscGeo, isHit ? 0xe06a4a : 0x7ac86a, 0.4);
      disc.position.set(t.x, 0.02, t.z);
      disc.name = 'targetDisc';
      selGroup.add(disc);
      const ring = mkFlat(targetRingGeo, isHit ? 0xe06a4a : 0x9ae08a, 0.85);
      ring.position.set(t.x, 0.025, t.z);
      ring.name = 'targetRing';
      selGroup.add(ring);
    }
  }

  // --- tweens / camera --------------------------------------------------------

  function tweenPosition(mesh, from, durMs) {
    const to = mesh.position.clone();
    mesh.position.copy(from);
    tweens.push({ mesh, from: from.clone(), to, t: 0, dur: durMs / 1000 });
  }

  function settle() {
    for (const tw of tweens) tw.mesh.position.copy(tw.to);
    tweens = [];
    if (camTween) { camera.position.copy(camTween.to); camera.lookAt(FRAMING.lookX, 0, FRAMING.lookZ); camTween = null; }
  }

  let shakeAmp = 0;
  function shakeCamera(amp) {
    if (settings.reducedMotion) return;
    shakeAmp = Math.max(shakeAmp, amp);
  }

  function introCamera() {
    if (settings.reducedMotion || !camera) return;
    const target = cameraHome();
    camera.position.set(target.x, target.y + 3.5, target.z + 3.5);
    camera.lookAt(FRAMING.lookX, 0, FRAMING.lookZ);
    camTween = { from: camera.position.clone(), to: target, t: 0, dur: 0.9 };
  }

  function cameraHome() {
    const vfov = (FRAMING.fov * Math.PI) / 180;
    const aspect = camera.aspect || 1;
    const dist = Math.max(
      FRAMING.halfH / Math.tan(vfov / 2),
      FRAMING.halfW / (Math.tan(vfov / 2) * aspect),
    ) + 1.2;
    const tilt = (FRAMING.tiltDeg * Math.PI) / 180;
    return new THREE.Vector3(FRAMING.lookX, Math.sin(tilt) * dist, Math.cos(tilt) * dist + FRAMING.lookZ);
  }

  function resize() {
    if (!renderer) return;
    const w = canvas.clientWidth || innerWidth;
    const h = canvas.clientHeight || innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (!camTween) {
      camera.position.copy(cameraHome());
      camera.lookAt(FRAMING.lookX, 0, FRAMING.lookZ);
    }
    renderer.setSize(w, h, false);
    applyQuality();
  }

  function applyQuality() {
    if (!renderer) return;
    const dprCap = quality === 'low' ? 1 : quality === 'medium' ? 1.5 : 2;
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, dprCap));
    const key = scene.getObjectByName('keyLight');
    if (key) key.castShadow = quality === 'high';
    renderer.shadowMap.enabled = quality === 'high';
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }

  function setQuality(q) {
    if (q === quality) return;
    quality = q;
    if (renderer) applyQuality();
  }

  // --- particles ----------------------------------------------------------------

  function buildParticles() {
    if (particles) { fxGroup.remove(particles.points); particles.geo.dispose(); particles.mat.dispose(); }
    const geo = new THREE.BufferGeometry();
    const posArr = new Float32Array(MAX_PARTICLES * 3);
    const colArr = new Float32Array(MAX_PARTICLES * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
    const mat = new THREE.PointsMaterial({ size: 0.09, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false });
    const points = new THREE.Points(geo, mat);
    points.layers.set(LAYER_FX);
    points.frustumCulled = false;
    // Cosmetic effects never intercept raycasts.
    points.raycast = () => {};
    fxGroup.add(points);
    particles = {
      geo, mat, points,
      data: Array.from({ length: MAX_PARTICLES }, () => ({ life: 0, x: 0, y: -99, z: 0, vx: 0, vy: 0, vz: 0, r: 1, g: 1, b: 1 })),
      cursor: 0,
    };
  }

  function burst(x, y, z, color, n) {
    if (settings.reducedMotion || !particles) return;
    const c = new THREE.Color(color);
    const rng = Rules.createRng(Rules.hashSeed(`fx:${x}:${z}:${performance.now() | 0}`));
    for (let i = 0; i < n; i++) {
      const p = particles.data[particles.cursor];
      particles.cursor = (particles.cursor + 1) % MAX_PARTICLES;
      const a = rng.next() * Math.PI * 2;
      const sp = 1.2 + rng.next() * 2.2;
      p.life = 0.55 + rng.next() * 0.4;
      p.x = x; p.y = y; p.z = z;
      p.vx = Math.cos(a) * sp; p.vz = Math.sin(a) * sp; p.vy = 1.6 + rng.next() * 2.0;
      p.r = c.r; p.g = c.g; p.b = c.b;
    }
  }

  function updateParticles(dt) {
    if (!particles) return;
    const pos = particles.geo.attributes.position.array;
    const col = particles.geo.attributes.color.array;
    let any = false;
    particles.data.forEach((p, i) => {
      if (p.life > 0) {
        any = true;
        p.life -= dt;
        p.vy -= 6.5 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        if (p.y < 0.03) { p.y = 0.03; p.vy *= -0.35; p.vx *= 0.7; p.vz *= 0.7; }
        const fade = Math.max(0, Math.min(1, p.life * 2));
        pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
        col[i * 3] = p.r * fade; col[i * 3 + 1] = p.g * fade; col[i * 3 + 2] = p.b * fade;
      } else if (pos[i * 3 + 1] > -50) {
        pos[i * 3 + 1] = -99;
      }
    });
    if (any) {
      particles.geo.attributes.position.needsUpdate = true;
      particles.geo.attributes.color.needsUpdate = true;
    }
  }

  // --- picking ------------------------------------------------------------------

  const raycaster = new THREE.Raycaster();
  raycaster.layers.set(LAYER_GAME);
  const pointerV = new THREE.Vector2();

  function pick(clientX, clientY) {
    if (!camera) return null;
    const rect = canvas.getBoundingClientRect();
    pointerV.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointerV.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointerV, camera);
    const hits = raycaster.intersectObjects(interactive, false);
    return hits.length ? hits[0].object.userData : null;
  }

  // --- frame loop -----------------------------------------------------------------

  let rafId = 0;
  let lastT = 0;
  let running = false;

  function frame(t) {
    rafId = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (t - lastT) / 1000 || 0.016);
    lastT = t;
    // Tweens
    if (tweens.length) {
      for (const tw of tweens) {
        tw.t = Math.min(1, tw.t + dt / tw.dur);
        const e = 1 - Math.pow(1 - tw.t, 3); // easeOutCubic
        tw.mesh.position.lerpVectors(tw.from, tw.to, e);
      }
      tweens = tweens.filter((tw) => tw.t < 1);
    }
    if (camTween) {
      camTween.t = Math.min(1, camTween.t + dt / camTween.dur);
      const e = 1 - Math.pow(1 - camTween.t, 3);
      camera.position.lerpVectors(camTween.from, camTween.to, e);
      camera.lookAt(FRAMING.lookX, 0, FRAMING.lookZ);
      if (camTween.t >= 1) camTween = null;
    }
    // Selection pulse (time-based, never frame-count based)
    selPulse += dt;
    const pulse = 0.65 + Math.sin(selPulse * 4) * 0.3;
    selGroup.traverse((o) => {
      if (o.name === 'targetRing') o.material.opacity = pulse;
      if (o.name === 'originRing') o.material.opacity = 0.6 + pulse * 0.35;
    });
    if (shakeAmp > 0.001) {
      const s = shakeAmp;
      camera.position.x += (Math.random() - 0.5) * s;
      camera.position.y += (Math.random() - 0.5) * s * 0.6;
      shakeAmp *= Math.pow(0.001, dt * 2.2);
    } else if (shakeAmp !== 0) {
      shakeAmp = 0;
      if (!camTween) { camera.position.copy(cameraHome()); camera.lookAt(FRAMING.lookX, 0, FRAMING.lookZ); }
    }
    updateParticles(dt);
    renderer.render(scene, camera);
  }

  function startLoop() {
    if (running || contextLost) return;
    running = true;
    lastT = performance.now();
    rafId = requestAnimationFrame(frame);
  }

  function stopLoop() {
    running = false;
    cancelAnimationFrame(rafId);
  }

  function pointScreenPos(point) {
    const pos = pointPos(point);
    const v = new THREE.Vector3(pos.x, 0.2, pos.z).project(camera);
    const rect = canvas.getBoundingClientRect();
    return {
      x: rect.left + (v.x + 1) / 2 * rect.width,
      y: rect.top + (-v.y + 1) / 2 * rect.height,
    };
  }

  init();

  return {
    setTheme, setQuality, sync, setSelection, clearSelection, settle,
    resize, pick, startLoop, stopLoop, introCamera, shakeCamera,
    pointPos, markerPos, railPos, offPos, pointScreenPos, burst,
    isContextLost: () => contextLost,
  };
}

let rendererApi = null;

// ---------------------------------------------------------------------------
// Game UI: HUD, selection, pointer/keyboard/gamepad input, tutorial card.
// ---------------------------------------------------------------------------

let session = null;
let appPhase = 'title'; // boot → title → mode-select → active → results …
let selection = null;   // {origin: {kind:'point'|'rail', point?}, moves: []}
let dragState = null;

const PLAYER_NAMES = ['You', 'Rival 1', 'Rival 2', 'Rival 3'];

function seatName(seat) {
  if (session?.humanSeats.has(seat) && seat !== 0) return `Traveler ${seat + 1}`;
  return PLAYER_NAMES[seat] || `Seat ${seat + 1}`;
}

function seatColor(seat) {
  const theme = Content.themeByKey(session?.def.theme || settings.theme);
  return `#${theme.players[seat % theme.players.length].toString(16).padStart(6, '0')}`;
}

async function doCommand(cmd) {
  if (!session || session.over) return;
  const r = await session.dispatch(cmd);
  if (r.ok) {
    Audio.playEvent('ack', session.log.length);
    updateAfterStateChange();
  }
}

// Central post-change refresh: render, HUD, mirror, tutorial, AI scheduling.
function updateAfterStateChange() {
  if (!session) return;
  const events = session.lastEvents || [];
  session.lastEvents = [];
  rendererApi.sync(session.state, events);
  clearSelectionUI();
  updateHUD();
  updateMirror();
  updateTutorialCard();
  announceEvents(events);
  for (const ev of events) playEventSound(ev);
  if (session.over) {
    rendererApi.settle();
    setTimeout(() => showResults(), settings.reducedMotion ? 250 : 1100);
  } else {
    session.scheduleAI();
    updateCubeOverlay();
  }
}

function playEventSound(ev) {
  const seed = session.log.length;
  switch (ev.type) {
    case 'roll': Audio.playEvent('roll', seed); break;
    case 'move': Audio.playEvent(ev.hit ? 'hit' : (ev.from === 'rail' ? 'enter' : 'move'), seed); if (ev.hit) vibrate(40); break;
    case 'hit': Audio.playEvent('hit', seed); vibrate(40); break;
    case 'bearOff': Audio.playEvent('bearOff', seed); break;
    case 'double': Audio.playEvent('double', seed); break;
    case 'accept': Audio.playEvent('accept', seed); break;
    case 'decline': Audio.playEvent('decline', seed); break;
    case 'noMoves': Audio.playEvent('noMoves', seed); break;
    case 'turn': Audio.playEvent('turn', seed); break;
    case 'invalid': Audio.playEvent('invalid', seed); break;
  }
}

function announceEvents(events) {
  for (const ev of events) {
    const who = ev.player != null ? seatName(ev.player) : '';
    switch (ev.type) {
      case 'roll': announce(`${who} rolled ${ev.dice[0]} and ${ev.dice[1]}${ev.dice[0] === ev.dice[1] ? ' — doubles, four moves' : ''}.`); break;
      case 'move':
        if (ev.to === 'off') announce(`${who} bore a marker off from point ${ev.from + 1}.`);
        else if (ev.hit) announce(`${who} hit on point ${ev.to + 1}.`, true);
        break;
      case 'noMoves': announce(`${who} has no legal move.`, true); break;
      case 'pass': announce(`${who} passes.`); break;
      case 'double': announce(`${who} offers stakes of ${ev.value}.`, true); break;
      case 'accept': announce(`${who} accepts. Stakes are now ${ev.value}.`); break;
      case 'decline': announce(`${who} declines the stakes.`); break;
      case 'concede': announce(`${who} concedes.`); break;
      case 'turn': break; // covered by roll announcements
      case 'gameOver': announce(`Game over. ${seatName(ev.result.winner)} wins ${ev.result.points} match point${ev.result.points === 1 ? '' : 's'}.`, true); break;
    }
  }
}

// --- HUD -------------------------------------------------------------------

function updateHUD() {
  const st = session.state;
  const def = session.def;
  const humanTurn = session.isHumanTurn();

  // Objective line
  const goalBits = [];
  if (def.goals?.maxTurns) goalBits.push(`within ${def.goals.maxTurns} turns (turn ${st.turnNum})`);
  if (def.goals?.minHits) goalBits.push(`${def.goals.minHits}+ strikes`);
  if (def.goals?.maxTimeSec) goalBits.push(`thinking ${fmtClock(session.thinkingMs)} / ${Math.round(def.goals.maxTimeSec * settings.timingAssist / 60)} min`);
  if (def.options?.moveLimit) goalBits.push(`move limit ${def.options.moveLimit}`);
  $('#bb-objective').textContent = `${def.name} — bear all your markers off first${goalBits.length ? ' · ' + goalBits.join(' · ') : ''}`;

  // Turn indicator
  const who = st.phase === 'cube'
    ? `${seatName((st.cube.pending.by + 1) % st.cfg.players)} answers the stakes`
    : st.phase === 'roll'
      ? `${seatName(st.active)} to roll`
      : `${seatName(st.active)} to move`;
  $('#bb-turn-indicator').textContent = session.over ? 'Game over' : who;

  // Dice tray
  const tray = $('#bb-dice-tray');
  tray.innerHTML = '';
  if (st.dice.length) {
    const used = st.dice.slice();
    for (const left of st.movesLeft) used.splice(used.indexOf(left), 1);
    st.dice.forEach((d, i) => {
      const el = document.createElement('div');
      el.className = 'bb-die' + (st.dice[0] === st.dice[1] ? ' bb-doubles' : '');
      const isUsed = used.includes(d) && used.splice(used.indexOf(d), 1).length > 0;
      // simpler: count remaining occurrences
      tray.appendChild(el);
      el.textContent = d;
      el.setAttribute('aria-label', `Die ${d}${isUsed ? ' (used)' : ''}`);
      if (isUsed) el.classList.add('bb-used');
      void i;
    });
  } else {
    tray.innerHTML = '<span class="bb-tile-sub">No dice yet</span>';
  }

  // Players
  const playersEl = $('#bb-rail-players');
  playersEl.innerHTML = '';
  for (let p = 0; p < st.cfg.players; p++) {
    const row = document.createElement('div');
    row.className = 'bb-player-row' + (p === st.active && !session.over ? ' bb-active' : '');
    const pips = Rules.pipCount(st, p);
    row.innerHTML = `<span class="bb-swatch" style="background:${seatColor(p)}"></span>
      <span>${esc(seatName(p))}${st.alive[p] ? '' : ' (out)'}</span>
      <span class="bb-pip" style="margin-left:auto">${st.off[p]} off · ${st.rail[p]} rail · ${pips} pips</span>`;
    playersEl.appendChild(row);
  }

  // Objective rail
  $('#bb-rail-objective').innerHTML = `<p>${esc(def.blurb || def.name)}</p>
    <p><span class="bb-badge">${esc(Rules.RULESETS[st.cfg.ruleset].label)}</span>
    <span class="bb-badge">${st.cfg.players} seats</span>
    ${def.ranked ? '<span class="bb-badge bb-on">ranked</span>' : '<span class="bb-badge">unranked</span>'}
    ${def.options?.cube ? `<span class="bb-badge">stakes ×${st.cube.value}</span>` : ''}</p>`;
  $('#bb-rail-progress').innerHTML =
    `<p class="bb-pip">Turn ${st.turnNum} · strikes ${st.stats.hits[0]} · borne off ${st.off[0]}/${Rules.RULESETS[st.cfg.ruleset].markers}</p>`;
  $('#bb-rail-status').innerHTML =
    `<p>${session.transport === 'hosted' ? 'Hosted table — server authoritative.' : 'Local table.'}</p>
     <p class="bb-pip">Seed ${st.cfg.seed} · v${Rules.RULES_VERSION}</p>`;

  // Action buttons
  const acts = humanTurn ? Rules.legalActions(st) : [];
  const can = (type) => acts.some((a) => a.type === type);
  $('#bb-btn-roll').disabled = !can('roll');
  $('#bb-btn-double').disabled = !can('double');
  $('#bb-btn-pass').disabled = !can('pass');
  $('#bb-btn-undo').disabled = !session.canUndo();
  $('#bb-btn-hint').disabled = !(def.mechanics?.hint && humanTurn);
  $('#bb-btn-roll').textContent = st.phase === 'roll' ? 'Roll' : 'Roll';

  // Hosted daily: keep the reconnect pointer fresh.
  if (session.transport === 'hosted' && session.def.kind === 'daily') {
    writeJSON(STORE_DAILY, { sessionId: session.sessionId, day: platform.todayUTC(), tick: st.tick });
  }
}

// --- cube overlay -----------------------------------------------------------

function updateCubeOverlay() {
  const st = session.state;
  const overlay = $('#bb-cube-overlay');
  if (st.phase === 'cube' && session.isHumanTurn() && !session.over) {
    $('#bb-cube-text').textContent =
      `${seatName(st.cube.pending.by)} offers to raise the stakes to ${st.cube.pending.value}. ` +
      'Accept to play on at the higher stakes, or decline and concede the current stakes.';
    overlay.hidden = false;
    $('#bb-btn-accept').focus();
  } else {
    overlay.hidden = true;
  }
}

// --- selection --------------------------------------------------------------

function legalOrigins() {
  if (!session || !session.isHumanTurn() || session.state.phase !== 'move') return [];
  const seen = new Map();
  for (const m of Rules.legalMoves(session.state)) {
    const key = m.from === 'rail' ? 'rail' : `p${m.from}`;
    if (!seen.has(key)) seen.set(key, { from: m.from, key });
  }
  return [...seen.values()];
}

function clearSelectionUI() {
  selection = null;
  rendererApi.clearSelection();
}

function selectOrigin(from) {
  const moves = Rules.legalMoves(session.state).filter((m) => m.from === from);
  if (!moves.length) return;
  selection = { from, moves };
  Audio.playEvent('ack');
  const st = session.state;
  const originPos = from === 'rail'
    ? { x: 0, z: 0 }
    : (() => { const p = rendererApi.pointPos(from); return { x: p.x, z: p.z }; })();
  const targets = moves.map((m) => {
    if (m.to === 'off') { const o = rendererApi.offPos(st.cfg.players, st.active, st.off[st.active]); return { x: o.x, z: o.z, to: 'off' }; }
    const p = rendererApi.pointPos(m.to);
    return { x: p.x, z: p.z, to: m.to };
  });
  const hits = moves.filter((m) => m.hit).map((m) => {
    const p = rendererApi.pointPos(m.to);
    return { x: p.x, z: p.z };
  });
  // Deduplicate target markers (same destination, different dice)
  const uniq = [...new Map(targets.map((t) => [`${t.to}`, t])).values()];
  rendererApi.setSelection(originPos, uniq, hits);
  const targetNames = uniq.map((t) => (t.to === 'off' ? 'bear off' : `point ${t.to + 1}`)).join(', ');
  announce(`Selected ${from === 'rail' ? 'your rail marker' : `point ${from + 1}`}. Targets: ${targetNames}.`);
}

function commitMove(to) {
  if (!selection) return;
  const matches = selection.moves.filter((m) => m.to === to);
  if (!matches.length) return;
  // Prefer a hitting move, then the larger die, when both dice reach the spot.
  matches.sort((a, b) => (b.hit - a.hit) || (b.die - a.die));
  const m = matches[0];
  clearSelectionUI();
  doCommand({ type: 'move', player: session.state.active, from: m.from, to: m.to, die: m.die });
}

function explainInvalid(pickData) {
  const st = session.state;
  let reason = 'Nothing to do there.';
  if (st.phase === 'roll') reason = 'Roll the dice first.';
  else if (!session.isHumanTurn()) reason = 'Wait for the rival.';
  else if (st.phase === 'move') {
    if (st.rail[st.active] > 0 && pickData?.kind === 'point') {
      reason = 'Your rail marker must re-enter first.';
    } else if (pickData?.kind === 'point') {
      const cell = st.points[pickData.point];
      if (cell.owner !== st.active || cell.count === 0) reason = 'That point holds no marker of yours.';
      else reason = 'None of the remaining dice can move that marker.';
    } else if (pickData?.kind === 'off') reason = 'You can only bear off with a die that reaches the edge.';
  }
  Audio.playEvent('invalid');
  toast(reason);
  announce(`Cannot move: ${reason}`);
}

function handlePick(data) {
  if (!session || session.over || appPhase !== 'game') return;
  if (!data) { clearSelectionUI(); return; }
  const st = session.state;
  if (!session.isHumanTurn()) { explainInvalid(data); return; }
  if (st.phase === 'roll') { explainInvalid(data); return; }
  if (st.phase !== 'move') return;

  if (selection) {
    // A click on a highlighted target commits; clicking another origin reselects.
    const target = data.kind === 'off' ? 'off' : data.kind === 'point' ? data.point : null;
    if (target != null && selection.moves.some((m) => m.to === target)) { commitMove(target); return; }
  }
  if (data.kind === 'rail' && st.rail[st.active] > 0 && legalOrigins().some((o) => o.from === 'rail')) {
    selectOrigin('rail');
    return;
  }
  if (data.kind === 'point') {
    if (legalOrigins().some((o) => o.from === data.point)) { selectOrigin(data.point); return; }
  }
  explainInvalid(data);
}

// --- pointer input (tap / drag with capture; cancel-safe) ---------------------

function initPointer(canvas) {
  canvas.addEventListener('pointerdown', (e) => {
    Audio.resumeAudio();
    dragState = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), pick: rendererApi.pick(e.clientX, e.clientY), moved: false };
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragState || dragState.id !== e.pointerId) return;
    if (Math.hypot(e.clientX - dragState.x0, e.clientY - dragState.y0) > 12) dragState.moved = true;
  });
  const finish = (e, cancelled) => {
    if (!dragState || dragState.id !== e.pointerId) return;
    const d = dragState;
    dragState = null;
    if (cancelled) return;
    const dt = performance.now() - d.t0;
    const dist = Math.hypot(e.clientX - d.x0, e.clientY - d.y0);
    // Tap: short press, small movement. Drag: release over a target.
    if (dist < 12 && dt < 600) handlePick(d.pick);
    else if (d.moved && d.pick) {
      const over = rendererApi.pick(e.clientX, e.clientY);
      if (d.pick.kind === 'point' || d.pick.kind === 'rail') {
        // Press-and-hold drag from an origin onto a destination.
        const from = d.pick.kind === 'rail' ? 'rail' : d.pick.point;
        if (!selection || selection.from !== from) {
          if (legalOrigins().some((o) => o.from === from)) selectOrigin(from);
        }
        if (selection) {
          const target = over?.kind === 'off' ? 'off' : over?.kind === 'point' ? over.point : null;
          if (target != null && selection.moves.some((m) => m.to === target)) commitMove(target);
          else if (!settings.toggleSelect) clearSelectionUI();
        }
      }
    }
  };
  canvas.addEventListener('pointerup', (e) => finish(e, false));
  canvas.addEventListener('pointercancel', (e) => finish(e, true));
  canvas.addEventListener('lostpointercapture', () => { dragState = null; });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

// --- keyboard input -----------------------------------------------------------

function initKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
    const b = settings.bindings;
    const key = e.key;
    const modalOpen = !$('#bb-pause-overlay').hidden || !$('#bb-cube-overlay').hidden;

    if (key === b.pause || (key === 'Escape' && !modalOpen)) {
      if (appPhase === 'game' && !session?.over) {
        e.preventDefault();
        togglePause();
      }
      return;
    }
    if (appPhase !== 'game' || !session || modalOpen) return;

    if (key === b.roll && !$('#bb-btn-roll').disabled) { e.preventDefault(); doCommand({ type: 'roll', player: session.state.active }); }
    else if (key === b.undo && !$('#bb-btn-undo').disabled) { e.preventDefault(); undoMove(); }
    else if (key === b.hint && !$('#bb-btn-hint').disabled) { e.preventDefault(); session.hint(); }
    else if (key === b.cameraReset) { e.preventDefault(); rendererApi.resize(); announce('Camera reset.'); }
    else if (key === b.next || key === b.prev || key === 'ArrowUp' || key === 'ArrowDown') {
      // Roving focus across the board mirror buttons.
      const btns = [...document.querySelectorAll('#bb-board-mirror button')];
      if (!btns.length) return;
      e.preventDefault();
      const cur = btns.indexOf(document.activeElement);
      const dir = (key === b.next || key === 'ArrowDown') ? 1 : -1;
      const next = btns[(cur + dir + btns.length) % btns.length] || btns[0];
      next.focus();
    } else if (key === 'Escape' && selection) {
      clearSelectionUI();
      announce('Selection cleared.');
    }
  });
}

// --- gamepad ------------------------------------------------------------------

function initGamepad() {
  let prev = {};
  const poll = () => {
    requestAnimationFrame(poll);
    if (appPhase !== 'game' || !session) return;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = [...pads].find(Boolean);
    if (!pad) return;
    const pressed = (i) => pad.buttons[i]?.pressed;
    const edge = (i) => pressed(i) && !prev[i];
    if (edge(9)) togglePause();
    if (edge(0)) {
      const el = document.activeElement;
      if (el && el.tagName === 'BUTTON') el.click();
      else if (!$('#bb-btn-roll').disabled) doCommand({ type: 'roll', player: session.state.active });
    }
    if (edge(1)) { if (selection) clearSelectionUI(); }
    if (edge(14) || edge(15)) {
      const btns = [...document.querySelectorAll('#bb-board-mirror button')];
      if (btns.length) {
        const cur = btns.indexOf(document.activeElement);
        const dir = edge(15) ? 1 : -1;
        (btns[(cur + dir + btns.length) % btns.length] || btns[0]).focus();
      }
    }
    prev = Object.fromEntries(pad.buttons.map((btn, i) => [i, btn.pressed]));
  };
  requestAnimationFrame(poll);
}

// --- board mirror (screen-reader model + DOM equivalents of canvas controls) --

function updateMirror() {
  const host = $('#bb-board-mirror');
  host.innerHTML = '';
  if (!session || appPhase !== 'game') return;
  const st = session.state;
  const h = document.createElement('h2');
  h.textContent = 'Board';
  host.appendChild(h);
  const origins = legalOrigins();
  for (let i = 0; i < Rules.POINTS; i++) {
    const cell = st.points[i];
    const btn = document.createElement('button');
    btn.type = 'button';
    const owner = cell.owner < 0 ? 'empty' : `${cell.count} of ${seatName(cell.owner)}`;
    const dist = Rules.distanceOf(st.cfg.ruleset, st.cfg.players, 0, i);
    btn.textContent = `Point ${i + 1}: ${owner}, distance ${dist} for you`;
    if (origins.some((o) => o.from === i)) btn.dataset.origin = '1';
    btn.addEventListener('click', () => handlePick({ kind: 'point', point: i }));
    host.appendChild(btn);
  }
  const rail = document.createElement('button');
  rail.type = 'button';
  rail.textContent = `Rail: ${st.rail[0]} of yours, ${st.rail.slice(1).reduce((a, n) => a + n, 0)} rival`;
  rail.addEventListener('click', () => handlePick({ kind: 'rail' }));
  host.appendChild(rail);
  const off = document.createElement('button');
  off.type = 'button';
  off.textContent = `Bear-off tray: ${st.off[0]} of yours off`;
  off.addEventListener('click', () => handlePick({ kind: 'off' }));
  host.appendChild(off);
}

// --- tutorial card ---------------------------------------------------------------

function updateTutorialCard() {
  const card = $('#bb-tutorial-card');
  const t = session?.tutorial;
  if (!session || !t || t.done || session.over || appPhase !== 'game') {
    card.hidden = true;
    return;
  }
  const step = session.def.tutorial.steps[t.step];
  if (!step) { card.hidden = true; return; }
  card.hidden = false;
  const times = step.times ? ` (${Math.min(t.count + 1, step.times)}/${step.times})` : '';
  $('#bb-tutorial-text').textContent = step.text + times;
}

// --- pause -------------------------------------------------------------------

function togglePause() {
  const overlay = $('#bb-pause-overlay');
  if (!session || session.over) return;
  if (overlay.hidden) {
    session.pause();
    overlay.hidden = false;
    announce('Game paused.');
    $('#bb-btn-resume').focus();
  } else {
    overlay.hidden = true;
    session.resume();
    announce('Game resumed.');
    $('#bb-btn-pause').focus();
  }
}

function undoMove() {
  if (!session?.canUndo()) return;
  if (session.undo()) {
    Audio.playEvent('ack');
    updateAfterStateChange();
    announce('Undone. It is your roll again.');
    toast('Undone.');
  }
}

// ---------------------------------------------------------------------------
// Screens & navigation
// ---------------------------------------------------------------------------

function hudVisible(on) {
  for (const sel of ['#bb-hud-top', '#bb-rail-left', '#bb-rail-right', '#bb-action-tray']) {
    $(sel).hidden = !on;
  }
  if (!on) {
    $('#bb-tutorial-card').hidden = true;
    $('#bb-cube-overlay').hidden = true;
  }
}

function setScreen(html) {
  hudVisible(false);
  $('#bb-pause-overlay').hidden = true;
  screenEl.innerHTML = `<div class="bb-screen-inner">${html}</div>`;
  screenEl.scrollTop = 0;
}

function enterGameUI() {
  screenEl.innerHTML = '';
  hudVisible(true);
  appPhase = 'game';
  $('#bb-screen').blur();
}

function starsText(n) {
  return '★'.repeat(n) + '☆'.repeat(Math.max(0, 3 - n));
}

// --- title ------------------------------------------------------------------

function showTitle() {
  appPhase = 'title';
  Audio.stopMusic();
  const snap = readJSON(STORE_SNAPSHOT, null);
  const m = masteryTitle();
  const dailyDef = Content.dailyForDate(platform.todayUTC());
  const dailyDone = progress.daily.days.includes(platform.todayUTC());
  const achCount = Object.keys(progress.achievements).length;
  const journeyDone = Object.keys(progress.journey).length;
  const dailyStored = readJSON(STORE_DAILY, null);
  const canResumeDaily = dailyStored && dailyStored.day === platform.todayUTC() && platform.available && !dailyDone;

  setScreen(`
    <div class="bb-title-block">
      <h1 class="bb-game-title">Bearing Board</h1>
      <p class="bb-tagline">A travel-board dice race of wood, leather, and brass.</p>
      <p class="bb-tagline">${esc(settings.profile.name)} · ${esc(m.title)} · ${m.stars}★ · ${achCount}/${Content.ACHIEVEMENTS.length} achievements</p>
    </div>
    <nav class="bb-menu" aria-label="Main menu">
      ${snap ? `<button class="bb-btn bb-btn-primary" id="m-continue">Continue — ${esc(snap.def?.name || snap.defId || 'saved table')}</button>` : ''}
      <button class="bb-btn bb-btn-primary" id="m-play">Play now</button>
      <button class="bb-btn" id="m-daily">${canResumeDaily ? 'Resume ' : ''}Daily Crossing <span class="bb-tile-sub" id="daily-count"></span></button>
      <button class="bb-btn" id="m-journey">Journey — ${journeyDone}/${Content.JOURNEY.length} stages</button>
      <button class="bb-btn" id="m-learn">Learn</button>
      <button class="bb-btn" id="m-challenges">Challenges</button>
      <button class="bb-btn" id="m-practice">Practice setup</button>
      <button class="bb-btn" id="m-settings">Settings</button>
      <button class="bb-btn" id="m-help">Help &amp; rules</button>
    </nav>
    <section class="bb-section">
      <h2>Today’s table ${dailyDone ? '<span class="bb-badge bb-on">finished</span>' : ''}</h2>
      <p>${esc(dailyDef.blurb)}</p>
    </section>
  `);

  const wire = (id, fn) => $(id)?.addEventListener('click', () => { Audio.resumeAudio(); Audio.playEvent('ack'); fn(); });
  wire('#m-continue', resumeSnapshot);
  wire('#m-play', () => startGame(Content.practiceDef('steady', 'duel'), { humanSeats: [0] }));
  wire('#m-daily', startDaily);
  wire('#m-journey', showJourney);
  wire('#m-learn', showLearn);
  wire('#m-challenges', showChallenges);
  wire('#m-practice', () => showSetup());
  wire('#m-settings', () => showSettings('title'));
  wire('#m-help', () => showHelp('title'));
  $('#m-play')?.focus();
  updateDailyCountdown();
}

let dailyCountTimer = 0;
function updateDailyCountdown() {
  clearInterval(dailyCountTimer);
  const tick = () => {
    const el = $('#daily-count');
    if (!el) { clearInterval(dailyCountTimer); return; }
    const now = platform.now();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    const ms = next - now;
    el.textContent = `· new in ${Math.floor(ms / 3600000)}h ${Math.floor(ms / 60000) % 60}m`;
  };
  tick();
  dailyCountTimer = setInterval(tick, 30000);
}

function resumeSnapshot() {
  const snap = readJSON(STORE_SNAPSHOT, null);
  if (!snap?.def || !snap?.cfg || !Array.isArray(snap.log)) {
    toast('No saved table found.');
    return;
  }
  const s = new Session(snap.def, { humanSeats: [0], thinkingMs: snap.thinkingMs || 0 });
  s.start(snap);
  if (s.log.length !== snap.log.length) {
    toast('Saved table was damaged — starting fresh.');
    s.log = [];
  }
  launchSession(s, 'resumed');
}

// --- journey / learn / challenges ---------------------------------------------

function showJourney() {
  appPhase = 'mode-select';
  let html = `<h1>Journey</h1><p class="bb-tagline">Forty authored tables across five chapters. Mastery stage closes each chapter.</p><div class="bb-grid">`;
  let lastChapter = -1;
  Content.JOURNEY.forEach((def, i) => {
    if (def.chapter !== lastChapter) {
      lastChapter = def.chapter;
      html += `<h2 class="bb-chapter">${esc(['Departure', 'Open Road', 'Home Stretch', 'Brass Stakes', 'Grand Circuit'][def.chapter])}</h2>`;
    }
    const rec = progress.journey[def.id];
    html += `<button class="bb-tile" data-j="${i}">
      <span class="bb-tile-name">${esc(def.name)}</span>
      <span class="bb-tile-sub">${esc(def.blurb)}</span>
      <span class="bb-stars" aria-label="${rec?.stars || 0} of 3 stars">${starsText(rec?.stars || 0)}</span>
    </button>`;
  });
  html += `</div><div class="bb-row" style="justify-content:center"><button class="bb-btn" id="back">Back</button></div>`;
  setScreen(html);
  screenEl.querySelectorAll('[data-j]').forEach((btn) => btn.addEventListener('click', () => {
    startGame(Content.JOURNEY[Number(btn.dataset.j)], { humanSeats: [0] });
  }));
  $('#back').addEventListener('click', showTitle);
}

function showLearn() {
  appPhase = 'mode-select';
  let html = `<h1>Learn</h1><p class="bb-tagline">Six short lessons. One rule at a time — you perform every action yourself.</p><div class="bb-grid">`;
  Content.LESSONS.forEach((def, i) => {
    const done = progress.lessons[def.id]?.done;
    html += `<button class="bb-tile" data-l="${i}">
      <span class="bb-tile-name">${esc(def.name)} ${done ? '<span class="bb-badge bb-on">done</span>' : ''}</span>
      <span class="bb-tile-sub">${esc(def.blurb)}</span>
    </button>`;
  });
  html += `</div><div class="bb-row" style="justify-content:center"><button class="bb-btn" id="back">Back</button></div>`;
  setScreen(html);
  screenEl.querySelectorAll('[data-l]').forEach((btn) => btn.addEventListener('click', () => {
    startGame(Content.LESSONS[Number(btn.dataset.l)], { humanSeats: [0] });
  }));
  $('#back').addEventListener('click', showTitle);
}

function showChallenges() {
  appPhase = 'mode-select';
  let html = `<h1>Challenges</h1><p class="bb-tagline">Constrained tables: move limits, speed targets, altered layouts.</p><div class="bb-grid">`;
  Content.CHALLENGES.forEach((def, i) => {
    const done = progress.challenges[def.id]?.done;
    html += `<button class="bb-tile" data-c="${i}">
      <span class="bb-tile-name">${esc(def.name)} ${done ? '<span class="bb-badge bb-on">cleared</span>' : ''}</span>
      <span class="bb-tile-sub">${esc(def.blurb)}</span>
    </button>`;
  });
  html += `</div><div class="bb-row" style="justify-content:center"><button class="bb-btn" id="back">Back</button></div>`;
  setScreen(html);
  screenEl.querySelectorAll('[data-c]').forEach((btn) => btn.addEventListener('click', () => {
    startGame(Content.CHALLENGES[Number(btn.dataset.c)], { humanSeats: [0] });
  }));
  $('#back').addEventListener('click', showTitle);
}

// --- practice setup --------------------------------------------------------------

function showSetup() {
  appPhase = 'mode-select';
  setScreen(`
    <h1>Practice setup</h1>
    <section class="bb-section bb-form">
      <p class="bb-tagline">Unranked: undo and hints allowed, no effect on rating. Expected duration 10–20 minutes.</p>
      <div class="bb-field">
        <label for="f-ruleset">Ruleset</label>
        <select id="f-ruleset">
          <option value="duel">Duel — two travelers, opposite directions, 15 markers</option>
          <option value="circuit">Circuit — 2–4 caravans chase one loop, 8 markers</option>
        </select>
      </div>
      <div class="bb-field">
        <label for="f-difficulty">Rival difficulty</label>
        <select id="f-difficulty">
          ${Object.values(AI.DIFFICULTIES).map((d) => `<option value="${d.key}" ${d.key === 'steady' ? 'selected' : ''}>${d.label} — ${d.blurb}</option>`).join('')}
        </select>
      </div>
      <div class="bb-field" id="f-players-wrap" hidden>
        <label for="f-players">Caravans (seats)</label>
        <select id="f-players"><option>2</option><option>3</option><option>4</option></select>
      </div>
      <div class="bb-field">
        <label for="f-humans">Humans at this device</label>
        <select id="f-humans"><option value="1">1 (vs AI)</option><option value="2">2 (pass-and-play)</option></select>
      </div>
      <div class="bb-field">
        <label for="f-theme">Table theme</label>
        <select id="f-theme">${Content.THEMES.map((t) => `<option value="${t.key}">${t.label}</option>`).join('')}</select>
      </div>
      <div class="bb-field">
        <label for="f-seed">Seed (optional — share a number to replay the same dice)</label>
        <input id="f-seed" type="number" min="0" max="4294967295" placeholder="random" />
      </div>
      <div class="bb-row">
        <button class="bb-btn" id="back">Back</button>
        <button class="bb-btn bb-btn-primary" id="f-start">Start table</button>
      </div>
    </section>
  `);
  const rulesetSel = $('#f-ruleset');
  rulesetSel.addEventListener('change', () => {
    $('#f-players-wrap').hidden = rulesetSel.value !== 'circuit';
  });
  $('#back').addEventListener('click', showTitle);
  $('#f-start').addEventListener('click', () => {
    const ruleset = rulesetSel.value;
    const difficulty = $('#f-difficulty').value;
    const players = ruleset === 'circuit' ? Number($('#f-players').value) : 2;
    const humans = Number($('#f-humans').value);
    const seedRaw = $('#f-seed').value.trim();
    const seed = seedRaw ? (Number(seedRaw) >>> 0) : null;
    const def = Content.practiceDef(difficulty, ruleset, seed, players);
    def.theme = $('#f-theme').value;
    startGame(def, { humanSeats: [...Array(Math.min(humans, players)).keys()] });
  });
}

// --- daily ------------------------------------------------------------------------

async function startDaily() {
  const def = Content.dailyForDate(platform.todayUTC());
  if (platform.available) {
    try {
      const stored = readJSON(STORE_DAILY, null);
      let body;
      if (stored && stored.day === platform.todayUTC() && stored.sessionId) {
        body = await platform.api(`sessions/${stored.sessionId}`);
        const away = Math.max(0, (body.state.tick || 0) - (stored.tick || 0));
        if (away > 0) toast(`While you were away: ${away} table event${away === 1 ? '' : 's'} played out.`);
      } else {
        body = await platform.api('sessions', {
          method: 'POST',
          body: JSON.stringify({ cfg: defToConfig(def) }),
        });
      }
      const s = new Session(def, { transport: 'hosted', sessionId: body.sessionId, humanSeats: [0] });
      s.state = body.state;
      s.log = body.log || [];
      if (s.state.winner >= 0) s.finished = true;
      writeJSON(STORE_DAILY, { sessionId: body.sessionId, day: platform.todayUTC(), tick: s.state.tick });
      launchSession(s, 'hosted');
      return;
    } catch (err) {
      toast(`Hosted table unavailable (${err.message}) — playing locally.`);
    }
  }
  startGame(def, { humanSeats: [0] });
}

// --- game launch ----------------------------------------------------------------------

function startGame(def, opts = {}) {
  const s = new Session(def, opts);
  s.start(opts.snapshot);
  launchSession(s, 'fresh');
}

function launchSession(s, how) {
  session = s;
  funnel.track('start', `${s.def.kind}:${how}`);
  rendererApi.setTheme(s.def.theme || settings.theme);
  enterGameUI();
  rendererApi.introCamera();
  Audio.resumeAudio();
  Audio.startAmbience(s.def.theme || settings.theme);
  Audio.startMusic(s.cfg.seed);
  if (s.over) {
    updateAfterStateChange();
  } else {
    updateAfterStateChange();
    const name = s.def.kind === 'learn' ? s.def.name : s.def.name;
    announce(`${name}. ${s.isHumanTurn() ? 'Your turn — roll the dice.' : 'Rival begins.'}`);
  }
  if (how === 'hosted') toast('Hosted table: the server is authoritative.');
}

// --- results ----------------------------------------------------------------------

function showResults() {
  if (!session?.result) return;
  appPhase = 'results';
  $('#bb-cube-overlay').hidden = true;
  $('#bb-tutorial-card').hidden = true;
  const { def, result: res, goalReport: rep, state } = session;
  const won = rep.won;
  Audio.playEvent(won ? 'win' : 'lose');
  const markers = Rules.RULESETS[state.cfg.ruleset].markers;

  const rows = res.breakdown.map((b) =>
    `<tr><td>${esc(b.label)}</td><td>${esc(b.value)}</td></tr>`).join('');
  const goals = rep.items.map((g) =>
    `<tr><td>${g.met ? '✓' : '✗'} ${esc(g.label)}</td><td>${g.met ? 'met' : 'missed'}</td></tr>`).join('');
  const stars = def.kind === 'journey' ? starsFor(def, rep, state, session.thinkingMs) : 0;
  const newAch = session.newAchievements || [];

  let nextBtn = '';
  if (def.kind === 'journey') {
    const idx = Content.JOURNEY.findIndex((j) => j.id === def.id);
    if (idx >= 0 && idx < Content.JOURNEY.length - 1) nextBtn = `<button class="bb-btn bb-btn-primary" id="r-next">Next stage</button>`;
  } else if (def.kind === 'learn') {
    const idx = Content.LESSONS.findIndex((j) => j.id === def.id);
    if (idx >= 0 && idx < Content.LESSONS.length - 1) nextBtn = `<button class="bb-btn bb-btn-primary" id="r-next">Next lesson</button>`;
  }

  setScreen(`
    <h1 class="bb-headline">${won ? 'Victory!' : 'The road goes on'}</h1>
    <p class="bb-center bb-tagline">${esc(def.name)} · ${esc(seatName(res.winner))} wins by ${esc(res.reason)} · ${state.turnNum} turns · ${fmtClock(session.thinkingMs)} thinking</p>
    ${def.kind === 'journey' ? `<p class="bb-center bb-stars" style="font-size:1.6rem" aria-label="${stars} of 3 stars">${starsText(stars)}</p>` : ''}
    <section class="bb-section">
      <h2>Score breakdown</h2>
      <table class="bb-score-table"><tbody>${rows}</tbody></table>
      <p class="bb-tagline">Strikes: you ${state.stats.hits[0]} · rivals ${state.stats.hits.slice(1).reduce((a, b) => a + b, 0)} · Borne off: you ${state.off[0]}/${markers}</p>
    </section>
    ${goals ? `<section class="bb-section"><h2>Goals</h2><table class="bb-score-table"><tbody>${goals}</tbody></table></section>` : ''}
    ${newAch.length ? `<section class="bb-section"><h2>Achievements</h2>${newAch.map((a) => `<p><span class="bb-badge bb-on">${esc(a.label)}</span> ${esc(a.desc)}</p>`).join('')}</section>` : ''}
    <section class="bb-section">
      <h2>Mastery</h2>
      <p>${esc(masteryTitle().title)} · ${masteryTitle().stars} journey stars</p>
      <p class="bb-tagline">Seed ${state.cfg.seed} · rules v${Rules.RULES_VERSION} · content v${Content.CONTENT_VERSION}</p>
      <button class="bb-btn" id="r-replay">Copy replay envelope</button>
    </section>
    <div class="bb-row" style="justify-content:center">
      <button class="bb-btn" id="r-menu">Menu</button>
      <button class="bb-btn" id="r-retry">Retry</button>
      ${nextBtn}
    </div>
  `);

  $('#r-menu').addEventListener('click', () => { Audio.stopMusic(); showTitle(); });
  $('#r-retry').addEventListener('click', () => {
    funnel.track('retry', def.kind);
    const fresh = def.kind === 'practice'
      ? Content.practiceDef(def.ai?.difficulty || 'steady', def.ruleset, null, def.players)
      : def;
    if (fresh.kind === 'practice') fresh.theme = def.theme;
    startGame(fresh, { humanSeats: [...session.humanSeats] });
  });
  $('#r-next')?.addEventListener('click', () => {
    const list = def.kind === 'journey' ? Content.JOURNEY : Content.LESSONS;
    const idx = list.findIndex((j) => j.id === def.id);
    startGame(list[idx + 1], { humanSeats: [0] });
  });
  $('#r-replay').addEventListener('click', async () => {
    const env = JSON.stringify(session.replayEnvelope());
    try {
      await navigator.clipboard.writeText(env);
      toast('Replay envelope copied.');
    } catch (_) {
      toast(`Replay hash: ${session.replayEnvelope().finalHash}`);
    }
  });
  $('#r-retry').focus();
}

// --- settings ----------------------------------------------------------------------

function showSettings(returnTo = 'title') {
  appPhase = 'settings';
  const b = settings.bindings;
  setScreen(`
    <h1>Settings</h1>
    <section class="bb-section bb-form">
      <h2>Audio</h2>
      <div class="bb-check"><input type="checkbox" id="s-audio" ${settings.audioEnabled ? 'checked' : ''} /><label for="s-audio">Audio enabled</label></div>
      ${['music', 'effects', 'ambience', 'voice'].map((bus) => `
        <div class="bb-field"><label for="s-vol-${bus}">${bus[0].toUpperCase() + bus.slice(1)} volume</label>
        <input type="range" id="s-vol-${bus}" min="0" max="100" value="${Math.round(settings.volume[bus] * 100)}" /></div>`).join('')}
    </section>
    <section class="bb-section bb-form">
      <h2>Graphics</h2>
      <div class="bb-field"><label for="s-quality">Quality tier</label>
        <select id="s-quality">
          ${['auto', 'low', 'medium', 'high'].map((q) => `<option value="${q}" ${settings.quality === q ? 'selected' : ''}>${q[0].toUpperCase() + q.slice(1)}</option>`).join('')}
        </select></div>
      <div class="bb-field"><label for="s-theme">Default theme</label>
        <select id="s-theme">${Content.THEMES.map((t) => `<option value="${t.key}" ${settings.theme === t.key ? 'selected' : ''}>${t.label}</option>`).join('')}</select></div>
    </section>
    <section class="bb-section bb-form">
      <h2>Accessibility &amp; controls</h2>
      <div class="bb-check"><input type="checkbox" id="s-rm" ${settings.reducedMotion ? 'checked' : ''} /><label for="s-rm">Reduced motion (no camera swoops, shake, or particles)</label></div>
      <div class="bb-check"><input type="checkbox" id="s-hc" ${settings.highContrast ? 'checked' : ''} /><label for="s-hc">High contrast palette</label></div>
      <div class="bb-check"><input type="checkbox" id="s-bt" ${settings.bigText ? 'checked' : ''} /><label for="s-bt">Larger text</label></div>
      <div class="bb-check"><input type="checkbox" id="s-lh" ${settings.leftHanded ? 'checked' : ''} /><label for="s-lh">Left-handed layout</label></div>
      <div class="bb-check"><input type="checkbox" id="s-hap" ${settings.haptics ? 'checked' : ''} /><label for="s-hap">Haptics (vibration on strikes)</label></div>
      <div class="bb-check"><input type="checkbox" id="s-ts" ${settings.toggleSelect ? 'checked' : ''} /><label for="s-ts">Tap-to-select (off = press-and-hold to drag)</label></div>
      <div class="bb-field"><label for="s-ta">Timing assistance in timed challenges</label>
        <select id="s-ta">${[1, 1.5, 2].map((m) => `<option value="${m}" ${settings.timingAssist === m ? 'selected' : ''}>${m}×</option>`).join('')}</select></div>
      <h3>Keyboard bindings</h3>
      <p>Roll <span class="bb-kbd">${esc(b.roll)}</span> · Undo <span class="bb-kbd">${esc(b.undo)}</span> · Hint <span class="bb-kbd">${esc(b.hint)}</span> · Pause <span class="bb-kbd">Esc</span> · Camera reset <span class="bb-kbd">${esc(b.cameraReset)}</span> · Navigate <span class="bb-kbd">←</span><span class="bb-kbd">→</span> · Confirm <span class="bb-kbd">Enter</span></p>
      <h3>Profile</h3>
      <div class="bb-field"><label for="s-name">Display name (guest — local only)</label>
        <input type="text" id="s-name" maxlength="24" value="${esc(settings.profile.name)}" /></div>
      <h3>Data</h3>
      <div class="bb-row">
        <button class="bb-btn" id="s-tutorial-reset">Replay tutorials</button>
        <button class="bb-btn bb-btn-danger" id="s-wipe">Reset all progress</button>
      </div>
    </section>
    <div class="bb-row" style="justify-content:center"><button class="bb-btn bb-btn-primary" id="s-back">Done</button></div>
  `);

  const change = (id, fn) => $(id).addEventListener('change', (e) => { fn(e.target); saveSettings(); applySettings(); funnel.track('settings_change', id.slice(2)); });
  change('#s-audio', (t) => { settings.audioEnabled = t.checked; });
  for (const bus of ['music', 'effects', 'ambience', 'voice']) {
    change(`#s-vol-${bus}`, (t) => { settings.volume[bus] = Number(t.value) / 100; });
  }
  change('#s-quality', (t) => { settings.quality = t.value; });
  change('#s-theme', (t) => { settings.theme = t.value; if (!session) rendererApi.setTheme(t.value); });
  change('#s-rm', (t) => { settings.reducedMotion = t.checked; });
  change('#s-hc', (t) => { settings.highContrast = t.checked; });
  change('#s-bt', (t) => { settings.bigText = t.checked; });
  change('#s-lh', (t) => { settings.leftHanded = t.checked; });
  change('#s-hap', (t) => { settings.haptics = t.checked; });
  change('#s-ts', (t) => { settings.toggleSelect = t.checked; });
  change('#s-ta', (t) => { settings.timingAssist = Number(t.value); });
  $('#s-name').addEventListener('change', (e) => {
    settings.profile.name = e.target.value.trim() || 'Guest Traveler';
    saveSettings();
  });
  $('#s-tutorial-reset').addEventListener('click', () => {
    progress.lessons = {};
    saveProgress();
    toast('Tutorials will play again.');
  });
  $('#s-wipe').addEventListener('click', () => {
    progress = structuredClone(DEFAULT_PROGRESS);
    saveProgress();
    storage.removeItem(STORE_SNAPSHOT);
    storage.removeItem(STORE_DAILY);
    toast('Progress reset.');
  });
  $('#s-back').addEventListener('click', () => {
    if (returnTo === 'pause' && session && !session.over) {
      enterGameUI();
      togglePause();
      updateHUD();
      updateMirror();
    } else showTitle();
  });
}

// --- help --------------------------------------------------------------------------

function showHelp(returnTo = 'title') {
  appPhase = 'help';
  const theme = Content.themeByKey(settings.theme);
  const legend = theme.players.slice(0, 4).map((c, i) =>
    `<span class="bb-badge"><span class="bb-swatch" style="background:#${c.toString(16).padStart(6, '0')}"></span> ${i === 0 ? 'You (light discs)' : `Rival ${i}`}</span>`).join('');
  setScreen(`
    <h1>Help &amp; rules</h1>
    <section class="bb-section"><h2>The road</h2>
      <p>Your markers travel a track of 24 triangular points, then leave the board. In a <strong>Duel</strong> you cross the whole board while your rival comes the other way. In a <strong>Circuit</strong>, every caravan chases the same loop from its own gate. First to bear everything off wins.</p></section>
    <section class="bb-section"><h2>Dice</h2>
      <p>Roll two dice; each die moves one marker. Doubles grant four moves. You must use every die you can, and if only one die of a mixed roll can be played it must be the higher one. If nothing can move, you pass.</p></section>
    <section class="bb-section"><h2>Strikes &amp; the rail</h2>
      <p>A lone marker on a point is a blot. Landing on it strikes it to the rail in the middle. While any marker of yours sits on the rail, it must re-enter — in the rival home stretch — before anything else may move.</p></section>
    <section class="bb-section"><h2>Bearing off</h2>
      <p>Once every marker is inside your home stretch (the last six points), dice can carry markers off the board. An oversized die may bear off only from your farthest occupied point.</p></section>
    <section class="bb-section"><h2>The stakes cube</h2>
      <p>Before rolling in a duel, you may offer the brass cube to double the stakes. The rival accepts — playing on and taking ownership of the cube — or declines and concedes the current stakes. Score stakes only; no money ever changes hands.</p></section>
    <section class="bb-section"><h2>Scoring</h2>
      <p>Match points = stakes value × sweep factor. Bearing off while the rival has borne nothing off doubles the win (full sweep); if they also have a marker on the rail or in your home stretch, it triples (grand sweep). Results always show this breakdown.</p></section>
    <section class="bb-section"><h2>Controls</h2>
      <p>Pointer/touch: tap a glowing marker, then a lit destination — or press and drag. Keyboard: <span class="bb-kbd">←</span><span class="bb-kbd">→</span> move through board buttons, <span class="bb-kbd">Enter</span> to use one, <span class="bb-kbd">R</span> roll, <span class="bb-kbd">U</span> undo, <span class="bb-kbd">H</span> hint, <span class="bb-kbd">C</span> camera, <span class="bb-kbd">Esc</span> pause. Gamepad: D-pad to browse, primary to confirm, secondary to cancel, start to pause.</p></section>
    <section class="bb-section"><h2>Colors</h2><p>${legend}</p>
      <p>Legal targets glow green; a strike target glows red; the selected marker carries a brass ring. High-contrast and color-vision-safe palettes are in Settings.</p></section>
    <div class="bb-row" style="justify-content:center"><button class="bb-btn bb-btn-primary" id="h-back">Done</button></div>
  `);
  $('#h-back').addEventListener('click', () => {
    if (returnTo === 'pause' && session && !session.over) {
      enterGameUI();
      togglePause();
      updateHUD();
      updateMirror();
    } else showTitle();
  });
}

// ---------------------------------------------------------------------------
// Static controls, lifecycle, boot
// ---------------------------------------------------------------------------

function wireStaticControls() {
  $('#bb-btn-roll').addEventListener('click', () => {
    Audio.resumeAudio();
    if (session?.isHumanTurn()) doCommand({ type: 'roll', player: session.state.active });
  });
  $('#bb-btn-double').addEventListener('click', () => {
    if (session?.isHumanTurn()) doCommand({ type: 'double', player: session.state.active });
  });
  $('#bb-btn-pass').addEventListener('click', () => {
    if (session?.isHumanTurn() && Rules.canPass(session.state)) {
      doCommand({ type: 'pass', player: session.state.active });
    }
  });
  $('#bb-btn-undo').addEventListener('click', undoMove);
  $('#bb-btn-hint').addEventListener('click', () => session?.hint());
  $('#bb-btn-skip').addEventListener('click', () => { rendererApi.settle(); announce('Animations settled.'); });
  $('#bb-btn-pause').addEventListener('click', togglePause);
  $('#bb-btn-resume').addEventListener('click', togglePause);
  $('#bb-btn-pause-settings').addEventListener('click', () => {
    $('#bb-pause-overlay').hidden = true;
    showSettings('pause');
  });
  $('#bb-btn-pause-help').addEventListener('click', () => {
    $('#bb-pause-overlay').hidden = true;
    showHelp('pause');
  });
  $('#bb-btn-leave').addEventListener('click', () => {
    $('#bb-pause-overlay').hidden = true;
    if (session && !session.over) {
      session.pause();
      session.persistSnapshot();
    }
    Audio.stopMusic();
    funnel.track('quit', session?.def.kind || '');
    showTitle();
  });
  $('#bb-btn-accept').addEventListener('click', () => {
    const st = session?.state;
    if (!st?.cube?.pending) return;
    const responder = (st.cube.pending.by + 1) % st.cfg.players;
    doCommand({ type: 'accept', player: responder });
  });
  $('#bb-btn-decline').addEventListener('click', () => {
    const st = session?.state;
    if (!st?.cube?.pending) return;
    const responder = (st.cube.pending.by + 1) % st.cfg.players;
    doCommand({ type: 'decline', player: responder });
  });
  $('#bb-btn-lesson-done').addEventListener('click', () => {
    if (!session) return;
    if (session.def.kind === 'learn') {
      progress.lessons[session.def.id] = { done: true };
      saveProgress();
      toast('Lesson complete.');
    }
    Audio.stopMusic();
    showLearn();
  });
}

function initLifecycle(canvas) {
  const onResize = () => rendererApi?.resize();
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // Backgrounding pauses solo simulation and silences rendering/audio.
      if (session && !session.over && appPhase === 'game' && $('#bb-pause-overlay').hidden) {
        togglePause();
      }
      rendererApi?.stopLoop();
      Audio.setBackgrounded(true);
    } else {
      rendererApi?.startLoop();
      rendererApi?.resize();
      Audio.setBackgrounded(false);
    }
  });

  window.addEventListener('error', (e) => {
    funnel.track('error', String(e.message || 'unknown').slice(0, 24));
  });
  window.addEventListener('unhandledrejection', (e) => {
    funnel.track('error', String(e.reason?.message || e.reason || 'rejection').slice(0, 24));
  });
}

async function boot() {
  const canvas = $('#bb-canvas');
  try {
    rendererApi = createRenderer(canvas);
  } catch (err) {
    $('#bb-webgl-fallback').hidden = false;
    canvas.hidden = true;
    funnel.track('error', 'webgl-unavailable');
    return;
  }
  applySettings();
  wireStaticControls();
  initPointer(canvas);
  initKeyboard();
  initGamepad();
  initLifecycle(canvas);
  rendererApi.setTheme(settings.theme);
  rendererApi.startLoop();
  // Platform detection must never block an offline start.
  platform.init().finally(() => showTitle());
  showTitle();
  funnel.track('boot', BUILD_VERSION);
  // Deep links: #play jumps straight to a practice table (two actions max).
  if (location.hash === '#play') {
    startGame(Content.practiceDef('steady', 'duel'), { humanSeats: [0] });
  }
}

boot();
