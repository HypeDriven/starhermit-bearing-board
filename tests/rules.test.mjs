// Bearing Board — rules engine unit tests: every legal action, invalid-action
// reason, scoring component, terminal state, serialization.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Rules from '../js/rules.js';
import { duelLayout, circuitLayout } from '../js/content.js';

const base = { id: 't', version: 1, ruleset: 'duel', players: 2, seed: 42 };

function game(cfg = {}) {
  return Rules.createGame({ ...base, ...cfg });
}

function roll(state, dice) {
  state.scriptedDice = [dice];
  const r = Rules.applyCommand(state, { type: 'roll', player: state.active });
  assert.ok(r.ok, r.events[0]?.reason);
  return r.state;
}

test('default duel layout: 15 markers each, mirrored', () => {
  const s = game();
  assert.equal(Rules.markersOf(s, 0), 15);
  assert.equal(Rules.markersOf(s, 1), 15);
  assert.equal(s.phase, 'roll');
  assert.equal(s.active, 0);
  assert.equal(s.tick, 0);
  assert.equal(s.turnNum, 1);
});

test('circuit layout: 8 markers per gate, 2–4 players', () => {
  for (const n of [2, 3, 4]) {
    const s = Rules.createGame({ id: 'c', version: 1, ruleset: 'circuit', players: n, seed: 7 });
    for (let p = 0; p < n; p++) assert.equal(Rules.markersOf(s, p), 8);
  }
  assert.throws(() => Rules.createGame({ id: 'c', version: 1, ruleset: 'circuit', players: 5, seed: 7 }));
});

test('config validation errors are explicit', () => {
  assert.ok(Rules.validateConfig({}).length > 0);
  assert.ok(Rules.validateConfig({ ...base, seed: 1, options: { cube: true }, ruleset: 'circuit' }).some((e) => e.includes('cube')));
  assert.ok(Rules.validateConfig({ ...base, seed: 'x' }).some((e) => e.includes('seed')));
});

test('roll produces movesLeft; doubles grant four', () => {
  let s = game({ scriptedDice: [[3, 3]] });
  s = roll(s, [3, 3]);
  assert.deepEqual(s.movesLeft, [3, 3, 3, 3]);
  assert.equal(s.stats.doubles, 1);
  s = game({ scriptedDice: [[2, 5]] });
  s = roll(s, [2, 5]);
  assert.deepEqual(s.movesLeft.sort(), [2, 5]);
});

test('moving onto a blot hits it onto the rail', () => {
  const s = game({
    layout: duelLayout([[9, 1]], [[4, 1]]),
    scriptedDice: [[5, 2]],
  });
  const rolled = roll(s, [5, 2]);
  const hit = Rules.legalMoves(rolled).find((m) => m.from === 9 && m.to === 4 && m.die === 5);
  assert.ok(hit?.hit, 'expected a hitting move');
  const r = Rules.applyCommand(rolled, { type: 'move', player: 0, from: 9, to: 4, die: 5 });
  assert.ok(r.ok);
  assert.equal(r.state.rail[1], 1);
  assert.equal(r.state.points[4].owner, 0);
  assert.equal(r.state.stats.hits[0], 1);
});

test('rail markers must re-enter before any other move', () => {
  const s = game({
    layout: duelLayout([[10, 2]], [[4, 1]], { rail0: 1 }),
    scriptedDice: [[3, 4]],
  });
  const rolled = roll(s, [3, 4]);
  const legal = Rules.legalMoves(rolled);
  assert.ok(legal.length > 0);
  assert.ok(legal.every((m) => m.from === 'rail'), 'only rail entries are legal');
  // A non-rail move must be rejected with a reason.
  const bad = Rules.applyCommand(rolled, { type: 'move', player: 0, from: 10, to: 6, die: 4 });
  assert.equal(bad.ok, false);
  assert.equal(bad.events[0].type, 'invalid');
  assert.equal(bad.state.stats.invalid[0], 1);
});

test('higher-die rule: only one die playable → must use the higher', () => {
  // p0 single marker at dist 13 (point 10), 14 already off. Wall of p1 at
  // dist 23 (point 0). Dice 6/4: 13+6=19 then 19+4=23 blocked; 13+4=17 then
  // 17+6=23 blocked — only one die can be played, so it must be the 6.
  const s = game({
    layout: duelLayout([[10, 1]], [[0, 15]], { off0: 14 }),
    scriptedDice: [[6, 4]],
  });
  const rolled = roll(s, [6, 4]);
  const legal = Rules.legalMoves(rolled);
  assert.ok(legal.length > 0);
  assert.ok(legal.every((m) => m.die === 6), `expected only die 6, got ${JSON.stringify(legal)}`);
});

test('bearing off: exact, oversized-from-farthest, and home-stretch gate', () => {
  // All home: markers at dist 20 (point 3) and dist 23 (point 0), 13 off.
  const s = game({
    layout: duelLayout([[3, 1], [0, 1]], [[20, 15]], { off0: 13 }),
    scriptedDice: [[6, 2]],
  });
  let rolled = roll(s, [6, 2]);
  let legal = Rules.legalMoves(rolled);
  // Die 6 may bear off ONLY from the farthest marker (point 0, dist 23).
  assert.ok(legal.filter((m) => m.die === 6).every((m) => m.from === 0 && m.to === 'off'));
  // Die 2 may bear off from point 0 or move point 3.
  assert.ok(legal.some((m) => m.die === 2 && m.from === 0 && m.to === 'off'));

  // Not all home → no bearing off at all, even with an exact die.
  const s2 = game({
    layout: duelLayout([[3, 1], [12, 1]], [[20, 15]], { off0: 13 }),
    scriptedDice: [[4, 2]],
  });
  rolled = roll(s2, [4, 2]);
  legal = Rules.legalMoves(rolled);
  assert.ok(legal.every((m) => m.to !== 'off'), 'no off move while a marker is outside home');
});

test('winning by bearoff ends the game with a breakdown', () => {
  const s = game({
    layout: duelLayout([[0, 1]], [[20, 15]], { off0: 14 }),
    scriptedDice: [[1, 1]],
  });
  const rolled = roll(s, [1, 1]);
  const r = Rules.applyCommand(rolled, { type: 'move', player: 0, from: 0, to: 'off', die: 1 });
  assert.ok(r.ok);
  assert.equal(r.state.winner, 0);
  assert.equal(r.state.phase, 'over');
  const res = r.state.result;
  assert.equal(res.reason, 'bearoff');
  assert.equal(res.points, res.cubeValue * res.factor);
  assert.ok(Array.isArray(res.breakdown) && res.breakdown.length >= 2);
  // Commands after the end are rejected.
  const after = Rules.applyCommand(r.state, { type: 'roll', player: 1 });
  assert.equal(after.ok, false);
  assert.match(after.events[0].reason, /over/);
});

test('gammon and backgammon factors', () => {
  // Rival has borne nothing off and sits in winner's home → backgammon ×3.
  const s = game({
    layout: duelLayout([[0, 1]], [[3, 1]], { off0: 14, fill1: 20 }),
    scriptedDice: [[2, 2]],
  });
  let rolled = roll(s, [2, 2]);
  const r = Rules.applyCommand(rolled, { type: 'move', player: 0, from: 0, to: 'off', die: 2 });
  assert.equal(r.state.result.factor, 3);

  // Rival has borne at least one off → single.
  const s2 = game({
    layout: duelLayout([[0, 1]], [[20, 14]], { off0: 14, off1: 1 }),
    scriptedDice: [[2, 2]],
  });
  rolled = roll(s2, [2, 2]);
  const r2 = Rules.applyCommand(rolled, { type: 'move', player: 0, from: 0, to: 'off', die: 2 });
  assert.equal(r2.state.result.factor, 1);
});

test('stakes cube: offer, accept, ownership, decline payout', () => {
  let s = game({ options: { cube: true }, scriptedDice: [[3, 1]] });
  assert.ok(Rules.legalActions(s).some((a) => a.type === 'double'));
  let r = Rules.applyCommand(s, { type: 'double', player: 0 });
  assert.ok(r.ok);
  assert.equal(r.state.phase, 'cube');
  // Player 0 cannot answer their own offer.
  r = Rules.applyCommand(r.state, { type: 'accept', player: 0 });
  assert.equal(r.ok, false);
  // Player 1 accepts.
  r = Rules.applyCommand(r.state, { type: 'accept', player: 1 });
  assert.ok(r.ok);
  assert.equal(r.state.cube.value, 2);
  assert.equal(r.state.cube.owner, 1);
  assert.equal(r.state.phase, 'roll');
  assert.equal(Rules.canDouble(r.state), false); // p0 doesn't own the cube

  // Decline pays the pre-offer stakes to the offerer.
  s = game({ options: { cube: true } });
  r = Rules.applyCommand(s, { type: 'double', player: 0 });
  r = Rules.applyCommand(r.state, { type: 'decline', player: 1 });
  assert.equal(r.state.winner, 0);
  assert.equal(r.state.result.reason, 'decline');
  assert.equal(r.state.result.points, 1);
});

test('pass only when nothing is playable', () => {
  let s = game({ scriptedDice: [[3, 1]] });
  const rolled = roll(s, [3, 1]);
  const bad = Rules.applyCommand(rolled, { type: 'pass', player: 0 });
  assert.equal(bad.ok, false);
  assert.match(bad.events[0].reason, /moves still available/);
});

test('out-of-turn commands are rejected', () => {
  const s = game();
  const r = Rules.applyCommand(s, { type: 'roll', player: 1 });
  assert.equal(r.ok, false);
  assert.match(r.events[0].reason, /out of turn/);
});

test('malformed commands fail safely', () => {
  const s = game();
  for (const cmd of [null, {}, { type: 7 }, { type: 'explode' }, 'roll']) {
    const r = Rules.applyCommand(s, cmd);
    assert.equal(r.ok, false);
  }
});

test('concede: duel ends; multiplayer circuit removes the caravan', () => {
  let s = game();
  let r = Rules.applyCommand(s, { type: 'concede', player: 1 });
  assert.equal(r.state.winner, 0);
  assert.equal(r.state.result.reason, 'concede');

  s = Rules.createGame({ id: 'c3', version: 1, ruleset: 'circuit', players: 3, seed: 9 });
  r = Rules.applyCommand(s, { type: 'concede', player: 1 });
  assert.ok(r.ok);
  assert.equal(r.state.winner, -1);
  assert.equal(r.state.alive[1], false);
  assert.equal(Rules.markersOf(r.state, 1), 0);
});

test('move limit finishes with deterministic tie-break', () => {
  const s = game({
    options: { moveLimit: 2 },
    layout: duelLayout([[23, 15]], [[0, 15]], { off0: 0, off1: 0 }),
    scriptedDice: [[1, 2], [3, 4]],
  });
  let st = roll(s, [1, 2]);
  // Use both dice, then rival uses both — turn 3 start triggers the limit.
  let legal = Rules.legalMoves(st);
  let r = Rules.applyCommand(st, { type: 'move', player: 0, ...legal[0] });
  st = r.state;
  legal = Rules.legalMoves(st);
  if (legal.length) { r = Rules.applyCommand(st, { type: 'move', player: 0, ...legal[0] }); st = r.state; }
  assert.equal(st.active, 1);
  st = roll(st, [3, 4]);
  legal = Rules.legalMoves(st);
  r = Rules.applyCommand(st, { type: 'move', player: 1, ...legal[0] });
  st = r.state;
  legal = Rules.legalMoves(st);
  if (legal.length) { r = Rules.applyCommand(st, { type: 'move', player: 1, ...legal[0] }); st = r.state; }
  if (st.winner < 0 && Rules.canPass(st)) st = Rules.applyCommand(st, { type: 'pass', player: 1 }).state;
  assert.ok(st.winner >= 0, 'move limit must end the game');
  assert.equal(st.result.reason, 'moveLimit');
});

test('serialization round-trip preserves the state hash', () => {
  let s = game({ scriptedDice: [[4, 2]] });
  s = roll(s, [4, 2]);
  const json = Rules.serialize(s);
  const back = Rules.deserialize(json);
  assert.equal(Rules.hashState(back), Rules.hashState(s));
});

test('markers are conserved through hits and bearoffs', () => {
  const s = game({
    layout: duelLayout([[9, 1]], [[4, 1]]),
    scriptedDice: [[5, 2]],
  });
  let st = roll(s, [5, 2]);
  st = Rules.applyCommand(st, { type: 'move', player: 0, from: 9, to: 4, die: 5 }).state;
  assert.equal(Rules.markersOf(st, 0), 15);
  assert.equal(Rules.markersOf(st, 1), 15);
});

test('circuit: everyone travels the same direction', () => {
  const s = Rules.createGame({ id: 'cc', version: 1, ruleset: 'circuit', players: 2, seed: 5 });
  // Both gates move +dice around the loop.
  assert.equal(Rules.pointAtDistance('circuit', 2, 0, 3), 3);
  assert.equal(Rules.pointAtDistance('circuit', 2, 1, 3), 15);
});

test('circuitLayout helper fills gates correctly', () => {
  const l = circuitLayout(3, [[[4, 4]], [[1, 2]], []]);
  const counts = [0, 0, 0];
  for (const c of l.points) counts[c.owner] += c.count;
  assert.deepEqual(counts, [8, 8, 8]);
});
