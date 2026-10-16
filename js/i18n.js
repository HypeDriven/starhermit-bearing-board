// Bearing Board — localization. Every player-facing string lives in the
// js/i18n-*.js tables (nine locales: en-US, en-GB, es-419, es-ES, de-DE, fr-FR,
// fr-CA, pt-BR, it-IT). The active locale comes from sh-language.js (Settings →
// Language: explicit choice → StarHermit preferred language → navigator.languages
// → en-US); `?lang=` forces one for the page load (QA links) and hides the
// selector. A change re-applies [data-i18n] markup and notifies listeners so the
// current screen, HUD and board mirror re-render live.
import { EN, EN_GB } from './i18n-en.js';
import { ES, ES_ES } from './i18n-es.js';
import { DE } from './i18n-de.js';
import { FR, FR_CA } from './i18n-fr.js';
import { PT } from './i18n-pt.js';
import { IT } from './i18n-it.js';

export const STRINGS = {
  'en-US': EN,
  'en-GB': { ...EN, ...EN_GB },
  'es-419': { ...ES, 'ls.lesson-roll.0': 'Viajas desde la puerta lejana (punta 24) hacia casa. Presiona Tirar.' },
  'es-ES': { ...ES, ...ES_ES },
  'de-DE': DE,
  'fr-FR': FR,
  'fr-CA': { ...FR, ...FR_CA },
  'pt-BR': PT,
  'it-IT': IT,
};
export const LOCALES = Object.keys(STRINGS);

let lang = 'en-US';
let dict = EN;
const listeners = [];

/** Translate `key`, filling {placeholders}; en-US, then `fallback`, then the key. */
export function t(key, vars, fallback) {
  let s = dict[key];
  if (s == null) s = EN[key];
  if (s == null) s = fallback != null ? fallback : key;
  if (vars) s = String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
  return s;
}
export function has(key) { return dict[key] != null || EN[key] != null; }
export function getLang() { return lang; }
export function onLanguage(fn) { listeners.push(fn); }

/** Re-apply data-i18n (text), data-i18n-html (trusted markup), data-i18n-aria and data-i18n-placeholder. */
export function applyDom(root = typeof document !== 'undefined' ? document : null) {
  if (!root) return;
  for (const n of root.querySelectorAll('[data-i18n]')) n.textContent = t(n.dataset.i18n);
  for (const n of root.querySelectorAll('[data-i18n-html]')) n.innerHTML = t(n.dataset.i18nHtml);
  for (const n of root.querySelectorAll('[data-i18n-aria]')) n.setAttribute('aria-label', t(n.dataset.i18nAria));
  for (const n of root.querySelectorAll('[data-i18n-placeholder]')) n.setAttribute('placeholder', t(n.dataset.i18nPlaceholder));
  if (root === document) document.documentElement.lang = lang;
}

function setLocale(next) {
  lang = STRINGS[next] ? next : 'en-US';
  dict = STRINGS[lang];
  if (typeof document === 'undefined') return;
  applyDom(document);
  for (const fn of listeners.slice()) { try { fn(lang); } catch (e) { console.error(e); } }
}

let forced = null;
try { forced = new URLSearchParams(location.search).get('lang'); } catch (_) { /* no URL */ }
const SL = typeof window !== 'undefined' ? window.StarHermitLanguage : null;
const forcedLocale = forced && SL ? SL.match(forced, LOCALES) : null;
export const language = SL ? SL.create({
  game: 'bearing-board', supported: LOCALES, panel: !forcedLocale,
  apply: (locale) => setLocale(forcedLocale || locale),
}) : null;
if (!language && typeof document !== 'undefined') setLocale('en-US');
