// Localization: js/strings.js (the nine StarHermit locales) in the interface
// language the runtime reports (preferences().language: the player's choice
// in Options › Language, else the device's). The browser build's own
// Language selector, its ?lang= override and the account's preferred-language
// lookup are the runtime's now. A change re-renders everything next frame
// (the UI is immediate mode); listeners hear it for what is cached.
import { onPreferencesChange, preferences } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { LOCALES, STRINGS } from "../js/strings.js";

type Table = Record<string, string>;
const TABLES = STRINGS as unknown as Record<string, Table>;
const PRIMARY: Record<string, string> = { en: "en-US", es: "es-419", de: "de-DE", fr: "fr-FR", pt: "pt-BR", it: "it-IT" };

/** The shipped locale nearest a BCP 47 tag (the browser build's mapping:
 * es-MX → es-419, en-AU → en-GB, fr → fr-FR, pt-PT → pt-BR). */
export function pickLocale(tag: string): string {
  const t = String(tag || "en-US");
  const exact = LOCALES.find((l) => l.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  const lang = t.split(/[-_]/)[0]!.toLowerCase();
  if (lang === "en" && /-(gb|ie|au|nz|za|in)$/i.test(t)) return "en-GB";
  if (lang === "es" && /-es$/i.test(t)) return "es-ES";
  if (lang === "fr" && /-ca$/i.test(t)) return "fr-CA";
  return PRIMARY[lang] ?? "en-US";
}

let locale = pickLocale(preferences().language);
export function currentLocale(): string { return locale; }
const listeners = new Set<() => void>();
/** fn() after the interface language changed. */
export function onLanguage(fn: () => void): void { listeners.add(fn); }
function apply(): void {
  ui.setLanguage(locale);
  for (const fn of listeners) fn();
}
onPreferencesChange((p) => {
  const next = pickLocale(p.language);
  if (next === locale) return;
  locale = next;
  apply();
});
apply();

export type Vars = Record<string, string | number> | null | undefined;
/** A string by key in the player's language (then en-US, then `fallback`,
 * then the key), `{name}` placeholders filled from vars. */
export function t(key: string, vars?: Vars, fallback?: string): string {
  let s = TABLES[locale]?.[key] ?? TABLES["en-US"]![key] ?? fallback ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] != null ? String(vars[k]) : m));
  return s;
}

/** Trusted markup (`*.html` strings) as plain text: tags dropped, the
 * browser build's key chips kept as the key names, entities decoded. */
export function plain(html: string): string {
  return html
    .replace(/<span class="bb-kbd">([^<]*)<\/span>/g, " $1 ")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/ {2,}/g, " ")
    .replace(/ ([,.;:)])/g, "$1")
    .trim();
}
