// Content module: families, concepts, scripts, claim validation, Amharic
// localization, language QA, and the Turn Into Content pipeline.
import crypto from 'node:crypto';
import { q, one, tx, audit, requirePerm, err, transition, setting } from '../core.mjs';
import { invokeAgent, embed } from '../ai/gateway.mjs';
import { validatorOverlay, overallResult, computeRiskTier } from '../../../../packages/scoring/src/index.mjs';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const code = (p) => `${p}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

export default async function routes(app) {
  app.get('/content/families', { preHandler: requirePerm('concept.read') }, async () => {
    const r = await q(
      `SELECT cf.*, kc.code AS card_code, seg.slug AS segment_slug
       FROM lcos.content_families cf
       JOIN lcos.knowledge_cards kc ON kc.id=cf.knowledge_card_id
       JOIN lcos.audience_segments seg ON seg.id=cf.primary_segment_id
       ORDER BY cf.created_at DESC LIMIT 200`);
    return { items: r.rows };
  });

  app.get('/content/concepts', { preHandler: requirePerm('concept.read') }, async (req) => {
    const r = await q(
      `SELECT * FROM lcos.content_concepts
       WHERE ($1::uuid IS NULL OR family_id=$1::uuid)
       ORDER BY created_at DESC LIMIT 200`, [req.query.family_id ?? null]);
    return { items: r.rows };
  });
  app.post('/content/concepts/:id/select', { preHandler: requirePerm('concept.select') }, async (req) => {
    const c = await one(
      `UPDATE lcos.content_concepts SET status='SELECTED', selected_by=$2, selected_at=now()
       WHERE id=$1 RETURNING *`, [req.params.id, req.actor.id]);
    await audit(null, { actor: req.actor, action: 'concept.select', objectType: 'CONCEPT', objectId: req.params.id });
    return c;
  });

  app.get('/content/scripts', { preHandler: requirePerm('script.read') }, async (req) => {
    const r = await q(
      `SELECT s.*, cf.code AS family_code, kc.code AS card_code
       FROM lcos.scripts s
       JOIN lcos.content_families cf ON cf.id=s.family_id
       JOIN lcos.knowledge_cards kc ON kc.id=cf.knowledge_card_id
       WHERE ($1::text IS NULL OR s.status=$1::lcos.script_status)
       ORDER BY s.created_at DESC LIMIT 200`, [req.query.status ?? null]);
    return { items: r.rows };
  });
  app.get('/content/scripts/:id', { preHandler: requirePerm('script.read') }, async (req, reply) => {
    const s = await one(`SELECT * FROM lcos.scripts WHERE id=$1`, [req.params.id]);
    if (!s) return reply.code(404).send(err(404, 'NOT_FOUND', 'script'));
    const version = await one(
      `SELECT * FROM lcos.script_versions WHERE script_id=$1 AND version=$2`, [s.id, s.current_version]);
    const claimMap = (await q(
      `SELECT sc.*, mc.code AS claim_code, mc.claim_text_en FROM lcos.script_claims sc
       JOIN lcos.medical_claims mc ON mc.id=sc.claim_id
       WHERE sc.script_id=$1 AND sc.script_version=$2`, [s.id, s.current_version])).rows;
    const findings = (await q(
      `SELECT * FROM lcos.script_findings WHERE script_id=$1 AND script_version=$2 AND NOT resolved`,
      [s.id, s.current_version])).rows;
    const translation = await one(
      `SELECT * FROM lcos.translations WHERE object_type='SCRIPT' AND object_id=$1 AND language='AM'`, [s.id]);
    return { ...s, version, claim_map: claimMap, findings, translation };
  });
  app.post('/content/scripts/:id/transition', async (req, reply) => {
    try {
      return await transition('script', req.params.id, req.body?.to, {
        actor: req.actor, reason: req.body?.reason, content_sha256: req.body?.content_sha256 });
    } catch (e) {
      const status = e.status ?? 500;
      return reply.code(status).send(err(status, e.code ?? 'INTERNAL', e.message, { guard: e.guard }));
    }
  });
  app.post('/content/scripts/:id/validate', { preHandler: requirePerm('script.write') }, async (req, reply) => {
    const result = await validateScript(req.params.id, { actor: req.actor });
    if (!result) return reply.code(404).send(err(404, 'NOT_FOUND', 'script'));
    return result;
  });
  app.post('/content/scripts/:id/localize', { preHandler: requirePerm('script.write') }, async (req, reply) => {
    const result = await localizeScript(req.params.id, { actor: req.actor });
    if (!result) return reply.code(404).send(err(404, 'NOT_FOUND', 'script'));
    return result;
  });

  // ----- reviews queue -----
  app.get('/reviews/queue', async (req) => {
    const r = await q(
      `SELECT rt.*, ro.slug AS required_role FROM lcos.review_tasks rt
       LEFT JOIN lcos.roles ro ON ro.id=rt.required_role_id
       WHERE rt.status IN ('OPEN','IN_PROGRESS') ORDER BY rt.due_at NULLS LAST LIMIT 100`);
    const mine = r.rows.filter(t => !t.required_role || req.actor.roles?.includes(t.required_role)
      || req.actor.roles?.includes('admin'));
    return { items: mine };
  });
  app.post('/reviews/:id/decide', async (req, reply) => {
    const task = await one(`SELECT * FROM lcos.review_tasks WHERE id=$1`, [req.params.id]);
    if (!task) return reply.code(404).send(err(404, 'NOT_FOUND', 'review task'));
    const decision = req.body?.decision;
    if (!['APPROVED','APPROVED_WITH_EDITS','CHANGES_REQUESTED','REJECTED','ESCALATED'].includes(decision)) {
      return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'bad decision'));
    }
    const permByType = { CLINICAL_SCRIPT: 'script.approve_clinical', CLINICAL_FINAL: 'production.approve_final',
      LANGUAGE: 'script.approve_language', EDITORIAL: 'script.approve_editorial',
      KNOWLEDGE_CARD: 'knowledge.approve' };
    const needed = permByType[task.review_type] ?? 'script.approve_editorial';
    if (!req.actor.permissions.includes(needed)) {
      return reply.code(403).send(err(403, 'FORBIDDEN', `requires ${needed}`));
    }
    return tx(async (client) => {
      await client.query(
        `UPDATE lcos.review_tasks SET status='COMPLETED', completed_at=now(), assigned_to=$2 WHERE id=$1`,
        [task.id, req.actor.id]);
      const table = task.review_type === 'LANGUAGE' ? 'language_reviews' : 'clinical_reviews';
      if (task.review_type === 'LANGUAGE') {
        await client.query(
          `INSERT INTO lcos.language_reviews (review_task_id, object_type, object_id, script_id,
             reviewer_user_id, language, decision, naturalness_score, register_correct,
             meaning_preserved, comment, content_sha256)
           VALUES ($1,$2,$3,$4,$5,'AM',$6,$7,$8,$9,$10,$11)`,
          [task.id, task.object_type, task.object_id,
           task.object_type === 'SCRIPT' ? task.object_id : null,
           req.actor.id, decision, req.body?.naturalness_score ?? null,
           req.body?.register_correct ?? true,
           decision.startsWith('APPROVED') ? true : (req.body?.meaning_preserved ?? false),
           req.body?.comment ?? null, task.content_sha256 ?? sha(String(task.object_id))]);
      } else {
        await client.query(
          `INSERT INTO lcos.clinical_reviews (review_task_id, object_type, object_id, script_id, render_id,
             reviewer_user_id, reviewer_role, decision, risk_tier_at_review, comment, content_sha256)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'TIER_2'),$10,$11)`,
          [task.id, task.object_type, task.object_id,
           task.object_type === 'SCRIPT' ? task.object_id : null,
           task.object_type === 'RENDER' ? task.object_id : null,
           req.actor.id, req.actor.roles?.[0] ?? 'unknown', decision,
           task.risk_tier, req.body?.comment ?? null, task.content_sha256 ?? sha(String(task.object_id))]);
      }
      await audit(client, { actor: req.actor, action: `review.${decision.toLowerCase()}`,
        objectType: task.object_type, objectId: task.object_id, reason: req.body?.comment });
      return { ok: true, review_task_id: task.id, decision, recorded_in: table };
    });
  });

  // ----- TURN INTO CONTENT -----
  app.post('/content/turn-into-content', { preHandler: requirePerm('question.turn_into_content') }, async (req, reply) => {
    const { question_id, languages = ['EN', 'AM'], concept_count = 2 } = req.body ?? {};
    if (!question_id) return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'question_id required'));
    try {
      const result = await turnIntoContent({ questionId: question_id, languages, conceptCount: concept_count,
        actor: req.actor });
      return reply.code(202).send(result);
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send(err(500, 'PIPELINE_ERROR', e.message));
    }
  });
}

// ============ pipeline ============

export async function turnIntoContent({ questionId, languages = ['EN', 'AM'], actor }) {
  const steps = [];
  const step = (name, status, extra = {}) => { steps.push({ step: name, status, ...extra }); };

  // 1. classification (run or reuse)
  let cls = await one(`SELECT * FROM lcos.question_classifications WHERE question_id=$1`, [questionId]);
  if (!cls) {
    const { classifyQuestion } = await import('./demand.mjs');
    await classifyQuestion(questionId);
    cls = await one(`SELECT * FROM lcos.question_classifications WHERE question_id=$1`, [questionId]);
  }
  if (!cls) throw new Error('question could not be classified');
  step('match_knowledge', cls.knowledge_card_id ? 'SUCCEEDED' : 'NO_KNOWLEDGE');

  // No approved knowledge: file the gap, notify clinical, stop cleanly.
  if (!cls.knowledge_card_id) {
    const question = await one(`SELECT sanitized_text FROM lcos.audience_questions WHERE id=$1`, [questionId]);
    const role = await one(`SELECT id FROM lcos.roles WHERE slug='medical_director'`);
    await q(`INSERT INTO lcos.review_tasks (review_type, object_type, object_id, required_role_id, sla_hours)
             VALUES ('KNOWLEDGE_CARD','KNOWLEDGE_CARD',$1,$2,72)`, [questionId, role.id]);
    return { pipeline_id: null, knowledge_card: null, steps,
      knowledge_gap: { question: question.sanitized_text,
        message: 'No approved medical knowledge answers this yet. The clinical team has been asked.' } };
  }

  const card = await one(
    `SELECT kc.*, t.code AS topic_code FROM lcos.knowledge_cards kc
     JOIN lcos.topics t ON t.id=kc.topic_id WHERE kc.id=$1`, [cls.knowledge_card_id]);
  if (card.status !== 'APPROVED') throw new Error(`knowledge card ${card.code} is not APPROVED`);
  const cardVersion = await one(`SELECT * FROM lcos.knowledge_card_versions WHERE id=$1`, [card.approved_version_id]);
  const claims = (await q(
    `SELECT mc.id, mc.code, mc.claim_text_en, mc.claim_type, mc.certainty, kcc.is_core
     FROM lcos.knowledge_card_claims kcc JOIN lcos.medical_claims mc ON mc.id=kcc.claim_id
     WHERE kcc.card_id=$1 AND mc.status='APPROVED'`, [card.id])).rows;
  const segment = await one(
    `SELECT * FROM lcos.audience_segments WHERE id=COALESCE($1, (SELECT id FROM lcos.audience_segments WHERE slug='general_public'))`,
    [cls.audience_segment_id]);

  // 2. family + risk tier
  const riskTier = computeRiskTier({
    cardTiers: [card.risk_tier], claimTypes: claims.map(c => c.claim_type),
    topicCodes: [card.topic_code] });
  const family = await one(
    `INSERT INTO lcos.content_families (code, title, knowledge_card_id, knowledge_card_version_id,
       primary_segment_id, risk_tier, origin, origin_question_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,'TURN_INTO_CONTENT',$7,$8) RETURNING *`,
    [code('CF'), `TIC: ${card.canonical_question_en.slice(0, 80)}`, card.id, card.approved_version_id,
     segment.id, riskTier, questionId, actor?.id ?? null]);
  step('create_family', 'SUCCEEDED', { family_code: family.code, risk_tier: riskTier });

  // 3. concepts
  const question = await one(`SELECT sanitized_text FROM lcos.audience_questions WHERE id=$1`, [questionId]);
  const conceptsOut = await invokeAgent('creative_director', {
    card: { code: card.code, canonical_question_en: card.canonical_question_en,
      canonical_answer_en: cardVersion.canonical_answer_en,
      prohibited_claims: cardVersion.prohibited_claims, approved_ctas: cardVersion.approved_ctas },
    claims: claims.map(c => ({ id: c.id, code: c.code, claim_text_en: c.claim_text_en, certainty: c.certainty })),
    audience: { slug: segment.slug, tone_guidance: segment.tone_guidance, terms_to_avoid: segment.terms_to_avoid },
    representative_question: question.sanitized_text,
  }, { objectType: 'CONTENT_FAMILY', objectId: family.id, workflowCode: 'WF06' });

  const validClaimIds = new Set(claims.map(c => c.id));
  const conceptRows = [];
  for (const c of conceptsOut.concepts) {
    // Drop hallucinated claim references outright; log the event.
    const badRefs = c.claim_ids_referenced.filter(id => !validClaimIds.has(id));
    if (badRefs.length) {
      await audit(null, { actor: { type: 'AGENT', label: 'creative_director' },
        action: 'concept.hallucinated_claim_ref', objectType: 'CONTENT_FAMILY', objectId: family.id,
        reason: `dropped concept "${c.title}": unknown claim ids` });
      continue;
    }
    const row = await one(
      `INSERT INTO lcos.content_concepts (code, family_id, video_family, title, hook_line, premise,
         treatment, perspective, characters, target_duration_s, claim_ids_referenced, cta_intent,
         why_this_works, status)
       VALUES ($1,$2,$3::lcos.video_family,$4,$5,$6,$7,$8,$9,$10,$11::uuid[],$12,$13,'SELECTED') RETURNING *`,
      [code('CC'), family.id, c.video_family, c.title, c.hook_line, c.premise, c.treatment,
       c.perspective ?? null, JSON.stringify(c.characters ?? []), c.target_duration_s,
       c.claim_ids_referenced, c.cta_intent, c.why_this_works]);
    conceptRows.push(row);
  }
  step('generate_concepts', 'SUCCEEDED', { count: conceptRows.length });

  // 4-7. per concept: script -> validate -> localize -> reviews
  const scripts = [];
  for (const concept of conceptRows.slice(0, 2)) {
    const s = await generateScript({ concept, family, card, cardVersion, claims, actor });
    if (s.status === 'NEEDS_KNOWLEDGE') { step('generate_script', 'NEEDS_KNOWLEDGE', { script: s.code }); continue; }
    const v = await validateScript(s.id, { actor });
    step('validate_claims', v.overall_result, { script: s.code, findings: v.findings.length });
    if (v.overall_result !== 'PASS') { scripts.push({ script_id: s.id, code: s.code, status: 'VALIDATION_FAILED' }); continue; }
    if (languages.includes('AM')) {
      const loc = await localizeScript(s.id, { actor });
      step('localize_amharic', loc.result, { script: s.code, drift: loc.drift_score });
    }
    await routeReviews(s.id, family.risk_tier);
    const fresh = await one(`SELECT id, code, status, risk_tier FROM lcos.scripts WHERE id=$1`, [s.id]);
    scripts.push(fresh);
  }
  step('queue_review', 'SUCCEEDED');

  return { pipeline_id: family.id, family_id: family.id, family_code: family.code,
    knowledge_card: { id: card.id, code: card.code, status: card.status,
      match_confidence: Number(cls.match_confidence) },
    risk_tier: family.risk_tier, concepts: conceptRows.map(c => ({ id: c.id, code: c.code, title: c.title })),
    scripts, steps };
}

export async function generateScript({ concept, family, card, cardVersion, claims, actor, seedUnsupported = false }) {
  const out = await invokeAgent('script_writer', {
    hook_line: concept.hook_line, video_family: concept.video_family,
    treatment: concept.treatment,
    card: { code: card.code, approved_ctas: cardVersion.approved_ctas,
      prohibited_claims: cardVersion.prohibited_claims },
    claims: claims.map(c => ({ id: c.id, code: c.code, claim_text_en: c.claim_text_en, certainty: c.certainty })),
    __seed_unsupported: seedUnsupported || undefined,
  }, { objectType: 'CONCEPT', objectId: concept.id, workflowCode: 'WF07' });

  if (out.result === 'NEEDS_KNOWLEDGE') {
    const s = await one(
      `INSERT INTO lcos.scripts (code, concept_id, family_id, knowledge_card_version_id, language,
         status, risk_tier, needs_knowledge_note, created_by)
       VALUES ($1,$2,$3,$4,'EN','NEEDS_KNOWLEDGE',$5,$6,$7) RETURNING *`,
      [code('SCR'), concept.id, family.id, family.knowledge_card_version_id, family.risk_tier,
       JSON.stringify(out.needs_knowledge), actor?.id ?? null]);
    return s;
  }
  const sc = out.script;
  const bodyHash = sha(sc.spoken_script + sc.hook + sc.cta);
  const s = await one(
    `INSERT INTO lcos.scripts (code, concept_id, family_id, knowledge_card_version_id, language,
       status, risk_tier, current_version, validation_result, content_sha256, created_by)
     VALUES ($1,$2,$3,$4,'EN','DRAFT',$5,1,'NOT_RUN',$6,$7) RETURNING *`,
    [code('SCR'), concept.id, family.id, family.knowledge_card_version_id, family.risk_tier,
     bodyHash, actor?.id ?? null]);
  await q(
    `INSERT INTO lcos.script_versions (script_id, version, hook, spoken_script, onscreen_text,
       scene_plan, cta, caption, hashtags, platform_variants, estimated_duration_s, content_sha256, created_by)
     VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [s.id, sc.hook, sc.spoken_script, JSON.stringify(sc.onscreen_text), JSON.stringify(sc.scene_plan),
     sc.cta, sc.caption ?? null, sc.hashtags ?? [], JSON.stringify(sc.platform_variants ?? {}),
     sc.estimated_duration_s, bodyHash, actor?.id ?? null]);
  for (const m of sc.claim_map) {
    await q(`INSERT INTO lcos.script_claims (script_id, script_version, claim_id, statement, location)
             VALUES ($1,1,$2,$3,$4)`, [s.id, m.claim_id, m.statement, m.location]);
  }
  return s;
}

export async function validateScript(scriptId, { actor }) {
  const s = await one(`SELECT * FROM lcos.scripts WHERE id=$1`, [scriptId]);
  if (!s) return null;
  const v = await one(`SELECT * FROM lcos.script_versions WHERE script_id=$1 AND version=$2`,
    [s.id, s.current_version]);
  const claimMap = (await q(
    `SELECT sc.id, sc.statement, sc.location, sc.claim_id FROM lcos.script_claims sc
     WHERE sc.script_id=$1 AND sc.script_version=$2`, [s.id, s.current_version])).rows;
  const family = await one(`SELECT * FROM lcos.content_families WHERE id=$1`, [s.family_id]);
  const cardVersion = await one(`SELECT * FROM lcos.knowledge_card_versions WHERE id=$1`,
    [family.knowledge_card_version_id]);
  const claims = (await q(
    `SELECT mc.id, mc.code, mc.claim_text_en, mc.certainty FROM lcos.knowledge_card_claims kcc
     JOIN lcos.medical_claims mc ON mc.id=kcc.claim_id
     WHERE kcc.card_id=$1 AND mc.status='APPROVED'`, [family.knowledge_card_id])).rows;

  await q(`UPDATE lcos.scripts SET status='VALIDATING' WHERE id=$1 AND status IN ('DRAFT','VALIDATION_FAILED')`, [s.id]);

  // Model validator. Its failure is treated as FAIL: there is no skip path.
  let agentOut;
  try {
    agentOut = await invokeAgent('claim_validator', {
      script_text: `${v.hook} ${v.spoken_script} ${v.cta}`,
      claim_map: claimMap.map(m => ({ statement: m.statement, claim_id: m.claim_id, location: m.location })),
      claims, prohibited_claims: cardVersion.prohibited_claims,
      risk_tier: s.risk_tier,
    }, { objectType: 'SCRIPT', objectId: s.id, workflowCode: 'WF08' });
  } catch (e) {
    agentOut = { overall_result: 'FAIL',
      statements: claimMap.map(m => ({ statement: m.statement, location: m.location,
        verdict: 'AMBIGUOUS', reason: 'validator unavailable', supporting_claim_ids: [] })),
      findings: [{ code: 'VALIDATOR_UNAVAILABLE', severity: 'BLOCKER',
        explanation: `Claim validator unavailable: ${e.message}. Validation fails closed.` }],
      summary: 'validator unavailable' };
  }

  // Deterministic overlay: can only ADD findings.
  const overlay = validatorOverlay({
    scriptText: `${v.hook} ${v.spoken_script} ${v.cta}`,
    claims, card: cardVersion, riskTier: s.risk_tier, cta: v.cta });
  const findings = [...agentOut.findings, ...overlay];
  const result = overallResult(agentOut.statements, findings);

  for (const st of agentOut.statements) {
    await q(`UPDATE lcos.script_claims SET verdict=$3::lcos.validation_verdict, verdict_reason=$4, validated_at=now()
             WHERE script_id=$1 AND script_version=$2 AND statement=$5`,
      [s.id, s.current_version, st.verdict, st.reason, st.statement]);
  }
  for (const f of findings) {
    await q(`INSERT INTO lcos.script_findings (script_id, script_version, code, severity, statement, explanation, suggested_fix)
             VALUES ($1,$2,$3::lcos.finding_code,$4::lcos.finding_severity,$5,$6,$7)`,
      [s.id, s.current_version, f.code, f.severity, f.statement ?? null, f.explanation, f.suggested_fix ?? null]);
  }
  await q(`UPDATE lcos.scripts SET validation_result=$2, validation_run_at=now(),
             status = CASE WHEN $2='PASS' THEN 'VALIDATED' ELSE 'VALIDATION_FAILED' END::lcos.script_status
           WHERE id=$1`, [s.id, result]);
  await audit(null, { actor: actor ?? { type: 'AGENT', label: 'claim_validator' },
    action: 'script.validated', objectType: 'SCRIPT', objectId: s.id, objectCode: s.code,
    toState: result, reason: `${findings.length} findings` });
  return { script_id: s.id, overall_result: result, statements: agentOut.statements, findings };
}

export async function localizeScript(scriptId, { actor }) {
  const s = await one(`SELECT * FROM lcos.scripts WHERE id=$1`, [scriptId]);
  if (!s) return null;
  const v = await one(`SELECT * FROM lcos.script_versions WHERE script_id=$1 AND version=$2`,
    [s.id, s.current_version]);
  const family = await one(`SELECT * FROM lcos.content_families WHERE id=$1`, [s.family_id]);
  const cardVersion = await one(`SELECT * FROM lcos.knowledge_card_versions WHERE id=$1`,
    [family.knowledge_card_version_id]);
  const terminology = (await q(
    `SELECT term_en, preferred_am, avoid_am FROM lcos.terminology WHERE status='APPROVED' LIMIT 200`)).rows;

  const loc = await invokeAgent('amharic_localizer', {
    english: { hook: v.hook, spoken_script: v.spoken_script, cta: v.cta, caption: v.caption },
    canonical_answer_am: cardVersion.canonical_answer_am,
    terminology, register: 'GENERAL',
  }, { objectType: 'SCRIPT', objectId: s.id, workflowCode: 'WF09' });

  if (loc.result === 'HUMAN_LANGUAGE_REVIEW') {
    await routeLanguageReview(s.id, null);
    return { result: 'HUMAN_LANGUAGE_REVIEW', reason: loc.escalation_reason };
  }

  // Blind back-translation: separate agent, does not receive the English.
  const back = await invokeAgent('back_translator', { amharic_text: loc.spoken_amharic },
    { objectType: 'SCRIPT', objectId: s.id, workflowCode: 'WF09' });
  const [srcVec, backVec] = await Promise.all([embed(v.spoken_script), embed(back.english)]);
  const drift = 1 - cosine(srcVec, backVec);

  const qa = await invokeAgent('language_qa', {
    amharic: loc.spoken_amharic, english_source: v.spoken_script,
    back_translation: back.english, terminology,
  }, { objectType: 'SCRIPT', objectId: s.id, workflowCode: 'WF10' });

  const trans = await one(
    `INSERT INTO lcos.translations (object_type, object_id, language, translated_text, back_translation,
       drift_score, terminology_used, uncertainties, status, produced_by_agent, content_sha256)
     VALUES ('SCRIPT',$1,'AM',$2,$3,$4,$5,$6,'IN_REVIEW','amharic_localizer',$7)
     ON CONFLICT (object_type, object_id, language)
     DO UPDATE SET translated_text=EXCLUDED.translated_text, back_translation=EXCLUDED.back_translation,
       drift_score=EXCLUDED.drift_score, status='IN_REVIEW' RETURNING id`,
    [s.id, loc.spoken_amharic, back.english, Math.round(drift * 1000) / 1000,
     JSON.stringify(loc.terminology_used), JSON.stringify(loc.uncertainties), sha(loc.spoken_amharic)]);

  const driftThreshold = Number(await setting('translation.drift_threshold', 0.12));
  const needsHuman = drift > driftThreshold || qa.verdict !== 'PASS' || qa.naturalness_score < 4
    || true; // pilot rule: every Amharic script sees the language editor
  if (needsHuman) await routeLanguageReview(s.id, trans.id);
  return { result: 'OK', translation_id: trans.id, drift_score: Math.round(drift * 1000) / 1000,
    qa_verdict: qa.verdict, naturalness: qa.naturalness_score, routed_to_human: needsHuman };
}

async function routeLanguageReview(scriptId, translationId) {
  const role = await one(`SELECT id FROM lcos.roles WHERE slug='language_editor'`);
  await q(`INSERT INTO lcos.review_tasks (review_type, object_type, object_id, required_role_id, sla_hours)
           VALUES ('LANGUAGE','SCRIPT',$1,$2,48)`, [scriptId, role.id]);
}

export async function routeReviews(scriptId, riskTier) {
  const s = await one(`SELECT * FROM lcos.scripts WHERE id=$1`, [scriptId]);
  if (['TIER_3', 'TIER_4'].includes(riskTier)) {
    const slug = riskTier === 'TIER_4' ? 'medical_director' : 'consulting_doctor';
    const role = await one(`SELECT id FROM lcos.roles WHERE slug=$1`, [slug]);
    const sla = (await setting('review.sla_hours', {}))[riskTier] ?? 24;
    await q(`INSERT INTO lcos.review_tasks (review_type, object_type, object_id, object_version,
               content_sha256, risk_tier, required_role_id, sla_hours, due_at)
             VALUES ('CLINICAL_SCRIPT','SCRIPT',$1,$2,$3,$4,$5,$6::int, now() + make_interval(hours => $6::int))`,
      [scriptId, s.current_version, s.content_sha256, riskTier, role.id, sla]);
    await q(`UPDATE lcos.scripts SET status='CLINICAL_REVIEW'
             WHERE id=$1 AND status IN ('VALIDATED','LANGUAGE_REVIEW')`, [scriptId]);
  }
  return true;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
