// Reference version selection tests (21 Aug 2026, owner question: "i dont
// understand how to change the references"). POST
// /studio/locks/:lockId/reference/select re-appends an EXISTING reference
// version so it becomes current again -- append-only, newest-wins, no
// deletion, no generation cost. Same login/token/call() pattern as the
// other studio test files; does not touch any existing test file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.LCOS_AI_PROVIDER = 'MOCK';
process.env.LCOS_ADAPTER_MODE = 'MOCK';
process.env.LCOS_STORAGE_DIR = '/tmp/lcos-refselect-test-storage';

const { buildServer } = await import('../src/server.mjs');
const { pool, one } = await import('../src/core.mjs');

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

let lockId, firstRefId, secondRefId;

test('set up a lock with two reference versions', async () => {
  const proj = (await call('POST', '/studio/projects',
    { title: 'Ref select test', format: 'explainer', aspect_ratio: '9:16', language: 'am' })).json();
  lockId = (await call('POST', `/studio/projects/${proj.id}/locks`,
    { level: 'L1_ENTITY', entity_type: 'CHARACTER', entity_code: 'CHR-SELECT-TEST',
      data: { name: 'Select Test' } })).json().id;
  firstRefId = (await call('POST', `/studio/locks/${lockId}/reference`, {})).json().id;
  secondRefId = (await call('POST', `/studio/locks/${lockId}/reference`, {})).json().id;
  const lock = await one(`SELECT reference_asset_ids FROM studio.locks WHERE id=$1`, [lockId]);
  assert.deepEqual(lock.reference_asset_ids, [firstRefId, secondRefId]);
});

test('selecting an earlier version re-appends it so it becomes current', async () => {
  const r = await call('POST', `/studio/locks/${lockId}/reference/select`, { asset_id: firstRefId });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().already_current, false);
  const lock = await one(`SELECT reference_asset_ids FROM studio.locks WHERE id=$1`, [lockId]);
  assert.deepEqual(lock.reference_asset_ids, [firstRefId, secondRefId, firstRefId],
    'append-only: history intact, chosen version now last (= current)');
});

test('selecting the already-current version is a no-op, not a duplicate append', async () => {
  const r = await call('POST', `/studio/locks/${lockId}/reference/select`, { asset_id: firstRefId });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().already_current, true);
  const lock = await one(`SELECT reference_asset_ids FROM studio.locks WHERE id=$1`, [lockId]);
  assert.equal(lock.reference_asset_ids.length, 3, 'no extra append');
});

test('selecting an asset that is not one of this lock\'s versions is refused', async () => {
  const r = await call('POST', `/studio/locks/${lockId}/reference/select`, { asset_id: crypto.randomUUID() });
  assert.equal(r.statusCode, 422);
});

test('missing asset_id is refused', async () => {
  const r = await call('POST', `/studio/locks/${lockId}/reference/select`, {});
  assert.equal(r.statusCode, 422);
});
