import test from 'node:test';
import assert from 'node:assert/strict';
import * as Gfx from '../js/gfx.js';
import { GFX_STRINGS, LOCALES, pickLocale } from '../js/gfx-strings.js';

test('detectPreset maps GPU strings to presets', () => {
  assert.equal(Gfx.detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
  assert.equal(Gfx.detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
  assert.equal(Gfx.detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)'), 'high');
  assert.equal(Gfx.detectPreset('Apple M2'), 'high');
  assert.equal(Gfx.detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)'), 'balanced');
  assert.equal(Gfx.detectPreset('Mali-G78'), 'balanced');
  assert.equal(Gfx.detectPreset(''), 'balanced');
  // Touch / small-screen devices cap Auto at balanced, but never raise it.
  assert.equal(Gfx.detectPreset('Apple M2', { mobile: true }), 'balanced');
  assert.equal(Gfx.detectPreset('SwiftShader', { mobile: true }), 'low');
});

test('resolve: auto uses the detected preset, explicit presets win', () => {
  const auto = Gfx.resolve({}, 'high');
  assert.equal(auto.preset, 'high');
  assert.equal(auto.auto, true);
  assert.equal(auto.shadows, Gfx.presetTier('high', 'shadows'));
  const low = Gfx.resolve({ preset: 'low' }, 'high');
  assert.equal(low.preset, 'low');
  assert.equal(low.auto, false);
  assert.equal(low.post, false, 'Low renders without a post chain');
  assert.equal(Gfx.resolve({ preset: 'bogus' }, undefined).preset, 'balanced');
});

test('resolve: per-category overrides and invalid tiers', () => {
  const r = Gfx.resolve({ preset: 'low', bloom: 'on', shadows: 'nope' }, 'low');
  assert.equal(r.bloom, 'on');
  assert.equal(r.shadows, 'off', 'invalid override falls back to the preset tier');
  assert.equal(r.post, true, 'bloom override turns the post chain on');
  for (const [cat, tiers] of Object.entries(Gfx.CATEGORIES)) {
    for (const p of Gfx.PRESETS) assert.ok(tiers.includes(Gfx.presetTier(p, cat)), `${p}.${cat}`);
  }
});

test('resolve: render scale clamps to 50–200% and multiplies the preset scale', () => {
  assert.equal(Gfx.resolve({ preset: 'high', render_scale: 5 }).scale, 2);
  assert.equal(Gfx.resolve({ preset: 'high', render_scale: 0.1 }).scale, 0.5);
  assert.equal(Gfx.resolve({ preset: 'ultra', render_scale: 1 }).scale, 1.25);
  assert.equal(Gfx.resolve({ preset: 'high' }).adaptive, true);
  assert.equal(Gfx.resolve({ preset: 'high', adaptive: false }).adaptive, false);
  assert.equal(Gfx.resolve({ preset: 'high' }).showFps, false);
});

test('choosePreset clears overrides but keeps scale, adaptive and fps', () => {
  const saved = { preset: 'high', bloom: 'off', ao: 'high', render_scale: 1.5, adaptive: false, show_fps: true };
  const next = Gfx.choosePreset(saved, 'low');
  assert.deepEqual(next, { preset: 'low', render_scale: 1.5, adaptive: false, show_fps: true });
  assert.equal(Gfx.resolve(next).bloom, 'off');
  assert.equal(Gfx.choosePreset(saved, 'auto').preset, 'auto');
});

test('describe summarises cost and pixels', () => {
  const text = Gfx.describe(Gfx.resolve({ preset: 'high' }), [1280, 800]);
  assert.match(text, /2048² shadows/);
  assert.match(text, /SMAA/);
  assert.match(text, /1280×800 px$/);
  assert.match(Gfx.describe(Gfx.resolve({ preset: 'low' })), /no shadows/);
});

test('graphics strings exist in every required locale', () => {
  assert.deepEqual(LOCALES, ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT']);
  const en = GFX_STRINGS['en-US'];
  for (const loc of LOCALES) {
    const L = GFX_STRINGS[loc];
    for (const k of Object.keys(en)) assert.ok(L[k], `${loc}.${k}`);
    for (const p of Gfx.PRESETS) assert.ok(L.preset[p], `${loc}.preset.${p}`);
    for (const [cat, tiers] of Object.entries(Gfx.CATEGORIES)) {
      assert.ok(L.cat[cat], `${loc}.cat.${cat}`);
      for (const t of tiers) assert.ok(L.tier[t], `${loc}.tier.${t}`);
    }
    for (const k of Object.keys(en.words)) assert.ok(L.words[k], `${loc}.words.${k}`);
  }
  assert.equal(pickLocale(['de-AT']), 'de-DE');
  assert.equal(pickLocale(['es-MX']), 'es-419');
  assert.equal(pickLocale(['fr-CA']), 'fr-CA');
  assert.equal(pickLocale(['en-GB']), 'en-GB');
  assert.equal(pickLocale(['ja-JP']), 'en-US');
});
