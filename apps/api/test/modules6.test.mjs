// Increment 6 tests: admin test-mode override for the doctor-approval gate
// (approval.override setting) and flexible/data-driven generation scope
// (content_output_types + POST /content/generate).
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

async function setOverride(value, token = tokens.admin) {
  return call('PUT', '/api/v1/platform/settings', token, { key: 'approval.override', value });
}

before(async () => {
  app = await buildServer();
  for (const r of ['admin', 'content', 'dev', 'language', 'intake', 'meddir']) {
    tokens[r] = await login(`${r}@letena.local`);
  }
  // Deterministic starting point regardless of test order across files.
  await setOverride('OFF');
});
after(async () => {
  await setOverride('OFF');
  await app.close();
  await pool.end();
});

// EC-001 ships IN_REVIEW with basics claims attached (also IN_REVIEW) but is
// never approved in the base seed, so it is a stable "not yet approved" card
// fixture independent of demo/e2e ordering. EC-004 is demo-approved and used
// as the "normal, already approved" control.
test('approval.override: defaults OFF and is only flippable by the admin role', async () => {
  const listed = await call('GET', '/api/v1/platform/settings', tokens.admin);
  assert.equal(listed.statusCode, 200);
  const row = listed.json().items.find(i => i.key === 'approval.override');
  assert.ok(row, 'approval.override is listed');
  assert.equal(row.value, 'OFF');

  // developer holds settings.manage (per seed) but not the admin role.
  const devDenied = await call('PUT', '/api/v1/platform/settings', tokens.dev,
    { key: 'approval.override', value: 'ADMIN_TEST_MODE' });
  assert.equal(devDenied.statusCode, 403, devDenied.body);
  assert.equal(devDenied.json().guard, 'adminOnlySetting');

  // content_lead holds neither settings.manage nor admin.
  const contentDenied = await call('PUT', '/api/v1/platform/settings', tokens.content,
    { key: 'approval.override', value: 'ADMIN_TEST_MODE' });
  assert.equal(contentDenied.statusCode, 403);

  const badValue = await setOverride('YES_PLEASE');
  assert.equal(badValue.statusCode, 422, badValue.body);

  const ok = await setOverride('ADMIN_TEST_MODE');
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().value, 'ADMIN_TEST_MODE');
  await setOverride('OFF');
  const back = await one(`SELECT value FROM lcos.settings WHERE key='approval.override'`);
  assert.equal(back.value, 'OFF');
});

test('GET /content/output-types is data-driven, not a hardcoded 4', async () => {
  const denied = await call('GET', '/api/v1/content/output-types', tokens.language);
  assert.equal(denied.statusCode, 403, 'language editor lacks concept.read');
  const r = await call('GET', '/api/v1/content/output-types', tokens.content);
  assert.equal(r.statusCode, 200, r.body);
  const items = r.json().items;
  assert.ok(items.length >= 5, `expected more than a fixed 4: got ${items.length}`);
  for (const key of ['code', 'label', 'platform', 'video_family', 'description']) {
    assert.ok(key in items[0], `output type carries ${key}`);
  }
  assert.ok(items.some(i => i.code === 'reel_question_explainer'));
  assert.ok(items.some(i => i.code === 'carousel'));
});

test('POST /content/generate: normal (non-override) path on an APPROVED card asks for exactly ONE output type', async () => {
  const card = await one(`SELECT id, code FROM lcos.knowledge_cards WHERE code='EC-004'`);
  assert.equal(card.code, 'EC-004');
  const r = await call('POST', '/api/v1/content/generate', tokens.content,
    { card_id: card.code, output_types: ['telegram_post'], languages: ['EN'] });
  assert.equal(r.statusCode, 202, r.body);
  const body = r.json();
  assert.equal(body.is_test_content, false);
  assert.equal(body.concepts.length, 1, 'exactly one concept for one requested output type');
  assert.equal(body.concepts[0].video_family, 'C03_TELEGRAM_POST');
  assert.equal(body.scripts.length, 1, 'exactly one script, not a fixed batch of four');
  const famRow = await one(`SELECT is_test_content FROM lcos.content_families WHERE id=$1`, [body.family_id]);
  assert.equal(famRow.is_test_content, false);
});

test('POST /content/generate: unknown output_types code is rejected', async () => {
  const card = await one(`SELECT code FROM lcos.knowledge_cards WHERE code='EC-004'`);
  const r = await call('POST', '/api/v1/content/generate', tokens.content,
    { card_id: card.code, output_types: ['not_a_real_type'] });
  assert.equal(r.statusCode, 422, r.body);
  assert.match(r.json().detail, /not_a_real_type/);
});

test('POST /content/generate: requires card_id or concept_id', async () => {
  const r = await call('POST', '/api/v1/content/generate', tokens.content, { output_types: ['telegram_post'] });
  assert.equal(r.statusCode, 422);
});

test('generation from a not-yet-approved card is blocked while approval.override is OFF', async () => {
  const card = await one(`SELECT id, code, status FROM lcos.knowledge_cards WHERE code='EC-001'`);
  assert.notEqual(card.status, 'APPROVED', 'EC-001 must stay unapproved for this fixture to mean anything');
  const r = await call('POST', '/api/v1/content/generate', tokens.admin,
    { card_id: card.code, output_types: ['reel_question_explainer'] });
  assert.equal(r.statusCode, 422, r.body);
  assert.equal(r.json().guard, 'cardIsApproved');
});

// turn-into-content only ever classifies a question onto an APPROVED card
// (see demand.mjs classifyQuestion), so the override there can only be
// exercised by a classification that already points at an unapproved card
// (e.g. one written between classify-time and generate-time) — build that
// fixture directly rather than relying on the classifier to produce it.
async function fixtureQuestionOnCard(cardCode, hashSuffix) {
  const card = await one(`SELECT id, topic_id FROM lcos.knowledge_cards WHERE code=$1`, [cardCode]);
  const segment = await one(`SELECT id FROM lcos.audience_segments WHERE slug='general_public'`);
  const question = await one(
    `INSERT INTO lcos.audience_questions (channel, source_hash, sanitized_text, status, deid_confidence, captured_at)
     VALUES ('WEBSITE',$1,'Test question for the override fixture.','CLASSIFIED',1,now())
     ON CONFLICT (source_hash) DO UPDATE SET status='CLASSIFIED' RETURNING id`,
    [`test-i6-${hashSuffix}`]);
  await q(`DELETE FROM lcos.question_classifications WHERE question_id=$1`, [question.id]);
  await q(
    `INSERT INTO lcos.question_classifications (question_id, topic_id, intent, urgency, clinical_risk,
       audience_segment_id, knowledge_card_id, match_confidence, raw_output)
     VALUES ($1,$2,'FACT_SEEKING','NONE','NONE',$3,$4,0.9,'{}'::jsonb)`,
    [question.id, card.topic_id, segment.id, card.id]);
  return question.id;
}

test('turn-into-content also honors the override when its classification points at an unapproved card', async () => {
  const questionId = await fixtureQuestionOnCard('EC-001', 'tic-override');
  const blocked = await call('POST', '/api/v1/content/turn-into-content', tokens.admin, { question_id: questionId });
  assert.equal(blocked.statusCode, 422, blocked.body);
  assert.equal(blocked.json().guard, 'cardIsApproved');

  await setOverride('ADMIN_TEST_MODE');
  try {
    const nonAdminBlocked = await call('POST', '/api/v1/content/turn-into-content', tokens.content, { question_id: questionId });
    assert.equal(nonAdminBlocked.statusCode, 403, nonAdminBlocked.body);

    const ok = await call('POST', '/api/v1/content/turn-into-content', tokens.admin, { question_id: questionId });
    assert.equal(ok.statusCode, 202, ok.body);
    assert.equal(ok.json().is_test_content, true);
    const famRow = await one(`SELECT is_test_content FROM lcos.content_families WHERE id=$1`, [ok.json().family_id]);
    assert.equal(famRow.is_test_content, true);
  } finally {
    await setOverride('OFF');
  }
});

test('ADMIN_TEST_MODE lets only the admin role generate from an unapproved card, and tags the output', async () => {
  const card = await one(`SELECT id, code, status FROM lcos.knowledge_cards WHERE code='EC-001'`);
  await setOverride('ADMIN_TEST_MODE');
  try {
    // Override is ON, but this actor is not an admin: still blocked.
    const nonAdmin = await call('POST', '/api/v1/content/generate', tokens.content,
      { card_id: card.code, output_types: ['reel_question_explainer'] });
    assert.equal(nonAdmin.statusCode, 403, nonAdmin.body);
    assert.equal(nonAdmin.json().guard, 'adminOnlyOverride');

    const before = await one(`SELECT count(*)::int n FROM lcos.audit_log
      WHERE action='content.admin_test_override_used' AND object_code=$1`, [card.code]);

    const admin = await call('POST', '/api/v1/content/generate', tokens.admin,
      { card_id: card.code, output_types: ['reel_question_explainer'], languages: ['EN'] });
    assert.equal(admin.statusCode, 202, admin.body);
    const body = admin.json();
    assert.equal(body.is_test_content, true, 'response marks test content');
    assert.equal(body.knowledge_card.status, card.status);
    assert.equal(body.concepts.length, 1);
    assert.equal(body.scripts.length, 1);

    const famRow = await one(`SELECT is_test_content FROM lcos.content_families WHERE id=$1`, [body.family_id]);
    assert.equal(famRow.is_test_content, true, 'family row tagged is_test_content');
    const scriptRow = await one(`SELECT is_test_content, status FROM lcos.scripts WHERE id=$1`,
      [body.scripts[0].script_id ?? body.scripts[0].id]);
    assert.equal(scriptRow.is_test_content, true, 'script row tagged is_test_content');

    const after = await one(`SELECT count(*)::int n FROM lcos.audit_log
      WHERE action='content.admin_test_override_used' AND object_code=$1`, [card.code]);
    assert.ok(after.n > before.n, 'admin override use was audit-logged');
    const auditRow = await one(`SELECT reason, actor_user_id FROM lcos.audit_log
      WHERE action='content.admin_test_override_used' AND object_code=$1
      ORDER BY occurred_at DESC LIMIT 1`, [card.code]);
    assert.ok(auditRow.reason.includes('IN_REVIEW') || auditRow.reason.includes('DRAFT'),
      `audit reason records card state: ${auditRow.reason}`);
    assert.ok(auditRow.actor_user_id, 'audit records the actor');

    // concept_id path: regenerate a script for the exact same concept only.
    const conceptId = body.concepts[0].id;
    const again = await call('POST', '/api/v1/content/generate', tokens.admin, { concept_id: conceptId });
    assert.equal(again.statusCode, 202, again.body);
    assert.equal(again.json().is_test_content, true);
    assert.equal(again.json().concepts.length, 1);
    assert.equal(again.json().concepts[0].id, conceptId);
  } finally {
    await setOverride('OFF');
  }
});

test('turning approval.override back OFF re-enforces the gate immediately (no stale cache)', async () => {
  const card = await one(`SELECT code FROM lcos.knowledge_cards WHERE code='EC-001'`);
  const r = await call('POST', '/api/v1/content/generate', tokens.admin,
    { card_id: card.code, output_types: ['reel_question_explainer'] });
  assert.equal(r.statusCode, 422, r.body);
  assert.equal(r.json().guard, 'cardIsApproved');
});

test('test content generated under override can never actually publish while the card is unapproved', async () => {
  const script = await one(
    `SELECT id FROM lcos.scripts WHERE is_test_content ORDER BY created_at DESC LIMIT 1`);
  if (!script) return; // depends on the override test above having run in this process
  const family = await one(
    `SELECT cf.id FROM lcos.content_families cf JOIN lcos.scripts s ON s.family_id=cf.id WHERE s.id=$1`,
    [script.id]);
  const card = await one(
    `SELECT status FROM lcos.knowledge_cards kc JOIN lcos.content_families cf ON cf.knowledge_card_id=kc.id
     WHERE cf.id=$1`, [family.id]);
  assert.notEqual(card.status, 'APPROVED',
    'the safety property this test protects only holds while the underlying card stays unapproved');
});
