// Video Studio phase 1 tests (18 Aug 2026): the core loop end to end in
// MOCK adapter mode. Project -> lock -> reference -> shot -> generate ->
// QC -> accept -> assemble, plus the two guards that matter most: a lock
// revision STALEs shots generated against the old version (unless already
// ACCEPTED), and assembly refuses when a shot has no accepted asset
// instead of silently skipping it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.LCOS_AI_PROVIDER = 'MOCK';
process.env.LCOS_ADAPTER_MODE = 'MOCK';
process.env.LCOS_STORAGE_DIR = '/tmp/lcos-test-storage';

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

let projectId, styleLockId, charLockId, shotAId, shotBId;

test('create a studio project', async () => {
  const r = await call('POST', '/studio/projects', { title: 'Maya and the Missing Key', format: 'ai_story',
    aspect_ratio: '9:16', language: 'am' });
  assert.equal(r.statusCode, 200, r.body);
  const p = r.json();
  assert.equal(p.state, 'REQUEST');
  assert.equal(p.title, 'Maya and the Missing Key');
  projectId = p.id;
});

test('create a style lock and a character lock', async () => {
  const style = await call('POST', `/studio/projects/${projectId}/locks`,
    { level: 'L0_PROJECT', entity_type: 'STYLE', entity_code: 'STYLE-MAIN',
      data: { style_summary: 'warm gouache illustration, soft edges', motion_grammar: 'gentle, grounded' } });
  assert.equal(style.statusCode, 200, style.body);
  styleLockId = style.json().id;
  assert.equal(style.json().version, 1);

  const char = await call('POST', `/studio/projects/${projectId}/locks`,
    { level: 'L1_ENTITY', entity_type: 'CHARACTER', entity_code: 'CHR-MAYA',
      data: { name: 'Maya', apparent_age: 'late 20s', silhouette: 'tall, narrow shoulders',
        face: 'oval face, dark eyes', hair: 'chin-length black bob',
        wardrobe_variants: { default: 'ochre field jacket' }, forbidden_drift: ['no earrings'] } });
  assert.equal(char.statusCode, 200, char.body);
  charLockId = char.json().id;
});

test('a still/keyframe prompt compiles deterministically from a lock, no model call', async () => {
  const { compileStillPrompt } = await import('../src/modules/studio.mjs');
  const prompt = compileStillPrompt({ entity_type: 'CHARACTER',
    data: { name: 'Maya', apparent_age: 'late 20s', silhouette: 'tall', face: 'oval', hair: 'bob',
      wardrobe_variants: { default: 'ochre jacket' }, style_summary: 'gouache' } });
  assert.ok(prompt.includes('Maya'));
  assert.ok(prompt.includes('ochre jacket'));
  assert.ok(prompt.includes('No embedded text'));
});

test('generate a reference image for the character lock', async () => {
  const r = await call('POST', `/studio/locks/${charLockId}/reference`, {});
  assert.equal(r.statusCode, 200, r.body);
  const asset = r.json();
  assert.equal(asset.kind, 'REFERENCE_IMAGE');
  assert.ok(asset.storage_key.includes('image.png'));
});

test('create two shots in the manifest, resolving active lock ids from continuity', async () => {
  const a = await call('POST', `/studio/projects/${projectId}/shots`,
    { shot_code: 'SH-010', order_index: 0, duration_target_s: 5,
      continuity: { characters: ['CHR-MAYA'] },
      story: { beat: 'Maya notices the missing key' },
      camera: { movement: 'slow_push_in', movement_intensity: 'low' },
      action: { subject: 'Maya glances down', temporal_beats: ['0-2s confident', '2-5s concern'] },
      generation: { mode_preference: 'text_to_video' } });
  assert.equal(a.statusCode, 200, a.body);
  const shotA = a.json();
  shotAId = shotA.id;
  assert.equal(shotA.status, 'DRAFT');
  assert.equal(shotA.locked_lock_ids.length, 1, 'should resolve the active CHR-MAYA lock id');

  const b = await call('POST', `/studio/projects/${projectId}/shots`,
    { shot_code: 'SH-020', order_index: 1, duration_target_s: 4,
      continuity: { characters: ['CHR-MAYA'] }, story: { beat: 'Maya decides to ask for help' },
      generation: { mode_preference: 'text_to_video' } });
  shotBId = b.json().id;
});

test('editing a shot while DRAFT is allowed', async () => {
  const r = await call('PATCH', `/studio/shots/${shotAId}`, { duration_target_s: 6 });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(Number(r.json().duration_target_s), 6);
});

let shotAAssetId, shotBAssetId;

test('generate a candidate for shot A and get an automated QC report back', async () => {
  const r = await call('POST', `/studio/shots/${shotAId}/generate`, {});
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.equal(body.asset.kind, 'VIDEO');
  assert.ok(['QC_PASS', 'QC_PASS_WITH_NOTES'].includes(body.asset.status),
    `expected a passing MOCK-mode disposition, got ${body.asset.status}`);
  assert.equal(body.qc_report.technical.skipped, true, 'MOCK mode should report technical QC as honestly skipped');
  shotAAssetId = body.asset.id;

  const shotAfter = await call('GET', `/studio/shots/${shotAId}/assets`);
  assert.equal(shotAfter.json().items.length, 1);
});

test('editing a shot is refused once it has moved past DRAFT', async () => {
  const r = await call('PATCH', `/studio/shots/${shotAId}`, { duration_target_s: 9 });
  assert.equal(r.statusCode, 422);
  assert.equal(r.json().code, 'GUARD_FAILED');
});

test('accepting a QC_BLOCKED asset is refused', async () => {
  // Forcing a real BLOCKED disposition needs a genuine ffprobe failure,
  // which MOCK mode's placeholder files don't produce, so this inserts a
  // QC_BLOCKED asset directly and exercises the accept guard against it.
  const blocked = await one(
    `INSERT INTO studio.assets (project_id, kind, status, storage_key)
     VALUES ($1,'VIDEO','QC_BLOCKED','studio/test/blocked.mp4') RETURNING *`, [projectId]);
  const r = await call('POST', `/studio/assets/${blocked.id}/accept`, {});
  assert.equal(r.statusCode, 422);
  assert.equal(r.json().code, 'GUARD_FAILED');
});

test('accept the shot A asset', async () => {
  const r = await call('POST', `/studio/assets/${shotAAssetId}/accept`, {});
  assert.equal(r.statusCode, 200, r.body);
  const shot = (await call('GET', `/studio/projects/${projectId}`)).json().shots.find(s => s.id === shotAId);
  assert.equal(shot.status, 'ACCEPTED');
  assert.equal(shot.accepted_asset_id, shotAAssetId);
});

test('assembly refuses while shot B still has no accepted asset, naming it', async () => {
  const r = await call('POST', `/studio/projects/${projectId}/assemble`, {});
  assert.equal(r.statusCode, 422);
  assert.ok(r.json().detail.includes('SH-020'));
});

test('generate and accept shot B, then assemble succeeds', async () => {
  const gen = await call('POST', `/studio/shots/${shotBId}/generate`, {});
  shotBAssetId = gen.json().asset.id;
  await call('POST', `/studio/assets/${shotBAssetId}/accept`, {});

  const asm = await call('POST', `/studio/projects/${projectId}/assemble`, {});
  assert.equal(asm.statusCode, 200, asm.body);
  const finalAsset = asm.json();
  assert.equal(finalAsset.kind, 'FINAL_CUT');

  const project = (await call('GET', `/studio/projects/${projectId}`)).json();
  assert.equal(project.state, 'ROUGH_CUT_VALIDATED');
  assert.equal(project.final_asset_id, finalAsset.id);
});

test('revising the character lock STALEs a shot generated against the old version, but not an ACCEPTED one', async () => {
  const revise = await call('POST', `/studio/projects/${projectId}/locks`,
    { level: 'L1_ENTITY', entity_type: 'CHARACTER', entity_code: 'CHR-MAYA',
      data: { name: 'Maya', wardrobe_variants: { default: 'NEW teal jacket' } } });
  assert.equal(revise.statusCode, 200, revise.body);
  assert.equal(revise.json().version, 2);
  // Both shots were generated against v1 of CHR-MAYA and both are already
  // ACCEPTED (shot A explicitly, shot B via the prior test), so this
  // revision should NOT mark either shot STALE; it should instead log a
  // note flagging that accepted shots exist against the superseded lock.
  const project = (await call('GET', `/studio/projects/${projectId}`)).json();
  const shotA = project.shots.find(s => s.id === shotAId);
  const shotB = project.shots.find(s => s.id === shotBId);
  assert.equal(shotA.status, 'ACCEPTED', 'accepted shots are not silently invalidated by a lock revision');
  assert.equal(shotB.status, 'ACCEPTED');
  const flagged = project.events.some(e => e.note?.includes('NOT invalidated'));
  assert.ok(flagged, 'a note should flag that accepted shots exist against the superseded lock version');
});

test('a DRAFT shot generated against a lock that then gets revised is marked STALE', async () => {
  const c = await call('POST', `/studio/projects/${projectId}/shots`,
    { shot_code: 'SH-030', order_index: 2, duration_target_s: 3,
      continuity: { characters: ['CHR-MAYA'] }, story: { beat: 'a filler shot' } });
  const shotCId = c.json().id;
  const genC = await call('POST', `/studio/shots/${shotCId}/generate`, {});
  assert.equal(genC.statusCode, 200, genC.body);

  const revise = await call('POST', `/studio/projects/${projectId}/locks`,
    { level: 'L1_ENTITY', entity_type: 'CHARACTER', entity_code: 'CHR-MAYA',
      data: { name: 'Maya', wardrobe_variants: { default: 'yet another jacket' } } });
  assert.equal(revise.json().staled_shots.some(s => s.id === shotCId), true,
    'the response should name the newly-STALE shot');

  const project = (await call('GET', `/studio/projects/${projectId}`)).json();
  const shotC = project.shots.find(s => s.id === shotCId);
  assert.equal(shotC.status, 'STALE');
});
