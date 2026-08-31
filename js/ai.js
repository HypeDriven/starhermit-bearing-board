// Bearing Board — deterministic practice AI.
// The AI never peeks at hidden state and never bypasses the rules: it plans
// with the same legalMoves()/legalActions() API the player UI uses. All
// tie-breaking noise comes from a seeded stream derived from the public game
// state, so the same position always produces the same AI decision.

import {
  createRng, hashSeed, legalMoves, pipCount, distanceOf, canDouble,
  POINTS, HOME_DIST,
} from './rules.js';

export const DIFFICULTIES = {
  casual: { key: 'casual', label: 'Casual', blurb: 'Plays loose and friendly. Good for learning.' },
  steady: { key: 'steady', label: 'Steady', blurb: 'Solid one-move judgement.' },
  sharp: { key: 'sharp', label: 'Sharp', blurb: 'Searches whole turns and weighs every risk.' },
};

const WEIGHTS = {
  steady: { off: 60, pip: -1.0, rail: -28, blot: -7, exposed: -13, made: 5, homeMade: 4, anchor: 6 },
  sharp: { off: 90, pip: -1.2, rail: -38, blot: -9, exposed: -18, made: 7, homeMade: 6, anchor: 9 },
};

function aiRng(state, seat, salt) {
  return createRng(hashSeed(`${state.cfg.seed}:${state.turnNum}:${seat}:${salt}`));
}

// Positional evaluation from player p's perspective. Higher is better for p.
export function evaluate(state, p, w) {
  const { ruleset, players } = state.cfg;
  const terms = (q) => {
    let score = w.off * state.off[q] + w.pip * pipCount(state, q) + w.rail * state.rail[q];
    for (let i = 0; i < POINTS; i++) {
      const cell = state.points[i];
      if (cell.owner !== q) continue;
      const dist = distanceOf(ruleset, players, q, i);
      if (cell.count === 1) {
        score += w.blot;
        // Blots an opponent can reach are worth even less.
        if (blotExposed(state, q, i)) score += w.exposed;
      } else if (cell.count >= 2) {
        score += w.made;
        if (dist >= HOME_DIST) score += w.homeMade;
      }
      // Anchors deep in hostile territory slow the other side down.
      if (cell.count >= 2 && dist <= 5 && ruleset === 'duel') score += w.anchor;
    }
    return score;
  };
  let total = terms(p);
  for (let q = 0; q < players; q++) if (q !== p && state.alive[q]) total -= terms(q) / (players - 1);
  return total;
}

// Is the blot on `point` attackable by any opponent marker within die range?
function blotExposed(state, q, point) {
  const { ruleset, players } = state.cfg;
  for (let o = 0; o < players; o++) {
    if (o === q || !state.alive[o]) continue;
    const oDist = distanceOf(ruleset, players, o, point);
    // Rail entries land at distance 0..5 of the attacker's track.
    if (state.rail[o] > 0 && oDist <= 5) return true;
    for (let i = 0; i < POINTS; i++) {
      const cell = state.points[i];
      if (cell.owner !== o) continue;
      const from = distanceOf(ruleset, players, o, i);
      const gap = oDist - from;
      if (ruleset === 'duel' ? gap >= 1 && gap <= 6 : (gap + POINTS) % POINTS >= 1 && (gap + POINTS) % POINTS <= 12)
        return true;
    }
  }
  return false;
}

function cloneForSearch(state) {
  return {
    ...state,
    alive: state.alive.slice(),
    dice: state.dice.slice(),
    movesLeft: state.movesLeft.slice(),
    points: state.points.map((c) => ({ owner: c.owner, count: c.count })),
    rail: state.rail.slice(),
    off: state.off.slice(),
    cube: { ...state.cube, pending: state.cube.pending ? { ...state.cube.pending } : null },
    stats: {
      ...state.stats,
      invalid: state.stats.invalid.slice(), hits: state.stats.hits.slice(),
      borneOff: state.stats.borneOff.slice(),
    },
  };
}

// Apply a move to a search clone without validation (move came from legalMoves).
function applyInPlace(state, p, move) {
  const at = (i) => state.points[i];
  if (move.from === 'rail') state.rail[p] -= 1;
  else {
    at(move.from).count -= 1;
    if (at(move.from).count === 0) at(move.from).owner = -1;
  }
  if (move.to === 'off') state.off[p] += 1;
  else {
    const dest = at(move.to);
    if (move.hit) { state.rail[dest.owner] += 1; dest.owner = p; dest.count = 1; }
    else { dest.owner = p; dest.count += 1; }
  }
  state.movesLeft.splice(state.movesLeft.indexOf(move.die), 1);
}

// Full-turn plan for `seat` to play from a phase:'move' state.
// Returns { moves: [...], score } — the complete best sequence found.
export function planTurn(state, seat, difficulty, budget = 24000) {
  const rng = aiRng(state, seat, 'plan');
  if (difficulty === 'casual') {
    // Random legal sequence.
    const work = cloneForSearch(state);
    const moves = [];
    for (;;) {
      const legal = legalMoves(work);
      if (!legal.length || !work.movesLeft.length) break;
      const m = legal[rng.int(legal.length)];
      applyInPlace(work, seat, m);
      moves.push(m);
    }
    return { moves, score: 0 };
  }

  const w = WEIGHTS[difficulty] || WEIGHTS.sharp;
  let nodes = 0;
  let best = null;

  if (difficulty === 'steady') {
    // Greedy one-ply: repeatedly take the move with the best immediate eval.
    const work = cloneForSearch(state);
    const moves = [];
    for (;;) {
      const legal = legalMoves(work);
      if (!legal.length || !work.movesLeft.length) break;
      let pick = null; let pickScore = -Infinity;
      for (const m of legal) {
        const next = cloneForSearch(work);
        applyInPlace(next, seat, m);
        const s = evaluate(next, seat, w) + rng.next() * 0.001;
        if (s > pickScore) { pickScore = s; pick = m; }
      }
      applyInPlace(work, seat, pick);
      moves.push(pick);
    }
    return { moves, score: moves.length ? evaluate(work, seat, w) : 0 };
  }

  // sharp: exhaustive turn search with a node budget and greedy fallback.
  const root = cloneForSearch(state);
  const greedy = planTurn(state, seat, 'steady');
  const dfs = (st, seq) => {
    if (++nodes > budget) return;
    const legal = st.movesLeft.length ? legalMoves(st) : [];
    if (!legal.length) {
      const score = evaluate(st, seat, w) + rng.next() * 0.001;
      if (!best || score > best.score) best = { moves: seq.slice(), score };
      return;
    }
    for (const m of legal) {
      const next = cloneForSearch(st);
      applyInPlace(next, seat, m);
      seq.push(m);
      dfs(next, seq);
      seq.pop();
    }
  };
  dfs(root, []);
  if (!best) return greedy;
  // A budget-truncated search may have missed the greedy line; keep the better.
  const greedyScore = simulateScore(state, seat, greedy.moves, w);
  return best.score >= greedyScore ? best : { moves: greedy.moves, score: greedyScore };
}

function simulateScore(state, seat, moves, w) {
  const work = cloneForSearch(state);
  for (const m of moves) applyInPlace(work, seat, m);
  return evaluate(work, seat, w);
}

// Should `seat` offer the stakes cube before rolling? (duel only)
export function shouldDouble(state, seat, difficulty) {
  if (!canDouble(state)) return false;
  if (difficulty === 'casual') return false;
  const w = WEIGHTS[difficulty] || WEIGHTS.sharp;
  const edge = evaluate(state, seat, w);
  const threshold = difficulty === 'sharp' ? 26 : 40;
  return edge > threshold;
}

// Should `seat` (the responder) accept a pending double?
export function shouldAccept(state, seat, difficulty) {
  const w = WEIGHTS[difficulty] || WEIGHTS.sharp;
  const edge = evaluate(state, seat, w);
  const drop = difficulty === 'casual' ? -20 : difficulty === 'steady' ? -55 : -75;
  return edge > drop;
}

// Whole-decision entry point used by the session controller. Returns the next
// single command the AI would issue in this state, or null if it cannot act.
export function aiCommand(state, seat, difficulty) {
  if (state.winner >= 0) return null;
  if (state.phase === 'roll') {
    if (state.active !== seat) return null;
    if (shouldDouble(state, seat, difficulty)) return { type: 'double', player: seat };
    return { type: 'roll', player: seat };
  }
  if (state.phase === 'move') {
    if (state.active !== seat) return null;
    const legal = legalMoves(state);
    if (!legal.length) return { type: 'pass', player: seat };
    const plan = planTurn(state, seat, difficulty);
    const first = plan.moves[0];
    if (!first) return { type: 'pass', player: seat };
    return { type: 'move', player: seat, from: first.from, to: first.to, die: first.die };
  }
  if (state.phase === 'cube') {
    const by = state.cube.pending?.by;
    if (by == null || by === seat) return null;
    return { type: shouldAccept(state, seat, difficulty) ? 'accept' : 'decline', player: seat };
  }
  return null;
}

// Hint for the human: plan with 'sharp' from the current position and explain
// the first step. Uses the same legal-move API as play.
export function suggestHint(state, seat) {
  if (state.phase === 'roll') return { kind: 'roll', text: 'Roll the dice.' };
  if (state.phase !== 'move') return null;
  const legal = legalMoves(state);
  if (!legal.length) return { kind: 'pass', text: 'No legal move — you must pass.' };
  const plan = planTurn(state, seat, 'sharp');
  const m = plan.moves[0] || legal[0];
  const fromText = m.from === 'rail' ? 'the rail' : `point ${m.from + 1}`;
  const toText = m.to === 'off' ? 'off the board' : `point ${m.to + 1}`;
  let why = m.hit ? 'It hits an exposed marker.' : m.to === 'off' ? 'It bears a marker off.' : '';
  return { kind: 'move', move: m, text: `Move from ${fromText} to ${toText} with the ${m.die}. ${why}`.trim() };
}
