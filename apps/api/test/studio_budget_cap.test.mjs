// Changing a budget cap after the project exists (22 Aug 2026).
//
// Owner, mid-run: "raise the cap to 20". There was no way to do it. The cap
// could be set once, at creation, and never again, so a project that turned
// out to need more had two options: pass override_budget on every call, which
// defeats the point of having a cap at all, or abandon the project and start
// again. A cap you cannot revise is not a budget, it is a wall.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.LCOS_AI_PROVIDER = 'MOCK';
process.env.LCOS_ADAPTER_MODE = 'MOCK';
process.env.LCOS_STORAGE_DIR = '/tmp/lcos-budgetcap-test-storage';

const { buildServer } = await import('../src/server.mjs');
const { pool, q, one } = await import('../src/core.mjs');

let app, token, approver;
const login = async (email) => (await app.inject({ method: 'POST', url: '/api/v1/auth/login',
  payload: { email, password: 'letena-dev-2026' } })).json().token;
const call = (method, url, payload, tk) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${tk ?? token}` }, payload });

before(async () => {
  app = await buildServer();
  token = await login('producer@letena.local');
  approver = token;
});
after(async () => { await app.close(); await pool.end(); });

let projectId;

test('a project can be created with a cap', async () => {
  projectId = (await call('POST', '/studio/projects',
    { title: 'Budget cap test', format: 'explainer', aspect_ratio: '9:16', language: 'am',
      budget_cap_usd: 8 })).json().id;
  const p = (await call('GET', `/studio/projects/${projectId}`)).json();
  assert.equal(Number(p.budget_cap_usd), 8);
});

test('the cap can be raised', async () => {
  const r = await call('POST', `/studio/projects/${projectId}/budget`, { budget_cap_usd: 20 });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(Number(r.json().budget_cap_usd), 20);
});

test('the change is on the event timeline with both numbers', async () => {
  const events = (await q(`SELECT note FROM studio.events WHERE project_id=$1 ORDER BY at DESC`, [projectId])).rows;
  const note = events.find(e => /budget cap changed/.test(e.note ?? ''));
  assert.ok(note, 'a spending limit change must be recorded, not silent');
  assert.match(note.note, /\$8\.00 to \$20\.00/);
});

test('the cap can be removed entirely with null', async () => {
  const r = await call('POST', `/studio/projects/${projectId}/budget`, { budget_cap_usd: null });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().budget_cap_usd, null);
});

test('omitting the field is a malformed request, not a silent no-op', async () => {
  const r = await call('POST', `/studio/projects/${projectId}/budget`, {});
  assert.equal(r.statusCode, 422);
  assert.match(r.json().detail, /budget_cap_usd is required/);
  assert.match(r.json().detail, /null to remove the cap/,
    'null and absent mean different things and the message should say so');
});

test('a zero or negative cap is refused', async () => {
  for (const bad of [0, -5, 'twenty']) {
    const r = await call('POST', `/studio/projects/${projectId}/budget`, { budget_cap_usd: bad });
    assert.equal(r.statusCode, 422, `${JSON.stringify(bad)} should be refused`);
    assert.match(r.json().detail, /positive number or null/);
  }
});

test('a cap below what the project already spent is refused', async () => {
  await q(`UPDATE studio.projects SET spent_usd=5.83 WHERE id=$1`, [projectId]);
  const r = await call('POST', `/studio/projects/${projectId}/budget`, { budget_cap_usd: 2 });
  assert.equal(r.statusCode, 422);
  assert.equal(r.json().guard, 'capBelowSpend');
  assert.match(r.json().detail, /already spent \$5\.83/);
  assert.match(r.json().detail, /cannot un-spend/,
    'the refusal should explain why, since the obvious reading is that lowering a cap should just work');
});

test('a cap exactly equal to spend is allowed', async () => {
  const r = await call('POST', `/studio/projects/${projectId}/budget`, { budget_cap_usd: 5.83 });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(Number(r.json().budget_cap_usd), 5.83);
});

test('raising a cap needs approve, not merely write', async () => {
  const src = await (await import('node:fs/promises')).readFile(
    new URL('../src/modules/studio.mjs', import.meta.url), 'utf8');
  const route = src.slice(src.indexOf("app.post('/studio/projects/:id/budget'"));
  assert.match(route.slice(0, 200), /requirePerm\('studio\.approve'\)/,
    'raising a spending limit is an approval, same as assembling or accepting work');
});

test('a missing project is a 404, not a silent create', async () => {
  const r = await call('POST', '/studio/projects/00000000-0000-0000-0000-000000000000/budget',
    { budget_cap_usd: 10 });
  assert.equal(r.statusCode, 404);
});

test('the project screen offers the cap editor, and only to an approver', async () => {
  const { readFile } = await import('node:fs/promises');
  const web = await readFile(new URL('../../web/app.js', import.meta.url), 'utf8');
  assert.match(web, /data-stbudget=/, 'there must be a way to set the cap without an API call');
  assert.match(web, /data-stbudgetclear=/);
  assert.match(web, /capEditHtml = \(p\) => can\('studio\.approve'\)/,
    'the control is gated on the same permission the route is');
  assert.match(web, /\[data-stbudget\],\[data-stbudgetclear\]/,
    'every new data attribute has to join the click-delegation allowlist or the button silently does nothing');
  const clear = web.slice(web.indexOf('if (b.dataset.stbudgetclear)'));
  assert.match(clear.slice(0, 400), /Click again to remove/,
    'removing a ceiling is a two-step action, like every other destructive control here');
});

test('the editor is shown even when the project has no cap today', async () => {
  const { readFile } = await import('node:fs/promises');
  const web = await readFile(new URL('../../web/app.js', import.meta.url), 'utf8');
  const block = web.slice(web.indexOf('if (p.budget_cap_usd != null) {'));
  assert.match(block.slice(0, 1800), /no cap<\/span>/,
    'a project with no ceiling is a state a producer may want to end, so the control cannot be hidden behind having one');
});
