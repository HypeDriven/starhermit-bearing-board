// The browser build's DOM shell (index.html + css/main.css + the screens
// js/main.js built) as starhermit:ui, built every frame: the HUD strip
// (objective, turn indicator, dice, Pause), the Objective / Progress rail,
// the Table rail with the players, the action tray, the lesson card, the
// stakes and pause dialogs, toasts, and the full-window screens (title,
// Journey, Learn, Challenges, Practice setup, results, settings, help) over
// the faint board. The browser's media queries are the layouts below, picked
// by the window's logical size: desktop (≥ 1024: both rails), tablet
// (768–1023: narrower rails), portrait (< 768: no rails, the objective on its
// own line, smaller dice, a full-width tray) and short landscape (height
// ≤ 500: only the Table rail, the tray beside it). The board is framed in
// what the HUD leaves (render.frameBoard), as the browser build fitted it to
// its safe rectangle.
import { frame, openMenu } from "starhermit:engine";
import { bindingLabel } from "starhermit:input";
import { requestSignIn } from "starhermit:platform";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import * as Rules from "../js/rules.js";
import * as Content from "../js/content.js";
import * as AI from "../js/ai.js";
import * as render from "./render.ts";
import * as platform from "./platform.ts";
import { plain, t } from "./i18n.ts";
import { achDesc, achLabel, aiLabel, defBlurb, defName, fmtClock, rulesetLabel, starsText, themeLabel, type Def } from "./names.ts";
import {
  answerCube, app, closeSubscreen, copyInvite, copyReplay, cubeOpen, finishLesson, go, hint, leaveTable, legalNow,
  masteryTitle, nextContent, offerStakes, openFromPause, openFromTitle, pass, pauseGame, playNow, profileName, restartTable,
  resetTutorials, resumeGame, resumeSnapshot, retry, roll, savedSnapshot, seatColor, seatName, setSetting, showTitle,
  skipAnim, startDaily, startGame, starsFor, undoMove, wipeProgress,
} from "./main.ts";

/** Runs `fn` once this frame's UI is built (for actions that end the table being drawn). */
function later(fn: () => void): void { queueMicrotask(fn); }

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; mode: "desktop" | "tablet" | "portrait" | "short"; railW: number }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = (f.width - sa.left - sa.right) / sc, lh = (f.height - sa.top - sa.bottom) / sc;
  const short = lh <= 500 && lw > lh;
  const mode = short ? "short" : lw >= 1024 ? "desktop" : lw >= 768 ? "tablet" : "portrait";
  return { lw, lh, sc, mode, railW: mode === "desktop" ? 240 : mode === "tablet" ? 200 : 176 };
}
const GAP = 8;

/** Button rows that wrap as the browser's flex-wrap did; `fill` stretches each row's buttons. */
function flow(id: string, items: { label: string; w?: number; build: (w: number | undefined) => void }[], width: number, opts: { fill?: boolean; justify?: ui.Layout["justify"] } = {}): ui.Rect {
  const L = layoutNow();
  const rows: (typeof items)[] = [[]];
  let used = 0;
  for (const it of items) {
    const w = it.w ?? ui.measureText(it.label, { kind: "button", style: "btn" }).width / L.sc + 2;
    if (used > 0 && used + GAP + w > width) { rows.push([]); used = 0; }
    rows[rows.length - 1]!.push({ ...it, w });
    used += (used > 0 ? GAP : 0) + w;
  }
  return ui.column(id, () => {
    rows.forEach((row, n) => {
      // Stretched rows share the width equally when every button fits its share, else by their widths.
      const share = (width - GAP * (row.length - 1)) / row.length;
      const used = row.reduce((a, it) => a + it.w!, 0) + GAP * (row.length - 1);
      const each = (it: { w?: number }): number | undefined => (!opts.fill ? undefined : row.every((r) => r.w! <= share) ? share : it.w! + (width - used) / row.length);
      ui.row(`${id}-${n}`, () => { for (const it of row) it.build(each(it)); }, { spacing: GAP, justify: opts.justify ?? "center", width });
    });
  }, { spacing: GAP, width });
}
function btn(label: string, id: string, cls: (string | false | undefined)[] = [], opts: ui.ButtonOptions = {}, width?: number): boolean {
  const styles: (string | ui.Style)[] = ["btn", ...cls.filter((c): c is string => !!c)];
  if (width) styles.push({ width });
  return ui.style(...styles).id(id).button(label, opts);
}

/** A modal card (the browser's .bb-modal veil + .bb-card); `back` runs on
 * Escape / East (not on the frame it opened). */
const openedAt = new Map<string, number>();
function card(key: string, title: string, L: Layout, build: (inner: number) => void, back?: () => void): void {
  const f = frame();
  if (!openedAt.has(key)) openedAt.set(key, f.frame);
  const w = Math.min(416, L.lw * 0.92);
  const inner = w - 48;
  const open = ui.dialog(key, title, true, () => {
    ui.column(`${key}-body`, () => build(inner), { width: inner, spacing: 10, align: "stretch" });
  });
  if (!open && back && openedAt.get(key) !== f.frame) back();
}
function closedCards(keep: string[]): void { for (const k of [...openedAt.keys()]) if (!keep.includes(k)) openedAt.delete(k); }

// ------------------------------------------------------------------ entry
export function drawScreens(): void {
  const L = layoutNow();
  if (app.phase === "game" && app.session) drawGame(L);
  else {
    closedCards([]);
    const f = frame();
    if (f.width > 2 && f.height > 2) render.frameBoard({ x: 0, y: 0, w: f.width, h: f.height }, f.width, f.height);
    drawPage(L);
  }
  if (app.toast) {
    const top = 64;
    ui.place("toast", { anchor: "top", x: 0, y: top }, () => {
      ui.style("toast").paragraph(app.toast!.text, Math.min(34 * 16, L.lw * 0.92) - 34);
    });
  }
}

// ------------------------------------------------------------------ the table HUD
function objectiveText(): string {
  const s = app.session!, st = s.state, def = s.def;
  const goals = (def.goals || {}) as Record<string, number | boolean>;
  const bits: string[] = [];
  if (goals.maxTurns) bits.push(t("hud.goalTurns", { n: Number(goals.maxTurns), cur: st.turnNum }));
  if (goals.minHits) bits.push(t("hud.goalHits", { n: Number(goals.minHits) }));
  if (goals.maxTimeSec) bits.push(t("hud.goalTime", { t: fmtClock(s.thinkingNow()), n: Math.round(Number(goals.maxTimeSec) * app.settings.timingAssist / 60) }));
  const moveLimit = (def.options as { moveLimit?: number } | undefined)?.moveLimit;
  if (moveLimit) bits.push(t("hud.moveLimit", { n: moveLimit }));
  return t("hud.objective", { name: defName(def) }) + (bits.length ? " · " + bits.join(" · ") : "");
}
function turnText(): string {
  const s = app.session!, st = s.state;
  if (s.over) return t("turn.over");
  if (st.phase === "cube") return t("turn.answers", { who: seatName((st.cube.pending.by + 1) % st.cfg.players) });
  return st.phase === "roll" ? t("turn.roll", { who: seatName(st.active) }) : t("turn.move", { who: seatName(st.active) });
}

function dice(small: boolean): void {
  const st = app.session!.state;
  ui.row("dice", () => {
    if (!st.dice.length) { ui.style("dice-none").label(t("dice.none")); return; }
    // Doubles grant four moves, so four dice show; a die is spent once movesLeft lacks it.
    const doubles = st.dice[0] === st.dice[1];
    const faces: number[] = doubles ? [st.dice[0], st.dice[0], st.dice[0], st.dice[0]] : st.dice.slice();
    const remaining: number[] = st.movesLeft.slice();
    faces.forEach((d, i) => {
      const at = remaining.indexOf(d);
      const used = at < 0;
      if (!used) remaining.splice(at, 1);
      const size = small ? 30 : 36;
      ui.id(`die-${i}`).widget(t(used ? "die.used" : "die.aria", { n: d }), {
        role: "image", size: { width: size, height: size },
        draw: (r, s) => {
          const k = s.scale;
          const alpha = used ? 0.35 : 1;
          const face = s.highContrast ? s.colors.background : `rgba(242,234,214,${alpha})`;
          const ink = s.highContrast ? s.colors.text : `rgba(42,28,16,${alpha})`;
          if (doubles && !used) draw.roundRect(r.x - 3 * k, r.y - 3 * k, r.width + 6 * k, r.height + 6 * k, 10 * k, "#d8b25c");
          draw.roundRect(r.x, r.y, r.width, r.height, 8 * k, face);
          draw.rect(r.x + 2 * k, r.y + r.height - 3 * k, r.width - 4 * k, 3 * k, [0, 0, 0, 0.25 * alpha]);
          draw.text(String(d), r.x + r.width / 2, r.y + r.height / 2 - (small ? 10 : 13) * k, { size: (small ? 17 : 21.6) * k, color: ink, align: "center", weight: "800" });
        },
      });
    });
  }, { style: "dice-tray", spacing: 6, align: "center" });
}

function hudTop(L: Layout): ui.Rect {
  const width = L.lw - 24;
  const pauseW = 52;
  const diceW = ((): number => {
    const st = app.session!.state;
    if (!st.dice.length) return ui.measureText(t("dice.none"), { style: "dice-none" }).width / L.sc + 16;
    const n = st.dice[0] === st.dice[1] ? 4 : st.dice.length;
    return n * ((L.mode === "portrait" ? 30 : 36) + 6) + 10;
  })();
  const turn = turnText();
  const turnW = ui.measureText(turn, { style: ["hud-chip", "turn"] }).width / L.sc + 4;
  const objText = objectiveText();
  const objNatural = ui.measureText(objText, { style: ["hud-chip", "objective"] }).width / L.sc + 4;
  const rest = turnW + diceW + pauseW + GAP * 3;
  // The objective takes what is left (at most 70ch); on a phone it gets its own line.
  const ownLine = L.mode === "portrait" || width - rest < 220;
  const objW = ownLine ? width : Math.min(objNatural, width - rest, 70 * 8);
  const small = L.mode === "portrait";
  return ui.place("hud", { anchor: "top-start", x: 12, y: 8 }, () => {
    const objective = (): void => {
      ui.column("objective", () => {
        ui.style(small ? "objective-small" : "objective").paragraph(objText, objW - 30);
      }, { style: "hud-chip", width: objW });
    };
    const others = (): void => {
      ui.column("turn", () => { ui.style("turn").label(turn); }, { style: "hud-chip" });
      dice(small);
      if (btn("II", "btn-pause", ["btn-icon"], { tooltip: t("hud.pause") })) pauseGame();
    };
    if (ownLine) {
      objective();
      ui.row("hud-row", others, { spacing: GAP, align: "center", width, justify: "end" });
    } else {
      ui.row("hud-row", () => { objective(); ui.spacer(); others(); }, { spacing: GAP, align: "center", width });
    }
  }, { spacing: GAP, width });
}

function railLeft(L: Layout, x: number, y: number, w: number, h: number, side: "start" | "end"): ui.Rect {
  const s = app.session!, st = s.state, def = s.def;
  const inner = w - 26;
  return ui.place("rail-left", { anchor: side === "start" ? "top-start" : "top-end", x, y }, () => {
    ui.style("rail-title").label(t("rail.objective"));
    ui.style("rail-text").paragraph(defBlurb(def) || defName(def), inner);
    const badges: [string, boolean][] = [[rulesetLabel(st.cfg.ruleset), false], [t("badge.seats", { n: st.cfg.players }), false],
      [def.ranked ? t("badge.ranked") : t("badge.unranked"), !!def.ranked]];
    if ((def.options as { cube?: boolean } | undefined)?.cube) badges.push([t("badge.stakes", { n: st.cube.value }), false]);
    flow("badges", badges.map(([text, on], i) => ({
      label: text, w: ui.measureText(text, { style: "badge" }).width / L.sc + 2,
      build: () => { ui.id(`badge-${i}`).style("badge", on && "badge-on").label(text); },
    })), inner, { justify: "start" });
    ui.style("rail-title").label(t("rail.progress"));
    ui.style("pip").paragraph(t("progress.line", { turn: st.turnNum, hits: st.stats.hits[0], off: st.off[0], total: (Rules.RULESETS as Record<string, { markers: number }>)[st.cfg.ruleset]!.markers }), inner);
  }, { style: "rail", width: w, height: h, spacing: 6 });
}

function railRight(_L: Layout, x: number, y: number, w: number, h: number, side: "start" | "end"): ui.Rect {
  const s = app.session!, st = s.state;
  const inner = w - 26;
  return ui.place("rail-right", { anchor: side === "end" ? "top-end" : "top-start", x, y }, () => {
    ui.style("rail-title").label(t("rail.table"));
    ui.style("rail-text").paragraph(t("status.local"), inner);
    ui.style("pip").paragraph(t("status.seed", { seed: st.cfg.seed, v: Rules.RULES_VERSION }), inner);
    for (let p = 0; p < st.cfg.players; p++) {
      const active = p === st.active && !s.over;
      ui.column(`player-${p}`, () => {
        ui.row(`player-${p}-name`, () => {
          const color = seatColor(p);
          ui.id(`swatch-${p}`).widget("", {
            role: "none", size: { width: 15, height: 15 },
            draw: (r, ws) => {
              const k = ws.scale;
              draw.roundRect(r.x, r.y, r.width, r.height, r.width / 2, "rgba(255,255,255,0.55)");
              draw.roundRect(r.x + 2 * k, r.y + 2 * k, r.width - 4 * k, r.height - 4 * k, r.width / 2 - 2 * k, color);
            },
          });
          ui.label(seatName(p) + (st.alive[p] ? "" : t("player.out")), { weight: active ? "700" : "normal" });
        }, { spacing: 8, align: "center" });
        ui.style("pip").label(t("player.stats", { off: st.off[p], rail: st.rail[p], pips: Rules.pipCount(st, p) }));
      }, { style: ["player-row", ...(active ? ["player-row-active"] : [])], width: inner, spacing: 2 });
    }
  }, { style: "rail", width: w, height: h, spacing: 6 });
}

function tray(L: Layout, anchor: ui.Anchor, x: number, y: number, maxW: number): ui.Rect {
  const legal = legalNow();
  const s = app.session!;
  const items: { label: string; id: string; on: boolean; fn: () => void; primary?: boolean }[] = [
    { label: t("btn.roll"), id: "btn-roll", on: legal.roll, fn: roll, primary: true },
    { label: t("btn.double"), id: "btn-double", on: legal.double, fn: offerStakes },
    { label: t("btn.pass"), id: "btn-pass", on: legal.pass, fn: pass },
    { label: t("btn.undo"), id: "btn-undo", on: legal.undo, fn: undoMove },
    { label: t("btn.hint"), id: "btn-hint", on: legal.hint, fn: hint },
    { label: t("btn.skip"), id: "btn-skip", on: !s.over, fn: skipAnim },
  ];
  const inner = maxW - 18;
  const narrow = L.mode === "portrait";
  return ui.place("tray", { anchor, x, y }, () => {
    flow("tray-flow", items.map((it) => ({
      label: it.label,
      build: (w) => { if (btn(it.label, it.id, [it.primary && "btn-primary", L.mode === "short" && "btn-compact"], { disabled: !it.on }, w)) { it.fn(); ui.setFocus(null); } },
    })), inner, { fill: narrow });
  }, { style: "tray" });
}

function trayWidth(L: Layout, avail: number): number {
  if (L.mode === "portrait") return avail;
  const labels = ["btn.roll", "btn.double", "btn.pass", "btn.undo", "btn.hint", "btn.skip"].map((k) => t(k));
  const total = labels.reduce((a, l) => a + ui.measureText(l, { kind: "button", style: "btn" }).width / L.sc + 2, 0) + GAP * 5 + 18;
  return Math.min(avail, 736, total);
}

function tutorialCard(L: Layout, anchor: ui.Anchor, x: number, y: number, w: number): ui.Rect | null {
  const s = app.session!;
  const tut = s.tutorial;
  if (!tut || tut.done || s.over) return null;
  const step = s.def.tutorial!.steps[tut.step];
  if (!step) return null;
  const times = step.times ? ` (${Math.min(tut.count + 1, step.times)}/${step.times})` : "";
  const text = t(`ls.${s.def.id}.${tut.step}`, null, step.text) + times;
  const label = t("btn.finishLesson");
  const bw = ui.measureText(label, { kind: "button", style: "btn" }).width / L.sc + 2;
  const stacked = L.mode === "short" || w - bw - 40 < 180;
  const textW = stacked ? w - 30 : w - bw - 46;
  return ui.place("tutorial", { anchor, x, y }, () => {
    const body = (): void => {
      ui.paragraph(text, textW);
      if (btn(label, "btn-lesson-done")) later(finishLesson);
    };
    if (stacked) ui.column("tutorial-col", body, { spacing: 8, align: "stretch" });
    else ui.row("tutorial-row", body, { spacing: 12, align: "center" });
  }, { style: "tutorial", width: w });
}

function drawGame(L: Layout): void {
  const s = app.session!;
  const f = frame();
  const sc = L.sc, sa = f.safeArea;
  const lefty = app.settings.leftHanded;
  const top = hudTop(L);
  const topH = (top.y + top.height - sa.top) / sc + 8;
  let trayRect: ui.Rect, tutRect: ui.Rect | null = null;
  const rails: ui.Rect[] = [];
  if (L.mode === "short") {
    // Landscape phone: only the Table rail (or the lesson card in its place), the tray beside it.
    const w = L.railW;
    const tut = tutorialCard(L, lefty ? "top-start" : "top-end", 12, topH, w);
    if (tut) rails.push(tut);
    else rails.push(railRight(L, 12, topH, w, Math.max(120, L.lh - topH - 8), lefty ? "start" : "end"));
    const tw = trayWidth(L, L.lw - w - 36);
    trayRect = tray(L, lefty ? "bottom-start" : "bottom-end", w + 24, 8, tw);
  } else {
    const avail = L.lw - 24;
    const tw = trayWidth(L, avail);
    trayRect = tray(L, lefty ? "bottom-start" : "bottom", lefty ? 12 : 0, 12, tw);
    const trayH = trayRect.height / sc + 12;
    tutRect = tutorialCard(L, "bottom", 0, trayH + 10, Math.min(544, L.lw * 0.92));
    if (L.mode !== "portrait") {
      const w = L.railW;
      const h = Math.max(120, (trayRect.y - sa.top) / sc - topH - 12);
      rails.push(railLeft(L, 12, topH, w, h, lefty ? "end" : "start"));
      rails.push(railRight(L, 12, topH, w, h, lefty ? "start" : "end"));
    }
  }
  // Dialogs over the table.
  if (cubeOpen()) {
    const st = s.state;
    card("cube", t("cube.title"), L, (inner) => {
      ui.paragraph(t("cube.text", { who: seatName(st.cube.pending.by), n: st.cube.pending.value }), inner);
      ui.row("cube-actions", () => {
        if (btn(t("btn.accept"), "btn-accept", ["btn-primary"])) answerCube(true);
        if (btn(t("btn.decline"), "btn-decline", ["btn-danger"])) answerCube(false);
      }, { spacing: 10, justify: "end", width: inner });
    }, pauseGame);
  }
  if (app.paused) {
    card("pause", t("pause.title"), L, (inner) => {
      const b = (label: string, id: string, cls: string[], fn: () => void): void => { if (btn(label, id, cls, {}, inner)) fn(); };
      b(t("btn.resume"), "btn-resume", ["btn-primary"], resumeGame);
      b(t("btn.restart"), "btn-restart", [], () => later(restartTable));
      b(t("btn.settings"), "btn-pause-settings", [], () => openFromPause("settings"));
      b(t("btn.help"), "btn-pause-help", [], () => openFromPause("help"));
      b(t("btn.leave"), "btn-leave", ["btn-danger"], () => later(leaveTable));
    }, () => { if (frame().frame !== app.pausedAt) resumeGame(); });
  }
  closedCards([...(cubeOpen() ? ["cube"] : []), ...(app.paused ? ["pause"] : [])]);
  // Frame the board in what the HUD leaves (the browser build's safe rectangle).
  const W = f.width, H = f.height;
  let x0 = sa.left, x1 = W - sa.right, y0 = top.y + top.height + 6 * sc, y1 = Math.min(trayRect.y, tutRect ? tutRect.y : H) - 6 * sc;
  for (const r of rails) {
    if (r.x + r.width / 2 < W / 2) x0 = Math.max(x0, r.x + r.width + 6 * sc);
    else x1 = Math.min(x1, r.x - 6 * sc);
  }
  if (x1 - x0 < W * 0.45) { x0 = 0; x1 = W; }
  if (y1 - y0 < 40 * sc) { y0 = 0; y1 = H; }
  if (W > 2 && H > 2) render.frameBoard({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, W, H);
}

// ------------------------------------------------------------------ full-window screens
/** A full-window screen (the browser's .bb-screen): the page scrolls, the
 * footer's buttons stay in view. */
const footH = new Map<string, number>();
function page(key: string, L: Layout, build: (inner: number) => void, footer?: (inner: number) => void): void {
  const inner = Math.min(960, L.lw - 32);
  const fh = footer ? (footH.get(key) ?? 60) : 0;
  ui.place(`page-${key}`, { anchor: "top-start", x: 0, y: 0 }, () => {
    ui.scrollArea(`${key}-scroll`, { width: L.lw, height: Math.max(80, L.lh - fh) }, () => {
      ui.row(`${key}-center`, () => {
        ui.column(`${key}-inner`, () => build(inner), { width: inner, spacing: 16, align: "stretch" });
      }, { width: L.lw - 2, justify: "center", padding: { top: 16, bottom: 16 } });
    });
    if (footer) {
      const r = ui.row(`${key}-foot`, () => {
        ui.column(`${key}-foot-inner`, () => footer(inner), { width: inner, align: "stretch" });
      }, { width: L.lw, justify: "center", padding: { top: 8, bottom: 12 } });
      footH.set(key, r.height / L.sc);
    }
  }, { style: "screen", width: L.lw, height: L.lh });
}
function section(id: string, inner: number, build: (w: number) => void): void {
  ui.column(id, () => build(inner - 38), { style: "section", width: inner, spacing: 8 });
}
function backRow(inner: number, label: string, fn: () => void, extra?: () => void): void {
  ui.row("back-row", () => { if (btn(label, "back", [])) fn(); extra?.(); }, { width: inner, spacing: 10, justify: "center" });
}

function drawPage(L: Layout): void {
  switch (app.phase) {
    case "title": return titleScreen(L);
    case "journey": return journeyScreen(L);
    case "learn": return learnScreen(L);
    case "challenges": return challengesScreen(L);
    case "setup": return setupScreen(L);
    case "results": return resultsScreen(L);
    case "settings": return settingsScreen(L);
    case "help": return helpScreen(L);
    default: break;
  }
}

function art(id: string, cls: string, w: number, h: number): void {
  ui.row(`${id}-row`, () => { ui.id(id).widget("", { role: "image", size: { width: w, height: h }, style: cls }); }, { justify: "center" });
}

function titleScreen(L: Layout): void {
  const snap = savedSnapshot();
  const m = masteryTitle();
  const progress = platform.getProgress();
  const today = Content.todayUTC();
  const dailyDef = Content.dailyForDate(today) as Def;
  const dailyDone = progress.daily.days.includes(today);
  const achCount = Object.keys(progress.achievements).length;
  const journeyDone = Object.keys(progress.journey).length;
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const ms = next - now.getTime();
  if (ui.back()) { /* the title is the top screen */ }
  page("title", L, (inner) => {
    // The browser build shrank the key art to 18rem on short windows (max-height: 560px).
    const artW = Math.min(inner, L.lh < 600 ? 160 : L.lh < 760 ? 288 : 608);
    art("key-art", "art-key", artW, artW * 672 / 1200);
    ui.style("game-title", (L.lh < 600 || L.lw < 480) && { text: { size: L.lw < 360 ? 30 : 36 } }).label("Bearing Board");
    ui.style("tagline-center").paragraph(t("title.tagline"), inner);
    ui.style("tagline-center").paragraph(t("title.stats", { name: profileName(), title: m.title, stars: m.stars, a: achCount, total: Content.ACHIEVEMENTS.length }), inner);
    const items: { label: string; id: string; primary?: boolean; fn: () => void }[] = [];
    if (snap) items.push({ label: t("m.continue", { name: snap.def ? defName(snap.def) : snap.defId || t("m.savedTable") }), id: "m-continue", primary: true, fn: resumeSnapshot });
    items.push({ label: t("m.play"), id: "m-play", primary: true, fn: playNow });
    items.push({ label: `${t("m.daily")} ${t("daily.newIn", { h: Math.floor(ms / 3600000), m: Math.floor(ms / 60000) % 60 })}`, id: "m-daily", fn: startDaily });
    items.push({ label: t("m.journey", { done: journeyDone, total: Content.JOURNEY.length }), id: "m-journey", fn: () => go("journey") });
    items.push({ label: t("m.learn"), id: "m-learn", fn: () => go("learn") });
    items.push({ label: t("m.challenges"), id: "m-challenges", fn: () => go("challenges") });
    items.push({ label: t("m.practice"), id: "m-practice", fn: () => go("setup") });
    items.push({ label: t("m.settings"), id: "m-settings", fn: () => openFromTitle("settings") });
    items.push({ label: t("m.help"), id: "m-help", fn: () => openFromTitle("help") });
    if (platform.signedIn() && platform.inviteLink()) items.push({ label: t("acc.invite"), id: "m-invite", fn: copyInvite });
    if (!platform.signedIn()) items.push({ label: t("acc.signIn"), id: "m-sign-in", fn: () => { void requestSignIn().catch(() => undefined); } });
    // Two columns where the window is wide but short (the browser build's menu was one column of 24rem).
    const cols = L.lw >= 640 && L.lh < 760 ? 2 : 1;
    const menuW = Math.min(inner, cols === 2 ? 608 : 384);
    const bw = (menuW - GAP * (cols - 1)) / cols;
    ui.row("menu-center", () => {
      ui.grid("menu", () => {
        for (const it of items) if (btn(it.label, it.id, ["btn-menu", it.primary && "btn-primary"], {}, bw)) { it.fn(); }
      }, { columns: cols, gap: GAP, width: menuW });
    }, { justify: "center", width: inner });
    section("today", inner, (w) => {
      ui.row("today-head", () => {
        ui.style("section-title").label(t("today.title"));
        if (dailyDone) ui.style("badge", "badge-on").label(t("badge.finished"));
      }, { spacing: 8, align: "center" });
      ui.paragraph(defBlurb(dailyDef), w);
    });
  });
}

function tileGrid(id: string, inner: number, defs: { def: Def; badge?: string; stars?: number; chapter?: string }[], onPick: (def: Def) => void): void {
  const cols = Math.max(1, Math.floor((inner + GAP) / (216 + GAP)));
  const tw = (inner - GAP * (cols - 1)) / cols;
  ui.grid(id, () => {
    defs.forEach(({ def, badge, stars, chapter }, i) => {
      if (chapter) ui.cell({ span: cols, column: 0 }).style("chapter").label(chapter);
      const name = defName(def);
      const clicked = ui.style("tile", { width: tw }).id(`${id}-${i}`).button(name, {
        content: () => {
          ui.row(`${id}-${i}-head`, () => {
            ui.style("tile-name").paragraph(name, tw - 28 - (badge ? 70 : 0));
            if (badge) ui.style("badge", "badge-on").label(badge);
          }, { spacing: 6, align: "center" });
          ui.style("tile-sub").paragraph(defBlurb(def), tw - 28);
          if (stars != null) ui.style("stars").label(starsText(stars));
        },
      });
      if (clicked) onPick(def);
    });
  }, { columns: cols, gap: GAP, width: inner, align: "stretch" });
}

function journeyScreen(L: Layout): void {
  if (ui.back()) { showTitle(); return; }
  const progress = platform.getProgress();
  page("journey", L, (inner) => {
    ui.style("page-title").label(t("journey.title"));
    ui.style("tagline").paragraph(t("journey.desc"), inner);
    let last = -1;
    tileGrid("journey-grid", inner, (Content.JOURNEY as Def[]).map((def) => {
      const chapter = def.chapter !== last ? t(`chap.${def.chapter}`) : undefined;
      last = def.chapter ?? last;
      return { def, stars: progress.journey[def.id]?.stars || 0, chapter };
    }), (def) => startGame(def, { humanSeats: [0] }));
  }, (inner) => backRow(inner, t("btn.back"), showTitle));
}

function learnScreen(L: Layout): void {
  if (ui.back()) { showTitle(); return; }
  const progress = platform.getProgress();
  page("learn", L, (inner) => {
    ui.style("page-title").label(t("learn.title"));
    ui.style("tagline").paragraph(t("learn.desc"), inner);
    tileGrid("learn-grid", inner, (Content.LESSONS as Def[]).map((def) => ({ def, badge: progress.lessons[def.id]?.done ? t("badge.done") : undefined })), (def) => startGame(def, { humanSeats: [0] }));
  }, (inner) => backRow(inner, t("btn.back"), showTitle));
}

function challengesScreen(L: Layout): void {
  if (ui.back()) { showTitle(); return; }
  const progress = platform.getProgress();
  page("challenges", L, (inner) => {
    ui.style("page-title").label(t("ch.title"));
    ui.style("tagline").paragraph(t("ch.desc"), inner);
    tileGrid("challenge-grid", inner, (Content.CHALLENGES as Def[]).map((def) => ({ def, badge: progress.challenges[def.id]?.done ? t("badge.cleared") : undefined })), (def) => startGame(def, { humanSeats: [0] }));
  }, (inner) => backRow(inner, t("btn.back"), showTitle));
}

function field(id: string, label: string, w: number, control: () => void): void {
  ui.column(id, () => { ui.style("field-label").label(label); control(); }, { spacing: 4, width: w, align: "stretch" });
}

function setupScreen(L: Layout): void {
  if (ui.back()) { showTitle(); return; }
  const f = app.setup;
  const RULESETS = ["duel", "circuit"];
  const DIFFS = Object.values(AI.DIFFICULTIES) as { key: string; blurb: string }[];
  const start = (): void => {
    const ruleset = RULESETS[f.ruleset]!;
    const difficulty = DIFFS[f.difficulty]!.key;
    const players = ruleset === "circuit" ? f.players + 2 : 2;
    const humans = f.humans + 1;
    const seed = f.seed.trim() && /^\d+$/.test(f.seed.trim()) ? Number(f.seed.trim()) >>> 0 : null;
    const def = (Content.practiceDef as (d: string, r: string, s: number | null, p: number) => Def)(difficulty, ruleset, seed, players);
    def.theme = (Content.THEMES[f.theme] ?? Content.THEMES[0]!).key;
    startGame(def, { humanSeats: [...Array(Math.min(humans, players)).keys()] });
  };
  page("setup", L, (inner) => {
    ui.style("page-title").label(t("setup.title"));
    section("setup-form", inner, (w) => {
      ui.style("tagline").paragraph(t("setup.desc"), w);
      field("f-ruleset", t("setup.ruleset"), w, () => { f.ruleset = ui.id("sel-ruleset").select(t("setup.ruleset"), f.ruleset, [t("setup.duel"), t("setup.circuit")]); });
      field("f-difficulty", t("setup.difficulty"), w, () => { f.difficulty = ui.id("sel-difficulty").select(t("setup.difficulty"), f.difficulty, DIFFS.map((d) => `${aiLabel(d.key)} — ${t(`ai.${d.key}.b`, null, d.blurb)}`)); });
      if (f.ruleset === 1) field("f-players", t("setup.players"), w, () => { f.players = ui.id("sel-players").select(t("setup.players"), f.players, ["2", "3", "4"]); });
      field("f-humans", t("setup.humans"), w, () => { f.humans = ui.id("sel-humans").select(t("setup.humans"), f.humans, [t("setup.h1"), t("setup.h2")]); });
      field("f-theme", t("setup.theme"), w, () => { f.theme = ui.id("sel-theme").select(t("setup.theme"), f.theme, Content.THEMES.map((th: { key: string; label: string }) => themeLabel(th))); });
      field("f-seed", t("setup.seed"), w, () => {
        f.seed = ui.textField("f-seed-input", f.seed, { maxChars: 10, width: w, placeholder: t("setup.random") }).replace(/[^\d]/g, "");
        if (ui.submitted("f-seed-input")) start();
      });
    });
  }, (inner) => backRow(inner, t("btn.back"), showTitle, () => { if (btn(t("setup.start"), "f-start", ["btn-primary"])) start(); }));
}

function resultsScreen(L: Layout): void {
  const s = app.session;
  if (!s?.result) { showTitle(); return; }
  const { def, result: res, goalReport: rep, state } = s;
  const won = rep!.won;
  const markers = (Rules.RULESETS as Record<string, { markers: number }>)[state.cfg.ruleset]!.markers;
  const stars = def.kind === "journey" ? starsFor(def, rep!, state, s.thinkingMs) : 0;
  const next = nextContent();
  if (ui.back()) { showTitle(); return; }
  page("results", L, (inner) => {
    const aw = Math.min(inner, L.lh < 760 ? 192 : 384);
    art("result-art", won ? "art-victory" : "art-road", aw, aw * 400 / 640);
    ui.style("headline").label(t(won ? "res.victory" : "res.road"));
    ui.style("tagline-center").paragraph(t(res.winner === 0 ? "res.lineYou" : "res.line", {
      name: defName(def), who: seatName(res.winner), reason: t(`reason.${res.reason}`, null, res.reason), turns: state.turnNum, time: fmtClock(s.thinkingMs),
    }), inner);
    if (def.kind === "journey") ui.row("stars-row", () => { ui.style("stars-big").label(starsText(stars), { tooltip: t("stars.aria", { n: stars }) }); }, { width: inner, justify: "center" });
    section("breakdown", inner, (w) => {
      ui.style("section-title").label(t("res.breakdown"));
      ui.grid("breakdown-grid", () => {
        for (const b of res.breakdown) { ui.style("cell").label(t(`bd.${b.key}`, null, b.label)); ui.style("cell").label(String(b.value)); }
      }, { columns: [{ fr: 1 }, { width: "auto", align: "end" }], gap: 0, width: w, rowStyle: "score-row" });
      ui.style("tagline").paragraph(t("res.strikes", { mine: state.stats.hits[0], theirs: state.stats.hits.slice(1).reduce((a: number, b: number) => a + b, 0), off: state.off[0], total: markers }), w);
    });
    if (rep!.items.length) {
      section("goals", inner, (w) => {
        ui.style("section-title").label(t("res.goals"));
        ui.grid("goals-grid", () => {
          for (const g of rep!.items) {
            ui.style("cell").paragraph(`${g.met ? "✓" : "✗"} ${t(`goal.${g.key}`, g.vars)}`, w - 120);
            ui.style("cell").label(t(g.met ? "res.met" : "res.missed"));
          }
        }, { columns: [{ fr: 1 }, { width: "auto", align: "end" }], gap: 0, width: w, rowStyle: "score-row" });
      });
    }
    if (s.newAchievements.length) {
      section("achievements", inner, (w) => {
        ui.style("section-title").label(t("res.achievements"));
        for (const a of s.newAchievements) {
          ui.row(`ach-${a.key}`, () => { ui.style("badge", "badge-on").label(achLabel(a)); ui.paragraph(achDesc(a), w - 160); }, { spacing: 8, align: "center" });
        }
      });
    }
    section("mastery", inner, (w) => {
      ui.style("section-title").label(t("res.mastery"));
      const m = masteryTitle();
      ui.paragraph(t("res.masteryLine", { title: m.title, stars: m.stars }), w);
      ui.style("tagline").paragraph(t("res.versions", { seed: state.cfg.seed, r: Rules.RULES_VERSION, c: Content.CONTENT_VERSION }), w);
      if (btn(t("res.copyReplay"), "r-replay")) copyReplay();
    });
    const lb = s.lbPost ? (!s.lbResult ? t("acc.lbPosting") : !s.lbResult.posted ? t("acc.lbNotPosted") : s.lbResult.rank ? t("acc.lbRank", { rank: s.lbResult.rank ?? 0 }) : t("acc.lbPosted")) : null;
    if (lb) ui.style("tagline-center").paragraph(lb, inner);
  }, (inner) => {
    ui.row("results-actions", () => {
      if (btn(t("btn.menu"), "r-menu")) { showTitle(); }
      if (btn(t("btn.retry"), "r-retry")) retry();
      if (next && btn(t(def.kind === "journey" ? "btn.nextStage" : "btn.nextLesson"), "r-next", ["btn-primary"])) startGame(next, { humanSeats: [0] });
    }, { width: inner, spacing: 10, justify: "center" });
  });
}

function keysText(): string {
  const key = (a: string): string => {
    const l = bindingLabel(a);
    const names: Record<string, string> = { Escape: "Esc", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Space: t("key.Space") };
    return names[l] ?? l.replace(/^Key/, "").replace(/^Digit/, "");
  };
  return [
    `${t("key.roll")} ${key("roll")}`, `${t("key.undo")} ${key("undo")}`, `${t("key.hint")} ${key("hint")}`,
    `${t("key.pause")} ${key("pause")}`, `${t("key.camera")} ${key("camera")}`,
    `${t("key.navigate")} ${key("prev")} ${key("next")}`, `${t("key.confirm")} ${key("confirm")}`,
  ].join(" · ");
}

function settingsScreen(L: Layout): void {
  if (ui.back()) { closeSubscreen(); return; }
  const st = app.settings;
  page("settings", L, (inner) => {
    ui.style("page-title").label(t("set.title"));
    section("set-table", inner, (w) => {
      field("s-theme", t("set.theme"), w, () => {
        const i = Math.max(0, Content.THEMES.findIndex((th: { key: string }) => th.key === st.theme));
        const n = ui.id("sel-theme-setting").select(t("set.theme"), i, Content.THEMES.map((th: { key: string; label: string }) => themeLabel(th)));
        if (n !== i) setSetting("theme", Content.THEMES[n]!.key);
      });
      // Sound, graphics, language, controls and accessibility are the runtime's Options.
      if (btn(t("btn.options"), "s-options", [], {}, w)) openMenu();
    });
    section("set-access", inner, (w) => {
      ui.style("section-title").label(t("set.access"));
      for (const [key, label] of [["leftHanded", "set.lh"], ["haptics", "set.hap"], ["toggleSelect", "set.ts"]] as const) {
        const v = ui.id(`s-${key}`).checkbox(t(label), st[key]);
        if (v !== st[key]) setSetting(key, v);
      }
      field("s-ta", t("set.ta"), w, () => {
        const opts = [1, 1.5, 2];
        const i = Math.max(0, opts.indexOf(st.timingAssist));
        const n = ui.id("sel-ta").select(t("set.ta"), i, opts.map((m) => `${m}×`));
        if (n !== i) setSetting("timingAssist", opts[n]!);
      });
      ui.style("sub-title").label(t("set.keys"));
      ui.paragraph(keysText(), w);
      ui.style("sub-title").label(t("set.profile"));
      field("s-name", t("set.name"), w, () => {
        const shown = st.profileName || t("profile.default");
        const v = ui.textField("s-name-input", shown, { maxChars: 24, width: w });
        if (v !== shown) {
          const clean = v.trim();
          setSetting("profileName", !clean || clean === t("profile.default") ? "" : v.slice(0, 24));
        }
      });
      ui.style("sub-title").label(t("set.data"));
      ui.row("s-data", () => {
        if (btn(t("set.replayTut"), "s-tutorial-reset")) resetTutorials();
        if (btn(t("set.wipe"), "s-wipe", ["btn-danger"])) wipeProgress();
      }, { spacing: 10 });
    });
  }, (inner) => ui.row("s-done-row", () => { if (btn(t("btn.done"), "s-back", ["btn-primary"])) closeSubscreen(); }, { width: inner, justify: "center" }));
}

function helpScreen(L: Layout): void {
  if (ui.back()) { closeSubscreen(); return; }
  const theme = Content.themeByKey(app.settings.theme);
  page("help", L, (inner) => {
    ui.style("page-title").label(t("help.title"));
    for (const k of ["road", "dice", "strikes", "bearoff", "cube", "scoring", "controls", "colors"]) {
      section(`h-${k}`, inner, (w) => {
        ui.style("section-title").label(t(`h.${k}.t`));
        if (k === "colors") {
          flow("legend", theme.players.slice(0, 4).map((c: number, i: number) => {
            const text = i === 0 ? t("help.you") : t("help.rival", { n: i });
            return {
              label: text, w: ui.measureText(text, { style: "badge" }).width / L.sc + 26,
              build: () => {
                ui.row(`legend-${i}`, () => {
                  ui.id(`legend-sw-${i}`).widget("", { role: "none", size: { width: 14, height: 14 }, draw: (r) => { draw.roundRect(r.x, r.y, r.width, r.height, r.width / 2, `#${c.toString(16).padStart(6, "0")}`); } });
                  ui.label(text);
                }, { style: "badge", spacing: 6, align: "center" });
              },
            };
          }), w, { justify: "start" });
        }
        ui.paragraph(plain(t(`h.${k}.html`)), w);
        if (k === "controls") ui.style("tagline").paragraph(keysText(), w);
      });
    }
  }, (inner) => ui.row("h-done-row", () => { if (btn(t("btn.done"), "h-back", ["btn-primary"])) closeSubscreen(); }, { width: inner, justify: "center" }));
}

