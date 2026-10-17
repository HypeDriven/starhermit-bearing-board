// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics,
// starts a practice duel with "Play now" and keeps playing through the visible controls (Roll, then
// moves via the board's keyboard mirror: arrow keys + Enter), so dice, marker slides, strikes and
// the rival's turns keep the table animating.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForSelector('#m-play', { state: 'visible', timeout: 15000 });
  await page.click('#m-settings');
  await page.waitForSelector('#s-gfx-section', { state: 'visible' });
  await page.selectOption('#s-quality', preset);
  await page.waitForFunction((p) => document.body.dataset.gfxPreset === p, preset);
  await page.click('#s-back');
  await page.waitForSelector('#m-play', { state: 'visible' });
}

const probe = (page) => page.evaluate(() => {
  const $ = (s) => document.querySelector(s);
  const btns = [...document.querySelectorAll('#bb-board-mirror button')];
  return {
    results: !!$('#r-menu'), cubeOpen: !$('#bb-cube-overlay')?.hidden,
    turn: $('#bb-turn-indicator')?.textContent || '', rollEnabled: !$('#bb-btn-roll')?.disabled,
    passEnabled: !$('#bb-btn-pass')?.disabled, live: $('#bb-live')?.textContent || '',
    mirror: btns.map((b) => ({ text: b.textContent, origin: b.dataset.origin === '1' })),
    focus: btns.indexOf(document.activeElement),
  };
});

async function activate(page, idx, count) {
  let cur = (await probe(page)).focus;
  const fwd = (idx - cur + count) % count, back = (cur - idx + count) % count;
  const [key, n] = fwd <= back ? ['ArrowRight', fwd] : ['ArrowLeft', back];
  for (let i = 0; i < n; i++) await page.keyboard.press(key);
  await page.keyboard.press('Enter');
}

export async function start(page) {
  await page.click('#m-play');
  await page.waitForFunction(() => /to (roll|move)/.test(document.querySelector('#bb-turn-indicator')?.textContent || ''), null, { timeout: 15000 });
  let stopped = false;
  page.once('close', () => { stopped = true; });
  (async () => {
    while (!stopped) {
      try {
        const p = await probe(page);
        if (p.results) { await page.click('#r-menu'); await page.click('#m-play'); }
        else if (p.cubeOpen) await page.click('#bb-btn-accept');
        else if (/You to roll/.test(p.turn) && p.rollEnabled) await page.click('#bb-btn-roll');
        else if (/You to move/.test(p.turn)) {
          const o = p.mirror.findIndex((b) => b.origin);
          if (o < 0) { if (p.passEnabled) await page.click('#bb-btn-pass'); }
          else {
            await activate(page, o, p.mirror.length);
            await page.waitForTimeout(150);
            const sel = (await probe(page)).live;
            const tail = sel.split(/targets?:/i)[1] || '';
            const targets = [...tail.matchAll(/point (\d+)/gi)].map((m) => Number(m[1]) - 1);
            const t = /bear off/i.test(tail) ? p.mirror.findIndex((b) => /^Bear-off tray/.test(b.text)) : Math.min(...targets);
            if (Number.isFinite(t) && t >= 0) await activate(page, t, p.mirror.length);
          }
        }
      } catch { /* closing or mid-animation */ }
      await new Promise((r) => setTimeout(r, 250));
    }
  })();
  await page.waitForTimeout(500);
}
