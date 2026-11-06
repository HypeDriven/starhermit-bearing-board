// Localization: assets/strings.json (the nine StarHermit locales) on the
// engine's string tables, in the interface language the runtime reports
// (Options › Language, else the device's); account lines are the engine's
// `starhermit.*`. The UI is immediate mode, so a change shows next frame.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));

export function currentLocale(): string { return strings.locale; }
export type Vars = Record<string, string | number> | null | undefined;
/** A string by key in the player's language (then its chain to en-US, then
 * `fallback`), `{name}` placeholders filled from vars. */
export function t(key: string, vars?: Vars, fallback?: string): string {
  if (fallback !== undefined && !strings.has(key)) return fallback;
  return strings.t(key, vars ?? undefined);
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
