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
import { mergeProgress } from '../js/progress.js';
import { STRINGS, LOCALES as UI_LOCALES } from '../js/i18n.js';
import * as Content from '../js/content.js';

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
      if (method === 'PUT') {
        if (cloud.conflict) { cloud.conflict = false; return Response.json({ etag: '"other"' }, { status: 412 }); }
        cloud.puts = (cloud.puts || 0) + 1;
        cloud.bytes = Buffer.from(JSON.parse(init.body).dataBase64, 'base64');
        return Response.json({ etag: `"v${cloud.puts}"` });
      }
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

test('save conflict: a refused write reloads the cloud copy for merging', async () => {
  const token = jwt({ sub: USER, game_scope: SLUG, exp: Math.floor(Date.now() / 1000) + 3600 });
  const { acc, SH, cloud } = boot({ hash: `#game_token=${token}` });
  const remotes = [];
  acc.onSaveConflict((doc) => remotes.push(doc));
  await acc.start(KEYS);
  acc.saveCloud({ data: { stats: { wins: 1 } }, check: 'a' }); await acc.flush();
  cloud.conflict = true;
  acc.saveCloud({ data: { stats: { wins: 2 } }, check: 'b' });
  const other = boot({ hash: `#game_token=${token}` });
  await other.acc.start(KEYS);
  const theirs = { data: { stats: { wins: 5 } }, check: 'c' };
  other.acc.saveCloud(theirs); await other.acc.flush();
  cloud.bytes = other.cloud.bytes;
  await acc.flush();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(remotes.length, 1);
  assert.deepEqual(plain(remotes[0]), theirs);
  assert.equal(SH.saveConflicted(), false, 'reload lifts the write block');
});

test('mergeProgress keeps the better record from each device', () => {
  const m = mergeProgress(
    { journey: { 'journey-01': { stars: 1, bestTurns: 50 }, 'journey-02': { stars: 2, bestTurns: 70 } }, lessons: { a: { done: true } },
      daily: { days: ['2026-10-01'], lastDay: '2026-10-01' }, achievements: { first_win: { at: '2026-10-02T00:00:00Z' } }, stats: { games: 9, wins: 1 } },
    { journey: { 'journey-01': { stars: 3, bestTurns: 60, goalsMet: true } }, challenges: { c: { done: true, best: 40 } },
      daily: { days: ['2026-10-03'], lastDay: '2026-10-03' }, achievements: { first_win: { at: '2026-10-01T00:00:00Z' } }, stats: { games: 4, wins: 3 } });
  assert.deepEqual(m.journey['journey-01'], { stars: 3, bestTurns: 50, goalsMet: true });
  assert.equal(m.journey['journey-02'].stars, 2);
  assert.equal(m.lessons.a.done, true);
  assert.deepEqual(m.challenges.c, { done: true, best: 40 });
  assert.deepEqual(m.daily, { days: ['2026-10-01', '2026-10-03'], lastDay: '2026-10-03' });
  assert.equal(m.achievements.first_win.at, '2026-10-01T00:00:00Z');
  assert.deepEqual(m.stats, { games: 9, wins: 3, hits: 0, sweeps: 0 });
});

test('every player-facing string and content name exists in all nine locales', () => {
  assert.deepEqual(UI_LOCALES, ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT']);
  const keys = Object.keys(STRINGS['en-US']);
  for (const loc of UI_LOCALES) {
    const T = STRINGS[loc];
    for (const k of keys) assert.ok(T[k], `${loc}.${k}`);
    for (const d of Content.JOURNEY) assert.ok(T[`j.${d.id}`] && T[`jb.${d.id}`], `${loc} ${d.id}`);
    for (const d of Content.LESSONS) {
      assert.ok(T[`l.${d.id}`] && T[`lb.${d.id}`], `${loc} ${d.id}`);
      d.tutorial.steps.forEach((_, i) => assert.ok(T[`ls.${d.id}.${i}`], `${loc} ${d.id}.${i}`));
    }
    for (const d of Content.CHALLENGES) assert.ok(T[`c.${d.id}`] && T[`cb.${d.id}`], `${loc} ${d.id}`);
    for (const a of Content.ACHIEVEMENTS) assert.ok(T[`ach.${a.key}`] && T[`ach.${a.key}.d`], `${loc} ${a.key}`);
    for (const th of Content.THEMES) assert.ok(T[`theme.${th.key}`], `${loc} ${th.key}`);
    Content.MASTERY_TIERS.forEach((_, i) => assert.ok(T[`tier.${i}`], `${loc} tier ${i}`));
  }
});
