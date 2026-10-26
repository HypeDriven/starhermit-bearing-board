// The look per graphics level: the browser build's four presets and their
// 60 FPS budgets (js/gfx.js before the port: TABLE and BUDGETS) keyed by the
// runtime's quality tier (frame().quality), with the spark and mote budgets
// scaled within the tier by the level (frame().levelIndex) as the browser
// build scaled them by its hardware level (at most twice). The runtime owns
// what the old Graphics panel did besides: Auto and the level choice,
// render scale and the pixel-ratio cap, adaptive resolution, the frame-rate
// limit and readout, and the shadow map size it holds to the level.
import type { QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Look {
  preset: QualityTier;
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
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
  /** Leather / wood grain texture size in px (detail on). */
  texture: number;
  /** Spark pool size, and the burst multiplier by level within the tier. */
  particles: number;
  burst: number;
  motes: number;
  bloomRes: number;
  /** Leather relief (the browser's bump map, here a normal map). */
  bump: boolean;
  softShadows: boolean;
  /** Markers are one mesh with the brass cap ring as vertex colour. */
  mergedRing: boolean;
}

const TABLE: Record<QualityTier, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "msaa", reflections: false, detailed: false, particles: "low", animated: false },
  balanced: { shadows: 1024, ao: "off", bloom: false, grade: true, antialias: "fxaa", reflections: true, detailed: true, particles: "high", animated: true },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, detailed: true, particles: "high", animated: true },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, detailed: true, particles: "high", animated: true },
};
const BUDGETS: Record<QualityTier, Omit<Budget, "burst">> = {
  low: { material: "lambert", segments: 16, texture: 256, particles: 120, motes: 0, bloomRes: 0.5, bump: false, softShadows: false, mergedRing: true },
  balanced: { material: "standard", segments: 24, texture: 256, particles: 240, motes: 24, bloomRes: 0.5, bump: false, softShadows: false, mergedRing: true },
  high: { material: "physical", segments: 32, texture: 512, particles: 240, motes: 40, bloomRes: 0.75, bump: true, softShadows: true, mergedRing: false },
  ultra: { material: "physical", segments: 48, texture: 1024, particles: 480, motes: 80, bloomRes: 1, bump: true, softShadows: true, mergedRing: false },
};
export const PARTICLE_MAX = 480;
export const MOTE_MAX = 160;
/** The first level index of each tier (quantum, molecular, terrestrial, galactic). */
const TIER_FLOOR: Record<QualityTier, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };

/** The look for a quality tier at a level index (0 quantum … 9 infinite). */
export function lookFor(preset: QualityTier, levelIndex: number): Look {
  // Levels are about 1.64× apart in GPU throughput.
  const k = Math.min(2, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  const b = BUDGETS[preset];
  return {
    preset, ...TABLE[preset],
    budget: { ...b, burst: Math.round(k * 100) / 100, motes: Math.min(MOTE_MAX, Math.round(b.motes * k)) },
  };
}
