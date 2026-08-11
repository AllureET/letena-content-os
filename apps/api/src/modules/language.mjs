// Language module: terminology database and the structured language review.
import crypto from 'node:crypto';
import { q, one, tx, audit, requirePerm, err } from '../core.mjs';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export default async function routes(app) {
  // ----- terminology -----
  app.get('/language/terminology', { preHandler: requirePerm('terminology.read') }, async (req) => {
    const r = await q(
      `SELECT t.*, tp.code AS topic_code FROM lcos.terminology t
       LEFT JOIN lcos.topics tp ON tp.id=t.topic_id
       WHERE ($1::text IS NULL OR t.status=$1::lcos.lifecycle_status)
         AND ($2::text IS NULL OR t.term_en ILIKE '%'||$2||'%' OR t.preferred_am ILIKE '%'||$2||'%')
       ORDER BY t.term_en LIMIT 300`, [req.query.status ?? null, req.query.q ?? null]);
    return { items: r.rows };
  });

  app.post('/language/terminology', { preHandler: requirePerm('terminology.manage') }, async (req, reply) => {
    const { term_en, preferred_am, formal_am, conversational_am, youth_am, avoid_am,
      avoid_reason, register, topic_code, clinical_context, notes } = req.body ?? {};
    if (!term_en || !preferred_am) {
      return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'term_en and preferred_am required'));
    }
    const t = await one(
      `INSERT INTO lcos.terminology (term_en, preferred_am, formal_am, conversational_am, youth_am,
         avoid_am, avoid_reason, register, topic_id, clinical_context, notes)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6::text[],'{}'),$7,COALESCE($8,'GENERAL'),
         (SELECT id FROM lcos.topics WHERE code=$9),$10,$11)
       ON CONFLICT (term_en, register) DO UPDATE SET preferred_am=EXCLUDED.preferred_am,
         avoid_am=EXCLUDED.avoid_am, status='DRAFT', updated_at=now()
       RETURNING *`,
      [term_en, preferred_am, formal_am ?? null, conversational_am ?? null, youth_am ?? null,
       avoid_am ?? null, avoid_reason ?? null, register ?? null, topic_code ?? null,
       clinical_context ?? null, notes ?? null]);
    await audit(null, { actor: req.actor, action: 'terminology.upsert', objectType: 'TERMINOLOGY',
      objectId: t.id, objectCode: term_en });
    return t;
  });

  app.post('/language/terminology/:id/approve', { preHandler: requirePerm('terminology.approve') }, async (req, reply) => {
    const t = await one(
      `UPDATE lcos.terminology SET status='APPROVED', reviewed_by=$2, reviewed_at=now()
       WHERE id=$1 AND status IN ('DRAFT','IN_REVIEW','NEEDS_UPDATE') RETURNING *`,
      [req.params.id, req.actor.id]);
    if (!t) return reply.code(404).send(err(404, 'NOT_FOUND', 'terminology entry not found or already approved'));
    await q(`INSERT INTO lcos.terminology_reviews (terminology_id, reviewer_id, decision, comment)
             VALUES ($1,$2,'APPROVED',$3)`, [t.id, req.actor.id, req.body?.comment ?? null]);
    await audit(null, { actor: req.actor, action: 'terminology.approve', objectType: 'TERMINOLOGY',
      objectId: t.id, objectCode: t.term_en });
    return t;
  });

  // ----- structured language review on a script -----
  // Completes the open LANGUAGE review task, records language_reviews with the
  // structured fields, applies edits as a translation update, and transitions
  // the script along the machine (which enforces tier rules).
  app.post('/content/scripts/:id/language-review', { preHandler: requirePerm('script.approve_language') },
    async (req, reply) => {
      const { decision, naturalness_score, meaning_preserved, corrected_amharic, comment } = req.body ?? {};
      if (!['APPROVED', 'APPROVED_WITH_EDITS', 'CHANGES_REQUESTED', 'REJECTED'].includes(decision)) {
        return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'bad decision'));
      }
      const s = await one(`SELECT * FROM lcos.scripts WHERE id=$1`, [req.params.id]);
      if (!s) return reply.code(404).send(err(404, 'NOT_FOUND', 'script'));
      const trans = await one(
        `SELECT * FROM lcos.translations WHERE object_type='SCRIPT' AND object_id=$1 AND language='AM'`, [s.id]);
      if (!trans) return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'no Amharic translation on this script'));
      if (decision.startsWith('APPROVED') && meaning_preserved === false) {
        return reply.code(422).send(err(422, 'GUARD_FAILED',
          'Cannot approve while marking meaning as not preserved.', { guard: 'meaningGate' }));
      }
      return tx(async (client) => {
        if (decision === 'APPROVED_WITH_EDITS' && corrected_amharic) {
          await client.query(
            `UPDATE lcos.translations SET translated_text=$2, content_sha256=$3,
               status='APPROVED', reviewed_by=$4, reviewed_at=now() WHERE id=$1`,
            [trans.id, corrected_amharic, sha(corrected_amharic), req.actor.id]);
        } else if (decision === 'APPROVED') {
          await client.query(
            `UPDATE lcos.translations SET status='APPROVED', reviewed_by=$2, reviewed_at=now() WHERE id=$1`,
            [trans.id, req.actor.id]);
        }
        await client.query(
          `INSERT INTO lcos.language_reviews (object_type, object_id, script_id, translation_id,
             reviewer_user_id, language, decision, naturalness_score, register_correct,
             meaning_preserved, corrected_text, comment, content_sha256)
           VALUES ('SCRIPT',$1,$1,$2,$3,'AM',$4,$5,true,$6,$7,$8,$9)`,
          [s.id, trans.id, req.actor.id, decision, naturalness_score ?? null,
           decision.startsWith('APPROVED'), corrected_amharic ?? null, comment ?? null,
           trans.content_sha256]);
        await client.query(
          `UPDATE lcos.review_tasks SET status='COMPLETED', completed_at=now(), assigned_to=$2
           WHERE review_type='LANGUAGE' AND object_type='SCRIPT' AND object_id=$1
             AND status IN ('OPEN','IN_PROGRESS')`, [s.id, req.actor.id]);
        await audit(client, { actor: req.actor, action: `language_review.${decision.toLowerCase()}`,
          objectType: 'SCRIPT', objectId: s.id, objectCode: s.code, reason: comment ?? null });
        return { ok: true, script_id: s.id, decision,
          next: decision.startsWith('APPROVED')
            ? (['TIER_3', 'TIER_4'].includes(s.risk_tier)
              ? 'script remains in CLINICAL_REVIEW for the clinician'
              : 'script may be approved editorially')
            : 'script returned to the writer' };
      });
    });
}
