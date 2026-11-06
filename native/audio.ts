// Sound, ported from the browser build's js/audio.js onto the engine's mixer:
// the authored one-shots (sfx/<name>.opus, sfx/manifest.txt) per logical
// event, the travelling-wind ambience bed and the seeded slow music pad. The
// runtime's Options › Audio owns the volumes, mute and voice limit (the
// browser build's Music / Effects / Ambience / Voice sliders and its
// game-options.js sound panel): event cues play on "effects", the
// interface clicks (ack, tick, select) on "interface", the pad and the bed on
// "music", each at the level the browser build's default bus volume gave it.
//
// The bed and the pad chords are rendered once into clips by the engine's
// OfflineAudioContext (noise, oscillators, filter and envelopes natively). Every
// clip loads at start (onStart) and a cue whose clip is still loading is silent;
// every cue has a visual or announced twin.
import { OfflineAudioContext, context, createClip, loadClip, play as playClip, type AudioClip, type Bus, type Sound } from "starhermit:audio";
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
/** Measured: brown noise through the filter reads rms .199, the old bed .169 (within 0.5 dB per theme). */
const BED_MAKEUP = 0.85;

const clips = new Map<string, AudioClip>();
/** Loads every clip at once (onStart); a cue whose clip is still loading is skipped. */
export function loadSfx(): void {
  for (const file of new Set(Object.values(SAMPLES))) {
    loadClip(`sfx/${file}.opus`).then((c) => { clips.set(file, c); }, (e: unknown) => console.warn(`sfx ${file}: ${String(e)}`));
  }
}

/** Plays a logical event's cue (Audio.playEvent in the browser build). */
export function playEvent(name: string): void {
  const file = SAMPLES[name];
  const clip = file ? clips.get(file) : undefined;
  if (!clip) return;
  const bus: Bus = INTERFACE.has(name) ? "interface" : "effects";
  try { playClip(clip, { bus, gain: VOICE_CUES.has(name) ? VOICE : EFFECTS }); }
  catch { /* the mixer is full this frame: skip it */ }
}

// -- the ambience bed and the music pad, rendered into clips ---------------------------------------
const RATE = 8000;
/** The travelling-wind bed: seeded brown noise through a 420 Hz lowpass, a seamless 3 s
 * loop (the noise repeats every 3 s, so once the filter settled so does its output). */
async function renderBed(themeKey: string): Promise<AudioClip> {
  const n = 3 * RATE, settle = Math.round(0.25 * RATE);
  const off = new OfflineAudioContext(1, settle + n, RATE);
  const noise = off.createNoise({ color: "brown", seed: hashSeed(`ambience:${themeKey}`), seconds: 3 });
  const lp = off.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 420;
  const g = off.createGain(); g.gain.value = BED_MAKEUP;
  noise.connect(lp).connect(g).connect(off.destination); noise.start();
  const r = await off.startRendering();
  return createClip([r.getChannelData(0).slice(settle)], RATE);
}
/** One pad step: each chord tone as a 3.6 s sine (0.05) and its 2.01×
 * triangle 50 ms later (2.4 s, 0.02), exponential decays, through a 3 kHz lowpass. */
async function renderChord(freqs: number[]): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, Math.round(3.7 * RATE), RATE);
  const lp = off.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 3000;
  lp.connect(off.destination);
  const voice = (type: "sine" | "triangle", freq: number, level: number, start: number, end: number): void => {
    const osc = off.createOscillator(); osc.type = type; osc.frequency.value = freq;
    const g = off.createGain();
    g.gain.setValueAtTime(level, start); g.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(g).connect(lp); osc.start(start); osc.stop(end);
  };
  for (const f of freqs) { voice("sine", f, 0.05, 0, 3.6); voice("triangle", f * 2.01, 0.02, 0.05, 2.45); }
  return createClip(await off.startRendering());
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
const chordAsked = new Set<string>();
let chordRenders: Promise<unknown> = Promise.resolve();
/** Renders a chord unless it is cached or on its way, one at a time. */
function askChord(root: number, c: number, oct: number): void {
  const key = `${root.toFixed(3)}:${c}:${oct}`;
  if (chordAsked.has(key)) return;
  chordAsked.add(key);
  chordRenders = chordRenders
    .then(() => renderChord(CHORDS[c]!.map((iv) => root * oct * Math.pow(2, iv / 12))))
    .then((clip) => { chordCache.set(key, clip); }, (e: unknown) => console.warn(`music: ${String(e)}`));
}
export function startMusic(seed: number): void {
  stopMusic();
  const rng = createRng(hashSeed(`music:${seed >>> 0}`));
  const root = 110 * Math.pow(2, rng.int(5) / 12);
  music = { seed, root, rng, step: 0, timer: 0 };
  for (let c = 0; c < CHORDS.length; c++) for (const oct of [1, 2]) askChord(root, c, oct);
  tick();
  music.timer = setInterval(tick, 3400);
}
export function stopMusic(): void {
  if (music) clearInterval(music.timer);
  music = null;
}
function tick(): void {
  if (!music) return;
  const m = music;
  const c = (m.step + m.rng.int(2)) % CHORDS.length;
  const oct = m.step % 4 === 3 ? 2 : 1;
  m.step++;
  const clip = chordCache.get(`${m.root.toFixed(3)}:${c}:${oct}`);
  if (clip && context.state === "running") try { playClip(clip, { bus: "music", gain: MUSIC }); } catch { /* the mixer is full */ }
}

/** Called each frame: starts the bed once the mixer runs and its clip is rendered. */
export function poll(): void {
  if (context.state !== "running" || !wantBed) return;
  if (!bed || bed.theme !== wantBed) {
    try { bed?.sound?.stop(); } catch { /* gone */ }
    const b: NonNullable<typeof bed> = { theme: wantBed, sound: null, clip: null };
    bed = b;
    renderBed(b.theme).then((clip) => { b.clip = clip; }, (e: unknown) => { console.warn(`ambience: ${String(e)}`); if (bed === b) wantBed = null; });
    return;
  }
  if (bed.clip && !bed.sound) {
    try { bed.sound = playClip(bed.clip, { bus: "music", loop: true, gain: 0.5 * AMBIENCE }); }
    catch (e) { console.warn(`ambience: ${String(e)}`); wantBed = null; }
  }
}
