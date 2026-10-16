// Bearing Board — the progress document shape and the cloud-save conflict
// merge. Pure data, no DOM (shared by main.js and the tests).

export const DEFAULT_PROGRESS = {
  version: 1,
  journey: {},          // defId -> {stars, bestTurns, goalsMet}
  lessons: {},          // defId -> {done}
  challenges: {},       // defId -> {done, best}
  daily: { days: [], lastDay: null },
  achievements: {},     // key -> {at}
  stats: { games: 0, wins: 0, hits: 0, sweeps: 0 },
};

// Combine two progress documents after a cloud-save conflict so neither
// device's progress is lost: the better record of every stage, lesson and
// challenge, every daily day and achievement (earliest unlock), larger stats.
export function mergeProgress(remote, local) {
  const a = { ...structuredClone(DEFAULT_PROGRESS), ...(remote || {}) };
  const b = { ...structuredClone(DEFAULT_PROGRESS), ...(local || {}) };
  const out = structuredClone(DEFAULT_PROGRESS);
  for (const id of new Set([...Object.keys(a.journey), ...Object.keys(b.journey)])) {
    const x = a.journey[id], y = b.journey[id];
    if (!x || !y) { out.journey[id] = structuredClone(x || y); continue; }
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

