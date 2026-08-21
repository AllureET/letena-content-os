// The front end's cache stamp (22 Aug 2026).
//
// index.html loaded the app as `/app.js?v=9`, a version number a person was
// meant to bump by hand on every deploy. Nobody ever did. The failure mode
// is worse than a stale page: the API deploys and the browser does not, so
// someone is running old JavaScript against a new server and every screen
// looks like it ignored the fix that just shipped. An entire evening of
// "the viewer is not there" was this -- the code had been live on the
// server the whole time, three deploys earlier.
//
// The stamp is now a hash of app.js as it sits on disk. It changes when and
// only when the file changes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.LCOS_AI_PROVIDER = 'MOCK';
process.env.LCOS_ADAPTER_MODE = 'MOCK';
process.env.LCOS_STORAGE_DIR = '/tmp/lcos-cachebust-test-storage';

const { buildServer } = await import('../src/server.mjs');
const { pool } = await import('../src/core.mjs');

let app;
before(async () => { app = await buildServer(); });
after(async () => { await app.close(); await pool.end(); });

test('the served page asks for app.js with a real stamp, not a hand-typed number', async () => {
  const r = await app.inject({ method: 'GET', url: '/' });
  assert.equal(r.statusCode, 200);
  const m = r.body.match(/\/app\.js\?v=([a-z0-9]+)/);
  assert.ok(m, 'the page must still load the app with a cache-busting query');
  assert.equal(m[1].length, 12, 'a content hash, not a version somebody has to remember to change');
  assert.ok(!/\/app\.js\?v=9\b/.test(r.body), 'the stamp that never moved');
});

test('the stamp matches the app.js the same server hands out', async () => {
  const crypto = await import('node:crypto');
  const page = (await app.inject({ method: 'GET', url: '/' })).body;
  const js = (await app.inject({ method: 'GET', url: '/app.js' })).body;
  const expected = crypto.createHash('sha256').update(js).digest('hex').slice(0, 12);
  assert.ok(page.includes(`/app.js?v=${expected}`),
    'a stamp that does not match the file it stamps is worse than none');
});

test('app.js is still served as javascript', async () => {
  const r = await app.inject({ method: 'GET', url: '/app.js' });
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['content-type'], /javascript/);
});
