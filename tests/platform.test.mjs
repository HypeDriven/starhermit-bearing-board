// StarHermit account tests: the SDK runs in a sandbox with a stubbed fetch
// and launch fragment; js/account.js drives it. Run: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAccount } from '../js/account.js';
import { ACCOUNT_STRINGS, LOCALES } from '../js/gfx-strings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SLUG = 'bearing-board';
const USER = 'a1b2c3d4-0000-4000-8000-000000000001';
const b64url = (s) => Buffer.from(s).toString('base64url');
const jwt = (claims) => `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify(claims))}.sig`;
const plain = (v) => JSON.parse(JSON.stringify(v));

function boot({ hash = '' } = {}) {
  const calls = [];
  const cloud = { bytes: null };
  const kv = { theme: 'harbor' };
  const ctx = {
    URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa, Blob, Response, console,
    setTimeout: (fn, ms) => (ms > 5000 ? 0 : setTimeout(fn, ms)),
    clearTimeout: (id) => { if (id) clearTimeout(id); },
    location: { hash, search: '', pathname: '/', hostname: 'localhost', origin: 'http://localhost', href: `http://localhost/${hash}` },
    history: { state: null, replaceState(_s, _t, url) { ctx.location.hash = url.includes('#') ? url.slice(url.indexOf('#')) : ''; } },
  };
  ctx.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers?.Authorization });
    const u = decodeURIComponent(url);
    if (u.endsWith(`/api/v1/users/${USER}/profile`)) return Response.json({ nickname: 'Rollo' });
    if (u.endsWith(`/cloud-saves/game:${SLUG}`)) {
      if (method === 'PUT') { cloud.bytes = Buffer.from(JSON.parse(init.body).dataBase64, 'base64'); return new Response(null, { status: 204 }); }
      return cloud.bytes ? new Response(cloud.bytes) : new Response('', { status: 404 });
    }
    if (u.endsWith(`/games/${SLUG}/settings`)) {
      if (method === 'PATCH') Object.assign(kv, JSON.parse(init.body).settings);
      return Response.json({ settings: kv });
    }
    if (u.endsWith(`/games/${SLUG}/controls`)) return Response.json({ actions: [{ action: 'roll', codes: ['Space'] }] });
    return new Response('', { status: 404 });
  };
  ctx.self = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'starhermit-sdk.js'), 'utf8'), ctx, { filename: 'starhermit-sdk.js' });
  ctx.StarHermit.init();
  return { ctx, calls, cloud, kv, SH: ctx.StarHermit, acc: createAccount(ctx.StarHermit) };
}

const KEYS = { roll: ['KeyR'], undo: ['KeyU'] };

test('standalone: no token, no network', async () => {
  const { acc, calls } = boot();
  assert.equal(acc.signedIn, false);
  assert.equal(await acc.start(KEYS), null);
  assert.equal(acc.saveCloud({ data: {} }), false);
  assert.equal(acc.mirrorSettings({ theme: 'x' }), null);
  await acc.flush();
  assert.equal(acc.inviteLink(), null);
  assert.equal(acc.canSignIn(), false);
  assert.equal(calls.length, 0);
});

test('launch token: identity, cloud save game:<slug>, settings patch, bindings', async () => {
  const token = jwt({ sub: USER, game_scope: SLUG, exp: Math.floor(Date.now() / 1000) + 3600 });
  const { acc, SH, ctx, calls, cloud, kv } = boot({ hash: `#game_token=${token}&session_id=s1` });
  assert.equal(acc.signedIn, true);
  assert.equal(SH.slug, SLUG);
  assert.equal(SH.userId, USER);
  assert.equal(ctx.location.hash, '', 'launch fragment stripped');

  const r = await acc.start(KEYS);
  assert.equal((await r.profile).displayName, 'Rollo');
  assert.equal(r.remote, null);
  assert.deepEqual(plain(r.settings), { theme: 'harbor' });
  assert.deepEqual(plain(r.bindings), { roll: ['Space'], undo: ['KeyU'] });

  await acc.mirrorSettings({ theme: 'harbor', haptics: false });
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.ok(patch.url.endsWith(`/api/v1/games/${SLUG}/settings`));
  assert.deepEqual(patch.body, { settings: { haptics: false } });
  assert.equal(kv.haptics, false);

  const doc = { data: { stats: { wins: 3 } }, check: 'abc' };
  assert.equal(acc.saveCloud(doc), true);
  assert.equal(await acc.flush(), true);
  const put = calls.find((c) => c.method === 'PUT');
  assert.equal(decodeURIComponent(put.url), `/api/v1/me/cloud-saves/game:${SLUG}`);
  assert.ok(calls.every((c) => c.auth === `Bearer ${token}`));
  assert.ok(!calls.some((c) => /\/api\/v1\/me(\/|$)/.test(c.url) && !c.url.includes('cloud-saves')), 'never /api/v1/me');

  const again = boot({ hash: `#game_token=${token}` });
  again.cloud.bytes = cloud.bytes;
  assert.deepEqual(plain((await again.acc.start(KEYS)).remote), doc);
  assert.match(acc.inviteLink(), new RegExp(`/game-invite/${USER}/${SLUG}$`));
});

test('sign-out on refused renewal stops cloud writes', async () => {
  const token = jwt({ sub: USER, game_scope: SLUG, exp: Math.floor(Date.now() / 1000) + 3600 });
  const { acc, SH } = boot({ hash: `#game_token=${token}` });
  await acc.start(KEYS);
  const seen = [];
  acc.onAuth((a) => seen.push(a.signedIn));
  SH.signOut('expired');
  assert.deepEqual(seen, [false]);
  assert.equal(acc.signedIn, false);
  assert.equal(acc.saveCloud({ data: {} }), false);
});

test('account strings exist in every required locale', () => {
  for (const loc of LOCALES)
    for (const k of Object.keys(ACCOUNT_STRINGS['en-US'])) assert.ok(ACCOUNT_STRINGS[loc]?.[k], `${loc}.${k}`);
});
