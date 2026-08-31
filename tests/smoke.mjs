// Bearing Board — smoke test: boot the real server entry point, verify the
// launch path, every client asset, the time API, and one authoritative
// session round-trip. Exits non-zero on any failure.
import { spawn } from 'node:child_process';

const PORT = 8391;
const base = `http://127.0.0.1:${PORT}`;
const failures = [];

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const child = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => process.stderr.write(d));

async function waitForServer(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${base}/api/v1/time`);
      if (r.ok) return true;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

try {
  check('server boots', await waitForServer());

  const index = await fetch(`${base}/`);
  const html = await index.text();
  check('launch file serves HTML', index.ok && html.includes('bb-root'));

  for (const p of ['/js/main.js', '/js/rules.js', '/js/ai.js', '/js/content.js', '/js/audio.js', '/css/main.css', '/vendor/three.module.min.js', '/favicon.svg', '/icon.png', '/starhermit.txt']) {
    const r = await fetch(`${base}${p}`);
    check(`asset ${p}`, r.ok);
  }

  const star = await (await fetch(`${base}/starhermit.txt`)).text();
  check('starhermit declares launch=index.html', /^launch=index\.html$/m.test(star));
  check('starhermit declares server=server.js', /^server=server\.js$/m.test(star));
  check('starhermit declares name', /^name=Bearing Board$/m.test(star));

  const t = await (await fetch(`${base}/api/v1/time`)).json();
  check('time API sane', Math.abs(t.epochMs - Date.now()) < 10000);

  const created = await (await fetch(`${base}/api/v1/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cfg: { id: 'smoke', version: 1, ruleset: 'duel', players: 2, seed: 5, options: {} } }),
  })).json();
  check('session created', !!created.sessionId);

  const rolled = await (await fetch(`${base}/api/v1/sessions/${created.sessionId}/commands`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd: { type: 'roll', player: 0, id: 'smoke-1' } }),
  })).json();
  check('authoritative roll', rolled.state?.dice?.length === 2);

  const replay = await (await fetch(`${base}/api/v1/sessions/${created.sessionId}/replay`)).json();
  check('replay envelope', Array.isArray(replay.hashes) && replay.hashes.length >= 2);
} catch (err) {
  check('smoke run', false, err.message);
} finally {
  child.kill();
}

if (failures.length) {
  console.error(`SMOKE FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('SMOKE OK');
