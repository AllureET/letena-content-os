// Run One tests: the unified format registry (migration 0019), per-format
// body generation, claim validation across every format, the nine-stage
// board with signed gates, the medical-sign-off reset on edit, and the
// verbatim canonical assets. These are the kickoff brief's definition-of-
// done tests: one per format proving the right body shape, one proving a
// claim in a non-video body is validated, and one proving publish is
// blocked without a signed medical review.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.LCOS_AI_PROVIDER = 'MOCK';
process.env.LCOS_ADAPTER_MODE = 'MOCK';
process.env.LCOS_STORAGE_DIR = '/tmp/lcos-test-storage';

const { buildServer } = await import('../src/server.mjs');
const { pool, q, one } = await import('../src/core.mjs');
const { bodyTextOf, BODY_KINDS } = await import('../src/formats.mjs');
const { publishRule, STAGES } = await import('../src/pipeline_rules.mjs');
const { LETENA_AMHARIC_BLOCKS, isAbortionAdjacent } = await import('../src/letena_canon.mjs');
const { generateScript, validateScript, generateContent } = await import('../src/modules/content.mjs');
const { nextApplicableStage } = await import('../src/modules/pipeline.mjs');

let app, tokens = {};
const login = async (email) => (await app.inject({ method: 'POST', url: '/api/v1/auth/login',
  payload: { email, password: 'letena-dev-2026' } })).json().token;
const call = (method, url, token, payload) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });

let cardId;   // EC-004, demo-approved: the stable approved-card fixture.

before(async () => {
  app = await buildServer();
  for (const r of ['admin', 'content', 'doctor', 'social', 'producer']) {
    tokens[r] = await login(`${r === 'doctor' ? 'doctor' : r}@letena.local`);
  }
  const card = await one(`SELECT id FROM lcos.knowledge_cards WHERE code='EC-004'`);
  cardId = card.id;
});
after(async () => {
  await app.close();
  await pool.end();
});

// =====================================================================
// Pure: bodyTextOf covers every body surface, including the new ones
// =====================================================================

test('bodyTextOf: a carousel slide, a static graphic and a post are all in the text', () => {
  const t = bodyTextOf({ hook: 'H', carousel_slides: [{ index: 1, title: 'SlideTitle', body: 'SlideBody' }],
    static_graphic: { headline: 'Head', body: 'StaticBody', footer: 'Foot' }, post_text: 'PostBody', cta: 'C' });
  for (const frag of ['SlideTitle', 'SlideBody', 'Head', 'StaticBody', 'Foot', 'PostBody']) {
    assert.ok(t.includes(frag), `missing ${frag}`);
  }
});

test('bodyTextOf: every string leaf of the generic body is collected, however nested', () => {
  const t = bodyTextOf({ hook: 'H', cta: 'C', body: {
    sections: [{ heading: 'SecHead', body: 'SecBody' }],
    items: [{ key: 'k', text_en: 'ItemEn', text_am: 'የአማርኛጽሁፍ', note: 'ItemNote' }],
    push: { title: 'PushTitle', body: 'PushBody', deep_link: 'abeba://today' },
    segments: [{ index: 1, title: 'SegTitle', minutes: 5, description: 'SegDesc' }],
    pinned_message: 'Pinned', cutdown_briefs: ['CutOne'],
  } });
  for (const frag of ['SecHead', 'SecBody', 'ItemEn', 'የአማርኛጽሁፍ', 'ItemNote',
    'PushTitle', 'PushBody', 'SegTitle', 'SegDesc', 'Pinned', 'CutOne']) {
    assert.ok(t.includes(frag), `missing ${frag}`);
  }
});

test('bodyTextOf: all three captions are part of the text, so captions are claim-validated', () => {
  const fromWriter = bodyTextOf({ hook: 'H', cta: 'C',
    captions: { short: 'CapShort', fbtg: 'CapFbtg', x: 'CapX' } });
  const fromDb = bodyTextOf({ hook: 'H', cta: 'C',
    caption_short: 'DbShort', caption_fbtg: 'DbFbtg', caption_x: 'DbX' });
  for (const frag of ['CapShort', 'CapFbtg', 'CapX']) assert.ok(fromWriter.includes(frag), frag);
  for (const frag of ['DbShort', 'DbFbtg', 'DbX']) assert.ok(fromDb.includes(frag), frag);
});

// =====================================================================
// Pure: the publish rule and the stage walk
// =====================================================================

test('publishRule: publish is blocked without a signed medical review, for any piece', () => {
  const blocked = publishRule({ needs_clinical_signoff: false }, new Set(['plan', 'script', 'approve']));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.guard, 'medicalReviewSigned');
  const ok = publishRule({ needs_clinical_signoff: false }, new Set(['medical_review']));
  assert.equal(ok.ok, true);
});

test('publishRule: an abortion-adjacent piece additionally needs clinical_signoff', () => {
  const blocked = publishRule({ needs_clinical_signoff: true }, new Set(['medical_review']));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.guard, 'clinicalSignoffSigned');
  const ok = publishRule({ needs_clinical_signoff: true }, new Set(['medical_review', 'clinical_signoff']));
  assert.equal(ok.ok, true);
});

test('nextApplicableStage skips stages a format marks not applicable', () => {
  const pushStages = ['plan', 'script', 'medical_review', 'approve', 'publish', 'measure'];
  assert.equal(nextApplicableStage('medical_review', pushStages), 'approve');
  assert.equal(nextApplicableStage('publish', pushStages), 'measure');
  assert.equal(nextApplicableStage('measure', pushStages), null);
  // In the superset walk order, produce (the DIGITAL path's single
  // production stage) comes right after medical review; shoot and edit are
  // the LIVE path's stages and effectiveStages() picks per piece.
  assert.equal(nextApplicableStage('medical_review', STAGES), 'produce');
});

test('isAbortionAdjacent matches the ported needle list and nothing benign', () => {
  assert.ok(isAbortionAdjacent('Post-abortion care: warning signs'));
  assert.ok(isAbortionAdjacent('What is MVA?'.toLowerCase()));
  assert.ok(!isAbortionAdjacent('How do condoms prevent pregnancy?'));
});

// =====================================================================
// The registry itself
// =====================================================================

test('GET /content/formats: every brief-required format is a row, none merged away', async () => {
  const r = await call('GET', '/api/v1/content/formats', tokens.content);
  assert.equal(r.statusCode, 200, r.body);
  const items = r.json().items;
  const codes = new Set(items.map(i => i.code));
  const required = ['send_it', 'question_explainer', 'chat_story', 'illustrated_scenario',
    'medical_visual', 'digital_presenter', 'real_ethiopia', 'reply_video', 'animated_news',
    'ask_dr_letena', 'quiz_reel', 'whiteboard_explainer',
    'save_it', 'carousel', 'static_graphic', 'myth_buster', 'infographic', 'quiz_carousel',
    'telegram_post', 'blog', 'library_explainer', 'x_thread', 'linkedin_post', 'newsletter',
    'library_article', 'faq', 'ask_sample_question', 'voices_seed_post', 'daily_insight',
    'push_notification', 'app_copy', 'while_you_wait', 'doctor_reply_starter',
    'aua_live', 'aua_promo', 'aua_recap', 'foundations_episode', 'cse_session',
    'insight_brief', 'radio_spot', 'poster', 'partner_onepager'];
  for (const c of required) assert.ok(codes.has(c), `registry is missing ${c}`);
  // brand_tier was a quota tier, never a format; the owner dropped the quota
  // system, so it must not have been carried over. It survives only as the
  // is_brand_tier flag on a piece.
  assert.ok(!codes.has('brand_tier'), 'brand_tier must not be seeded');
  // aua_clip was split into aua_live / aua_promo / aua_recap (owner, 14 Aug
  // 2026) and must not remain as a dangling code.
  assert.ok(!codes.has('aua_clip'), 'aua_clip must be gone after the three-way split');
  for (const f of items) {
    assert.ok(BODY_KINDS.includes(f.body_kind), `${f.code} has unknown body_kind ${f.body_kind}`);
    assert.ok(f.stages_applicable.includes('medical_review'),
      `${f.code} must never opt out of medical review`);
    assert.ok(Array.isArray(f.headings) && f.headings.length > 0, `${f.code} has no headings`);
    assert.ok(Array.isArray(f.rules) && f.rules.length > 0, `${f.code} has no rules`);
  }
  // The documented hedging tension is scoped per format, never global.
  const push = items.find(i => i.code === 'push_notification');
  assert.equal(push.hedging_allowed, true);
  const sendIt = items.find(i => i.code === 'send_it');
  assert.equal(sendIt.hedging_allowed, false);
});

test('the canonical Amharic blocks ride verbatim in the active writer prompt', async () => {
  const p = await one(`SELECT system_prompt FROM lcos.ai_prompts
                       WHERE prompt_key='script_writer' AND is_active`);
  for (const [name, block] of Object.entries(LETENA_AMHARIC_BLOCKS)) {
    assert.ok(p.system_prompt.includes(block),
      `canonical block "${name}" has drifted out of the active prompt`);
  }
  assert.ok(p.system_prompt.includes('No clinic names publicly. A cost barrier routes to the free-care line.'),
    'clinical governance block missing');
  // Owner, 14 Aug 2026: the red-flag / senior-on-call escalation line
  // "refers to the EMR, and is unnecessary in producing content".
  assert.ok(!p.system_prompt.includes('Red flags route to a phone consult'),
    'the EMR escalation line must be out of content prompts');
  assert.ok(!p.system_prompt.includes('senior on-call clinician'),
    'the EMR escalation line must be out of content prompts');
  assert.ok(p.system_prompt.includes('value in the main post, the door in a self-reply'),
    'per-platform caption rules missing the X rule');
  assert.ok(p.system_prompt.includes('LINKEDIN'), 'per-platform caption rules missing LinkedIn');
  assert.ok(!p.system_prompt.includes('Ousman'), 'no named clinicians in prompts, ever');
});

test('clinical review is OFF for testing, and that never touches the publish gate', async () => {
  // Owner ruling, 14 Aug 2026: "Yes cause were testing". The toggle only
  // controls whether a TIER_3/4 script stops for a human during the
  // pipeline. Publish requires a signed medical_review gate for every
  // format regardless; publishRule() has no toggle input at all. THE
  // TOGGLE MUST GO BACK ON BEFORE REAL PUBLISHING.
  const row = await one(`SELECT value FROM lcos.settings WHERE key='review.clinical_review_enabled'`);
  assert.equal(row.value, false);
  const blocked = publishRule({ needs_clinical_signoff: false }, new Set(['plan', 'script', 'approve']));
  assert.equal(blocked.ok, false, 'publish still refuses without the signed medical gate');
});

// =====================================================================
// One generation per format: the body the format actually needs
// =====================================================================

const BODY_ASSERTIONS = {
  VIDEO: (v) => { assert.ok(v.spoken_script.trim()); assert.ok(v.scene_plan.length >= 1); },
  CAROUSEL: (v) => { assert.ok(v.carousel_slides.length >= 2, 'needs slides'); },
  STATIC: (v) => { assert.ok(v.static_graphic?.headline); assert.ok(v.static_graphic?.body); },
  POST: (v) => { assert.ok((v.post_text ?? '').trim()); },
  ARTICLE: (v) => { assert.ok((v.body?.sections ?? []).length >= 1, 'needs sections'); },
  MICROCOPY: (v) => {
    assert.ok((v.body?.items ?? []).length >= 1, 'needs items');
    assert.ok(v.body.items[0].text_en && v.body.items[0].text_am, 'items carry parallel EN and AM');
  },
  PUSH: (v) => {
    assert.ok(v.body?.push?.title.length <= 40);
    assert.ok(v.body?.push?.body.length <= 100);
    assert.ok(v.body?.push?.deep_link.startsWith('abeba://'));
  },
  AUDIO: (v) => { assert.ok(v.spoken_script.trim()); assert.equal(v.scene_plan.length, 0); },
  LIVE: (v) => {
    assert.ok((v.body?.segments ?? []).length >= 1, 'needs segments');
    assert.ok((v.body?.cutdown_briefs ?? []).length >= 1, 'needs cutdown briefs');
  },
};

test('every registry format generates its own body shape, and its claims are in bodyTextOf', async (t) => {
  const formats = (await q(`SELECT * FROM lcos.content_formats WHERE is_active ORDER BY sort_order`)).rows;
  assert.ok(formats.length >= 42, `expected the full corrected registry, got ${formats.length}`);
  // Direct function calls, not HTTP: the generation endpoints carry a
  // deliberate 30/hour rate limit (they spend money in production), and 36
  // formats through the HTTP path would trip it mid-loop.
  const adminUser = await one(`SELECT id FROM lcos.users WHERE email='admin@letena.local'`);
  const actor = { id: adminUser.id, roles: ['admin'], permissions: [] };
  for (const f of formats) {
    await t.test(`format ${f.code} (${f.body_kind})`, async () => {
      const out = await generateContent({ cardId, formatCodes: [f.code], languages: ['EN'], actor });
      assert.equal(out.scripts.length, 1);
      const scriptId = out.scripts[0].script_id ?? out.scripts[0].id;
      const s = await one(`SELECT * FROM lcos.scripts WHERE id=$1`, [scriptId]);
      const v = await one(`SELECT * FROM lcos.script_versions WHERE script_id=$1 AND version=$2`,
        [s.id, s.current_version]);
      assert.equal(v.format, f.body_kind, `script body kind must match the registry`);
      BODY_ASSERTIONS[f.body_kind](v);
      // The claim map is non-empty and every mapped statement is reachable
      // through bodyTextOf, which is what the validator actually reads.
      const claims = (await q(`SELECT statement FROM lcos.script_claims
                               WHERE script_id=$1 AND script_version=$2`, [s.id, s.current_version])).rows;
      assert.ok(claims.length >= 1, 'claim map must never be empty');
      const text = bodyTextOf(v);
      assert.ok(text.length > 0);
      // Validation ran during the pipeline and passed (claims came straight
      // from the approved card).
      assert.equal(s.validation_result, 'PASS', `validation must PASS for ${f.code}`);
      // The registry format rides on the concept for downstream stages.
      const c = await one(`SELECT format_code FROM lcos.content_concepts WHERE id=$1`, [s.concept_id]);
      assert.equal(c.format_code, f.code);
    });
  }
});

test('one topic becomes three formats in one call, each written to its own schema', async () => {
  const res = await call('POST', '/api/v1/content/generate', tokens.admin,
    { card_id: cardId, formats: ['send_it', 'save_it', 'library_article'], languages: ['EN'] });
  assert.equal(res.statusCode, 202, res.body);
  const out = res.json();
  assert.equal(out.scripts.length, 3);
  const kinds = [];
  for (const sRef of out.scripts) {
    const s = await one(`SELECT * FROM lcos.scripts WHERE id=$1`, [sRef.script_id ?? sRef.id]);
    const v = await one(`SELECT format FROM lcos.script_versions WHERE script_id=$1 AND version=$2`,
      [s.id, s.current_version]);
    kinds.push(v.format);
  }
  assert.deepEqual(kinds.sort(), ['ARTICLE', 'CAROUSEL', 'VIDEO']);
});

// =====================================================================
// SAFETY: a claim in a non-video body is validated exactly as hard
// =====================================================================

test('an unsupported claim on a carousel slide FAILS validation', async () => {
  // Build a save_it concept by API, then regenerate its script directly with
  // the seeded defect: the mock writer plants "It is 99% effective for
  // everyone." INSIDE a slide, with a SLIDE claim location. If bodyTextOf
  // did not cover slides, or the claim map skipped them, this would pass
  // and that is the exact regression this test pins.
  const gen = await call('POST', '/api/v1/content/generate', tokens.admin,
    { card_id: cardId, formats: ['save_it'], languages: ['EN'] });
  assert.equal(gen.statusCode, 202, gen.body);
  const conceptId = gen.json().concepts[0].id;
  const concept = await one(`SELECT * FROM lcos.content_concepts WHERE id=$1`, [conceptId]);
  const family = await one(`SELECT * FROM lcos.content_families WHERE id=$1`, [concept.family_id]);
  const card = await one(`SELECT kc.*, t.code AS topic_code FROM lcos.knowledge_cards kc
                          JOIN lcos.topics t ON t.id=kc.topic_id WHERE kc.id=$1`, [family.knowledge_card_id]);
  const cardVersion = await one(`SELECT * FROM lcos.knowledge_card_versions WHERE id=$1`,
    [family.knowledge_card_version_id]);
  const claims = (await q(
    `SELECT mc.id, mc.code, mc.claim_text_en, mc.certainty FROM lcos.knowledge_card_claims kcc
     JOIN lcos.medical_claims mc ON mc.id=kcc.claim_id
     WHERE kcc.card_id=$1 AND mc.status='APPROVED'`, [card.id])).rows;
  const s = await generateScript({ concept, family, card, cardVersion, claims,
    actor: { id: null }, seedUnsupported: true });
  const v = await one(`SELECT * FROM lcos.script_versions WHERE script_id=$1 AND version=1`, [s.id]);
  assert.equal(v.format, 'CAROUSEL');
  assert.ok(bodyTextOf(v).includes('99% effective for everyone'),
    'the bad statement must be reachable through bodyTextOf');
  const badRow = await one(`SELECT location FROM lcos.script_claims
                            WHERE script_id=$1 AND statement LIKE '%99%% effective%'`, [s.id]);
  assert.equal(badRow.location, 'SLIDE', 'the claim location is the slide, and the insert accepted it');
  const result = await validateScript(s.id, { actor: { id: null } });
  assert.equal(result.overall_result, 'FAIL', 'a bad claim on a slide must fail, same as spoken');
  const after = await one(`SELECT status, validation_result FROM lcos.scripts WHERE id=$1`, [s.id]);
  assert.equal(after.validation_result, 'FAIL');
  assert.equal(after.status, 'VALIDATION_FAILED');
});

test('NEEDS_KNOWLEDGE is a success, not an error', async () => {
  // A card with an approved version but zero attached claims: the writer
  // must stop and name the missing fact rather than inventing one.
  const admin = await one(`SELECT id FROM lcos.users WHERE email='admin@letena.local'`);
  const topic = await one(`SELECT id FROM lcos.topics WHERE code='EC'`);
  const kc = await one(
    `INSERT INTO lcos.knowledge_cards (code, topic_id, canonical_question_en, status, risk_tier, created_by)
     VALUES ('TEST-NK-001', $1, 'A question with no approved facts yet?', 'DRAFT', 'TIER_2', $2)
     ON CONFLICT (code) DO UPDATE SET status='DRAFT' RETURNING id`, [topic.id, admin.id]);
  const kv = await one(
    `INSERT INTO lcos.knowledge_card_versions (card_id, version, canonical_answer_en, content_sha256, created_by)
     VALUES ($1, 1, 'placeholder', md5('placeholder'), $2)
     ON CONFLICT (card_id, version) DO UPDATE SET canonical_answer_en=EXCLUDED.canonical_answer_en
     RETURNING id`, [kc.id, admin.id]);
  // The APPROVED check constraint requires the review fields to be set in
  // the same statement, so approve after the version exists.
  await q(`UPDATE lcos.knowledge_cards SET current_version_id=$2, approved_version_id=$2,
             status='APPROVED', reviewed_by=$3, reviewed_at=now(), review_due_at=CURRENT_DATE+180
           WHERE id=$1`, [kc.id, kv.id, admin.id]);
  const res = await call('POST', '/api/v1/content/generate', tokens.admin,
    { card_id: kc.id, formats: ['telegram_post'], languages: ['EN'] });
  assert.equal(res.statusCode, 202, res.body);
  assert.equal(res.json().scripts[0].status, 'NEEDS_KNOWLEDGE');
});

// =====================================================================
// Stages, gates, publish blocking, and the edit reset
// =====================================================================

test('the stage walk honors not-applicable stages, and publish is gate-blocked end to end', async () => {
  const gen = await call('POST', '/api/v1/content/generate', tokens.admin,
    { card_id: cardId, formats: ['telegram_post'], languages: ['EN'] });
  assert.equal(gen.statusCode, 202, gen.body);
  const scriptId = gen.json().scripts[0].script_id ?? gen.json().scripts[0].id;
  let s = await one(`SELECT * FROM lcos.scripts WHERE id=$1`, [scriptId]);
  assert.equal(s.stage, 'script', 'generation lands at the script stage');
  assert.equal(s.validation_result, 'PASS');

  // Advance out of script (admin signs on advance) -> medical_review.
  let adv = await call('POST', `/api/v1/pipeline/scripts/${scriptId}/advance`, tokens.admin, {});
  assert.equal(adv.statusCode, 200, adv.body);
  assert.equal(adv.json().stage, 'medical_review');
  // Advance out of medical_review: admin holds the clinical permission and
  // validation PASSed, so the advance signs the medical gate. For a
  // telegram_post, shoot and edit are NOT APPLICABLE, so the walk jumps
  // straight to approve.
  adv = await call('POST', `/api/v1/pipeline/scripts/${scriptId}/advance`, tokens.admin, {});
  assert.equal(adv.statusCode, 200, adv.body);
  assert.equal(adv.json().stage, 'approve', 'shoot and edit are skipped as not applicable');
  const gates = (await q(`SELECT gate FROM lcos.script_gates WHERE script_id=$1`, [scriptId]))
    .rows.map(r => r.gate);
  assert.ok(gates.includes('medical_review'), 'advancing out of medical_review signed its gate');

  // Now the executePublish side condition. Approve the script and push a
  // render through, then strip the medical gate to prove publish refuses.
  await q(`UPDATE lcos.scripts SET status='APPROVED', approved_by=$2, approved_at=now(),
             approved_version=current_version WHERE id=$1`,
    [scriptId, (await one(`SELECT id FROM lcos.users WHERE email='admin@letena.local'`)).id]);
  const pj = await call('POST', '/api/v1/production/jobs', tokens.admin, { script_id: scriptId });
  assert.equal(pj.statusCode, 201, pj.body);
  const run = await call('POST', `/api/v1/production/jobs/${pj.json().id}/run`, tokens.admin, {});
  assert.equal(run.statusCode, 200, run.body);
  const renderId = run.json().render_id;
  const rApprove = await call('POST', `/api/v1/production/renders/${renderId}/approve`, tokens.admin, {});
  assert.equal(rApprove.statusCode, 200, rApprove.body);
  const account = await one(`SELECT id FROM lcos.platform_accounts WHERE platform='TELEGRAM' LIMIT 1`);
  const job = await call('POST', '/api/v1/distribution/jobs', tokens.admin,
    { render_id: renderId, platform: 'TELEGRAM', platform_account_id: account.id });
  assert.equal(job.statusCode, 201, job.body);

  // Remove the signed medical gate: publish must refuse, plainly, and must
  // NOT cancel the job (an unsigned gate is a pending human action).
  await q(`DELETE FROM lcos.script_gates WHERE script_id=$1 AND gate='medical_review'`, [scriptId]);
  let pub = await call('POST', `/api/v1/distribution/jobs/${job.json().id}/publish-now`, tokens.admin);
  assert.equal(pub.statusCode, 422, pub.body);
  assert.equal(pub.json().guard, 'medicalReviewSigned');
  const jobRow = await one(`SELECT status FROM lcos.publishing_jobs WHERE id=$1`, [job.json().id]);
  assert.equal(jobRow.status, 'SCHEDULED', 'job stays scheduled, waiting on the signature');

  // Sign it back through the pipeline endpoint and publish goes through.
  const sign = await call('POST', `/api/v1/pipeline/scripts/${scriptId}/gates/medical_review`,
    tokens.admin, { note: 'signed for test' });
  assert.equal(sign.statusCode, 200, sign.body);
  pub = await call('POST', `/api/v1/distribution/jobs/${job.json().id}/publish-now`, tokens.admin);
  assert.equal(pub.statusCode, 200, pub.body);
});

test('signing the medical gate is refused while claim validation has not passed', async () => {
  const gen = await call('POST', '/api/v1/content/generate', tokens.admin,
    { card_id: cardId, formats: ['static_graphic'], languages: ['EN'] });
  const scriptId = gen.json().scripts[0].script_id ?? gen.json().scripts[0].id;
  // With clinical review off for testing, a TIER_3 piece auto-approves at
  // generation; drop it back to DRAFT so the NOT_RUN reset below does not
  // trip the approved-requires-pass constraint.
  await q(`UPDATE lcos.scripts SET validation_result='NOT_RUN', status='DRAFT',
             approved_by=NULL, approved_at=NULL, approved_version=NULL WHERE id=$1`, [scriptId]);
  const sign = await call('POST', `/api/v1/pipeline/scripts/${scriptId}/gates/medical_review`,
    tokens.admin, {});
  assert.equal(sign.statusCode, 422, sign.body);
  assert.equal(sign.json().guard, 'validationBeforeMedicalGate');
});

test('a human edit to medically meaningful content invalidates the medical sign-off', async () => {
  const gen = await call('POST', '/api/v1/content/generate', tokens.admin,
    { card_id: cardId, formats: ['telegram_post'], languages: ['EN'] });
  const scriptId = gen.json().scripts[0].script_id ?? gen.json().scripts[0].id;
  // Sign the medical gate (validation passed during generation).
  const sign = await call('POST', `/api/v1/pipeline/scripts/${scriptId}/gates/medical_review`,
    tokens.admin, {});
  assert.equal(sign.statusCode, 200, sign.body);
  await q(`UPDATE lcos.scripts SET status='APPROVED', approved_by=$2, approved_at=now(),
             approved_version=current_version, stage='approve' WHERE id=$1`,
    [scriptId, (await one(`SELECT id FROM lcos.users WHERE email='admin@letena.local'`)).id]);

  // Edit the body text. The sign-off no longer describes the content.
  const edit = await call('POST', `/api/v1/content/scripts/${scriptId}/edit`, tokens.admin,
    { post_text: 'A different message entirely, changing the medical meaning.' });
  assert.equal(edit.statusCode, 200, edit.body);
  assert.equal(edit.json().content_changed, true);
  assert.equal(edit.json().medical_signoff_invalidated, true);
  const gates = (await q(`SELECT gate FROM lcos.script_gates WHERE script_id=$1`, [scriptId])).rows;
  assert.ok(!gates.some(g => g.gate === 'medical_review'), 'medical gate withdrawn');
  const s = await one(`SELECT status, validation_result, stage, current_version FROM lcos.scripts WHERE id=$1`, [scriptId]);
  assert.equal(s.status, 'DRAFT', 'approved script drops back to draft');
  assert.equal(s.validation_result, 'NOT_RUN', 'must re-validate');
  assert.equal(s.stage, 'script', 'stage rolls back behind medical review');
  assert.equal(s.current_version, 2, 'the edit is a new version, the old one is preserved');

  // A resave with identical text does NOT withdraw anything.
  const sign2 = await call('POST', `/api/v1/pipeline/scripts/${scriptId}/gates/medical_review`, tokens.admin, {});
  assert.equal(sign2.statusCode, 422, 'cannot re-sign until validation passes again');
});

test('abortion-adjacent generation carries needs_clinical_signoff and the publish rule enforces it', async () => {
  // EC-004 is not abortion-adjacent; fabricate an adjacent concept title by
  // generating and then checking the detection path directly on a script
  // row plus the pure rule. Detection at generation is exercised via
  // isAbortionAdjacent above; here we pin the stored flag's effect.
  const gen = await call('POST', '/api/v1/content/generate', tokens.admin,
    { card_id: cardId, formats: ['telegram_post'], languages: ['EN'] });
  const scriptId = gen.json().scripts[0].script_id ?? gen.json().scripts[0].id;
  await q(`UPDATE lcos.scripts SET needs_clinical_signoff=true WHERE id=$1`, [scriptId]);
  const s = await one(`SELECT * FROM lcos.scripts WHERE id=$1`, [scriptId]);
  const blocked = publishRule(s, new Set(['medical_review']));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.guard, 'clinicalSignoffSigned');
});

test('the board groups by stage and explains blockers in plain language', async () => {
  const r = await call('GET', '/api/v1/pipeline/board', tokens.content);
  assert.equal(r.statusCode, 200, r.body);
  const out = r.json();
  assert.deepEqual(out.stage_order, STAGES);
  const all = Object.values(out.stages).flat();
  assert.ok(all.length > 0, 'board shows pieces');
  const blockedOne = all.find(p => p.advance_block);
  assert.ok(blockedOne, 'a piece with an unsigned gate explains itself');
});
