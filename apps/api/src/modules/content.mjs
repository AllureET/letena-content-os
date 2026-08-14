// Content module: families, concepts, scripts, claim validation, Amharic
// localization, language QA, and the Turn Into Content pipeline.
import crypto from 'node:crypto';
import { q, one, tx, audit, requirePerm, err, transition, setting } from '../core.mjs';
import { invokeAgent, embed } from '../ai/gateway.mjs';
import { lintStyle } from '../ai/style_lint.mjs';
import { validatorOverlay, overallResult, computeRiskTier } from '../../../../packages/scoring/src/index.mjs';
import { formatOf, bodyTextOf } from '../formats.mjs';
import { isAbortionAdjacent } from '../letena_canon.mjs';
import { classifyEdit } from '../pipeline_rules.mjs';
import { signGate, invalidateMedicalSignoff, signerRoleFor } from './pipeline.mjs';
import { containsForbidden } from '../../../../packages/deid/src/index.mjs';

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
    }).then(async (result) => {
      // A human clinical approval of a script IS the medical_review gate
      // signature (Run One): the same act, recorded in both the review
      // table and the signed-gate ledger the publish transition checks.
      // Outside the tx deliberately: a gate row is idempotent and losing it
      // is recoverable by re-signing, where failing the review write is not.
      if (result.ok && task.review_type === 'CLINICAL_SCRIPT' && task.object_type === 'SCRIPT'
          && decision.startsWith('APPROVED')) {
        await signGate(task.object_id, 'medical_review', { signedBy: req.actor.id,
          note: `clinical review ${decision.toLowerCase()}`,
          signedRole: signerRoleFor(req.actor, 'medical_review') });
      }
      return result;
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
      // Batch approval by someone holding the clinical permission signs the
      // medical_review gate too, so Nate's one-click flow stays one click
      // while the gate the publish transition checks is a real, signed
      // record. An editorial-only approver does NOT sign it: their click
      // approves the script status, and publish still waits for a clinical
      // signature, because medical_review before publish has no exceptions.
      if (req.actor.permissions.includes('script.approve_clinical')) {
        await signGate(s.id, 'medical_review', { signedBy: req.actor.id, note: 'batch approval',
          signedRole: signerRoleFor(req.actor, 'medical_review') });
        if (s.needs_clinical_signoff) {
          await signGate(s.id, 'clinical_signoff', { signedBy: req.actor.id, note: 'batch approval',
            signedRole: signerRoleFor(req.actor, 'clinical_signoff') });
        }
      }
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
    const { question_id, languages = ['EN', 'AM'], concept_count = 2, tone_preset = null,
      audience = 'WOMEN' } = req.body ?? {};
    if (!question_id) return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'question_id required'));
    if (!AUDIENCES.includes(audience)) {
      return reply.code(422).send(err(422, 'VALIDATION_ERROR', `audience must be one of ${AUDIENCES.join(', ')}`));
    }
    try {
      const result = await turnIntoContent({ questionId: question_id, languages, conceptCount: concept_count,
        actor: req.actor, tonePreset: tone_preset, audience });
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

  // The unified format registry (migration 0019). One row per format Letena
  // publishes anywhere; adding a format is a row, never a code change.
  // Writes happen by migration, deliberately: headings and rules feed the
  // writer prompt and the stage/gate machinery, so a change to them is a
  // reviewed change, the same discipline as prompt versions.
  app.get('/content/formats', { preHandler: requirePerm('concept.read') }, async () => {
    const r = await q(
      `SELECT code, label, kind, surface, platforms, language_mode, body_kind, video_family,
              headings, rules, body_schema, stages_applicable, review_ladder, target_length,
              hedging_allowed, wants_captions, ends_at_door, is_internal, sort_order, description,
              comment_prompt_allowed, production_paths, cta_spec
       FROM lcos.content_formats WHERE is_active ORDER BY sort_order`);
    return { items: r.rows };
  });

  // Edit a script's body after generation. THIS IS THE EDIT PATH. Run One
  // invalidated the medical sign-off on ANY body change; the owner refined
  // it 14 Aug 2026: "if the edit is to a medical term, it should go back to
  // medical review, if its to just the content then it should go through
  // and the updated amharic should be used to retrain the descriptions for
  // output". So the edit is CLASSIFIED, deterministically (classifyEdit in
  // pipeline_rules.mjs): a change to any claim-mapped statement, number,
  // time window, negation, hedge, dose or terminology term is MEDICAL and
  // withdraws medical_review and clinical_signoff, resets validation, and
  // returns the piece to medical review. A change to non-medical text only
  // (a hook rewrite, a caption, pacing) passes and the sign-off stands, and
  // any corrected Amharic in it is stored as an approved phrasing example
  // that the localizer prompt learns from. Conservative at the boundary:
  // when the classifier cannot tell, the edit is medical.
  app.post('/content/scripts/:id/edit', { preHandler: requirePerm('script.write') }, async (req, reply) => {
    const s = await one(`SELECT * FROM lcos.scripts WHERE id=$1`, [req.params.id]);
    if (!s) return reply.code(404).send(err(404, 'NOT_FOUND', 'script'));
    const v = await one(`SELECT * FROM lcos.script_versions WHERE script_id=$1 AND version=$2`,
      [s.id, s.current_version]);
    if (!v) return reply.code(422).send(err(422, 'GUARD_FAILED', 'script has no version to edit'));

    const b = req.body ?? {};
    // Only these fields are editable; anything else in the payload is
    // ignored rather than stored, so a client cannot write fields the
    // pipeline does not know how to validate.
    const EDITABLE = ['hook', 'spoken_script', 'onscreen_text', 'scene_plan', 'carousel_slides',
      'static_graphic', 'post_text', 'body', 'cta', 'caption', 'caption_short', 'caption_fbtg',
      'caption_x', 'captions_by_platform', 'hashtags'];
    const next = {};
    for (const f of EDITABLE) next[f] = (f in b) ? b[f] : v[f];

    const newBodyText = bodyTextOf(next);
    if (!newBodyText) {
      return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'the edit would leave the piece with no text at all'));
    }
    const oldBodyText = bodyTextOf(v);
    const newHash = sha(newBodyText);
    const changed = newHash !== v.content_sha256;
    const fmtRow = await formatRowForScript(s.id);
    const stayEnglish = await stayEnglishTerms();
    const styleWarnings = lintStyle(newBodyText, { hedgingAllowed: !!fmtRow?.hedging_allowed,
      commentPromptAllowed: fmtRow ? !!fmtRow.comment_prompt_allowed : true, stayEnglish });
    // What kind of edit is this? Claim-mapped statements for the version
    // being edited, plus the stay-English terminology, feed the classifier.
    const claimStatements = (await q(
      `SELECT statement FROM lcos.script_claims WHERE script_id=$1 AND script_version=$2`,
      [s.id, s.current_version])).rows.map((r) => r.statement);
    const editClass = changed
      ? classifyEdit({ oldText: oldBodyText, newText: newBodyText, claimStatements,
          terminologyTerms: stayEnglish })
      : { medical: false, reasons: ['no textual change'] };

    const nv = s.current_version + 1;
    await q(
      `INSERT INTO lcos.script_versions (script_id, version, hook, spoken_script, onscreen_text,
         scene_plan, cta, caption, hashtags, platform_variants, estimated_duration_s, content_sha256,
         created_by, tone_preset, style_warnings, format, carousel_slides, static_graphic, post_text,
         body, caption_short, caption_fbtg, caption_x, captions_by_platform, authored_by, change_summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
               'AGENT_HUMAN_EDITED',$25)`,
      [s.id, nv, next.hook, next.spoken_script ?? '', JSON.stringify(next.onscreen_text ?? []),
       JSON.stringify(next.scene_plan ?? []), next.cta, next.caption ?? null,
       next.hashtags ?? [], JSON.stringify(v.platform_variants ?? {}), v.estimated_duration_s,
       newHash, req.actor.id, v.tone_preset, JSON.stringify(styleWarnings),
       v.format ?? 'VIDEO', JSON.stringify(next.carousel_slides ?? []),
       next.static_graphic ? JSON.stringify(next.static_graphic) : null, next.post_text ?? null,
       JSON.stringify(next.body ?? {}), next.caption_short ?? null, next.caption_fbtg ?? null,
       next.caption_x ?? null, JSON.stringify(next.captions_by_platform ?? {}),
       req.body?.change_summary ?? 'human edit']);
    // Carry the claim map forward so re-validation has a map to check. The
    // editor is expected to re-run validation; the status reset below makes
    // that unavoidable before approval.
    await q(`INSERT INTO lcos.script_claims (script_id, script_version, claim_id, statement, location)
             SELECT script_id, $2, claim_id, statement, location FROM lcos.script_claims
             WHERE script_id=$1 AND script_version=$3`, [s.id, nv, s.current_version]);
    await q(`UPDATE lcos.scripts SET current_version=$2, content_sha256=$3 WHERE id=$1`, [s.id, nv, newHash]);

    let invalidated = false;
    if (changed && editClass.medical) {
      invalidated = await invalidateMedicalSignoff(s.id, {
        actor: req.actor,
        reason: `medical edit: ${editClass.reasons.join('; ')}` });
    } else if (changed) {
      // Non-medical edit: the sign-off stands, and the corrected Amharic
      // feeds back. Every Ethiopic-script line that changed is stored as an
      // approved phrasing example; the localizer prompt injects recent ones
      // ("retrain the descriptions", owner, 14 Aug 2026; no fine-tuning).
      const newAm = extractAmharicSegments(newBodyText);
      const oldAm = new Set(extractAmharicSegments(oldBodyText));
      for (const seg of newAm) {
        if (!oldAm.has(seg)) {
          await q(`INSERT INTO lcos.phrasing_examples (script_id, amharic_text, english_context, note, created_by)
                   VALUES ($1,$2,$3,$4,$5)`,
            [s.id, seg, (next.hook ?? '').slice(0, 300),
             'human-corrected Amharic from a non-medical edit', req.actor.id]);
        }
      }
    }
    await audit(null, { actor: req.actor, action: 'script.edited', objectType: 'SCRIPT',
      objectId: s.id, objectCode: s.code,
      reason: !changed ? 'no textual change'
        : editClass.medical ? `medical edit; sign-off invalidated (${editClass.reasons.join('; ')})`
        : 'non-medical edit; sign-off stands; Amharic phrasing captured' });
    return { script_id: s.id, version: nv, content_changed: changed,
      edit_class: editClass.medical ? 'MEDICAL' : 'NON_MEDICAL', edit_reasons: editClass.reasons,
      medical_signoff_invalidated: invalidated, style_warnings: styleWarnings };
  });
  app.post('/content/generate', { preHandler: requirePerm('question.turn_into_content') }, async (req, reply) => {
    const { card_id, concept_id, output_types, formats, question_id, languages = ['EN', 'AM'],
      tone_preset = null, audience = 'WOMEN', is_brand_tier = false } = req.body ?? {};
    if (!card_id && !concept_id) {
      return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'card_id (topic) or concept_id is required'));
    }
    if (!AUDIENCES.includes(audience)) {
      return reply.code(422).send(err(422, 'VALIDATION_ERROR', `audience must be one of ${AUDIENCES.join(', ')}`));
    }
    try {
      const result = await generateContent({ cardId: card_id, conceptId: concept_id,
        outputTypes: output_types, formatCodes: formats, questionId: question_id,
        languages, actor: req.actor, tonePreset: tone_preset, audience,
        isBrandTier: !!is_brand_tier });
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

export async function turnIntoContent({ questionId, languages = ['EN', 'AM'], actor, tonePreset = null, audience = 'WOMEN' }) {
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
         why_this_works, status, audience)
       VALUES ($1,$2,$3::lcos.video_family,$4,$5,$6,$7,$8,$9,$10,$11::uuid[],$12,$13,'SELECTED',$14) RETURNING *`,
      [code('CC'), family.id, c.video_family, c.title, c.hook_line, c.premise, c.treatment,
       c.perspective ?? null, JSON.stringify(c.characters ?? []), c.target_duration_s,
       c.claim_ids_referenced, c.cta_intent, c.why_this_works, audience]);
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
export async function generateContent({ cardId, conceptId, outputTypes, formatCodes = null,
    questionId, languages = ['EN', 'AM'], actor, tonePreset = null, audience = 'WOMEN',
    isBrandTier = false }) {
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

  const wantsFormats = Array.isArray(formatCodes) && formatCodes.length > 0;
  if (!wantsFormats && (!Array.isArray(outputTypes) || !outputTypes.length)) {
    const e = new Error('formats (content_formats codes) or output_types (content_output_types codes) must be a non-empty array');
    e.status = 422; e.code = 'VALIDATION_ERROR'; throw e;
  }
  if (questionId) {
    const question = await one(`SELECT id FROM lcos.audience_questions WHERE id=$1`, [questionId]);
    if (!question) { const e = new Error('question_id not found'); e.status = 404; e.code = 'NOT_FOUND'; throw e; }
  }
  const { card, cardVersion, claims, isTestContent } = await resolveCardForGeneration(cardId, actor);
  step('resolve_card', 'SUCCEEDED', { card_code: card.code, is_test_content: isTestContent });

  // Two ways to name what to make. The format registry (content_formats,
  // migration 0019) is the Run One path and the superset: one topic can
  // become a Send-It, a Save-It and a library article in one call, each
  // written to its own schema. output_types remains for existing callers
  // and maps to the same downstream machinery via video_family.
  let types;
  if (wantsFormats) {
    const rows = (await q(
      `SELECT code, label, video_family, description, sort_order,
              platforms[1] AS platform, target_length
       FROM lcos.content_formats WHERE code = ANY($1::text[]) AND is_active ORDER BY sort_order`,
      [formatCodes])).rows;
    const foundCodes = new Set(rows.map(t => t.code));
    const missing = formatCodes.filter(c => !foundCodes.has(c));
    if (missing.length) {
      const e = new Error(`unknown or inactive formats: ${missing.join(', ')}`);
      e.status = 422; e.code = 'VALIDATION_ERROR'; throw e;
    }
    types = rows.map(r => ({ ...r, format_code: r.code }));
  } else {
    types = (await q(
      `SELECT * FROM lcos.content_output_types WHERE code = ANY($1::text[]) AND is_active ORDER BY sort_order`,
      [outputTypes])).rows.map(r => ({ ...r, format_code: null }));
    const foundCodes = new Set(types.map(t => t.code));
    const missing = outputTypes.filter(c => !foundCodes.has(c));
    if (missing.length) {
      const e = new Error(`unknown or inactive output_types: ${missing.join(', ')}`);
      e.status = 422; e.code = 'VALIDATION_ERROR'; throw e;
    }
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
    // target_duration_s only means something for timed formats; the column
    // has a CHECK of 6..600 so registry minute-scale targets are clamped.
    let dur = 30;
    const tl = t.target_length ?? null;
    if (tl && tl.unit === 'seconds') dur = Number(tl.max ?? tl.options?.[0] ?? 30) || 30;
    else if (tl && tl.unit === 'minutes') dur = Math.min(600, (Number(tl.max ?? tl.target ?? 1) || 1) * 60);
    const row = await one(
      `INSERT INTO lcos.content_concepts (code, family_id, video_family, format_code, title, hook_line, premise,
         treatment, claim_ids_referenced, target_duration_s, cta_intent, why_this_works, status, audience)
       VALUES ($1,$2,$3::lcos.video_family,$4,$5,$6,$7,$8,$9::uuid[],$10,$11,$12,'SELECTED',$13) RETURNING *`,
      [code('CC'), family.id, t.video_family, t.format_code,
       `${t.label}: ${card.canonical_question_en.slice(0, 70)}`,
       card.canonical_question_en, t.description ?? `Direct answer using ${card.code}.`,
       `Format: ${t.label}${t.platform ? ` (${t.platform})` : ''}. ${t.description ?? ''}`.trim(),
       claims.map(c => c.id), dur, 'private telegram consult',
       `Targeted generation request for ${t.format_code ? 'format' : 'output type'} ${t.code}.`, audience]);
    conceptRows.push(row);
  }
  step('create_concepts', 'SUCCEEDED', { count: conceptRows.length, output_types: types.map(t => t.code) });

  const scripts = [];
  for (const concept of conceptRows) {
    const s = await generateScript({ concept, family, card, cardVersion, claims, actor,
      isTestContent, tonePreset: effectiveTone, isBrandTier });
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

// The registry row that governs a script, resolved through its concept.
// Null for legacy concepts created before format_code existed; every caller
// treats null as "behave exactly as before Run One".
export async function formatRowForScript(scriptId) {
  return one(
    `SELECT cf.* FROM lcos.scripts s
     JOIN lcos.content_concepts cc ON cc.id = s.concept_id
     JOIN lcos.content_formats cf ON cf.code = cc.format_code
     WHERE s.id = $1`, [scriptId]);
}

// The audience registers a piece can be written to (owner, 14 Aug 2026:
// "This is mainly women but also men... they ask a lot"). WOMEN stays the
// default because it is who asks most.
export const AUDIENCES = Object.freeze(['WOMEN', 'MEN', 'COUPLES', 'GENERAL']);

// The stay-English terminology set (owner rule 12 Aug 2026, reconfirmed
// 14 Aug): terms written in English inside Amharic copy, with the
// avoid-listed Amharic renderings the deterministic lint flags. Injected
// into every writer and localizer prompt for every format, not only video.
export async function stayEnglishTerms() {
  return (await q(
    `SELECT term_en, avoid_am FROM lcos.terminology
     WHERE keep_english AND status='APPROVED' ORDER BY term_en LIMIT 200`)).rows;
}

// Every Ethiopic-script run in a text, trimmed, deduplicated. Used to
// capture corrected Amharic phrasing from a non-medical human edit.
export function extractAmharicSegments(text) {
  const matches = String(text ?? '').match(/[\u1200-\u137F][\u1200-\u137F\s\u1361-\u1368.,:;!?()0-9]*[\u1200-\u137F\u1362]?/g) ?? [];
  return [...new Set(matches.map((m) => m.trim()).filter((m) => m.length >= 6))];
}

// Format-specific REQUIRED body fields (14 Aug 2026 corrections, item 5).
// The zod schema keys on body kind and cannot see the format code, so the
// per-format requirements are enforced here, deterministically. Failing one
// throws: a quiz without its giveaway or an Ask Dr Letena without its
// reworded question is not a thinner piece, it is not the format at all.
//
// ask_dr_letena additionally re-asserts de-identification over the quoted
// question itself. The question already passed the system's de-id on
// ingest and the writer is instructed to reword it, but this format READS
// A REAL PATIENT QUESTION ALOUD, so a residual phone number, handle or
// name pattern in the final quoted text is a hard stop, exactly as the AUA
// anonymised rule requires: a question that cannot be fully de-identified
// does not run.
export function requireFormatBody(fmtRow, sc) {
  const fail = (msg) => {
    const e = new Error(msg); e.status = 422; e.code = 'FORMAT_BODY_INCOMPLETE'; throw e;
  };
  const codeName = fmtRow?.code;
  if (!codeName) return;
  if (codeName === 'ask_dr_letena') {
    const qq = sc.body?.question_quoted;
    if (!qq || !String(qq).trim()) fail('ask_dr_letena requires body.question_quoted: the de-identified, reworded user question read aloud');
    if (containsForbidden(String(qq))) {
      fail('ask_dr_letena: the quoted question still carries an identifying pattern after rewording. A question that cannot be fully de-identified does not run.');
    }
  }
  if (codeName === 'quiz_reel' || codeName === 'quiz_carousel') {
    const g = sc.body?.giveaway;
    if (!g?.how_to_enter || !g?.deadline || !g?.winner_selection) {
      fail(`${codeName} requires body.giveaway with how_to_enter, deadline and winner_selection (non-medical, never claim-mapped, no clinical promises)`);
    }
  }
  if (codeName === 'aua_recap') {
    if ((sc.body?.cutdown_briefs ?? []).length !== 4) {
      fail('aua_recap requires body.cutdown_briefs with exactly four briefs');
    }
  }
  if (codeName === 'whiteboard_explainer') {
    const w = sc.body?.whiteboard;
    const clips = w?.clips ?? [];
    if (clips.length < 3 || clips.length > 4) fail('whiteboard_explainer requires body.whiteboard.clips: three to four clips');
    if (!(w?.board_map ?? []).length) fail('whiteboard_explainer requires body.whiteboard.board_map: one row per board element');
    for (const c of clips) {
      if (!c.last_frame_anchor || !String(c.last_frame_anchor).trim()) {
        fail('whiteboard_explainer: every clip needs a last_frame_anchor describing exactly what the board shows at its end');
      }
    }
  }
}

export async function generateScript({ concept, family, card, cardVersion, claims, actor, seedUnsupported = false,
    isTestContent = false, tonePreset = null, isBrandTier = false }) {
  const effectiveTone = tonePreset || String(await setting('content.tone_preset', 'LETENA_DEFAULT'));
  // Registry-driven generation (Run One, 14 Aug 2026). When the concept
  // carries a format_code, lcos.content_formats is the authority for what
  // is being written: the body kind, the headings, the per-format rules,
  // the target length, the language mode. video_family remains only the
  // render-routing key. Legacy concepts (format_code null) keep the exact
  // pre-Run-One behaviour, including the video_family -> body kind mapping.
  const fmtRow = concept.format_code
    ? await one(`SELECT * FROM lcos.content_formats WHERE code=$1 AND is_active`, [concept.format_code])
    : null;
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
  // What kind of thing this is, which decides which body the writer fills.
  // Distinct from video_family (a render-routing key) and from platform
  // (where it gets posted): a carousel and a static graphic are both
  // Instagram, and neither is a video. The registry's body_kind wins when a
  // format_code is present.
  const bodyKind = fmtRow?.body_kind ?? formatOf(concept.video_family);
  // NOTE the canonical Amharic blocks are deliberately NOT in this context:
  // the bot block contains @LetenaEthBot, which the outbound PII assertion
  // treats as a forbidden HANDLE and would kill every call. The blocks ride
  // verbatim inside the script_writer prompt text (migration 0021), which
  // the assertion does not scan. See apps/api/src/letena_canon.mjs.
  // The stay-English terminology rides in EVERY writer call (item 2 of the
  // 14 Aug corrections): term names only, which the PII assertion tolerates;
  // the rule text lives in the prompt. cta_spec carries block NAMES, never
  // block text (the door block's phone number and the bot handle would trip
  // the outbound PII assertion; the blocks ride verbatim in the prompt).
  const stayEnglish = await stayEnglishTerms();
  const audience = AUDIENCES.includes(concept.audience) ? concept.audience : 'WOMEN';
  const out = await invokeAgent('script_writer', {
    hook_line: concept.hook_line, video_family: concept.video_family,
    hook_line_is_placeholder: hookLineIsPlaceholder,
    treatment: concept.treatment,
    format: bodyKind,
    audience,
    terminology_keep_english: stayEnglish.map((t) => t.term_en),
    format_spec: fmtRow ? {
      code: fmtRow.code, label: fmtRow.label, kind: fmtRow.kind, surface: fmtRow.surface,
      platforms: fmtRow.platforms, language_mode: fmtRow.language_mode,
      headings: fmtRow.headings, rules: fmtRow.rules, body_schema: fmtRow.body_schema,
      target_length: fmtRow.target_length, wants_captions: fmtRow.wants_captions,
      ends_at_door: fmtRow.ends_at_door, hedging_allowed: fmtRow.hedging_allowed,
      cta: fmtRow.cta_spec, comment_prompt_allowed: fmtRow.comment_prompt_allowed,
    } : null,
    platform: outputType?.platform ?? fmtRow?.platforms?.[0] ?? null,
    output_format: outputType?.label ?? fmtRow?.label ?? null,
    format_note: outputType?.description ?? fmtRow?.description ?? null,
    target_duration_s: concept.target_duration_s ?? null,
    card: { code: card.code, canonical_question_en: card.canonical_question_en,
      approved_ctas: cardVersion.approved_ctas,
      prohibited_claims: cardVersion.prohibited_claims },
    claims: claims.map(c => ({ id: c.id, code: c.code, claim_text_en: c.claim_text_en, certainty: c.certainty })),
    __seed_unsupported: seedUnsupported || undefined,
  }, { objectType: 'CONCEPT', objectId: concept.id, workflowCode: 'WF07', tone_preset: effectiveTone });

  // Abortion-adjacent detection, ported from letenav2 content_board.php.
  // Substring detection over the piece's identity text OR the tier-4 topic
  // signal; a client flag could add to this but can never clear it once
  // detection fires. Stored on the script so the publish transition and the
  // pipeline advance both see it without re-deriving.
  const needsClinical = isAbortionAdjacent(
    `${concept.title ?? ''} ${concept.hook_line ?? ''} ${card.canonical_question_en ?? ''}`)
    || family.risk_tier === 'TIER_4';

  if (out.result === 'NEEDS_KNOWLEDGE') {
    const s = await one(
      `INSERT INTO lcos.scripts (code, concept_id, family_id, knowledge_card_version_id, language,
         status, risk_tier, needs_knowledge_note, created_by, is_test_content, stage, needs_clinical_signoff)
       VALUES ($1,$2,$3,$4,'EN','NEEDS_KNOWLEDGE',$5,$6,$7,$8,'script',$9) RETURNING *`,
      [code('SCR'), concept.id, family.id, family.knowledge_card_version_id, family.risk_tier,
       JSON.stringify(out.needs_knowledge), actor?.id ?? null, isTestContent, needsClinical]);
    return s;
  }
  const sc = out.script;
  // Format-specific required bodies, checked in code because the zod schema
  // keys on body KIND and cannot see the format code (14 Aug corrections).
  // Fails closed: a missing required field is a generation failure, never a
  // silently thinner piece.
  requireFormatBody(fmtRow, sc);
  // Hash and lint the piece's ACTUAL body. Both used to read spoken_script,
  // which is empty for a carousel, a static graphic or a post now that each
  // fills its own body, so both would have been operating on a hook and a
  // CTA alone. bodyTextOf() is the single definition of "the text of this
  // piece" and is the same one the validator and the localizer use. Since
  // Run One it also covers the generic body and all three captions.
  const bodyText = bodyTextOf(sc);
  const bodyHash = sha(bodyText);
  // Mechanical house-style lint over every generated surface. Not
  // exhaustive (see ai/style_lint.mjs); catches em dashes, filler hedges,
  // AI sign-offs, disclosure-shaped comment prompts and transliterated
  // stay-English terms so a human reviewer sees them rather than them
  // slipping by. hedgingAllowed and commentPromptAllowed come from the
  // registry: a push notification is REQUIRED to say might/may, and a quiz
  // is ALLOWED to invite a non-disclosing comment.
  const styleWarnings = lintStyle([bodyText, sc.caption].filter(Boolean).join('\n'),
    { hedgingAllowed: !!fmtRow?.hedging_allowed,
      commentPromptAllowed: fmtRow ? !!fmtRow.comment_prompt_allowed : true,
      stayEnglish });
  // New pieces start at the 'script' stage: generation IS the script step,
  // and plan happened when the concept was selected or commissioned.
  // The production path defaults per format: the FIRST entry of the
  // registry row's production_paths (DIGITAL everywhere the owner's
  // adapter pipeline applies, LIVE for aua_live, NONE for text and app
  // surfaces). Legacy concepts with no registry row keep LIVE, which is
  // the shoot+edit behaviour they were built on. Changeable through
  // POST /pipeline/scripts/:id/production-path until production starts.
  const productionPath = fmtRow?.production_paths?.[0] ?? 'LIVE';
  const s = await one(
    `INSERT INTO lcos.scripts (code, concept_id, family_id, knowledge_card_version_id, language,
       status, risk_tier, current_version, validation_result, content_sha256, created_by,
       is_test_content, stage, needs_clinical_signoff, production_path, is_brand_tier)
     VALUES ($1,$2,$3,$4,'EN','DRAFT',$5,1,'NOT_RUN',$6,$7,$8,'script',$9,$10,$11) RETURNING *`,
    [code('SCR'), concept.id, family.id, family.knowledge_card_version_id, family.risk_tier,
     bodyHash, actor?.id ?? null, isTestContent, needsClinical, productionPath, isBrandTier]);
  await q(
    `INSERT INTO lcos.script_versions (script_id, version, hook, spoken_script, onscreen_text,
       scene_plan, cta, caption, hashtags, platform_variants, estimated_duration_s, content_sha256,
       created_by, tone_preset, style_warnings, format, carousel_slides, static_graphic, post_text,
       body, captions_by_platform)
     VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [s.id, sc.hook, sc.spoken_script ?? '', JSON.stringify(sc.onscreen_text), JSON.stringify(sc.scene_plan),
     sc.cta, sc.caption ?? null, sc.hashtags ?? [], JSON.stringify(sc.platform_variants ?? {}),
     sc.estimated_duration_s, bodyHash, actor?.id ?? null, effectiveTone, JSON.stringify(styleWarnings),
     sc.format ?? bodyKind ?? 'VIDEO', JSON.stringify(sc.carousel_slides ?? []),
     sc.static_graphic ? JSON.stringify(sc.static_graphic) : null, sc.post_text ?? null,
     JSON.stringify(sc.body ?? {}), JSON.stringify(sc.captions ?? {})]);
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
    `SELECT term_en, preferred_am, avoid_am, keep_english FROM lcos.terminology WHERE status='APPROVED' LIMIT 200`)).rows;
  const effectiveTone = tonePreset || String(await setting('content.tone_preset', 'LETENA_DEFAULT'));
  const concept = await one(
    `SELECT cc.audience FROM lcos.content_concepts cc WHERE cc.id=$1`, [s.concept_id]);
  // Recent human-corrected Amharic phrasing (from non-medical edits, item
  // 12.1 of the 14 Aug corrections) rides into every localizer call as
  // approved phrasing examples. This is the "retrain the descriptions"
  // loop; there is no model fine-tuning.
  const phrasingExamples = (await q(
    `SELECT amharic_text FROM lcos.phrasing_examples ORDER BY created_at DESC LIMIT 10`)).rows
    .map((r) => r.amharic_text);

  const loc = await invokeAgent('amharic_localizer', {
    english: { hook: v.hook, spoken_script: v.spoken_script || bodyTextOf(v), cta: v.cta,
      caption: v.caption, format: v.format ?? 'VIDEO' },
    canonical_answer_am: cardVersion.canonical_answer_am,
    terminology, register: 'GENERAL',
    audience: concept?.audience ?? 'WOMEN',
    human_corrected_examples: phrasingExamples,
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
  // loop. SWITCHED BACK ON the same day by the unified-content-machine
  // build (migration 0021), per the kickoff brief. The code-side fallback
  // is now true as well, so a database missing the settings row fails SAFE:
  // clinical review happens unless someone explicitly turned it off.
  const clinicalReviewEnabled = Boolean(await setting('review.clinical_review_enabled', true));
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
