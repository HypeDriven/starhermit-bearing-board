// Bearing Board — StarHermit account adapter over window.StarHermit
// (starhermit-sdk.js). Pure logic, no DOM: main.js wires it to the UI.
// Without a launch token every method is a no-op and nothing is requested.

export function createAccount(SH) {
  let cloudReady = false;   // remote save read; local saves may now upload
  let pushed = null;        // last settings object mirrored to the KV store

  return {
    get signedIn() { return !!(SH && SH.signedIn); },
    canSignIn() { return !!(SH && SH.canSignIn()); },
    signIn() { return !!(SH && SH.signIn()); },
    inviteLink() { return SH && SH.signedIn ? SH.inviteLink() : null; },
    onAuth(fn) { return SH ? SH.on('auth', fn) : () => {}; },

    /**
     * Signed-in start: nickname, remote save, platform settings and key
     * bindings in parallel. Resolves null standalone.
     * → { profile: Promise<{displayName}>, remote, settings, bindings }
     */
    async start(keyDefaults) {
      if (!this.signedIn) return null;
      const profile = SH.profile();
      const [remote, settings, bindings] = await Promise.all([
        SH.loadJSON(), SH.getSettings(), SH.loadBindings(keyDefaults),
      ]);
      cloudReady = true;
      pushed = JSON.parse(JSON.stringify(settings || {}));
      return { profile, remote, settings: settings || {}, bindings };
    },

    /** Debounced upload of the save document (after start()). */
    saveCloud(doc) {
      if (!this.signedIn || !cloudReady) return false;
      SH.saveJSON(doc);
      return true;
    },
    flush() { return this.signedIn ? SH.flushSave(true) : Promise.resolve(false); },

    /** PATCH only the keys that changed since the last mirror. */
    mirrorSettings(s) {
      if (!this.signedIn || !pushed) return null;
      const patch = {};
      for (const k of Object.keys(s)) {
        if (JSON.stringify(s[k]) !== JSON.stringify(pushed[k])) patch[k] = s[k];
      }
      pushed = JSON.parse(JSON.stringify(s));
      return Object.keys(patch).length ? SH.patchSettings(patch) : null;
    },

    /**
     * Post a finished game to the leaderboards (score-script.js).
     * → { posted, rank } — rank on the high-score board, or null.
     */
    async submitScore(points) {
      if (!this.signedIn) return { posted: false, rank: null };
      let keys;
      try { keys = await SH.submitScores({ 'high-score': points }); } catch { return { posted: false, rank: null }; }
      if (!keys || keys.indexOf('high-score') < 0) return { posted: false, rank: null };
      try {
        const r = await SH.leaderboard('high-score', { pageSize: 100 });
        const me = (r.items || []).find((i) => i.userId === SH.userId);
        return { posted: true, rank: me ? me.rank : null };
      } catch { return { posted: true, rank: null }; }
    },

    reset() { cloudReady = false; pushed = null; },
  };
}
