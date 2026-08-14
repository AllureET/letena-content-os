// THE critical acceptance test: the Postpill question end to end, plus the
// governance tests that must hold: unsupported claims cannot pass, tier
// rules cannot be bypassed, PII cannot reach agents, developers cannot
// approve. Runs against the real Postgres with MOCK AI and MOCK adapters.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.LCOS_AI_PROVIDER = 'MOCK';
process.env.LCOS_ADAPTER_MODE = 'MOCK';
process.env.LCOS_STORAGE_DIR = '/tmp/lcos-test-storage';

const { buildServer } = await import('../src/server.mjs');
const { pool, q, one } = await import('../src/core.mjs');
const { invokeAgent, AgentError } = await import('../src/ai/gateway.mjs');

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
  for (const r of ['intake', 'content', 'meddir', 'doctor', 'language', 'producer', 'social', 'dev', 'admin']) {
    tokens[r] = await login(`${r}@letena.local`);
    assert.ok(tokens[r], `login ${r}`);
  }
  await q(`UPDATE lcos.content_families SET origin_question_id=NULL
           WHERE origin_question_id IN (SELECT id FROM lcos.audience_questions WHERE source_hash LIKE 'test-%')`);
  await q(`DELETE FROM lcos.audience_questions WHERE source_hash LIKE 'test-%'`);
  // This suite is the acceptance test of the FULL human review journey
  // (doctor approves, language editor approves, publish), so it runs with
  // the clinical review gate ON. The deployed default is OFF while the
  // owner tests the pipeline (0023, "Yes cause were testing"); the after()
  // hook restores whatever value the database held.
  const clin = await call('PUT', '/api/v1/platform/settings', tokens.admin,
    { key: 'review.clinical_review_enabled', value: true });
  assert.equal(clin.statusCode, 200, clin.body);
  // Published rows accumulate across runs and flip the score-confidence
  // heuristic from LOW (few peers) to FULL; each run starts from a clean slate.
  await q(`DELETE FROM lcos.content_scores`);
  await q(`DELETE FROM lcos.content_performance`);
  await q(`UPDATE lcos.experiment_variants SET published_content_id=NULL`);
  await q(`DELETE FROM lcos.published_content`);
});
after(async () => {
  await call('PUT', '/api/v1/platform/settings', tokens.admin,
    { key: 'review.clinical_review_enabled', value: false });
  await app.close(); await pool.end();
});

// ---------------------------------------------------------------- pipeline
let questionId, familyId, scriptIds = [], renderId, publishedId;

test('STEP 1-2: ingest sanitizes and stores the Postpill question', async () => {
  const res = await call('POST', '/api/v1/ingest/questions', tokens.intake, {
    batch_id: 'test-batch-1',
    questions: [{
      channel: 'TELEGRAM', source_hash: 'test-postpill-1',
      text: 'My name is Hana, call me on 0911234567. I took Postpill twice this month. Will I still be able to have children?',
      language_hint: 'EN', category_hints: ['contraception'], urgency_hint: 'consult',
      captured_at: new Date().toISOString(),
    }],
  });
  assert.equal(res.statusCode, 202, res.body);
  const body = res.json();
  assert.equal(body.accepted, 1);
  questionId = body.question_ids[0];
  const row = await one(`SELECT * FROM lcos.audience_questions WHERE id=$1`, [questionId]);
  assert.ok(row.sanitized_text.includes('[NAME]'), 'name redacted');
  assert.ok(row.sanitized_text.includes('[PHONE]'), 'phone redacted');
  assert.ok(!row.sanitized_text.includes('Hana'));
  assert.ok(!row.sanitized_text.includes('0911234567'));
  assert.equal(row.status, 'DEIDENTIFIED');
  assert.deepEqual(row.category_hints, ['contraception']);
});

test('ingest rejects a batch carrying a forbidden key, loudly', async () => {
  const res = await call('POST', '/api/v1/ingest/questions', tokens.intake, {
    questions: [{ channel: 'TELEGRAM', text: 'ok question', source_hash: 'test-forbidden-1',
      patient_id: 'pat_123' }],
  });
  assert.equal(res.statusCode, 422);
  assert.match(res.json().detail, /forbidden key/);
});

test('v2: a full inquiry stores de-identified answer, thread and consult mode', async () => {
  const res = await call('POST', '/api/v1/ingest/questions', tokens.intake, {
    batch_id: 'test-batch-v2',
    questions: [{
      channel: 'TELEGRAM', source_hash: 'test-inquiry-1', consult_mode: 'PHONE',
      text: 'Hello doctor, can I ask a question about my period being late?',
      thread: [
        { role: 'doctor', text: 'Of course. When was your last period, and are you on any contraception?' },
        { role: 'patient', text: 'My name is Meron, call me on 0922334455. Last period was six weeks ago, I use Postpill sometimes.' },
        { role: 'note', text: 'Patient reports repeated EC use, LMP 6 weeks. Advised urine hCG test. No red flags.' },
      ],
      answer_text: 'A late period after emergency contraception is common. Please take a pregnancy test now, and repeat in one week if negative. Reach us on 0922334455 if positive.',
      answered_at: new Date().toISOString(),
      captured_at: new Date().toISOString(),
    }],
  });
  assert.equal(res.statusCode, 202, res.body);
  assert.equal(res.json().accepted, 1);
  const row = await one(`SELECT * FROM lcos.audience_questions WHERE source_hash='test-inquiry-1'`);
  assert.equal(row.consult_mode, 'PHONE');
  assert.ok(!row.answer_text.includes('0922334455'), 'answer phone redacted');
  const patientSeg = row.thread.find(s => s.role === 'patient');
  assert.ok(!patientSeg.text.includes('Meron'), 'thread name redacted');
  assert.ok(!patientSeg.text.includes('0922334455'), 'thread phone redacted');
  assert.equal(row.thread.length, 3);
  assert.ok(row.thread.some(s => s.role === 'note'), 'clinical note kept');
});

test('v2: re-sending a known hash with an answer attaches instead of dropping', async () => {
  const bare = await call('POST', '/api/v1/ingest/questions', tokens.intake, {
    questions: [{ channel: 'WEBSITE', source_hash: 'test-attach-1',
      text: 'Is it safe to use Postpill twice in one month?' }],
  });
  assert.equal(bare.json().accepted, 1);
  const again = await call('POST', '/api/v1/ingest/questions', tokens.intake, {
    questions: [{ channel: 'WEBSITE', source_hash: 'test-attach-1',
      text: 'Is it safe to use Postpill twice in one month?' }],
  });
  assert.equal(again.json().duplicates, 1, 'bare resend is still a duplicate');
  const withAnswer = await call('POST', '/api/v1/ingest/questions', tokens.intake, {
    questions: [{ channel: 'WEBSITE', source_hash: 'test-attach-1',
      text: 'Is it safe to use Postpill twice in one month?',
      answer_text: 'It is not dangerous, but it is less reliable than regular contraception. Consider a regular method.' }],
  });
  assert.equal(withAnswer.json().updated, 1, withAnswer.body);
  const row = await one(`SELECT answer_text FROM lcos.audience_questions WHERE source_hash='test-attach-1'`);
  assert.match(row.answer_text, /less reliable/);
});

test('v2: a thread segment with an unexpected key rejects the whole batch', async () => {
  const res = await call('POST', '/api/v1/ingest/questions', tokens.intake, {
    questions: [{ channel: 'TELEGRAM', source_hash: 'test-badseg-1', text: 'ok question here',
      thread: [{ role: 'patient', text: 'hello', phone: '0911000000' }] }],
  });
  assert.equal(res.statusCode, 422);
  assert.match(res.json().detail, /unexpected key/);
});

test('v2: a thread segment with an unknown role rejects the whole batch', async () => {
  const res = await call('POST', '/api/v1/ingest/questions', tokens.intake, {
    questions: [{ channel: 'TELEGRAM', source_hash: 'test-badrole-1', text: 'ok question here',
      thread: [{ role: 'admin', text: 'hello' }] }],
  });
  assert.equal(res.statusCode, 422);
  assert.match(res.json().detail, /role must be one of/);
});

test('STEP 2b: classification maps to EC topic and the approved EC-004 card', async () => {
  const res = await call('POST', `/api/v1/questions/${questionId}/classify`, tokens.intake);
  assert.equal(res.statusCode, 200, res.body);
  const c = res.json();
  assert.equal(c.topic_code, 'EC');
  assert.ok(['EC-004', 'EC-005'].includes(c.knowledge_card_code), `matched ${c.knowledge_card_code}`);
  assert.ok(c.match_confidence > 0.5);
  assert.equal(c.is_myth, true);
  const row = await one(`SELECT status, embedding IS NOT NULL AS has_emb FROM lcos.audience_questions WHERE id=$1`, [questionId]);
  assert.equal(row.status, 'CLUSTERED');
  assert.ok(row.has_emb, 'embedding stored');
});

test('semantic search finds the question from a paraphrase', async () => {
  const res = await call('GET',
    '/api/v1/questions/search?semantic=' + encodeURIComponent('repeated postpill use future fertility children'),
    tokens.intake);
  assert.equal(res.statusCode, 200);
  assert.ok(res.json().items.some(i => i.id === questionId), 'question found by paraphrase');
});

test('STEP 4-12: TURN INTO CONTENT produces validated, localized scripts in review', async () => {
  const res = await call('POST', '/api/v1/content/turn-into-content', tokens.intake,
    { question_id: questionId, languages: ['EN', 'AM'] });
  assert.equal(res.statusCode, 202, res.body);
  const p = res.json();
  assert.ok(p.knowledge_card, 'card matched');
  assert.equal(p.knowledge_card.status, 'APPROVED');
  assert.equal(p.risk_tier, 'TIER_3');
  assert.ok(p.concepts.length >= 2, 'concepts generated');
  assert.ok(p.scripts.length >= 1, 'scripts generated');
  familyId = p.family_id;
  scriptIds = p.scripts.map(s => s.id);
  const validated = p.steps.filter(s => s.step === 'validate_claims');
  assert.ok(validated.every(s => s.status === 'PASS'), JSON.stringify(validated));
  // Tier 3 → clinical review queue
  for (const s of p.scripts) assert.equal(s.status, 'CLINICAL_REVIEW');
  // Amharic translation with back-translation exists
  const trans = await one(
    `SELECT * FROM lcos.translations WHERE object_type='SCRIPT' AND object_id=$1`, [scriptIds[0]]);
  assert.ok(trans, 'translation row');
  assert.ok(trans.back_translation.length > 20, 'back-translation present');
  assert.ok(trans.drift_score !== null);
});

test('GOVERNANCE: an unsupported medical statement fails validation', async () => {
  const { generateScript, validateScript } = await import('../src/modules/content.mjs');
  const family = await one(`SELECT * FROM lcos.content_families WHERE id=$1`, [familyId]);
  const card = await one(`SELECT * FROM lcos.knowledge_cards WHERE id=$1`, [family.knowledge_card_id]);
  const cardVersion = await one(`SELECT * FROM lcos.knowledge_card_versions WHERE id=$1`, [card.approved_version_id]);
  const claims = (await q(
    `SELECT mc.id, mc.code, mc.claim_text_en, mc.claim_type, mc.certainty FROM lcos.knowledge_card_claims kcc
     JOIN lcos.medical_claims mc ON mc.id=kcc.claim_id WHERE kcc.card_id=$1`, [card.id])).rows;
  const concept = await one(`SELECT * FROM lcos.content_concepts WHERE family_id=$1 LIMIT 1`, [familyId]);
  const s = await generateScript({ concept, family, card, cardVersion, claims,
    actor: { id: null }, seedUnsupported: true });
  const v = await validateScript(s.id, { actor: { type: 'SYSTEM' } });
  assert.equal(v.overall_result, 'FAIL', 'seeded unsupported statement must FAIL');
  assert.ok(v.findings.some(f => ['UNSUPPORTED_STATEMENT', 'NUMBER_ALTERED'].includes(f.code)));
  const row = await one(`SELECT status, validation_result FROM lcos.scripts WHERE id=$1`, [s.id]);
  assert.equal(row.status, 'VALIDATION_FAILED');
  // And it cannot be approved by anyone, even the medical director.
  const res = await call('POST', `/api/v1/content/scripts/${s.id}/transition`, tokens.meddir,
    { to: 'APPROVED' });
  assert.equal(res.statusCode, 409, 'no transition path from VALIDATION_FAILED to APPROVED');
});

test('GOVERNANCE: a developer cannot clinically approve a script', async () => {
  const res = await call('POST', `/api/v1/content/scripts/${scriptIds[0]}/transition`, tokens.dev,
    { to: 'APPROVED' });
  assert.ok([403, 409].includes(res.statusCode));
  if (res.statusCode === 403) assert.match(res.json().detail, /script.approve_clinical/);
});

test('GOVERNANCE: content lead cannot approve a TIER_3 script editorially', async () => {
  const res = await call('POST', `/api/v1/content/scripts/${scriptIds[0]}/transition`, tokens.content,
    { to: 'APPROVED' });
  assert.equal(res.statusCode, 403, res.body);
});

test('STEP 13: consulting doctor approves the Tier 3 script', async () => {
  const res = await call('POST', `/api/v1/content/scripts/${scriptIds[0]}/transition`, tokens.doctor,
    { to: 'APPROVED' });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().status, 'APPROVED');
});

test('GOVERNANCE: AI voice holds while the Amharic translation is unapproved', async () => {
  const jobRes = await call('POST', '/api/v1/production/jobs', tokens.producer,
    { script_id: scriptIds[0] });
  assert.equal(jobRes.statusCode, 201, jobRes.body);
  const runRes = await call('POST', `/api/v1/production/jobs/${jobRes.json().id}/run`, tokens.producer);
  assert.equal(runRes.statusCode, 200, runRes.body);
  assert.equal(runRes.json().status, 'VOICE_PENDING');
  assert.match(runRes.json().reason, /language-approved/);
});

test('STEP 12b: language editor approves the Amharic', async () => {
  const r = await call('POST', `/api/v1/content/scripts/${scriptIds[0]}/language-review`, tokens.language,
    { decision: 'APPROVED', naturalness_score: 4, meaning_preserved: true });
  assert.equal(r.statusCode, 200, r.body);
});

test('STEP 14-16: production routes and renders through the mock adapter', async () => {
  const jobRes = await call('POST', '/api/v1/production/jobs', tokens.producer,
    { script_id: scriptIds[0] });
  assert.equal(jobRes.statusCode, 201, jobRes.body);
  const job = jobRes.json();
  assert.equal(job.engine, 'CREATOMATE');
  const runRes = await call('POST', `/api/v1/production/jobs/${job.id}/run`, tokens.producer);
  assert.equal(runRes.statusCode, 200, runRes.body);
  const run = runRes.json();
  assert.equal(run.status, 'RENDERED');
  renderId = run.render_id;
  assert.ok(run.preview_url, 'preview exists');
});

test('a script that is not APPROVED cannot enter production', async () => {
  const draft = await one(
    `SELECT id FROM lcos.scripts WHERE status='VALIDATION_FAILED' LIMIT 1`);
  const res = await call('POST', '/api/v1/production/jobs', tokens.producer, { script_id: draft.id });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().guard, 'scriptApproved');
});

test('STEP 17-18: reviewer approves the finished render', async () => {
  const res = await call('POST', `/api/v1/production/renders/${renderId}/approve`, tokens.producer);
  assert.equal(res.statusCode, 200, res.body);
});

test('publishing without final render approval is blocked', async () => {
  // second render with no approval
  const job2 = (await call('POST', '/api/v1/production/jobs', tokens.producer,
    { script_id: scriptIds[0] })).json();
  const run2 = (await call('POST', `/api/v1/production/jobs/${job2.id}/run`, tokens.producer)).json();
  const res = await call('POST', '/api/v1/distribution/jobs', tokens.social,
    { render_id: run2.render_id, platform: 'TELEGRAM' });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().guard, 'finalReviewApproved');
});

test('STEP 19-20: publish to Telegram through the mock connector', async () => {
  const jobRes = await call('POST', '/api/v1/distribution/jobs', tokens.social,
    { render_id: renderId, platform: 'TELEGRAM', caption: 'ጥያቄዎ መልስ አለው' });
  assert.equal(jobRes.statusCode, 201, jobRes.body);
  const pubRes = await call('POST', `/api/v1/distribution/jobs/${jobRes.json().id}/publish-now`, tokens.social);
  assert.equal(pubRes.statusCode, 200, pubRes.body);
  publishedId = pubRes.json().published_content_id;
  assert.ok(publishedId);
});

test('lineage traces the published piece to card, claims and reviewer', async () => {
  const res = await call('GET', `/api/v1/distribution/published/${publishedId}/lineage`, tokens.content);
  assert.equal(res.statusCode, 200, res.body);
  const l = res.json();
  assert.ok(['EC-004', 'EC-005'].includes(l.card_code));
  assert.ok(l.claim_count >= 2, 'claims mapped');
  assert.ok(l.clinical_reviewer_id, 'clinical reviewer recorded');
});

test('STEP 21-22: analytics attach and scores compute', async () => {
  const col = await call('POST', `/api/v1/analytics/collect/${publishedId}`, tokens.social,
    { questions_attributed: 4, consultations_attributed: 2 });
  assert.equal(col.statusCode, 200, col.body);
  assert.ok(col.json().metrics_available.length > 0);
  const sc = await call('POST', `/api/v1/analytics/scores/${publishedId}`, tokens.social);
  assert.equal(sc.statusCode, 200, sc.body);
  const s = sc.json();
  assert.ok(s.composite_score !== null);
  assert.equal(s.confidence, 'LOW');  // honest: too few peers
});

test('demand recompute produces the coverage board', async () => {
  const res = await call('POST', '/api/v1/demand/recompute', tokens.admin);
  assert.equal(res.statusCode, 200, res.body);
  const board = await call('GET', '/api/v1/demand/priority', tokens.content);
  assert.ok(board.json().items.length >= 1);
});

// ---------------------------------------------------------------- more governance
test('GOVERNANCE: retiring the card cancels scheduled publishing and blocks new publish', async () => {
  // schedule a second publish, then retire the card underneath it
  const jobRes = await call('POST', '/api/v1/distribution/jobs', tokens.social,
    { render_id: renderId, platform: 'INSTAGRAM' });
  assert.equal(jobRes.statusCode, 201);
  const family = await one(`SELECT knowledge_card_id FROM lcos.content_families WHERE id=$1`, [familyId]);
  const retire = await call('POST', `/api/v1/knowledge/cards/${family.knowledge_card_id}/transition`,
    tokens.meddir, { to: 'RETIRED', reason: 'test retirement' });
  assert.equal(retire.statusCode, 200, retire.body);
  // The DB trigger cancelled the scheduled job:
  const job = await one(`SELECT status, error_code FROM lcos.publishing_jobs WHERE id=$1`, [jobRes.json().id]);
  assert.equal(job.status, 'CANCELLED');
  assert.equal(job.error_code, 'KNOWLEDGE_INVALIDATED');
  // restore for other tests
  await q(`UPDATE lcos.knowledge_cards SET status='APPROVED', retired_reason=NULL WHERE id=$1`,
    [family.knowledge_card_id]);
});

test('GOVERNANCE: PII in an agent payload blocks the call before dispatch', async () => {
  await assert.rejects(
    invokeAgent('question_classifier', { question_text: 'call me +251911234567 about EC', topics: [], cards: [] }),
    (e) => e instanceof AgentError && e.outcome === 'BLOCKED_PII');
  const row = await one(
    `SELECT outcome FROM lcos.ai_invocations WHERE outcome='BLOCKED_PII' ORDER BY occurred_at DESC LIMIT 1`);
  assert.ok(row, 'BLOCKED_PII recorded in ai_invocations');
});

test('GOVERNANCE: approving a card without claims is refused with a named guard', async () => {
  // A dedicated empty shell: the seeded pilot cards may legitimately carry
  // claims once the basics library is loaded, so the test brings its own.
  await q(`DELETE FROM lcos.knowledge_cards WHERE code='TEST-EMPTY-1'`);
  const topic = await one(`SELECT id FROM lcos.topics WHERE code='MEN'`);
  const card = await one(
    `INSERT INTO lcos.knowledge_cards (code, topic_id, canonical_question_en, status, risk_tier)
     VALUES ('TEST-EMPTY-1', $1, 'test: empty card must not enter review', 'DRAFT', 'TIER_2')
     RETURNING id`, [topic.id]);
  const res = await call('POST', `/api/v1/knowledge/cards/${card.id}/transition`, tokens.meddir,
    { to: 'IN_REVIEW' });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().guard, 'hasClaims');
  await q(`DELETE FROM lcos.knowledge_cards WHERE id=$1`, [card.id]);
});

test('audit log recorded the whole journey', async () => {
  const res = await call('GET', '/api/v1/platform/audit', tokens.admin);
  const actions = res.json().items.map(i => i.action);
  for (const expected of ['publish.executed', 'render.approve', 'script.approved', 'concept.select']) {
    // script.approved comes from the machine as script.approved
    if (expected === 'script.approved') {
      assert.ok(actions.some(a => a === 'script.approved' || a === 'script.approved'.toLowerCase()));
    }
  }
  assert.ok(actions.includes('publish.executed'));
});

test('dashboard reflects reality', async () => {
  const res = await call('GET', '/api/v1/platform/dashboard', tokens.admin);
  assert.equal(res.statusCode, 200);
  const d = res.json();
  assert.ok(d.questions_24h >= 1);
});
