// Video Studio project archive/unarchive (19 Aug 2026). Nate: "im looking a
// t the studio project for spotting on the pill, and I dont see. a way to
// dlete it" -- there was no delete/archive/cancel route anywhere in
// studio.mjs. This adds a reversible archive instead of a hard delete
// (child tables cascade-delete on a real DELETE, which would silently wipe
// audit history and orphan generated media -- see migration
// 0034_studio_project_archive.sql for the full reasoning). This file only
// tests the archive/unarchive/list-filtering plumbing; it does not touch
// studio.test.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.LCOS_AI_PROVIDER = 'MOCK';
process.env.LCOS_ADAPTER_MODE = 'MOCK';
process.env.LCOS_STORAGE_DIR = '/tmp/lcos-test-storage';

const { buildServer } = await import('../src/server.mjs');
const { pool } = await import('../src/core.mjs');

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

let projectId;

test('create a project to archive', async () => {
  const r = await call('POST', '/studio/projects', { title: 'Spotting on the pill', format: 'explainer',
    aspect_ratio: '9:16', language: 'am' });
  assert.equal(r.statusCode, 200, r.body);
  projectId = r.json().id;
});

test('archiving hides the project from the default list but not from direct fetch', async () => {
  const arch = await call('POST', `/studio/projects/${projectId}/archive`);
  assert.equal(arch.statusCode, 200, arch.body);
  assert.ok(arch.json().archived_at);

  const list = await call('GET', '/studio/projects');
  assert.ok(!list.json().items.some(p => p.id === projectId),
    'an archived project must not appear in the default project list');

  const withArchived = await call('GET', '/studio/projects?include_archived=1');
  assert.ok(withArchived.json().items.some(p => p.id === projectId),
    '?include_archived=1 must still surface it');

  const direct = await call('GET', `/studio/projects/${projectId}`);
  assert.equal(direct.statusCode, 200, 'archiving must not make the project itself unreachable');
  assert.ok(direct.json().archived_at);
});

test('archiving is idempotent and archiving never touches locks/shots/events', async () => {
  const before2 = await call('GET', `/studio/projects/${projectId}`);
  const lockCount = (before2.json().locks ?? []).length;
  const eventCountBefore = (before2.json().events ?? []).length;

  const again = await call('POST', `/studio/projects/${projectId}/archive`);
  assert.equal(again.statusCode, 200, again.body);

  const after2 = await call('GET', `/studio/projects/${projectId}`);
  assert.equal((after2.json().locks ?? []).length, lockCount);
  assert.ok((after2.json().events ?? []).length >= eventCountBefore,
    'archive should only ever add events, never remove them');
});

test('unarchiving brings it back into the default list', async () => {
  const un = await call('POST', `/studio/projects/${projectId}/unarchive`);
  assert.equal(un.statusCode, 200, un.body);
  assert.equal(un.json().archived_at, null);

  const list = await call('GET', '/studio/projects');
  assert.ok(list.json().items.some(p => p.id === projectId),
    'unarchiving must bring the project back into the default list');
});

test('archiving an unknown project 404s', async () => {
  const r = await call('POST', '/studio/projects/00000000-0000-0000-0000-000000000000/archive');
  assert.equal(r.statusCode, 404);
});
