// Bearing Board — every player-facing string in the nine StarHermit locales
// (en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT): the game's
// tables (js/i18n-*.js), the platform lines (js/account-strings.js, as
// acc.<key>) and the strings the engine client added (PORT below). Pure data:
// native/i18n.ts picks the table for the runtime's interface language and
// the tests check that every key exists in every locale. Values may hold
// {placeholders}; keys ending in `.html` are trusted markup, which the engine
// client shows as plain text (native/i18n.ts plain()).
import { EN, EN_GB } from './i18n-en.js';
import { ES, ES_ES } from './i18n-es.js';
import { DE } from './i18n-de.js';
import { FR, FR_CA } from './i18n-fr.js';
import { PT } from './i18n-pt.js';
import { IT } from './i18n-it.js';
import { ACCOUNT_STRINGS } from './account-strings.js';

const PORT = {
  'en-US': { 'btn.options': 'Sound, graphics and controls…', 'toast.merged': 'Progress from another device was merged.' },
  'en-GB': { 'btn.options': 'Sound, graphics and controls…', 'toast.merged': 'Progress from another device was merged.' },
  'es-419': { 'btn.options': 'Sonido, gráficos y controles…', 'toast.merged': 'Se combinó el progreso de otro dispositivo.' },
  'es-ES': { 'btn.options': 'Sonido, gráficos y controles…', 'toast.merged': 'Se ha combinado el progreso de otro dispositivo.' },
  'de-DE': { 'btn.options': 'Ton, Grafik und Steuerung …', 'toast.merged': 'Fortschritt von einem anderen Gerät wurde übernommen.' },
  'fr-FR': { 'btn.options': 'Son, graphismes et commandes…', 'toast.merged': 'La progression d’un autre appareil a été fusionnée.' },
  'fr-CA': { 'btn.options': 'Son, graphismes et commandes…', 'toast.merged': 'La progression d’un autre appareil a été fusionnée.' },
  'pt-BR': { 'btn.options': 'Som, gráficos e controles…', 'toast.merged': 'O progresso de outro dispositivo foi mesclado.' },
  'it-IT': { 'btn.options': 'Audio, grafica e comandi…', 'toast.merged': 'I progressi di un altro dispositivo sono stati uniti.' },
};

const BASE = {
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

const account = (loc) => Object.fromEntries(Object.entries(ACCOUNT_STRINGS[loc]).map(([k, v]) => [`acc.${k}`, v]));

/** locale → { key: text } */
export const STRINGS = Object.fromEntries(Object.keys(BASE).map((loc) => [loc, { ...BASE[loc], ...account(loc), ...PORT[loc] }]));
export const LOCALES = Object.keys(STRINGS);
