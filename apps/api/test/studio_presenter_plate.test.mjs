// The presenter plate (22 Aug 2026).
//
// Owner, on the first finished cut: "the girl and th ebackground change 5
// diffeent times". Six shots, six compositions, six slightly different
// women. Locks constrain the description the model reads. They have never
// constrained the pixels it draws.
//
// The plate is the answer for a piece to camera: compose the room and the
// presenter ONCE, accept it once, and cut every shot's first frame out of
// that single picture. What these tests pin is that the cutting is real --
// no second call to the image model, a recorded link back to the plate, and
// the shot's own framing still applied -- and that the escape hatch for a
// genuinely different picture still works.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.LCOS_AI_PROVIDER = 'MOCK';
process.env.LCOS_ADAPTER_MODE = 'MOCK';
process.env.LCOS_STORAGE_DIR = '/tmp/lcos-plate-test-storage';

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
let projectId, plateId, shotA, shotB;

const newShot = (code, order, extra = {}) => call('POST', `/studio/projects/${projectId}/shots`,
  { shot_code: code, order_index: order, duration_target_s: 5,
    story: { beat: code, narration: 'የወሊድ መቆጣጠሪያ' },
    continuity: { characters: ['CHR-PL'], environment: 'ENV-PL' }, ...extra });

test('a project with approved locks has no plate yet', async () => {
  projectId = (await call('POST', '/studio/projects',
    { title: 'Plate test', format: 'explainer', aspect_ratio: '9:16', language: 'am' })).json().id;
  for (const [type, entityCode] of [['CHARACTER', 'CHR-PL'], ['ENVIRONMENT', 'ENV-PL']]) {
    const lock = (await call('POST', `/studio/projects/${projectId}/locks`,
      { level: 'L1_ENTITY', entity_type: type, entity_code: entityCode, data: { name: entityCode } })).json();
    await call('POST', `/studio/locks/${lock.id}/reference/upload`, { image_base64: PNG });
    await call('POST', `/studio/locks/${lock.id}/approve`, {});
  }
  const plates = await q(
    `SELECT id FROM studio.assets WHERE project_id=$1 AND settings->>'role'='presenter_plate'`, [projectId]);
  assert.equal(plates.rows.length, 0);
});

test('composing the plate asks for a frame loose enough to crop from', async () => {
  const r = await call('POST', `/studio/projects/${projectId}/presenter-plate`, {});
  assert.equal(r.statusCode, 200, r.body);
  const { asset, needs_acceptance } = r.json();
  plateId = asset.id;
  assert.equal(asset.shot_id, null, 'the plate belongs to the project, not to any one shot');
  assert.equal(asset.generator.role, 'presenter_plate');
  assert.equal(needs_acceptance, true,
    'one picture decides what the whole video looks like, so a person sees it first');
  const prompt = asset.settings.prompt;
  assert.match(prompt, /square-on to the lens/, 'she must face the camera, not sit at an angle');
  assert.match(prompt, /leave room around her/,
    'a plate framed tight on her face has nothing left to crop into a close-up');
});

test('an unaccepted plate is not used -- shots still compose their own frame', async () => {
  shotA = (await newShot('SH-A', 0, { camera: { shot_size: 'MEDIUM' } })).json().id;
  const r = await call('POST', `/studio/shots/${shotA}/compose-first-frame`, {});
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().cut_from_presenter_plate, undefined);
  assert.equal(r.json().asset.generator.provider, 'GEMINI');
});

test('accepting the plate is what switches the project over', async () => {
  const r = await call('POST', `/studio/assets/${plateId}/accept`, {});
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await one(`SELECT status FROM studio.assets WHERE id=$1`, [plateId])).status, 'ACCEPTED');
});

test('a shot now cuts its first frame from the plate instead of composing one', async () => {
  shotB = (await newShot('SH-B', 1, { camera: { shot_size: 'CLOSE' } })).json().id;
  const r = await call('POST', `/studio/shots/${shotB}/compose-first-frame`, {});
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.equal(body.cut_from_presenter_plate, plateId);
  assert.equal(body.asset.generator.provider, 'PLATE_CROP',
    'not GEMINI -- the whole point is that no second picture is drawn');
  assert.equal(body.asset.source_asset_id, plateId, 'the frame records what it was cut out of');
  assert.equal(body.asset.settings.shot_size, 'CLOSE', "the shot's own framing still applies to the crop");
});

test('cutting from the plate costs nothing, because nothing is generated', async () => {
  const before = Number((await one(`SELECT spent_usd FROM studio.projects WHERE id=$1`, [projectId])).spent_usd);
  const shot = (await newShot('SH-C', 2, { camera: { shot_size: 'MEDIUM_CLOSE' } })).json();
  await call('POST', `/studio/shots/${shot.id}/compose-first-frame`, {});
  const after = Number((await one(`SELECT spent_usd FROM studio.projects WHERE id=$1`, [projectId])).spent_usd);
  assert.equal(after, before, 'a crop is ffmpeg, not a model call');
});

test('every shot cut from the plate points at the same source picture', async () => {
  const rows = await q(
    `SELECT source_asset_id FROM studio.assets
     WHERE project_id=$1 AND generator->>'provider'='PLATE_CROP'`, [projectId]);
  assert.ok(rows.rows.length >= 2);
  assert.equal(new Set(rows.rows.map(r => r.source_asset_id)).size, 1,
    'if two shots can be cut from two different plates, drift is back');
  assert.equal(rows.rows[0].source_asset_id, plateId);
});

test('fresh:true still composes a genuinely different picture', async () => {
  const cutaway = (await newShot('SH-CUT', 3)).json();
  const r = await call('POST', `/studio/shots/${cutaway.id}/compose-first-frame`, { fresh: true });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().cut_from_presenter_plate, undefined);
  assert.equal(r.json().asset.generator.provider, 'GEMINI',
    'an insert or a second location is a real need; the plate must not outlaw it');
});

test('a talking-head shot cut from the plate stays a talking-head shot', async () => {
  const th = (await newShot('SH-TH', 4, { generation: { mode_preference: 'talking_head' } })).json();
  await call('POST', `/studio/shots/${th.id}/compose-first-frame`, {});
  const shot = await one(`SELECT generation FROM studio.shots WHERE id=$1`, [th.id]);
  assert.equal(shot.generation.mode_preference, 'talking_head',
    'the same silent demotion to Runway that compose-first-frame had');
});

test('the plate refuses to compose against unapproved locks', async () => {
  const bare = (await call('POST', '/studio/projects',
    { title: 'No locks', format: 'explainer', aspect_ratio: '9:16', language: 'am' })).json().id;
  const r = await call('POST', `/studio/projects/${bare}/presenter-plate`, {});
  assert.equal(r.statusCode, 422);
  assert.match(r.json().detail, /CHARACTER lock/);
});

test('regenerating the plate does not change what shots are cut from until it is accepted', async () => {
  const second = (await call('POST', `/studio/projects/${projectId}/presenter-plate`, {})).json().asset;
  assert.notEqual(second.id, plateId);
  const shot = (await newShot('SH-D', 5)).json();
  const r = await call('POST', `/studio/shots/${shot.id}/compose-first-frame`, {});
  assert.equal(r.json().cut_from_presenter_plate, plateId,
    'an unreviewed retry must not quietly change the look of the video');
});

test('the project screen can see which shots are still on their own frame', async () => {
  const r = await call('GET', `/studio/projects/${projectId}`);
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.ok(body.presenter_plates.length >= 2, 'both plates come back so the screen can say which is live');
  assert.equal(body.presenter_plates[0].status, 'GENERATED', 'newest first');
  assert.ok(Array.isArray(body.plate_cut_shot_ids));
  assert.ok(body.plate_cut_shot_ids.includes(shotB), 'SH-B was cut from the plate');
  assert.ok(!body.plate_cut_shot_ids.includes(shotA),
    'SH-A composed its own frame before the plate existed and must not be claimed as cut from it');
});

test('accepting a plate does not silently rewrite frames a person already approved', async () => {
  const before = (await one(`SELECT generation FROM studio.shots WHERE id=$1`, [shotA])).generation;
  await call('GET', `/studio/projects/${projectId}`);
  const after = (await one(`SELECT generation FROM studio.shots WHERE id=$1`, [shotA])).generation;
  assert.equal(after.first_frame_asset_id, before.first_frame_asset_id,
    'replacing approved pictures behind the producer is worse than the drift being fixed');
});

// 22 Aug 2026. STU-2EBF97A2 carries three active ENVIRONMENT locks, two of
// them abandoned experiments. A plate route that picks one of them blind is
// the same bug the plate exists to end, one level up: instead of six rooms
// that drift, you get one room chosen by accident.
test('an ambiguous room is refused, not guessed', async () => {
  const second = (await call('POST', `/studio/projects/${projectId}/locks`,
    { level: 'L1_ENTITY', entity_type: 'ENVIRONMENT', entity_code: 'ENV-PL-2', data: { name: 'ENV-PL-2' } })).json();
  await call('POST', `/studio/locks/${second.id}/reference/upload`, { image_base64: PNG });
  await call('POST', `/studio/locks/${second.id}/approve`, {});

  const r = await call('POST', `/studio/projects/${projectId}/presenter-plate`, {});
  assert.equal(r.statusCode, 422);
  assert.equal(r.json().guard, 'plateLockChoice');
  assert.match(r.json().detail, /2 active ENVIRONMENT locks/);
  assert.match(r.json().detail, /ENV-PL/, 'the refusal names the candidates so the choice can be made');

  const ok = await call('POST', `/studio/projects/${projectId}/presenter-plate`,
    { environment_lock_id: second.id });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().environment_lock.entity_code, 'ENV-PL-2');
});

test('a lock id that is not on this project is refused rather than ignored', async () => {
  const r = await call('POST', `/studio/projects/${projectId}/presenter-plate`,
    { environment_lock_id: '00000000-0000-0000-0000-000000000000' });
  assert.equal(r.statusCode, 422);
  assert.match(r.json().detail, /does not match an active ENVIRONMENT lock/);
});
