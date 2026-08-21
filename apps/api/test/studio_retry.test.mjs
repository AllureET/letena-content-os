// Video Studio retry/repair/fallback ladder tests (playbook section 15,
// phase 1, 18 Aug 2026 follow-up). Covers the one call site the ladder was
// scoped to -- POST /shots/:shotId/generate -- across its four outcomes:
// a TRANSIENT failure that recovers on the same-engine retry, a
// PROVIDER_DOWN failure that only succeeds via the fallback engine, a
// POLICY failure that stops cold with no retry and no fallback, and total
// exhaustion of all 3 real calls.
//
// Mocking approach: (b) from the task -- node:test's t.mock.method,
// stubbing kling.textToVideo/veo.textToVideo directly on the adapter
// module's own exported objects, auto-restored per-test by node:test's
// test-scoped MockTracker. Zero production-code footprint (no MOCK-only
// test hook needed in studio.mjs or adapters/index.mjs). This works
// because kling/veo are plain exported objects (not the module namespace
// itself), videoEngine() in adapters/index.mjs returns those SAME object
// references by identity, and studio.mjs holds onto whatever videoEngine()
// handed it -- so mutating kling.textToVideo/veo.textToVideo here is
// visible to studio.mjs's call without touching studio.mjs at all. Chose
// (b) over the (a) force_error hook because it needed no new branch in
// production code and no risk of that branch ever being reachable outside
// MOCK() -- there is simply nothing in studio.mjs for a reviewer to worry
// about.
//
// Same login/token/call() helper pattern as studio.test.mjs and
// studio_budget.test.mjs. This file does not import or modify
// studio.test.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.LCOS_AI_PROVIDER = 'MOCK';
process.env.LCOS_ADAPTER_MODE = 'MOCK';
process.env.LCOS_STORAGE_DIR = '/tmp/lcos-test-storage';

const { buildServer } = await import('../src/server.mjs');
const { pool } = await import('../src/core.mjs');
const { kling, veo, runway } = await import('../src/adapters/index.mjs');

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

const newProject = async (title) => {
  // No budget_cap_usd: these tests are about the retry ladder, not the
  // budget guardrail (already covered by studio_budget.test.mjs), so a
  // null cap keeps that guardrail fully out of the way.
  const r = await call('POST', '/studio/projects', { title, format: 'ai_story', aspect_ratio: '9:16', language: 'am' });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};
// engine is pinned explicitly (21 Aug 2026): RUNWAY became the system
// default and the fallback target, so a test that wants to exercise the
// same-engine retry and the fallback hop has to say which engine it starts
// on rather than relying on the default. The ladder's mechanics under test
// are unchanged; only the topology around them moved.
const newShot = async (projectId, shotCode, engine = 'KLING') => {
  const r = await call('POST', `/studio/projects/${projectId}/shots`,
    { shot_code: shotCode, order_index: 0, duration_target_s: 5,
      story: { beat: 'a beat' }, generation: { mode_preference: 'text_to_video', engine } });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};
const getShot = async (projectId, shotId) =>
  (await call('GET', `/studio/projects/${projectId}`)).json().shots.find(s => s.id === shotId);

test('a TRANSIENT failure retries the same engine and succeeds on attempt 2', async (t) => {
  let calls = 0;
  t.mock.method(kling, 'textToVideo', async ({ assetId }) => {
    calls += 1;
    if (calls === 1) throw new Error('request timeout contacting Kling');
    return { status: 'SUCCEEDED', storage_key: `assets/generated/${assetId}/broll.mp4`,
      provider_job_id: `retry-${assetId.slice(0, 8)}`, cost_usd: 0 };
  });

  const project = await newProject('Retry TRANSIENT case');
  const shot = await newShot(project.id, 'SH-R1');
  const r = await call('POST', `/studio/shots/${shot.id}/generate`, {});
  assert.equal(r.statusCode, 200, r.body);

  const asset = r.json().asset;
  assert.equal(calls, 2, 'exactly one retry, both real calls on the same (Kling) engine');
  assert.equal(asset.generator.attempt_count, 2);
  assert.equal(asset.generator.fallback_used, false);
  assert.equal(asset.generator.provider, 'KLING', 'engine unchanged from the original request');

  const shotAfter = await getShot(project.id, shot.id);
  assert.equal(shotAfter.status, 'NEEDS_REVIEW', 'a generated candidate always lands in NEEDS_REVIEW for QC/human review');
});

test('a PROVIDER_DOWN failure skips the same-engine retry and succeeds via the fallback engine', async (t) => {
  let klingCalls = 0;
  t.mock.method(kling, 'textToVideo', async () => {
    klingCalls += 1;
    throw new Error('Kling provider is currently unavailable');
  });
  let fallbackCalls = 0;
  t.mock.method(runway, 'textToVideo', async ({ assetId }) => {
    fallbackCalls += 1;
    return { status: 'SUCCEEDED', storage_key: `assets/generated/${assetId}/broll-runway.mp4`,
      provider_job_id: `fallback-${assetId.slice(0, 8)}`, cost_usd: 0 };
  });

  const project = await newProject('Retry PROVIDER_DOWN case');
  const shot = await newShot(project.id, 'SH-R2');
  const r = await call('POST', `/studio/shots/${shot.id}/generate`, {});
  assert.equal(r.statusCode, 200, r.body);

  const asset = r.json().asset;
  assert.equal(klingCalls, 1, 'PROVIDER_DOWN gets no same-engine retry in this phase-1 design');
  assert.equal(fallbackCalls, 1, 'exactly one fallback attempt on the fallback engine');
  assert.equal(asset.generator.attempt_count, 2);
  assert.equal(asset.generator.fallback_used, true);
  assert.equal(asset.generator.provider, 'RUNWAY',
    'provider reflects whichever engine actually produced the asset; RUNWAY is the fallback target since it is the only implemented adapter');
});

test('a POLICY failure stops cold and leaves the shot editable: no retry, no fallback, exactly one real call', async (t) => {
  let klingCalls = 0;
  t.mock.method(kling, 'textToVideo', async () => {
    klingCalls += 1;
    throw new Error('rejected by content moderation: blocked content');
  });
  let fallbackCalls = 0;
  t.mock.method(runway, 'textToVideo', async () => {
    fallbackCalls += 1;
    return { status: 'SUCCEEDED', storage_key: 'assets/generated/should-not-be-called/broll-runway.mp4', cost_usd: 0 };
  });

  const project = await newProject('Retry POLICY case');
  const shot = await newShot(project.id, 'SH-R3');
  const r = await call('POST', `/studio/shots/${shot.id}/generate`, {});
  assert.equal(r.statusCode, 502, r.body);

  const body = r.json();
  assert.equal(body.code, 'GENERATION_FAILED');
  assert.equal(body.attempts.length, 1, 'a policy rejection is a hard gate, not retried');
  assert.equal(body.attempts[0].engine, 'KLING');
  assert.equal(body.attempts[0].error_class, 'POLICY');
  assert.equal(klingCalls, 1);
  assert.equal(fallbackCalls, 0, 'the fallback engine is never a policy workaround');

  const shotAfter = await getShot(project.id, shot.id);
  // DRAFT, not NEEDS_REVIEW, since 21 Aug 2026: nothing rendered, so there
  // is nothing for a person to review, and NEEDS_REVIEW is a state that can
  // neither be edited nor rejected -- a shot refused on policy grounds
  // needs its prompt changed, which DRAFT allows and NEEDS_REVIEW did not.
  assert.equal(shotAfter.status, 'DRAFT');
});

test('total exhaustion after all 3 attempts returns 502 with the full attempts array', async (t) => {
  let klingCalls = 0;
  t.mock.method(kling, 'textToVideo', async () => {
    klingCalls += 1;
    throw new Error('connection reset (ECONNRESET) contacting Kling');
  });
  let fallbackCalls = 0;
  t.mock.method(runway, 'textToVideo', async () => {
    fallbackCalls += 1;
    throw new Error('Runway provider is currently unavailable');
  });

  const project = await newProject('Retry exhaustion case');
  const shot = await newShot(project.id, 'SH-R4');
  const r = await call('POST', `/studio/shots/${shot.id}/generate`, {});
  assert.equal(r.statusCode, 502, r.body);

  const body = r.json();
  assert.equal(body.code, 'GENERATION_FAILED');
  assert.equal(klingCalls, 2, 'same-engine attempt plus its one TRANSIENT retry');
  assert.equal(fallbackCalls, 1, 'then exactly one fallback attempt, and no more after that');
  assert.equal(body.attempts.length, 3, 'never hide the attempt history from the reviewer');
  assert.equal(body.attempts[0].engine, 'KLING');
  assert.equal(body.attempts[0].attempt_number, 1);
  assert.equal(body.attempts[0].error_class, 'TRANSIENT');
  assert.equal(body.attempts[1].engine, 'KLING');
  assert.equal(body.attempts[1].attempt_number, 2);
  assert.equal(body.attempts[1].error_class, 'TRANSIENT');
  assert.equal(body.attempts[2].engine, 'RUNWAY');
  assert.equal(body.attempts[2].attempt_number, 3);
  assert.equal(body.attempts[2].error_class, 'PROVIDER_DOWN');

  const shotAfter = await getShot(project.id, shot.id);
  // Same rule as the POLICY case above: every attempt failed, so the shot
  // goes back to DRAFT where it can be changed and tried again. The three
  // attempts are still on the project timeline.
  assert.equal(shotAfter.status, 'DRAFT');
});

// 21 Aug 2026: RUNWAY is both the default engine and the fallback target,
// so it is the one engine with nowhere to fall back TO. Rerouting a real
// Runway outage onto the kling/veo skeletons would burn an attempt and
// report a misleading second error ("requires KLING_ACCESS_KEY"), hiding
// the actual cause. The ladder stops instead, and this pins that.
test('a RUNWAY failure exhausts without rerouting onto an unimplemented engine', async (t) => {
  let runwayCalls = 0;
  t.mock.method(runway, 'textToVideo', async () => {
    runwayCalls += 1;
    throw new Error('Runway provider is currently unavailable');
  });
  let klingCalls = 0;
  t.mock.method(kling, 'textToVideo', async () => {
    klingCalls += 1;
    return { status: 'SUCCEEDED', storage_key: 'assets/generated/should-not-be-called/broll.mp4', cost_usd: 0 };
  });

  const project = await newProject('Runway no-fallback case');
  const shot = await newShot(project.id, 'SH-R5', 'RUNWAY');
  const r = await call('POST', `/studio/shots/${shot.id}/generate`, {});
  assert.equal(r.statusCode, 502, r.body);

  const body = r.json();
  assert.equal(body.code, 'GENERATION_FAILED');
  assert.equal(runwayCalls, 1, 'PROVIDER_DOWN gets no same-engine retry');
  assert.equal(klingCalls, 0, 'never reroute onto a skeleton adapter that cannot succeed');
  assert.equal(body.attempts.length, 1);
  assert.equal(body.attempts[0].engine, 'RUNWAY');
  assert.equal(body.attempts[0].error_class, 'PROVIDER_DOWN');
});
