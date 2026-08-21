// Two dead ends a shot could get stuck in (21 Aug 2026), both found while
// trying to move the Spotting on the Pill shots to a rebuilt environment.
//
// 1. A generate call where every attempt failed left the shot in
//    NEEDS_REVIEW. There is nothing to review when nothing rendered, and
//    that state cannot be edited (PATCH only touches DRAFT and STALE) or
//    rejected (there is no asset to reject), so a shot whose render failed
//    could not be changed and tried again without going into the database.
//
// 2. locked_lock_ids was resolved once at shot creation and never again, so
//    moving a shot to a different environment updated the continuity block
//    and left the shot bound to the old lock. Everything downstream reads
//    locked_lock_ids, not continuity, so the shot would have gone on
//    composing the old set while the screen said it was somewhere else.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.LCOS_AI_PROVIDER = 'MOCK';
process.env.LCOS_ADAPTER_MODE = 'MOCK';
process.env.LCOS_STORAGE_DIR = '/tmp/lcos-shotstate-test-storage';

const { buildServer } = await import('../src/server.mjs');
const { pool, q, one } = await import('../src/core.mjs');

let app, token;
const login = async (email) => (await app.inject({ method: 'POST', url: '/api/v1/auth/login',
  payload: { email, password: 'letena-dev-2026' } })).json().token;
const call = (method, url, payload) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` }, payload });

before(async () => { app = await buildServer(); token = await login('producer@letena.local'); });
after(async () => { await app.close(); await pool.end(); });

let projectId, envAId, envBId, shotId;

test('set up a project with two environments and a shot in the first', async () => {
  projectId = (await call('POST', '/studio/projects',
    { title: 'Shot state test', format: 'explainer', aspect_ratio: '9:16', language: 'am' })).json().id;
  envAId = (await call('POST', `/studio/projects/${projectId}/locks`,
    { level: 'L1_ENTITY', entity_type: 'ENVIRONMENT', entity_code: 'ENV-A', data: { architecture: 'room A' } })).json().id;
  envBId = (await call('POST', `/studio/projects/${projectId}/locks`,
    { level: 'L1_ENTITY', entity_type: 'ENVIRONMENT', entity_code: 'ENV-B', data: { architecture: 'room B' } })).json().id;
  shotId = (await call('POST', `/studio/projects/${projectId}/shots`,
    { shot_code: 'SH-STATE', order_index: 0, duration_target_s: 5, story: { beat: 'state' },
      continuity: { environment: 'ENV-A' }, generation: { mode_preference: 'text_to_video' } })).json().id;
  const shot = await one(`SELECT locked_lock_ids FROM studio.shots WHERE id=$1`, [shotId]);
  assert.deepEqual(shot.locked_lock_ids, [envAId]);
});

test('moving a shot to another environment re-binds it to that lock', async () => {
  const r = await call('PATCH', `/studio/shots/${shotId}`, { continuity: { environment: 'ENV-B' } });
  assert.equal(r.statusCode, 200, r.body);
  const shot = await one(`SELECT locked_lock_ids, continuity FROM studio.shots WHERE id=$1`, [shotId]);
  assert.deepEqual(shot.locked_lock_ids, [envBId],
    'compose reads locked_lock_ids, not continuity, so leaving the old id here composes the old room');
  assert.equal(shot.continuity.environment, 'ENV-B');
});

test('an edit that does not touch continuity leaves the locks alone', async () => {
  const r = await call('PATCH', `/studio/shots/${shotId}`, { story: { beat: 'a different beat' } });
  assert.equal(r.statusCode, 200, r.body);
  const shot = await one(`SELECT locked_lock_ids FROM studio.shots WHERE id=$1`, [shotId]);
  assert.deepEqual(shot.locked_lock_ids, [envBId]);
});

test('clearing the continuity block clears the bindings rather than keeping stale ones', async () => {
  await call('PATCH', `/studio/shots/${shotId}`, { continuity: {} });
  const shot = await one(`SELECT locked_lock_ids FROM studio.shots WHERE id=$1`, [shotId]);
  assert.deepEqual(shot.locked_lock_ids, []);
  await call('PATCH', `/studio/shots/${shotId}`, { continuity: { environment: 'ENV-B' } });
});

test('a shot whose every generate attempt failed goes back to DRAFT, not NEEDS_REVIEW', async () => {
  // KLING is an unimplemented skeleton that throws in production mode, so
  // pinning it is the honest way to make a real generate call fail.
  const failing = (await call('POST', `/studio/projects/${projectId}/shots`,
    { shot_code: 'SH-FAIL', order_index: 1, duration_target_s: 5, story: { beat: 'will fail' },
      generation: { mode_preference: 'text_to_video', engine: 'KLING' } })).json();
  const { setCred } = await import('../src/creds.mjs');
  await setCred('LCOS_ADAPTER_MODE', 'PRODUCTION');
  try {
    const r = await call('POST', `/studio/shots/${failing.id}/generate`, {});
    assert.equal(r.statusCode, 502, r.body);
  } finally {
    await setCred('LCOS_ADAPTER_MODE', '');
  }
  const shot = await one(`SELECT status FROM studio.shots WHERE id=$1`, [failing.id]);
  assert.equal(shot.status, 'DRAFT',
    'nothing rendered, so there is nothing to review -- and NEEDS_REVIEW cannot be edited or rejected');

  // And DRAFT is not just cosmetic: the shot must actually be editable again.
  const edit = await call('PATCH', `/studio/shots/${failing.id}`, { story: { beat: 'try something else' } });
  assert.equal(edit.statusCode, 200, edit.body);
});

test('the failure is still on the record, it is just not blocking the shot', async () => {
  const ev = await q(`SELECT note FROM studio.events WHERE project_id=$1 AND note LIKE '%FAILED%'`, [projectId]);
  assert.ok(ev.rows.length, 'every attempt the ladder made is written to the project timeline');
});
