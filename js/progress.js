// Bearing Board — the progress document shape, the cloud-save conflict
// merge and the browser build's cloud save. Pure data, no DOM (shared by the
// engine client, native/platform.ts, and the tests). The progress document is
// the game's save (starhermit:storage `saves`); the browser build kept it in
// the cloud slot game:<slug> as a zipped save.json holding { data, check }
// (check: the FNV-1a checksum below), which the engine shows as a foreign
// save and fromBrowserSave() reads.

export const DEFAULT_PROGRESS = {
  version: 1,
  journey: {},          // defId -> {stars, bestTurns, goalsMet}
  lessons: {},          // defId -> {done}
  challenges: {},       // defId -> {done, best}
  daily: { days: [], lastDay: null },
  achievements: {},     // key -> {at}
  stats: { games: 0, wins: 0, hits: 0, sweeps: 0 },
};

const clone = (v) => JSON.parse(JSON.stringify(v));

/** FNV-1a over the JSON text, 8 hex digits (the browser build's checksum). */
export function checksum(obj) {
  const s = JSON.stringify(obj);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** A progress document from anything (a save, a cloud copy): the defaults
 * filled in, unknown shapes dropped; null when it is not one. */
export function normalizeProgress(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? clone(v) : {});
  const out = clone(DEFAULT_PROGRESS);
  out.journey = obj(d.journey);
  out.lessons = obj(d.lessons);
  out.challenges = obj(d.challenges);
  out.achievements = obj(d.achievements);
  const daily = obj(d.daily);
  out.daily = { days: Array.isArray(daily.days) ? daily.days.filter((x) => typeof x === 'string') : [], lastDay: typeof daily.lastDay === 'string' ? daily.lastDay : null };
  const stats = obj(d.stats);
  for (const k of Object.keys(stats)) out.stats[k] = Math.max(0, Number(stats[k]) || 0);
  return out;
}

/** The browser build's cloud save (save.json text, { data, check }) as a
 * progress document, or null when it is not one or its checksum fails. */
export function fromBrowserSave(text) {
  if (typeof text !== 'string') return null;
  let doc;
  try { doc = JSON.parse(text); } catch { return null; }
  if (!doc || typeof doc !== 'object' || !doc.data || doc.check !== checksum(doc.data)) return null;
  return normalizeProgress(doc.data);
}

// Combine two progress documents after a cloud-save conflict so neither
// device's progress is lost: the better record of every stage, lesson and
// challenge, every daily day and achievement (earliest unlock), larger stats.
export function mergeProgress(remote, local) {
  const a = { ...clone(DEFAULT_PROGRESS), ...(remote || {}) };
  const b = { ...clone(DEFAULT_PROGRESS), ...(local || {}) };
  const out = clone(DEFAULT_PROGRESS);
  for (const id of new Set([...Object.keys(a.journey), ...Object.keys(b.journey)])) {
    const x = a.journey[id], y = b.journey[id];
    if (!x || !y) { out.journey[id] = clone(x || y); continue; }
    out.journey[id] = {
      stars: Math.max(x.stars || 0, y.stars || 0),
      bestTurns: Math.min(x.bestTurns ?? 9999, y.bestTurns ?? 9999),
      goalsMet: !!(x.goalsMet || y.goalsMet),
    };
  }
  for (const id of new Set([...Object.keys(a.lessons), ...Object.keys(b.lessons)])) {
    out.lessons[id] = { done: !!(a.lessons[id]?.done || b.lessons[id]?.done) };
  }
  for (const id of new Set([...Object.keys(a.challenges), ...Object.keys(b.challenges)])) {
    const x = a.challenges[id], y = b.challenges[id];
    out.challenges[id] = { done: !!(x?.done || y?.done), best: Math.min(x?.best ?? Infinity, y?.best ?? Infinity) };
    if (!Number.isFinite(out.challenges[id].best)) delete out.challenges[id].best;
  }
  out.daily.days = [...new Set([...(a.daily.days || []), ...(b.daily.days || [])])].sort();
  out.daily.lastDay = [a.daily.lastDay, b.daily.lastDay].filter(Boolean).sort().pop() || null;
  for (const k of new Set([...Object.keys(a.achievements), ...Object.keys(b.achievements)])) {
    const x = a.achievements[k]?.at, y = b.achievements[k]?.at;
    out.achievements[k] = { at: [x, y].filter(Boolean).sort()[0] };
  }
  for (const k of new Set([...Object.keys(a.stats), ...Object.keys(b.stats)])) {
    out.stats[k] = Math.max(Number(a.stats[k]) || 0, Number(b.stats[k]) || 0);
  }
  return out;
}

