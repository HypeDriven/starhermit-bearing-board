// Bearing Board on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The session controller, goals, stars,
// achievements and input are the browser build's (js/main.js before the
// port); the rules, AI and content are the shared js/rules.js, js/ai.js and
// js/content.js, unchanged. Screens and the HUD are starhermit:ui
// (screens.ts), the board starhermit:scene (render.ts), saves and the
// platform platform.ts. App phases: title → menus (journey | learn |
// challenges | setup) → game ↔ paused → results → title, with settings and
// help from the title or the pause card.
import { clipboard, frame, onPreferencesChange, onRender, onResume, onStart, onSuspend, onUpdate, preferences } from "starhermit:engine";
import { onAction, onPointerButton, onPointerMove, onTouch, vibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded } from "starhermit:platform";
import * as Rules from "../js/rules.js";
import * as Content from "../js/content.js";
import * as AI from "../js/ai.js";
import * as render from "./render.ts";
import * as audio from "./audio.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import { onLanguage, t } from "./i18n.ts";
import { achDesc, achLabel, defName, fmtClock, type Def } from "./names.ts";
import { setStyle } from "./style.ts";
import { drawScreens } from "./screens.ts";

const BUILD_VERSION = "1.0.0";
const AI_THINK_MS = 650;

// The rules state (js/rules.js createGame / applyCommand), typed loosely: the rules are untyped JS.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type State = any;
type Cmd = { type: string; player: number; from?: number | "rail"; to?: number | "off"; die?: number; id?: string };
export type Ev = { type: string; player?: number; from?: number | "rail"; to?: number | "off"; point?: number; hit?: boolean; dice?: number[]; value?: number; reason?: string; result?: Result };
export type Result = { winner: number; points: number; cubeValue: number; factor: number; reason: string; breakdown: { key: string; label: string; value: number | string }[] };
type Move = { from: number | "rail"; to: number | "off"; die: number; hit?: boolean };
type Goal = { key: string; vars: Record<string, string | number>; met: boolean };
export type GoalReport = { items: Goal[]; won: boolean; complete: boolean; allMet: boolean };
type Snapshot = { version: 1; cfg: unknown; log: Cmd[]; hash: string; defId: string; defKind: string; def: Def; thinkingMs: number; savedAt: string };

/** Game-clock milliseconds (pauses while suspended; advances in headless checks). */
const nowMs = (): number => frame().time * 1000;

// ------------------------------------------------------------------ session
export class Session {
  def: Def;
  cfg: ReturnType<typeof defToConfig>;
  humanSeats: Set<number>;
  aiDifficulty: string;
  state!: State;
  log: Cmd[] = [];
  snapshots: { stateJSON: string; logLen: number; thinkingMs: number }[] = [];
  lastEvents: Ev[] = [];
  result: Result | null = null;
  goalReport: GoalReport | null = null;
  thinkingMs: number;
  thinkStart = 0;
  startedAt = Date.now();
  aiTimer = 0;
  paused = false;
  finished = false;
  tutorial: { step: number; count: number; done: boolean } | null;
  newAchievements: { key: string; label: string; desc: string }[] = [];
  lbPost: Promise<{ posted: boolean; rank: number | null }> | null = null;
  lbResult: { posted: boolean; rank: number | null } | null = null;

  constructor(def: Def, opts: { humanSeats?: number[]; thinkingMs?: number } = {}) {
    this.def = def;
    this.cfg = defToConfig(def);
    this.humanSeats = new Set(opts.humanSeats || [0]);
    this.aiDifficulty = def.ai?.difficulty || "steady";
    this.thinkingMs = opts.thinkingMs || 0;
    this.tutorial = def.tutorial ? { step: 0, count: 0, done: false } : null;
  }

  start(snapshot?: Snapshot | null): void {
    if (snapshot && snapshot.cfg && Array.isArray(snapshot.log)) {
      // Deterministic resume: replay the command log onto a fresh game.
      try {
        const r = Rules.replay(snapshot.cfg, snapshot.log);
        if (r.finalHash === snapshot.hash) { this.state = r.state; this.log = snapshot.log.slice(); }
      } catch { /* a damaged save restarts fresh */ }
    }
    if (!this.state) { this.state = Rules.createGame(this.cfg); this.log = []; }
    if (this.state.winner >= 0) this.finished = true;
    this.pushSnapshot();
  }

  get over(): boolean { return this.state.winner >= 0; }

  isHumanTurn(): boolean {
    if (this.over) return false;
    if (this.state.phase === "cube") {
      const by = this.state.cube.pending?.by ?? 0;
      return this.humanSeats.has((by + 1) % this.state.cfg.players);
    }
    return this.humanSeats.has(this.state.active);
  }

  /** Undo checkpoint: a human decision point (their roll phase). */
  pushSnapshot(): void {
    if (!this.def.mechanics?.undo) return;
    if (!this.isHumanTurn() || this.state.phase !== "roll") return;
    this.snapshots.push({ stateJSON: Rules.serialize(this.state), logLen: this.log.length, thinkingMs: this.thinkingMs });
    if (this.snapshots.length > 40) this.snapshots.shift();
  }
  canUndo(): boolean { return this.def.mechanics?.undo === true && this.snapshots.length > 1 && !this.over; }
  undo(): boolean {
    if (!this.canUndo()) return false;
    this.snapshots.pop(); // the current position
    const snap = this.snapshots[this.snapshots.length - 1]!;
    this.state = Rules.deserialize(snap.stateJSON);
    this.log.length = snap.logLen;
    this.thinkingMs = snap.thinkingMs;
    this.thinkStart = this.isHumanTurn() ? nowMs() : 0;
    platform.funnel("undo", this.def.kind);
    return true;
  }

  startThinking(): void {
    if (this.state.active === 0 || (this.state.phase === "cube" && this.isHumanTurn())) {
      if (!this.thinkStart) this.thinkStart = nowMs() || 1;
    }
  }
  stopThinking(): void {
    if (this.thinkStart) { this.thinkingMs += nowMs() - this.thinkStart; this.thinkStart = 0; }
  }
  /** The thinking clock now (the HUD's timed goal). */
  thinkingNow(): number { return this.thinkingMs + (this.thinkStart ? nowMs() - this.thinkStart : 0); }

  dispatch(cmd: Cmd): { ok: boolean; reason?: string; events?: Ev[] } {
    if (this.over || this.paused) return { ok: false };
    cmd.id = cmd.id || Rules.makeCmdId("bb");
    this.stopThinking();
    const r = Rules.applyCommand(this.state, cmd);
    if (!r.ok) {
      const reason = (r.events[0] as Ev | undefined)?.reason || "illegal action";
      const why = t(`rule.${reason}`, null, reason);
      audio.playEvent("invalid");
      toast(t("invalid.toast", { reason: why }));
      announce(t("invalid.announce", { reason: why }), true);
      this.state = r.state; // invalid-action stats are authoritative
      this.startThinking();
      return { ok: false, reason };
    }
    this.state = r.state;
    this.log.push(cmd);
    this.afterCommands(r.events as Ev[]);
    return { ok: true, events: r.events as Ev[] };
  }

  afterCommands(events: Ev[]): void {
    this.lastEvents = events;
    this.watchTutorial(events);
    for (const ev of events) if (ev.type === "gameOver") { this.finish(ev.result!); break; }
    if (!this.over) {
      this.pushSnapshot();
      this.startThinking();
      this.persistSnapshot();
    }
  }

  watchTutorial(events: Ev[]): void {
    const tut = this.tutorial;
    if (!tut || tut.done) return;
    const steps = this.def.tutorial!.steps;
    const step = steps[tut.step];
    if (!step) { tut.done = true; return; }
    const matched = events.some((ev) => {
      if (ev.player !== undefined && !this.humanSeats.has(ev.player)) return false;
      switch (step.expect) {
        case "roll": return ev.type === "roll";
        case "move": return ev.type === "move";
        case "hit": return ev.type === "hit";
        case "enter": return ev.type === "move" && ev.from === "rail";
        case "bearOff": return ev.type === "bearOff";
        case "double": return ev.type === "double";
        default: return false;
      }
    });
    if (!matched) return;
    tut.count += 1;
    platform.funnel("tutorial_step", `${this.def.id}:${tut.step}`);
    if (tut.count >= (step.times || 1)) {
      tut.step += 1;
      tut.count = 0;
      if (tut.step >= steps.length) tut.done = true;
    }
  }

  pause(): void { this.paused = true; clearTimeout(this.aiTimer); this.stopThinking(); }
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.startThinking();
    this.scheduleAI();
  }

  scheduleAI(delay = AI_THINK_MS): void {
    clearTimeout(this.aiTimer);
    if (this.over || this.paused || this.isHumanTurn()) return;
    this.aiTimer = setTimeout(() => this.aiStep(), reducedMotion() ? 180 : delay);
  }
  aiStep(): void {
    if (this.over || this.paused || app.session !== this) return;
    const seat = this.state.phase === "cube" ? (this.state.cube.pending.by + 1) % this.state.cfg.players : this.state.active;
    if (this.humanSeats.has(seat)) return;
    const cmd = AI.aiCommand(this.state, seat, this.aiDifficulty) as Cmd | null;
    if (!cmd) return;
    this.dispatch(cmd);
    updateAfterStateChange();
    this.scheduleAI();
  }

  persistSnapshot(): void {
    if (this.over) return;
    const snap: Snapshot = {
      version: 1, cfg: this.cfg, log: this.log, hash: Rules.hashState(this.state), defId: this.def.id, defKind: this.def.kind,
      def: this.def, thinkingMs: this.thinkingMs, savedAt: new Date().toISOString(),
    };
    platform.storeSet("snapshot", snap);
  }
  clearPersisted(): void { platform.storeRemove("snapshot"); }

  /** Schema, build / content / rules versions, seed, initial hash, ordered commands, hashes, result. */
  replayEnvelope(): Record<string, unknown> {
    const r = Rules.replay(this.cfg, this.log);
    return {
      schema: 1, build: BUILD_VERSION, contentVersion: Content.CONTENT_VERSION, rulesVersion: Rules.RULES_VERSION,
      seed: this.cfg.seed, initialHash: r.hashes[0], timestampOffset: new Date(this.startedAt).toISOString(),
      commands: this.log.slice(), hashes: r.hashes, finalHash: r.finalHash, result: this.state.result,
    };
  }

  hint(): void {
    if (!this.def.mechanics?.hint || !this.isHumanTurn()) return;
    const h = AI.suggestHint(this.state, this.state.active) as { kind: string; move?: Move; text?: string } | null;
    if (h) { const text = hintText(h); toast(text); announce(t("hint.announce", { text })); }
  }

  finish(result: Result): void {
    this.stopThinking();
    this.finished = true;
    this.result = result;
    this.goalReport = evaluateGoals(this.def, this.state, this.thinkingMs);
    this.clearPersisted();
    this.newAchievements = applyOutcome(this, result);
  }
}

/** Hint text from AI.suggestHint's structured result, in the game language. */
function hintText(h: { kind: string; move?: Move; text?: string }): string {
  if (h.kind === "roll") return t("hint.roll");
  if (h.kind === "pass") return t("hint.pass");
  const m = h.move;
  if (!m) return h.text ?? "";
  const from = m.from === "rail" ? t("place.rail") : t("place.point", { n: m.from + 1 });
  const to = m.to === "off" ? t("place.off") : t("place.point", { n: m.to + 1 });
  const why = m.hit ? t("hint.hit") : m.to === "off" ? t("hint.off") : "";
  return `${t("hint.move", { from, to, die: m.die })} ${why}`.trim();
}

function defToConfig(def: Def) {
  return {
    id: def.id, version: def.version || 1, kind: def.kind, ruleset: def.ruleset, players: def.players,
    seed: def.seed >>> 0, options: def.options || {}, goals: def.goals || { win: true },
    layout: (def as { layout?: unknown }).layout, scriptedDice: (def as { scriptedDice?: unknown }).scriptedDice,
  };
}

// ------------------------------------------------------------------ goals, stars, achievements
export function evaluateGoals(def: Def, state: State, thinkingMs: number): GoalReport {
  const goals = (def.goals || { win: true }) as Record<string, number | boolean | undefined>;
  const res = state.result as Result;
  const me = 0;
  const won = res.winner === me;
  const hitsAgainst = state.stats.hits.reduce((a: number, h: number, p: number) => (p === me ? a : a + h), 0);
  const timeLimit = goals.maxTimeSec ? Number(goals.maxTimeSec) * app.settings.timingAssist : null;
  const items: Goal[] = [];
  // Labels are rendered from key + values so the results screen follows the language.
  const add = (key: string, vars: Record<string, string | number>, met: boolean): void => { items.push({ key, vars, met: !!met }); };
  if (goals.win !== false) add(won ? "won" : "win", {}, won);
  if (goals.maxTurns) add("maxTurns", { n: Number(goals.maxTurns), cur: state.turnNum }, state.turnNum <= Number(goals.maxTurns));
  if (goals.minHits) add("minHits", { n: Number(goals.minHits), cur: state.stats.hits[me] }, state.stats.hits[me] >= Number(goals.minHits));
  if (goals.minPoints) add("minPoints", { n: Number(goals.minPoints), cur: res.points }, won && res.points >= Number(goals.minPoints));
  if (goals.maxHitsAgainst != null) add("maxHitsAgainst", { n: Number(goals.maxHitsAgainst), cur: hitsAgainst }, hitsAgainst <= Number(goals.maxHitsAgainst));
  if (timeLimit) add("maxTimeSec", { n: Math.round(timeLimit / 60), cur: fmtClock(thinkingMs) }, thinkingMs <= timeLimit * 1000);
  const complete = items.length > 0 && items[0]!.met;
  const allMet = items.every((i) => i.met);
  return { items, won, complete, allMet };
}

export function starsFor(def: Def, report: GoalReport, state: State, thinkingMs: number): number {
  if (!report.won) return 0;
  let stars = 1;
  if (report.allMet) stars += 1;
  const par = def.par || {};
  const parOk = (!par.turns || state.turnNum <= par.turns) && (!par.timeSec || thinkingMs <= par.timeSec * 1000 * app.settings.timingAssist);
  if (parOk) stars += 1;
  return stars;
}

export function unlockAchievement(key: string): { key: string; label: string; desc: string } | null {
  const progress = platform.getProgress();
  if (progress.achievements[key]) return null; // idempotent
  const def = (Content.ACHIEVEMENTS as { key: string; label: string; desc: string }[]).find((a) => a.key === key);
  if (!def) return null;
  progress.achievements[key] = { at: new Date().toISOString() };
  platform.saveProgress(progress);
  audio.playEvent("unlock");
  toast(t("ach.toast", { name: achLabel(def) }));
  announce(t("ach.announce", { name: achLabel(def), desc: achDesc(def) }), true);
  return def;
}

function applyOutcome(session: Session, result: Result): { key: string; label: string; desc: string }[] {
  const { def, state, goalReport } = session;
  const progress = platform.getProgress();
  const me = 0;
  const won = result.winner === me;
  progress.stats.games = (progress.stats.games || 0) + 1;
  if (won) progress.stats.wins = (progress.stats.wins || 0) + 1;
  progress.stats.hits = (progress.stats.hits || 0) + state.stats.hits[me];
  const newly: { key: string; label: string; desc: string }[] = [];
  const push = (key: string): void => { const a = unlockAchievement(key); if (a) newly.push(a); };
  if (won) push("first_win");
  if (won && result.factor > 1) { progress.stats.sweeps = (progress.stats.sweeps || 0) + 1; push("first_sweep"); }
  if (progress.stats.hits >= 50) push("hitter_50");
  if (progress.stats.games >= 100) push("hundred_tables");
  if (won && state.cfg.ruleset === "circuit" && state.cfg.players === 4) push("circuit_champion");
  if (won && result.cubeValue >= 4) push("cube_closer");
  if (def.kind === "journey") {
    const stars = starsFor(def, goalReport!, state, session.thinkingMs);
    const prev = progress.journey[def.id] || { stars: 0 };
    if (stars > prev.stars || !progress.journey[def.id]) {
      progress.journey[def.id] = {
        stars: Math.max(stars, prev.stars || 0),
        bestTurns: Math.min(prev.bestTurns ?? 9999, state.turnNum),
        goalsMet: goalReport!.allMet || !!prev.goalsMet,
      };
    }
    const done = Object.keys(progress.journey).length;
    if (done >= 20) push("journey_half");
    if (done >= Content.JOURNEY.length) push("journey_full");
  }
  if (def.kind === "learn" && (session.tutorial?.done || won)) progress.lessons[def.id] = { done: true };
  if (def.kind === "challenge" && goalReport!.complete && goalReport!.allMet) progress.challenges[def.id] = { done: true, best: state.turnNum };
  if (def.kind === "daily") {
    const day = def.id.replace("daily-", "");
    if (!progress.daily.days.includes(day) && won) { progress.daily.days.push(day); progress.daily.lastDay = day; }
    if (progress.daily.days.length >= 7) push("daily_streak_7");
  }
  platform.saveProgress(progress);
  platform.funnel("round_end", `${def.kind}:${won ? "win" : "loss"}`);
  return newly;
}

export function journeyStars(): number {
  return Object.values(platform.getProgress().journey).reduce((a, j) => a + (j.stars || 0), 0);
}
export function masteryTitle(): { stars: number; title: string } {
  const stars = journeyStars();
  let title = t("tier.0", null, Content.MASTERY_TIERS[0]!.title);
  Content.MASTERY_TIERS.forEach((tier: { stars: number; title: string }, i: number) => { if (stars >= tier.stars) title = t(`tier.${i}`, null, tier.title); });
  return { stars, title };
}

// ------------------------------------------------------------------ app state
export type Phase = "title" | "journey" | "learn" | "challenges" | "setup" | "game" | "results" | "settings" | "help";
export const app = {
  phase: "title" as Phase,
  /** Settings and help opened from the pause card go back to it. */
  returnTo: "title" as "title" | "pause",
  paused: false,
  pausedAt: 0,
  session: null as Session | null,
  selection: null as { from: number | "rail"; moves: Move[] } | null,
  /** The keyboard / pad board cursor: points 0–23, 24 the rail, 25 the off tray. */
  cursor: null as number | null,
  toast: null as { text: string; until: number } | null,
  settings: platform.DEFAULT_SETTINGS as platform.Settings,
  resultsPending: false,
  setup: { ruleset: 0, difficulty: 1, players: 0, humans: 0, theme: 0, seed: "" },
  lbLine: null as string | null,
};
export function reducedMotion(): boolean { return preferences().reducedMotion; }

export function announce(text: string, assertive = false): void {
  if (!text) return;
  try { ui.announce(text.slice(0, 500), { politeness: assertive ? "assertive" : "polite" }); } catch { /* too many at once */ }
}
export function toast(text: string, ms = 2600): void { app.toast = { text, until: nowMs() + ms }; }
function haptic(ms: number): void { if (app.settings.haptics) vibrate(ms); }

export function seatName(seat: number): string {
  const s = app.session;
  if (s?.humanSeats.has(seat) && seat !== 0) return t("seat.traveler", { n: seat + 1 });
  if (seat === 0) return t("seat.you");
  if (seat >= 1 && seat <= 3) return t("seat.rival", { n: seat });
  return t("seat.seat", { n: seat + 1 });
}
export function seatColor(seat: number): string {
  const theme = Content.themeByKey(app.session?.def.theme || app.settings.theme);
  return `#${theme.players[seat % theme.players.length].toString(16).padStart(6, "0")}`;
}
export function profileName(): string {
  return platform.accountName() ?? (app.settings.profileName || t("profile.default"));
}

// ------------------------------------------------------------------ boot
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const key = `${f.quality}:${f.levelIndex}`;
  if (key === lookKey) return;
  lookKey = key;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}

onStart(() => {
  platform.initPlatform();
  app.settings = platform.loadSettings();
  setStyle();
  audio.loadSfx();
  render.setReducedMotion(reducedMotion());
  applyLook();
  render.setTheme(app.settings.theme);
  platform.funnel("boot", BUILD_VERSION);
  showTitle();
});
onPreferencesChange((p) => render.setReducedMotion(p.reducedMotion));
onLanguage(() => { /* every screen is rebuilt each frame */ });
platform.onProgressMerged(() => toast(t("toast.merged")));
platform.onSettingsChange(() => {
  app.settings = platform.loadSettings();
  if (!app.session || app.phase !== "game") render.setTheme(app.settings.theme);
});
onSessionEnded(() => toast(t("acc.signedOut")));
onSuspend(() => {
  // Backgrounding pauses a local game (the runtime stops frames and audio).
  if (app.phase === "game" && app.session && !app.session.over && !app.paused) pauseGame();
  platform.flushSave();
});
onResume(() => { render.resetCamera(); });

// ------------------------------------------------------------------ screens & navigation
export function go(phase: Phase): void {
  app.phase = phase;
  ui.setFocus(null);
}
export function showTitle(): void {
  app.paused = false;
  audio.stopMusic();
  audio.stopAmbience();
  render.clearSelection();
  render.setCursor(null);
  if (app.session && app.phase !== "game") render.setTheme(app.settings.theme);
  go("title");
}

export function startGame(def: Def, opts: { humanSeats?: number[] } = {}): void {
  const s = new Session(def, opts);
  s.start(null);
  launchSession(s, "fresh");
}
export function resumeSnapshot(): void {
  const snap = platform.storeGet<Snapshot | null>("snapshot", null);
  if (!snap?.def || !snap?.cfg || !Array.isArray(snap.log)) { toast(t("toast.noSaved")); return; }
  const s = new Session(snap.def, { humanSeats: [0], thinkingMs: snap.thinkingMs || 0 });
  s.start(snap);
  if (s.log.length !== snap.log.length) { toast(t("toast.damaged")); s.log = []; }
  launchSession(s, "resumed");
}
export function savedSnapshot(): Snapshot | null {
  const snap = platform.storeGet<Snapshot | null>("snapshot", null);
  return snap?.def && snap?.cfg && Array.isArray(snap.log) ? snap : null;
}

function launchSession(s: Session, how: string): void {
  if (app.session && app.session !== s) app.session.pause();
  app.session = s;
  app.selection = null;
  app.cursor = null;
  app.paused = false;
  app.resultsPending = false;
  app.lbLine = null;
  platform.funnel("start", `${s.def.kind}:${how}`);
  render.setTheme(s.def.theme || app.settings.theme);
  go("game");
  render.introCamera();
  audio.playEvent("tableOpen");
  audio.startAmbience(s.def.theme || app.settings.theme);
  audio.startMusic(s.cfg.seed);
  s.lastEvents = [];
  updateAfterStateChange();
  if (!s.over) announce(t("an.start", { name: defName(s.def), who: s.isHumanTurn() ? t("an.yourTurn") : t("an.rivalBegins") }));
}

export function startDaily(): void { startGame(Content.dailyForDate(Content.todayUTC()) as Def, { humanSeats: [0] }); }
export function playNow(): void { startGame(Content.practiceDef("steady", "duel") as Def, { humanSeats: [0] }); }

// ------------------------------------------------------------------ commands and state changes
export function doCommand(cmd: Cmd): void {
  const s = app.session;
  if (!s || s.over) return;
  const r = s.dispatch(cmd);
  if (r.ok) {
    audio.playEvent("ack");
    updateAfterStateChange();
  }
}

/** Central post-change refresh: board, announcements, sounds, AI, results. */
export function updateAfterStateChange(): void {
  const s = app.session;
  if (!s) return;
  const events = s.lastEvents || [];
  s.lastEvents = [];
  render.sync(s.state, events);
  clearSelectionUI();
  announceEvents(events);
  for (const ev of events) playEventSound(ev);
  if (s.over) {
    render.settle();
    if (!app.resultsPending) {
      app.resultsPending = true;
      setTimeout(() => { if (app.session === s) showResults(); }, reducedMotion() ? 250 : 1100);
    }
  } else s.scheduleAI();
}

function playEventSound(ev: Ev): void {
  switch (ev.type) {
    case "roll": audio.playEvent(ev.dice![0] === ev.dice![1] ? "doubles" : "roll"); break;
    case "move": audio.playEvent(ev.hit ? "hit" : ev.from === "rail" ? "enter" : "move"); if (ev.hit) haptic(40); break;
    case "hit": audio.playEvent("hit"); haptic(40); break;
    case "bearOff": audio.playEvent("bearOff"); break;
    case "double": audio.playEvent("double"); break;
    case "accept": audio.playEvent("accept"); break;
    case "decline": audio.playEvent("decline"); break;
    case "noMoves": audio.playEvent("noMoves"); break;
    case "turn": audio.playEvent("turn"); break;
    case "invalid": audio.playEvent("invalid"); break;
  }
}

function announceEvents(events: Ev[]): void {
  for (const ev of events) {
    const who = ev.player != null ? seatName(ev.player) : "";
    switch (ev.type) {
      case "roll": announce(t(ev.dice![0] === ev.dice![1] ? "ev.rollDoubles" : "ev.roll", { who, a: ev.dice![0]!, b: ev.dice![1]! })); break;
      case "move":
        if (ev.to === "off") announce(t("ev.bearOff", { who, n: (ev.from as number) + 1 }));
        else if (ev.hit) announce(t("ev.hit", { who, n: (ev.to as number) + 1 }), true);
        break;
      case "noMoves": announce(t("ev.noMoves", { who }), true); break;
      case "pass": announce(t("ev.pass", { who })); break;
      case "double": announce(t("ev.double", { who, n: ev.value! }), true); break;
      case "accept": announce(t("ev.accept", { who, n: ev.value! })); break;
      case "decline": announce(t("ev.decline", { who })); break;
      case "concede": announce(t("ev.concede", { who })); break;
      case "gameOver": announce(t(ev.result!.points === 1 ? "ev.gameOver1" : "ev.gameOverN", { who: seatName(ev.result!.winner), n: ev.result!.points }), true); break;
    }
  }
}

/** What the human may do now (the tray's enabled buttons). */
export function legalNow(): { roll: boolean; double: boolean; pass: boolean; undo: boolean; hint: boolean } {
  const s = app.session;
  if (!s || app.phase !== "game" || app.paused) return { roll: false, double: false, pass: false, undo: false, hint: false };
  const human = s.isHumanTurn();
  const acts = human ? (Rules.legalActions(s.state) as { type: string }[]) : [];
  const can = (type: string): boolean => acts.some((a) => a.type === type);
  return { roll: can("roll"), double: can("double"), pass: can("pass"), undo: s.canUndo(), hint: !!(s.def.mechanics?.hint && human) };
}
export function roll(): void { const s = app.session; if (s?.isHumanTurn() && legalNow().roll) doCommand({ type: "roll", player: s.state.active }); }
export function offerStakes(): void { const s = app.session; if (s?.isHumanTurn() && legalNow().double) doCommand({ type: "double", player: s.state.active }); }
export function pass(): void { const s = app.session; if (s?.isHumanTurn() && Rules.canPass(s.state)) doCommand({ type: "pass", player: s.state.active }); }
export function hint(): void { if (legalNow().hint) app.session?.hint(); }
export function skipAnim(): void { render.settle(); announce(t("an.settled")); }
export function answerCube(accept: boolean): void {
  const st = app.session?.state;
  if (!st?.cube?.pending) return;
  const responder = (st.cube.pending.by + 1) % st.cfg.players;
  doCommand({ type: accept ? "accept" : "decline", player: responder });
}
export function undoMove(): void {
  const s = app.session;
  if (!s?.canUndo()) return;
  if (s.undo()) {
    audio.playEvent("undo");
    s.lastEvents = [];
    updateAfterStateChange();
    announce(t("an.undone"));
    toast(t("toast.undone"));
  }
}
export function cubeOpen(): boolean {
  const s = app.session;
  return !!s && app.phase === "game" && !app.paused && s.state.phase === "cube" && s.isHumanTurn() && !s.over;
}

// ------------------------------------------------------------------ selection
export function legalOrigins(): (number | "rail")[] {
  const s = app.session;
  if (!s || !s.isHumanTurn() || s.state.phase !== "move") return [];
  const seen = new Set<number | "rail">();
  for (const m of Rules.legalMoves(s.state) as Move[]) seen.add(m.from);
  return [...seen];
}
function clearSelectionUI(): void { app.selection = null; render.clearSelection(); }

function selectOrigin(from: number | "rail"): void {
  const s = app.session!;
  const moves = (Rules.legalMoves(s.state) as Move[]).filter((m) => m.from === from);
  if (!moves.length) return;
  app.selection = { from, moves };
  audio.playEvent("select");
  const st = s.state;
  const origin = from === "rail" ? { x: 0, z: 0 } : (() => { const p = render.pointPos(from); return { x: p.x, z: p.z }; })();
  const uniq = new Map<string, render.Spot>();
  for (const m of moves) {
    if (uniq.has(String(m.to))) { if (m.hit) uniq.get(String(m.to))!.hit = true; continue; }
    if (m.to === "off") { const o = render.offPos(st.cfg.players, st.active, st.off[st.active]); uniq.set("off", { x: o.x, z: o.z }); }
    else { const p = render.pointPos(m.to); uniq.set(String(m.to), { x: p.x, z: p.z, hit: !!m.hit }); }
  }
  render.setSelection(origin, [...uniq.values()]);
  const names = [...uniq.keys()].map((k) => (k === "off" ? t("sel.bearOff") : t("place.point", { n: Number(k) + 1 }))).join(", ");
  announce(t("sel.announce", { origin: from === "rail" ? t("sel.rail") : t("place.point", { n: from + 1 }), targets: names }));
}

function commitMove(to: number | "off"): void {
  const sel = app.selection;
  if (!sel || !app.session) return;
  const matches = sel.moves.filter((m) => m.to === to);
  if (!matches.length) return;
  // Prefer a hitting move, then the larger die, when both dice reach the spot.
  matches.sort((a, b) => (Number(!!b.hit) - Number(!!a.hit)) || (b.die - a.die));
  const m = matches[0]!;
  clearSelectionUI();
  doCommand({ type: "move", player: app.session.state.active, from: m.from, to: m.to, die: m.die });
}

function explainInvalid(pick: render.Pick): void {
  const s = app.session!;
  const st = s.state;
  let reason = t("why.nothing");
  if (st.phase === "roll") reason = t("why.roll");
  else if (!s.isHumanTurn()) reason = t("why.wait");
  else if (st.phase === "move") {
    if (st.rail[st.active] > 0 && pick?.kind === "point") reason = t("why.rail");
    else if (pick?.kind === "point") {
      const cell = st.points[pick.point];
      reason = cell.owner !== st.active || cell.count === 0 ? t("why.noMarker") : t("why.noDie");
    } else if (pick?.kind === "off") reason = t("why.off");
  }
  audio.playEvent("invalid");
  toast(reason);
  announce(t("why.announce", { reason }));
}

export function handlePick(pick: render.Pick): void {
  const s = app.session;
  if (!s || s.over || app.phase !== "game" || app.paused || cubeOpen()) return;
  if (!pick) { clearSelectionUI(); return; }
  const st = s.state;
  if (!s.isHumanTurn() || st.phase === "roll") { explainInvalid(pick); return; }
  if (st.phase !== "move") return;
  if (app.selection) {
    // A pick on a highlighted target commits; another origin reselects.
    const target = pick.kind === "off" ? "off" : pick.kind === "point" ? pick.point : null;
    if (target != null && app.selection.moves.some((m) => m.to === target)) { commitMove(target); return; }
  }
  if (pick.kind === "rail" && st.rail[st.active] > 0 && legalOrigins().includes("rail")) { selectOrigin("rail"); return; }
  if (pick.kind === "point" && legalOrigins().includes(pick.point)) { selectOrigin(pick.point); return; }
  explainInvalid(pick);
}

// ------------------------------------------------------------------ the board cursor (the browser build's board mirror)
const CURSOR_SPOTS = Rules.POINTS + 2;
function cursorPick(i: number): render.Pick {
  return i < Rules.POINTS ? { kind: "point", point: i } : i === Rules.POINTS ? { kind: "rail" } : { kind: "off" };
}
/** The mirror button's text for a board spot ("Point 6: 5 of You, distance 18 for you"). */
export function spotLabel(i: number): string {
  const st = app.session!.state;
  if (i < Rules.POINTS) {
    const cell = st.points[i];
    const owner = cell.owner < 0 ? t("mirror.empty")
      : cell.owner === 0 ? t("mirror.mine", { n: cell.count }) : t("mirror.owner", { n: cell.count, who: seatName(cell.owner) });
    const d = Rules.distanceOf(st.cfg.ruleset, st.cfg.players, 0, i);
    return t("mirror.point", { n: i + 1, owner, d });
  }
  if (i === Rules.POINTS) return t("mirror.rail", { mine: st.rail[0], rival: st.rail.slice(1).reduce((a: number, n: number) => a + n, 0) });
  return t("mirror.off", { n: st.off[0] });
}
function moveCursor(dir: number): void {
  const s = app.session;
  if (!s) return;
  ui.setFocus(null);
  app.cursor = app.cursor == null ? (dir > 0 ? 0 : CURSOR_SPOTS - 1) : (app.cursor + dir + CURSOR_SPOTS) % CURSOR_SPOTS;
  showCursor();
  audio.playEvent("tick");
  announce(spotLabel(app.cursor));
}
function showCursor(): void {
  const s = app.session;
  if (app.cursor == null || !s || app.phase !== "game") { render.setCursor(null); return; }
  const i = app.cursor;
  if (i < Rules.POINTS) { const p = render.pointPos(i); render.setCursor({ x: p.x, z: p.z }); }
  else if (i === Rules.POINTS) render.setCursor({ x: 0, z: 0 });
  else { const o = render.offPos(s.state.cfg.players, 0, 0); render.setCursor({ x: o.x, z: o.z }); }
}

// ------------------------------------------------------------------ pause, leave, restart
export function pauseGame(): void {
  const s = app.session;
  if (!s || s.over || app.phase !== "game" || app.paused) return;
  s.pause();
  app.paused = true;
  app.pausedAt = frame().frame;
  audio.stopAmbience();
  announce(t("an.paused"));
}
export function resumeGame(): void {
  const s = app.session;
  if (!s || !app.paused) return;
  app.paused = false;
  go("game");
  s.resume();
  audio.startAmbience(s.def.theme || app.settings.theme);
  announce(t("an.resumed"));
}
export function restartTable(): void {
  const s = app.session;
  if (!s) return;
  s.pause();
  s.clearPersisted();
  platform.funnel("retry", s.def.kind);
  startGame(s.def, { humanSeats: [...s.humanSeats] });
  toast(t("toast.restarted"));
}
export function leaveTable(): void {
  const s = app.session;
  if (s && !s.over) { s.pause(); s.persistSnapshot(); }
  platform.funnel("quit", s?.def.kind || "");
  app.session = null;
  showTitle();
  render.setTheme(app.settings.theme);
}
export function finishLesson(): void {
  const s = app.session;
  if (!s) return;
  if (s.def.kind === "learn") {
    const p = platform.getProgress();
    p.lessons[s.def.id] = { done: true };
    platform.saveProgress(p);
    toast(t("toast.lessonDone"));
  }
  s.pause();
  app.session = null;
  showTitle();
  go("learn");
}
/** Settings or help from the pause card: back to it. */
export function openFromPause(phase: "settings" | "help"): void { app.returnTo = "pause"; go(phase); }
export function openFromTitle(phase: "settings" | "help"): void { app.returnTo = "title"; go(phase); }
export function closeSubscreen(): void {
  if (app.returnTo === "pause" && app.session && !app.session.over) { go("game"); app.paused = true; app.pausedAt = frame().frame; }
  else showTitle();
}

// ------------------------------------------------------------------ results
export function showResults(): void {
  const s = app.session;
  if (!s?.result) return;
  render.setCursor(null);
  go("results");
  const won = s.goalReport!.won;
  audio.playEvent(won ? "win" : "lose");
  const stars = s.def.kind === "journey" ? starsFor(s.def, s.goalReport!, s.state, s.thinkingMs) : 0;
  if (stars > 0) setTimeout(() => audio.playEvent("stars"), reducedMotion() ? 300 : 900);
  // Signed-in solo games (not lessons) post seat 0's match points (0 for a
  // loss) to the high-score board once; the results line shows the rank.
  if (platform.signedIn() && s.def.kind !== "learn" && s.humanSeats.size === 1 && !s.lbPost) {
    s.lbPost = platform.submitScore(s.result.winner === 0 ? s.result.points : 0);
    s.lbPost.then((r) => { s.lbResult = r; }, () => { s.lbResult = { posted: false, rank: null }; });
  }
}
export function retry(): void {
  const s = app.session;
  if (!s) return;
  platform.funnel("retry", s.def.kind);
  const def = s.def;
  const fresh = def.kind === "practice" ? (Content.practiceDef as (d: string, r: string, s: number | null, p: number) => Def)(def.ai?.difficulty || "steady", def.ruleset, null, def.players) : def;
  if (fresh.kind === "practice") fresh.theme = def.theme;
  startGame(fresh, { humanSeats: [...s.humanSeats] });
}
export function nextContent(): Def | null {
  const def = app.session?.def;
  if (!def) return null;
  const list = (def.kind === "journey" ? Content.JOURNEY : def.kind === "learn" ? Content.LESSONS : null) as Def[] | null;
  if (!list) return null;
  const idx = list.findIndex((j) => j.id === def.id);
  return idx >= 0 && idx < list.length - 1 ? list[idx + 1]! : null;
}
export function copyReplay(): void {
  const s = app.session;
  if (!s) return;
  const env = s.replayEnvelope();
  try { clipboard.writeText(JSON.stringify(env)); toast(t("toast.replayCopied")); }
  catch { toast(t("toast.replayHash", { h: String(env.finalHash) })); }
}
export function copyInvite(): void {
  const link = platform.inviteLink();
  if (!link) return;
  try { clipboard.writeText(link); toast(t("acc.inviteCopied")); }
  catch { toast(`${t("acc.inviteFailed")} ${link}`, 6000); }
}

// ------------------------------------------------------------------ settings
export function setSetting<K extends keyof platform.Settings>(key: K, value: platform.Settings[K]): void {
  app.settings = { ...app.settings, [key]: value };
  platform.saveSetting(key, value);
  if (key === "theme" && !app.session) render.setTheme(String(value));
  platform.funnel("settings_change", key);
}
export function resetTutorials(): void {
  const p = platform.getProgress();
  p.lessons = {};
  platform.saveProgress(p);
  toast(t("toast.tutReset"));
}
export function wipeProgress(): void {
  platform.saveProgress(platform.emptyProgress());
  platform.storeRemove("snapshot");
  toast(t("toast.wiped"));
}

// ------------------------------------------------------------------ input
function gameInput(): boolean {
  return app.phase === "game" && !!app.session && !app.paused && !ui.capturingKeys();
}
onAction((e) => {
  if (!e.pressed) return;
  if (ui.capturingKeys()) return;
  const s = app.session;
  if (app.phase === "game" && s && !s.over) {
    if (e.action === "pause") {
      // The pause card closes itself on the Escape / East that is not its opening one.
      if (!app.paused) pauseGame();
      return;
    }
    if (!gameInput() || cubeOpen()) return;
    switch (e.action) {
      case "roll": roll(); break;
      case "undo": undoMove(); break;
      case "hint": hint(); break;
      case "camera": render.resetCamera(); announce(t("an.camera")); break;
      case "next": moveCursor(1); break;
      case "prev": moveCursor(-1); break;
      // Enter / Space / South on a focused widget is the widget's.
      case "confirm":
        if (ui.focused()) break;
        if (app.cursor != null) handlePick(cursorPick(app.cursor));
        else if (e.source === "gamepad") roll();
        break;
      case "cancel": if (app.selection) { clearSelectionUI(); announce(t("an.cleared")); } break;
    }
  }
});

// Pointer and touch: a tap (short, < 12 px) picks; a press-and-drag from an
// origin commits on release over a target. A press right after a touch is
// the same tap reported twice and is skipped.
let drag: { x0: number; y0: number; t0: number; pick: render.Pick; moved: boolean } | null = null;
let lastTouch = -1e9;
function pressAt(x: number, y: number): void {
  if (!gameInput() || ui.pointerOver()) { drag = null; return; }
  drag = { x0: x, y0: y, t0: nowMs(), pick: render.pick(x, y), moved: false };
}
function moveTo(x: number, y: number): void {
  if (drag && Math.hypot(x - drag.x0, y - drag.y0) > 12 * frame().scale) drag.moved = true;
}
function releaseAt(x: number, y: number): void {
  const d = drag;
  drag = null;
  if (!d || !gameInput()) return;
  const dt = nowMs() - d.t0;
  const dist = Math.hypot(x - d.x0, y - d.y0);
  if (dist < 12 * frame().scale && dt < 600) { app.cursor = null; render.setCursor(null); handlePick(d.pick); return; }
  if (!d.moved || !d.pick || d.pick.kind === "off") return;
  const from = d.pick.kind === "rail" ? "rail" : d.pick.point;
  if (!app.selection || app.selection.from !== from) {
    if (legalOrigins().includes(from)) selectOrigin(from);
  }
  if (app.selection) {
    const over = render.pick(x, y);
    const target = over?.kind === "off" ? "off" : over?.kind === "point" ? over.point : null;
    if (target != null && app.selection.moves.some((m) => m.to === target)) commitMove(target);
    else if (!app.settings.toggleSelect) clearSelectionUI();
  }
}
onPointerButton((e) => {
  if (e.button !== 0 || nowMs() - lastTouch < 600) return;
  if (e.pressed) pressAt(e.x, e.y); else releaseAt(e.x, e.y);
});
onPointerMove((x, y) => { if (nowMs() - lastTouch >= 600) moveTo(x, y); });
onTouch((e) => {
  if (!e.primary) return;
  lastTouch = nowMs();
  if (e.phase === "start") pressAt(e.x, e.y);
  else if (e.phase === "move") moveTo(e.x, e.y);
  else if (e.phase === "end") releaseAt(e.x, e.y);
  else drag = null;
});

// ------------------------------------------------------------------ frame
onUpdate((dt) => {
  applyLook();
  audio.poll();
  render.update(dt);
  showCursor();
  if (app.toast && nowMs() > app.toast.until) app.toast = null;
});
onRender(() => { drawScreens(); });
