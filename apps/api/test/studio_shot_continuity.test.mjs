// Shot-to-shot continuity tests (21 Aug 2026, owner request: "kling
// offers this thing where the last frame of a video becomes the first
// frame of the next video, can we implement that with runway in LCOS so
// we can maintain the vid[eo continuity]"). Reproduces that
// provider-agnostically: POST /shots/:shotId/continue-from-previous
// extracts the last frame of an EARLIER shot's ACCEPTED video with
// ffmpeg and points this shot's generation.first_frame_asset_id at it --
// the same field compose-first-frame writes -- so it works identically
// whichever engine actually generated the earlier video. Also covers the
// remix-reattachment fix this feature exposed: remixing a shot's current
// first-frame KEYFRAME (from compose-first-frame OR from this route)
// must update that shot's generation.first_frame_asset_id too, or
// Generate would silently keep using the un-remixed frame. Same
// login/token/call() pattern as studio.test.mjs and
// studio_library_bridge.test.mjs; does not touch any existing test file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.LCOS_AI_PROVIDER = 'MOCK';
process.env.LCOS_ADAPTER_MODE = 'MOCK';
process.env.LCOS_STORAGE_DIR = '/tmp/lcos-shotcontinuity-test-storage';

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

let projectId, shotAId, shotBId, shotCId, shotDId, shotAAssetId;

test('set up a project with four shots in order', async () => {
  const proj = (await call('POST', '/studio/projects',
    { title: 'Continuity test', format: 'explainer', aspect_ratio: '9:16', language: 'am' })).json();
  projectId = proj.id;
  const mk = async (shot_code, order_index) => (await call('POST', `/studio/projects/${projectId}/shots`,
    { shot_code, order_index, duration_target_s: 4, story: { beat: shot_code },
      generation: { mode_preference: 'text_to_video' } })).json();
  shotAId = (await mk('SH-A', 0)).id;
  shotBId = (await mk('SH-B', 1)).id;
  shotCId = (await mk('SH-C', 2)).id;
  shotDId = (await mk('SH-D', 3)).id;
});

test('continuing from previous refuses the first shot in the project (no earlier shot)', async () => {
  const r = await call('POST', `/studio/shots/${shotAId}/continue-from-previous`, {});
  assert.equal(r.statusCode, 422);
  assert.equal(r.json().code, 'GUARD_FAILED');
});

test('generate and accept shot A\'s video', async () => {
  const gen = await call('POST', `/studio/shots/${shotAId}/generate`, {});
  assert.equal(gen.statusCode, 200, gen.body);
  assert.equal(gen.json().asset.kind, 'VIDEO');
  shotAAssetId = gen.json().asset.id;
  const acc = await call('POST', `/studio/assets/${shotAAssetId}/accept`, {});
  assert.equal(acc.statusCode, 200, acc.body);
});

test('continuing shot B from shot A extracts a last frame and sets it as shot B\'s first frame', async () => {
  const r = await call('POST', `/studio/shots/${shotBId}/continue-from-previous`, {});
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.equal(body.asset.kind, 'KEYFRAME');
  assert.equal(body.asset.generator.provider, 'FRAME_EXTRACT');
  assert.equal(body.asset.source_asset_id, shotAAssetId, 'lineage recorded back to shot A\'s accepted video');
  assert.equal(body.continued_from.shot_id, shotAId);
  assert.equal(body.continued_from.shot_code, 'SH-A');

  const shotB = await one(`SELECT generation FROM studio.shots WHERE id=$1`, [shotBId]);
  assert.equal(shotB.generation.first_frame_asset_id, body.asset.id);
  assert.equal(shotB.generation.mode_preference, 'image_to_video');
  assert.equal(shotB.generation.continued_from_shot_id, shotAId);

  // Mirrored into the library like every other studio-generated image.
  const studioRow = await one(`SELECT library_asset_id FROM studio.assets WHERE id=$1`, [body.asset.id]);
  assert.ok(studioRow.library_asset_id, 'continuity frame also mirrored into the library');
});

test('continuing shot C from shot B is refused while shot B has no accepted video yet', async () => {
  const r = await call('POST', `/studio/shots/${shotCId}/continue-from-previous`, {});
  assert.equal(r.statusCode, 422);
  assert.equal(r.json().code, 'GUARD_FAILED');
  assert.ok(r.json().detail.includes('SH-B'), 'names the shot that needs accepting first');
});

test('remixing a shot\'s current first-frame keyframe re-points that shot at the remix, not the stale frame', async () => {
  const shotB = await one(`SELECT generation FROM studio.shots WHERE id=$1`, [shotBId]);
  const originalFrameId = shotB.generation.first_frame_asset_id;

  const remix = await call('POST', `/studio/assets/${originalFrameId}/remix`, { prompt: 'slightly warmer light' });
  assert.equal(remix.statusCode, 200, remix.body);
  const remixed = remix.json();
  assert.notEqual(remixed.id, originalFrameId);
  assert.equal(remixed.attached_to_shot.id, shotBId);
  assert.equal(remixed.attached_to_shot.shot_code, 'SH-B');

  const shotBAfter = await one(`SELECT generation FROM studio.shots WHERE id=$1`, [shotBId]);
  assert.equal(shotBAfter.generation.first_frame_asset_id, remixed.id,
    'Generate must use the REMIXED frame, not the original one that was just superseded');
});

test('source_shot_id lets a shot continue from a specific non-adjacent earlier shot', async () => {
  const r = await call('POST', `/studio/shots/${shotDId}/continue-from-previous`, { source_shot_id: shotAId });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().continued_from.shot_id, shotAId, 'explicit source_shot_id wins over the adjacent shot');
});

test('a shot cannot continue from itself', async () => {
  const r = await call('POST', `/studio/shots/${shotAId}/continue-from-previous`, { source_shot_id: shotAId });
  assert.equal(r.statusCode, 422);
  assert.equal(r.json().code, 'GUARD_FAILED');
});

test('source_shot_id must resolve to a shot in the same project', async () => {
  const otherProj = (await call('POST', '/studio/projects',
    { title: 'Other project', format: 'explainer', aspect_ratio: '9:16', language: 'am' })).json();
  const r = await call('POST', `/studio/shots/${shotCId}/continue-from-previous`, { source_shot_id: otherProj.id });
  assert.equal(r.statusCode, 404);
});

// Composing a fresh first frame ends the continuity link (22 Aug 2026).
// Leaving the pointer behind made the system believe a link that no longer
// existed: rejecting an earlier shot's video was refused because "the next
// shot continues from it", when that shot had been recomposed and did not.
// The refusal's own advice -- regenerate the later shot's first frame first
// -- only works if doing so actually clears the link.
test('recomposing a shot\'s first frame clears the link to the shot it continued from', async () => {
  const before = await one(`SELECT generation FROM studio.shots WHERE id=$1`, [shotBId]);
  assert.ok(before.generation.continued_from_shot_id, 'SH-B is continuing from SH-A at this point');
  // compose-first-frame needs an approved character and environment lock,
  // which this file's shots do not otherwise have.
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  for (const [type, code] of [['CHARACTER', 'CHR-CONT'], ['ENVIRONMENT', 'ENV-CONT']]) {
    const lock = (await call('POST', `/studio/projects/${projectId}/locks`,
      { level: 'L1_ENTITY', entity_type: type, entity_code: code, data: { name: code } })).json();
    await call('POST', `/studio/locks/${lock.id}/reference/upload`, { image_base64: PNG });
    await call('POST', `/studio/locks/${lock.id}/approve`, {});
  }
  await call('PATCH', `/studio/shots/${shotBId}`,
    { continuity: { characters: ['CHR-CONT'], environment: 'ENV-CONT' } });
  const r = await call('POST', `/studio/shots/${shotBId}/compose-first-frame`, {});
  assert.equal(r.statusCode, 200, r.body);
  const after = await one(`SELECT generation FROM studio.shots WHERE id=$1`, [shotBId]);
  assert.equal(after.generation.continued_from_shot_id, undefined,
    'a freshly composed frame does not continue from anything');
  assert.equal(after.generation.first_frame_asset_id, r.json().asset.id);
  assert.equal(after.generation.mode_preference, 'image_to_video',
    'the rest of the generation block is still merged, not replaced');
});
