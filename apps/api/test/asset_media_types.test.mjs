// Uploaded-asset extension and media Content-Type (21 Aug 2026).
//
// Found while installing the house background track: a 2.9MB audio/mpeg
// upload succeeded, stored byte-identically, and then would not play in the
// asset library's <audio> tag. Two bugs, one symptom.
//
//   1. modules/assets.mjs derived the stored file's extension from the mime
//      SUBTYPE, sliced to four characters: audio/mpeg -> ".mpeg" (and
//      image/svg+xml -> ".svg+", video/quicktime -> ".quic"). It is only
//      correct for png/mp4/wav by coincidence.
//   2. The /api/v1/media/* route in server.mjs maps extension to
//      Content-Type and had no row for "mpeg", so it fell through to
//      application/octet-stream, which browsers will not decode as audio.
//
// Both halves are covered here, because fixing either alone leaves the track
// silent: files already on disk keep the extension they were written with.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.LCOS_AI_PROVIDER = 'MOCK';
process.env.LCOS_ADAPTER_MODE = 'MOCK';
process.env.LCOS_STORAGE_DIR = '/tmp/lcos-assetmedia-test-storage';

const { buildServer } = await import('../src/server.mjs');
const { pool, q, one } = await import('../src/core.mjs');

const RUN_STARTED_AT = new Date();
let app, token;
const login = async (email) => (await app.inject({ method: 'POST', url: '/api/v1/auth/login',
  payload: { email, password: 'letena-dev-2026' } })).json().token;
const call = (method, url, payload) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` }, payload });

before(async () => {
  app = await buildServer();
  token = await login('producer@letena.local');
});

// Same hygiene rule as the studio test files: lcos.assets is the SHARED
// library and the local test database persists between runs, so remove
// exactly the rows this file created.
after(async () => {
  const r = await q(`SELECT code FROM lcos.assets WHERE code LIKE 'AST-%' AND created_at >= $1
                     AND title LIKE 'mime ext test%'`, [RUN_STARTED_AT]);
  const codes = r.rows.map((x) => x.code);
  if (codes.length) {
    await q(`DELETE FROM lcos.asset_tags WHERE asset_id IN (SELECT id FROM lcos.assets WHERE code = ANY($1))`, [codes]);
    await q(`DELETE FROM lcos.assets WHERE code = ANY($1)`, [codes]);
  }
  await app.close();
  await pool.end();
});

// A one-frame silent mp3 is unnecessary; the upload path never decodes the
// bytes, it only files them. Any payload exercises the extension logic.
const BYTES = Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00test').toString('base64');

const upload = async (title, mime) => (await call('POST', '/production/assets',
  { title, kind: 'AUDIO_MUSIC', mime_type: mime, content_base64: BYTES })).json();

test('an audio/mpeg upload is stored as .mp3, not .mpeg', async () => {
  const a = await upload('mime ext test mpeg', 'audio/mpeg');
  assert.ok(a.storage_key.endsWith('.mp3'),
    `audio/mpeg must land on disk as .mp3 so the media route can type it; got ${a.storage_key}`);
});

test('the other mime types we accept get real extensions too', async () => {
  const cases = [
    ['image/svg+xml', '.svg'],
    ['video/quicktime', '.mov'],
    ['image/jpeg', '.jpg'],
    ['audio/mp4', '.m4a'],
  ];
  for (const [mime, ext] of cases) {
    const r = await call('POST', '/production/assets',
      { title: `mime ext test ${mime}`, kind: 'AUDIO_MUSIC', mime_type: mime, content_base64: BYTES });
    assert.equal(r.statusCode, 201, r.body);
    assert.ok(r.json().storage_key.endsWith(ext),
      `${mime} should store as ${ext}, got ${r.json().storage_key}`);
  }
});

test('an unlisted mime type still stores rather than failing', async () => {
  const a = await upload('mime ext test odd', 'application/x-weird-thing');
  assert.ok(a.storage_key, 'an unusual mime must not block the upload');
  assert.match(a.storage_key, /\.[a-z0-9]+$/, 'and must still get some sanitised extension');
});

test('the media route serves an .mp3 as audio/mpeg, not octet-stream', async () => {
  const a = await upload('mime ext test served', 'audio/mpeg');
  const r = await app.inject({ method: 'GET',
    url: `/api/v1/media/${a.storage_key}?token=${token}` });
  assert.equal(r.statusCode, 200, r.body);
  assert.match(r.headers['content-type'], /^audio\/mpeg/,
    'octet-stream here is what stopped the house track playing in the library');
});

test('a legacy file already on disk as .mpeg is still typed as audio', async () => {
  // The extension fix does not rewrite history. Anything uploaded before it
  // is sitting on disk as .mpeg, so the route's own table must cover it.
  const a = await upload('mime ext test legacy', 'audio/mpeg');
  const legacyKey = a.storage_key.replace(/\.mp3$/, '.mpeg');
  const { storage } = await import('../src/adapters/index.mjs');
  await storage.put(legacyKey, Buffer.from(BYTES, 'base64'));
  const r = await app.inject({ method: 'GET', url: `/api/v1/media/${legacyKey}?token=${token}` });
  assert.equal(r.statusCode, 200, r.body);
  assert.match(r.headers['content-type'], /^audio\/mpeg/);
});
