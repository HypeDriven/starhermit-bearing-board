// The game's data and the StarHermit platform, on the runtime's modules:
// - progress (journey stars, lessons, challenges, daily days, achievements,
//   lifetime stats: js/progress.js) is the game's save (starhermit:storage
//   `saves`): on the device and, signed in, in the account's cloud slot, two
//   devices' progress merged on a conflict (mergeProgress). The browser
//   build's cloud save (the JS SDK's zipped save.json { data, check } in the
//   slot game:<slug>) shows as foreign: it is merged in and replaces the slot
//   once (replaceForeign);
// - the game's own options (theme, left-handed, haptics, tap-to-select,
//   timing assistance, traveller name) are `settings` (game.<key>, synced
//   with the account); the browser build's per-player settings keys are
//   migrated where the game still has the option and removed. Sound,
//   graphics, language, controls and accessibility are the runtime's Options;
// - the table in progress (Continue) and the anonymous funnel stay on the
//   device (`storage`);
// - a finished solo game's match points go to the high-score board through
//   score-script.js: a practice session whose socket carries
//   { type: 'result', scores }, as the JS SDK's submitScores did.
import type { JsonValue } from "starhermit:engine";
import { connectGame, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, sessions, type Leaderboard } from "starhermit:platform";
import { saves, settings, storage } from "starhermit:storage";
import { DEFAULT_PROGRESS, fromBrowserSave, mergeProgress, normalizeProgress } from "../js/progress.js";
import { DEFAULT_SETTINGS, cleanSetting, migrateLegacySetting } from "../js/settings.js";

export type Progress = typeof DEFAULT_PROGRESS & {
  journey: Record<string, { stars: number; bestTurns?: number; goalsMet?: boolean }>;
  lessons: Record<string, { done: boolean }>;
  challenges: Record<string, { done: boolean; best?: number }>;
  daily: { days: string[]; lastDay: string | null };
  achievements: Record<string, { at: string }>;
  stats: Record<string, number>;
};

const SCHEMA = 1;
const norm = (d: unknown): Progress => (normalizeProgress(d) ?? normalizeProgress({})!) as Progress;

// --- progress ------------------------------------------------------------------------
let progress: Progress = norm(null);
const mergedListeners = new Set<() => void>();
/** fn() after progress from the account (another device, the browser build) came in. */
export function onProgressMerged(fn: () => void): void { mergedListeners.add(fn); }
function adopted(): void { for (const fn of mergedListeners) fn(); }

export function getProgress(): Progress { return progress; }
export function emptyProgress(): Progress { return norm(null); }
/** Replaces the progress document and saves it (device at once, the account debounced). */
export function saveProgress(p: Progress = progress): void {
  progress = norm(p);
  try { saves.save(progress as unknown as JsonValue, { schema: SCHEMA }); } catch (e) { console.warn(`save: ${String(e)}`); }
}

let lastSavedAt = 0;
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  const fromBrowser = fromBrowserSave(old.text);
  if (fromBrowser) progress = norm(mergeProgress(fromBrowser, progress));
  try { saves.save(progress as unknown as JsonValue, { schema: SCHEMA, replaceForeign: true }); }
  catch (e) { console.warn(`save migration: ${String(e)}`); }
  if (fromBrowser) adopted();
}

/** Reads the device's save, starts listening for the account's (from onStart). */
export function initPlatform(): void {
  const cur = saves.load();
  progress = norm(cur?.data);
  lastSavedAt = cur?.savedAt ?? 0;
  saves.onConflict((local, remote) => ({ merged: mergeProgress(remote.data, local?.data) as unknown as JsonValue }));
  saves.onStatus((_status, state) => {
    if (state === "foreign") { migrateForeign(); return; }
    // The account's save replaced the device's (another device saved last): adopt it.
    const now = saves.load();
    if (now && now.savedAt !== lastSavedAt) {
      lastSavedAt = now.savedAt;
      const next = norm(now.data);
      if (JSON.stringify(next) !== JSON.stringify(progress)) { progress = next; adopted(); }
    }
  });
  if (saves.state() === "foreign") migrateForeign();
  settings.onLegacy(importLegacySettings);
  importLegacySettings();
  refreshInvite();
}
export function flushSave(): void { void saves.flush().catch(() => undefined); }

// --- the game's own options -------------------------------------------------------------
export { DEFAULT_SETTINGS };
export type Settings = typeof DEFAULT_SETTINGS;
const KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];

export function loadSettings(): Settings {
  const out = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
  for (const key of KEYS) {
    const v = cleanSetting(key, settings.get(key));
    if (v !== undefined) out[key] = v;
  }
  return out as Settings;
}
export function saveSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  try { settings.set(key, value as unknown as JsonValue); } catch (e) { console.warn(`setting ${key}: ${String(e)}`); }
}
const settingsListeners = new Set<() => void>();
export function onSettingsChange(fn: () => void): void { settingsListeners.add(fn); }
settings.onChange(() => { for (const fn of settingsListeners) fn(); });

function importLegacySettings(): void {
  const keys = settings.legacyKeys();
  if (!keys) return;
  let changed = false;
  for (const key of keys) {
    const m = migrateLegacySetting(key, settings.legacy(key));
    if (m && settings.get(m.key) === undefined) { settings.set(m.key, m.value as JsonValue); changed = true; }
    // Every legacy key is the browser build's (its settings, sound, frame-rate and language slots).
    settings.removeLegacy(key);
  }
  if (changed) for (const fn of settingsListeners) fn();
}

// --- device-only records -----------------------------------------------------------------
export function storeGet<T>(key: string, fallback: T): T {
  try { const v = storage.getJson(key); return v === null ? fallback : (v as unknown as T); } catch { return fallback; }
}
export function storeSet(key: string, v: unknown): void {
  try { storage.setJson(key, v as JsonValue); } catch (e) { console.warn(`storage ${key}: ${String(e)}`); }
}
export function storeRemove(key: string): void { try { storage.remove(key); } catch { /* gone */ } }

/** Anonymous funnel events (boot, start, tutorial step, round end, retry,
 * undo, settings change, quit, error): on this device only, capped at 200. */
export function funnel(name: string, dim: string = ""): void {
  const day = new Date().toISOString().slice(0, 10);
  let sid = storeGet<{ day: string; id: string; events: { n: string; d: string; t: number }[] } | null>("funnel", null);
  if (!sid || sid.day !== day) sid = { day, id: Math.floor(Math.random() * 2 ** 40).toString(36), events: [] };
  sid.events.push({ n: name, d: String(dim).slice(0, 24), t: Date.now() });
  if (sid.events.length > 200) sid.events.splice(0, sid.events.length - 200);
  storeSet("funnel", sid);
}

// --- the player ------------------------------------------------------------------------------
export function signedIn(): boolean { return player() !== null; }
export function accountName(): string | null { return player()?.displayName?.slice(0, 40) ?? null; }
let invite: string | null = null;
function refreshInvite(): void {
  invite = null;
  if (!player()) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
}
/** The invite link, fetched ahead so a button press can copy it at once. */
export function inviteLink(): string | null { return player() ? invite : null; }
onPlayerChange(() => { refreshInvite(); board = null; });

// --- leaderboard -------------------------------------------------------------------------------
let board: Leaderboard | null = null;
async function highScoreBoard(): Promise<Leaderboard | null> {
  if (board) return board;
  const list = await leaderboards.list();
  board = list.find((b) => b.key === "high-score") ?? null;
  return board;
}

/** Posts a finished game's match points through score-script.js; whether it
 * was taken and the player's rank (null past the first 100). Never rejects. */
export async function submitScore(points: number): Promise<{ posted: boolean; rank: number | null }> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (list: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { "high-score": points } }); });
      socket.on("game", (data) => {
        const d = data as { type?: string; accepted?: string[] } | null;
        if (d && d.type === "result-ack") finish(Array.isArray(d.accepted) ? d.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes("high-score")) return { posted: false, rank: null };
  try {
    const b = await highScoreBoard();
    if (!b) return { posted: true, rank: null };
    const page = await leaderboards.entries(b.id, { pageSize: 100 });
    const mine = page.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}
