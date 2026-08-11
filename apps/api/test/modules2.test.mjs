// Tests for session-2 additions: terminology, language review, assets +
// generation guard, experiments, calendar, publish-due sweep, TOTP, rate limit.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.LCOS_AI_PROVIDER = 'MOCK';
process.env.LCOS_ADAPTER_MODE = 'MOCK';
process.env.LCOS_STORAGE_DIR = '/tmp/lcos-test-storage';

const { buildServer } = await import('../src/server.mjs');
const { pool, q, one, totpSecret, totpCode } = await import('../src/core.mjs');

let app, tokens = {};
const login = async (email) => (await app.inject({ method: 'POST', url: '/api/v1/auth/login',
  payload: { email, password: 'letena-dev-2026' } })).json().token;
const call = (method, url, token, payload) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });

before(async () => {
  app = await buildServer();
  for (const r of ['language', 'content', 'producer', 'social', 'dev', 'admin']) {
    tokens[r] = await login(`${r}@letena.local`);
  }
});
after(async () => { await app.close(); await pool.end(); });

test('terminology: language editor creates and approves; developer cannot', async () => {
  const created = await call('POST', '/api/v1/language/terminology', tokens.language, {
    term_en: 'emergency contraception', preferred_am: 'የአስቸኳይ ጊዜ የእርግዝና መከላከያ',
    avoid_am: ['የፅንስ ማስወረጃ'], register: 'GENERAL' });
  assert.equal(created.statusCode, 200, created.body);
  const id = created.json().id;
  const devDenied = await call('POST', `/api/v1/language/terminology/${id}/approve`, tokens.dev);
  assert.equal(devDenied.statusCode, 403);
  const approved = await call('POST', `/api/v1/language/terminology/${id}/approve`, tokens.language);
  assert.equal(approved.statusCode, 200);
  assert.equal(approved.json().status, 'APPROVED');
});

test('language review: structured decision records and completes the task', async () => {
  const s = await one(
    `SELECT s.id FROM lcos.scripts s
     JOIN lcos.translations t ON t.object_type='SCRIPT' AND t.object_id=s.id
     WHERE s.status IN ('CLINICAL_REVIEW','APPROVED') LIMIT 1`);
  if (!s) return;   // e2e not run in this process; covered when suites run together
  const r = await call('POST', `/api/v1/content/scripts/${s.id}/language-review`, tokens.language,
    { decision: 'APPROVED', naturalness_score: 4, meaning_preserved: true });
  assert.equal(r.statusCode, 200, r.body);
  const rec = await one(
    `SELECT * FROM lcos.language_reviews WHERE script_id=$1 ORDER BY reviewed_at DESC LIMIT 1`, [s.id]);
  assert.equal(rec.decision, 'APPROVED');
  assert.equal(rec.meaning_preserved, true);
});

test('language review: cannot approve while meaning not preserved', async () => {
  const s = await one(
    `SELECT s.id FROM lcos.scripts s
     JOIN lcos.translations t ON t.object_type='SCRIPT' AND t.object_id=s.id LIMIT 1`);
  if (!s) return;
  const r = await call('POST', `/api/v1/content/scripts/${s.id}/language-review`, tokens.language,
    { decision: 'APPROVED', meaning_preserved: false });
  assert.equal(r.statusCode, 422);
  assert.equal(r.json().guard, 'meaningGate');
});

test('assets: upload with tags, then semantic search finds it', async () => {
  const up = await call('POST', '/api/v1/production/assets', tokens.producer, {
    title: 'Addis evening street, woman with phone', kind: 'VIDEO', origin: 'SHOT_IN_HOUSE',
    mime_type: 'video/mp4', content_base64: Buffer.from('fake mp4').toString('base64'),
    tags: ['city:addis', 'emotion:calm', 'activity:phone'], topic_codes: ['EC'] });
  assert.equal(up.statusCode, 201, up.body);
  const search = await call('GET',
    '/api/v1/production/assets/search?semantic=' + encodeURIComponent('addis street evening phone woman'),
    tokens.producer);
  assert.equal(search.statusCode, 200);
  assert.ok(search.json().items.some(i => i.id === up.json().id), 'uploaded asset found semantically');
});

test('assets: people without consent reference are refused', async () => {
  const r = await call('POST', '/api/v1/production/assets', tokens.producer, {
    title: 'street interview', kind: 'VIDEO', mime_type: 'video/mp4', people_present: true });
  assert.equal(r.statusCode, 422);
  assert.equal(r.json().guard, 'peopleNeedConsent');
});

test('assets: medical illustration generation is refused at the boundary', async () => {
  const r = await call('POST', '/api/v1/production/assets/generate', tokens.producer,
    { brief: 'diagram of the menstrual cycle', kind: 'MEDICAL_ILLUSTRATION' });
  assert.equal(r.statusCode, 422);
  assert.equal(r.json().guard, 'noGenerativeMedicalIllustration');
});

test('assets: generated b-roll lands inactive with a producer review task', async () => {
  const r = await call('POST', '/api/v1/production/assets/generate', tokens.producer,
    { brief: 'shared taxi interior at dusk, phone glow', kind: 'IMAGE_PHOTO' });
  assert.equal(r.statusCode, 201, r.body);
  const a = r.json();
  assert.equal(a.is_active, false);
  assert.equal(a.is_ai_generated, true);
  const task = await one(
    `SELECT * FROM lcos.review_tasks WHERE object_type='ASSET' AND object_id=$1 AND status='OPEN'`, [a.id]);
  assert.ok(task, 'producer review task created');
  const act = await call('POST', `/api/v1/production/assets/${a.id}/activate`, tokens.producer);
  assert.equal(act.statusCode, 200);
  assert.equal(act.json().is_active, true);
});

test('experiments: shape guard, lifecycle, conclude', async () => {
  const e = await call('POST', '/api/v1/experiments', tokens.content, {
    title: 'Amharic vs English hook', hypothesis: 'Amharic hooks lift 3s view rate on TikTok',
    variable_tested: 'HOOK', primary_metric: '3s_view_rate', platform: 'TIKTOK' });
  assert.equal(e.statusCode, 201, e.body);
  const id = e.json().id;
  const badStart = await call('POST', `/api/v1/experiments/${id}/start`, tokens.content);
  assert.equal(badStart.statusCode, 422);
  assert.equal(badStart.json().guard, 'experimentShape');
  await call('POST', `/api/v1/experiments/${id}/variants`, tokens.content,
    { label: 'control-english', description: 'English hook', is_control: true });
  await call('POST', `/api/v1/experiments/${id}/variants`, tokens.content,
    { label: 'variant-amharic', description: 'Amharic hook' });
  const start = await call('POST', `/api/v1/experiments/${id}/start`, tokens.content);
  assert.equal(start.statusCode, 200);
  assert.equal(start.json().status, 'RUNNING');
  const done = await call('POST', `/api/v1/experiments/${id}/conclude`, tokens.content,
    { conclusion: 'Demo conclusion', confidence_note: 'sample below threshold' });
  assert.equal(done.statusCode, 200);
  assert.equal(done.json().status, 'CONCLUDED');
});

test('weekly report generates with recommendations', async () => {
  const r = await call('GET', '/api/v1/analytics/weekly-report', tokens.content);
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(r.json().report.recommendations.length >= 1);
});

test('calendar returns scheduled and published buckets', async () => {
  const r = await call('GET', '/api/v1/distribution/calendar', tokens.social);
  assert.equal(r.statusCode, 200);
  assert.ok(Array.isArray(r.json().scheduled) && Array.isArray(r.json().published));
});

test('publish-due sweep runs under the social role and reports results', async () => {
  const r = await call('POST', '/api/v1/distribution/publish-due', tokens.social);
  assert.equal(r.statusCode, 200, r.body);
  assert.ok('attempted' in r.json());
});

test('TOTP: enroll, verify, then login requires the code', async () => {
  const enroll = await call('POST', '/api/v1/auth/totp/enroll', tokens.producer);
  assert.equal(enroll.statusCode, 200);
  const secret = enroll.json().secret;
  const verify = await call('POST', '/api/v1/auth/totp/verify', tokens.producer,
    { code: totpCode(secret) });
  assert.equal(verify.statusCode, 200);
  const bare = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
    payload: { email: 'producer@letena.local', password: 'letena-dev-2026' } });
  assert.equal(bare.statusCode, 401);
  assert.equal(bare.json().code, 'TOTP_REQUIRED');
  const withCode = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
    payload: { email: 'producer@letena.local', password: 'letena-dev-2026', totp: totpCode(secret) } });
  assert.equal(withCode.statusCode, 200, withCode.body);
  // cleanup so other suites can log in without TOTP
  await q(`UPDATE lcos.users SET totp_enabled=false, totp_secret=NULL
           WHERE lower(email)='producer@letena.local'`);
});

test('security headers are present', async () => {
  const r = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.ok(r.headers['content-security-policy'].includes("default-src 'self'"));
});
