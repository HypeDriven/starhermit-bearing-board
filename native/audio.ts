// Sound, ported from the browser build's js/audio.js onto the engine's mixer:
// the authored one-shots (sfx/<name>.opus, sfx/manifest.txt) per logical
// event, the travelling-wind ambience bed and the seeded slow music pad. The
// runtime's Options › Audio owns the volumes, mute and voice limit (the
// browser build's Music / Effects / Ambience / Voice sliders and its
// game-options.js sound panel): event cues play on "effects", the
// interface clicks (ack, tick, select) on "interface", the pad and the bed on
// "music", each at the level the browser build's default bus volume gave it.
//
// The bed and the pad chords are rendered once into clips (createClip) with
// the same noise, oscillators, filter and envelopes rather than run as a
// live synthesis graph: the engine's browser runtime drops clip loads while
// a graph changes (see the arrow-exodus port). For the same reason the
// browser build's synthesized stand-ins for clips still loading are not
// ported: clips load once the mixer runs (natively at once, in a browser
// after the first press) and a cue before that is silent; every cue has a
// visual or announced twin.
import { context, createClip, loadClip, play as playClip, type AudioClip, type Bus, type Sound } from "starhermit:audio";
import { createRng, hashSeed } from "../js/rules.js";

const SAMPLES: Record<string, string> = {
  ack: "ui-ack", roll: "dice-roll", move: "checker-move", hit: "checker-hit", bearOff: "bear-off",
  enter: "rail-enter", double: "stakes-offer", accept: "stakes-accept", decline: "stakes-decline",
  invalid: "invalid-move", noMoves: "no-moves", turn: "turn-change", win: "game-win", lose: "game-lose",
  unlock: "unlock-chime", tick: "ui-tick", doubles: "dice-doubles", select: "marker-select",
  undo: "undo-slide", tableOpen: "table-open", stars: "journey-stars",
};
const INTERFACE = new Set(["ack", "tick", "select"]);
// The browser build's default bus volumes: music 0.45, effects 0.8, ambience 0.35, voice 0.7.
const EFFECTS = 0.8, MUSIC = 0.45, AMBIENCE = 0.35, VOICE = 0.7;
const VOICE_CUES = new Set(["win", "lose", "stars", "unlock"]);

const clips = new Map<string, AudioClip>();
let wantClips = false;
function load(file: string): void {
  loadClip(`sfx/${file}.opus`).then((c) => { clips.set(file, c); }, (e: unknown) => console.warn(`sfx ${file}: ${String(e)}`));
}
/** Loads every clip once the mixer runs. */
export function loadSfx(): void { wantClips = true; poll(); }

/** Plays a logical event's cue (Audio.playEvent in the browser build). */
export function playEvent(name: string): void {
  const file = SAMPLES[name];
  const clip = file ? clips.get(file) : undefined;
  if (!clip) return;
  const bus: Bus = INTERFACE.has(name) ? "interface" : "effects";
  try { playClip(clip, { bus, gain: VOICE_CUES.has(name) ? VOICE : EFFECTS }); }
  catch { clips.delete(file!); load(file!); } // a clip the mixer lost: load it again
}

// -- the ambience bed and the music pad, rendered into clips ---------------------------------------
const RATE = 8000;
/** RBJ biquad lowpass over `x` in place (Web Audio's BiquadFilterNode, Q as linear). */
function lowpass(x: Float32Array, freq: number, q: number): void {
  const w = 2 * Math.PI * freq / RATE, alpha = Math.sin(w) / (2 * q), c = Math.cos(w);
  const a0 = 1 + alpha;
  const b0 = (1 - c) / 2 / a0, b1 = (1 - c) / a0, b2 = b0, a1 = -2 * c / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i]!;
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    x[i] = y0;
  }
}
/** The travelling-wind bed: seeded brown-ish noise through a 420 Hz lowpass,
 * a seamless 3 s loop (the browser build's looped buffer, gain 0.5). */
function bedClip(themeKey: string): AudioClip {
  const rate = 8000;
  const n = 3 * rate, fade = Math.round(0.25 * rate);
  const raw = new Float32Array(n + fade);
  const rng = createRng(hashSeed(`ambience:${themeKey}`));
  let last = 0;
  for (let i = 0; i < raw.length; i++) {
    last = last * 0.98 + (rng.next() * 2 - 1) * 0.02;
    raw[i] = last * 6;
  }
  // 420 Hz at 8 kHz (the filter's own rate).
  const w = 2 * Math.PI * 420 / rate, alpha = Math.sin(w) / (2 * 0.707), c = Math.cos(w), a0 = 1 + alpha;
  const b0 = (1 - c) / 2 / a0, b1 = (1 - c) / a0, a1 = -2 * c / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < raw.length; i++) {
    const x0 = raw[i]!, y0 = b0 * x0 + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0; raw[i] = Math.max(-1, Math.min(1, y0 * 0.5));
  }
  const out = raw.slice(0, n);
  for (let i = 0; i < fade; i++) { const k = i / fade; out[i] = raw[n + i]! * (1 - k) + raw[i]! * k; }
  return createClip([out], rate);
}
/** One pad step: each chord tone as a 3.6 s sine (0.05) and its 2.01×
 * triangle a 50 ms later (2.4 s, 0.02), exponential decays as the browser
 * build's blips. */
function chordClip(freqs: number[]): AudioClip {
  const n = Math.round(3.7 * RATE);
  const out = new Float32Array(n);
  const k1 = Math.pow(0.0001 / 0.05, 1 / (3.6 * RATE)), k2 = Math.pow(0.0001 / 0.02, 1 / (2.4 * RATE));
  const lag = Math.round(0.05 * RATE), end1 = Math.round(3.6 * RATE), end2 = lag + Math.round(2.4 * RATE);
  for (const f of freqs) {
    const w = 2 * Math.PI * f / RATE, step2 = f * 2.01 / RATE;
    let e1 = 0.05, e2 = 0.02, ph = 0;
    for (let i = 0; i < n; i++) {
      if (i < end1) { out[i]! += Math.sin(w * i) * e1; e1 *= k1; }
      if (i >= lag && i < end2) { out[i]! += (1 - 4 * Math.abs(ph - 0.5)) * e2; e2 *= k2; ph += step2; if (ph >= 1) ph -= 1; }
    }
  }
  lowpass(out, 3000, 0.707);
  return createClip([out], RATE);
}

const CHORDS = [
  [0, 3, 7, 10], // minor 7
  [0, 4, 7, 11], // major 7
  [0, 5, 7, 10], // 7sus
  [0, 3, 7, 9], // minor 6
];

let bed: { theme: string; sound: Sound | null; clip: AudioClip | null } | null = null;
let wantBed: string | null = null;
export function startAmbience(themeKey: string): void { wantBed = themeKey; poll(); }
export function stopAmbience(): void {
  wantBed = null;
  try { bed?.sound?.stop(); } catch { /* already gone */ }
  if (bed) bed.sound = null;
}

// The pad: a seeded root and progression per table, a chord every 3.4 s.
let music: { seed: number; root: number; rng: ReturnType<typeof createRng>; step: number; timer: number } | null = null;
const chordCache = new Map<string, AudioClip>();
const chordQueue: string[] = [];
export function startMusic(seed: number): void {
  stopMusic();
  const rng = createRng(hashSeed(`music:${seed >>> 0}`));
  const root = 110 * Math.pow(2, rng.int(5) / 12);
  music = { seed, root, rng, step: 0, timer: 0 };
  // Queue the progression's clips (both octaves), rendered one a frame.
  for (let c = 0; c < CHORDS.length; c++) for (const oct of [1, 2]) chordQueue.push(`${root.toFixed(3)}:${c}:${oct}`);
  tick();
  music.timer = setInterval(tick, 3400);
}
export function stopMusic(): void {
  if (music) clearInterval(music.timer);
  music = null;
}
function chordFor(key: string): AudioClip | null {
  const hit = chordCache.get(key);
  if (hit) return hit;
  if (context.state !== "running") return null;
  const [root, c, oct] = key.split(":").map(Number) as [number, number, number];
  const clip = chordClip(CHORDS[c]!.map((iv) => root * oct * Math.pow(2, iv / 12)));
  chordCache.set(key, clip);
  return clip;
}
function tick(): void {
  if (!music) return;
  const m = music;
  const c = (m.step + m.rng.int(2)) % CHORDS.length;
  const oct = m.step % 4 === 3 ? 2 : 1;
  m.step++;
  const clip = chordCache.get(`${m.root.toFixed(3)}:${c}:${oct}`);
  if (clip) try { playClip(clip, { bus: "music", gain: MUSIC }); } catch { /* the mixer is full */ }
}

/** Called each frame: starts what waited for the mixer, renders one pending clip. */
export function poll(): void {
  if (context.state !== "running") return;
  if (wantClips) { wantClips = false; for (const file of new Set(Object.values(SAMPLES))) load(file); }
  if (wantBed && (!bed || bed.theme !== wantBed || !bed.sound)) {
    try {
      if (!bed || bed.theme !== wantBed) { try { bed?.sound?.stop(); } catch { /* gone */ } bed = { theme: wantBed, sound: null, clip: bedClip(wantBed) }; return; }
      bed.sound = playClip(bed.clip!, { bus: "music", loop: true, gain: 0.5 * AMBIENCE });
    } catch (e) { console.warn(`ambience: ${String(e)}`); wantBed = null; }
    return;
  }
  const next = chordQueue.shift();
  if (next) chordFor(next);
}
