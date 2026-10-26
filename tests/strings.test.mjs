// Bearing Board — every client string in the nine StarHermit locales. Run: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { STRINGS, LOCALES } from '../js/strings.js';
import * as Content from '../js/content.js';

test('every player-facing string and content name exists in all nine locales', () => {
  assert.deepEqual(LOCALES, ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT']);
  const keys = Object.keys(STRINGS['en-US']);
  for (const loc of LOCALES) {
    const T = STRINGS[loc];
    for (const k of keys) assert.ok(T[k], `${loc}.${k}`);
    for (const d of Content.JOURNEY) assert.ok(T[`j.${d.id}`] && T[`jb.${d.id}`], `${loc} ${d.id}`);
    for (const d of Content.LESSONS) {
      assert.ok(T[`l.${d.id}`] && T[`lb.${d.id}`], `${loc} ${d.id}`);
      d.tutorial.steps.forEach((_, i) => assert.ok(T[`ls.${d.id}.${i}`], `${loc} ${d.id}.${i}`));
    }
    for (const d of Content.CHALLENGES) assert.ok(T[`c.${d.id}`] && T[`cb.${d.id}`], `${loc} ${d.id}`);
    for (const a of Content.ACHIEVEMENTS) assert.ok(T[`ach.${a.key}`] && T[`ach.${a.key}.d`], `${loc} ${a.key}`);
    for (const th of Content.THEMES) assert.ok(T[`theme.${th.key}`], `${loc} ${th.key}`);
    Content.MASTERY_TIERS.forEach((_, i) => assert.ok(T[`tier.${i}`], `${loc} tier ${i}`));
  }
});

test('every literal key the engine client asks for exists', () => {
  const src = readdirSync(new URL('../native/', import.meta.url)).filter((f) => f.endsWith('.ts'))
    .map((f) => readFileSync(new URL(`../native/${f}`, import.meta.url), 'utf8')).join('\n');
  const used = new Set([...src.matchAll(/\bt\("([a-zA-Z0-9_.]+)"/g)].map((m) => m[1]));
  assert.ok(used.size > 100, `found ${used.size} keys`);
  for (const k of used) for (const loc of LOCALES) assert.ok(STRINGS[loc][k], `${loc}.${k}`);
});
