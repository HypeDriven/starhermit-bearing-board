// The look per graphics level. The engine-owned effects (shadows and their
// map size, ambient occlusion, bloom, the grade, anti-aliasing) are the
// level's own (levelSettings(): the same table every StarHermit game reads).
// The game's art (materials, segments, textures, reflections, the lantern,
// motion) is the browser build's four presets (js/gfx.js before the port)
// keyed by the level's quality tier, with the spark and mote budgets scaled
// within the tier by the level's particle budget against the tier's anchor
// level (quantum, molecular, terrestrial, galactic), at most twice. The
// runtime owns what the old Graphics panel did besides: Auto and the level
// choice, render scale and the pixel-ratio cap, adaptive resolution and the
// frame-rate limit and readout.
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Look {
  preset: QualityTier;
  /** The level's shadow map size, 0 when the level draws no shadows. */
  shadows: number;
  /** The level's ambient occlusion (null: off). */
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution (null: off). */
  bloom: number | null;
  grade: boolean;
  antialias: AntialiasMode;
  reflections: boolean;
  /** Grain textures, stitching, hinges, bevelled lacquered markers, the lantern. */
  detailed: boolean;
  /** "low" halves the burst counts; "high" sparks are additive (they bloom). */
  particles: "low" | "high";
  /** Lantern flicker and drifting dust motes. */
  animated: boolean;
  budget: Budget;
}
export interface Budget {
  /** Lambert board and markers (Low), standard PBR (Balanced), clearcoat lacquer (High, Ultra). */
  material: "lambert" | "standard" | "physical";
  /** Marker radial segments (a plain cylinder on Low, a lathed bevel above). */
  segments: number;
  /** Leather / wood grain texture size in px (detail on), within the level's largest texture. */
  texture: number;
  /** Spark pool size, and the burst multiplier by level within the tier. */
  particles: number;
  burst: number;
  motes: number;
  /** Leather relief (the browser's bump map, here a normal map). */
  bump: boolean;
  softShadows: boolean;
  /** Markers are one mesh with the brass cap ring as vertex colour. */
  mergedRing: boolean;
}

type Art = Pick<Look, "reflections" | "detailed" | "particles" | "animated">;
const ART: Record<QualityTier, Art> = {
  low: { reflections: false, detailed: false, particles: "low", animated: false },
  balanced: { reflections: true, detailed: true, particles: "high", animated: true },
  high: { reflections: true, detailed: true, particles: "high", animated: true },
  ultra: { reflections: true, detailed: true, particles: "high", animated: true },
};
const BUDGETS: Record<QualityTier, Omit<Budget, "burst">> = {
  low: { material: "lambert", segments: 16, texture: 256, particles: 120, motes: 0, bump: false, softShadows: false, mergedRing: true },
  balanced: { material: "standard", segments: 24, texture: 256, particles: 240, motes: 24, bump: false, softShadows: false, mergedRing: true },
  high: { material: "physical", segments: 32, texture: 512, particles: 240, motes: 40, bump: true, softShadows: true, mergedRing: false },
  ultra: { material: "physical", segments: 48, texture: 1024, particles: 480, motes: 80, bump: true, softShadows: true, mergedRing: false },
};
export const PARTICLE_MAX = 480;
export const MOTE_MAX = 160;
/** The level whose settings are each tier's preset. */
const ANCHOR: Record<QualityTier, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };

/** The look for a graphics level (the frame's by default). */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const k = Math.min(2, s.particles / levelSettings(ANCHOR[preset]).particles);
  const b = BUDGETS[preset];
  return {
    preset, ...ART[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: {
      ...b, texture: Math.min(b.texture, s.maxTextureSize),
      burst: Math.round(k * 100) / 100, motes: Math.min(MOTE_MAX, Math.round(b.motes * k)),
    },
  };
}
