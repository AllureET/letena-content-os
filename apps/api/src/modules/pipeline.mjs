// Pipeline module: the nine-stage board with signed gates, ported from
// letenav2 lib/content_board.php into LCOS as part of the unified content
// machine (Run One, 14 Aug 2026). The rules are enforced HERE, server side,
// never only in a page:
//   - a piece advances out of its current stage ONLY when that stage's gate
//     row exists in lcos.script_gates (someone with the right permission
//     signed it);
//   - a piece cannot REACH publish unless the medical_review gate is signed
//     and, when the piece is abortion-adjacent (needs_clinical_signoff),
//     the clinical_signoff gate is signed too;
//   - stages a format cannot use (a push notification is never shot or
//     edited) are marked NOT APPLICABLE by the format registry
//     (content_formats.stages_applicable) and are skipped on the walk,
//     explicitly, rather than the stage not existing.
//
// What is deliberately NOT here: the weekly quota system, buffer targets
// and throughput maths from letenav2 (LETENA_CB_QUOTA_TARGETS et al).
// Dropped by the owner, explicitly, in the kickoff brief. Do not add them
// back.
//
// Signer routing is by permission, resolved at runtime through RBAC, never
// by name. That is not a style preference: a named clinician baked into a
// template is exactly how the previous staleness happened when staff
// changed on 12 Aug 2026.
import { q, one, audit, requirePerm, err } from '../core.mjs';
import { publishRule, STAGES, GATES, effectiveStages, PRODUCTION_PATHS } from '../pipeline_rules.mjs';
export { publishRule, STAGES, GATES, effectiveStages };

// Sign a gate. Idempotent per (script, gate) via the unique constraint; the
// FIRST signature stands and a repeat sign is a no-op, so nobody can
// quietly re-attribute an existing signature.
export async function signGate(scriptId, gate, { signedBy = null, note = null, signedRole = null } = {}) {
  if (!GATES.includes(gate)) throw new Error(`unknown gate ${gate}`);
  await q(`INSERT INTO lcos.script_gates (script_id, gate, signed_by, note, signed_role)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (script_id, gate) DO NOTHING`,
    [scriptId, gate, signedBy, note, signedRole]);
  return true;
}

// The medical-sign-off reset (kickoff brief defect 1, and a deliberate
// BEHAVIOUR CHANGE from letenav2): when medically meaningful content
// changes after medical review, the sign-off no longer describes the text
// it signed, so it is withdrawn. Deletes the medical_review and
// clinical_signoff gate rows, resets validation, drops an approved or
// in-review script back to DRAFT, rolls the stage back to script when the
// piece had moved past medical_review, and cancels open clinical review
// tasks whose content hash is now stale. Every removal is audit-logged.
export async function invalidateMedicalSignoff(scriptId, { actor = null, reason = null } = {}) {
  const gates = (await q(
    `DELETE FROM lcos.script_gates WHERE script_id=$1 AND gate IN ('medical_review','clinical_signoff')
     RETURNING gate`, [scriptId])).rows;
  const s = await one(`SELECT * FROM lcos.scripts WHERE id=$1`, [scriptId]);
  await q(
    `UPDATE lcos.scripts SET validation_result='NOT_RUN',
       status = CASE WHEN status IN ('APPROVED','VALIDATED','CLINICAL_REVIEW','LANGUAGE_REVIEW')
                     THEN 'DRAFT'::lcos.script_status ELSE status END,
       stage = CASE WHEN stage IN ('medical_review','shoot','edit','approve','publish')
                    THEN 'script' ELSE stage END
     WHERE id=$1`, [scriptId]);
  await q(`UPDATE lcos.review_tasks SET status='CANCELLED'
           WHERE object_type='SCRIPT' AND object_id=$1 AND review_type IN ('CLINICAL_SCRIPT','CLINICAL_FINAL')
             AND status IN ('OPEN','IN_PROGRESS')`, [scriptId]);
  await audit(null, { actor: actor ?? { type: 'SYSTEM', label: 'medical-signoff-reset' },
    action: 'script.medical_signoff_invalidated', objectType: 'SCRIPT', objectId: scriptId,
    objectCode: s?.code ?? null,
    reason: reason ?? `content changed after review; gates withdrawn: ${gates.map(g => g.gate).join(', ') || 'none held'}` });
  return gates.length > 0;
}

// Which ROLE signs which gate, plus the permission that backs it (owner,
// 14 Aug 2026: "I sign off cause I have admin rights, but we also allow the
// proper letena roles to sign off respectively"). Content sign-off is the
// content lead; medical review is a Letena doctor (consulting_doctor or the
// medical director); clinical sign-off is the MEDICAL DIRECTOR role; the
// production gates are the producer; publish is the social lead. Admin can
// sign anything, because Nate does, but admin is the OVERRIDE and not the
// design, and an admin signature outside the declared role is recorded as
// signed_role='admin_override' so it is visible as one. Role slugs are
// resolved at runtime through user_roles, never a person's name: high-risk
// sign-off is whoever holds medical_director today, held as a role
// assignment, which is exactly how a staff change stays a data change.
export const GATE_SIGNERS = {
  plan: { roles: ['content_lead'], permission: 'script.write' },
  script: { roles: ['content_lead'], permission: 'script.write' },
  medical_review: { roles: ['consulting_doctor', 'medical_director'], permission: 'script.approve_clinical' },
  clinical_signoff: { roles: ['medical_director'], permission: 'script.approve_clinical' },
  produce: { roles: ['producer'], permission: 'production.request' },
  shoot: { roles: ['producer'], permission: 'production.request' },
  edit: { roles: ['producer'], permission: 'production.request' },
  approve: { roles: ['content_lead'], permission: 'script.approve_editorial' },
  publish: { roles: ['social_lead'], permission: 'publish.execute' },
  repurpose: { roles: ['content_lead'], permission: 'script.write' },
  measure: { roles: ['content_lead'], permission: 'script.write' },
};

// Can this actor sign this gate, and in what role? null when they cannot.
// Permission AND role must both hold; admin alone is the recorded override.
export function signerRoleFor(actor, gate) {
  const spec = GATE_SIGNERS[gate];
  if (!spec) return null;
  const roles = actor?.roles ?? [];
  const perms = actor?.permissions ?? [];
  const declaredRole = spec.roles.find((r) => roles.includes(r));
  if (declaredRole && perms.includes(spec.permission)) return declaredRole;
  if (roles.includes('admin')) return 'admin_override';
  return null;
}

export default async function routes(app) {
  // The board: every script grouped by stage, with its format, its signed
  // gates, and whether it can advance (and if not, why, in plain language,
  // because the daily user is Girum, the content lead, not a developer
  // (owner, 14 Aug 2026)).
  app.get('/pipeline/board', { preHandler: requirePerm('script.read') }, async () => {
    const rows = (await q(
      `SELECT s.id, s.code, s.status, s.stage, s.risk_tier, s.needs_clinical_signoff,
              s.production_path, s.validation_result, cc.title, cc.format_code, cc.video_family,
              cf.label AS format_label, cf.stages_applicable, cf.is_internal,
              array_remove(array_agg(g.gate), NULL) AS signed_gates
       FROM lcos.scripts s
       JOIN lcos.content_concepts cc ON cc.id = s.concept_id
       LEFT JOIN lcos.content_formats cf ON cf.code = cc.format_code
       LEFT JOIN lcos.script_gates g ON g.script_id = s.id
       GROUP BY s.id, cc.id, cf.code
       ORDER BY s.created_at DESC LIMIT 500`)).rows;
    const stages = Object.fromEntries(STAGES.map(st => [st, []]));
    for (const r of rows) {
      const applicable = effectiveStages(r.stages_applicable ?? STAGES, r.production_path);
      const signed = new Set(r.signed_gates ?? []);
      const nxt = nextApplicableStage(r.stage, applicable);
      let block = null;
      if (!nxt) block = 'This piece is at its final stage.';
      else if (!signed.has(r.stage)) block = `The ${r.stage} gate is not signed yet.`;
      // A flagged piece stops AT medical review until the clinical sign-off
      // is also signed (owner, 14 Aug 2026): it stops at the point where a
      // clinician is already looking at it, not at the very end.
      else if (r.stage === 'medical_review' && r.needs_clinical_signoff && !signed.has('clinical_signoff')) {
        block = 'This piece is abortion-adjacent: the clinical sign-off (medical director) must be signed before it can leave medical review.';
      }
      else if (nxt === 'publish') {
        const pr = publishRule(r, signed);
        if (!pr.ok) block = pr.reason;
      }
      const item = { ...r, signed_gates: [...signed], next_stage: nxt,
        can_advance: block === null, advance_block: block,
        stages_applicable: applicable };
      (stages[r.stage] ?? (stages[r.stage] = [])).push(item);
    }
    return { stages, stage_order: STAGES, total: rows.length };
  });

  // Sign a gate. Idempotent per (script, gate): the first signature stands.
  app.post('/pipeline/scripts/:id/gates/:gate', async (req, reply) => {
    const gate = String(req.params.gate);
    if (!GATE_SIGNERS[gate]) return reply.code(422).send(err(422, 'VALIDATION_ERROR', `unknown gate ${gate}`));
    const signedRole = signerRoleFor(req.actor, gate);
    if (!signedRole) {
      const spec = GATE_SIGNERS[gate];
      return reply.code(403).send(err(403, 'FORBIDDEN',
        `signing the ${gate} gate requires the ${spec.roles.join(' or ')} role (with ${spec.permission}); admin may override`));
    }
    const s = await one(`SELECT * FROM lcos.scripts WHERE id=$1`, [req.params.id]);
    if (!s) return reply.code(404).send(err(404, 'NOT_FOUND', 'script'));
    // The medical gate can only be signed over machine-validated content.
    // A doctor signing a script whose claims were never checked, or failed
    // the check, would make the human signature vouch for text the closed
    // claim universe rejected. Fails closed.
    if ((gate === 'medical_review' || gate === 'clinical_signoff') && s.validation_result !== 'PASS') {
      return reply.code(422).send(err(422, 'GUARD_FAILED',
        `Claim validation is ${s.validation_result ?? 'NOT_RUN'}. It must PASS before ${gate} can be signed.`,
        { guard: 'validationBeforeMedicalGate' }));
    }
    await signGate(s.id, gate, { signedBy: req.actor.id, note: req.body?.note ?? null, signedRole });
    await audit(null, { actor: req.actor, action: 'pipeline.gate_signed', objectType: 'SCRIPT',
      objectId: s.id, objectCode: s.code, reason: `${gate} as ${signedRole}` });
    return { ok: true, script_id: s.id, gate, signed_role: signedRole };
  });

  // Advance a piece to its next APPLICABLE stage. Server-side enforcement,
  // never trusting the caller: current gate must be signed; reaching
  // publish additionally requires the publish rule (signed medical_review,
  // plus clinical_signoff when abortion-adjacent).
  app.post('/pipeline/scripts/:id/advance', { preHandler: requirePerm('script.write') }, async (req, reply) => {
    const s = await one(`SELECT s.*, cc.format_code FROM lcos.scripts s
                         JOIN lcos.content_concepts cc ON cc.id=s.concept_id WHERE s.id=$1`,
      [req.params.id]);
    if (!s) return reply.code(404).send(err(404, 'NOT_FOUND', 'script'));
    const fmt = s.format_code
      ? await one(`SELECT stages_applicable, is_internal FROM lcos.content_formats WHERE code=$1`, [s.format_code])
      : null;
    const applicable = effectiveStages(fmt?.stages_applicable ?? STAGES, s.production_path);
    const next = nextApplicableStage(s.stage, applicable);
    if (!next) {
      return reply.code(422).send(err(422, 'GUARD_FAILED',
        'This piece is already at its final applicable stage.', { guard: 'finalStage' }));
    }
    // Sign-and-advance in one action, like the letenav2 board: when the
    // caller holds the current gate's permission and the gate is unsigned,
    // their advance click signs it. Callers who cannot sign it get a plain
    // refusal naming the gate.
    const signed = new Set((await q(`SELECT gate FROM lcos.script_gates WHERE script_id=$1`, [s.id]))
      .rows.map(r => r.gate));
    if (!signed.has(s.stage)) {
      const signedRole = signerRoleFor(req.actor, s.stage);
      if (signedRole
          && !(s.stage === 'medical_review' && s.validation_result !== 'PASS')) {
        await signGate(s.id, s.stage, { signedBy: req.actor.id,
          note: req.body?.note ?? 'signed on advance', signedRole });
        signed.add(s.stage);
      } else {
        const spec = GATE_SIGNERS[s.stage];
        return reply.code(422).send(err(422, 'GUARD_FAILED',
          `Cannot advance: the ${s.stage} gate is not signed, and signing it requires the ${spec.roles.join(' or ')} role` +
          (s.stage === 'medical_review' && s.validation_result !== 'PASS'
            ? ' plus a PASS from claim validation' : '') + '.',
          { guard: 'gateUnsigned' }));
      }
    }
    // Clinical sign-off blocks the EXIT from medical review on a flagged
    // piece (owner, 14 Aug 2026: "it should block the medical review from
    // being acccepted right?"). Better than letenav2, where the flag was
    // only checked at publish and a flagged piece sailed through review.
    // The publish-time check below stays as a backstop: belt and braces.
    if (s.stage === 'medical_review' && s.needs_clinical_signoff && !signed.has('clinical_signoff')) {
      return reply.code(422).send(err(422, 'GUARD_FAILED',
        'This piece is abortion-adjacent: the clinical sign-off (medical director role) must be signed before it can leave medical review.',
        { guard: 'clinicalSignoffBeforeMedicalExit' }));
    }
    if (next === 'publish') {
      const pr = publishRule(s, signed);
      if (!pr.ok) return reply.code(422).send(err(422, 'GUARD_FAILED', pr.reason, { guard: pr.guard }));
      if (fmt?.is_internal) {
        return reply.code(422).send(err(422, 'GUARD_FAILED',
          'This format is internal and never publishes.', { guard: 'internalFormat' }));
      }
    }
    await q(`UPDATE lcos.scripts SET stage=$2 WHERE id=$1`, [s.id, next]);
    await audit(null, { actor: req.actor, action: 'pipeline.advanced', objectType: 'SCRIPT',
      objectId: s.id, objectCode: s.code, fromState: s.stage, toState: next });
    return { ok: true, script_id: s.id, stage: next };
  });

  // Change a piece's production path (owner, 14 Aug 2026: DIGITAL by
  // default, LIVE optional, "The choice is made at plan time and is
  // changeable until production starts"). Refused once the piece is past
  // medical_review (production underway or done) or any production gate is
  // already signed. The format's production_paths bounds the choice:
  // aua_live is LIVE only, push_notification is NONE and skips production.
  app.post('/pipeline/scripts/:id/production-path', { preHandler: requirePerm('script.write') }, async (req, reply) => {
    const path = String(req.body?.path ?? '');
    if (!PRODUCTION_PATHS.includes(path)) {
      return reply.code(422).send(err(422, 'VALIDATION_ERROR', `path must be one of ${PRODUCTION_PATHS.join(', ')}`));
    }
    const s = await one(`SELECT s.*, cc.format_code FROM lcos.scripts s
                         JOIN lcos.content_concepts cc ON cc.id=s.concept_id WHERE s.id=$1`,
      [req.params.id]);
    if (!s) return reply.code(404).send(err(404, 'NOT_FOUND', 'script'));
    const fmt = s.format_code
      ? await one(`SELECT production_paths FROM lcos.content_formats WHERE code=$1`, [s.format_code])
      : null;
    const supported = fmt?.production_paths ?? ['DIGITAL', 'LIVE'];
    if (!supported.includes(path)) {
      return reply.code(422).send(err(422, 'GUARD_FAILED',
        `This format supports ${supported.join(', ')} only.`, { guard: 'formatSupportsPath' }));
    }
    if (STAGES.indexOf(s.stage) > STAGES.indexOf('medical_review')) {
      return reply.code(422).send(err(422, 'GUARD_FAILED',
        'Production has started or finished for this piece; the path can no longer change.',
        { guard: 'productionNotStarted' }));
    }
    const prodGate = await one(`SELECT gate FROM lcos.script_gates
                                WHERE script_id=$1 AND gate IN ('produce','shoot','edit') LIMIT 1`, [s.id]);
    if (prodGate) {
      return reply.code(422).send(err(422, 'GUARD_FAILED',
        `The ${prodGate.gate} gate is already signed; the path can no longer change.`,
        { guard: 'productionNotStarted' }));
    }
    await q(`UPDATE lcos.scripts SET production_path=$2 WHERE id=$1`, [s.id, path]);
    await audit(null, { actor: req.actor, action: 'pipeline.production_path_changed', objectType: 'SCRIPT',
      objectId: s.id, objectCode: s.code, fromState: s.production_path, toState: path });
    return { ok: true, script_id: s.id, production_path: path };
  });
}

// The stage a piece moves to when it advances, skipping stages the format
// marks not applicable. Exported for tests.
export function nextApplicableStage(stage, applicable) {
  const i = STAGES.indexOf(stage);
  if (i < 0) return null;
  for (let j = i + 1; j < STAGES.length; j++) {
    if (applicable.includes(STAGES[j])) return STAGES[j];
  }
  return null;
}
