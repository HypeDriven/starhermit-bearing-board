// Localized strings for the Graphics settings section. The rest of the game ships in English;
// these strings follow the browser language across the nine supported locales.

export const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];

const EN_US = {
  title: 'Graphics',
  quality: 'Quality',
  auto: 'Auto (detected: {tier})',
  preset: { low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra' },
  renderScale: 'Render scale',
  fromPreset: 'From preset ({tier})',
  cat: {
    shadows: 'Shadows', ao: 'Ambient occlusion', bloom: 'Bloom', grade: 'Color grade and vignette',
    antialias: 'Anti-aliasing', reflections: 'Reflections', detail: 'Board detail', particles: 'Particles',
    background: 'Ambient motion',
  },
  tier: {
    off: 'Off', on: 'On', low: 'Low', medium: 'Medium', high: 'High', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    plain: 'Plain', detailed: 'Detailed', static: 'Still', animated: 'Animated',
  },
  adaptive: 'Adaptive resolution (lowers the resolution when frames are slow)',
  showFps: 'Show frame rate',
  postFailed: 'Post-processing is unavailable on this device; the board is drawn without it.',
  unknownGpu: 'unknown GPU',
  words: {
    noShadows: 'no shadows', shadows: '{n}² shadows', ao: 'ambient occlusion', aoHigh: 'full ambient occlusion',
    bloom: 'bloom', noAA: 'no anti-aliasing', reflections: 'reflections', animated: 'ambient motion',
  },
};

const EN_GB = {
  ...EN_US,
  cat: { ...EN_US.cat, grade: 'Colour grade and vignette' },
};

const ES_419 = {
  title: 'Gráficos',
  quality: 'Calidad',
  auto: 'Automática (detectada: {tier})',
  preset: { low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
  renderScale: 'Escala de renderizado',
  fromPreset: 'Según el ajuste ({tier})',
  cat: {
    shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Corrección de color y viñeta',
    antialias: 'Antialiasing', reflections: 'Reflejos', detail: 'Detalle del tablero', particles: 'Partículas',
    background: 'Movimiento ambiental',
  },
  tier: {
    off: 'No', on: 'Sí', low: 'Baja', medium: 'Media', high: 'Alta', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    plain: 'Simple', detailed: 'Detallado', static: 'Quieto', animated: 'Animado',
  },
  adaptive: 'Resolución adaptable (baja la resolución si los cuadros van lentos)',
  showFps: 'Mostrar cuadros por segundo',
  postFailed: 'El posprocesado no está disponible en este dispositivo; el tablero se dibuja sin él.',
  unknownGpu: 'GPU desconocida',
  words: {
    noShadows: 'sin sombras', shadows: 'sombras {n}²', ao: 'oclusión ambiental', aoHigh: 'oclusión ambiental completa',
    bloom: 'resplandor', noAA: 'sin antialiasing', reflections: 'reflejos', animated: 'movimiento ambiental',
  },
};

const ES_ES = {
  ...ES_419,
  adaptive: 'Resolución adaptativa (reduce la resolución si los fotogramas van lentos)',
  showFps: 'Mostrar fotogramas por segundo',
  renderScale: 'Escala de renderizado',
  cat: { ...ES_419.cat, bloom: 'Resplandor (bloom)' },
};

const DE_DE = {
  title: 'Grafik',
  quality: 'Qualität',
  auto: 'Automatisch (erkannt: {tier})',
  preset: { low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra' },
  renderScale: 'Renderskalierung',
  fromPreset: 'Laut Voreinstellung ({tier})',
  cat: {
    shadows: 'Schatten', ao: 'Umgebungsverdeckung', bloom: 'Leuchteffekt', grade: 'Farbkorrektur und Vignette',
    antialias: 'Kantenglättung', reflections: 'Spiegelungen', detail: 'Brettdetails', particles: 'Partikel',
    background: 'Umgebungsbewegung',
  },
  tier: {
    off: 'Aus', on: 'An', low: 'Niedrig', medium: 'Mittel', high: 'Hoch', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    plain: 'Schlicht', detailed: 'Detailliert', static: 'Still', animated: 'Animiert',
  },
  adaptive: 'Adaptive Auflösung (senkt die Auflösung, wenn Bilder langsam sind)',
  showFps: 'Bildrate anzeigen',
  postFailed: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; das Brett wird ohne sie gezeichnet.',
  unknownGpu: 'unbekannte GPU',
  words: {
    noShadows: 'keine Schatten', shadows: '{n}²-Schatten', ao: 'Umgebungsverdeckung', aoHigh: 'volle Umgebungsverdeckung',
    bloom: 'Leuchteffekt', noAA: 'keine Kantenglättung', reflections: 'Spiegelungen', animated: 'Umgebungsbewegung',
  },
};

const FR_FR = {
  title: 'Graphismes',
  quality: 'Qualité',
  auto: 'Auto (détecté : {tier})',
  preset: { low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra' },
  renderScale: 'Échelle de rendu',
  fromPreset: 'Selon le préréglage ({tier})',
  cat: {
    shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Halo lumineux', grade: 'Étalonnage et vignettage',
    antialias: 'Anticrénelage', reflections: 'Reflets', detail: 'Détail du plateau', particles: 'Particules',
    background: 'Mouvement d’ambiance',
  },
  tier: {
    off: 'Désactivé', on: 'Activé', low: 'Bas', medium: 'Moyen', high: 'Élevé', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    plain: 'Simple', detailed: 'Détaillé', static: 'Fixe', animated: 'Animé',
  },
  adaptive: 'Résolution adaptative (baisse la résolution quand les images ralentissent)',
  showFps: 'Afficher la fréquence d’images',
  postFailed: 'Le post-traitement est indisponible sur cet appareil ; le plateau est affiché sans.',
  unknownGpu: 'GPU inconnu',
  words: {
    noShadows: 'sans ombres', shadows: 'ombres {n}²', ao: 'occlusion ambiante', aoHigh: 'occlusion ambiante complète',
    bloom: 'halo', noAA: 'sans anticrénelage', reflections: 'reflets', animated: 'mouvement d’ambiance',
  },
};

const FR_CA = {
  ...FR_FR,
  showFps: 'Afficher le nombre d’images par seconde',
  adaptive: 'Résolution adaptative (réduit la résolution quand les images ralentissent)',
};

const PT_BR = {
  title: 'Gráficos',
  quality: 'Qualidade',
  auto: 'Automática (detectada: {tier})',
  preset: { low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
  renderScale: 'Escala de renderização',
  fromPreset: 'Conforme a predefinição ({tier})',
  cat: {
    shadows: 'Sombras', ao: 'Oclusão de ambiente', bloom: 'Brilho', grade: 'Correção de cor e vinheta',
    antialias: 'Antisserrilhamento', reflections: 'Reflexos', detail: 'Detalhe do tabuleiro', particles: 'Partículas',
    background: 'Movimento ambiente',
  },
  tier: {
    off: 'Desligado', on: 'Ligado', low: 'Baixo', medium: 'Médio', high: 'Alto', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    plain: 'Simples', detailed: 'Detalhado', static: 'Parado', animated: 'Animado',
  },
  adaptive: 'Resolução adaptativa (reduz a resolução quando os quadros ficam lentos)',
  showFps: 'Mostrar taxa de quadros',
  postFailed: 'O pós-processamento não está disponível neste dispositivo; o tabuleiro é desenhado sem ele.',
  unknownGpu: 'GPU desconhecida',
  words: {
    noShadows: 'sem sombras', shadows: 'sombras {n}²', ao: 'oclusão de ambiente', aoHigh: 'oclusão de ambiente completa',
    bloom: 'brilho', noAA: 'sem antisserrilhamento', reflections: 'reflexos', animated: 'movimento ambiente',
  },
};

const IT_IT = {
  title: 'Grafica',
  quality: 'Qualità',
  auto: 'Automatica (rilevata: {tier})',
  preset: { low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra' },
  renderScale: 'Scala di rendering',
  fromPreset: 'Dalla preimpostazione ({tier})',
  cat: {
    shadows: 'Ombre', ao: 'Occlusione ambientale', bloom: 'Bagliore', grade: 'Correzione colore e vignettatura',
    antialias: 'Antialiasing', reflections: 'Riflessi', detail: 'Dettaglio della tavola', particles: 'Particelle',
    background: 'Movimento d’ambiente',
  },
  tier: {
    off: 'No', on: 'Sì', low: 'Basso', medium: 'Medio', high: 'Alto', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    plain: 'Semplice', detailed: 'Dettagliato', static: 'Fermo', animated: 'Animato',
  },
  adaptive: 'Risoluzione adattiva (abbassa la risoluzione quando i fotogrammi rallentano)',
  showFps: 'Mostra frequenza fotogrammi',
  postFailed: 'La post-elaborazione non è disponibile su questo dispositivo; la tavola viene disegnata senza.',
  unknownGpu: 'GPU sconosciuta',
  words: {
    noShadows: 'nessuna ombra', shadows: 'ombre {n}²', ao: 'occlusione ambientale', aoHigh: 'occlusione ambientale completa',
    bloom: 'bagliore', noAA: 'nessun antialiasing', reflections: 'riflessi', animated: 'movimento d’ambiente',
  },
};

export const GFX_STRINGS = {
  'en-US': EN_US, 'en-GB': EN_GB, 'es-419': ES_419, 'es-ES': ES_ES, 'de-DE': DE_DE,
  'fr-FR': FR_FR, 'fr-CA': FR_CA, 'pt-BR': PT_BR, 'it-IT': IT_IT,
};

const FALLBACK = { en: 'en-US', es: 'es-419', de: 'de-DE', fr: 'fr-FR', pt: 'pt-BR', it: 'it-IT' };

/** First supported locale from a browser language list (exact match, then language family). */
export function pickLocale(langs) {
  const list = (Array.isArray(langs) ? langs : [langs]).filter(Boolean).map(String);
  for (const l of list) {
    const hit = LOCALES.find((x) => x.toLowerCase() === l.toLowerCase());
    if (hit) return hit;
    const lower = l.toLowerCase();
    if (lower.startsWith('es-') && lower !== 'es-es') return 'es-419';
    if (lower === 'en-au' || lower === 'en-nz' || lower === 'en-ie') return 'en-GB';
  }
  for (const l of list) {
    const fam = FALLBACK[l.toLowerCase().split('-')[0]];
    if (fam) return fam;
  }
  return 'en-US';
}

export function gfxStrings(locale) {
  return GFX_STRINGS[locale] || EN_US;
}
