// Bearing Board — determinism, replay, and fuzz tests.
// Property: same (version, seed, command list) → identical state hashes.
// Fuzz: malformed commands never hang, crash, or corrupt marker counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Rules from '../js/rules.js';
import { aiCommand } from '../js/ai.js';

function randomGameCommands(seedStr, maxCmds = 400) {
  const rng = Rules.createRng(Rules.hashSeed(seedStr));
  const cfg = {
    id: `fuzz-${seedStr}`, version: 1,
    ruleset: rng.next() < 0.5 ? 'duel' : 'circuit',
    players: 2, seed: Rules.hashSeed(seedStr) >>> 0,
    options: { cube: rng.next() < 0.5 },
  };
  if (cfg.ruleset === 'circuit') cfg.options = {};
  let state = Rules.createGame(cfg);
  const commands = [];
  let guard = maxCmds;
  while (state.winner < 0 && guard-- > 0) {
    const seat = state.phase === 'cube'
      ? (state.cube.pending.by + 1) % state.cfg.players
      : state.active;
    let cmd;
    if (rng.next() < 0.5) {
      // Random legal action.
      const acts = Rules.legalActions(state);
      if (!acts.length) break;
      const a = acts[rng.int(acts.length)];
      cmd = { type: a.type, player: seat };
      if (a.type === 'move') { cmd.from = a.from; cmd.to = a.to; cmd.die = a.die; }
    } else {
      cmd = aiCommand(state, seat, 'steady');
      if (!cmd) break;
    }
    const r = Rules.applyCommand(state, cmd);
    if (r.ok) {
      commands.push(cmd);
      state = r.state;
    }
  }
  return { cfg, commands, finalState: state };
}

test('replay property: same seed + commands → identical hashes (30 games)', () => {
  for (let i = 0; i < 30; i++) {
    const { cfg, commands, finalState } = randomGameCommands(`prop-${i}`);
    const a = Rules.replay(cfg, commands);
    const b = Rules.replay(cfg, commands);
    assert.equal(a.finalHash, b.finalHash, `game ${i} replay mismatch`);
    assert.equal(a.finalHash, Rules.hashState(finalState), `game ${i} live/replay mismatch`);
    assert.deepEqual(a.hashes, b.hashes);
  }
});

test('games terminate: AI vs AI finishes within a sane bound', () => {
  for (const ruleset of ['duel', 'circuit']) {
    const { finalState } = randomGameCommands(`term-${ruleset}`, 3000);
    assert.ok(finalState.winner >= 0, `${ruleset} did not terminate`);
    assert.ok(finalState.turnNum < 600, `${ruleset} took ${finalState.turnNum} turns`);
  }
});

test('fuzz: malformed commands never hang or corrupt state', () => {
  const rng = Rules.createRng(Rules.hashSeed('fuzz-malformed'));
  let state = Rules.createGame({ id: 'fz', version: 1, ruleset: 'duel', players: 2, seed: 1 });
  for (let i = 0; i < 500; i++) {
    const junk = [
      null, undefined, 42, 'roll', {}, { type: 'move' },
      { type: 'move', from: -1, to: 99, die: 0 },
      { type: 'move', from: 'x', to: {}, die: NaN },
      { type: 'roll', player: 99 },
      { type: 'accept' }, { type: 'double', player: -3 },
      { type: 'concede', player: 42 },
      { type: 'move', from: 0, to: 'off', die: 7 },
      { type: 'pass', player: 'zero' },
    ][rng.int(11)];
    const r = Rules.applyCommand(state, junk);
    state = r.state;
    // Invariants after every single command, ok or not.
    assert.equal(Rules.markersOf(state, 0), 15, 'player 0 markers lost');
    assert.equal(Rules.markersOf(state, 1), 15, 'player 1 markers lost');
    assert.ok(Number.isInteger(state.tick) && state.tick >= 0);
    assert.ok(['roll', 'move', 'cube', 'over'].includes(state.phase));
    if (state.winner >= 0) break;
    // Mix in a real legal action sometimes so the game also progresses.
    if (i % 3 === 0) {
      const acts = Rules.legalActions(state);
      if (acts.length) {
        const a = acts[rng.int(acts.length)];
        const cmd = { type: a.type };
        if (a.type === 'move') { cmd.from = a.from; cmd.to = a.to; cmd.die = a.die; }
        state = Rules.applyCommand(state, cmd).state;
      }
    }
  }
});

test('state hashes differ across seeds and match across resumes', () => {
  const g1 = Rules.createGame({ id: 'h1', version: 1, ruleset: 'duel', players: 2, seed: 100 });
  const g2 = Rules.createGame({ id: 'h2', version: 1, ruleset: 'duel', players: 2, seed: 101 });
  assert.notEqual(Rules.hashState(g1), Rules.hashState(g2));
  const resumed = Rules.deserialize(Rules.serialize(g1));
  assert.equal(Rules.hashState(resumed), Rules.hashState(g1));
});

test('replay envelope carries terminal result and monotonic ticks', () => {
  const { cfg, commands } = randomGameCommands('envelope');
  const r = Rules.replay(cfg, commands);
  assert.ok(r.hashes.length >= 2);
  assert.equal(r.hashes.length, r.applied.length + 1);
});
