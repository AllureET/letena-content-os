// Reference-pack + Runway-engine tests (21 Aug 2026, owner: "once you
// create a character or background reference, I can use chatgpt to create
// these, how can we use it for the LCOS and is there a place where I can
// insert it right after we lock in a character and background", and "I
// don't want this running through veo. I think runway is cheaper is it
// not?"). Covers, in MOCK mode:
//   - uploading a multi-sheet pack onto a lock, filed by sheet_kind
//   - a pack sheet does NOT become the composable reference unless asked
//   - make_current opts one sheet in
//   - the pack is scoped to its own lock, never project-wide
//   - bad sheet_kind / missing image are skipped with a reason, not fatal
//   - shot generation defaults to RUNWAY (not the Kling stub) and records
//     the cheaper per-second estimate
// Same login/token/call() pattern as the other studio test files.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.LCOS_AI_PROVIDER = 'MOCK';
process.env.LCOS_ADAPTER_MODE = 'MOCK';
process.env.LCOS_STORAGE_DIR = '/tmp/lcos-refpack-test-storage';

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
// Test hygiene (21 Aug 2026): these tests bridge assets into lcos.assets,
// the SHARED content library, and the local test database persists between
// runs. Left alone they accumulate a few BACKGROUND/CHARACTER_REFERENCE
// rows per run forever, and GET /production/assets is ORDER BY created_at
// DESC LIMIT 200 -- so after enough runs they push older fixtures out of
// that window and break an unrelated test (part2_flow's library filter
// assertion, which is how this was noticed). Removing exactly the rows
// this file created keeps the shared library stable for every other test.
// studio.assets.library_asset_id has an FK to lcos.assets, so the mirror
// pointer is cleared before the delete.
async function cleanupBridgedAssets(codes) {
  if (!codes.length) return;
  await q(`UPDATE studio.assets SET library_asset_id = NULL
           WHERE library_asset_id IN (SELECT id FROM lcos.assets WHERE code = ANY($1))`, [codes]);
  await q(`DELETE FROM lcos.asset_tags WHERE asset_id IN (SELECT id FROM lcos.assets WHERE code = ANY($1))`, [codes]);
  await q(`DELETE FROM lcos.assets WHERE code = ANY($1)`, [codes]);
}

after(async () => {
  // Every row bridgeAssetToLibrary() created during this file carries the
  // STUDIO- code prefix; scope the delete to the ones created since this
  // run started so a concurrent run's rows are never touched.
  const r = await q(`SELECT code FROM lcos.assets WHERE code LIKE 'STUDIO-%' AND created_at >= $1`, [RUN_STARTED_AT]);
  await cleanupBridgedAssets(r.rows.map(x => x.code));
  await app.close();
  await pool.end();
});

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
let projectId, charLockId, envLockId;

test('set up a project with a character lock and an environment lock', async () => {
  const p = (await call('POST', '/studio/projects',
    { title: 'Reference pack test', format: 'explainer', aspect_ratio: '9:16', language: 'am' })).json();
  projectId = p.id;
  charLockId = (await call('POST', `/studio/projects/${projectId}/locks`,
    { level: 'L1_ENTITY', entity_type: 'CHARACTER', entity_code: 'CHR-PACK-TEST',
      data: { name: 'Pack Test' } })).json().id;
  envLockId = (await call('POST', `/studio/projects/${projectId}/locks`,
    { level: 'L1_ENTITY', entity_type: 'ENVIRONMENT', entity_code: 'ENV-PACK-TEST',
      data: { architecture: 'test room' } })).json().id;
});

test('uploading a multi-sheet pack files each sheet under its own kind', async () => {
  const r = await call('POST', `/studio/locks/${charLockId}/reference-pack`, {
    sheets: [
      { sheet_kind: 'TURNAROUND', image_base64: PNG, note: 'front/3-4/side/back' },
      { sheet_kind: 'EXPRESSIONS', image_base64: PNG },
      { sheet_kind: 'COSTUME_DETAIL', image_base64: PNG },
    ],
  });
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.equal(body.saved.length, 3);
  assert.equal(body.skipped.length, 0);
  assert.deepEqual(body.saved.map(s => s.sheet_kind).sort(),
    ['COSTUME_DETAIL', 'EXPRESSIONS', 'TURNAROUND']);
  assert.equal(body.saved[0].sheet_note, 'front/3-4/side/back');

  const pack = await call('GET', `/studio/locks/${charLockId}/reference-pack`);
  assert.equal(pack.statusCode, 200);
  assert.equal(pack.json().items.length, 3);
});

test('a pack sheet does NOT silently become the lock\'s composable reference', async () => {
  const lock = await one(`SELECT reference_asset_ids FROM studio.locks WHERE id=$1`, [charLockId]);
  assert.equal(lock.reference_asset_ids.length, 0,
    'a turnaround contact sheet must never become the single frame a shot composes from');
});

test('make_current opts a specific sheet into being the current reference', async () => {
  const r = await call('POST', `/studio/locks/${charLockId}/reference-pack`, {
    sheets: [{ sheet_kind: 'MASTER', image_base64: PNG, make_current: true }],
  });
  assert.equal(r.statusCode, 200, r.body);
  const lock = await one(`SELECT reference_asset_ids FROM studio.locks WHERE id=$1`, [charLockId]);
  assert.deepEqual(lock.reference_asset_ids, [r.json().saved[0].id]);
});

test('a pack is scoped to its own lock, not shared across the project', async () => {
  await call('POST', `/studio/locks/${envLockId}/reference-pack`, {
    sheets: [{ sheet_kind: 'LOCATION_ANGLES', image_base64: PNG }],
  });
  const envPack = (await call('GET', `/studio/locks/${envLockId}/reference-pack`)).json();
  assert.equal(envPack.items.length, 1, 'the environment lock sees only its own sheet');
  assert.equal(envPack.items[0].sheet_kind, 'LOCATION_ANGLES');
  const charPack = (await call('GET', `/studio/locks/${charLockId}/reference-pack`)).json();
  assert.equal(charPack.items.length, 4, 'the character lock still sees only its own four');
  assert.ok(!charPack.items.some(i => i.sheet_kind === 'LOCATION_ANGLES'));
});

test('an invalid sheet is skipped with a reason while the valid ones still save', async () => {
  const r = await call('POST', `/studio/locks/${envLockId}/reference-pack`, {
    sheets: [
      { sheet_kind: 'NOT_A_REAL_KIND', image_base64: PNG },
      { sheet_kind: 'PROPS' },
      { sheet_kind: 'LOCATION_LAYOUT', image_base64: PNG },
    ],
  });
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.equal(body.saved.length, 1);
  assert.equal(body.saved[0].sheet_kind, 'LOCATION_LAYOUT');
  assert.equal(body.skipped.length, 2);
  assert.match(body.skipped[0].reason, /sheet_kind must be one of/);
  assert.match(body.skipped[1].reason, /image_base64 is required/);
});

test('an empty sheets array is refused', async () => {
  const r = await call('POST', `/studio/locks/${envLockId}/reference-pack`, { sheets: [] });
  assert.equal(r.statusCode, 422);
});

test('shot generation now defaults to RUNWAY, not the Kling stub', async () => {
  const shot = (await call('POST', `/studio/projects/${projectId}/shots`,
    { shot_code: 'SH-RUNWAY', order_index: 0, duration_target_s: 5,
      story: { beat: 'engine default check' }, generation: { mode_preference: 'text_to_video' } })).json();
  const gen = await call('POST', `/studio/shots/${shot.id}/generate`, {});
  assert.equal(gen.statusCode, 200, gen.body);
  const asset = gen.json().asset;
  assert.equal(asset.generator.provider, 'RUNWAY',
    'with no engine set anywhere, a shot must render through the one real adapter');
  assert.ok(asset.storage_key.includes('runway'), 'the MOCK Runway adapter should have produced the file');
});

test('an explicit VEO engine on the shot still resolves to VEO', async () => {
  const shot = (await call('POST', `/studio/projects/${projectId}/shots`,
    { shot_code: 'SH-VEO', order_index: 1, duration_target_s: 5,
      story: { beat: 'explicit engine check' },
      generation: { mode_preference: 'text_to_video', engine: 'VEO' } })).json();
  const gen = await call('POST', `/studio/shots/${shot.id}/generate`, {});
  assert.equal(gen.statusCode, 200, gen.body);
  assert.equal(gen.json().asset.generator.provider, 'VEO',
    'the engine setting must keep its meaning even though RUNWAY is the default');
});
