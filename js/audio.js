// Bearing Board — procedural WebAudio.
// Independent buses (music / effects / ambience / voice), original short
// transients tied to logical events, a quiet ambience bed, and an adaptive
// music pad whose seeded variants keep replays sounding consistent. No
// gameplay information is ever audio-only: every cue has a DOM/text twin.

import { createRng, hashSeed } from './rules.js';

let ctx = null;
let buses = null;          // {music, effects, ambience, voice} -> GainNode
let enabled = true;
let ambienceNodes = null;
let musicTimer = 0;
let musicSeed = 1;

const BUSES = ['music', 'effects', 'ambience', 'voice'];
const volumes = { music: 0.45, effects: 0.8, ambience: 0.35, voice: 0.7 };

function ensureCtx() {
  if (ctx || typeof window === 'undefined') return;
  // Browsers require a user gesture before audio may start.
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    buses = {};
    for (const name of BUSES) {
      const g = ctx.createGain();
      g.gain.value = enabled ? volumes[name] : 0;
      g.connect(ctx.destination);
      buses[name] = g;
    }
  } catch (_) { ctx = null; }
}

export function resumeAudio() {
  ensureCtx();
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
}

export function setVolume(bus, value) {
  if (!BUSES.includes(bus)) return;
  volumes[bus] = Math.max(0, Math.min(1, value));
  if (buses) buses[bus].gain.value = enabled ? volumes[bus] : 0;
}

export function getVolume(bus) { return volumes[bus] ?? 0; }

export function setAudioEnabled(on) {
  enabled = !!on;
  if (!buses) return;
  for (const name of BUSES) buses[name].gain.value = enabled ? volumes[name] : 0;
}

export function audioEnabled() { return enabled; }

// Backgrounding: keep the graph alive but silent so resume is instant.
export function setBackgrounded(hidden) {
  if (!ctx) return;
  if (hidden) ctx.suspend().catch(() => {});
  else if (enabled) ctx.resume().catch(() => {});
}

// ---------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------

function blip(bus, freq, dur, gain, type = 'triangle', when = 0, glide = 0) {
  if (!ctx || !buses || gain <= 0) return;
  const t = ctx.currentTime + when;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (glide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + glide), t + dur);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(buses[bus]);
  o.start(t); o.stop(t + dur + 0.02);
}

// Filtered noise burst — dice rattle, leather thuds, wood knocks.
function noise(bus, dur, gain, freq = 1200, q = 0.8, when = 0) {
  if (!ctx || !buses || gain <= 0) return;
  const t = ctx.currentTime + when;
  const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  const rng = createRng(hashSeed(`noise:${musicSeed}:${len}:${freq}`));
  for (let i = 0; i < len; i++) data[i] = (rng.next() * 2 - 1) * (1 - i / len);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(buses[bus]);
  src.start(t);
}

// ---------------------------------------------------------------------------
// Ambience: a soft travelling-wind bed (looped filtered noise, very quiet)
// ---------------------------------------------------------------------------

export function startAmbience(themeKey = 'caravan') {
  ensureCtx();
  if (!ctx || ambienceNodes) return;
  const len = ctx.sampleRate * 3;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  const rng = createRng(hashSeed(`ambience:${themeKey}`));
  let last = 0;
  for (let i = 0; i < len; i++) {
    last = last * 0.98 + (rng.next() * 2 - 1) * 0.02; // brown-ish drift
    data[i] = last * 6;
  }
  const src = ctx.createBufferSource();
  src.buffer = buf; src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass'; f.frequency.value = 420;
  const g = ctx.createGain();
  g.gain.value = 0.5;
  src.connect(f).connect(g).connect(buses.ambience);
  src.start();
  ambienceNodes = { src, g };
}

export function stopAmbience() {
  if (!ambienceNodes) return;
  try { ambienceNodes.src.stop(); } catch (_) {}
  ambienceNodes = null;
}

// ---------------------------------------------------------------------------
// Adaptive music: slow pad chords from a seeded progression. Two stems
// (low + high) that trade density as the game nears its end.
// ---------------------------------------------------------------------------

const CHORDS = [
  [0, 3, 7, 10],   // minor 7
  [0, 4, 7, 11],   // major 7
  [0, 5, 7, 10],   // 7sus
  [0, 3, 7, 9],    // minor 6
];

export function startMusic(seed = 1) {
  ensureCtx();
  musicSeed = seed >>> 0;
  if (!ctx || musicTimer) return;
  const rng = createRng(hashSeed(`music:${musicSeed}`));
  const root = 110 * Math.pow(2, rng.int(5) / 12);
  let step = 0;
  const tick = () => {
    if (!ctx) return;
    const chord = CHORDS[(step + rng.int(2)) % CHORDS.length];
    const octave = step % 4 === 3 ? 2 : 1;
    for (const iv of chord) {
      const f = root * octave * Math.pow(2, iv / 12);
      blip('music', f, 3.6, 0.05, 'sine');
      blip('music', f * 2.01, 2.4, 0.02, 'triangle', 0.05);
    }
    step++;
  };
  tick();
  musicTimer = setInterval(tick, 3400);
}

export function stopMusic() {
  if (musicTimer) clearInterval(musicTimer);
  musicTimer = 0;
}

// ---------------------------------------------------------------------------
// Authored sample one-shots (sfx/manifest.json). Each logical event prefers
// its mapped .opus clip; the procedural synthesis above remains the fallback
// while a clip is still loading or if fetch/decode fails.
// ---------------------------------------------------------------------------

const SFX_SAMPLES = {
  ack: 'ui-ack',
  roll: 'dice-roll',
  move: 'checker-move',
  hit: 'checker-hit',
  bearOff: 'bear-off',
  enter: 'rail-enter',
  double: 'stakes-offer',
  accept: 'stakes-accept',
  decline: 'stakes-decline',
  invalid: 'invalid-move',
  noMoves: 'no-moves',
  turn: 'turn-change',
  win: 'game-win',
  lose: 'game-lose',
  unlock: 'unlock-chime',
  tick: 'ui-tick',
};

const sampleCache = new Map(); // basename -> AudioBuffer | null (failed)
const samplePending = new Set();

function loadSample(base) {
  if (sampleCache.has(base) || samplePending.has(base)) return;
  samplePending.add(base);
  fetch(`sfx/${base}.opus`)
    .then((r) => { if (!r.ok) throw new Error(`sfx ${r.status}`); return r.arrayBuffer(); })
    .then((ab) => ctx && ctx.decodeAudioData(ab))
    .then((buf) => { sampleCache.set(base, buf || null); })
    .catch(() => { sampleCache.set(base, null); })
    .finally(() => { samplePending.delete(base); });
}

// Returns true when the mapped clip actually started playing.
function playSample(base) {
  const buf = sampleCache.get(base);
  if (!buf) { loadSample(base); return false; }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(buses.effects);
  src.start();
  return true;
}

// ---------------------------------------------------------------------------
// Logical event mapping (single entry point used by the session controller)
// ---------------------------------------------------------------------------

export function playEvent(name, seed = 0) {
  if (!enabled) return;
  resumeAudio();
  if (!ctx) return;
  const base = SFX_SAMPLES[name];
  if (base && playSample(base)) return;
  const rng = createRng(hashSeed(`sfx:${name}:${seed}`));
  const v = 0.92 + rng.next() * 0.16; // seeded pitch/variant
  switch (name) {
    case 'ack':      blip('effects', 660 * v, 0.06, 0.12); break;
    case 'roll':
      noise('effects', 0.22, 0.30, 2400, 0.6);
      noise('effects', 0.12, 0.22, 3600, 0.8, 0.10);
      blip('effects', 190 * v, 0.14, 0.18, 'square', 0.16);
      break;
    case 'move':     noise('effects', 0.09, 0.35, 900, 1.2); blip('effects', 150 * v, 0.12, 0.2); break;
    case 'hit':
      noise('effects', 0.16, 0.4, 500, 1.0);
      blip('effects', 96 * v, 0.3, 0.3, 'sawtooth');
      blip('effects', 1400 * v, 0.12, 0.1, 'square', 0.02);
      break;
    case 'bearOff':  blip('effects', 660 * v, 0.2, 0.22); blip('effects', 990 * v, 0.24, 0.16, 'sine', 0.08); break;
    case 'enter':    blip('effects', 330 * v, 0.14, 0.2); noise('effects', 0.08, 0.2, 1100, 1.0, 0.03); break;
    case 'double':   blip('effects', 392, 0.35, 0.28, 'square'); blip('effects', 523, 0.3, 0.2, 'square', 0.12); break;
    case 'accept':   blip('effects', 523, 0.22, 0.24); blip('effects', 784, 0.26, 0.2, 'sine', 0.1); break;
    case 'decline':  blip('effects', 262, 0.3, 0.24); blip('effects', 196, 0.34, 0.2, 'sine', 0.12); break;
    case 'invalid':  blip('effects', 110, 0.16, 0.2, 'square'); break;
    case 'noMoves':  blip('effects', 165, 0.2, 0.16); break;
    case 'turn':     blip('effects', 440 * v, 0.08, 0.1); break;
    case 'win':
      [523, 659, 784, 1047].forEach((f, i) => blip('voice', f, 0.5, 0.2, 'sine', i * 0.13));
      break;
    case 'lose':     [392, 330, 262].forEach((f, i) => blip('voice', f, 0.5, 0.18, 'sine', i * 0.16)); break;
    case 'unlock':   [784, 988, 1175].forEach((f, i) => blip('voice', f, 0.4, 0.16, 'triangle', i * 0.09)); break;
    case 'tick':     blip('effects', 880, 0.05, 0.08); break;
  }
}
