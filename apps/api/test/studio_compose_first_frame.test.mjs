// Video Studio "compose first frame" tests (19 Aug 2026): the step-by-step
// shot-generation gap the owner asked for after reviewing Letena's real
// Instagram doctor-presenter content -- same doctor (CHARACTER lock),
// different backdrop (ENVIRONMENT lock). POST
// /studio/shots/:shotId/compose-first-frame composes those two locks'
// reference images into one first-frame still via gemini.generateImage's
// new referenceImageKeys, and points the shot's generation block at it.
// Same login/token/call() pattern as studio.test.mjs / studio_budget.test.mjs;
// this file does not touch either of those files' own tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.LCOS_AI_PROVIDER = 'MOCK';
process.env.LCOS_ADAPTER_MODE = 'MOCK';
process.env.LCOS_STORAGE_DIR = '/tmp/lcos-test-storage';

const { buildServer } = await import('../src/server.mjs');
const { pool, q, one } = await import('../src/core.mjs');
const { gemini, storage } = await import('../src/adapters/index.mjs');
const { readFile } = await import('node:fs/promises');
const { compileComposePrompt } = await import('../src/modules/studio.mjs');

let app, token;
const login = async (email) => (await app.inject({ method: 'POST', url: '/api/v1/auth/login',
  payload: { email, password: 'letena-dev-2026' } })).json().token;
const call = (method, url, payload) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` }, payload });

before(async () => {
  app = await buildServer();
  token = await login('producer@letena.local'); // producer holds studio.write/generate/approve
});
after(async () => { await app.close(); await pool.end(); });

const newProject = async (title) => {
  const r = await call('POST', '/studio/projects', { title, format: 'explainer', aspect_ratio: '9:16', language: 'am' });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};
const newLock = async (projectId, entityType, entityCode, data) => {
  const r = await call('POST', `/studio/projects/${projectId}/locks`,
    { level: entityType === 'CHARACTER' ? 'L1_ENTITY' : 'L2_STATE', entity_type: entityType, entity_code: entityCode, data });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};
const approveLock = async (lockId) => {
  const r = await call('POST', `/studio/locks/${lockId}/approve`, {});
  assert.equal(r.statusCode, 200, r.body);
};
const genReference = async (lockId) => {
  const r = await call('POST', `/studio/locks/${lockId}/reference`, {});
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};
const newShot = async (projectId, shotCode, continuity, generation) => {
  const r = await call('POST', `/studio/projects/${projectId}/shots`,
    { shot_code: shotCode, order_index: 0, duration_target_s: 5, story: { beat: 'a beat' },
      continuity, generation });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};

const CHAR_DATA = { name: 'Dr. Sara', apparent_age: '30s', silhouette: 'medium build',
  face: 'warm expression', hair: 'headscarf', wardrobe_variants: { default: 'white coat, Letena patch' } };
const ENV_DATA = { architecture: 'studio backdrop', palette: 'blue and white vertical stripes',
  time: 'daytime', weather: 'indoor' };

// ---------------------------------------------------------------------
// Guard tests: each names the exact missing piece.
// ---------------------------------------------------------------------
test('compose-first-frame refuses with a 404 when the shot does not exist', async () => {
  const r = await call('POST', '/studio/shots/00000000-0000-0000-0000-000000000000/compose-first-frame', {});
  assert.equal(r.statusCode, 404, r.body);
});

test('compose-first-frame refuses when the shot has no CHARACTER lock attached', async () => {
  const project = await newProject('Compose guard: no character');
  const env = await newLock(project.id, 'ENVIRONMENT', 'ENV-STUDIO', ENV_DATA);
  await approveLock(env.id);
  await genReference(env.id);
  const shot = await newShot(project.id, 'SH-001', { environment: 'ENV-STUDIO' }, {});
  const r = await call('POST', `/studio/shots/${shot.id}/compose-first-frame`, {});
  assert.equal(r.statusCode, 422, r.body);
  assert.equal(r.json().code, 'GUARD_FAILED');
  assert.match(r.json().detail, /no CHARACTER lock attached/);
});

test('compose-first-frame refuses when the shot has no ENVIRONMENT lock attached', async () => {
  const project = await newProject('Compose guard: no environment');
  const char = await newLock(project.id, 'CHARACTER', 'CHR-SARA', CHAR_DATA);
  await approveLock(char.id);
  await genReference(char.id);
  const shot = await newShot(project.id, 'SH-001', { characters: ['CHR-SARA'] }, {});
  const r = await call('POST', `/studio/shots/${shot.id}/compose-first-frame`, {});
  assert.equal(r.statusCode, 422, r.body);
  assert.equal(r.json().code, 'GUARD_FAILED');
  assert.match(r.json().detail, /no ENVIRONMENT lock attached/);
});

test('compose-first-frame refuses when the CHARACTER lock is not approved', async () => {
  const project = await newProject('Compose guard: character unapproved');
  const char = await newLock(project.id, 'CHARACTER', 'CHR-SARA', CHAR_DATA);
  // deliberately not approved
  const env = await newLock(project.id, 'ENVIRONMENT', 'ENV-STUDIO', ENV_DATA);
  await approveLock(env.id);
  await genReference(env.id);
  const shot = await newShot(project.id, 'SH-001', { characters: ['CHR-SARA'], environment: 'ENV-STUDIO' }, {});
  const r = await call('POST', `/studio/shots/${shot.id}/compose-first-frame`, {});
  assert.equal(r.statusCode, 422, r.body);
  assert.equal(r.json().code, 'GUARD_FAILED');
  assert.match(r.json().detail, /CHARACTER lock.*not approved/);
});

test('compose-first-frame refuses when the ENVIRONMENT lock is not approved', async () => {
  const project = await newProject('Compose guard: environment unapproved');
  const char = await newLock(project.id, 'CHARACTER', 'CHR-SARA', CHAR_DATA);
  await approveLock(char.id);
  await genReference(char.id);
  const env = await newLock(project.id, 'ENVIRONMENT', 'ENV-STUDIO', ENV_DATA);
  // deliberately not approved
  const shot = await newShot(project.id, 'SH-001', { characters: ['CHR-SARA'], environment: 'ENV-STUDIO' }, {});
  const r = await call('POST', `/studio/shots/${shot.id}/compose-first-frame`, {});
  assert.equal(r.statusCode, 422, r.body);
  assert.equal(r.json().code, 'GUARD_FAILED');
  assert.match(r.json().detail, /ENVIRONMENT lock.*not approved/);
});

test('compose-first-frame refuses when the CHARACTER lock has no reference image yet', async () => {
  const project = await newProject('Compose guard: character no reference');
  const char = await newLock(project.id, 'CHARACTER', 'CHR-SARA', CHAR_DATA);
  await approveLock(char.id);
  // no reference generated
  const env = await newLock(project.id, 'ENVIRONMENT', 'ENV-STUDIO', ENV_DATA);
  await approveLock(env.id);
  await genReference(env.id);
  const shot = await newShot(project.id, 'SH-001', { characters: ['CHR-SARA'], environment: 'ENV-STUDIO' }, {});
  const r = await call('POST', `/studio/shots/${shot.id}/compose-first-frame`, {});
  assert.equal(r.statusCode, 422, r.body);
  assert.equal(r.json().code, 'GUARD_FAILED');
  assert.match(r.json().detail, /CHARACTER lock has no reference image yet/);
});

test('compose-first-frame refuses when the ENVIRONMENT lock has no reference image yet', async () => {
  const project = await newProject('Compose guard: environment no reference');
  const char = await newLock(project.id, 'CHARACTER', 'CHR-SARA', CHAR_DATA);
  await approveLock(char.id);
  await genReference(char.id);
  const env = await newLock(project.id, 'ENVIRONMENT', 'ENV-STUDIO', ENV_DATA);
  await approveLock(env.id);
  // no reference generated
  const shot = await newShot(project.id, 'SH-001', { characters: ['CHR-SARA'], environment: 'ENV-STUDIO' }, {});
  const r = await call('POST', `/studio/shots/${shot.id}/compose-first-frame`, {});
  assert.equal(r.statusCode, 422, r.body);
  assert.equal(r.json().code, 'GUARD_FAILED');
  assert.match(r.json().detail, /ENVIRONMENT lock has no reference image yet/);
});

// ---------------------------------------------------------------------
// Happy path.
// ---------------------------------------------------------------------
test('compose-first-frame creates a composed KEYFRAME asset and sets the shot to image_to_video with it as first frame, preserving other generation keys', async () => {
  const project = await newProject('Compose happy path');
  const char = await newLock(project.id, 'CHARACTER', 'CHR-SARA', CHAR_DATA);
  await approveLock(char.id);
  const charRef = await genReference(char.id);
  const env = await newLock(project.id, 'ENVIRONMENT', 'ENV-STUDIO', ENV_DATA);
  await approveLock(env.id);
  const envRef = await genReference(env.id);
  const shot = await newShot(project.id, 'SH-001', { characters: ['CHR-SARA'], environment: 'ENV-STUDIO' },
    { engine: 'KLING' }); // pre-existing generation key that must survive

  const r = await call('POST', `/studio/shots/${shot.id}/compose-first-frame`, {});
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.equal(body.asset.kind, 'KEYFRAME');
  assert.equal(body.asset.status, 'GENERATED');
  assert.equal(body.asset.shot_id, shot.id);
  assert.equal(body.asset.generator.provider, 'GEMINI');
  assert.equal(body.asset.generator.composed_from.character_lock_id, char.id);
  assert.equal(body.asset.generator.composed_from.environment_lock_id, env.id);
  assert.equal(body.character_lock.id, char.id);
  assert.equal(body.environment_lock.id, env.id);

  const project2 = await (await call('GET', `/studio/projects/${project.id}`)).json();
  const shotAfter = project2.shots.find(s => s.id === shot.id);
  assert.equal(shotAfter.generation.first_frame_asset_id, body.asset.id);
  assert.equal(shotAfter.generation.mode_preference, 'image_to_video');
  assert.equal(shotAfter.generation.engine, 'KLING', 'pre-existing generation.engine must survive the merge');

  // Uses the character/environment lock's own reference asset, not some
  // other asset -- sanity check both reference assets exist and are IMAGE-kind.
  assert.equal(charRef.kind, 'REFERENCE_IMAGE');
  assert.equal(envRef.kind, 'REFERENCE_IMAGE');
});

test('compose-first-frame spends budget only after generation succeeds', async () => {
  const r = await call('POST', '/studio/projects', { title: 'Compose budget', format: 'explainer',
    aspect_ratio: '9:16', language: 'am', budget_cap_usd: 10.00 });
  const project = r.json();
  const char = await newLock(project.id, 'CHARACTER', 'CHR-SARA', CHAR_DATA);
  await approveLock(char.id);
  await genReference(char.id);
  const env = await newLock(project.id, 'ENVIRONMENT', 'ENV-STUDIO', ENV_DATA);
  await approveLock(env.id);
  await genReference(env.id);
  const shot = await newShot(project.id, 'SH-001', { characters: ['CHR-SARA'], environment: 'ENV-STUDIO' }, {});

  const before = await (await call('GET', `/studio/projects/${project.id}`)).json();
  const spentBefore = Number(before.spent_usd);

  const compose = await call('POST', `/studio/shots/${shot.id}/compose-first-frame`, {});
  assert.equal(compose.statusCode, 200, compose.body);

  const after = await (await call('GET', `/studio/projects/${project.id}`)).json();
  assert.ok(Number(after.spent_usd) > spentBefore, 'spend should increase after a successful compose call');
});

// ---------------------------------------------------------------------
// Adapter-level: gemini.generateImage with 0/1/2 referenceImageKeys in
// MOCK mode, imported directly (no HTTP route needed for this one).
// ---------------------------------------------------------------------
test('gemini.generateImage MOCK placeholder reflects the reference image count', async () => {
  const zero = await gemini.generateImage({ prompt: 'a test prompt', assetId: 'test-refs-0' });
  const zeroBuf = await readFile(storage.localPath(zero.storage_key));
  assert.match(zeroBuf.toString(), /^MOCK-GEMINI-PNG refs=0/);

  const withOneRef = await gemini.generateImage({ prompt: 'a test prompt', assetId: 'test-refs-1',
    referenceImageKeys: ['some/key.png'] });
  const oneBuf = await readFile(storage.localPath(withOneRef.storage_key));
  assert.match(oneBuf.toString(), /^MOCK-GEMINI-PNG refs=1/);

  const two = await gemini.generateImage({ prompt: 'a test prompt', assetId: 'test-refs-2',
    referenceImageKeys: ['some/key1.png', 'some/key2.png'] });
  const twoBuf = await readFile(storage.localPath(two.storage_key));
  assert.match(twoBuf.toString(), /^MOCK-GEMINI-PNG refs=2/);
});

// Shot-level framing override (21 Aug 2026). Added on the first real
// Spotting on the Pill compose: the character lock said "waist-up portrait"
// and Gemini returned a full-body wide of the whole room. At 9:16 on a phone
// that puts the presenter's face at a few percent of the frame, which is
// unusable for a talking-head piece. The only lever before this was revising
// the character lock, which stales every shot in the project and is the
// wrong tool -- a lock says WHO she is, not how one shot is cropped.
// camera.framing_notes was already on the shot and nothing read it.
const CHAR = { entity_code: 'CHR-T', data: { name: 'T', composition: 'lock says waist-up' } };
const ENV = { entity_code: 'ENV-T', data: { architecture: 'a room', composition: 'env says wide' } };

test('the shot\'s own framing note wins over both locks', () => {
  const p = compileComposePrompt(CHAR, ENV, null, '9:16', 'shot says tight chest-up');
  assert.match(p, /\[FRAMING\] shot says tight chest-up/);
  assert.ok(!p.includes('lock says waist-up'),
    'a shot that states its framing must not also carry the lock composition, or the two contradict each other');
});

test('with no shot framing note the character lock still wins over the environment', () => {
  const p = compileComposePrompt(CHAR, ENV, null, '9:16', null);
  assert.match(p, /\[FRAMING\] lock says waist-up/);
});

test('with neither a shot note nor a character composition the environment is the fallback', () => {
  const p = compileComposePrompt({ entity_code: 'CHR-T', data: { name: 'T' } }, ENV, null, '9:16', null);
  assert.match(p, /\[FRAMING\] env says wide/);
});

test('the aspect line is still emitted alongside a shot framing note', () => {
  const p = compileComposePrompt(CHAR, ENV, null, '9:16', 'shot says tight chest-up');
  assert.match(p, /\[ASPECT\] 9:16 vertical portrait orientation/);
});
