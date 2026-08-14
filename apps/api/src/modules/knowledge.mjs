// Knowledge module: sources, claims, cards, versions, transitions.
import crypto from 'node:crypto';
import { q, one, tx, audit, requirePerm, err, transition } from '../core.mjs';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export default async function routes(app) {
  // ----- sources -----
  app.get('/knowledge/sources', { preHandler: requirePerm('knowledge.read') }, async (req) => {
    const r = await q(`SELECT * FROM lcos.medical_sources ORDER BY precedence, organisation LIMIT 200`);
    return { items: r.rows };
  });
  app.post('/knowledge/sources', { preHandler: requirePerm('source.manage') }, async (req, reply) => {
    const { code, organisation, title, source_type, precedence, version, url } = req.body ?? {};
    if (!code || !organisation || !title || !source_type || !precedence) {
      return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'code, organisation, title, source_type, precedence required'));
    }
    const s = await one(
      `INSERT INTO lcos.medical_sources (code, organisation, title, source_type, precedence, version, url, added_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [code, organisation, title, source_type, precedence, version ?? null, url ?? null, req.actor.id]);
    await audit(null, { actor: req.actor, action: 'source.create', objectType: 'MEDICAL_SOURCE',
      objectId: s.id, objectCode: code });
    return s;
  });
  app.post('/knowledge/sources/:id/supersede', { preHandler: requirePerm('source.manage') }, async (req) => {
    // The DB trigger cascades NEEDS_UPDATE onto dependent claims and cards.
    const s = await one(
      `UPDATE lcos.medical_sources SET status='SUPERSEDED', superseded_by_id=$2 WHERE id=$1 RETURNING *`,
      [req.params.id, req.body?.superseded_by_id ?? null]);
    await audit(null, { actor: req.actor, action: 'source.supersede', objectType: 'MEDICAL_SOURCE',
      objectId: req.params.id, objectCode: s?.code });
    return s;
  });

  // ----- claims -----
  app.get('/knowledge/claims', { preHandler: requirePerm('knowledge.read') }, async (req) => {
    const { status, topic_code } = req.query;
    const r = await q(
      `SELECT mc.*, t.code AS topic_code FROM lcos.medical_claims mc
       JOIN lcos.topics t ON t.id = mc.topic_id
       WHERE ($1::text IS NULL OR mc.status = $1::lcos.lifecycle_status)
         AND ($2::text IS NULL OR t.code = $2)
       ORDER BY mc.code LIMIT 500`, [status ?? null, topic_code ?? null]);
    return { items: r.rows };
  });
  app.post('/knowledge/claims', { preHandler: requirePerm('knowledge.draft') }, async (req, reply) => {
    const { code, topic_code, claim_text_en, claim_type, certainty } = req.body ?? {};
    if (!code || !topic_code || !claim_text_en) {
      return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'code, topic_code, claim_text_en required'));
    }
    const c = await one(
      `INSERT INTO lcos.medical_claims (code, topic_id, claim_text_en, claim_type, certainty, created_by)
       SELECT $1, t.id, $2, COALESCE($3,'FACT'), COALESCE($4,'ESTABLISHED'), $5
       FROM lcos.topics t WHERE t.code=$6 RETURNING *`,
      [code, claim_text_en, claim_type, certainty, req.actor.id, topic_code]);
    if (!c) return reply.code(422).send(err(422, 'VALIDATION_ERROR', `unknown topic ${topic_code}`));
    await audit(null, { actor: req.actor, action: 'claim.create', objectType: 'MEDICAL_CLAIM',
      objectId: c.id, objectCode: code });
    return c;
  });
  app.post('/knowledge/claims/:id/sources', { preHandler: requirePerm('knowledge.draft') }, async (req) => {
    await q(`INSERT INTO lcos.claim_sources (claim_id, source_id, locator, quote, is_primary, added_by)
             VALUES ($1,$2,$3,$4,COALESCE($5,false),$6) ON CONFLICT DO NOTHING`,
      [req.params.id, req.body.source_id, req.body.locator ?? null, req.body.quote ?? null,
       req.body.is_primary, req.actor.id]);
    return { ok: true };
  });
  app.post('/knowledge/claims/:id/transition', async (req, reply) => {
    return doTransition('medical_claim', req, reply);
  });

  // ----- cards -----
  app.get('/knowledge/cards', { preHandler: requirePerm('knowledge.read') }, async (req) => {
    const { status, expiring_within_days } = req.query;
    const r = await q(
      `SELECT kc.*, t.code AS topic_code,
        (SELECT count(*)::int FROM lcos.knowledge_card_claims k WHERE k.card_id=kc.id) AS claim_count
       FROM lcos.knowledge_cards kc JOIN lcos.topics t ON t.id=kc.topic_id
       WHERE ($1::text IS NULL OR kc.status=$1::lcos.lifecycle_status)
         AND ($2::int IS NULL OR kc.review_due_at <= CURRENT_DATE + ($2::int || ' days')::interval)
       ORDER BY kc.code LIMIT 500`, [status ?? null, expiring_within_days ?? null]);
    return { items: r.rows };
  });
  app.get('/knowledge/cards/:id', { preHandler: requirePerm('knowledge.read') }, async (req, reply) => {
    const card = await one(
      `SELECT kc.*, t.code AS topic_code FROM lcos.knowledge_cards kc
       JOIN lcos.topics t ON t.id=kc.topic_id
       WHERE kc.id::text=$1 OR kc.code=$1`, [req.params.id]);
    if (!card) return reply.code(404).send(err(404, 'NOT_FOUND', 'card not found'));
    const version = card.current_version_id
      ? await one(`SELECT * FROM lcos.knowledge_card_versions WHERE id=$1`, [card.current_version_id]) : null;
    const claims = (await q(
      `SELECT mc.*, kcc.is_core FROM lcos.knowledge_card_claims kcc
       JOIN lcos.medical_claims mc ON mc.id=kcc.claim_id WHERE kcc.card_id=$1
       ORDER BY kcc.sort_order`, [card.id])).rows;
    const sources = (await q(
      `SELECT DISTINCT ms.code, ms.organisation, ms.title, cs.locator, cs.quote, cs.claim_id
       FROM lcos.claim_sources cs JOIN lcos.medical_sources ms ON ms.id=cs.source_id
       WHERE cs.claim_id = ANY($1::uuid[])`, [claims.map(c => c.id)])).rows;
    return { ...card, version, claims, sources };
  });
  app.post('/knowledge/cards', { preHandler: requirePerm('knowledge.draft') }, async (req, reply) => {
    const { code, topic_code, canonical_question_en, risk_tier } = req.body ?? {};
    if (!code || !topic_code || !canonical_question_en) {
      return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'code, topic_code, canonical_question_en required'));
    }
    const c = await one(
      `INSERT INTO lcos.knowledge_cards (code, topic_id, canonical_question_en, risk_tier, created_by)
       SELECT $1, t.id, $2, COALESCE($3::lcos.risk_tier, t.default_risk_tier), $4
       FROM lcos.topics t WHERE t.code=$5 RETURNING *`,
      [code, canonical_question_en, risk_tier ?? null, req.actor.id, topic_code]);
    await audit(null, { actor: req.actor, action: 'card.create', objectType: 'KNOWLEDGE_CARD',
      objectId: c.id, objectCode: code });
    return c;
  });
  app.post('/knowledge/cards/:id/versions', { preHandler: requirePerm('knowledge.draft') }, async (req, reply) => {
    const { canonical_answer_en, prohibited_claims, referral_conditions, urgent_conditions,
      approved_ctas, change_summary } = req.body ?? {};
    if (!canonical_answer_en) return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'canonical_answer_en required'));
    return tx(async (client) => {
      const card = (await client.query(`SELECT * FROM lcos.knowledge_cards WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
      if (!card) return reply.code(404).send(err(404, 'NOT_FOUND', 'card'));
      const next = (await client.query(
        `SELECT COALESCE(max(version),0)+1 AS v FROM lcos.knowledge_card_versions WHERE card_id=$1`,
        [card.id])).rows[0].v;
      const v = (await client.query(
        `INSERT INTO lcos.knowledge_card_versions (card_id, version, canonical_answer_en,
           prohibited_claims, referral_conditions, urgent_conditions, approved_ctas,
           change_summary, content_sha256, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [card.id, next, canonical_answer_en,
         JSON.stringify(prohibited_claims ?? []), JSON.stringify(referral_conditions ?? []),
         JSON.stringify(urgent_conditions ?? []), JSON.stringify(approved_ctas ?? []),
         change_summary ?? null, sha(canonical_answer_en), req.actor.id])).rows[0];
      // Editing an approved card forces NEEDS_UPDATE. Silent edits are impossible.
      const newStatus = card.status === 'APPROVED' ? 'NEEDS_UPDATE' : card.status;
      await client.query(
        `UPDATE lcos.knowledge_cards SET current_version_id=$2, status=$3 WHERE id=$1`,
        [card.id, v.id, newStatus]);
      await audit(client, { actor: req.actor, action: 'card.version_created',
        objectType: 'KNOWLEDGE_CARD', objectId: card.id, objectCode: card.code,
        fromState: card.status, toState: newStatus });
      return v;
    });
  });
  app.post('/knowledge/cards/:id/claims', { preHandler: requirePerm('knowledge.draft') }, async (req) => {
    await q(`INSERT INTO lcos.knowledge_card_claims (card_id, claim_id, is_core, added_by)
             VALUES ($1,$2,COALESCE($3,true),$4) ON CONFLICT DO NOTHING`,
      [req.params.id, req.body.claim_id, req.body.is_core, req.actor.id]);
    return { ok: true };
  });
  app.post('/knowledge/cards/:id/transition', async (req, reply) => {
    return doTransition('knowledge_card', req, reply);
  });

  // One-click clinical approval of a card AND its pending facts (owner
  // decision, Aug 2026: doctors approve facts once; this is that click).
  // Approves every attached IN_REVIEW claim the doctor did not author, then
  // runs the card through the normal state machine so all its guards
  // (reviewer-not-author, all-claims-approved, has-version) still hold.
  //
  // Found live 14 Aug 2026 (Nate: "claims approved (0) but card blocked").
  // core.mjs's reviewerIsNotAuthor guard exempts admins (13 Aug fix, "a
  // small team sometimes has only one person to draft and clear a card"),
  // but this endpoint pre-selects claims with its own hand-rolled SQL
  // before that guard ever runs, and that query still hardcoded
  // `created_by <> actor`. For every card an admin authored themselves
  // (which is all 20 of the seeded/generated ones here), that silently
  // excluded every claim from the batch, so 0 got approved and the
  // transition's own all-claims-approved guard then blocked the card with
  // no indication why. Same admin exemption as the guard, applied here too.
  app.post('/knowledge/cards/:id/approve-with-claims',
    { preHandler: requirePerm('knowledge.approve') }, async (req, reply) => {
    const isAdmin = req.actor.roles?.includes('admin');
    const claims = (await q(
      `SELECT mc.id, mc.code FROM lcos.knowledge_card_claims kcc
       JOIN lcos.medical_claims mc ON mc.id=kcc.claim_id
       WHERE kcc.card_id=$1 AND mc.status IN ('DRAFT','IN_REVIEW') AND ($2::boolean OR mc.created_by <> $3)`,
      [req.params.id, isAdmin, req.actor.id])).rows;
    for (const cl of claims) {
      await q(`UPDATE lcos.medical_claims SET status='APPROVED', reviewed_by=$2,
                 reviewed_at=now(), review_due_at=CURRENT_DATE + interval '12 months',
                 updated_at=now() WHERE id=$1`, [cl.id, req.actor.id]);
      await audit(null, { actor: req.actor, action: 'claim.approved', objectType: 'MEDICAL_CLAIM',
        objectId: cl.id, objectCode: cl.code });
    }
    const card = await one(`SELECT status FROM lcos.knowledge_cards WHERE id=$1`, [req.params.id]);
    if (!card) return reply.code(404).send(err(404, 'NOT_FOUND', 'card'));
    if (card.status === 'APPROVED') return { ok: true, claims_approved: claims.length, card: 'already approved' };
    try {
      await transition('knowledge_card', req.params.id, 'APPROVED', {
        actor: req.actor, review_due_months: req.body?.review_due_months ?? 6,
        reason: 'Clinical approval of facts and card (one click)',
      });
    } catch (e) {
      const status = e.status ?? 500;
      return reply.code(status).send(err(status, e.code ?? 'INTERNAL',
        `claims approved (${claims.length}) but card blocked: ${e.message}`, { guard: e.guard }));
    }
    return { ok: true, claims_approved: claims.length, card: 'APPROVED' };
  });

  // Expiry sweep (WF19): overdue APPROVED cards and claims -> NEEDS_UPDATE
  // (the DB trigger cancels their scheduled publishes); cards inside the
  // 30-day window get a clinical review task if none is open.
  app.post('/knowledge/sweep-expiry', async (req, reply) => {
    const allowed = req.actor.permissions.includes('knowledge.approve')
      || req.actor.roles?.includes('automation') || req.actor.roles?.includes('admin');
    if (!allowed) return reply.code(403).send(err(403, 'FORBIDDEN', 'knowledge.approve or automation'));
    const expiredCards = (await q(
      `UPDATE lcos.knowledge_cards SET status='NEEDS_UPDATE'
       WHERE status='APPROVED' AND review_due_at < CURRENT_DATE RETURNING id, code`)).rows;
    const expiredClaims = (await q(
      `UPDATE lcos.medical_claims SET status='NEEDS_UPDATE'
       WHERE status='APPROVED' AND review_due_at < CURRENT_DATE RETURNING id, code`)).rows;
    const role = await one(`SELECT id FROM lcos.roles WHERE slug='medical_director'`);
    const expiring = (await q(
      `SELECT kc.id, kc.code FROM lcos.knowledge_cards kc
       WHERE kc.status='APPROVED' AND kc.review_due_at <= CURRENT_DATE + 30
         AND NOT EXISTS (SELECT 1 FROM lcos.review_tasks rt
           WHERE rt.review_type='KNOWLEDGE_CARD' AND rt.object_type='KNOWLEDGE_CARD'
             AND rt.object_id=kc.id AND rt.status IN ('OPEN','IN_PROGRESS'))`)).rows;
    for (const c of expiring) {
      await q(`INSERT INTO lcos.review_tasks (review_type, object_type, object_id, required_role_id, sla_hours)
               VALUES ('KNOWLEDGE_CARD','KNOWLEDGE_CARD',$1,$2,168)`, [c.id, role.id]);
    }
    for (const c of expiredCards) {
      await audit(null, { actor: req.actor, action: 'knowledge_card.expired', objectType: 'KNOWLEDGE_CARD',
        objectId: c.id, objectCode: c.code, fromState: 'APPROVED', toState: 'NEEDS_UPDATE',
        reason: 'review_due_at passed' });
    }
    return { expired_cards: expiredCards.map(c => c.code),
      expired_claims: expiredClaims.map(c => c.code),
      review_tasks_created: expiring.map(c => c.code) };
  });

  // The knowledge backlog generated by blocked scripts.
  app.get('/knowledge/needs-knowledge', { preHandler: requirePerm('knowledge.read') }, async () => {
    const r = await q(
      `SELECT s.id, s.code, s.needs_knowledge_note, s.created_at, cf.code AS family_code, kc.code AS card_code
       FROM lcos.scripts s
       JOIN lcos.content_families cf ON cf.id=s.family_id
       JOIN lcos.knowledge_cards kc ON kc.id=cf.knowledge_card_id
       WHERE s.status='NEEDS_KNOWLEDGE' ORDER BY s.created_at DESC LIMIT 100`);
    return { items: r.rows };
  });

  async function doTransition(machine, req, reply) {
    try {
      return await transition(machine, req.params.id, req.body?.to, {
        actor: req.actor, reason: req.body?.reason,
        review_due_months: req.body?.review_due_months,
        content_sha256: req.body?.content_sha256,
      });
    } catch (e) {
      const status = e.status ?? 500;
      return reply.code(status).send(err(status, e.code ?? 'INTERNAL', e.message, { guard: e.guard }));
    }
  }
}
