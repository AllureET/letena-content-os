// Part 1 correction tests (owner feedback, Nate, 14 Aug 2026): audience
// registers, stay-English terminology enforcement, the call-or-DM CTA on
// every format, the new formats (ask_dr_letena, the AUA split, the quiz
// pair, the whiteboard explainer), the digital-by-default production path,
// clinical sign-off blocking medical review, role-based gate signing, the
// refined edit classification with the Amharic feedback loop, per-platform
// captions, and the brand-tier flag.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.LCOS_AI_PROVIDER = 'MOCK';
process.env.LCOS_ADAPTER_MODE = 'MOCK';
process.env.LCOS_STORAGE_DIR = '/tmp/lcos-test-storage';

const { buildServer } = await import('../src/server.mjs');
const { pool, q, one } = await import('../src/core.mjs');
const { lintStyle, lintStayEnglish } = await import('../src/ai/style_lint.mjs');
const { LETENA_AMHARIC_BLOCKS, assembleCta, CLINICAL_GOVERNANCE_RULES, PLATFORM_CAPTION_RULES }
  = await import('../src/letena_canon.mjs');
const { classifyEdit, effectiveStages, STAGES } = await import('../src/pipeline_rules.mjs');
const { requireFormatBody, stayEnglishTerms, extractAmharicSegments } = await import('../src/modules/content.mjs');
const { HOUSE_STYLE_RULES } = await import('../src/ai/gateway.mjs');

let app, tokens = {};
const login = async (email) => (await app.inject({ method: 'POST', url: '/api/v1/auth/login',
  payload: { email, password: 'letena-dev-2026' } })).json().token;
const call = (method, url, token, payload) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });

let cardId;
before(async () => {
  app = await buildServer();
  for (const r of ['admin', 'content', 'doctor', 'social', 'producer']) {
    tokens[r] = await login(`${r === 'doctor' ? 'doctor' : r}@letena.local`);
  }
  cardId = (await one(`SELECT id FROM lcos.knowledge_cards WHERE code='EC-004'`)).id;
});
after(async () => { await app.close(); await pool.end(); });

const genOne = async (format, extra = {}) => {
  const res = await call('POST', '/api/v1/content/generate', tokens.admin,
    { card_id: cardId, formats: [format], languages: ['EN'], ...extra });
  assert.equal(res.statusCode, 202, res.body);
  const scriptId = res.json().scripts[0].script_id ?? res.json().scripts[0].id;
  const s = await one(`SELECT * FROM lcos.scripts WHERE id=$1`, [scriptId]);
  const v = await one(`SELECT * FROM lcos.script_versions WHERE script_id=$1 AND version=$2`,
    [s.id, s.current_version]);
  const concept = await one(`SELECT * FROM lcos.content_concepts WHERE id=$1`, [s.concept_id]);
  return { s, v, concept, out: res.json() };
};

// =====================================================================
// Item 6: the EMR escalation line is out of the content governance block
// =====================================================================

test('the EMR escalation line is removed from the governance rules; the rest stays verbatim', () => {
  assert.ok(!CLINICAL_GOVERNANCE_RULES.includes('Red flags route to a phone consult'));
  assert.ok(!CLINICAL_GOVERNANCE_RULES.includes('senior on-call clinician'));
  for (const kept of [
    'Inform and refer, never diagnose in comments or DMs.',
    'PEP and any 72-hour pathway leads with the phone. Exposure within 72 hours routes to phone first.',
    'Abortion content stays at options counseling, post-abortion care, and accompaniment. No methods, no dosing, no sourcing, no how-to, on screen or in captions. Warning-signs content is the one safety exception and stays.',
    'Emergency contraception and PEP after assault are raised in the private consult only, never on screen.',
    'No clinic names publicly. A cost barrier routes to the free-care line.',
  ]) assert.ok(CLINICAL_GOVERNANCE_RULES.includes(kept), `governance lost: ${kept}`);
});

// =====================================================================
// Item 2: terminology, deterministic enforcement
// =====================================================================

test('an Amharic body that renders "condom" in Amharic script is flagged, deterministically', async () => {
  const entries = await stayEnglishTerms();
  assert.ok(entries.length >= 20, 'the stay-English set must be seeded and APPROVED');
  const flagged = lintStayEnglish('ኮንዶም መጠቀም እርግዝናን ይከላከላል።', entries);
  assert.ok(flagged.some((w) => w.includes('"Condom"') && w.includes('ኮንዶም')),
    JSON.stringify(flagged));
  // Through lintStyle with the same entries, as generation runs it.
  const viaLint = lintStyle('Postpill ውጤታማ ነው። ኮንዶም ግን የተሻለ ነው።', { stayEnglish: entries });
  assert.ok(viaLint.some((w) => w.startsWith('terminology_stay_english:')));
  // English usage of the term is fine; Amharic-native words are fine.
  assert.equal(lintStayEnglish('Condom መጠቀም ጥሩ ነው። የወር አበባ መዘግየት የተለመደ ነው።', entries).length, 0);
});

test('the stay-English terminology rides in the active writer and localizer prompts', async () => {
  for (const key of ['script_writer', 'amharic_localizer']) {
    const p = await one(`SELECT system_prompt FROM lcos.ai_prompts WHERE prompt_key=$1 AND is_active`, [key]);
    assert.ok(/never transliterate/i.test(p.system_prompt), `${key} must state the transliteration ban`);
    assert.ok(p.system_prompt.includes('Postpill'), `${key} must carry the rule with examples`);
  }
});

// =====================================================================
// Items 7 and 8: comments and hedging, precise
// =====================================================================

test('filler hedging is flagged even where hedging is allowed; uncertainty words only where banned', () => {
  const filler = lintStyle('It is generally recommended to note that results may vary.', { hedgingAllowed: true });
  assert.ok(filler.filter((w) => w.startsWith('hedge_phrase:')).length >= 2, JSON.stringify(filler));
  const genuine = lintStyle('Your period might come a day or two late.', { hedgingAllowed: true });
  assert.equal(genuine.filter((w) => w.startsWith('hedge_phrase:')).length, 0, JSON.stringify(genuine));
});

test('a non-disclosing comment prompt passes; a self-disclosure ask is flagged; disallowed formats flag any invite', () => {
  const fine = lintStyle('What myth have you heard about Postpill? Tell us below. Tag a friend who should see this.',
    { commentPromptAllowed: true });
  assert.equal(fine.filter((w) => w.includes('comment')).length, 0, JSON.stringify(fine));
  const disclosure = lintStyle('Comment below and share your experience with your period.',
    { commentPromptAllowed: true });
  assert.ok(disclosure.some((w) => w.startsWith('comment_self_disclosure:')), JSON.stringify(disclosure));
  const notAllowed = lintStyle('Drop a comment with your favourite topic.', { commentPromptAllowed: false });
  assert.ok(notAllowed.some((w) => w.startsWith('comment_prompt_not_allowed:')), JSON.stringify(notAllowed));
});

test('HOUSE_STYLE_RULES carries the corrected comment and hedging rules', () => {
  assert.ok(HOUSE_STYLE_RULES.includes('disclose something private in public'));
  assert.ok(HOUSE_STYLE_RULES.includes('tag-a-friend'));
  assert.ok(HOUSE_STYLE_RULES.includes('load-bearing'));
  assert.ok(!HOUSE_STYLE_RULES.includes('Never ask for a public comment'));
});

// =====================================================================
// Item 4: every non-internal format has a CTA with a real contact route
// =====================================================================

test('every non-internal format assembles a CTA carrying a real contact route, never a retyped number', async () => {
  const formats = (await q(`SELECT code, cta_spec, is_internal FROM lcos.content_formats WHERE is_active`)).rows;
  for (const f of formats) {
    if (f.is_internal) continue;
    const cta = assembleCta(f.cta_spec);
    assert.ok(cta, `${f.code} has no assembled CTA`);
    assert.ok(/0908 182 838|abeba:\/\/|letena\.et|@LetenaEthBot/.test(cta),
      `${f.code} CTA carries no real contact route: ${cta}`);
    // Blocks are the canonical bytes, never paraphrased.
    for (const b of f.cta_spec.blocks ?? []) {
      assert.ok(cta.includes(LETENA_AMHARIC_BLOCKS[b]), `${f.code} block ${b} not byte-identical`);
    }
  }
  const sendIt = formats.find((f) => f.code === 'send_it');
  assert.deepEqual(sendIt.cta_spec.actions, ['call', 'dm'], 'the two actions are call and DM');
  const promo = formats.find((f) => f.code === 'aua_promo');
  assert.deepEqual(promo.cta_spec.actions, ['send_question'], 'aua_promo CTA is send your question');
});

// =====================================================================
// Item 5: the new formats generate their required bodies
// =====================================================================

test('ask_dr_letena carries a de-identified reworded question, and refuses one that cannot be de-identified', async () => {
  const { v, s } = await genOne('ask_dr_letena');
  assert.equal(v.format, 'VIDEO');
  assert.ok(v.body.question_quoted?.length > 10, 'the reworded question is in the body');
  assert.equal(s.production_path, 'DIGITAL', 'works digitally by default');
  // A question still carrying a phone number after rewording is a hard stop.
  const fmtRow = await one(`SELECT * FROM lcos.content_formats WHERE code='ask_dr_letena'`);
  assert.throws(() => requireFormatBody(fmtRow,
    { body: { question_quoted: 'A woman on 0911234567 asked about her result.' } }),
  /cannot be fully de-identified/);
});

test('quiz formats require the giveaway mechanic and keep it non-clinical and unmapped', async () => {
  for (const code of ['quiz_reel', 'quiz_carousel']) {
    const { v } = await genOne(code);
    const g = v.body.giveaway;
    assert.ok(g?.how_to_enter && g?.deadline && g?.winner_selection, `${code} giveaway incomplete`);
    assert.ok(v.body.quiz?.question && v.body.quiz?.answer, `${code} quiz body incomplete`);
    // The quiz answer is claim-mapped like any medical statement.
    const claims = (await q(`SELECT statement FROM lcos.script_claims sc
      JOIN lcos.scripts s ON s.id=sc.script_id WHERE sc.script_id IN
      (SELECT script_id FROM lcos.script_versions WHERE id=$1)`, [v.id])).rows;
    assert.ok(claims.length >= 1, `${code} must stay claim-mapped`);
  }
  const fmtRow = await one(`SELECT * FROM lcos.content_formats WHERE code='quiz_reel'`);
  assert.throws(() => requireFormatBody(fmtRow, { body: { quiz: { question: 'q', answer: 'a' } } }),
    /giveaway/);
});

test('aua_recap requires exactly four cutdown briefs; aua_live is the run of show', async () => {
  // The recap generates from the live's transcript, and only a CONFIRMED
  // one (Part 2, 14 Aug 2026): create, confirm, then generate.
  const created = await call('POST', '/api/v1/content/transcripts', tokens.admin,
    { title: 'part1 recap fixture', transcript_text: '[00:05] Postpill works within 72 hours.' });
  assert.equal(created.statusCode, 201, created.body);
  const transcriptId = created.json().id;
  const confirmed = await call('POST', `/api/v1/content/transcripts/${transcriptId}/confirm`, tokens.admin);
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  const { v } = await genOne('aua_recap', { transcript_id: transcriptId });
  assert.equal(v.format, 'VIDEO');
  assert.equal(v.body.cutdown_briefs.length, 4);
  const live = await genOne('aua_live');
  assert.equal(live.v.format, 'LIVE');
  assert.ok(live.v.body.segments.length >= 1);
  assert.equal(live.s.production_path, 'LIVE', 'aua_live is LIVE only');
});

test('whiteboard_explainer requires three to four clips, each with a last-frame anchor, and a board map', async () => {
  const { v, s } = await genOne('whiteboard_explainer');
  const w = v.body.whiteboard;
  assert.ok(w.clips.length >= 3 && w.clips.length <= 4);
  for (const c of w.clips) assert.ok(c.last_frame_anchor?.length > 10, 'every clip carries its anchor');
  assert.ok(w.board_map.length >= 1);
  assert.ok(w.pronunciation_notes.length >= 1);
  assert.equal(s.production_path, 'DIGITAL', 'the whiteboard explainer is DIGITAL only');
  const fmtRow = await one(`SELECT * FROM lcos.content_formats WHERE code='whiteboard_explainer'`);
  assert.throws(() => requireFormatBody(fmtRow,
    { body: { whiteboard: { board_map: [{ element: 'x' }], clips: [{ index: 1, dialogue: 'd', last_frame_anchor: 'a' }] } } }),
  /three to four clips/);
});

// =====================================================================
// Item 9: digital by default, live optional, none skips production
// =====================================================================

test('a clip defaults to DIGITAL and walks produce instead of shoot and edit', async () => {
  const { s } = await genOne('send_it');
  assert.equal(s.production_path, 'DIGITAL');
  let adv = await call('POST', `/api/v1/pipeline/scripts/${s.id}/advance`, tokens.admin, {});
  assert.equal(adv.json().stage, 'medical_review', adv.body);
  adv = await call('POST', `/api/v1/pipeline/scripts/${s.id}/advance`, tokens.admin, {});
  assert.equal(adv.json().stage, 'produce', 'DIGITAL replaces shoot and edit with produce');
  adv = await call('POST', `/api/v1/pipeline/scripts/${s.id}/advance`, tokens.admin, {});
  assert.equal(adv.json().stage, 'approve', 'after produce comes approve');
});

test('the production path is changeable until production starts, within what the format supports', async () => {
  const { s } = await genOne('send_it');
  let r = await call('POST', `/api/v1/pipeline/scripts/${s.id}/production-path`, tokens.admin, { path: 'LIVE' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().production_path, 'LIVE');
  r = await call('POST', `/api/v1/pipeline/scripts/${s.id}/production-path`, tokens.admin, { path: 'DIGITAL' });
  assert.equal(r.statusCode, 200, r.body);
  // aua_live supports LIVE only.
  const live = await genOne('aua_live');
  r = await call('POST', `/api/v1/pipeline/scripts/${live.s.id}/production-path`, tokens.admin, { path: 'DIGITAL' });
  assert.equal(r.statusCode, 422);
  assert.equal(r.json().guard, 'formatSupportsPath');
  // Once past medical review, the path is locked.
  await call('POST', `/api/v1/pipeline/scripts/${s.id}/advance`, tokens.admin, {});
  await call('POST', `/api/v1/pipeline/scripts/${s.id}/advance`, tokens.admin, {});
  r = await call('POST', `/api/v1/pipeline/scripts/${s.id}/production-path`, tokens.admin, { path: 'LIVE' });
  assert.equal(r.statusCode, 422);
  assert.equal(r.json().guard, 'productionNotStarted');
});

test('a push notification has no production at all and walks straight to approve', async () => {
  const { s } = await genOne('push_notification');
  assert.equal(s.production_path, 'NONE');
  const fmt = await one(`SELECT stages_applicable FROM lcos.content_formats WHERE code='push_notification'`);
  const eff = effectiveStages(fmt.stages_applicable, 'NONE');
  assert.ok(!eff.includes('produce') && !eff.includes('shoot') && !eff.includes('edit'));
  await call('POST', `/api/v1/pipeline/scripts/${s.id}/advance`, tokens.admin, {});
  const adv = await call('POST', `/api/v1/pipeline/scripts/${s.id}/advance`, tokens.admin, {});
  assert.equal(adv.json().stage, 'approve');
});

// =====================================================================
// Item 10: clinical sign-off blocks the exit from medical review
// =====================================================================

test('a flagged piece cannot leave medical review until clinical_signoff is signed too', async () => {
  const { s } = await genOne('telegram_post');
  await q(`UPDATE lcos.scripts SET needs_clinical_signoff=true WHERE id=$1`, [s.id]);
  let adv = await call('POST', `/api/v1/pipeline/scripts/${s.id}/advance`, tokens.admin, {});
  assert.equal(adv.json().stage, 'medical_review');
  // Admin signs medical_review on advance, but the flagged piece stops HERE,
  // where a clinician is already looking, not at publish.
  adv = await call('POST', `/api/v1/pipeline/scripts/${s.id}/advance`, tokens.admin, {});
  assert.equal(adv.statusCode, 422, adv.body);
  assert.equal(adv.json().guard, 'clinicalSignoffBeforeMedicalExit');
  const sign = await call('POST', `/api/v1/pipeline/scripts/${s.id}/gates/clinical_signoff`, tokens.admin, {});
  assert.equal(sign.statusCode, 200, sign.body);
  adv = await call('POST', `/api/v1/pipeline/scripts/${s.id}/advance`, tokens.admin, {});
  assert.equal(adv.statusCode, 200, adv.body);
  assert.equal(adv.json().stage, 'approve');
});

// =====================================================================
// Item 11: role-based signing, admin visible as the override
// =====================================================================

test('gates are signed by role: content lead refused on the medical gate, doctor signs it, admin is recorded as override', async () => {
  const { s } = await genOne('telegram_post');
  const refused = await call('POST', `/api/v1/pipeline/scripts/${s.id}/gates/medical_review`, tokens.content, {});
  assert.equal(refused.statusCode, 403, refused.body);
  assert.match(refused.json().detail, /consulting_doctor or medical_director/);
  const byDoctor = await call('POST', `/api/v1/pipeline/scripts/${s.id}/gates/medical_review`, tokens.doctor, {});
  assert.equal(byDoctor.statusCode, 200, byDoctor.body);
  assert.equal(byDoctor.json().signed_role, 'consulting_doctor');
  const row = await one(`SELECT signed_role FROM lcos.script_gates WHERE script_id=$1 AND gate='medical_review'`, [s.id]);
  assert.equal(row.signed_role, 'consulting_doctor');
  // Admin signing outside their declared role is visible as the override.
  const byAdmin = await call('POST', `/api/v1/pipeline/scripts/${s.id}/gates/clinical_signoff`, tokens.admin, {});
  assert.equal(byAdmin.statusCode, 200, byAdmin.body);
  assert.equal(byAdmin.json().signed_role, 'admin_override');
});

// =====================================================================
// Item 12.1: the refined edit split and the Amharic feedback loop
// =====================================================================

test('an edit that changes a number goes back to medical review; a hook rewrite does not', async () => {
  const { s, v } = await genOne('telegram_post');
  const sign = await call('POST', `/api/v1/pipeline/scripts/${s.id}/gates/medical_review`, tokens.doctor, {});
  assert.equal(sign.statusCode, 200, sign.body);
  await q(`UPDATE lcos.scripts SET status='APPROVED', approved_version=current_version WHERE id=$1`, [s.id]);

  // NON-MEDICAL: append plain Amharic to the hook; every claim statement,
  // number, negation, hedge and terminology count is untouched.
  const softened = `${v.hook} የተለመደ ጥያቄ ነው።`;
  let edit = await call('POST', `/api/v1/content/scripts/${s.id}/edit`, tokens.admin, { hook: softened });
  assert.equal(edit.statusCode, 200, edit.body);
  assert.equal(edit.json().edit_class, 'NON_MEDICAL', JSON.stringify(edit.json().edit_reasons));
  assert.equal(edit.json().medical_signoff_invalidated, false);
  const gateStillThere = await one(
    `SELECT signed_role FROM lcos.script_gates WHERE script_id=$1 AND gate='medical_review'`, [s.id]);
  assert.ok(gateStillThere, 'the sign-off stands on a non-medical edit');
  // The corrected Amharic was captured for the localizer to learn from.
  const example = await one(
    `SELECT amharic_text FROM lcos.phrasing_examples WHERE script_id=$1 ORDER BY created_at DESC LIMIT 1`, [s.id]);
  assert.ok(example?.amharic_text.includes('የተለመደ ጥያቄ ነው'), 'Amharic phrasing captured');

  // MEDICAL: introduce a number that was never in the piece.
  const v2 = await one(`SELECT * FROM lcos.script_versions WHERE script_id=$1 ORDER BY version DESC LIMIT 1`, [s.id]);
  edit = await call('POST', `/api/v1/content/scripts/${s.id}/edit`, tokens.admin,
    { post_text: `${v2.post_text} It is 87% effective.` });
  assert.equal(edit.statusCode, 200, edit.body);
  assert.equal(edit.json().edit_class, 'MEDICAL', JSON.stringify(edit.json().edit_reasons));
  assert.equal(edit.json().medical_signoff_invalidated, true);
  const gateGone = await one(
    `SELECT id FROM lcos.script_gates WHERE script_id=$1 AND gate='medical_review'`, [s.id]);
  assert.ok(!gateGone, 'the medical gate is withdrawn');
  const after = await one(`SELECT validation_result, stage FROM lcos.scripts WHERE id=$1`, [s.id]);
  assert.equal(after.validation_result, 'NOT_RUN');
});

test('classifyEdit is conservative at the boundary', () => {
  assert.equal(classifyEdit({ oldText: null, newText: 'x' }).medical, true);
  assert.equal(classifyEdit({ oldText: 'Take it within 72 hours.', newText: 'Take it within 5 days.' }).medical, true);
  assert.equal(classifyEdit({ oldText: 'It can happen.', newText: 'It will happen.' }).medical, true);
  assert.equal(classifyEdit({
    oldText: 'Old hook. The fact stays exactly here.',
    newText: 'A sharper hook. The fact stays exactly here.',
    claimStatements: ['The fact stays exactly here.'] }).medical, false);
  assert.equal(classifyEdit({
    oldText: 'Hook. The fact stays exactly here.',
    newText: 'Hook. The fact is now different.',
    claimStatements: ['The fact stays exactly here.'] }).medical, true);
});

// =====================================================================
// Items 1, 12.2, 13: audience, brand tier, per-platform captions
// =====================================================================

test('the audience field rides the request, lands on the concept, and defaults to WOMEN', async () => {
  const men = await genOne('send_it', { audience: 'MEN' });
  assert.equal(men.concept.audience, 'MEN');
  const def = await genOne('send_it');
  assert.equal(def.concept.audience, 'WOMEN');
  const bad = await call('POST', '/api/v1/content/generate', tokens.admin,
    { card_id: cardId, formats: ['send_it'], audience: 'EVERYONE' });
  assert.equal(bad.statusCode, 422);
});

test('is_brand_tier is a flag on the piece, not a format', async () => {
  const { s } = await genOne('static_graphic', { is_brand_tier: true });
  assert.equal(s.is_brand_tier, true);
  const normal = await genOne('static_graphic');
  assert.equal(normal.s.is_brand_tier, false);
});

test('captions are keyed by the format platforms and are claim-validated surfaces', async () => {
  const { v } = await genOne('save_it');
  const platforms = Object.keys(v.captions_by_platform ?? {});
  assert.deepEqual(platforms.sort(), ['INSTAGRAM', 'TELEGRAM'],
    'save_it publishes to Instagram and Telegram, so it gets exactly those captions');
  const { bodyTextOf } = await import('../src/formats.mjs');
  for (const text of Object.values(v.captions_by_platform)) {
    assert.ok(bodyTextOf(v).includes(text), 'every platform caption is inside bodyTextOf');
  }
  // The legacy trio migrated into the platform-keyed shape stays readable.
  const legacy = bodyTextOf({ hook: 'H', cta: 'C', captions_by_platform: { FACEBOOK: 'FbCap', LINKEDIN: 'LiCap' } });
  assert.ok(legacy.includes('FbCap') && legacy.includes('LiCap'));
  // All seven platform rules exist.
  for (const pl of ['TIKTOK', 'INSTAGRAM', 'FACEBOOK', 'TELEGRAM', 'TWITTER', 'LINKEDIN', 'YOUTUBE']) {
    assert.ok(PLATFORM_CAPTION_RULES[pl], `caption rule missing for ${pl}`);
  }
});

// =====================================================================
// Voice and helpers
// =====================================================================

test('the house voice is the doctor first, and the audience includes men', async () => {
  const preset = await one(`SELECT prompt_instructions FROM lcos.tone_presets WHERE key='LETENA_DEFAULT'`);
  assert.ok(/doctor first/i.test(preset.prompt_instructions));
  assert.ok(/not a peer, not a lecturer/i.test(preset.prompt_instructions));
  assert.ok(/men/i.test(preset.prompt_instructions));
  assert.ok(!/older sister/i.test(preset.prompt_instructions), 'the peer framing is pulled back');
});

test('extractAmharicSegments finds Ethiopic runs and ignores Latin text', () => {
  const segs = extractAmharicSegments('Hook line. የወር አበባ መዘግየት የተለመደ ነው። More English.');
  assert.ok(segs.some((x) => x.includes('የወር አበባ')));
  assert.equal(extractAmharicSegments('English only.').length, 0);
});
