// Bearing Board — the progress document: the cloud-save conflict merge, the
// browser build's cloud save (foreign save migration) and the settings
// migration. Run: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROGRESS, checksum, fromBrowserSave, mergeProgress, normalizeProgress } from '../js/progress.js';
import { DEFAULT_SETTINGS, cleanSetting, migrateLegacySetting } from '../js/settings.js';

test('mergeProgress keeps the better record from each device', () => {
  const m = mergeProgress(
    { journey: { 'journey-01': { stars: 1, bestTurns: 50 }, 'journey-02': { stars: 2, bestTurns: 70 } }, lessons: { a: { done: true } },
      daily: { days: ['2026-10-01'], lastDay: '2026-10-01' }, achievements: { first_win: { at: '2026-10-02T00:00:00Z' } }, stats: { games: 9, wins: 1 } },
    { journey: { 'journey-01': { stars: 3, bestTurns: 60, goalsMet: true } }, challenges: { c: { done: true, best: 40 } },
      daily: { days: ['2026-10-03'], lastDay: '2026-10-03' }, achievements: { first_win: { at: '2026-10-01T00:00:00Z' } }, stats: { games: 4, wins: 3 } });
  assert.deepEqual(m.journey['journey-01'], { stars: 3, bestTurns: 50, goalsMet: true });
  assert.equal(m.journey['journey-02'].stars, 2);
  assert.equal(m.lessons.a.done, true);
  assert.deepEqual(m.challenges.c, { done: true, best: 40 });
  assert.deepEqual(m.daily, { days: ['2026-10-01', '2026-10-03'], lastDay: '2026-10-03' });
  assert.equal(m.achievements.first_win.at, '2026-10-01T00:00:00Z');
  assert.deepEqual(m.stats, { games: 9, wins: 3, hits: 0, sweeps: 0 });
});

test('the browser build\'s cloud save (save.json { data, check }) migrates', () => {
  const data = { ...DEFAULT_PROGRESS, journey: { 'journey-03': { stars: 2, bestTurns: 61, goalsMet: false } }, stats: { games: 12, wins: 5, hits: 30, sweeps: 1 } };
  const text = JSON.stringify({ data, check: checksum(data) });
  const p = fromBrowserSave(text);
  assert.equal(p.journey['journey-03'].stars, 2);
  assert.equal(p.stats.games, 12);
  // Merged into what this device already has.
  const merged = mergeProgress(p, { lessons: { 'lesson-roll': { done: true } }, stats: { games: 3 } });
  assert.equal(merged.lessons['lesson-roll'].done, true);
  assert.equal(merged.stats.games, 12);
  // A bad checksum, other JSON or no text is not a save.
  assert.equal(fromBrowserSave(JSON.stringify({ data, check: '00000000' })), null);
  assert.equal(fromBrowserSave('not json'), null);
  assert.equal(fromBrowserSave(null), null);
});

test('normalizeProgress fills defaults and drops wrong shapes', () => {
  const p = normalizeProgress({ journey: [], daily: { days: ['2026-01-01', 3], lastDay: 7 }, stats: { games: '4', wins: -2 } });
  assert.deepEqual(p.journey, {});
  assert.deepEqual(p.daily, { days: ['2026-01-01'], lastDay: null });
  assert.deepEqual(p.stats, { games: 4, wins: 0, hits: 0, sweeps: 0 });
  assert.equal(normalizeProgress('x'), null);
});

test('browser-build settings keys migrate where the game keeps the option', () => {
  assert.deepEqual(migrateLegacySetting('theme', 'ember'), { key: 'theme', value: 'ember' });
  assert.deepEqual(migrateLegacySetting('leftHanded', true), { key: 'leftHanded', value: true });
  assert.deepEqual(migrateLegacySetting('timingAssist', 1.5), { key: 'timingAssist', value: 1.5 });
  assert.deepEqual(migrateLegacySetting('profile', { name: '  Rollo ' }), { key: 'profileName', value: 'Rollo' });
  assert.equal(migrateLegacySetting('profile', { name: 'Guest Traveler' }), null);
  for (const gone of ['audioEnabled', 'volume', 'graphics', 'reducedMotion', 'highContrast', 'bigText', 'ui.language'])
    assert.equal(migrateLegacySetting(gone, true), null, gone);
  assert.equal(migrateLegacySetting('theme', 'neon'), null);
  assert.equal(cleanSetting('haptics', 'yes'), undefined);
  assert.deepEqual(Object.keys(DEFAULT_SETTINGS), ['theme', 'leftHanded', 'haptics', 'toggleSelect', 'timingAssist', 'profileName']);
});
