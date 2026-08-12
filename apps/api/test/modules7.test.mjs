// Increment 6 tests: per-platform export specs (migration 0008). Pure
// evaluateContent() warning logic, GET/PUT /platform/specs, and the
// duration/aspect-ratio warning riding along on POST /distribution/jobs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.LCOS_AI_PROVIDER = 'MOCK';
process.env.LCOS_ADAPTER_MODE = 'MOCK';
process.env.LCOS_STORAGE_DIR = '/tmp/lcos-test-storage';

const { buildServer } = await import('../src/server.mjs');
const { pool, q, one } = await import('../src/core.mjs');
const { evaluateContent } = await import('../src/modules/platform_specs.mjs');

let app, tokens = {};
const login = async (email) => {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
    payload: { email, password: 'letena-dev-2026' } });
  assert.equal(res.statusCode, 200, `login failed for ${email}: ${res.body}`);
  return res.json().token;
};
const call = (method, url, token, payload) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });

before(async () => {
  app = await buildServer();
  for (const r of ['admin', 'intake', 'producer', 'social']) {
    tokens[r] = await login(`${r}@letena.local`);
  }
});
after(async () => { await app.close(); await pool.end(); });

// ------------------------------------------------------ pure warning logic
test('evaluateContent: compliant duration and matching ratio produce no warnings', () => {
  const spec = { platform: 'INSTAGRAM', aspect_ratio: '9:16', width: 1080, height: 1920,
    max_duration_seconds: 900, recommended_duration_seconds: 90 };
  const warnings = evaluateContent(spec, { durationSeconds: 30, aspectRatio: '9:16' });
  assert.deepEqual(warnings, []);
});

test('evaluateContent: duration over the recommended (but under max) flags a soft warning', () => {
  const spec = { platform: 'INSTAGRAM', aspect_ratio: '9:16', width: 1080, height: 1920,
    max_duration_seconds: 900, recommended_duration_seconds: 90 };
  const warnings = evaluateContent(spec, { durationSeconds: 200, aspectRatio: '9:16' });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'DURATION_EXCEEDS_RECOMMENDED');
});

test('evaluateContent: duration over the platform max flags the harder warning instead', () => {
  const spec = { platform: 'FACEBOOK', aspect_ratio: '9:16', width: 1080, height: 1920,
    max_duration_seconds: 240, recommended_duration_seconds: 60 };
  const warnings = evaluateContent(spec, { durationSeconds: 300, aspectRatio: '9:16' });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'DURATION_EXCEEDS_MAX');
});

test('evaluateContent: mismatched aspect ratio is flagged independently of duration', () => {
  const spec = { platform: 'TIKTOK', aspect_ratio: '9:16', width: 1080, height: 1920,
    max_duration_seconds: 600, recommended_duration_seconds: 34 };
  const warnings = evaluateContent(spec, { durationSeconds: 20, aspectRatio: '1:1' });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'ASPECT_RATIO_MISMATCH');
});

test('evaluateContent: both problems at once produce both warnings', () => {
  const spec = { platform: 'TIKTOK', aspect_ratio: '9:16', width: 1080, height: 1920,
    max_duration_seconds: 600, recommended_duration_seconds: 34 };
  const warnings = evaluateContent(spec, { durationSeconds: 700, aspectRatio: '1:1' });
  const codes = warnings.map(w => w.code).sort();
  assert.deepEqual(codes, ['ASPECT_RATIO_MISMATCH', 'DURATION_EXCEEDS_MAX']);
});

test('evaluateContent: no spec, no content fields, no crash', () => {
  assert.deepEqual(evaluateContent(null, { durationSeconds: 999 }), []);
  assert.deepEqual(evaluateContent({ platform: 'TELEGRAM' }, {}), []);
});

// ------------------------------------------------------------ GET/PUT specs
test('GET /platform/specs: the right 2026 spec is selected per platform', async () => {
  const res = await call('GET', '/api/v1/platform/specs', tokens.admin);
  assert.equal(res.statusCode, 200, res.body);
  const items = res.json().items;
  const byPlatform = Object.fromEntries(items.map(i => [i.platform, i]));
  assert.equal(byPlatform.INSTAGRAM.aspect_ratio, '9:16');
  assert.equal(byPlatform.INSTAGRAM.width, 1080);
  assert.equal(byPlatform.INSTAGRAM.height, 1920);
  assert.equal(byPlatform.INSTAGRAM.recommended_duration_seconds, 90);
  assert.equal(byPlatform.TIKTOK.width, 1080);
  assert.equal(byPlatform.TIKTOK.height, 1920);
  assert.equal(byPlatform.FACEBOOK.recommended_duration_seconds, 60);
  assert.equal(byPlatform.TELEGRAM.max_duration_seconds, null, 'Telegram has no platform-imposed cap');
});

test('PUT /platform/specs/:platform requires publish.schedule or settings.manage', async () => {
  const res = await call('PUT', '/api/v1/platform/specs/TIKTOK', tokens.intake,
    { aspect_ratio: '9:16', width: 1080, height: 1920 });
  assert.equal(res.statusCode, 403, res.body);
});

test('PUT /platform/specs/:platform updates and persists an edited spec', async () => {
  const res = await call('PUT', '/api/v1/platform/specs/TIKTOK', tokens.social,
    { aspect_ratio: '9:16', width: 1080, height: 1920, max_duration_seconds: 600,
      recommended_duration_seconds: 45, format_notes: 'edited by test' });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().recommended_duration_seconds, 45);
  const row = await one(`SELECT recommended_duration_seconds, format_notes FROM lcos.platform_specs WHERE platform='TIKTOK'`);
  assert.equal(row.recommended_duration_seconds, 45);
  assert.equal(row.format_notes, 'edited by test');
  // restore the seeded value so other tests/read-only assertions stay stable
  await call('PUT', '/api/v1/platform/specs/TIKTOK', tokens.social,
    { aspect_ratio: '9:16', width: 1080, height: 1920, max_duration_seconds: 600,
      recommended_duration_seconds: 34, format_notes: 'restored after test' });
});

// ------------------------------------------------ wired into the schedule route
// Reuses any already-APPROVED script as a fixture substrate (the dev DB
// accumulates these across seed + prior test runs) rather than re-running
// the whole ingest -> classify -> Turn Into Content pipeline.
async function renderFromAnyApprovedScript() {
  const script = await one(
    `SELECT s.* FROM lcos.scripts s WHERE s.status='APPROVED' AND s.risk_tier <> 'TIER_4'
     ORDER BY s.created_at DESC LIMIT 1`);
  assert.ok(script, 'an APPROVED non-TIER_4 script fixture exists');
  const pj = await call('POST', '/api/v1/production/jobs', tokens.producer, { script_id: script.id });
  assert.equal(pj.statusCode, 201, pj.body);
  const run = await call('POST', `/api/v1/production/jobs/${pj.json().id}/run`, tokens.producer);
  assert.equal(run.statusCode, 200, run.body);
  assert.equal(run.json().status, 'RENDERED', JSON.stringify(run.json()));
  const renderId = run.json().render_id;
  const approve = await call('POST', `/api/v1/production/renders/${renderId}/approve`, tokens.producer);
  assert.equal(approve.statusCode, 200, approve.body);
  return { script, renderId };
}

test('POST /distribution/jobs: a compliant render schedules with no warnings', async () => {
  const { renderId } = await renderFromAnyApprovedScript();
  // Mock renders come out 30s / 9:16, which fits every seeded platform.
  const res = await call('POST', '/api/v1/distribution/jobs', tokens.social,
    { render_id: renderId, platform: 'TELEGRAM' });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  assert.deepEqual(body.warnings, []);
  assert.equal(body.platform_spec.platform, 'TELEGRAM');
  const stored = await one(`SELECT payload FROM lcos.publishing_jobs WHERE id=$1`, [body.id]);
  assert.deepEqual(stored.payload.warnings, [], 'warnings persisted on the job payload too');
});

test('POST /distribution/jobs: an oversized, wrong-ratio render is flagged (not blocked)', async () => {
  const { renderId } = await renderFromAnyApprovedScript();
  // Simulate a source render that is too long and the wrong shape for
  // Instagram Reels (2026 spec: 1080x1920 9:16, recommended <=90s).
  await q(`UPDATE lcos.renders SET duration_s=200, aspect_ratio='1:1' WHERE id=$1`, [renderId]);
  const res = await call('POST', '/api/v1/distribution/jobs', tokens.social,
    { render_id: renderId, platform: 'INSTAGRAM' });
  assert.equal(res.statusCode, 201, res.body, 'flagging never blocks scheduling');
  const codes = res.json().warnings.map(w => w.code).sort();
  assert.deepEqual(codes, ['ASPECT_RATIO_MISMATCH', 'DURATION_EXCEEDS_RECOMMENDED']);
  assert.equal(res.json().platform_spec.width, 1080);
  assert.equal(res.json().platform_spec.height, 1920);
});
