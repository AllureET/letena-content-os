// Video Studio assembly extension tests (crossfade transitions + one
// project-music layer, playbook 18.1/16.2 phase-1 scope, 18 Aug 2026 third
// follow-up). Same login/token/call() `/api/v1`-prefixed helper pattern as
// studio.test.mjs; this file does NOT import or modify studio.test.mjs, and
// none of these tests touch the three assembly tests that file already
// owns.
//
// Everything here runs in MOCK adapter mode (no real ffmpeg/ffprobe
// available in this test environment), so:
//   - the default (transition omitted/'cut', no music) regression case is
//     checked against THIS file's own project, independent of
//     studio.test.mjs, per the task's instruction.
//   - music_asset_id validation (not found / wrong kind / wrong project) is
//     fully exercisable in MOCK mode, since it is plain SQL lookups before
//     any ffmpeg call happens.
//   - the crossfade resolution/frame-rate mismatch guard itself is
//     real-ffmpeg/ffprobe-only and CANNOT be exercised end to end here --
//     instead, describeClipMismatch (the pure helper studio.mjs factors
//     that comparison into) is imported and unit-tested directly below,
//     which gives real coverage of the comparison logic without needing
//     actual media files.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.LCOS_AI_PROVIDER = 'MOCK';
process.env.LCOS_ADAPTER_MODE = 'MOCK';
process.env.LCOS_STORAGE_DIR = '/tmp/lcos-test-storage';

const { buildServer } = await import('../src/server.mjs');
const { pool, q, one } = await import('../src/core.mjs');
const { describeClipMismatch } = await import('../src/modules/studio.mjs');

let app, token;
const login = async (email) => (await app.inject({ method: 'POST', url: '/api/v1/auth/login',
  payload: { email, password: 'letena-dev-2026' } })).json().token;
const call = (method, url, payload) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` }, payload });

before(async () => {
  app = await buildServer();
  token = await login('producer@letena.local'); // producer role holds studio.approve too
});
after(async () => { await app.close(); await pool.end(); });

// ---------------------------------------------------------------------
// Test fixture: one project with two shots, each generated and accepted,
// built once and reused across the assemble-option tests below (assemble
// itself does not mutate shots/assets, so calling it repeatedly against the
// same project is safe).
// ---------------------------------------------------------------------
const newProject = async (title) => {
  const r = await call('POST', '/studio/projects', { title, format: 'ai_story', aspect_ratio: '9:16', language: 'am' });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};
const newAcceptedShot = async (projectId, shotCode, orderIndex) => {
  const s = await call('POST', `/studio/projects/${projectId}/shots`,
    { shot_code: shotCode, order_index: orderIndex, duration_target_s: 4,
      story: { beat: 'a beat' }, generation: { mode_preference: 'text_to_video' } });
  assert.equal(s.statusCode, 200, s.body);
  const shot = s.json();
  const gen = await call('POST', `/studio/shots/${shot.id}/generate`, {});
  assert.equal(gen.statusCode, 200, gen.body);
  const assetId = gen.json().asset.id;
  const accept = await call('POST', `/studio/assets/${assetId}/accept`, {});
  assert.equal(accept.statusCode, 200, accept.body);
  return shot;
};

let projectId;

test('fixture: build a two-shot project with both shots accepted', async () => {
  const project = await newProject('Assembly options fixture');
  projectId = project.id;
  await newAcceptedShot(projectId, 'SH-010', 0);
  await newAcceptedShot(projectId, 'SH-020', 1);
});

// ---------------------------------------------------------------------
// Default path regression guard (own project, independent of
// studio.test.mjs, per the task's instruction).
// ---------------------------------------------------------------------
test('default assemble (transition omitted, no music) returns the same shape as before', async () => {
  const r = await call('POST', `/studio/projects/${projectId}/assemble`, {});
  assert.equal(r.statusCode, 200, r.body);
  const finalAsset = r.json();
  assert.equal(finalAsset.kind, 'FINAL_CUT');
  assert.equal(finalAsset.settings.shot_count, 2);
  assert.equal(finalAsset.settings.transition, 'cut');
  assert.equal(finalAsset.settings.music_asset_id, undefined, 'no music_asset_id when none was requested');
  assert.equal(finalAsset.generator.tool, 'ffmpeg-concat');
  assert.equal(finalAsset.generator.mock, true);

  const project = (await call('GET', `/studio/projects/${projectId}`)).json();
  assert.equal(project.state, 'ROUGH_CUT_VALIDATED');
  assert.equal(project.final_asset_id, finalAsset.id);
});

test('explicit transition: "cut" behaves identically to the default', async () => {
  const r = await call('POST', `/studio/projects/${projectId}/assemble`, { transition: 'cut' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().settings.transition, 'cut');
});

test('an unrecognized transition value is refused with 422 VALIDATION', async () => {
  const r = await call('POST', `/studio/projects/${projectId}/assemble`, { transition: 'wipe' });
  assert.equal(r.statusCode, 422, r.body);
  assert.equal(r.json().code, 'VALIDATION');
  assert.ok(r.json().detail.includes('wipe'));
});

// ---------------------------------------------------------------------
// music_asset_id validation: not found / wrong kind / wrong project, each
// a distinct, accurately-named 422 VALIDATION.
// ---------------------------------------------------------------------
test('music_asset_id that does not exist is refused, naming "does not resolve"', async () => {
  const fakeId = '00000000-0000-0000-0000-000000000000';
  const r = await call('POST', `/studio/projects/${projectId}/assemble`, { music_asset_id: fakeId });
  assert.equal(r.statusCode, 422, r.body);
  assert.equal(r.json().code, 'VALIDATION');
  assert.ok(r.json().detail.includes('does not resolve to an existing asset'), r.json().detail);
});

test('music_asset_id that exists but is the wrong kind is refused, naming the actual kind', async () => {
  // Shot A's own accepted VIDEO asset is a real, existing studio.assets row
  // of the wrong kind -- exactly the case this guard needs to catch.
  const project = (await call('GET', `/studio/projects/${projectId}`)).json();
  const wrongKindAssetId = project.shots[0].accepted_asset_id;
  const r = await call('POST', `/studio/projects/${projectId}/assemble`, { music_asset_id: wrongKindAssetId });
  assert.equal(r.statusCode, 422, r.body);
  assert.equal(r.json().code, 'VALIDATION');
  assert.ok(r.json().detail.includes('VIDEO'), r.json().detail);
  assert.ok(r.json().detail.includes('not MUSIC'), r.json().detail);
});

test('music_asset_id belonging to a different project is refused, naming the project mismatch', async () => {
  const otherProject = await newProject('A different project entirely');
  const musicResp = await call('POST', `/studio/projects/${otherProject.id}/music`,
    { brief: { prompt: 'gentle ambient pad' } });
  assert.equal(musicResp.statusCode, 200, musicResp.body);
  const otherProjectsMusicId = musicResp.json().id;

  const r = await call('POST', `/studio/projects/${projectId}/assemble`, { music_asset_id: otherProjectsMusicId });
  assert.equal(r.statusCode, 422, r.body);
  assert.equal(r.json().code, 'VALIDATION');
  assert.ok(r.json().detail.includes('different project'), r.json().detail);
});

// ---------------------------------------------------------------------
// A valid music_asset_id is accepted; in MOCK mode this is recorded on the
// FINAL_CUT asset's settings without pretending a real mix happened.
// ---------------------------------------------------------------------
test('a valid music_asset_id is accepted and reflected on the FINAL_CUT asset settings, in MOCK mode', async () => {
  const musicResp = await call('POST', `/studio/projects/${projectId}/music`,
    { brief: { prompt: 'warm acoustic guitar bed', tempo_bpm: 90, duration_s: 20 } });
  assert.equal(musicResp.statusCode, 200, musicResp.body);
  const musicAsset = musicResp.json();
  assert.equal(musicAsset.kind, 'MUSIC');

  const r = await call('POST', `/studio/projects/${projectId}/assemble`, { music_asset_id: musicAsset.id });
  assert.equal(r.statusCode, 200, r.body);
  const finalAsset = r.json();
  assert.equal(finalAsset.settings.music_asset_id, musicAsset.id);
  assert.equal(finalAsset.settings.shot_count, 2, 'the pre-existing shot_count field must still be present');
});

// ---------------------------------------------------------------------
// transition: 'crossfade' in MOCK mode: accepted and recorded in
// settings.transition, since MOCK mode cannot exercise the real
// ffmpeg/ffprobe xfade path at all.
// ---------------------------------------------------------------------
test('transition: "crossfade" is accepted in MOCK mode and recorded in settings, without claiming a real blend happened', async () => {
  const r = await call('POST', `/studio/projects/${projectId}/assemble`, { transition: 'crossfade', transition_duration_s: 0.75 });
  assert.equal(r.statusCode, 200, r.body);
  const finalAsset = r.json();
  assert.equal(finalAsset.settings.transition, 'crossfade');
  assert.equal(Number(finalAsset.settings.transition_duration_s), 0.75);
  assert.equal(finalAsset.generator.tool, 'ffmpeg-xfade');
  assert.equal(finalAsset.generator.mock, true, 'MOCK mode must never claim a real crossfade was produced');
});

test('transition_duration_s must be a positive number', async () => {
  const r = await call('POST', `/studio/projects/${projectId}/assemble`, { transition: 'crossfade', transition_duration_s: -1 });
  assert.equal(r.statusCode, 422, r.body);
  assert.equal(r.json().code, 'VALIDATION');
});

// ---------------------------------------------------------------------
// describeClipMismatch: the pure helper studio.mjs's real-ffmpeg crossfade
// guard is built on. This is real, direct coverage of the comparison logic
// -- resolution and frame-rate mismatch detection, and the "no mismatch"
// case -- without needing actual media files or a real ffprobe call.
// ---------------------------------------------------------------------
test('describeClipMismatch: matching resolution and fps returns null', () => {
  const a = { width: 1080, height: 1920, fps: 30 };
  const b = { width: 1080, height: 1920, fps: 30 };
  assert.equal(describeClipMismatch(a, b, 'SH-010', 'SH-020'), null);
});

test('describeClipMismatch: a small fps difference within tolerance (29.97 vs 30) is not a mismatch', () => {
  const a = { width: 1080, height: 1920, fps: 30 };
  const b = { width: 1080, height: 1920, fps: 29.97 };
  assert.equal(describeClipMismatch(a, b, 'SH-010', 'SH-020'), null);
});

test('describeClipMismatch: a resolution mismatch names the exact shot-code pair and dimensions', () => {
  const a = { width: 1080, height: 1920, fps: 30 };
  const b = { width: 720, height: 1280, fps: 30 };
  const msg = describeClipMismatch(a, b, 'SH-010', 'SH-020');
  assert.ok(msg.includes('SH-010 is 1080x1920'), msg);
  assert.ok(msg.includes('SH-020 is 720x1280'), msg);
});

test('describeClipMismatch: a frame-rate mismatch names the exact shot-code pair and fps values', () => {
  const a = { width: 1080, height: 1920, fps: 24 };
  const b = { width: 1080, height: 1920, fps: 60 };
  const msg = describeClipMismatch(a, b, 'SH-010', 'SH-020');
  assert.ok(msg.includes('SH-010 is 24.00fps'), msg);
  assert.ok(msg.includes('SH-020 is 60.00fps'), msg);
});

test('describeClipMismatch: both resolution and fps differing names both problems', () => {
  const a = { width: 1080, height: 1920, fps: 24 };
  const b = { width: 720, height: 1280, fps: 60 };
  const msg = describeClipMismatch(a, b, 'SH-010', 'SH-020');
  assert.ok(msg.includes('1080x1920'), msg);
  assert.ok(msg.includes('24.00fps'), msg);
});
