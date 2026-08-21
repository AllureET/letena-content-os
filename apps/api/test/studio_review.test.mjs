// Shot review: approve, reject, comment (21 Aug 2026).
//
// Owner, looking at a shot sitting in NEEDS_REVIEW: "this says needs review
// but doesnt offer me a viewer to view it or a place to approve, reject,
// make comment or whatever". Accept was the only verdict the API could
// express, so a clip that was wrong had no way to be marked wrong. The shot
// just sat in NEEDS_REVIEW and the only recourse was to generate over it. A
// review step you can only pass is not a review step.
//
// Covers, in MOCK mode: reject sends the shot back to DRAFT so it can be
// edited and regenerated, notes are recorded on all three verdicts, and
// rejecting an accepted video that a later shot already continues from is
// refused by name rather than silently orphaning that shot.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.LCOS_AI_PROVIDER = 'MOCK';
process.env.LCOS_ADAPTER_MODE = 'MOCK';
process.env.LCOS_STORAGE_DIR = '/tmp/lcos-review-test-storage';

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

let projectId, shotA, shotB, assetA;

const mkShot = async (shot_code, order_index) => (await call('POST', `/studio/projects/${projectId}/shots`,
  { shot_code, order_index, duration_target_s: 5, story: { beat: shot_code },
    generation: { mode_preference: 'text_to_video' } })).json();

test('set up a project with two shots and a rendered video on each', async () => {
  projectId = (await call('POST', '/studio/projects',
    { title: 'Review test', format: 'explainer', aspect_ratio: '9:16', language: 'am' })).json().id;
  shotA = await mkShot('SH-A', 0);
  shotB = await mkShot('SH-B', 1);
  assetA = (await call('POST', `/studio/shots/${shotA.id}/generate`, {})).json().asset;
  assert.equal(assetA.kind, 'VIDEO');
});

test('a note on its own records the comment and changes no status', async () => {
  const before = await one(`SELECT status FROM studio.assets WHERE id=$1`, [assetA.id]);
  const r = await call('POST', `/studio/assets/${assetA.id}/note`, { note: 'the light is a little cold' });
  assert.equal(r.statusCode, 200, r.body);
  const after = await one(`SELECT status, settings FROM studio.assets WHERE id=$1`, [assetA.id]);
  assert.equal(after.status, before.status, 'a comment is not a verdict');
  assert.equal(after.settings.review_note, 'the light is a little cold');
});

test('an empty note is refused rather than saved as nothing', async () => {
  const r = await call('POST', `/studio/assets/${assetA.id}/note`, { note: '   ' });
  assert.equal(r.statusCode, 422);
});

test('rejecting sends the shot back to DRAFT and records why', async () => {
  const r = await call('POST', `/studio/assets/${assetA.id}/reject`, { note: 'she looks away on the last beat' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().shot_status, 'DRAFT');
  const a = await one(`SELECT status, settings FROM studio.assets WHERE id=$1`, [assetA.id]);
  assert.equal(a.status, 'REJECTED');
  assert.equal(a.settings.review_note, 'she looks away on the last beat');
  const s = await one(`SELECT status FROM studio.shots WHERE id=$1`, [shotA.id]);
  assert.equal(s.status, 'DRAFT',
    'DRAFT is the state that says generate this again, and the only one PATCH will let you edit');
});

test('the reason reaches the project timeline, not just the asset row', async () => {
  const ev = await one(`SELECT note FROM studio.events WHERE project_id=$1 AND artifact=$2
                        AND note LIKE 'rejected%' ORDER BY at DESC LIMIT 1`, [projectId, assetA.id]);
  assert.match(ev.note, /she looks away on the last beat/);
});

test('a rejected shot can be generated again, and accepted with a note', async () => {
  const again = (await call('POST', `/studio/shots/${shotA.id}/generate`, {})).json().asset;
  assert.notEqual(again.id, assetA.id, 'generating again must produce a new asset, not overwrite the rejected one');
  const r = await call('POST', `/studio/assets/${again.id}/accept`, { note: 'good take' });
  assert.equal(r.statusCode, 200, r.body);
  const a = await one(`SELECT status, settings FROM studio.assets WHERE id=$1`, [again.id]);
  assert.equal(a.status, 'ACCEPTED');
  assert.equal(a.settings.review_note, 'good take');
  const s = await one(`SELECT status, accepted_asset_id FROM studio.shots WHERE id=$1`, [shotA.id]);
  assert.equal(s.status, 'ACCEPTED');
  assert.equal(s.accepted_asset_id, again.id);
  assetA = again;
});

test('rejecting an accepted video a later shot continues from is refused by name', async () => {
  const cont = await call('POST', `/studio/shots/${shotB.id}/continue-from-previous`, {});
  assert.equal(cont.statusCode, 200, cont.body);
  const r = await call('POST', `/studio/assets/${assetA.id}/reject`, {});
  assert.equal(r.statusCode, 422);
  assert.equal(r.json().guard, 'rejectWouldOrphanContinuity');
  assert.match(r.json().detail, /SH-B/,
    'naming the dependent shot is the difference between a useful refusal and a shrug');
  const a = await one(`SELECT status FROM studio.assets WHERE id=$1`, [assetA.id]);
  assert.equal(a.status, 'ACCEPTED', 'the refusal must not half-apply');
});

test('with nothing continuing from it, an accepted video can still be rejected', async () => {
  await q(`UPDATE studio.shots SET generation = generation - 'continued_from_shot_id' WHERE id=$1`, [shotB.id]);
  const r = await call('POST', `/studio/assets/${assetA.id}/reject`, { note: 'changed my mind' });
  assert.equal(r.statusCode, 200, r.body);
  const s = await one(`SELECT status, accepted_asset_id FROM studio.shots WHERE id=$1`, [shotA.id]);
  assert.equal(s.status, 'DRAFT');
  assert.equal(s.accepted_asset_id, null, 'a rejected video must stop being the shot\'s accepted one');
});

test('rejecting something that does not exist is a 404, not a silent success', async () => {
  const r = await call('POST', '/studio/assets/00000000-0000-0000-0000-000000000000/reject', {});
  assert.equal(r.statusCode, 404);
});
