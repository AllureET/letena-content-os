// Video Studio budget guardrail tests (playbook 21, 18 Aug 2026 follow-up).
// Covers the four paid-generation routes' shared checkAndSpendBudget path:
// refuse at/above 90% of budget_cap_usd, allow an approver override, warn
// at 60%/80%, spend recorded only after a real success, and a null
// budget_cap_usd never blocking or warning no matter how much is "spent."
// Same login/token/call() pattern as studio.test.mjs; this file does not
// touch studio.test.mjs itself.
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
  token = await login('producer@letena.local'); // producer role holds studio.approve too
});
after(async () => { await app.close(); await pool.end(); });

const newProject = async (title, budgetCapUsd) => {
  const r = await call('POST', '/studio/projects',
    { title, format: 'ai_story', aspect_ratio: '9:16', language: 'am',
      ...(budgetCapUsd !== undefined ? { budget_cap_usd: budgetCapUsd } : {}) });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};
const newShot = async (projectId, shotCode, durationTargetS = 5) => {
  const r = await call('POST', `/studio/projects/${projectId}/shots`,
    { shot_code: shotCode, order_index: 0, duration_target_s: durationTargetS,
      story: { beat: 'a beat' }, generation: { mode_preference: 'text_to_video' } });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};
const getProject = async (projectId) => (await call('GET', `/studio/projects/${projectId}`)).json();

// ---------------------------------------------------------------------
// (a) + (b): a $1 cap, a shot whose estimated cost alone crosses 90% of
// it (KLING_VIDEO_PER_S 0.35 * 5s = $1.75), refused, then the SAME call
// succeeding once an approver overrides.
// ---------------------------------------------------------------------
test('a tiny budget cap refuses generation whose estimated cost alone crosses 90%, spent_usd unchanged', async () => {
  const project = await newProject('Budget refusal case', 1.00);
  const shot = await newShot(project.id, 'SH-B1');

  const refused = await call('POST', `/studio/shots/${shot.id}/generate`, {});
  assert.equal(refused.statusCode, 422, refused.body);
  const body = refused.json();
  assert.equal(body.code, 'BUDGET_EXCEEDED');
  assert.ok(body.detail.includes('1.00'), 'message should name budget_cap_usd');
  assert.ok(body.detail.includes('1.75'), 'message should name the estimated cost of this call');
  assert.ok(body.detail.includes('0.00') || body.detail.includes('$0.00'),
    'message should name spent_usd (still zero before any spend)');

  const afterRefusal = await getProject(project.id);
  assert.equal(Number(afterRefusal.spent_usd), 0, 'a refused call must not touch spent_usd');
  // Nothing was attempted, so the shot's status must be left exactly as
  // it was, not flipped to GENERATING or NEEDS_REVIEW.
  const shotAfter = afterRefusal.shots.find(s => s.id === shot.id);
  assert.equal(shotAfter.status, 'DRAFT');
});

test('the same refused call succeeds with override_budget:true from an approver, and logs an event', async () => {
  const project = await newProject('Budget override case', 1.00);
  const shot = await newShot(project.id, 'SH-B2');

  const refused = await call('POST', `/studio/shots/${shot.id}/generate`, {});
  assert.equal(refused.statusCode, 422, refused.body);

  const overridden = await call('POST', `/studio/shots/${shot.id}/generate`, { override_budget: true });
  assert.equal(overridden.statusCode, 200, overridden.body);
  const body = overridden.json();
  assert.equal(body.budget_warning.threshold, 90);
  assert.equal(Number(body.budget_warning.budget_cap_usd), 1.00);
  assert.equal(Number(body.budget_warning.estimated_cost_usd), 1.75);

  const after = await getProject(project.id);
  assert.equal(Number(after.spent_usd), 1.75,
    'spend is recorded from the estimate because MOCK adapters report cost_usd: 0');
  const overrideEvent = after.events.find(e => e.note?.includes('budget guardrail overridden'));
  assert.ok(overrideEvent, 'an override must be logged as an event');
  assert.ok(overrideEvent.note.includes('producer@letena.local'));
});

// ---------------------------------------------------------------------
// (c) ample headroom: generation succeeds with no warning, and spent_usd
// increases by the estimate afterward.
// ---------------------------------------------------------------------
test('ample budget headroom generates successfully with no budget_warning, and spent_usd increases by the estimate', async () => {
  const project = await newProject('Ample headroom case', 100.00);
  const shot = await newShot(project.id, 'SH-C1');

  const r = await call('POST', `/studio/shots/${shot.id}/generate`, {});
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.equal(body.budget_warning, undefined, 'no field at all below the 60% threshold');

  const after = await getProject(project.id);
  assert.equal(Number(after.spent_usd), 1.75, 'KLING_VIDEO_PER_S 0.35 * 5s duration target');
});

// ---------------------------------------------------------------------
// (d) 60% and 80% warning thresholds, each producing budget_warning with
// the right threshold value; nothing below 60%. Uses the lock reference
// route (flat GEMINI_REFERENCE_IMAGE estimate) and direct SQL to
// fast-forward spent_usd into each band rather than many real calls.
// ---------------------------------------------------------------------
test('60% and 80% thresholds each produce budget_warning with the right threshold, and nothing below 60%', async () => {
  const project = await newProject('Threshold case', 10.00);
  const lock = await one(
    `INSERT INTO studio.locks (project_id, level, entity_type, entity_code, version, data)
     VALUES ($1,'L0_PROJECT','STYLE','STYLE-MAIN',1,$2) RETURNING *`,
    [project.id, JSON.stringify({ style_summary: 'test style' })]);

  // Below 60%: spent_usd 0, estimate 0.04 on a $10 cap -> ratio ~0.004.
  const below = await call('POST', `/studio/locks/${lock.id}/reference`, {});
  assert.equal(below.statusCode, 200, below.body);
  assert.equal(below.json().budget_warning, undefined, 'no field at all below 60%');

  // 60% band: spent_usd 6.46 + estimate 0.04 = 6.50 -> ratio 0.65.
  await q(`UPDATE studio.projects SET spent_usd=$2 WHERE id=$1`, [project.id, 6.46]);
  const at60 = await call('POST', `/studio/locks/${lock.id}/reference`, {});
  assert.equal(at60.statusCode, 200, at60.body);
  assert.equal(at60.json().budget_warning.threshold, 60);
  assert.equal(Number(at60.json().budget_warning.spent_usd), 6.46);

  // 80% band: spent_usd 8.46 + estimate 0.04 = 8.50 -> ratio 0.85.
  await q(`UPDATE studio.projects SET spent_usd=$2 WHERE id=$1`, [project.id, 8.46]);
  const at80 = await call('POST', `/studio/locks/${lock.id}/reference`, {});
  assert.equal(at80.statusCode, 200, at80.body);
  assert.equal(at80.json().budget_warning.threshold, 80);
  assert.equal(Number(at80.json().budget_warning.spent_usd), 8.46);
});

// ---------------------------------------------------------------------
// (e) budget_cap_usd left null: never blocked, never warned, no matter
// how much spent_usd already shows.
// ---------------------------------------------------------------------
test('a null budget_cap_usd is never blocked and never warned regardless of spent_usd', async () => {
  const project = await newProject('No cap case'); // budget_cap_usd omitted -> null
  assert.equal(project.budget_cap_usd, null);
  await q(`UPDATE studio.projects SET spent_usd=$2 WHERE id=$1`, [project.id, 999999.99]);
  const shot = await newShot(project.id, 'SH-E1');

  const r = await call('POST', `/studio/shots/${shot.id}/generate`, {});
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().budget_warning, undefined, 'no cap means no warning either');

  const after = await getProject(project.id);
  assert.equal(after.budget_cap_usd, null);
  assert.equal(Number(after.spent_usd), 999999.99 + 1.75, 'spend still tracked even with no cap to enforce');
});
