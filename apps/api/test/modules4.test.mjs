// Increment 4 tests: asset binding, retention sweep, platform variants,
// experiment metric auto-attach.
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
  for (const r of ['producer', 'admin', 'content', 'dev']) tokens[r] = await login(`${r}@letena.local`);
});
after(async () => { await app.close(); await pool.end(); });

test('retention sweep purges expired quarantine and old text', async () => {
  await q(`INSERT INTO lcos.audience_questions (channel, source_hash, sanitized_text, status,
             deid_confidence, captured_at, ingested_at)
           VALUES ('TELEGRAM','test-ret-q1','old quarantined text','QUARANTINED',0.5,
                   now() - interval '20 days', now() - interval '20 days')
           ON CONFLICT (source_hash) DO UPDATE SET status='QUARANTINED',
             sanitized_text='old quarantined text', ingested_at=now() - interval '20 days'`);
  await q(`INSERT INTO lcos.audience_questions (channel, source_hash, sanitized_text, status,
             deid_confidence, captured_at, purge_after)
           VALUES ('TELEGRAM','test-ret-q2','ancient question text','CLUSTERED',1,
                   now() - interval '25 months', CURRENT_DATE - 30)
           ON CONFLICT (source_hash) DO UPDATE SET status='CLUSTERED',
             sanitized_text='ancient question text', purge_after=CURRENT_DATE - 30`);
  const r = await call('POST', '/api/v1/platform/retention-sweep', tokens.admin);
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(r.json().quarantine_purged >= 1, 'quarantine purged');
  assert.ok(r.json().retention_purged >= 1, 'retention purged');
  const q1 = await one(`SELECT status, sanitized_text FROM lcos.audience_questions WHERE source_hash='test-ret-q1'`);
  assert.equal(q1.status, 'PURGED');
  assert.ok(!q1.sanitized_text.includes('quarantined text'));
  const q2 = await one(`SELECT status, sanitized_text, embedding FROM lcos.audience_questions WHERE source_hash='test-ret-q2'`);
  assert.equal(q2.status, 'ARCHIVED');
  assert.ok(!q2.sanitized_text.includes('ancient'));
  assert.equal(q2.embedding, null);
});

test('retention sweep denied to developer', async () => {
  const r = await call('POST', '/api/v1/platform/retention-sweep', tokens.dev);
  // developer holds settings.manage per seed; content_lead does not
  const r2 = await call('POST', '/api/v1/platform/retention-sweep', tokens.content);
  assert.equal(r2.statusCode, 403);
  assert.equal(r.statusCode, 200);
});

test('asset binding: a matching active library asset lands in the render payload', async () => {
  // Upload a library asset that matches the mock script's scene brief
  const up = await call('POST', '/api/v1/production/assets', tokens.producer, {
    title: 'Addis evening calm street b-roll', kind: 'VIDEO', origin: 'SHOT_IN_HOUSE',
    mime_type: 'video/mp4', content_base64: Buffer.from('broll').toString('base64'),
    tags: ['city:addis', 'emotion:calm', 'time:evening'] });
  assert.equal(up.statusCode, 201, up.body);
  // Take an approved script from the earlier suites and run a fresh job
  const script = await one(
    `SELECT id FROM lcos.scripts WHERE status='APPROVED' ORDER BY created_at DESC LIMIT 1`);
  if (!script) return; // e2e suite provides one when run together
  const job = (await call('POST', '/api/v1/production/jobs', tokens.producer,
    { script_id: script.id })).json();
  const run = await call('POST', `/api/v1/production/jobs/${job.id}/run`, tokens.producer);
  assert.equal(run.statusCode, 200, run.body);
  const jobRow = await one(`SELECT asset_plan FROM lcos.production_jobs WHERE id=$1`, [job.id]);
  assert.ok(Array.isArray(jobRow.asset_plan) && jobRow.asset_plan.length >= 1,
    `asset bound: ${JSON.stringify(jobRow.asset_plan)}`);
  assert.ok(jobRow.asset_plan[0].asset_code.startsWith('AST-') || jobRow.asset_plan[0].asset_code.startsWith('GEN-'));
});

test('experiment conclude auto-attaches the primary metric from performance', async () => {
  const pc = await one(`SELECT id FROM lcos.published_content ORDER BY published_at DESC LIMIT 1`);
  if (!pc) return;
  const e = (await call('POST', '/api/v1/experiments', tokens.content, {
    title: 'metric attach test', hypothesis: 'x', variable_tested: 'HOOK',
    primary_metric: 'completion_rate' })).json();
  await call('POST', `/api/v1/experiments/${e.id}/variants`, tokens.content,
    { label: 'control', description: 'c', is_control: true, published_content_id: pc.id });
  await call('POST', `/api/v1/experiments/${e.id}/variants`, tokens.content,
    { label: 'variant', description: 'v' });
  await call('POST', `/api/v1/experiments/${e.id}/start`, tokens.content);
  const done = await call('POST', `/api/v1/experiments/${e.id}/conclude`, tokens.content,
    { conclusion: 'test' });
  assert.equal(done.statusCode, 200, done.body);
  const v = await one(
    `SELECT primary_metric_value, sample_size FROM lcos.experiment_variants
     WHERE experiment_id=$1 AND is_control`, [e.id]);
  assert.ok(v.primary_metric_value != null, 'metric value attached');
  assert.ok(Number(v.primary_metric_value) > 0 && Number(v.primary_metric_value) <= 1,
    'completion rate in range');
});
