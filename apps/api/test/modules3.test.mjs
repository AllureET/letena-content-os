// Tests for increment 3: voice gate, expiry sweep, costs, users admin.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.LCOS_AI_PROVIDER = 'MOCK';
process.env.LCOS_ADAPTER_MODE = 'MOCK';
process.env.LCOS_STORAGE_DIR = '/tmp/lcos-test-storage';

const { buildServer } = await import('../src/server.mjs');
const { pool, q, one } = await import('../src/core.mjs');

let app, tokens = {};
const login = async (email) => (await app.inject({ method: 'POST', url: '/api/v1/auth/login',
  payload: { email, password: 'letena-dev-2026' } })).json().token;
const call = (method, url, token, payload) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });

before(async () => {
  app = await buildServer();
  for (const r of ['meddir', 'content', 'dev', 'admin', 'social']) tokens[r] = await login(`${r}@letena.local`);
});
after(async () => { await app.close(); await pool.end(); });

test('expiry sweep moves an overdue approved card to NEEDS_UPDATE', async () => {
  // Make EC-005 overdue (it is demo-approved).
  const card = await one(`SELECT id, status FROM lcos.knowledge_cards WHERE code='EC-005'`);
  if (card.status !== 'APPROVED') {
    await q(`UPDATE lcos.knowledge_cards SET status='APPROVED' WHERE id=$1`, [card.id]);
  }
  await q(`UPDATE lcos.knowledge_cards SET review_due_at = CURRENT_DATE - 1 WHERE id=$1`, [card.id]);
  const r = await call('POST', '/api/v1/knowledge/sweep-expiry', tokens.meddir);
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(r.json().expired_cards.includes('EC-005'));
  const after1 = await one(`SELECT status FROM lcos.knowledge_cards WHERE id=$1`, [card.id]);
  assert.equal(after1.status, 'NEEDS_UPDATE');
  // restore for other suites
  await q(`UPDATE lcos.knowledge_cards SET status='APPROVED', review_due_at=CURRENT_DATE+180 WHERE id=$1`, [card.id]);
});

test('expiry sweep creates a review task inside the 30-day window', async () => {
  const card = await one(`SELECT id FROM lcos.knowledge_cards WHERE code='EC-004'`);
  await q(`UPDATE lcos.review_tasks SET status='CANCELLED'
           WHERE review_type='KNOWLEDGE_CARD' AND object_id=$1 AND status IN ('OPEN','IN_PROGRESS')`,
    [card.id]);
  await q(`UPDATE lcos.knowledge_cards SET status='APPROVED', review_due_at = CURRENT_DATE + 10 WHERE id=$1`, [card.id]);
  const r = await call('POST', '/api/v1/knowledge/sweep-expiry', tokens.meddir);
  assert.equal(r.statusCode, 200);
  assert.ok(r.json().review_tasks_created.includes('EC-004'));
  // idempotent: second run creates no duplicate
  const r2 = await call('POST', '/api/v1/knowledge/sweep-expiry', tokens.meddir);
  assert.ok(!r2.json().review_tasks_created.includes('EC-004'));
  await q(`UPDATE lcos.knowledge_cards SET review_due_at = CURRENT_DATE + 180 WHERE id=$1`, [card.id]);
});

test('sweep is denied to the content lead', async () => {
  const r = await call('POST', '/api/v1/knowledge/sweep-expiry', tokens.content);
  assert.equal(r.statusCode, 403);
});

test('costs endpoint returns the four rollups', async () => {
  const r = await call('GET', '/api/v1/analytics/costs', tokens.content);
  assert.equal(r.statusCode, 200, r.body);
  const c = r.json();
  for (const k of ['by_month', 'by_agent', 'renders_by_month', 'per_piece']) {
    assert.ok(Array.isArray(c[k]), k);
  }
  assert.ok(c.by_agent.length >= 1, 'agent costs recorded from prior suites');
});

test('users admin: admin creates, grants, deactivates; developer denied', async () => {
  const denied = await call('GET', '/api/v1/platform/users', tokens.dev);
  assert.equal(denied.statusCode, 403);
  const email = `test-user-${Date.now()}@letena.local`;
  const created = await call('POST', '/api/v1/platform/users', tokens.admin,
    { email, full_name: 'Test Person', password: 'a-long-password-123', role_slug: 'viewer' });
  assert.equal(created.statusCode, 201, created.body);
  const uid = created.json().id;
  const short = await call('POST', '/api/v1/platform/users', tokens.admin,
    { email: 'x@letena.local', full_name: 'X', password: 'short', role_slug: 'viewer' });
  assert.equal(short.statusCode, 422);
  const grant = await call('POST', `/api/v1/platform/users/${uid}/roles`, tokens.admin,
    { role_slug: 'social_lead' });
  assert.equal(grant.statusCode, 200);
  const list = await call('GET', '/api/v1/platform/users', tokens.admin);
  const row = list.json().items.find(u => u.email === email);
  assert.deepEqual(row.roles.sort(), ['social_lead', 'viewer']);
  const deact = await call('POST', `/api/v1/platform/users/${uid}/deactivate`, tokens.admin);
  assert.equal(deact.statusCode, 200);
  const gone = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
    payload: { email, password: 'a-long-password-123' } });
  assert.equal(gone.statusCode, 401, 'deactivated user cannot log in');
});

test('admin cannot deactivate themselves', async () => {
  const me = await one(`SELECT id FROM lcos.users WHERE lower(email)='admin@letena.local'`);
  const r = await call('POST', `/api/v1/platform/users/${me.id}/deactivate`, tokens.admin);
  assert.equal(r.statusCode, 422);
  assert.equal(r.json().guard, 'notSelf');
});
