// Byte ranges on the media route (22 Aug 2026).
//
// Found while trying to look at frame 18 of a 31-second cut: the route
// streamed whole files and answered no Range header, so no browser could seek
// anything it served. Setting currentTime silently did nothing and the element
// sat at frame zero. Every video in the app was unscrubbable, the rough-cut
// player included, which is the one place a producer most needs to jump to a
// moment and look at it. It presented as "the player is broken" and went
// unfixed because nothing errored; it simply refused to move.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.LCOS_AI_PROVIDER = 'MOCK';
process.env.LCOS_ADAPTER_MODE = 'MOCK';
const dir = await mkdtemp(join(tmpdir(), 'lcos-range-'));
process.env.LCOS_STORAGE_DIR = dir;

const { buildServer } = await import('../src/server.mjs');
const { pool } = await import('../src/core.mjs');

let app, token;
const BODY = Buffer.from('0123456789abcdefghijABCDEFGHIJ'); // 30 bytes, positions readable by eye
before(async () => {
  app = await buildServer();
  token = (await app.inject({ method: 'POST', url: '/api/v1/auth/login',
    payload: { email: 'producer@letena.local', password: 'letena-dev-2026' } })).json().token;
  await writeFile(join(dir, 'clip.mp4'), BODY);
});
after(async () => { await app.close(); await pool.end(); });

const get = (headers = {}) => app.inject({ method: 'GET',
  url: `/api/v1/media/clip.mp4?token=${encodeURIComponent(token)}`, headers });

test('a plain request still returns the whole file, with its length', async () => {
  const r = await get();
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['content-length'], String(BODY.length));
  assert.equal(r.rawPayload.toString(), BODY.toString());
});

test('every response advertises that ranges are accepted', async () => {
  assert.equal((await get()).headers['accept-ranges'], 'bytes');
});

test('a range returns 206 with exactly those bytes', async () => {
  const r = await get({ range: 'bytes=10-19' });
  assert.equal(r.statusCode, 206);
  assert.equal(r.headers['content-range'], `bytes 10-19/${BODY.length}`);
  assert.equal(r.headers['content-length'], '10');
  assert.equal(r.rawPayload.toString(), 'abcdefghij');
});

test('an open-ended range runs to the end of the file', async () => {
  const r = await get({ range: 'bytes=20-' });
  assert.equal(r.statusCode, 206);
  assert.equal(r.rawPayload.toString(), 'ABCDEFGHIJ');
  assert.equal(r.headers['content-range'], `bytes 20-29/${BODY.length}`);
});

test('a suffix range means the LAST n bytes, not the first n', async () => {
  const r = await get({ range: 'bytes=-5' });
  assert.equal(r.statusCode, 206);
  assert.equal(r.rawPayload.toString(), 'FGHIJ',
    'reading this backwards serves the wrong part of the file under a 206, which looks like corruption');
  assert.equal(r.headers['content-range'], `bytes 25-29/${BODY.length}`);
});

test('an end past the file is clamped rather than refused', async () => {
  const r = await get({ range: 'bytes=25-9999' });
  assert.equal(r.statusCode, 206);
  assert.equal(r.rawPayload.toString(), 'FGHIJ');
  assert.equal(r.headers['content-range'], `bytes 25-29/${BODY.length}`);
});

test('a start past the file is 416, and says how big the file really is', async () => {
  const r = await get({ range: 'bytes=99-100' });
  assert.equal(r.statusCode, 416);
  assert.equal(r.headers['content-range'], `bytes */${BODY.length}`);
});

test('a backwards range is 416, not a silent empty body', async () => {
  const r = await get({ range: 'bytes=20-10' });
  assert.equal(r.statusCode, 416);
});

test('a malformed range is 416 rather than quietly serving everything', async () => {
  for (const bad of ['bytes=', 'bytes=abc-def', 'seconds=1-2', 'bytes=1-2, 5-6']) {
    const r = await get({ range: bad });
    assert.equal(r.statusCode, 416, `${bad} should be refused, not answered with the whole file`);
  }
});

test('ranges do not weaken the token check', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/v1/media/clip.mp4?token=nonsense',
    headers: { range: 'bytes=0-5' } });
  assert.equal(r.statusCode, 401);
});

test('range handling does not open a path out of the storage root', async () => {
  // Two shapes, because they fail at different layers and both must fail. A
  // literal ../ is normalised by the router before the route ever matches, so
  // it lands outside /api/v1/media and the auth hook turns it away; a
  // percent-encoded one reaches the route and is refused by resolving against
  // the storage root. A range header must not change either answer.
  for (const path of ['../../etc/passwd', '..%2f..%2fetc%2fpasswd', '%2e%2e%2f%2e%2e%2fetc%2fpasswd']) {
    const r = await app.inject({ method: 'GET',
      url: `/api/v1/media/${path}?token=${encodeURIComponent(token)}`,
      headers: { range: 'bytes=0-5' } });
    assert.ok([400, 401, 404].includes(r.statusCode),
      `${path} should be refused, got ${r.statusCode}`);
    assert.doesNotMatch(r.rawPayload.toString().slice(0, 200), /root:/,
      `${path} must never return the contents of a file outside the store`);
  }
});
