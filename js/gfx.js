// Graphics quality model: presets, per-category overrides, GPU detection and a cost summary.
// Pure (no three.js, no DOM) so the settings panel, the renderer and the unit tests agree on
// what a setting means.

export const PRESETS = ['low', 'balanced', 'high', 'ultra'];

// Category → allowed tiers, cheapest first.
export const CATEGORIES = {
  shadows: ['off', 'low', 'medium', 'high'],
  ao: ['off', 'on', 'high'],
  bloom: ['off', 'on'],
  grade: ['off', 'on'],
  antialias: ['off', 'fxaa', 'smaa', 'msaa'],
  reflections: ['off', 'on'],      // room-environment image-based lighting on brass and lacquer
  detail: ['plain', 'detailed'],   // grain textures, stitching, bevelled lacquered markers
  particles: ['low', 'high'],      // strike / bear-off / victory bursts
  background: ['static', 'animated'], // lantern flicker and drifting dust motes
};

// Each preset is a row of tiers, a device-pixel-ratio cap and a render scale multiplier.
const TABLE = {
  low: { dprCap: 1, scale: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'msaa', reflections: 'off', detail: 'plain', particles: 'low', background: 'static' },
  balanced: { dprCap: 1.5, scale: 1, shadows: 'low', ao: 'off', bloom: 'off', grade: 'on', antialias: 'fxaa', reflections: 'on', detail: 'detailed', particles: 'high', background: 'animated' },
  high: { dprCap: 2, scale: 1, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', reflections: 'on', detail: 'detailed', particles: 'high', background: 'animated' },
  ultra: { dprCap: 2, scale: 1.25, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', detail: 'detailed', particles: 'high', background: 'animated' },
};

export const SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };

export const DEFAULT_GRAPHICS = { preset: 'auto', render_scale: 1, adaptive: true, show_fps: false };

// StarHermit hardware level (0–20, gpu-level.js) at which Auto starts choosing each preset.
export const LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };

// Per-preset asset and effect budgets, each tuned to hold 60 FPS on the weakest GPU Auto gives the
// preset (Low: level 0 phones / Intel UHD; Balanced: level 4 Iris Xe; High: level 10 GTX 1070;
// Ultra: level 17 RTX 4080). Gameplay is identical on every preset.
//   material  — 'lambert' (Lambert board and markers, Phong brass), 'standard' (PBR), 'physical'
//               (clearcoat lacquer on markers and frame)
//   segments  — marker radial segments (plain cylinder on Low, lathed bevelled marker above)
//   texture   — leather / wood grain texture size in px with Scene detail on (wood is size × size/4)
//   particles — spark pool size; burst counts scale by the hardware level within the preset
//   motes     — dust motes in the lantern light (Ambient motion on)
//   bloomRes  — bloom resolution as a fraction of the canvas
//   bump      — leather bump map on the field and points (Scene detail on)
//   softShadows — PCF soft shadow filtering (else plain PCF)
//   mergedRing — markers are one mesh with the brass cap ring baked in as vertex colour (one draw
//               per marker instead of two); High/Ultra keep a separate metallic ring mesh
export const BUDGETS = {
  low: { material: 'lambert', segments: 16, texture: 256, particles: 120, motes: 0, bloomRes: 0.5, bump: false, softShadows: false, mergedRing: true },
  balanced: { material: 'standard', segments: 24, texture: 256, particles: 240, motes: 24, bloomRes: 0.5, bump: false, softShadows: false, mergedRing: true },
  high: { material: 'physical', segments: 32, texture: 512, particles: 240, motes: 40, bloomRes: 0.75, bump: true, softShadows: true, mergedRing: false },
  ultra: { material: 'physical', segments: 48, texture: 1024, particles: 480, motes: 80, bloomRes: 1, bump: true, softShadows: true, mergedRing: false },
};

const gpuApi = () => globalThis.StarHermitGpu;

/** Hardware level 0–20 for a renderer string (+ optional detectSystem() fields such as mobile). */
export function detectLevel(gpu, system = {}) {
  const G = gpuApi();
  return G ? G.detectLevel({ webgl: true, webgl2: true, ...system, gpu: String(gpu || '') }) : 0;
}

/** Auto preset for a hardware level: Low 0, Balanced 4, High 10, Ultra 17. */
export function presetForLevel(level) {
  const G = gpuApi();
  return G ? G.presetForLevel(level, LEVELS) : PRESETS.filter((p) => LEVELS[p] <= level).pop() || 'low';
}

/** Best preset for this GPU (hardware level → preset). */
export function detectPreset(gpu, system = {}) {
  return presetForLevel(detectLevel(gpu, system));
}

/** The preset's budget; `burst` multiplies spark counts by the level within the preset (≤ 2×). */
export function budget(preset, level) {
  const b = BUDGETS[preset] || BUDGETS.balanced;
  const G = gpuApi(), floor = LEVELS[preset] ?? 0;
  const lv = Number.isFinite(level) ? level : floor;
  const k = G ? G.scaleBudget(1, lv, floor) : 1;
  return { ...b, burst: Math.round(Math.min(2, k) * 100) / 100, motes: Math.min(160, Math.round(b.motes * Math.min(2, k))) };
}

/**
 * Resolve saved settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
 */
export function resolve(saved, detected, level) {
  const s = saved || {};
  const auto = !PRESETS.includes(s.preset);
  const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
  const row = TABLE[preset];
  const userScale = clamp(Number(s.render_scale) || 1, 0.5, 2);
  const out = { preset, auto, dprCap: row.dprCap, userScale, scale: row.scale * userScale };
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
  }
  out.budget = budget(preset, level);
  out.adaptive = s.adaptive !== false;
  out.showFps = !!s.show_fps;
  // Post-processing runs only when something needs it; otherwise the canvas MSAA is used.
  out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' || out.antialias === 'fxaa' || out.antialias === 'smaa';
  return out;
}

/** The preset's own tier for a category (for "From preset (…)" labels). */
export function presetTier(preset, cat) {
  return TABLE[preset]?.[cat];
}

/** Choosing a preset keeps scale/adaptive/fps but clears every per-category override. */
export function choosePreset(saved, preset) {
  const out = { ...DEFAULT_GRAPHICS, ...(saved || {}) };
  for (const cat of Object.keys(CATEGORIES)) delete out[cat];
  out.preset = preset === 'auto' || PRESETS.includes(preset) ? preset : 'auto';
  return out;
}

const EN_WORDS = {
  noShadows: 'no shadows', shadows: '{n}² shadows', ao: 'ambient occlusion', aoHigh: 'full ambient occlusion',
  bloom: 'bloom', noAA: 'no anti-aliasing', reflections: 'reflections', animated: 'ambient motion',
};

/** One-line cost summary. `words` lets the UI pass localized fragments. */
export function describe(r, pixels, words = EN_WORDS) {
  const w = { ...EN_WORDS, ...words };
  const parts = [
    r.shadows === 'off' ? w.noShadows : w.shadows.replace('{n}', SHADOW_MAP[r.shadows]),
    r.ao === 'off' ? null : r.ao === 'high' ? w.aoHigh : w.ao,
    r.bloom === 'on' ? w.bloom : null,
    r.reflections === 'on' ? w.reflections : null,
    r.background === 'animated' ? w.animated : null,
    r.antialias === 'off' ? w.noAA : r.antialias.toUpperCase(),
    pixels ? `${pixels[0]}×${pixels[1]} px` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}
