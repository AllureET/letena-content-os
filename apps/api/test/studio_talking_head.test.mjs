// Voice drives the picture (22 Aug 2026).
//
// Owner: "if the audio is made after the video, doesnt that mean there is no
// chance for lipsyncing? is that possible at all?" The answer was no, and the
// reason was the order. Runway invents a mouth before the words exist, so the
// presenter mouths nothing in particular, and no prompt tuning fixes that
// because the information is not there when the mouth is drawn.
//
// So the order is reversed for this mode: generate the line, let its real
// length set the shot, then animate the composed frame FROM that line.
//
// Two consequences these tests pin. The mode refuses to run without a voice,
// because a talking head with no words is the old bug wearing a new name. And
// assembly must not lay narration over a clip that already carries it, or the
// same sentence plays twice a fraction of a second apart.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.LCOS_AI_PROVIDER = 'MOCK';
process.env.LCOS_ADAPTER_MODE = 'MOCK';
process.env.LCOS_STORAGE_DIR = '/tmp/lcos-talkinghead-test-storage';

const { buildServer } = await import('../src/server.mjs');
const { pool, q, one } = await import('../src/core.mjs');

let app, token;
const login = async (email) => (await app.inject({ method: 'POST', url: '/api/v1/auth/login',
  payload: { email, password: 'letena-dev-2026' } })).json().token;
const call = (method, url, payload) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` }, payload });

before(async () => { app = await buildServer(); token = await login('producer@letena.local'); });
after(async () => { await app.close(); await pool.end(); });

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
let projectId, shotId;

test('set up a project with approved locks and a composed first frame', async () => {
  projectId = (await call('POST', '/studio/projects',
    { title: 'Talking head test', format: 'explainer', aspect_ratio: '9:16', language: 'am' })).json().id;
  for (const [type, code] of [['CHARACTER', 'CHR-TH'], ['ENVIRONMENT', 'ENV-TH']]) {
    const lock = (await call('POST', `/studio/projects/${projectId}/locks`,
      { level: 'L1_ENTITY', entity_type: type, entity_code: code, data: { name: code } })).json();
    await call('POST', `/studio/locks/${lock.id}/reference/upload`, { image_base64: PNG });
    await call('POST', `/studio/locks/${lock.id}/approve`, {});
  }
  shotId = (await call('POST', `/studio/projects/${projectId}/shots`,
    { shot_code: 'SH-TH', order_index: 0, duration_target_s: 5,
      story: { beat: 'hook', narration: 'የወሊድ መቆጣጠሪያ' },
      continuity: { characters: ['CHR-TH'], environment: 'ENV-TH' },
      generation: { mode_preference: 'talking_head' } })).json().id;
  const frame = await call('POST', `/studio/shots/${shotId}/compose-first-frame`, {});
  assert.equal(frame.statusCode, 200, frame.body);
});

test('the mode refuses to run before the line exists, and says why', async () => {
  const r = await call('POST', `/studio/shots/${shotId}/generate`, {});
  assert.equal(r.statusCode, 422);
  assert.equal(r.json().guard, 'talkingHeadNeedsVoice');
  assert.match(r.json().detail, /voice drives the picture/,
    'the refusal should explain the order, since the order is the whole point');
});

test('generating the line reports its length', async () => {
  const r = await call('POST', `/studio/shots/${shotId}/voice`, {});
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().kind, 'VOICE');
});

test('with a line in place, the shot generates as a talking head', async () => {
  const r = await call('POST', `/studio/shots/${shotId}/generate`, {});
  assert.equal(r.statusCode, 200, r.body);
  const asset = r.json().asset;
  assert.equal(asset.kind, 'VIDEO');
  assert.equal(asset.generator.mode, 'talking_head');
  assert.equal(asset.generator.provider, 'FAL', 'Runway has no audio-driven endpoint; this path is deliberately not Runway');
  assert.ok(asset.generator.driven_by_voice_asset_id, 'the clip records which line drove it');
  assert.equal(asset.generator.carries_own_audio, true,
    'assembly reads this to know the narration is already in the picture');
});

test('a shot with no composed frame is refused before anything is spent', async () => {
  const bare = (await call('POST', `/studio/projects/${projectId}/shots`,
    { shot_code: 'SH-TH-BARE', order_index: 1, duration_target_s: 5, story: { beat: 'bare' },
      continuity: { characters: ['CHR-TH'], environment: 'ENV-TH' },
      generation: { mode_preference: 'talking_head' } })).json();
  const r = await call('POST', `/studio/shots/${bare.id}/generate`, {});
  assert.equal(r.statusCode, 422);
  assert.match(r.json().detail, /compose-first-frame/);
});

test('the Runway path is untouched by any of this', async () => {
  const runwayShot = (await call('POST', `/studio/projects/${projectId}/shots`,
    { shot_code: 'SH-RW', order_index: 2, duration_target_s: 5, story: { beat: 'runway' },
      generation: { mode_preference: 'text_to_video' } })).json();
  const r = await call('POST', `/studio/shots/${runwayShot.id}/generate`, {});
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().asset.generator.provider, 'RUNWAY');
});
