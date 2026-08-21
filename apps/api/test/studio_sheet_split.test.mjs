// Breaking a reference sheet into its individual pictures (21 Aug 2026).
//
// Owner: "why dont you take the character and location reference and just
// break it down into the individual pieces so we can use whats needed".
//
// The whole sheet is a typeset document and can never go to an image model
// (see the comment in compose-first-frame). The pictures ON it are the
// useful part. Split finds each one, cuts it out without its caption, and
// records whether any lettering fell inside the crop. Only a piece that is
// purely a picture may condition a generation or become the lock's
// reference; a caption strip or a colour swatch is kept and shown, so a
// bad split is visible rather than silent, but is never used.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.LCOS_AI_PROVIDER = 'MOCK';
process.env.LCOS_ADAPTER_MODE = 'MOCK';
process.env.LCOS_STORAGE_DIR = '/tmp/lcos-sheetsplit-test-storage';

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
after(async () => {
  const r = await q(`SELECT code FROM lcos.assets WHERE code LIKE 'STUDIO-%' AND created_at >= $1`, [RUN_STARTED_AT]);
  const codes = r.rows.map(x => x.code);
  if (codes.length) {
    await q(`UPDATE studio.assets SET library_asset_id = NULL
             WHERE library_asset_id IN (SELECT id FROM lcos.assets WHERE code = ANY($1))`, [codes]);
    await q(`DELETE FROM lcos.asset_tags WHERE asset_id IN (SELECT id FROM lcos.assets WHERE code = ANY($1))`, [codes]);
    await q(`DELETE FROM lcos.assets WHERE code = ANY($1)`, [codes]);
  }
  await app.close();
  await pool.end();
});

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
let projectId, charLockId, envLockId, sheetId, panels;

test('set up a lock with a sheet on it', async () => {
  projectId = (await call('POST', '/studio/projects',
    { title: 'Sheet split test', format: 'explainer', aspect_ratio: '9:16', language: 'am' })).json().id;
  charLockId = (await call('POST', `/studio/projects/${projectId}/locks`,
    { level: 'L1_ENTITY', entity_type: 'CHARACTER', entity_code: 'CHR-SPLIT', data: { name: 'Split' } })).json().id;
  envLockId = (await call('POST', `/studio/projects/${projectId}/locks`,
    { level: 'L1_ENTITY', entity_type: 'ENVIRONMENT', entity_code: 'ENV-SPLIT', data: { architecture: 'a room' } })).json().id;
  const r = await call('POST', `/studio/locks/${charLockId}/reference-pack`,
    { sheets: [{ sheet_kind: 'TURNAROUND', image_base64: PNG, note: 'the ChatGPT sheet' }] });
  sheetId = r.json().saved[0].id;
});

test('splitting cuts the sheet into pieces and says which are clean', async () => {
  const r = await call('POST', `/studio/locks/${charLockId}/reference-pack/${sheetId}/split`, {});
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  panels = body.saved;
  assert.equal(panels.length, 3, 'the mock vision pass returns two pictures and one title block');
  assert.equal(body.usable_count, 2, 'the title block is kept but is not usable');
  const title = panels.find(p => p.use === 'TEXT_BLOCK');
  assert.ok(title, 'a block of pure type must be recorded, not silently dropped');
  assert.equal(title.usable_as_reference, false);
});

test('the sheet itself is untouched and still in the pack', async () => {
  const pack = (await call('GET', `/studio/locks/${charLockId}/reference-pack`)).json();
  assert.equal(pack.items.length, 1, 'splitting adds pieces, it does not consume the sheet');
  assert.equal(pack.items[0].id, sheetId);
  assert.equal(pack.items[0].panels.length, 3, 'the pieces hang off the sheet they came from');
});

test('a piece never quietly becomes the lock\'s reference', async () => {
  const lock = await one(`SELECT reference_asset_ids FROM studio.locks WHERE id=$1`, [charLockId]);
  assert.equal(lock.reference_asset_ids.length, 0,
    'cutting a sheet up is not the same as choosing which piece to use');
});

test('choosing a clean piece makes it the current reference', async () => {
  const clean = panels.find(p => p.usable_as_reference);
  const r = await call('POST', `/studio/locks/${charLockId}/reference/select`, { asset_id: clean.id });
  assert.equal(r.statusCode, 200, r.body);
  const lock = await one(`SELECT reference_asset_ids FROM studio.locks WHERE id=$1`, [charLockId]);
  assert.deepEqual(lock.reference_asset_ids, [clean.id]);
});

test('choosing a piece with lettering in it is refused, and says why', async () => {
  const dirty = panels.find(p => !p.usable_as_reference);
  const r = await call('POST', `/studio/locks/${charLockId}/reference/select`, { asset_id: dirty.id });
  assert.equal(r.statusCode, 422);
  assert.equal(r.json().guard, 'panelHasText');
  assert.match(r.json().detail, /lettering/);
});

test('a sheet belonging to another lock cannot be split onto this one', async () => {
  const r = await call('POST', `/studio/locks/${envLockId}/reference-pack/${sheetId}/split`, {});
  assert.equal(r.statusCode, 422);
  assert.match(r.json().detail, /does not belong to this lock/);
});

test('an asset that is not a pack sheet cannot be split', async () => {
  const ref = (await call('POST', `/studio/locks/${envLockId}/reference/upload`, { image_base64: PNG })).json();
  const r = await call('POST', `/studio/locks/${envLockId}/reference-pack/${ref.id}/split`, {});
  assert.equal(r.statusCode, 422);
});

test('splitting again adds a second set rather than replacing the first', async () => {
  const r = await call('POST', `/studio/locks/${charLockId}/reference-pack/${sheetId}/split`, {});
  assert.equal(r.statusCode, 200, r.body);
  const pack = (await call('GET', `/studio/locks/${charLockId}/reference-pack`)).json();
  assert.equal(pack.items[0].panels.length, 6, 'append-only, same as every other reference mechanism here');
});

test('composing a first frame conditions on a clean piece, never the sheet', async () => {
  await call('POST', `/studio/locks/${charLockId}/approve`, {});
  await call('POST', `/studio/locks/${envLockId}/approve`, {});
  const shot = (await call('POST', `/studio/projects/${projectId}/shots`,
    { shot_code: 'SH-SPLIT', order_index: 0, duration_target_s: 5, story: { beat: 'conditioning' },
      continuity: { characters: ['CHR-SPLIT'], environment: 'ENV-SPLIT' },
      generation: { mode_preference: 'image_to_video' } })).json();
  const r = await call('POST', `/studio/shots/${shot.id}/compose-first-frame`, {});
  assert.equal(r.statusCode, 200, r.body);
  // The MOCK Gemini adapter writes the reference count into the file it
  // produces, which is the only honest way to check this without a provider.
  const { storage } = await import('../src/adapters/index.mjs');
  const { readFile } = await import('node:fs/promises');
  const body = (await readFile(storage.localPath(r.json().asset.storage_key))).toString();
  assert.match(body, /refs=3/, 'two lock references plus exactly one clean piece');
});
