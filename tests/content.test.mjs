// Bearing Board — content validation: every authored def passes the offline
// validators, sample content terminates under AI play, daily generation is
// deterministic, achievements/mastery metadata are well-formed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Content from '../js/content.js';
import * as Rules from '../js/rules.js';

test('all authored content passes offline validators', () => {
  const reports = Content.validateAll();
  const bad = reports.filter((r) => !r.ok);
  assert.equal(bad.length, 0, JSON.stringify(bad, null, 2));
});

test('launch scope: 6 lessons, 40 journey stages, 8 challenges, 5 themes', () => {
  assert.equal(Content.LESSONS.length, 6);
  assert.equal(Content.JOURNEY.length, 40);
  assert.equal(Content.CHALLENGES.length, 8);
  assert.equal(Content.THEMES.length, 5);
  // Mastery every 8th journey stage.
  Content.JOURNEY.forEach((d, i) => assert.equal(!!d.mastery, i % 8 === 7, d.id));
  // Unique ids everywhere.
  const ids = [...Content.LESSONS, ...Content.JOURNEY, ...Content.CHALLENGES].map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('sample content terminates under steady AI (no soft locks)', async () => {
  const samples = [
    Content.JOURNEY[0], Content.JOURNEY[7], Content.JOURNEY[23],
    Content.JOURNEY[31], Content.JOURNEY[39],
    Content.CHALLENGES[0], Content.CHALLENGES[3],
    Content.dailyForDate('2026-08-30'),
  ];
  for (const def of samples) {
    const r = await Content.simulateContent(def, 500);
    assert.ok(r.ok, `${def.id}: ${r.errors?.join('; ')}`);
  }
});

test('daily generation is deterministic and immutable per date', () => {
  const a = Content.dailyForDate('2026-08-30');
  const b = Content.dailyForDate('2026-08-30');
  const c = Content.dailyForDate('2026-08-31');
  assert.equal(a.seed, b.seed);
  assert.equal(a.ruleset, b.ruleset);
  assert.equal(a.id, b.id);
  assert.notEqual(a.seed, c.seed);
  assert.equal(a.ranked, true);
  assert.equal(a.mechanics.undo, false);
  assert.match(Content.todayUTC(new Date(Date.UTC(2026, 7, 30))), /^\d{4}-\d{2}-\d{2}$/);
});

test('achievements: stable lowercase keys, required set present', () => {
  const keys = Content.ACHIEVEMENTS.map((a) => a.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const k of keys) assert.match(k, /^[a-z0-9_]+$/);
  // Spec set: first completion, mechanic mastery, streak, hard milestone, long-term.
  for (const required of ['first_win', 'hitter_50', 'daily_streak_7', 'journey_full', 'hundred_tables']) {
    assert.ok(keys.includes(required), `missing achievement ${required}`);
  }
});

test('practice defs honor ruleset constraints', () => {
  const d = Content.practiceDef('steady', 'duel', 1234);
  assert.equal(d.ruleset, 'duel');
  assert.equal(d.players, 2);
  assert.equal(d.options.cube, true);
  assert.equal(d.seed, 1234);
  const c = Content.practiceDef('sharp', 'circuit', 99, 4);
  assert.equal(c.players, 4);
  assert.equal(c.options.cube, false);
  assert.equal(Content.validateContent(c).ok, true);
});

test('journey seeds are stable across imports (authored, not random)', () => {
  const ids = Content.JOURNEY.map((d) => `${d.id}:${d.seed}`);
  assert.equal(new Set(ids).size, 40);
  for (const d of Content.JOURNEY) assert.ok(Number.isInteger(d.seed) && d.seed >= 1000, d.id);
});

test('every scripted dice lesson stays within the rules engine', () => {
  for (const lesson of Content.LESSONS) {
    const s = Rules.createGame(lesson);
    assert.ok(Rules.hashState(s).length > 0, lesson.id);
    assert.equal(Rules.markersOf(s, 0), Rules.RULESETS[lesson.ruleset].markers);
  }
});
