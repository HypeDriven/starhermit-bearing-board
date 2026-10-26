// Bearing Board — the game's own options as the engine client keeps them
// (starhermit:storage `settings`, game.<key>) and the migration of the
// browser build's per-player settings keys. Pure data (native/platform.ts
// and the tests). Sound, graphics, language, controls, reduced motion, high
// contrast and text size are the runtime's Options now and are dropped.

export const DEFAULT_SETTINGS = {
  theme: 'caravan',
  leftHanded: false,
  haptics: true,
  toggleSelect: true, // tap-tap selection (else a failed press-and-hold drop clears it)
  timingAssist: 1, // 1 | 1.5 | 2 for timed goals
  profileName: '', // '' = the localized default guest name
};
const KEYS = Object.keys(DEFAULT_SETTINGS);
const THEMES = ['caravan', 'lagoon', 'ember', 'verdant', 'midnight'];

/** A stored value for `key` in the shape the game keeps, or undefined. */
export function cleanSetting(key, v) {
  switch (key) {
    case 'theme': return typeof v === 'string' && THEMES.includes(v) ? v : undefined;
    case 'leftHanded': case 'haptics': case 'toggleSelect': return typeof v === 'boolean' ? v : undefined;
    case 'timingAssist': return v === 1 || v === 1.5 || v === 2 ? v : undefined;
    case 'profileName': return typeof v === 'string' ? v.trim().slice(0, 24) : undefined;
    default: return undefined;
  }
}

/** A browser-build settings key and value → { key, value } the engine client
 * keeps, or null (dropped). Its default traveller name was stored literally. */
export function migrateLegacySetting(key, value) {
  if (key === 'profile') {
    const name = value && typeof value === 'object' ? value.name : undefined;
    if (typeof name !== 'string' || name === 'Guest Traveler') return null;
    const v = cleanSetting('profileName', name);
    return v ? { key: 'profileName', value: v } : null;
  }
  if (!KEYS.includes(key) || key === 'profileName') return null;
  const v = cleanSetting(key, value);
  return v === undefined ? null : { key, value: v };
}
