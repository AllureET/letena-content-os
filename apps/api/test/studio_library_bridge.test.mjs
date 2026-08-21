// Video Studio <-> Asset Library bridge tests (21 Aug 2026, owner request:
// "build the real preview/thumbnail... make the bridge so video studio
// images show up in the browsable library and so video studio can pick
// from library... reference images should be able to be seen from the
// preview and remixed through Gemini"). Covers, in MOCK mode:
//   - a generated lock reference mirrors into lcos.assets
//   - GET .../locks embeds reference_assets (what the frontend thumbnails)
//   - remixing an existing reference creates a new version and becomes
//     the lock's newest reference
//   - attaching an existing library asset to a lock without a new
//     generation
//   - uploading a caller-supplied image as a lock's reference
// Same login/token/call() pattern as studio.test.mjs; does not touch any
// existing test file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.LCOS_AI_PROVIDER = 'MOCK';
process.env.LCOS_ADAPTER_MODE = 'MOCK';
process.env.LCOS_STORAGE_DIR = '/tmp/lcos-libbridge-test-storage';

const { buildServer } = await import('../src/server.mjs');
const { pool, q, one } = await import('../src/core.mjs');

let app, token;
const login = async (email) => (await app.inject({ method: 'POST', url: '/api/v1/auth/login',
  payload: { email, password: 'letena-dev-2026' } })).json().token;
const call = (method, url, payload) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` }, payload });

before(async () => {
  app = await buildServer();
  token = await login('producer@letena.local');
});
after(async () => { await app.close(); await pool.end(); });

test('generated lock reference mirrors into lcos.assets, and shows up in GET .../locks', async () => {
  const proj = (await call('POST', '/studio/projects',
    { title: 'Library bridge test', format: 'explainer', aspect_ratio: '9:16', language: 'am' })).json();
  const lockRes = await call('POST', `/studio/projects/${proj.id}/locks`,
    { level: 'L1_ENTITY', entity_type: 'CHARACTER', entity_code: 'CHR-BRIDGE-TEST',
      data: { name: 'Bridge Test', silhouette: 'test subject', face: 'test face' } });
  assert.equal(lockRes.statusCode, 200, lockRes.body);
  const lock = lockRes.json();
  await call('POST', `/studio/locks/${lock.id}/approve`, {});

  const refRes = await call('POST', `/studio/locks/${lock.id}/reference`, {});
  assert.equal(refRes.statusCode, 200, refRes.body);
  const refAsset = refRes.json();
  assert.ok(refAsset.id, 'reference asset has an id');

  // The bridge should have mirrored this into lcos.assets and recorded the
  // mirror back onto the studio row.
  const studioRow = await one(`SELECT library_asset_id FROM studio.assets WHERE id=$1`, [refAsset.id]);
  assert.ok(studioRow.library_asset_id, 'studio asset got a library_asset_id');
  const libRow = await one(`SELECT kind, storage_key, is_ai_generated, is_active FROM lcos.assets WHERE id=$1`,
    [studioRow.library_asset_id]);
  assert.equal(libRow.kind, 'CHARACTER_REFERENCE');
  assert.equal(libRow.storage_key, refAsset.storage_key);
  assert.equal(libRow.is_ai_generated, true);
  assert.equal(libRow.is_active, true);

  // GET .../locks should embed reference_assets so the frontend can render
  // an actual thumbnail instead of just "has reference image" text.
  const locksRes = await call('GET', `/studio/projects/${proj.id}/locks`);
  assert.equal(locksRes.statusCode, 200);
  const gotLock = locksRes.json().items.find((l) => l.id === lock.id);
  assert.ok(gotLock, 'lock found in listing');
  assert.equal(gotLock.reference_assets.length, 1);
  assert.equal(gotLock.reference_assets[0].id, refAsset.id);
  assert.equal(gotLock.reference_assets[0].storage_key, refAsset.storage_key);

  // Library-candidates picker should also surface it for a CHARACTER lock.
  const candRes = await call('GET', `/studio/locks/library-candidates?entity_type=CHARACTER`);
  assert.equal(candRes.statusCode, 200);
  assert.ok(candRes.json().items.some((a) => a.id === studioRow.library_asset_id));
});

test('remixing an existing reference creates a new version and becomes the lock\'s current reference', async () => {
  const proj = (await call('POST', '/studio/projects',
    { title: 'Remix test', format: 'explainer', aspect_ratio: '9:16', language: 'am' })).json();
  const lock = (await call('POST', `/studio/projects/${proj.id}/locks`,
    { level: 'L1_ENTITY', entity_type: 'ENVIRONMENT', entity_code: 'ENV-REMIX-TEST',
      data: { architecture: 'test room', palette: 'blue' } })).json();
  const original = (await call('POST', `/studio/locks/${lock.id}/reference`, {})).json();

  const remixRes = await call('POST', `/studio/assets/${original.id}/remix`, { prompt: 'add a window' });
  assert.equal(remixRes.statusCode, 200, remixRes.body);
  const remixed = remixRes.json();
  assert.notEqual(remixed.id, original.id, 'remix produces a NEW asset, not an in-place edit');
  assert.equal(remixed.attached_to_lock.id, lock.id);

  const updatedLock = await one(`SELECT reference_asset_ids FROM studio.locks WHERE id=$1`, [lock.id]);
  assert.deepEqual(updatedLock.reference_asset_ids, [original.id, remixed.id],
    'both versions kept, newest last (append-only, matches every other reference_asset_ids write in this file)');

  const remixedRow = await one(`SELECT source_asset_id FROM studio.assets WHERE id=$1`, [remixed.id]);
  assert.equal(remixedRow.source_asset_id, original.id, 'remix lineage recorded');
});

test('remix rejects an asset that is not a REFERENCE_IMAGE or KEYFRAME', async () => {
  const proj = (await call('POST', '/studio/projects',
    { title: 'Remix guard test', format: 'explainer', aspect_ratio: '9:16', language: 'am' })).json();
  const music = await call('POST', `/studio/projects/${proj.id}/music`, { brief: { prompt: 'calm background bed' } });
  assert.equal(music.statusCode, 200, music.body);
  const rejectRes = await call('POST', `/studio/assets/${music.json().id}/remix`, { prompt: 'anything' });
  assert.equal(rejectRes.statusCode, 422);
});

test('attaching an existing library asset skips generation and becomes the reference', async () => {
  const proj = (await call('POST', '/studio/projects',
    { title: 'Attach test', format: 'explainer', aspect_ratio: '9:16', language: 'am' })).json();
  const lock = (await call('POST', `/studio/projects/${proj.id}/locks`,
    { level: 'L1_ENTITY', entity_type: 'CHARACTER', entity_code: 'CHR-ATTACH-TEST',
      data: { name: 'Attach Test' } })).json();

  const libRow = await one(
    `INSERT INTO lcos.assets (code, kind, origin, title, storage_key, mime_type, is_ai_generated, is_active)
     VALUES ($1, 'CHARACTER_REFERENCE', 'SHOT_IN_HOUSE', 'Pre-existing library photo',
       'assets/preexisting/photo.png', 'image/png', false, true) RETURNING id`,
    [`LIBTEST-${crypto.randomUUID().slice(0, 8).toUpperCase()}`]);

  const attachRes = await call('POST', `/studio/locks/${lock.id}/reference/attach`, { library_asset_id: libRow.id });
  assert.equal(attachRes.statusCode, 200, attachRes.body);
  const attached = attachRes.json();
  assert.equal(attached.storage_key, 'assets/preexisting/photo.png');
  assert.equal(attached.generator.provider, 'LIBRARY');

  const updatedLock = await one(`SELECT reference_asset_ids FROM studio.locks WHERE id=$1`, [lock.id]);
  assert.deepEqual(updatedLock.reference_asset_ids, [attached.id]);
});

test('attach rejects an unknown or inactive library asset', async () => {
  const proj = (await call('POST', '/studio/projects',
    { title: 'Attach guard test', format: 'explainer', aspect_ratio: '9:16', language: 'am' })).json();
  const lock = (await call('POST', `/studio/projects/${proj.id}/locks`,
    { level: 'L1_ENTITY', entity_type: 'CHARACTER', entity_code: 'CHR-ATTACH-GUARD',
      data: { name: 'Guard Test' } })).json();
  const r = await call('POST', `/studio/locks/${lock.id}/reference/attach`, { library_asset_id: crypto.randomUUID() });
  assert.equal(r.statusCode, 404);
});

test('uploading an image becomes the lock\'s reference and mirrors into the library', async () => {
  const proj = (await call('POST', '/studio/projects',
    { title: 'Upload test', format: 'explainer', aspect_ratio: '9:16', language: 'am' })).json();
  const lock = (await call('POST', `/studio/projects/${proj.id}/locks`,
    { level: 'L1_ENTITY', entity_type: 'ENVIRONMENT', entity_code: 'ENV-UPLOAD-TEST',
      data: { architecture: 'uploaded room' } })).json();

  const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const upRes = await call('POST', `/studio/locks/${lock.id}/reference/upload`,
    { image_base64: tinyPngBase64, mime_type: 'image/png' });
  assert.equal(upRes.statusCode, 200, upRes.body);
  const uploaded = upRes.json();
  assert.equal(uploaded.generator.provider, 'UPLOAD');

  const updatedLock = await one(`SELECT reference_asset_ids FROM studio.locks WHERE id=$1`, [lock.id]);
  assert.deepEqual(updatedLock.reference_asset_ids, [uploaded.id]);

  const studioRow = await one(`SELECT library_asset_id FROM studio.assets WHERE id=$1`, [uploaded.id]);
  assert.ok(studioRow.library_asset_id, 'uploaded reference also mirrored into the library');
});

test('upload rejects missing image data', async () => {
  const proj = (await call('POST', '/studio/projects',
    { title: 'Upload guard test', format: 'explainer', aspect_ratio: '9:16', language: 'am' })).json();
  const lock = (await call('POST', `/studio/projects/${proj.id}/locks`,
    { level: 'L1_ENTITY', entity_type: 'CHARACTER', entity_code: 'CHR-UPLOAD-GUARD',
      data: { name: 'Guard' } })).json();
  const r = await call('POST', `/studio/locks/${lock.id}/reference/upload`, {});
  assert.equal(r.statusCode, 422);
});
