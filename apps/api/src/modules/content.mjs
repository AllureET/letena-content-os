// Content module: families, concepts, scripts, claim validation, Amharic
// localization, language QA, and the Turn Into Content pipeline.
import crypto from 'node:crypto';
import { q, one, tx, audit, requirePerm, err, transition, setting } from '../core.mjs';
import { invokeAgent, embed } from '../ai/gateway.mjs';
import { lintStyle } from '../ai/style_lint.mjs';
import { validatorOverlay, overallResult, computeRiskTier } from '../../../../packages/scoring/src/index.mjs';
import { formatOf, bodyTextOf } from '../formats.mjs';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const code = (p) => `${p}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

export default async function routes(app) {
  // Named tone/voice presets (lcos.tone_presets, migration 0009). The default
  // is the content.tone_preset setting (Settings screen); this list is what a
  // per-request tone_preset override on /content/turn-into-content picks from.
  app.get('/content/tone-presets', { preHandler: requirePerm('concept.read') }, async () => {
    const r = await q(
      `SELECT key, label, description FROM lcos.tone_presets WHERE is_active ORDER BY key`);
    const current = String(await setting('content.tone_preset', 'LETENA_DEFAULT'));
    return { items: r.rows, default: current };
  });

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
  // Manual re-validation from the review screen. Found live 14 Aug 2026: a
  // script that FAILs on its first pass (through the Turn Into Content
  // pipeline, processGeneratedScript) never reaches routeReviews() -- that
  // function only runs once, right after a first-time PASS, inside the
  // generation pipeline itself. So a script fixed and re-validated by hand
  // here would sit at status=VALIDATED forever with no review task and no
  // way for a human to ever see it (SCR-35ACBC7C, the claim_validator
  // precision fix). Mirror the pipeline's own behavior: the first time a
  // script reaches PASS with no review_tasks row yet at all (regardless of
  // how many failed attempts came before), route it, exactly like a
  // freshly-generated script that passed immediately would be. Guarded on
  // "no review_tasks row ever" rather than on script status, so this never
  // fires twice for the same script and never re-routes one already in or
  // past review.
  app.post('/content/scripts/:id/validate', { preHandler: requirePerm('script.write') }, async (req, reply) => {
    const result = await validateScript(req.params.id, { actor: req.actor });
    if (!result) return reply.code(404).send(err(404, 'NOT_FOUND', 'script'));
    if (result.overall_result === 'PASS') {
      const alreadyRouted = await one(
        `SELECT id FROM lcos.review_tasks WHERE object_type='SCRIPT' AND object_id=$1 LIMIT 1`,
        [req.params.id]);
      if (!alreadyRouted) {
        const s = await one(`SELECT risk_tier FROM lcos.scripts WHERE id=$1`, [req.params.id]);
        await routeReviews(req.params.id, s.risk_tier);
      }
    }
    return result;
  });
  app.post('/content/scripts/:id/localize', { preHandler: requirePerm('script.write') }, async (req, reply) => {
    const result = await localizeScript(req.params.id, { actor: req.actor, tonePreset: req.body?.tone_preset ?? null });
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
  // One-click batch approval (owner decision, Aug 2026: the per-piece
  // multi-role chain is collapsed; doctors approve FACTS on knowledge cards,
  // and generated pieces that passed claim validation approve in one click).
  // The author-is-not-reviewer rule is deliberately not enforced here; the
  // audit log records who clicked. Tier 4 scripts still require the clinical
  // permission, and nothing that failed claim validation can pass.
  app.post('/reviews/batch-approve', async (req, reply) => {
    const wanted = Array.isArray(req.body?.script_ids) ? req.body.script_ids : null;
    const scripts = (await q(
      `SELECT * FROM lcos.scripts
       WHERE status IN ('VALIDATED','LANGUAGE_REVIEW','CLINICAL_REVIEW')
         AND validation_result='PASS'
         AND ($1::uuid[] IS NULL OR id = ANY($1::uuid[]))
       ORDER BY created_at LIMIT 200`, [wanted])).rows;
    let approved = 0, skipped = [];
    for (const s of scripts) {
      const needed = ['TIER_3', 'TIER_4'].includes(s.risk_tier)
        ? 'script.approve_clinical' : 'script.approve_editorial';
      if (!req.actor.permissions.includes(needed)) { skipped.push({ id: s.id, reason: needed }); continue; }
      await tx(async (client) => {
        await client.query(
          `UPDATE lcos.review_tasks SET status='COMPLETED', completed_at=now(), assigned_to=$2
           WHERE object_type='SCRIPT' AND object_id=$1 AND status IN ('OPEN','IN_PROGRESS')`,
          [s.id, req.actor.id]);
        await client.query(
          `INSERT INTO lcos.clinical_reviews (object_type, object_id, script_id, reviewer_user_id,
             reviewer_role, decision, risk_tier_at_review, comment, content_sha256)
           VALUES ('SCRIPT',$1,$1,$2,$3,'APPROVED',$4,'batch approval',$5)`,
          [s.id, req.actor.id, req.actor.roles?.[0] ?? 'unknown', s.risk_tier,
           s.content_sha256 ?? sha(String(s.id))]);
        await client.query(
          `UPDATE lcos.scripts SET status='APPROVED', approved_by=$2, approved_at=now(),
             approved_version=current_version WHERE id=$1`, [s.id, req.actor.id]);
        await audit(client, { actor: req.actor, action: 'script.batch_approved',
          objectType: 'SCRIPT', objectId: s.id, objectCode: s.code });
      });
      approved++;
    }
    // Renders that succeeded but lack their final look also clear here.
    let rendersApproved = 0;
    if (req.actor.permissions.includes('production.approve_final')) {
      const renders = (await q(
        `SELECT r.*, s.risk_tier FROM lcos.renders r JOIN lcos.scripts s ON s.id=r.script_id
         WHERE r.status='SUCCEEDED' AND NOT EXISTS (
           SELECT 1 FROM lcos.clinical_reviews cr WHERE cr.render_id=r.id
             AND cr.decision IN ('APPROVED','APPROVED_WITH_EDITS'))
         LIMIT 200`)).rows;
      for (const r of renders) {
        if (r.risk_tier === 'TIER_4'
            && !req.actor.roles?.some(x => ['medical_director', 'admin'].includes(x))) continue;
        await q(
          `INSERT INTO lcos.clinical_reviews (object_type, object_id, render_id, script_id,
             reviewer_user_id, reviewer_role, decision, risk_tier_at_review, comment, content_sha256)
           VALUES ('RENDER',$1,$1,$2,$3,$4,'APPROVED',$5,'batch approval',$6)`,
          [r.id, r.script_id, req.actor.id, req.actor.roles?.[0] ?? 'unknown', r.risk_tier,
           sha(r.storage_key ?? String(r.id))]);
        rendersApproved++;
      }
    }
    await audit(null, { actor: req.actor, action: 'review.batch_approve', objectType: 'SCRIPT',
      reason: `${approved} scripts, ${rendersApproved} renders, ${skipped.length} skipped` });
    return { approved, renders_approved: rendersApproved, skipped };
  });

  // tone_preset is optional: a per-request override of the content.tone_preset
  // setting (see GET /content/tone-presets for the selectable list). Both
  // generation entry points accept it and pass it straight through to
  // invokeAgent() -- turn-into-content here, and the output_types-based
  // POST /content/generate below.
  app.post('/content/turn-into-content', { preHandler: requirePerm('question.turn_into_content') }, async (req, reply) => {
    const { question_id, languages = ['EN', 'AM'], concept_count = 2, tone_preset = null } = req.body ?? {};
    if (!question_id) return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'question_id required'));
    try {
      const result = await turnIntoContent({ questionId: question_id, languages, conceptCount: concept_count,
        actor: req.actor, tonePreset: tone_preset });
      return reply.code(202).send(result);
    } catch (e) {
      const status = e.status ?? 500;
      if (status >= 500) req.log.error(e);
      return reply.code(status).send(err(status, e.code ?? 'PIPELINE_ERROR', e.message, e.guard ? { guard: e.guard } : {}));
    }
  });

  // ----- flexible generation scope -----
  // Owner ask (Nate, Aug 2026): "it's currently set to 4 diff outputs. How
  // about if I just want to output 1 kind in 1 specific topic." This is the
  // scoped alternative to turn-into-content: pick a knowledge card (the
  // topic) and exactly which output_types to generate (a data-driven list,
  // see content_output_types), or point at one existing concept to
  // (re)generate just its script. Same claim-validation and card-approval
  // rules as turn-into-content, including the admin test-mode override.
  app.get('/content/output-types', { preHandler: requirePerm('concept.read') }, async () => {
    const r = await q(
      `SELECT code, label, platform, video_family, description, sort_order
       FROM lcos.content_output_types WHERE is_active ORDER BY sort_order`);
    return { items: r.rows };
  });
  app.post('/content/generate', { preHandler: requirePerm('question.turn_into_content') }, async (req, reply) => {
    const { card_id, concept_id, output_types, question_id, languages = ['EN', 'AM'], tone_preset = null } = req.body ?? {};
    if (!card_id && !concept_id) {
      return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'card_id (topic) or concept_id is required'));
    }
    try {
      const result = await generateContent({ cardId: card_id, conceptId: concept_id,
        outputTypes: output_types, questionId: question_id, languages, actor: req.actor, tonePreset: tone_preset });
      return reply.code(202).send(result);
    } catch (e) {
      const status = e.status ?? 500;
      if (status >= 500) req.log.error(e);
      return reply.code(status).send(err(status, e.code ?? 'PIPELINE_ERROR', e.message, e.guard ? { guard: e.guard } : {}));
    }
  });

  // Bulk commission from real demand, unapproved cards included -- see
  // bulkCommission() above for the owner decision this implements. Gated on
  // the same capability as the other generation entry points; bulkCommission
  // itself enforces admin + ADMIN_TEST_MODE before it will touch a card
  // nobody has approved.
  app.post('/content/bulk-commission', { preHandler: requirePerm('question.turn_into_content') }, async (req, reply) => {
    const { limit = 10, output_types = null } = req.body ?? {};
    try {
      const result = await bulkCommission({ limit, outputTypes: output_types, actor: req.actor });
      return reply.code(202).send(result);
    } catch (e) {
      const status = e.status ?? 500;
      if (status >= 500) req.log.error(e);
      return reply.code(status).send(err(status, e.code ?? 'PIPELINE_ERROR', e.message, e.guard ? { guard: e.guard } : {}));
    }
  });
}

// ============ card resolution (approval gate + admin test-mode override) ============

// Owner ask (Nate, Aug 2026): "I want to be able to test the system out and
// build some test content without waiting for dr approval... place override
// options in settings for me as admin." The normal rule is unchanged: only
// an APPROVED card's APPROVED claims feed generation. approval.override=
// ADMIN_TEST_MODE (settings, admin-role-only to flip, see PUT
// /platform/settings) opens a second door, ADMIN-role-only to walk through:
// generate from a card that is still DRAFT/IN_REVIEW, using its latest
// (unapproved) version and whatever claims are attached regardless of their
// own status. Every row produced this way carries is_test_content=true and
// every use of the override is audit-logged with the card and claim ids.
// This never touches the publish-time re-check in distribution.mjs
// (executePublish requires card.status='APPROVED'), so test content can be
// generated and even rendered, but can never actually go out to the public
// while its card is unapproved.
export async function resolveCardForGeneration(cardIdOrCode, actor) {
  const card = await one(
    `SELECT kc.*, t.code AS topic_code FROM lcos.knowledge_cards kc
     JOIN lcos.topics t ON t.id=kc.topic_id
     WHERE kc.id::text=$1 OR kc.code=$1`, [String(cardIdOrCode)]);
  if (!card) {
    const e = new Error('knowledge card not found'); e.status = 404; e.code = 'NOT_FOUND'; throw e;
  }
  if (card.status === 'APPROVED') {
    const cardVersion = await one(`SELECT * FROM lcos.knowledge_card_versions WHERE id=$1`, [card.approved_version_id]);
    const claims = (await q(
      `SELECT mc.id, mc.code, mc.claim_text_en, mc.claim_type, mc.certainty, kcc.is_core
       FROM lcos.knowledge_card_claims kcc JOIN lcos.medical_claims mc ON mc.id=kcc.claim_id
       WHERE kcc.card_id=$1 AND mc.status='APPROVED'`, [card.id])).rows;
    return { card, cardVersion, claims, isTestContent: false, overrideUsed: false };
  }

  // Not approved: the only door in is the admin test-mode override.
  const override = String(await setting('approval.override', 'OFF'));
  if (override !== 'ADMIN_TEST_MODE') {
    const e = new Error(`knowledge card ${card.code} is not APPROVED`);
    e.status = 422; e.code = 'GUARD_FAILED'; e.guard = 'cardIsApproved'; throw e;
  }
  if (!actor?.roles?.includes('admin')) {
    const e = new Error('approval.override is ADMIN_TEST_MODE, which only an admin may use to generate from a not-yet-approved card.');
    e.status = 403; e.code = 'FORBIDDEN'; e.guard = 'adminOnlyOverride'; throw e;
  }
  const versionId = card.current_version_id ?? card.approved_version_id;
  if (!versionId) {
    const e = new Error(`knowledge card ${card.code} has no card body yet; write a version first`);
    e.status = 422; e.code = 'GUARD_FAILED'; e.guard = 'hasVersion'; throw e;
  }
  const cardVersion = await one(`SELECT * FROM lcos.knowledge_card_versions WHERE id=$1`, [versionId]);
  const claims = (await q(
    `SELECT mc.id, mc.code, mc.claim_text_en, mc.claim_type, mc.certainty, kcc.is_core
     FROM lcos.knowledge_card_claims kcc JOIN lcos.medical_claims mc ON mc.id=kcc.claim_id
     WHERE kcc.card_id=$1 AND mc.status <> 'RETIRED'`, [card.id])).rows;
  await audit(null, { actor, action: 'content.admin_test_override_used', objectType: 'KNOWLEDGE_CARD',
    objectId: card.id, objectCode: card.code,
    reason: `ADMIN_TEST_MODE generation from ${card.status} card; claims=[${claims.map(c => c.code).join(', ')}]` });
  return { card, cardVersion, claims, isTestContent: true, overrideUsed: true };
}

// ============ pipeline ============

export async function turnIntoContent({ questionId, languages = ['EN', 'AM'], actor, tonePreset = null }) {
  const steps = [];
  const step = (name, status, extra = {}) => { steps.push({ step: name, status, ...extra }); };
  const effectiveTone = tonePreset || String(await setting('content.tone_preset', 'LETENA_DEFAULT'));

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

  const { card, cardVersion, claims, isTestContent } = await resolveCardForGeneration(cls.knowledge_card_id, actor);
  const segment = await one(
    `SELECT * FROM lcos.audience_segments WHERE id=COALESCE($1, (SELECT id FROM lcos.audience_segments WHERE slug='general_public'))`,
    [cls.audience_segment_id]);

  // 2. family + risk tier
  const riskTier = computeRiskTier({
    cardTiers: [card.risk_tier], claimTypes: claims.map(c => c.claim_type),
    topicCodes: [card.topic_code] });
  const family = await one(
    `INSERT INTO lcos.content_families (code, title, knowledge_card_id, knowledge_card_version_id,
       primary_segment_id, risk_tier, origin, origin_question_id, created_by, is_test_content)
     VALUES ($1,$2,$3,$4,$5,$6,'TURN_INTO_CONTENT',$7,$8,$9) RETURNING *`,
    [code('CF'), `TIC: ${card.canonical_question_en.slice(0, 80)}`, card.id, cardVersion.id,
     segment.id, riskTier, questionId, actor?.id ?? null, isTestContent]);
  step('create_family', 'SUCCEEDED', { family_code: family.code, risk_tier: riskTier, is_test_content: isTestContent });

  // 3. concepts
  const question = await one(`SELECT sanitized_text FROM lcos.audience_questions WHERE id=$1`, [questionId]);
  const conceptsOut = await invokeAgent('creative_director', {
    card: { code: card.code, canonical_question_en: card.canonical_question_en,
      canonical_answer_en: cardVersion.canonical_answer_en,
      prohibited_claims: cardVersion.prohibited_claims, approved_ctas: cardVersion.approved_ctas },
    claims: claims.map(c => ({ id: c.id, code: c.code, claim_text_en: c.claim_text_en, certainty: c.certainty })),
    audience: { slug: segment.slug, tone_guidance: segment.tone_guidance, terms_to_avoid: segment.terms_to_avoid },
    representative_question: question.sanitized_text,
  }, { objectType: 'CONTENT_FAMILY', objectId: family.id, workflowCode: 'WF06', tone_preset: effectiveTone });

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
    const s = await generateScript({ concept, family, card, cardVersion, claims, actor,
      isTestContent, tonePreset: effectiveTone });
    scripts.push(await processGeneratedScript(s, family, languages, actor, step, effectiveTone));
  }
  step('queue_review', 'SUCCEEDED');

  return { pipeline_id: family.id, family_id: family.id, family_code: family.code,
    knowledge_card: { id: card.id, code: card.code, status: card.status,
      match_confidence: Number(cls.match_confidence) },
    is_test_content: isTestContent, tone_preset: effectiveTone,
    risk_tier: family.risk_tier, concepts: conceptRows.map(c => ({ id: c.id, code: c.code, title: c.title })),
    scripts, steps };
}

// Shared per-script tail of both generation pipelines: validate -> localize
// (if Amharic requested, carrying the same tone preset used for generation)
// -> route to auto-approval or the review queue.
async function processGeneratedScript(s, family, languages, actor, step, tonePreset = null) {
  if (s.status === 'NEEDS_KNOWLEDGE') {
    step('generate_script', 'NEEDS_KNOWLEDGE', { script: s.code });
    return { script_id: s.id, code: s.code, status: 'NEEDS_KNOWLEDGE' };
  }
  const v = await validateScript(s.id, { actor });
  step('validate_claims', v.overall_result, { script: s.code, findings: v.findings.length });
  if (v.overall_result !== 'PASS') return { script_id: s.id, code: s.code, status: 'VALIDATION_FAILED' };
  if (languages.includes('AM')) {
    const loc = await localizeScript(s.id, { actor, tonePreset });
    step('localize_amharic', loc.result, { script: s.code, drift: loc.drift_score });
  }
  await routeReviews(s.id, family.risk_tier);
  return one(
    `SELECT s.id, s.code, s.status, s.risk_tier, sv.tone_preset, sv.style_warnings
     FROM lcos.scripts s
     JOIN lcos.script_versions sv ON sv.script_id=s.id AND sv.version=s.current_version
     WHERE s.id=$1`, [s.id]);
}

// ============ flexible generation scope (POST /content/generate) ============

// Owner ask (Nate, Aug 2026): "How about if I just want to output 1 kind in
// 1 specific topic. And how about if I want a diff output." Two entry
// points: concept_id re-runs script generation for exactly that one
// existing concept; card_id + output_types builds exactly the requested
// output kinds (from content_output_types, a data table, not a hardcoded
// array) for that one knowledge card, skipping the free-form creative
// director step entirely so the caller gets exactly what they asked for.
// tonePreset is optional on both paths, the same per-request override as
// turn-into-content: falls back to the content.tone_preset setting.
export async function generateContent({ cardId, conceptId, outputTypes, questionId, languages = ['EN', 'AM'],
    actor, tonePreset = null }) {
  const steps = [];
  const step = (name, status, extra = {}) => { steps.push({ step: name, status, ...extra }); };
  const effectiveTone = tonePreset || String(await setting('content.tone_preset', 'LETENA_DEFAULT'));

  if (conceptId) {
    const concept = await one(`SELECT * FROM lcos.content_concepts WHERE id=$1`, [conceptId]);
    if (!concept) { const e = new Error('concept not found'); e.status = 404; e.code = 'NOT_FOUND'; throw e; }
    const family = await one(`SELECT * FROM lcos.content_families WHERE id=$1`, [concept.family_id]);
    const { card, cardVersion, claims, isTestContent } = await resolveCardForGeneration(family.knowledge_card_id, actor);
    step('resolve_card', 'SUCCEEDED', { card_code: card.code, is_test_content: isTestContent });

    const s = await generateScript({ concept, family, card, cardVersion, claims, actor,
      isTestContent, tonePreset: effectiveTone });
    const scriptResult = await processGeneratedScript(s, family, languages, actor, step, effectiveTone);
    return { pipeline_id: family.id, family_id: family.id, family_code: family.code,
      knowledge_card: { id: card.id, code: card.code, status: card.status },
      is_test_content: isTestContent, tone_preset: effectiveTone, risk_tier: family.risk_tier,
      concepts: [{ id: concept.id, code: concept.code, title: concept.title, video_family: concept.video_family }],
      scripts: [scriptResult], steps };
  }

  if (!Array.isArray(outputTypes) || !outputTypes.length) {
    const e = new Error('output_types must be a non-empty array of content_output_types codes');
    e.status = 422; e.code = 'VALIDATION_ERROR'; throw e;
  }
  if (questionId) {
    const question = await one(`SELECT id FROM lcos.audience_questions WHERE id=$1`, [questionId]);
    if (!question) { const e = new Error('question_id not found'); e.status = 404; e.code = 'NOT_FOUND'; throw e; }
  }
  const { card, cardVersion, claims, isTestContent } = await resolveCardForGeneration(cardId, actor);
  step('resolve_card', 'SUCCEEDED', { card_code: card.code, is_test_content: isTestContent });

  const types = (await q(
    `SELECT * FROM lcos.content_output_types WHERE code = ANY($1::text[]) AND is_active ORDER BY sort_order`,
    [outputTypes])).rows;
  const foundCodes = new Set(types.map(t => t.code));
  const missing = outputTypes.filter(c => !foundCodes.has(c));
  if (missing.length) {
    const e = new Error(`unknown or inactive output_types: ${missing.join(', ')}`);
    e.status = 422; e.code = 'VALIDATION_ERROR'; throw e;
  }

  const segment = await one(`SELECT * FROM lcos.audience_segments WHERE slug='general_public'`);
  const riskTier = computeRiskTier({ cardTiers: [card.risk_tier],
    claimTypes: claims.map(c => c.claim_type), topicCodes: [card.topic_code] });

  const family = await one(
    `INSERT INTO lcos.content_families (code, title, knowledge_card_id, knowledge_card_version_id,
       primary_segment_id, risk_tier, origin, origin_question_id, created_by, is_test_content)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [code('CF'), `Targeted: ${card.canonical_question_en.slice(0, 70)}`, card.id, cardVersion.id,
     segment.id, riskTier, questionId ? 'TURN_INTO_CONTENT' : 'PLANNED', questionId ?? null,
     actor?.id ?? null, isTestContent]);
  step('create_family', 'SUCCEEDED',
    { family_code: family.code, risk_tier: riskTier, output_types: types.map(t => t.code), is_test_content: isTestContent });

  const conceptRows = [];
  for (const t of types) {
    const row = await one(
      `INSERT INTO lcos.content_concepts (code, family_id, video_family, title, hook_line, premise,
         treatment, claim_ids_referenced, target_duration_s, cta_intent, why_this_works, status)
       VALUES ($1,$2,$3::lcos.video_family,$4,$5,$6,$7,$8::uuid[],$9,$10,$11,'SELECTED') RETURNING *`,
      [code('CC'), family.id, t.video_family, `${t.label}: ${card.canonical_question_en.slice(0, 70)}`,
       card.canonical_question_en, t.description ?? `Direct answer using ${card.code}.`,
       `Format: ${t.label}${t.platform ? ` (${t.platform})` : ''}. ${t.description ?? ''}`.trim(),
       claims.map(c => c.id), 30, 'private telegram consult',
       `Targeted generation request for output type ${t.code}.`]);
    conceptRows.push(row);
  }
  step('create_concepts', 'SUCCEEDED', { count: conceptRows.length, output_types: types.map(t => t.code) });

  const scripts = [];
  for (const concept of conceptRows) {
    const s = await generateScript({ concept, family, card, cardVersion, claims, actor,
      isTestContent, tonePreset: effectiveTone });
    scripts.push(await processGeneratedScript(s, family, languages, actor, step, effectiveTone));
  }
  step('queue_review', 'SUCCEEDED');

  return { pipeline_id: family.id, family_id: family.id, family_code: family.code,
    knowledge_card: { id: card.id, code: card.code, status: card.status },
    is_test_content: isTestContent, tone_preset: effectiveTone, risk_tier: family.risk_tier,
    concepts: conceptRows.map(c => ({ id: c.id, code: c.code, title: c.title, video_family: c.video_family })),
    scripts, steps };
}

// ============ bulk commission (owner decision, 12 Aug 2026) ============

// Nate's words: "I don't want to have to approve knowledge cards anymore...
// I just want to generate content automatically. We don't have to put it
// out until it gets human approval each step of the way, IE script, ie
// video, etc." This is the bulk driver for that: instead of one
// Turn Into Content click per question, it loops over every knowledge card
// that has real question demand behind it -- approved or not -- and
// generates a full spread of output types for each.
//
// What this does NOT change: resolveCardForGeneration() still requires
// approval.override='ADMIN_TEST_MODE' plus an admin actor to touch an
// unapproved card, exactly the door Nate had built for himself weeks ago to
// test without waiting on medical-director sign-off; content made that way still carries
// is_test_content=true; and executePublish() in distribution.mjs still
// re-checks card.status='APPROVED' at publish time no matter how the
// content was generated. So bulk commission can run against the entire
// backlog, unapproved cards included, and nothing it makes can reach a
// real user until a card is approved or a human clears it downstream --
// the human checkpoint just moves to the script/render review Nate
// described instead of sitting in front of generation.
export async function bulkCommission({ limit = 10, outputTypes = null, actor }) {
  if (!actor?.roles?.includes('admin')) {
    const e = new Error('bulk commission requires an admin actor: it is the same door as the single-card admin test-mode override, just looped');
    e.status = 403; e.code = 'FORBIDDEN'; e.guard = 'adminOnlyBulk'; throw e;
  }
  const override = String(await setting('approval.override', 'OFF'));
  if (override !== 'ADMIN_TEST_MODE') {
    const e = new Error('approval.override must be ADMIN_TEST_MODE for bulk commission to reach cards nobody has approved yet -- flip it on the Settings screen first');
    e.status = 422; e.code = 'GUARD_FAILED'; e.guard = 'adminTestModeRequired'; throw e;
  }
  const boundedLimit = Math.min(Math.max(Number(limit) || 10, 1), 25);
  const types = (Array.isArray(outputTypes) && outputTypes.length) ? outputTypes
    : (await q(`SELECT code FROM lcos.content_output_types WHERE is_active ORDER BY sort_order`)).rows.map(r => r.code);

  // Candidates: any non-retired card with a real question cluster behind
  // it, ranked by the latest priority score when one exists (falls back to
  // raw question volume for cards /demand/recompute hasn't scored yet).
  // The 14-day guard against a card that already got a family stops the
  // same card from being re-commissioned every time this runs.
  const candidates = (await q(
    `SELECT kc.id, kc.code, kc.status, count(DISTINCT qc.id)::int AS cluster_count,
            count(DISTINCT qcm.question_id)::int AS question_count,
            COALESCE(max(tps.priority_score), 0) AS priority_score
     FROM lcos.knowledge_cards kc
     JOIN lcos.question_clusters qc ON qc.knowledge_card_id = kc.id AND qc.is_active
     LEFT JOIN lcos.question_cluster_members qcm ON qcm.cluster_id = qc.id
     LEFT JOIN lcos.topic_priority_scores tps ON tps.knowledge_card_id = kc.id
       AND tps.computed_for = (SELECT max(computed_for) FROM lcos.topic_priority_scores)
     WHERE kc.status <> 'RETIRED'
       AND NOT EXISTS (SELECT 1 FROM lcos.content_families cf WHERE cf.knowledge_card_id = kc.id
                        AND cf.created_at > now() - interval '14 days')
     GROUP BY kc.id, kc.code, kc.status
     ORDER BY priority_score DESC, question_count DESC
     LIMIT $1`, [boundedLimit])).rows;

  const results = [];
  for (const c of candidates) {
    try {
      const r = await generateContent({ cardId: c.id, outputTypes: types, actor });
      results.push({ card_id: c.id, card_code: c.code, card_status: c.status, family_code: r.family_code,
        is_test_content: r.is_test_content, pieces: r.scripts.length, status: 'OK' });
    } catch (e) {
      results.push({ card_id: c.id, card_code: c.code, card_status: c.status, status: 'FAILED', error: e.message });
    }
  }
  const ok = results.filter(r => r.status === 'OK');
  const totalPieces = ok.reduce((n, r) => n + r.pieces, 0);
  await audit(null, { actor, action: 'content.bulk_commission', objectType: 'KNOWLEDGE_CARD',
    reason: `${ok.length}/${candidates.length} cards commissioned, ${totalPieces} pieces, output_types=${types.join(',')}` });
  return { candidates_considered: candidates.length, commissioned: ok.length, total_pieces: totalPieces, results };
}

export async function generateScript({ concept, family, card, cardVersion, claims, actor, seedUnsupported = false,
    isTestContent = false, tonePreset = null }) {
  const effectiveTone = tonePreset || String(await setting('content.tone_preset', 'LETENA_DEFAULT'));
  // Platform context for the writer (14 Aug 2026, Nate: "the script is bland
  // and its terrible... research the top way to write scripts for each
  // individual social media platform"). A TikTok reel, an Instagram carousel
  // and a Telegram post are three different crafts, and until now the writer
  // was told none of them: it only ever saw video_family, an internal
  // taxonomy code that carries no craft guidance. content_output_types
  // already holds the real platform and format per video_family, so read it
  // rather than inventing a second mapping.
  const outputType = await one(
    `SELECT code, label, platform, description FROM lcos.content_output_types
     WHERE video_family=$1::lcos.video_family AND is_active ORDER BY sort_order LIMIT 1`,
    [concept.video_family]);
  // generateContent()'s output-type path creates concepts WITHOUT running
  // creative_director: it stubs hook_line with the card's canonical question
  // verbatim as a placeholder. The writer had no way to know that, so it
  // treated a placeholder as approved creative direction and shipped the
  // literal question as the hook ("How do condoms prevent pregnancy?" was
  // both the hook and the 0-second on-screen text on SCR-97A5F22A). Tell it
  // the truth so it writes a real opening instead of echoing a form field.
  const hookLineIsPlaceholder =
    (concept.hook_line ?? '').trim() === (card.canonical_question_en ?? '').trim();
  const out = await invokeAgent('script_writer', {
    hook_line: concept.hook_line, video_family: concept.video_family,
    hook_line_is_placeholder: hookLineIsPlaceholder,
    treatment: concept.treatment,
    // What kind of thing this is, which decides which body the writer fills.
    // Distinct from video_family (a render-routing key) and from platform
    // (where it gets posted): a carousel and a static graphic are both
    // Instagram, and neither is a video.
    format: formatOf(concept.video_family),
    platform: outputType?.platform ?? null,
    output_format: outputType?.label ?? null,
    format_note: outputType?.description ?? null,
    target_duration_s: concept.target_duration_s ?? null,
    card: { code: card.code, canonical_question_en: card.canonical_question_en,
      approved_ctas: cardVersion.approved_ctas,
      prohibited_claims: cardVersion.prohibited_claims },
    claims: claims.map(c => ({ id: c.id, code: c.code, claim_text_en: c.claim_text_en, certainty: c.certainty })),
    __seed_unsupported: seedUnsupported || undefined,
  }, { objectType: 'CONCEPT', objectId: concept.id, workflowCode: 'WF07', tone_preset: effectiveTone });

  if (out.result === 'NEEDS_KNOWLEDGE') {
    const s = await one(
      `INSERT INTO lcos.scripts (code, concept_id, family_id, knowledge_card_version_id, language,
         status, risk_tier, needs_knowledge_note, created_by, is_test_content)
       VALUES ($1,$2,$3,$4,'EN','NEEDS_KNOWLEDGE',$5,$6,$7,$8) RETURNING *`,
      [code('SCR'), concept.id, family.id, family.knowledge_card_version_id, family.risk_tier,
       JSON.stringify(out.needs_knowledge), actor?.id ?? null, isTestContent]);
    return s;
  }
  const sc = out.script;
  // Hash and lint the piece's ACTUAL body. Both used to read spoken_script,
  // which is empty for a carousel, a static graphic or a post now that each
  // fills its own body, so both would have been operating on a hook and a
  // CTA alone. bodyTextOf() is the single definition of "the text of this
  // piece" and is the same one the validator and the localizer use.
  const bodyText = bodyTextOf(sc);
  const bodyHash = sha(bodyText);
  // Mechanical house-style lint over every generated English surface. Not
  // exhaustive (see ai/style_lint.mjs); catches em dashes, hedge phrases and
  // AI sign-offs so a human reviewer sees them rather than them slipping by.
  const styleWarnings = lintStyle([bodyText, sc.caption].filter(Boolean).join('\n'));
  const s = await one(
    `INSERT INTO lcos.scripts (code, concept_id, family_id, knowledge_card_version_id, language,
       status, risk_tier, current_version, validation_result, content_sha256, created_by, is_test_content)
     VALUES ($1,$2,$3,$4,'EN','DRAFT',$5,1,'NOT_RUN',$6,$7,$8) RETURNING *`,
    [code('SCR'), concept.id, family.id, family.knowledge_card_version_id, family.risk_tier,
     bodyHash, actor?.id ?? null, isTestContent]);
  await q(
    `INSERT INTO lcos.script_versions (script_id, version, hook, spoken_script, onscreen_text,
       scene_plan, cta, caption, hashtags, platform_variants, estimated_duration_s, content_sha256,
       created_by, tone_preset, style_warnings, format, carousel_slides, static_graphic, post_text)
     VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [s.id, sc.hook, sc.spoken_script ?? '', JSON.stringify(sc.onscreen_text), JSON.stringify(sc.scene_plan),
     sc.cta, sc.caption ?? null, sc.hashtags ?? [], JSON.stringify(sc.platform_variants ?? {}),
     sc.estimated_duration_s, bodyHash, actor?.id ?? null, effectiveTone, JSON.stringify(styleWarnings),
     sc.format ?? 'VIDEO', JSON.stringify(sc.carousel_slides ?? []),
     sc.static_graphic ? JSON.stringify(sc.static_graphic) : null, sc.post_text ?? null]);
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
  // Test-mode scripts (is_test_content) were written from whatever claims
  // were attached, not only APPROVED ones (see resolveCardForGeneration);
  // re-fetch on the same basis so validation can find what generation used
  // instead of failing every statement on a filter mismatch.
  const claims = (await q(
    `SELECT mc.id, mc.code, mc.claim_text_en, mc.certainty FROM lcos.knowledge_card_claims kcc
     JOIN lcos.medical_claims mc ON mc.id=kcc.claim_id
     WHERE kcc.card_id=$1 AND (
       ($2::boolean AND mc.status <> 'RETIRED') OR (NOT $2::boolean AND mc.status='APPROVED')
     )`, [family.knowledge_card_id, s.is_test_content])).rows;

  await q(`UPDATE lcos.scripts SET status='VALIDATING' WHERE id=$1 AND status IN ('DRAFT','VALIDATION_FAILED')`, [s.id]);

  // Model validator. Its failure is treated as FAIL: there is no skip path.
  let agentOut;
  try {
    agentOut = await invokeAgent('claim_validator', {
      script_text: bodyTextOf(v),
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
    scriptText: bodyTextOf(v),
    claims, card: cardVersion, riskTier: s.risk_tier, cta: v.cta });
  const findings = [...agentOut.findings, ...overlay];
  const result = overallResult(agentOut.statements, findings);

  // Superseded by this run: without this, a re-validate (the "Re-run
  // validation" button on a VALIDATION_FAILED script) only ever adds rows,
  // so an old FAIL finding from before a fix keeps showing next to a fresh
  // PASS forever, since the GET route filters on NOT resolved with no
  // recency cutoff.
  await q(`UPDATE lcos.script_findings SET resolved=true, resolved_by=$3, resolved_at=now()
           WHERE script_id=$1 AND script_version=$2 AND NOT resolved`,
    [s.id, s.current_version, actor?.id ?? null]);

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

export async function localizeScript(scriptId, { actor, tonePreset = null }) {
  const s = await one(`SELECT * FROM lcos.scripts WHERE id=$1`, [scriptId]);
  if (!s) return null;
  const v = await one(`SELECT * FROM lcos.script_versions WHERE script_id=$1 AND version=$2`,
    [s.id, s.current_version]);
  const family = await one(`SELECT * FROM lcos.content_families WHERE id=$1`, [s.family_id]);
  const cardVersion = await one(`SELECT * FROM lcos.knowledge_card_versions WHERE id=$1`,
    [family.knowledge_card_version_id]);
  const terminology = (await q(
    `SELECT term_en, preferred_am, avoid_am FROM lcos.terminology WHERE status='APPROVED' LIMIT 200`)).rows;
  const effectiveTone = tonePreset || String(await setting('content.tone_preset', 'LETENA_DEFAULT'));

  const loc = await invokeAgent('amharic_localizer', {
    english: { hook: v.hook, spoken_script: v.spoken_script || bodyTextOf(v), cta: v.cta,
      caption: v.caption, format: v.format ?? 'VIDEO' },
    canonical_answer_am: cardVersion.canonical_answer_am,
    terminology, register: 'GENERAL',
  }, { objectType: 'SCRIPT', objectId: s.id, workflowCode: 'WF09', tone_preset: effectiveTone });

  if (loc.result === 'HUMAN_LANGUAGE_REVIEW') {
    await routeLanguageReview(s.id, null);
    return { result: 'HUMAN_LANGUAGE_REVIEW', reason: loc.escalation_reason };
  }

  // Blind back-translation: separate agent, does not receive the English.
  const back = await invokeAgent('back_translator', { amharic_text: loc.spoken_amharic },
    { objectType: 'SCRIPT', objectId: s.id, workflowCode: 'WF09' });
  const [srcVec, backVec] = await Promise.all([embed(v.spoken_script || bodyTextOf(v)), embed(back.english)]);
  const drift = 1 - cosine(srcVec, backVec);

  const qa = await invokeAgent('language_qa', {
    amharic: loc.spoken_amharic, english_source: v.spoken_script || bodyTextOf(v),
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
  const mode = String(await setting('publishing.mode', 'DRAFT_BATCH'));
  // In DRAFT_BATCH every Amharic script sees the language editor (the original
  // pilot rule; approval is one batch click anyway). In the auto modes only
  // genuinely suspicious translations pull a human in.
  const needsHuman = drift > driftThreshold || qa.verdict !== 'PASS' || qa.naturalness_score < 4
    || mode === 'DRAFT_BATCH';
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
  // Owner decision (Aug 2026): in the auto modes, scripts generated from an
  // approved knowledge card that passed claim validation approve themselves.
  // AUTO_EXCEPT_SENSITIVE still routes TIER_4 (abortion, GBV) to a human.
  const mode = String(await setting('publishing.mode', 'DRAFT_BATCH'));
  const modeAutoOk = mode === 'FULL_AUTO'
    || (mode === 'AUTO_EXCEPT_SENSITIVE' && riskTier !== 'TIER_4');
  const isClinicalTier = ['TIER_3', 'TIER_4'].includes(riskTier);
  // Separate, dedicated kill switch for the clinical-sign-off gate itself
  // (Settings -> admin toggle), independent of publishing.mode. Added 14 Aug
  // 2026 to unblock testing the rest of the pipeline without a doctor in the
  // loop; the plan is to turn this back on once that's verified, so it is
  // its own setting rather than folded into publishing.mode's existing auto
  // levels, which govern a broader set of behavior (language review too).
  const clinicalReviewEnabled = Boolean(await setting('review.clinical_review_enabled', false));
  const clinicalGateOff = isClinicalTier && !clinicalReviewEnabled;
  const autoOk = modeAutoOk || clinicalGateOff;
  if (autoOk && s.validation_result === 'PASS' && s.created_by) {
    await q(`UPDATE lcos.scripts SET status='APPROVED', approved_by=created_by,
               approved_at=now(), approved_version=current_version
             WHERE id=$1 AND validation_result='PASS'`, [scriptId]);
    await q(`UPDATE lcos.review_tasks SET status='CANCELLED'
             WHERE object_type='SCRIPT' AND object_id=$1 AND status IN ('OPEN','IN_PROGRESS')`, [scriptId]);
    const reason = modeAutoOk ? `publishing.mode=${mode}` : 'review.clinical_review_enabled=false';
    await audit(null, { actor: { type: 'SYSTEM', label: reason },
      action: 'script.auto_approved', objectType: 'SCRIPT', objectId: scriptId });
    return true;
  }
  if (isClinicalTier) {
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
