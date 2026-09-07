/**
 * Bearing Board — end-to-end playthrough test (dev only, not shipped).
 *
 * Drives the real visible UI in headless Chrome via playwright-core:
 *   title → settings (enable reduced motion) → "Play now" practice duel
 *   vs the steady AI → roll/move through the HUD buttons and the game's
 *   documented keyboard path (arrow-key roving focus over the on-screen
 *   board controls, Enter to confirm — the same path keyboard players use)
 *   → full game to the results screen, then back to the menu.
 * Also exercises pause/resume, pause→settings→back, undo, hint, and the
 * stakes-cube accept dialog when the AI offers it.
 *
 * Board moves go through #bb-board-mirror buttons: these are the DOM
 * equivalents of the canvas board controls (the canvas itself is a WebGL
 * raycast surface); the game ships arrow-key navigation + Enter explicitly
 * for them (see Settings → Keyboard bindings). All reads of game state are
 * taken from visible HUD/mirror DOM text, used only for synchronization.
 *
 * Self-contained: starts its own static file server on an ephemeral port
 * (server.js is the StarHermit authoritative game server, not used here).
 * Runs two passes — desktop 1280×800 and mobile 390×844 (touch) — and
 * fails loudly on any non-benign console error or pageerror.
 *
 * Run: npm run test:e2e
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = normalize(join(fileURLToPath(import.meta.url), '..', '..'));
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
  '.ts': 'video/mp2t',
  '.txt': 'text/plain; charset=utf-8',
};

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      // Platform API probe: answer with a non-time payload so the game takes
      // its documented offline path (platform.available stays false) without
      // producing 404 console noise.
      if (url.pathname.startsWith('/api/v1/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      let path = normalize(decodeURIComponent(url.pathname));
      if (path === '/' || path === '\\') path = '/index.html';
      const file = join(ROOT, path);
      if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch (_) {
      res.writeHead(404); res.end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const step = async (name, fn) => {
  await fn();
  console.log(`ok - ${name}`);
};

async function runPass(browser, tag, viewport, hasTouch, base, errors) {
  const context = await browser.newContext({ viewport, hasTouch, isMobile: hasTouch });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`[${tag}] pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !browserNoise.test(m.text())) errors.push(`[${tag}] console: ${m.text()}`);
  });
  const shot = (stage) => page.screenshot({ path: `/tmp/bearing-board-e2e-${stage}-${tag}.png` });

  // --- state probe: only visible HUD / mirror DOM, for synchronization ----
  const probe = () => page.evaluate(() => {
    const $ = (s) => document.querySelector(s);
    const mirrorBtns = [...document.querySelectorAll('#bb-board-mirror button')];
    return {
      results: !!$('#r-menu'),
      cubeOpen: !$('#bb-cube-overlay')?.hidden,
      pauseOpen: !$('#bb-pause-overlay')?.hidden,
      turn: $('#bb-turn-indicator')?.textContent || '',
      progress: $('#bb-rail-progress')?.textContent?.replace(/\s+/g, ' ').trim() || '',
      rollEnabled: !$('#bb-btn-roll')?.disabled,
      passEnabled: !$('#bb-btn-pass')?.disabled,
      undoEnabled: !$('#bb-btn-undo')?.disabled,
      hintEnabled: !$('#bb-btn-hint')?.disabled,
      live: $('#bb-live')?.textContent || '',
      mirror: mirrorBtns.map((b) => ({ text: b.textContent, origin: b.dataset.origin === '1' })),
      focusIdx: mirrorBtns.indexOf(document.activeElement),
    };
  });

  // Move keyboard focus onto mirror button `idx` using the game's roving
  // focus bindings (ArrowRight/ArrowLeft), then confirm with Enter.
  // Focus movement is deterministic (wraps modulo the button count), so the
  // arrow run is sent in one batch and verified once at the end.
  const focusIndex = () => page.evaluate(
    () => [...document.querySelectorAll('#bb-board-mirror button')].indexOf(document.activeElement),
  );
  async function activateMirrorButton(idx, count) {
    let cur = await focusIndex();
    if (cur !== idx) {
      const n = count;
      const fwd = (idx - cur + n) % n;
      const back = (cur - idx + n) % n;
      const [key, presses] = fwd <= back ? ['ArrowRight', fwd] : ['ArrowLeft', back];
      for (let i = 0; i < presses; i++) await page.keyboard.press(key);
      cur = await focusIndex();
      if (cur !== idx) throw new Error(`could not focus mirror button ${idx} (at ${cur})`);
    }
    await page.keyboard.press('Enter');
  }

  await step(`[${tag}] load + title visible`, async () => {
    await page.goto(base, { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('#m-play', { state: 'visible', timeout: 15000 });
    if (!(await page.locator('#bb-canvas').isVisible()) && await page.locator('#bb-webgl-fallback').isVisible()) {
      throw new Error('WebGL fallback shown — renderer failed to boot');
    }
    await shot('title');
  });

  await step(`[${tag}] settings open/close + reduced motion`, async () => {
    await page.click('#m-settings');
    await page.waitForSelector('#s-back', { state: 'visible' });
    const rm = page.locator('#s-rm');
    if (!(await rm.isChecked())) await rm.click(); // faster AI + results; also exercises a control
    await page.selectOption('#s-quality', 'low'); // cheap rendering under swiftshader
    await shot('settings');
    await page.click('#s-back');
    await page.waitForSelector('#m-play', { state: 'visible' });
  });

  await step(`[${tag}] start practice duel via Play now`, async () => {
    await page.click('#m-play');
    await page.waitForFunction(
      () => /to (roll|move)/.test(document.querySelector('#bb-turn-indicator')?.textContent || ''),
      null, { timeout: 15000 },
    );
  });

  // --- pause / resume / pause-settings, done once early in the game -------
  let pauseTested = false;
  async function maybeTestPause() {
    if (pauseTested) return;
    pauseTested = true;
    await page.click('#bb-btn-pause');
    await page.waitForSelector('#bb-pause-overlay:not([hidden])');
    await shot('pause');
    await page.click('#bb-btn-pause-settings');
    await page.waitForSelector('#s-back', { state: 'visible' });
    await page.click('#s-back');
    await page.waitForSelector('#bb-pause-overlay:not([hidden])'); // returns to paused game
    await page.click('#bb-btn-resume');
    await page.waitForSelector('#bb-pause-overlay', { state: 'hidden' });
  }

  // --- play the full game --------------------------------------------------
  let undoTested = false;
  let hintTested = false;
  let cubeSeen = false;
  let movesMade = 0;
  let midShotTaken = false;
  let lastProgress = '';
  let selectFails = 0;

  await step(`[${tag}] play duel to results screen`, async () => {
    const deadline = Date.now() + 12 * 60 * 1000;
    const t0 = Date.now();
    for (;;) {
      const iterStart = Date.now();
      if (Date.now() > deadline) throw new Error('game did not reach results within 12 minutes');
      const p = await probe();
      if (p.results) break;
      if (p.progress && p.progress !== lastProgress) {
        lastProgress = p.progress;
        console.log(`  [${tag}] +${((Date.now() - t0) / 1000).toFixed(0)}s ${p.progress}`);
      }

      if (p.cubeOpen) {
        cubeSeen = true;
        console.log(`  [${tag}] stakes offered by rival — accepting`);
        await page.click('#bb-btn-accept');
        await page.waitForTimeout(300);
        continue;
      }
      if (p.pauseOpen) { // e.g. backgrounding auto-pause
        await page.click('#bb-btn-resume');
        await page.waitForTimeout(200);
        continue;
      }

      if (/You to roll/.test(p.turn)) {
        if (p.rollEnabled) {
          await page.click('#bb-btn-roll');
          await page.waitForTimeout(300);
          if (!pauseTested) await maybeTestPause();
        } else {
          await page.waitForTimeout(250);
        }
        continue;
      }

      if (/You to move/.test(p.turn)) {
        if (!hintTested && p.hintEnabled) {
          hintTested = true;
          await page.click('#bb-btn-hint');
          await page.waitForSelector('#bb-toast:not([hidden])');
          const hintText = (await page.textContent('#bb-toast')).trim();
          if (!hintText) throw new Error('hint produced no toast text');
          console.log(`  [${tag}] hint: ${hintText}`);
        }
        // Pick a legal origin: marked point buttons first. If none, prefer
        // Pass when enabled (no legal moves — e.g. rail re-entry blocked);
        // only try the rail button while moves actually exist.
        let originIdx = p.mirror.findIndex((b) => b.origin);
        if (originIdx < 0 && !p.passEnabled) {
          const railIdx = p.mirror.findIndex((b) => /^Rail: [1-9]/.test(b.text));
          if (railIdx >= 0) originIdx = railIdx;
        }
        if (originIdx < 0) {
          if (p.passEnabled) {
            console.log(`  [${tag}] no legal move — passing`);
            await page.click('#bb-btn-pass');
            await page.waitForTimeout(300);
            continue;
          }
          await page.waitForTimeout(250);
          continue;
        }
        const prevLive = p.live;
        await activateMirrorButton(originIdx, p.mirror.length); // select origin
        // selectOrigin announces via rAF; wait for the live region to change
        // (identical re-announcement is fine — fall through after timeout).
        await page.waitForFunction(
          (prev) => {
            const t = document.querySelector('#bb-live')?.textContent || '';
            return t && t !== prev;
          },
          prevLive, { timeout: 3000 },
        ).catch(() => {});
        const sel = (await probe()).live;
        if (!sel.startsWith('Selected')) { // rejected origin — re-probe
          selectFails += 1;
          if (selectFails >= 10) {
            throw new Error(`selection keeps failing (turn="${p.turn}", live="${sel}", origins=${p.mirror.map((b, i) => b.origin ? i : -1).filter((i) => i >= 0)})`);
          }
          continue;
        }
        selectFails = 0;
        // Parse only the "Targets: ..." tail (the origin itself is "point N" too).
        const targetText = sel.split(/targets?:/i)[1] || '';
        const targets = [...targetText.matchAll(/point (\d+)/gi)].map((m) => Number(m[1]) - 1);
        const bearOff = /bear off/i.test(targetText);
        // Prefer bearing off (finishes faster), else the most advanced target.
        const targetIdx = bearOff
          ? p.mirror.findIndex((b) => /^Bear-off tray/.test(b.text))
          : Math.min(...targets);
        if (targetIdx == null || targetIdx < 0) throw new Error(`no target parsed from "${sel}"`);
        await activateMirrorButton(targetIdx, p.mirror.length); // commit the move
        await page.waitForTimeout(180);
        movesMade += 1;

        // Undo becomes available once a second roll checkpoint exists
        // (i.e. from our second turn onward); exercise it once, for real.
        if (!undoTested) {
          const q = await probe();
          if (q.undoEnabled) {
            undoTested = true;
            await page.click('#bb-btn-undo');
            await page.waitForTimeout(300);
            const after = await probe();
            if (!/You to roll/.test(after.turn)) throw new Error('undo did not return to roll phase');
            console.log(`  [${tag}] undo restored pre-roll state`);
          }
        }
        if (!midShotTaken && movesMade >= 3) {
          midShotTaken = true;
          await shot('midgame');
        }
        continue;
      }

      await page.waitForTimeout(250); // rival thinking / animations
      const iterMs = Date.now() - iterStart;
      if (iterMs > 2000) console.log(`  [${tag}] slow iteration: ${iterMs}ms (turn="${p.turn}")`);
    }
    console.log(`  [${tag}] moves made: ${movesMade}, cube offered: ${cubeSeen}`);
    if (movesMade < 5) throw new Error(`suspiciously few moves played (${movesMade})`);
    if (!pauseTested || !undoTested || !hintTested) {
      throw new Error(`coverage missing: pause=${pauseTested} undo=${undoTested} hint=${hintTested}`);
    }
  });

  await step(`[${tag}] results screen + back to menu`, async () => {
    await page.waitForSelector('#r-menu', { state: 'visible', timeout: 10000 });
    const headline = (await page.locator('#bb-screen h1').first().textContent()).trim();
    const rows = await page.locator('.bb-score-table tbody tr').count();
    if (rows < 1) throw new Error('results screen has no score breakdown rows');
    console.log(`  [${tag}] headline: ${headline} (${rows} breakdown rows)`);
    await shot('results');
    await page.click('#r-menu');
    await page.waitForSelector('#m-play', { state: 'visible', timeout: 10000 });
  });

  await context.close();
}

const { server, port } = await startServer();
const base = `http://127.0.0.1:${port}`;
console.log(`serving ${ROOT} on ${base}`);
let browser = null;
const errors = [];
try {
  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });
  await runPass(browser, 'desktop', { width: 1280, height: 800 }, false, base, errors);
  if (errors.length) throw new Error('errors after desktop pass:\n' + errors.join('\n'));
  await runPass(browser, 'mobile', { width: 390, height: 844 }, true, base, errors);
  if (errors.length) throw new Error('page errors:\n' + errors.join('\n'));
  console.log('\nE2E PASS — bearing-board, desktop + mobile, no page errors');
} finally {
  await browser?.close();
  server.close();
}
