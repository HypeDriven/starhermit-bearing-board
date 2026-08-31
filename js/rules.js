// Bearing Board — deterministic rules engine.
// Pure module: no DOM, no rendering, no I/O. Same file runs in browser, Node,
// and the authoritative host script. State changes happen only through
// applyCommand(); identical (version, seed, command list) always yields
// identical state hashes.
//
// Rules contract (original rules family, two rulesets):
//  - The board is 24 triangular points. Each player races their markers along
//    a personal track of distances 0..23 and then bears them off (distance 24).
//  - DUEL (2 players): players travel in opposite directions across the full
//    board. Classic mirrored opening layout, 15 markers each. An optional
//    stakes cube may be offered, accepted, or declined (score stakes only —
//    no monetary framing).
//  - CIRCUIT (2–4 players): everyone travels the same direction around a
//    loop, each from their own start gate, 8 markers each. First to bear
//    everything off wins; no cube.
//  - Two dice; doubles grant four moves. All possible dice must be used; if
//    only one die of a mixed roll can be played, it must be the higher one.
//  - Landing on a lone opposing marker (a blot) hits it onto the rail.
//    Markers on the rail must re-enter before any other move.
//  - Bearing off requires every marker inside the home stretch (distance ≥ 18).
//    An over-sized die may bear off only from the farthest occupied point.
// Terminal scoring: cube value × gammon/backgammon factor, reported as a
// component breakdown, never a bare total.

export const RULES_VERSION = 1;
export const POINTS = 24;
export const HOME_DIST = 18; // distance >= HOME_DIST is the home stretch
export const TRACK_LEN = 24; // bearing off happens at distance 24

export const RULESETS = {
  duel: {
    key: 'duel', label: 'Duel', minPlayers: 2, maxPlayers: 2,
    markers: 15, cubeAllowed: true,
    blurb: 'Two travelers cross the whole board in opposite directions.',
  },
  circuit: {
    key: 'circuit', label: 'Circuit', minPlayers: 2, maxPlayers: 4,
    markers: 8, cubeAllowed: false,
    blurb: 'Up to four caravans chase the same loop from separate gates.',
  },
};

// ---------------------------------------------------------------------------
// Seeded random streams (rules / decoration / audiovisual stay separate)
// ---------------------------------------------------------------------------

export function hashSeed(str) {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// mulberry32: tiny, fast, deterministic 32-bit PRNG with visible state.
export function createRng(state) {
  let s = state >>> 0;
  return {
    get state() { return s >>> 0; },
    set state(v) { s = v >>> 0; },
    next() {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    int(n) { return Math.floor(this.next() * n); },
    range(lo, hi) { return lo + this.int(hi - lo + 1); },
    pick(arr) { return arr[this.int(arr.length)]; },
  };
}

const STREAM_RULES = 0x9e3779b9;

// ---------------------------------------------------------------------------
// Config + game creation
// ---------------------------------------------------------------------------

export class RulesError extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

export function validateConfig(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== 'object') return ['config must be an object'];
  if (typeof cfg.id !== 'string' || !cfg.id) errors.push('id required');
  if (!Number.isInteger(cfg.version) || cfg.version < 1) errors.push('version must be a positive integer');
  const rs = RULESETS[cfg.ruleset];
  if (!rs) errors.push(`unknown ruleset "${cfg.ruleset}"`);
  const players = cfg.players ?? 2;
  if (rs && (players < rs.minPlayers || players > rs.maxPlayers))
    errors.push(`${cfg.ruleset} supports ${rs.minPlayers}–${rs.maxPlayers} players, got ${players}`);
  if (!Number.isInteger(cfg.seed)) errors.push('integer seed required');
  const opts = cfg.options || {};
  if (opts.cube && rs && !rs.cubeAllowed) errors.push('cube not allowed in this ruleset');
  if (opts.moveLimit != null && (!Number.isInteger(opts.moveLimit) || opts.moveLimit < 1))
    errors.push('moveLimit must be a positive integer');
  if (cfg.layout) {
    const m = rs ? rs.markers : 15;
    const counts = new Array(players).fill(0);
    for (const cell of cfg.layout.points || []) {
      if (!Number.isInteger(cell.point) || cell.point < 0 || cell.point >= POINTS)
        errors.push(`layout point out of range: ${cell.point}`);
      if (!Number.isInteger(cell.owner) || cell.owner < 0 || cell.owner >= players)
        errors.push(`layout owner out of range: ${cell.owner}`);
      if (!Number.isInteger(cell.count) || cell.count < 1 || cell.count > m)
        errors.push(`layout count out of range: ${cell.count}`);
      else counts[cell.owner] += cell.count;
    }
    (cfg.layout.rail || []).forEach((c, i) => {
      if (!Number.isInteger(c) || c < 0 || c > m) errors.push(`layout rail[${i}] invalid`);
      else counts[i] += c;
    });
    (cfg.layout.off || []).forEach((c, i) => {
      if (!Number.isInteger(c) || c < 0 || c > m) errors.push(`layout off[${i}] invalid`);
      else counts[i] += c;
    });
    counts.forEach((c, i) => {
      if (c !== m) errors.push(`layout places ${c}/${m} markers for player ${i}`);
    });
  }
  if (cfg.scriptedDice) {
    for (const d of cfg.scriptedDice) {
      if (!Array.isArray(d) || d.length !== 2 || d.some((v) => !Number.isInteger(v) || v < 1 || v > 6))
        errors.push(`scripted dice must be [1..6, 1..6], got ${JSON.stringify(d)}`);
    }
  }
  return errors;
}

export function createGame(cfg) {
  const errors = validateConfig(cfg);
  if (errors.length) throw new RulesError('invalid config: ' + errors.join('; '));
  const rs = RULESETS[cfg.ruleset];
  const players = cfg.players ?? 2;
  const points = [];
  for (let i = 0; i < POINTS; i++) points.push({ owner: -1, count: 0 });
  const rail = new Array(players).fill(0);
  const off = new Array(players).fill(0);

  if (cfg.layout) {
    for (const cell of cfg.layout.points || []) {
      points[cell.point] = { owner: cell.owner, count: cell.count };
    }
    (cfg.layout.rail || []).forEach((c, i) => { rail[i] = c; });
    (cfg.layout.off || []).forEach((c, i) => { off[i] = c; });
  } else {
    defaultLayout(cfg.ruleset, players, points);
  }

  const rng = createRng((cfg.seed ^ STREAM_RULES) >>> 0);
  return {
    version: RULES_VERSION,
    cfg: {
      id: cfg.id, version: cfg.version, kind: cfg.kind || 'practice',
      ruleset: cfg.ruleset, players, seed: cfg.seed >>> 0,
      options: {
        cube: !!cfg.options?.cube,
        moveLimit: cfg.options?.moveLimit ?? 0,
      },
      goals: cfg.goals ? JSON.parse(JSON.stringify(cfg.goals)) : { win: true },
    },
    rng: rng.state,
    scriptedDice: cfg.scriptedDice ? cfg.scriptedDice.map((d) => [d[0], d[1]]) : [],
    tick: 0,
    turnNum: 1,
    phase: 'roll',           // roll → move (→ move …) → roll … ; cube → accept/decline; over
    active: 0,
    alive: new Array(players).fill(true),
    dice: [],
    movesLeft: [],
    points,
    rail,
    off,
    cube: { value: 1, owner: -1, pending: null },
    winner: -1,
    result: null,
    stats: {
      invalid: new Array(players).fill(0),
      hits: new Array(players).fill(0),
      borneOff: new Array(players).fill(0),
      doubles: 0,
      rolls: 0,
    },
  };
}

function defaultLayout(ruleset, players, points) {
  if (ruleset === 'duel') {
    // Mirrored travel layout; player 0 travels 23→0, player 1 travels 0→23.
    const put = (point, owner, count) => { points[point] = { owner, count }; };
    put(23, 0, 2); put(12, 0, 5); put(7, 0, 3); put(5, 0, 5);
    put(0, 1, 2); put(11, 1, 5); put(16, 1, 3); put(18, 1, 5);
  } else {
    // Circuit: every player's stack waits at their own gate.
    for (let p = 0; p < players; p++) {
      points[startPoint(ruleset, players, p)] = { owner: p, count: RULESETS.circuit.markers };
    }
  }
}

// ---------------------------------------------------------------------------
// Track geometry helpers
// ---------------------------------------------------------------------------

export function startPoint(ruleset, players, p) {
  if (ruleset === 'duel') return p === 0 ? 23 : 0;
  return (p * Math.floor(POINTS / players)) % POINTS;
}

// Distance a point represents along player p's track (0..23).
export function distanceOf(ruleset, players, p, point) {
  if (ruleset === 'duel') return p === 0 ? POINTS - 1 - point : point;
  const s = startPoint(ruleset, players, p);
  return (point - s + POINTS) % POINTS;
}

// Board point at a given distance along player p's track.
export function pointAtDistance(ruleset, players, p, dist) {
  if (ruleset === 'duel') return p === 0 ? POINTS - 1 - dist : dist;
  const s = startPoint(ruleset, players, p);
  return (s + dist) % POINTS;
}

export function markersOf(state, p) {
  let total = state.rail[p] + state.off[p];
  for (const cell of state.points) if (cell.owner === p) total += cell.count;
  return total;
}

export function allInHome(state, p) {
  if (state.rail[p] > 0) return false;
  const { ruleset, players } = state.cfg;
  for (let i = 0; i < POINTS; i++) {
    const cell = state.points[i];
    if (cell.owner === p && distanceOf(ruleset, players, p, i) < HOME_DIST) return false;
  }
  return true;
}

export function pipCount(state, p) {
  const { ruleset, players } = state.cfg;
  let pips = 0;
  for (let i = 0; i < POINTS; i++) {
    const cell = state.points[i];
    if (cell.owner === p) pips += cell.count * (TRACK_LEN - distanceOf(ruleset, players, p, i));
  }
  pips += state.rail[p] * TRACK_LEN;
  return pips;
}

// ---------------------------------------------------------------------------
// Move generation
// ---------------------------------------------------------------------------

// A single-die move candidate: {from: 'rail'|point, to: point|'off', die, hit}
function candidateMoves(state, p, die) {
  const { ruleset, players } = state.cfg;
  const out = [];
  const consider = (from, fromDist) => {
    const newDist = fromDist + die;
    if (newDist >= TRACK_LEN) {
      // Bearing off: exact, or over-sized only from the farthest marker.
      if (!allInHome(state, p)) return;
      if (fromDist === undefined) return; // rail never bears off
      if (newDist === TRACK_LEN) {
        out.push({ from, to: 'off', die, hit: false });
        return;
      }
      let farther = false;
      for (let i = 0; i < POINTS; i++) {
        const cell = state.points[i];
        if (cell.owner !== p || i === from) continue;
        const d = distanceOf(ruleset, players, p, i);
        if (d > fromDist && d < TRACK_LEN) { farther = true; break; }
      }
      if (!farther) out.push({ from, to: 'off', die, hit: false });
      return;
    }
    const to = pointAtDistance(ruleset, players, p, newDist);
    const cell = state.points[to];
    if (cell.owner === -1 || cell.owner === p) out.push({ from, to, die, hit: false });
    else if (cell.count === 1) out.push({ from, to, die, hit: true });
    // blocked otherwise
  };

  if (state.rail[p] > 0) {
    consider('rail', -1);
  } else {
    for (let i = 0; i < POINTS; i++) {
      const cell = state.points[i];
      if (cell.owner !== p) continue;
      consider(i, distanceOf(ruleset, players, p, i));
    }
  }
  return out;
}

const moveKey = (m) => `${m.from}>${m.to}:${m.die}`;

// Apply a single-die move directly to a state (assumed legal). Used by the
// search, by applyCommand after validation, and by tests.
function applyMoveRaw(state, p, move, events) {
  const cell = (i) => state.points[i];
  if (move.from === 'rail') state.rail[p] -= 1;
  else {
    cell(move.from).count -= 1;
    if (cell(move.from).count === 0) cell(move.from).owner = -1;
  }
  if (move.to === 'off') {
    state.off[p] += 1;
    state.stats.borneOff[p] += 1;
  } else {
    const dest = cell(move.to);
    if (move.hit) {
      const victim = dest.owner;
      state.rail[victim] += 1;
      state.stats.hits[p] += 1;
      dest.owner = p;
      dest.count = 1;
      if (events) events.push({ type: 'hit', player: p, victim, point: move.to });
    } else {
      dest.owner = p;
      dest.count += 1;
    }
  }
}

// Max number of dice playable from this position with this move multiset,
// plus the set of first-move keys that achieve it. Memoized per call.
function bestPlay(state, p, movesLeft) {
  const memo = new Map();
  const snap = () => ({
    points: state.points.map((c) => ({ owner: c.owner, count: c.count })),
    rail: state.rail.slice(), off: state.off.slice(),
    hits: state.stats.hits.slice(), borneOff: state.stats.borneOff.slice(),
  });
  const restore = (s) => {
    state.points = s.points; state.rail = s.rail; state.off = s.off;
    state.stats.hits = s.hits; state.stats.borneOff = s.borneOff;
  };
  const key = (left) =>
    state.points.map((c) => (c.owner * 16 + c.count + 32).toString(36)).join('') +
    '|' + state.rail.join(',') + '|' + state.off.join(',') + '|' + left.slice().sort((a, b) => a - b).join(',');

  const dfs = (left) => {
    if (!left.length) return 0;
    const k = key(left);
    if (memo.has(k)) return memo.get(k);
    let best = 0;
    const seen = new Set();
    for (const die of left) {
      if (seen.has(die)) continue;
      seen.add(die);
      const moves = candidateMoves(state, p, die);
      if (!moves.length) continue;
      for (const m of moves) {
        const s = snap();
        applyMoveRaw(state, p, m, null);
        const rest = left.slice();
        rest.splice(rest.indexOf(die), 1);
        const val = 1 + dfs(rest);
        restore(s);
        if (val > best) best = val;
      }
    }
    memo.set(k, best);
    return best;
  };

  const maxTotal = dfs(movesLeft.slice());
  const firsts = new Map(); // moveKey -> move
  if (maxTotal > 0) {
    const seen = new Set();
    for (const die of movesLeft) {
      if (seen.has(die)) continue;
      seen.add(die);
      for (const m of candidateMoves(state, p, die)) {
        const s = snap();
        applyMoveRaw(state, p, m, null);
        const rest = movesLeft.slice();
        rest.splice(rest.indexOf(die), 1);
        const val = 1 + dfs(rest);
        restore(s);
        if (val === maxTotal) firsts.set(moveKey(m), m);
      }
    }
  }
  return { maxTotal, moves: [...firsts.values()] };
}

// Legal immediate moves for the active player, enforcing the full-dice rules.
export function legalMoves(state) {
  if (state.phase !== 'move' || state.winner >= 0) return [];
  const p = state.active;
  const { maxTotal, moves } = bestPlay(state, p, state.movesLeft);
  // Higher-die rule: mixed roll, nothing used yet, only one die playable.
  if (
    moves.length && maxTotal === 1 &&
    state.dice.length === 2 &&
    state.dice[0] !== state.dice[1] &&
    state.movesLeft.length === 2
  ) {
    const hi = Math.max(state.dice[0], state.dice[1]);
    const filtered = moves.filter((m) => m.die === hi);
    if (filtered.length) return filtered;
  }
  return moves;
}

export function canPass(state) {
  return state.phase === 'move' && state.winner < 0 && legalMoves(state).length === 0;
}

export function canDouble(state) {
  if (state.phase !== 'roll' || state.winner >= 0) return false;
  if (!state.cfg.options.cube || state.cube.pending) return false;
  if (state.cube.value >= 64) return false;
  return state.cube.owner === -1 || state.cube.owner === state.active;
}

// Every legal action for the active player — the single API used by play,
// tutorials, and hints alike.
export function legalActions(state) {
  if (state.winner >= 0) return [];
  if (state.phase === 'roll') {
    const acts = [{ type: 'roll' }];
    if (canDouble(state)) acts.push({ type: 'double' });
    return acts;
  }
  if (state.phase === 'move') {
    const moves = legalMoves(state).map((m) => ({ type: 'move', ...m }));
    if (!moves.length) return [{ type: 'pass' }];
    return moves;
  }
  if (state.phase === 'cube') return [{ type: 'accept' }, { type: 'decline' }];
  return [];
}

// ---------------------------------------------------------------------------
// Command application
// ---------------------------------------------------------------------------

let cmdCounter = 0;
export function makeCmdId(prefix = 'cmd') {
  return `${prefix}-${Date.now().toString(36)}-${(cmdCounter++).toString(36)}`;
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

function fail(state, cmd, reason) {
  const next = cloneState(state);
  const actor = actorOf(next, cmd);
  if (actor >= 0) next.stats.invalid[actor] += 1;
  return { state: next, ok: false, events: [{ type: 'invalid', reason, command: cmd.type }] };
}

// Who a command is attributed to (for invalid-action stats and turn checks).
function actorOf(state, cmd) {
  if (state.phase === 'cube' && (cmd.type === 'accept' || cmd.type === 'decline'))
    return cubeResponder(state);
  if (cmd.player != null) return cmd.player;
  return state.active;
}

function cubeResponder(state) {
  const by = state.cube.pending?.by ?? 0;
  const n = state.cfg.players;
  return (by + 1) % n;
}

function rollDice(state) {
  const rng = createRng(state.rng);
  let d;
  if (state.scriptedDice.length) d = state.scriptedDice.shift();
  else d = [rng.int(6) + 1, rng.int(6) + 1];
  state.rng = rng.state;
  return d;
}

function endTurn(state, events) {
  const n = state.cfg.players;
  let next = state.active;
  for (let i = 0; i < n; i++) {
    next = (next + 1) % n;
    if (state.alive[next]) break;
  }
  state.active = next;
  state.dice = [];
  state.movesLeft = [];
  state.phase = 'roll';
  state.turnNum += 1;
  events.push({ type: 'turn', player: next, turnNum: state.turnNum });
  if (state.cfg.options.moveLimit && state.turnNum > state.cfg.options.moveLimit) {
    finishByLimit(state, events);
  }
}

function checkWin(state, p, events) {
  if (state.off[p] === RULESETS[state.cfg.ruleset].markers) {
    finish(state, p, 'bearoff', events);
    return true;
  }
  return false;
}

function gammonFactor(state, winner) {
  const { ruleset, players } = state.cfg;
  let worst = -1;
  for (let p = 0; p < players; p++) {
    if (p === winner || !state.alive[p]) continue;
    if (state.off[p] === 0) worst = p;
  }
  if (worst < 0) return { factor: 1, key: 'single', label: 'Straight win' };
  if (ruleset === 'duel') {
    // Backgammon: loser still has a marker on the rail or in winner's home.
    const inHome = state.points.some(
      (c, i) => c.owner === worst && distanceOf(ruleset, players, winner, i) >= HOME_DIST,
    );
    if (state.rail[worst] > 0 || inHome)
      return { factor: 3, key: 'backgammon', label: 'Grand sweep (×3)' };
  }
  return { factor: 2, key: 'gammon', label: 'Full sweep (×2)' };
}

function buildResult(state, winner, reason, baseOverride) {
  const { factor, key, label } = reason === 'bearoff'
    ? gammonFactor(state, winner)
    : { factor: 1, key: 'single', label: 'Straight win' };
  const cubeValue = baseOverride ?? state.cube.value;
  const pointsWon = cubeValue * factor;
  const breakdown = [
    { key: 'base', label: 'Stakes value', value: cubeValue },
  ];
  if (factor > 1) breakdown.push({ key, label, value: `×${factor}` });
  breakdown.push({ key: 'total', label: 'Match points', value: pointsWon });
  return {
    winner,
    reason,
    cubeValue,
    factor,
    points: pointsWon,
    breakdown,
    turns: state.turnNum,
    hits: state.stats.hits.slice(),
    invalid: state.stats.invalid.slice(),
    borneOff: state.off.slice(),
  };
}

function finish(state, winner, reason, events, baseOverride) {
  state.winner = winner;
  state.phase = 'over';
  state.dice = [];
  state.movesLeft = [];
  state.result = buildResult(state, winner, reason, baseOverride);
  events.push({ type: 'gameOver', result: state.result });
}

// Move-limit finish: most borne off, then fewer invalid actions, then lower
// pip count, then lower seat index (stable identifier order).
function finishByLimit(state, events) {
  const n = state.cfg.players;
  let best = -1;
  for (let p = 0; p < n; p++) {
    if (!state.alive[p]) continue;
    if (best < 0) { best = p; continue; }
    const a = state.off[p] - state.off[best];
    const b = state.stats.invalid[best] - state.stats.invalid[p];
    const c = pipCount(state, best) - pipCount(state, p);
    if (a > 0 || (a === 0 && b > 0) || (a === 0 && b === 0 && c > 0)) best = p;
  }
  finish(state, best, 'moveLimit', events);
}

export function applyCommand(state, cmd) {
  if (!cmd || typeof cmd.type !== 'string') return fail(state, { type: '?' }, 'malformed command');
  if (state.winner >= 0) return fail(state, cmd, 'game is over');
  const next = cloneState(state);
  const events = [];
  const p = next.active;

  switch (cmd.type) {
    case 'roll': {
      if (next.phase !== 'roll') return fail(state, cmd, 'not rolling phase');
      if (cmd.player != null && cmd.player !== p) return fail(state, cmd, 'out of turn');
      next.dice = rollDice(next);
      next.stats.rolls += 1;
      next.movesLeft = next.dice[0] === next.dice[1]
        ? [next.dice[0], next.dice[0], next.dice[0], next.dice[0]]
        : next.dice.slice();
      if (next.dice[0] === next.dice[1]) next.stats.doubles += 1;
      next.phase = 'move';
      next.tick += 1;
      events.push({ type: 'roll', player: p, dice: next.dice.slice(), turnNum: next.turnNum });
      if (legalMoves(next).length === 0) events.push({ type: 'noMoves', player: p });
      return { state: next, ok: true, events };
    }

    case 'move': {
      if (next.phase !== 'move') return fail(state, cmd, 'not moving phase');
      if (cmd.player != null && cmd.player !== p) return fail(state, cmd, 'out of turn');
      const legal = legalMoves(next);
      const from = cmd.from === 'rail' ? 'rail' : Number(cmd.from);
      const to = cmd.to === 'off' ? 'off' : Number(cmd.to);
      const die = Number(cmd.die);
      const move = legal.find((m) => m.from === from && m.to === to && m.die === die);
      if (!move) return fail(state, cmd, 'illegal move');
      applyMoveRaw(next, p, move, events);
      next.movesLeft.splice(next.movesLeft.indexOf(move.die), 1);
      next.tick += 1;
      events.push({ type: 'move', player: p, from: move.from, to: move.to, die: move.die, hit: move.hit });
      if (move.to === 'off') events.push({ type: 'bearOff', player: p, count: next.off[p] });
      if (checkWin(next, p, events)) return { state: next, ok: true, events };
      if (next.movesLeft.length === 0) endTurn(next, events);
      else if (legalMoves(next).length === 0) events.push({ type: 'noMoves', player: p });
      return { state: next, ok: true, events };
    }

    case 'pass': {
      if (next.phase !== 'move') return fail(state, cmd, 'not moving phase');
      if (cmd.player != null && cmd.player !== p) return fail(state, cmd, 'out of turn');
      if (!canPass(next)) return fail(state, cmd, 'moves still available');
      next.tick += 1;
      events.push({ type: 'pass', player: p });
      endTurn(next, events);
      return { state: next, ok: true, events };
    }

    case 'double': {
      if (cmd.player != null && cmd.player !== p) return fail(state, cmd, 'out of turn');
      if (!canDouble(next)) return fail(state, cmd, 'cannot offer the stakes now');
      next.cube.pending = { by: p, value: next.cube.value * 2 };
      next.phase = 'cube';
      next.tick += 1;
      events.push({ type: 'double', player: p, value: next.cube.pending.value });
      return { state: next, ok: true, events };
    }

    case 'accept':
    case 'decline': {
      if (next.phase !== 'cube' || !next.cube.pending) return fail(state, cmd, 'no stakes offer pending');
      const responder = cubeResponder(next);
      if (cmd.player != null && cmd.player !== responder) return fail(state, cmd, 'out of turn');
      const pending = next.cube.pending;
      next.tick += 1;
      if (cmd.type === 'accept') {
        next.cube.value = pending.value;
        next.cube.owner = responder;
        next.cube.pending = null;
        next.phase = 'roll';
        events.push({ type: 'accept', player: responder, value: pending.value });
      } else {
        next.cube.pending = null;
        events.push({ type: 'decline', player: responder });
        // Declining pays the pre-offer stakes to the offerer.
        finish(next, pending.by, 'decline', events, pending.value / 2);
      }
      return { state: next, ok: true, events };
    }

    case 'concede': {
      const who = cmd.player != null ? cmd.player : p;
      if (who < 0 || who >= next.cfg.players || !next.alive[who]) return fail(state, cmd, 'cannot concede');
      next.tick += 1;
      events.push({ type: 'concede', player: who });
      const n = next.cfg.players;
      const others = [];
      for (let q = 0; q < n; q++) if (q !== who && next.alive[q]) others.push(q);
      if (others.length === 1) {
        finish(next, others[0], 'concede', events);
      } else {
        // Multiplayer: the conceding caravan leaves the board.
        next.alive[who] = false;
        for (const cell of next.points) if (cell.owner === who) { cell.owner = -1; cell.count = 0; }
        next.rail[who] = 0;
        if (next.active === who) endTurn(next, events);
        events.push({ type: 'eliminated', player: who });
      }
      return { state: next, ok: true, events };
    }

    default:
      return fail(state, cmd, `unknown command "${cmd.type}"`);
  }
}

// ---------------------------------------------------------------------------
// Serialization, hashing, replay
// ---------------------------------------------------------------------------

export function serialize(state) {
  return JSON.stringify(state);
}

export function deserialize(json) {
  const state = typeof json === 'string' ? JSON.parse(json) : JSON.parse(JSON.stringify(json));
  if (state.version > RULES_VERSION) throw new RulesError(`state version ${state.version} newer than engine ${RULES_VERSION}`);
  migrate(state);
  return state;
}

// In-place migration of older serialized states to the current version.
export function migrate(state) {
  if (state.version === RULES_VERSION) return state;
  // v1 is the launch schema; future migrations chain here.
  state.version = RULES_VERSION;
  return state;
}

function canonical(state) {
  return {
    v: state.version,
    cfg: state.cfg,
    rng: state.rng,
    scripted: state.scriptedDice,
    tick: state.tick,
    turn: state.turnNum,
    phase: state.phase,
    active: state.active,
    alive: state.alive,
    dice: state.dice,
    left: state.movesLeft,
    pts: state.points.map((c) => [c.owner, c.count]),
    rail: state.rail,
    off: state.off,
    cube: state.cube,
    winner: state.winner,
    result: state.result,
  };
}

export function hashState(state) {
  const s = JSON.stringify(canonical(state));
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193);
    h2 = Math.imul(h2 + s.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

// Replay an ordered command log; returns terminal state plus periodic hashes.
export function replay(cfg, commands) {
  let state = createGame(cfg);
  const hashes = [hashState(state)];
  const applied = [];
  for (const cmd of commands) {
    const r = applyCommand(state, cmd);
    state = r.state;
    applied.push({ cmd: cmd.type, ok: r.ok });
    hashes.push(hashState(state));
    if (state.winner >= 0) break;
  }
  return { state, hashes, applied, finalHash: hashes[hashes.length - 1] };
}
