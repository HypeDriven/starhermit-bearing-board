// Localized names of the game's content: js/content.js keeps English data and
// js/strings.js the translations keyed by id (as in the browser build).
import * as Rules from "../js/rules.js";
import * as Content from "../js/content.js";
import { t } from "./i18n.ts";

export type Def = ReturnType<typeof Content.makeDef> & {
  tutorial?: { steps: { expect: string; text: string; times?: number }[] };
  goals?: Record<string, number | boolean>;
  options?: Record<string, unknown>;
  par?: { turns?: number; timeSec?: number };
  chapter?: number;
};

export const achLabel = (def: { key: string; label: string }): string => t(`ach.${def.key}`, null, def.label);
export const achDesc = (def: { key: string; desc: string }): string => t(`ach.${def.key}.d`, null, def.desc);
export const aiLabel = (key: string): string => t(`ai.${key}`, null, key);
export const aiWord = (key: string): string => t(`ai.${key}.w`, null, key);
export const rulesetLabel = (key: string): string => t(`rs.${key}`, null, (Rules.RULESETS as Record<string, { label: string }>)[key]?.label ?? key);
export const themeLabel = (th: { key: string; label: string }): string => t(`theme.${th.key}`, null, th.label);

export function defName(def: Def | null | undefined): string {
  if (!def) return "";
  if (def.kind === "journey") return t(`j.${def.id}`, null, def.name);
  if (def.kind === "learn") return t(`l.${def.id}`, null, def.name);
  if (def.kind === "challenge") return t(`c.${def.id}`, null, def.name);
  if (def.kind === "daily") return t("daily.name", { date: String(def.id).replace(/^daily-/, "") }, def.name);
  if (def.kind === "practice") {
    const d = def.ai?.difficulty || "steady";
    return t("prac.name", { ruleset: rulesetLabel(def.ruleset), difficulty: aiLabel(d), dw: aiWord(d) }, def.name);
  }
  return def.name;
}
export function defBlurb(def: Def | null | undefined): string {
  if (!def) return "";
  if (def.kind === "journey") return t(`jb.${def.id}`, null, def.blurb);
  if (def.kind === "learn") return t(`lb.${def.id}`, null, def.blurb);
  if (def.kind === "challenge") return t(`cb.${def.id}`, null, def.blurb);
  if (def.kind === "practice") return t("prac.blurb", null, def.blurb);
  if (def.kind === "daily") {
    const d = aiWord(def.ai?.difficulty || "steady");
    return def.ruleset === "circuit" ? t("daily.circuit", { n: def.players, d }, def.blurb) : t("daily.duel", { d }, def.blurb);
  }
  return def.blurb || "";
}

export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
export function starsText(n: number): string { return "★".repeat(n) + "☆".repeat(Math.max(0, 3 - n)); }
