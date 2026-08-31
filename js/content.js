// Bearing Board — versioned content: lessons, journey stages, daily challenge,
// practice configs, challenges, themes, achievements, and offline validators.
// Every definition carries identifier, version, seed, initial state, goals,
// allowed mechanics, par values, tutorial flags, and presentation theme.

import { hashSeed, createRng, validateConfig, RULESETS } from './rules.js';

export const CONTENT_VERSION = 1;

// ---------------------------------------------------------------------------
// Layout builders (authored stages stay compact and always sum correctly)
// ---------------------------------------------------------------------------

// Merge duplicate point cells and top up each side to its marker quota on a
// fill point, so authored stages only list the interesting cells.
export function duelLayout(p0cells, p1cells, extra = {}) {
  const markers = RULESETS.duel.markers;
  const merge = (cells) => {
    const map = new Map();
    for (const [point, count] of cells) map.set(point, (map.get(point) || 0) + count);
    return map;
  };
  const rail = [extra.rail0 || 0, extra.rail1 || 0];
  const off = [extra.off0 || 0, extra.off1 || 0];
  const m0 = merge(p0cells);
  const m1 = merge(p1cells);
  const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);
  const fill = (m, owner, fillPoint) => {
    const placed = sum(m) + rail[owner] + off[owner];
    const rest = markers - placed;
    if (rest < 0) throw new Error(`duelLayout: player ${owner} over-placed by ${-rest}`);
    if (rest > 0) m.set(fillPoint, (m.get(fillPoint) || 0) + rest);
  };
  fill(m0, 0, extra.fill0 ?? 23);
  fill(m1, 1, extra.fill1 ?? 0);
  const points = [];
  for (const [point, count] of m0) points.push({ point, owner: 0, count });
  for (const [point, count] of m1) points.push({ point, owner: 1, count });
  return { points, rail, off };
}

export function circuitLayout(players, stacks, extra = {}) {
  const markers = RULESETS.circuit.markers;
  const rail = extra.rail || new Array(players).fill(0);
  const off = extra.off || new Array(players).fill(0);
  const points = [];
  for (let p = 0; p < players; p++) {
    const cells = new Map(stacks[p] || []);
    const placed = [...cells.values()].reduce((a, b) => a + b, 0) + rail[p] + off[p];
    const rest = markers - placed;
    if (rest < 0) throw new Error(`circuitLayout: player ${p} over-placed`);
    const gate = p * Math.floor(24 / players);
    if (rest > 0) cells.set(gate, (cells.get(gate) || 0) + rest);
    for (const [point, count] of cells) points.push({ point, owner: p, count });
  }
  return { points, rail, off };
}

// ---------------------------------------------------------------------------
// Shared config factory
// ---------------------------------------------------------------------------

let seq = 0;
export function makeDef(partial) {
  return {
    version: CONTENT_VERSION,
    kind: 'practice',
    ruleset: 'duel',
    players: 2,
    seed: hashSeed(`bearing-board:${partial.id || 'anon'}:${seq++}`),
    options: {},
    goals: { win: true },
    par: { turns: 80, timeSec: 600 },
    mechanics: { undo: true, hint: true },
    theme: 'caravan',
    ai: { difficulty: 'steady' },
    ranked: false,
    name: partial.id || 'Untitled',
    blurb: '',
    ...partial,
    id: partial.id,
  };
}

// ---------------------------------------------------------------------------
// Learn — interactive lessons, one rule at a time, performed by the player
// ---------------------------------------------------------------------------

export const LESSONS = [
  makeDef({
    id: 'lesson-roll', kind: 'learn', name: 'Lesson 1 — Roll & Travel',
    blurb: 'Roll the dice and move two markers along your track.',
    seed: 101, scriptedDice: [[3, 1], [2, 5], [4, 6], [1, 1]],
    ai: { difficulty: 'casual' }, par: { turns: 4, timeSec: 240 },
    tutorial: {
      steps: [
        { expect: 'roll', text: 'You travel from the far gate (point 24) toward home. Press Roll.' },
        { expect: 'move', times: 2, text: 'Each die moves one marker. Your markers glow — pick one, then a lit destination.' },
        { expect: 'roll', text: 'Well traveled. Roll again whenever you like, or finish the lesson.' },
      ],
    },
  }),
  makeDef({
    id: 'lesson-hit', kind: 'learn', name: 'Lesson 2 — Striking Blots',
    blurb: 'Land on a lone rival marker to send it to the rail.',
    seed: 102, scriptedDice: [[5, 2], [3, 3]],
    layout: duelLayout([[9, 1]], [[4, 1]]),
    ai: { difficulty: 'casual' }, par: { turns: 3, timeSec: 240 },
    tutorial: {
      steps: [
        { expect: 'roll', text: 'A single rival marker on a point is a blot. Yours on point 10 can reach it.' },
        { expect: 'hit', text: 'Use the 5: move your blot from point 10 onto point 5 to strike.' },
        { expect: 'move', text: 'Struck! Their marker sits on the rail. Spend your remaining die.' },
      ],
    },
  }),
  makeDef({
    id: 'lesson-rail', kind: 'learn', name: 'Lesson 3 — Off the Rail',
    blurb: 'Struck markers must re-enter before anything else moves.',
    seed: 103, scriptedDice: [[3, 5], [2, 2]],
    layout: duelLayout([[5, 14]], [[11, 1]], { rail0: 1 }),
    ai: { difficulty: 'casual' }, par: { turns: 3, timeSec: 240 },
    tutorial: {
      steps: [
        { expect: 'roll', text: 'One of your markers is on the rail. It must come back first.' },
        { expect: 'enter', text: 'Roll, then choose the rail marker — it re-enters in the rival home stretch.' },
        { expect: 'move', text: 'Back in play. Spend the other die.' },
      ],
    },
  }),
  makeDef({
    id: 'lesson-doubles', kind: 'learn', name: 'Lesson 4 — Double Dice',
    blurb: 'Matching dice grant four moves instead of two.',
    seed: 104, scriptedDice: [[4, 4], [6, 3]],
    ai: { difficulty: 'casual' }, par: { turns: 3, timeSec: 300 },
    tutorial: {
      steps: [
        { expect: 'roll', text: 'Doubles are lucky: the same number four times.' },
        { expect: 'move', times: 4, text: 'You rolled double 4 — make four moves of 4.' },
      ],
    },
  }),
  makeDef({
    id: 'lesson-bearoff', kind: 'learn', name: 'Lesson 5 — Bearing Off',
    blurb: 'Bring every marker home, then carry them off the board.',
    seed: 105, scriptedDice: [[6, 6], [5, 4], [3, 2]],
    layout: duelLayout([[5, 5], [3, 5], [1, 5]], [[17, 5], [19, 5], [21, 5]]),
    ai: { difficulty: 'casual' }, par: { turns: 4, timeSec: 300 },
    tutorial: {
      steps: [
        { expect: 'roll', text: 'All your markers are home. Now bear them off past the near edge.' },
        { expect: 'bearOff', times: 3, text: 'A die matching a point’s distance carries its marker off. Double 6s!' },
        { expect: 'roll', text: 'First to bear everything off wins. Keep going or finish.' },
      ],
    },
  }),
  makeDef({
    id: 'lesson-cube', kind: 'learn', name: 'Lesson 6 — The Stakes Cube',
    blurb: 'Offer to raise the stakes; the rival may accept or concede.',
    seed: 106, scriptedDice: [[4, 2], [6, 1]],
    options: { cube: true },
    ai: { difficulty: 'casual' }, par: { turns: 6, timeSec: 300 },
    tutorial: {
      steps: [
        { expect: 'double', text: 'Before rolling, you may offer the brass cube to double the stakes. Offer it.' },
        { expect: 'roll', text: 'They accepted — the stakes are now 2, and only they can offer next. Roll on.' },
      ],
    },
  }),
];

// ---------------------------------------------------------------------------
// Journey — 40 authored stages in five chapters, mastery every 8th
// ---------------------------------------------------------------------------

const CHAPTERS = ['Departure', 'Open Road', 'Home Stretch', 'Brass Stakes', 'Grand Circuit'];

function stage(i, partial) {
  const chapter = Math.floor(i / 8);
  const mastery = i % 8 === 7;
  return makeDef({
    id: `journey-${String(i + 1).padStart(2, '0')}`,
    kind: 'journey',
    name: `${CHAPTERS[chapter]} ${(i % 8) + 1}${mastery ? ' — Mastery' : ''}`,
    chapter,
    mastery,
    theme: ['caravan', 'lagoon', 'ember', 'verdant', 'midnight'][chapter],
    ...partial,
  });
}

export const JOURNEY = [
  // Chapter 1 — Departure: full duel games against a gentle rival.
  stage(0, { name: 'Departure 1 — First Crossing', blurb: 'A plain race from the standard opening.', seed: 1001, ai: { difficulty: 'casual' }, par: { turns: 90, timeSec: 720 } }),
  stage(1, { name: 'Departure 2 — Head Start', blurb: 'Two markers already home. Press the advantage.', seed: 1002, layout: duelLayout([[5, 4], [3, 3]], [[0, 2]], { off0: 2 }), ai: { difficulty: 'casual' }, par: { turns: 80, timeSec: 700 } }),
  stage(2, { name: 'Departure 3 — Long Columns', blurb: 'Deep stacks travel slowly but safely.', seed: 1003, layout: duelLayout([[18, 5], [12, 5]], [[11, 5], [6, 5]]), ai: { difficulty: 'casual' }, par: { turns: 85, timeSec: 700 } }),
  stage(3, { name: 'Departure 4 — River Ford', blurb: 'Your caravan is split by the ford. Reunite it.', seed: 1040, layout: duelLayout([[23, 6], [10, 5]], [[0, 6], [13, 5]]), ai: { difficulty: 'casual' }, par: { turns: 90, timeSec: 720 } }),
  stage(4, { name: 'Departure 5 — Spread Thin', blurb: 'Many single markers: fast, but exposed.', seed: 1004, layout: duelLayout([[21, 1], [19, 1], [17, 1], [14, 1], [12, 1], [9, 1], [7, 1]], [[22, 1], [20, 1], [16, 1], [13, 1], [10, 1], [8, 1], [4, 1]]), ai: { difficulty: 'casual' }, par: { turns: 85, timeSec: 700 } }),
  stage(5, { name: 'Departure 6 — Split Camp', blurb: 'Half your caravan waits at the gate.', seed: 1005, layout: duelLayout([[23, 8], [8, 4]], [[0, 8], [15, 4]]), ai: { difficulty: 'casual' }, par: { turns: 95, timeSec: 760 } }),
  stage(6, { name: 'Departure 7 — Steady Rival', blurb: 'The rival stops making obvious mistakes.', seed: 1006, ai: { difficulty: 'steady' }, par: { turns: 85, timeSec: 700 } }),
  stage(7, { name: 'Departure 8 — Mastery: The Crossing', blurb: 'Prove the basics: win a full duel.', seed: 1007, ai: { difficulty: 'steady' }, goals: { win: true, maxTurns: 90 }, par: { turns: 80, timeSec: 660 } }),

  // Chapter 2 — Open Road: blots, hits, and the rail.
  stage(8, { name: 'Open Road 1 — Ambush', blurb: 'A rival blot waits in your path.', seed: 1008, layout: duelLayout([[12, 6], [9, 2]], [[4, 1], [10, 3]]), ai: { difficulty: 'casual' }, par: { turns: 80, timeSec: 660 } }),
  stage(9, { name: 'Open Road 2 — Exposed', blurb: 'Your own blots are everywhere. Cover or run.', seed: 1009, layout: duelLayout([[20, 1], [17, 1], [15, 1], [13, 1], [10, 1], [8, 2]], [[5, 2], [3, 2]]), ai: { difficulty: 'casual' }, par: { turns: 85, timeSec: 700 } }),
  stage(10, { name: 'Open Road 3 — Rail Duty', blurb: 'Start with two markers on the rail.', seed: 1010, layout: duelLayout([[13, 5], [8, 4]], [[10, 5], [6, 4]], { rail0: 2 }), ai: { difficulty: 'casual' }, par: { turns: 90, timeSec: 720 } }),
  stage(11, { name: 'Open Road 4 — Barricade', blurb: 'The rival built a wall across the road.', seed: 1011, layout: duelLayout([[22, 3], [19, 3], [16, 2]], [[11, 2], [9, 2], [7, 2], [5, 2]]), ai: { difficulty: 'steady' }, par: { turns: 95, timeSec: 760 } }),
  stage(12, { name: 'Open Road 5 — Counterstrike', blurb: 'Hit three rival markers before you win.', seed: 1012, layout: duelLayout([[14, 4], [11, 3], [7, 2]], [[5, 1], [9, 1], [13, 1], [17, 2]]), ai: { difficulty: 'steady' }, goals: { win: true, minHits: 3 }, par: { turns: 85, timeSec: 700 } }),
  stage(13, { name: 'Open Road 6 — Hostile Gates', blurb: 'Re-entry points are crowded tonight.', seed: 1013, layout: duelLayout([[6, 5], [4, 4]], [[18, 2], [20, 2], [22, 2], [12, 3]], { rail0: 1 }), ai: { difficulty: 'steady' }, par: { turns: 90, timeSec: 720 } }),
  stage(14, { name: 'Open Road 7 — Running Fight', blurb: 'Loose markers on both sides. Choose battles.', seed: 1014, layout: duelLayout([[21, 1], [18, 1], [15, 2], [10, 2], [6, 2]], [[2, 1], [5, 1], [8, 2], [13, 2], [17, 2]]), ai: { difficulty: 'steady' }, par: { turns: 85, timeSec: 700 } }),
  stage(15, { name: 'Open Road 8 — Mastery: The Gauntlet', blurb: 'Win with two markers starting on the rail.', seed: 1015, layout: duelLayout([[15, 5], [9, 4]], [[12, 5], [7, 4]], { rail0: 2 }), ai: { difficulty: 'steady' }, goals: { win: true, maxTurns: 95 }, par: { turns: 85, timeSec: 720 } }),

  // Chapter 3 — Home Stretch: endgames and pip races.
  stage(16, { name: 'Home Stretch 1 — Almost There', blurb: 'Everything is home except one straggler.', seed: 1016, layout: duelLayout([[8, 1], [5, 5], [4, 4], [2, 5]], [[6, 1], [3, 5], [1, 5]]), ai: { difficulty: 'casual' }, par: { turns: 60, timeSec: 540 } }),
  stage(17, { name: 'Home Stretch 2 — Pure Race', blurb: 'No contact left. Count your pips.', seed: 1017, layout: duelLayout([[5, 5], [4, 4], [2, 4]], [[3, 5], [2, 4], [0, 4]], { off0: 2, off1: 2 }), ai: { difficulty: 'steady' }, par: { turns: 40, timeSec: 420 } }),
  stage(18, { name: 'Home Stretch 3 — Odd Stacks', blurb: 'Tall stacks bear off awkwardly. Plan ahead.', seed: 1018, layout: duelLayout([[5, 9], [2, 6]], [[4, 9], [1, 6]]), ai: { difficulty: 'steady' }, par: { turns: 45, timeSec: 460 } }),
  stage(19, { name: 'Home Stretch 4 — Wastage', blurb: 'Small dice betray tall home points. Even them out.', seed: 1019, layout: duelLayout([[5, 6], [3, 6], [0, 3]], [[5, 3], [3, 3], [2, 3], [1, 3], [0, 3]]), ai: { difficulty: 'steady' }, par: { turns: 45, timeSec: 460 } }),
  stage(20, { name: 'Home Stretch 5 — Last Marker', blurb: 'Your rival is nearly done. One hit saves you.', seed: 1020, layout: duelLayout([[6, 2], [4, 4], [3, 4], [1, 4]], [[2, 1]], { off1: 14 }), ai: { difficulty: 'steady' }, par: { turns: 30, timeSec: 360 } }),
  stage(21, { name: 'Home Stretch 6 — Photo Race', blurb: 'A dead-even sprint. Waste nothing.', seed: 1021, layout: duelLayout([[5, 4], [3, 4], [1, 4]], [[4, 4], [2, 4], [0, 4]], { off0: 3, off1: 3 }), ai: { difficulty: 'steady' }, par: { turns: 32, timeSec: 380 } }),
  stage(22, { name: 'Home Stretch 7 — Sharp Sprint', blurb: 'A sharp rival races you home.', seed: 1022, layout: duelLayout([[7, 2], [5, 5], [3, 4], [1, 4]], [[6, 2], [4, 5], [2, 4], [0, 4]]), ai: { difficulty: 'sharp' }, par: { turns: 45, timeSec: 480 } }),
  stage(23, { name: 'Home Stretch 8 — Mastery: The Sprint', blurb: 'Win the endgame in under 40 turns.', seed: 1023, layout: duelLayout([[5, 5], [4, 5], [2, 5]], [[5, 5], [3, 5], [1, 5]]), ai: { difficulty: 'sharp' }, goals: { win: true, maxTurns: 40 }, par: { turns: 34, timeSec: 420 } }),

  // Chapter 4 — Brass Stakes: the cube.
  stage(24, { name: 'Brass Stakes 1 — First Offer', blurb: 'The cube is in play. Use it when ahead.', seed: 1024, options: { cube: true }, ai: { difficulty: 'steady' }, par: { turns: 80, timeSec: 700 } }),
  stage(25, { name: 'Brass Stakes 2 — Pressing', blurb: 'Win with the stakes at 2 or higher.', seed: 1025, options: { cube: true }, goals: { win: true, minPoints: 2 }, ai: { difficulty: 'steady' }, par: { turns: 80, timeSec: 700 } }),
  stage(26, { name: 'Brass Stakes 3 — Held Nerve', blurb: 'They will offer. Decide like a banker.', seed: 1026, options: { cube: true }, layout: duelLayout([[12, 4], [9, 4], [6, 3]], [[11, 4], [8, 4], [5, 3]]), ai: { difficulty: 'steady' }, par: { turns: 75, timeSec: 680 } }),
  stage(27, { name: 'Brass Stakes 4 — Sweep Threat', blurb: 'Far ahead? Hunt the full sweep for ×2.', seed: 1027, options: { cube: true }, layout: duelLayout([[5, 5], [3, 5], [1, 4]], [[22, 3], [20, 3]]), ai: { difficulty: 'steady' }, goals: { win: true, minPoints: 2 }, par: { turns: 55, timeSec: 560 } }),
  stage(28, { name: 'Brass Stakes 5 — Comeback', blurb: 'Behind on pips, cube in their hands.', seed: 1028, options: { cube: true }, layout: duelLayout([[18, 4], [13, 4], [9, 3], [6, 2]], [[4, 5], [2, 5]], { off1: 3 }), ai: { difficulty: 'steady' }, par: { turns: 85, timeSec: 720 } }),
  stage(29, { name: 'Brass Stakes 6 — Sharp Banker', blurb: 'A sharp rival loves the cube. Punish greed.', seed: 1029, options: { cube: true }, ai: { difficulty: 'sharp' }, par: { turns: 85, timeSec: 720 } }),
  stage(30, { name: 'Brass Stakes 7 — Redouble Road', blurb: 'Reach stakes of 4 and still win.', seed: 1030, options: { cube: true }, goals: { win: true, minPoints: 4 }, ai: { difficulty: 'sharp' }, par: { turns: 85, timeSec: 720 } }),
  stage(31, { name: 'Brass Stakes 8 — Mastery: High Brass', blurb: 'Win a cube duel against a sharp rival.', seed: 1031, options: { cube: true }, ai: { difficulty: 'sharp' }, goals: { win: true, maxTurns: 95 }, par: { turns: 80, timeSec: 700 } }),

  // Chapter 5 — Grand Circuit: the loop ruleset, 2–4 players.
  stage(32, { name: 'Grand Circuit 1 — The Loop', blurb: 'Same road, same direction. Chase and be chased.', seed: 1032, ruleset: 'circuit', players: 2, ai: { difficulty: 'casual' }, par: { turns: 90, timeSec: 720 } }),
  stage(33, { name: 'Grand Circuit 2 — Slipstream', blurb: 'Overtake without leaving easy targets.', seed: 1033, ruleset: 'circuit', players: 2, layout: circuitLayout(2, [[[3, 4]], [[9, 4]]]), ai: { difficulty: 'steady' }, par: { turns: 85, timeSec: 700 } }),
  stage(34, { name: 'Grand Circuit 3 — Three Caravans', blurb: 'Two rivals share the loop with you.', seed: 1034, ruleset: 'circuit', players: 3, ai: { difficulty: 'steady' }, par: { turns: 110, timeSec: 840 } }),
  stage(35, { name: 'Grand Circuit 4 — Crowded Gates', blurb: 'Four caravans. Every point matters.', seed: 1035, ruleset: 'circuit', players: 4, ai: { difficulty: 'casual' }, par: { turns: 130, timeSec: 960 } }),
  stage(36, { name: 'Grand Circuit 5 — Breakaway', blurb: 'You start ahead. Stay there.', seed: 1036, ruleset: 'circuit', players: 3, layout: circuitLayout(3, [[[4, 4], [10, 4]], [[0, 8]], [[16, 8]]]), ai: { difficulty: 'steady' }, par: { turns: 110, timeSec: 840 } }),
  stage(37, { name: 'Grand Circuit 6 — Pursuit', blurb: 'You start behind. Hunt the leaders.', seed: 1037, ruleset: 'circuit', players: 3, layout: circuitLayout(3, [[[0, 8]], [[12, 4], [6, 4]], [[20, 4], [14, 4]]]), ai: { difficulty: 'steady' }, par: { turns: 115, timeSec: 860 } }),
  stage(38, { name: 'Grand Circuit 7 — Sharp Caravan', blurb: 'Three sharp rivals on one loop.', seed: 1038, ruleset: 'circuit', players: 4, ai: { difficulty: 'sharp' }, par: { turns: 130, timeSec: 960 } }),
  stage(39, { name: 'Grand Circuit 8 — Mastery: The Grand Tour', blurb: 'Win the four-caravan grand circuit.', seed: 1039, ruleset: 'circuit', players: 4, ai: { difficulty: 'sharp' }, goals: { win: true, maxTurns: 150 }, par: { turns: 125, timeSec: 940 } }),
];

// ---------------------------------------------------------------------------
// Daily — one shared seed + ruleset per UTC day (immutable after publication)
// ---------------------------------------------------------------------------

export function dailyForDate(dateStr) {
  // dateStr: 'YYYY-MM-DD' (UTC)
  const seed = hashSeed(`bearing-board:daily:v${CONTENT_VERSION}:${dateStr}`);
  const rng = createRng(seed);
  const circuit = rng.next() < 0.3;
  const players = circuit ? (rng.next() < 0.5 ? 3 : 2) : 2;
  const difficulty = ['casual', 'steady', 'sharp'][Math.floor(rng.next() * 3)];
  const theme = ['caravan', 'lagoon', 'ember', 'verdant', 'midnight'][Math.floor(rng.next() * 5)];
  const gameSeed = (rng.next() * 0xffffffff) >>> 0;
  return makeDef({
    id: `daily-${dateStr}`,
    kind: 'daily',
    name: `Daily Crossing — ${dateStr}`,
    blurb: circuit
      ? `Today’s shared table: a ${players}-caravan circuit against a ${difficulty} rival.`
      : `Today’s shared table: a duel against a ${difficulty} rival.`,
    ruleset: circuit ? 'circuit' : 'duel',
    players,
    seed: gameSeed,
    options: { cube: !circuit && rng.next() < 0.5 },
    ai: { difficulty },
    theme,
    ranked: true,
    mechanics: { undo: false, hint: false },
    par: { turns: 85, timeSec: 720 },
  });
}

export function todayUTC(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Practice — selectable difficulty, restart, undo, unranked
// ---------------------------------------------------------------------------

export function practiceDef(difficulty = 'steady', ruleset = 'duel', seed = null, players = 2) {
  const s = seed ?? hashSeed(`practice:${Date.now()}:${Math.random()}`);
  return makeDef({
    id: `practice-${s.toString(36)}`,
    kind: 'practice',
    name: `Practice — ${RULESETS[ruleset].label} vs ${difficulty}`,
    blurb: 'Unranked. Undo and hints are allowed; restart any time.',
    ruleset,
    players: ruleset === 'circuit' ? players : 2,
    seed: s >>> 0,
    options: { cube: ruleset === 'duel' },
    ai: { difficulty },
    mechanics: { undo: true, hint: true },
    par: { turns: 85, timeSec: 720 },
  });
}

// ---------------------------------------------------------------------------
// Challenge — constrained goals
// ---------------------------------------------------------------------------

export const CHALLENGES = [
  makeDef({
    id: 'challenge-sprint', kind: 'challenge', name: 'Sprint Table',
    blurb: 'Win a full duel in 70 turns or fewer.', seed: 2001,
    options: { moveLimit: 70 }, goals: { win: true, maxTurns: 70 },
    ai: { difficulty: 'steady' }, theme: 'ember', par: { turns: 65, timeSec: 600 },
  }),
  makeDef({
    id: 'challenge-blitz', kind: 'challenge', name: 'Blitz Clock',
    blurb: 'Win in under four minutes of your own thinking time.', seed: 2002,
    goals: { win: true, maxTimeSec: 240 },
    ai: { difficulty: 'steady' }, theme: 'ember', par: { turns: 85, timeSec: 240 },
  }),
  makeDef({
    id: 'challenge-bare-rail', kind: 'challenge', name: 'Bare Rail',
    blurb: 'Three markers start on the rail. Recover and win.', seed: 2003,
    layout: duelLayout([[15, 5], [10, 4], [7, 3]], [[12, 5], [8, 5]], { rail0: 3 }),
    ai: { difficulty: 'steady' }, theme: 'midnight', par: { turns: 100, timeSec: 780 },
  }),
  makeDef({
    id: 'challenge-sharp-table', kind: 'challenge', name: 'The Sharp Table',
    blurb: 'Beat a sharp rival from the standard opening.', seed: 2004,
    ai: { difficulty: 'sharp' }, theme: 'midnight', par: { turns: 85, timeSec: 720 },
  }),
  makeDef({
    id: 'challenge-high-stakes', kind: 'challenge', name: 'High Brass',
    blurb: 'Win with the stakes cube at 4 or higher.', seed: 2005,
    options: { cube: true }, goals: { win: true, minPoints: 4 },
    ai: { difficulty: 'sharp' }, theme: 'verdant', par: { turns: 90, timeSec: 760 },
  }),
  makeDef({
    id: 'challenge-clean-hands', kind: 'challenge', name: 'Clean Hands',
    blurb: 'Win while being hit at most twice.', seed: 2006,
    goals: { win: true, maxHitsAgainst: 2 },
    ai: { difficulty: 'steady' }, theme: 'lagoon', par: { turns: 85, timeSec: 720 },
  }),
  makeDef({
    id: 'challenge-caravan', kind: 'challenge', name: 'Caravan Master',
    blurb: 'Win a four-caravan circuit.', seed: 2007,
    ruleset: 'circuit', players: 4,
    ai: { difficulty: 'sharp' }, theme: 'verdant', par: { turns: 135, timeSec: 980 },
  }),
  makeDef({
    id: 'challenge-photo', kind: 'challenge', name: 'Photo Finish',
    blurb: 'A knife-edge endgame: win in 14 turns.', seed: 2008,
    layout: duelLayout([[4, 4], [2, 4], [0, 4]], [[3, 4], [1, 4], [0, 2]], { off0: 3, off1: 5 }),
    options: { moveLimit: 28 }, goals: { win: true, maxTurns: 14 },
    ai: { difficulty: 'sharp' }, theme: 'lagoon', par: { turns: 14, timeSec: 300 },
  }),
];

// ---------------------------------------------------------------------------
// Themes — five visual themes (presentation only; never rules)
// ---------------------------------------------------------------------------

export const THEMES = [
  {
    key: 'caravan', label: 'Caravan Leather',
    board: 0xcaa06a, boardAlt: 0x7a4a2a, frame: 0x5a3f28, rail: 0x3a2a1c,
    felt: 0xb98d55, accent: 0xc9a25e,
    players: [0xf2e6cf, 0x2e2018, 0x8c3d2e, 0x2e5a4a],
    sky: 0x241a12, fog: 0x241a12,
  },
  {
    key: 'lagoon', label: 'Lagoon Voyage',
    board: 0x9ac7c0, boardAlt: 0x2f6b66, frame: 0x274b52, rail: 0x1b3338,
    felt: 0x7fb5ae, accent: 0xe0b25c,
    players: [0xf4efe2, 0x14343a, 0xc96f4a, 0x3a7ca5],
    sky: 0x10222a, fog: 0x10222a,
  },
  {
    key: 'ember', label: 'Ember Night',
    board: 0xd0a080, boardAlt: 0x8a3d2a, frame: 0x4a2420, rail: 0x2a1512,
    felt: 0xbf8a60, accent: 0xf0a03c,
    players: [0xf6e8d0, 0x241210, 0xd06a3a, 0x6a8a5a],
    sky: 0x1c100c, fog: 0x1c100c,
  },
  {
    key: 'verdant', label: 'Verdant Camp',
    board: 0xb8c88f, boardAlt: 0x4a6a3a, frame: 0x33482a, rail: 0x20301c,
    felt: 0x9ab57a, accent: 0xd8b25c,
    players: [0xf0ead2, 0x1e2a16, 0xa8543a, 0x4a6a8a],
    sky: 0x141f10, fog: 0x141f10,
  },
  {
    key: 'midnight', label: 'Midnight Brass',
    board: 0x8f95b8, boardAlt: 0x3a3f66, frame: 0x262a44, rail: 0x171a2c,
    felt: 0x6f76a0, accent: 0xd8b25c,
    players: [0xe8e6f0, 0x12142a, 0xc05a5a, 0x5aa08a],
    sky: 0x0e1020, fog: 0x0e1020,
  },
];

export function themeByKey(key) {
  return THEMES.find((t) => t.key === key) || THEMES[0];
}

// ---------------------------------------------------------------------------
// Achievements — static, stable keys, idempotent unlocks
// ---------------------------------------------------------------------------

export const ACHIEVEMENTS = [
  { key: 'first_win', label: 'First Crossing', desc: 'Win your first game.' },
  { key: 'first_sweep', label: 'Full Sweep', desc: 'Win by a gammon or better.' },
  { key: 'journey_half', label: 'Seasoned Traveler', desc: 'Complete 20 journey stages.' },
  { key: 'journey_full', label: 'Grand Itinerary', desc: 'Complete all 40 journey stages.' },
  { key: 'daily_streak_7', label: 'Weekly Ritual', desc: 'Finish the daily table on 7 different days.' },
  { key: 'hitter_50', label: 'Rail Warden', desc: 'Strike 50 rival markers across all games.' },
  { key: 'circuit_champion', label: 'Caravan Master', desc: 'Win a four-caravan circuit.' },
  { key: 'cube_closer', label: 'Brass Closer', desc: 'Win with the stakes at 4 or higher.' },
  { key: 'hundred_tables', label: 'Hundred Tables', desc: 'Finish 100 games, any mode, any pace.' },
];

// Mastery track: journey stars map to traveler titles.
export const MASTERY_TIERS = [
  { stars: 0, title: 'Packer' },
  { stars: 10, title: 'Wayfarer' },
  { stars: 30, title: 'Pathfinder' },
  { stars: 60, title: 'Guide' },
  { stars: 90, title: 'Master of Roads' },
  { stars: 120, title: 'Grand Bearer' },
];

// ---------------------------------------------------------------------------
// Offline validators — legality, reachable goals, bounded duration
// ---------------------------------------------------------------------------

export function validateContent(def) {
  const errors = [];
  for (const e of validateConfig(def)) errors.push(e);
  if (!def.name) errors.push('name required');
  if (!THEMES.some((t) => t.key === def.theme)) errors.push(`unknown theme "${def.theme}"`);
  if (def.kind === 'daily' && def.mechanics?.undo) errors.push('daily must not allow undo');
  if (def.goals?.maxTurns && !def.options?.moveLimit) {
    // Session-side goal; ensure it is at least plausible.
    if (def.goals.maxTurns < 8) errors.push('maxTurns goal implausibly low');
  }
  return { id: def.id, ok: errors.length === 0, errors };
}

// Simulation-based validation: prove a table terminates within a sane bound
// when played by the steady AI on both sides (no soft locks, bounded duration).
export function simulateContent(def, maxTurns = 700) {
  // Imported lazily to keep content.js free of AI cost at load time.
  return import('./rules.js').then(async (Rules) => {
    const AI = await import('./ai.js');
    let state = Rules.createGame(def);
    let guard = maxTurns * 8;
    while (state.winner < 0 && guard-- > 0 && state.turnNum <= maxTurns) {
      const seat = state.phase === 'cube' ? (state.cube.pending.by + 1) % state.cfg.players : state.active;
      const cmd = AI.aiCommand(state, seat, 'steady');
      if (!cmd) return { ok: false, errors: [`AI could not act at turn ${state.turnNum}`] };
      const r = Rules.applyCommand(state, cmd);
      if (!r.ok) return { ok: false, errors: [`illegal AI command: ${r.events[0]?.reason}`] };
      state = r.state;
    }
    if (state.winner < 0) return { ok: false, errors: [`did not terminate within ${maxTurns} turns`] };
    return { ok: true, errors: [], turns: state.turnNum, winner: state.winner };
  });
}

export function validateAll() {
  const reports = [];
  const push = (def) => reports.push(validateContent(def));
  LESSONS.forEach(push);
  JOURNEY.forEach(push);
  CHALLENGES.forEach(push);
  ['2026-01-01', '2026-08-24', '2026-12-31'].forEach((d) => push(dailyForDate(d)));
  return reports;
}
