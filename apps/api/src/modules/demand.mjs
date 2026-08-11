// Demand module: ingest (HMAC, forbidden keys, EMR hints), de-identification,
// classification, embeddings, clustering, priority + coverage.
import crypto from 'node:crypto';
import { q, one, audit, requirePerm, err, setting } from '../core.mjs';
import { deidentify } from '../../../../packages/deid/src/index.mjs';
import { invokeAgent, embed, toVectorLiteral } from '../ai/gateway.mjs';
import { priorityScore, coverageState } from '../../../../packages/scoring/src/index.mjs';

const FORBIDDEN_KEYS = ['patient_id', 'matter_id', 'consult_id', 'alias', 'phone',
  'phone_number', 'name', 'full_name', 'email', 'telegram_id', 'platform_user_id', 'msisdn'];

export default async function routes(app) {
  // ----- ingest (open route; HMAC or bearer question.ingest) -----
  app.post('/ingest/questions', async (req, reply) => {
    const body = req.body ?? {};
    const questions = body.questions ?? [body];
    if (questions.length > 500) return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'max 500 per batch'));

    // Auth: HMAC signature (EMR exporter) or an authenticated user with question.ingest.
    const sig = req.headers['x-letena-signature'];
    if (sig) {
      const secret = process.env.LETENA_INGEST_SHARED_SECRET || 'dev-ingest-secret';
      const ts = req.headers['x-letena-timestamp'] ?? '';
      if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) {
        return reply.code(401).send(err(401, 'UNAUTHENTICATED', 'timestamp outside tolerance'));
      }
      const expect = 'sha256=' + crypto.createHmac('sha256', secret)
        .update(`${ts}.${JSON.stringify(req.body)}`).digest('hex');
      if (!crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(String(sig).padEnd(expect.length).slice(0, expect.length)))) {
        return reply.code(401).send(err(401, 'UNAUTHENTICATED', 'bad signature'));
      }
    } else if (!req.actor?.permissions?.includes('question.ingest')) {
      return reply.code(401).send(err(401, 'UNAUTHENTICATED', 'signature or question.ingest required'));
    }

    // Forbidden keys reject the WHOLE batch, deliberately loud: one leaked
    // field means the exporting job is misconfigured and the rest is suspect.
    for (let i = 0; i < questions.length; i++) {
      for (const k of Object.keys(questions[i])) {
        if (FORBIDDEN_KEYS.includes(k.toLowerCase())) {
          await audit(null, { actor: { type: 'SYSTEM', label: 'ingest' }, action: 'ingest.rejected_forbidden_key',
            objectType: 'INGEST_BATCH', reason: `record ${i} carried forbidden key ${k}` });
          return reply.code(422).send(err(422, 'VALIDATION_ERROR',
            `record ${i} contains forbidden key "${k}"; whole batch rejected`));
        }
      }
    }

    const batch = await one(
      `INSERT INTO lcos.ingest_batches (external_ref, channel, source_system, record_count, submitted_by)
       VALUES ($1, COALESCE($2,'OTHER')::lcos.ingest_channel, $3, $4, $5)
       ON CONFLICT (external_ref) DO UPDATE SET record_count = ingest_batches.record_count + EXCLUDED.record_count
       RETURNING id`,
      [body.batch_id ?? null, questions[0]?.channel ?? 'OTHER', sig ? 'letena.et' : 'manual',
       questions.length, req.actor?.id ?? null]);

    let accepted = 0, duplicates = 0, quarantined = 0;
    const ids = [];
    for (const item of questions) {
      const text = String(item.text ?? '').trim();
      if (text.length < 3 || text.length > 4000) continue;
      const hash = item.source_hash
        ?? crypto.createHash('sha256').update('adhoc:' + text).digest('hex');
      // De-identify IN MEMORY before any insert. Raw text is never stored.
      const deid = deidentify(text);
      const threshold = Number(await setting('deid.confidence_threshold', 0.85));
      const status = deid.confidence >= threshold ? 'DEIDENTIFIED' : 'QUARANTINED';
      if (status === 'QUARANTINED') quarantined++;
      try {
        const row = await one(
          `INSERT INTO lcos.audience_questions (batch_id, channel, source_hash, sanitized_text,
             language, status, deid_confidence, deid_redactions, quarantine_reason,
             category_hints, urgency_hint, captured_at)
           VALUES ($1, COALESCE($2,'OTHER')::lcos.ingest_channel, $3, $4,
             $5::lcos.content_language, $6::lcos.question_status, $7, $8, $9, $10, $11, COALESCE($12::timestamptz, now()))
           RETURNING id`,
          [batch.id, item.channel ?? null, hash, deid.text,
           ['EN','AM','OM','TI'].includes((item.language_hint ?? '').toUpperCase()) ? item.language_hint.toUpperCase() : null,
           status, deid.confidence, JSON.stringify(deid.redactions),
           status === 'QUARANTINED' ? 'low de-identification confidence' : null,
           item.category_hints ?? [], item.urgency_hint ?? null, item.captured_at ?? null]);
        accepted++; ids.push(row.id);
      } catch (e) {
        if (e.code === '23505') duplicates++; else throw e;
      }
    }
    await q(`UPDATE lcos.ingest_batches SET accepted_count=$2, quarantined_count=$3, rejected_count=$4 WHERE id=$1`,
      [batch.id, accepted, quarantined, duplicates]);
    return reply.code(202).send({ batch_id: batch.id, accepted, duplicates, quarantined, question_ids: ids });
  });

  // ----- questions -----
  app.get('/questions', { preHandler: requirePerm('question.read') }, async (req) => {
    const { status, channel, limit } = req.query;
    const r = await q(
      `SELECT aq.*, qc.topic_id, t.code AS topic_code, qc.intent, qc.urgency AS classified_urgency,
              qc.knowledge_card_id, kc.code AS card_code, qc.match_confidence
       FROM lcos.audience_questions aq
       LEFT JOIN lcos.question_classifications qc ON qc.question_id = aq.id
       LEFT JOIN lcos.topics t ON t.id = qc.topic_id
       LEFT JOIN lcos.knowledge_cards kc ON kc.id = qc.knowledge_card_id
       WHERE ($1::text IS NULL OR aq.status=$1::lcos.question_status)
         AND ($2::text IS NULL OR aq.channel=$2::lcos.ingest_channel)
       ORDER BY aq.captured_at DESC LIMIT LEAST(COALESCE($3::int, 50), 200)`,
      [status ?? null, channel ?? null, limit ?? null]);
    return { items: r.rows.map(({ embedding, ...rest }) => rest) };
  });

  app.get('/questions/quarantine', { preHandler: requirePerm('question.redact') }, async () => {
    const r = await q(`SELECT id, sanitized_text, deid_confidence, quarantine_reason, channel, captured_at
                       FROM lcos.audience_questions WHERE status='QUARANTINED' ORDER BY captured_at LIMIT 100`);
    return { items: r.rows };
  });
  app.post('/questions/:id/redact', { preHandler: requirePerm('question.redact') }, async (req, reply) => {
    const text = String(req.body?.sanitized_text ?? '').trim();
    if (text.length < 3) return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'sanitized_text required'));
    const row = await one(
      `UPDATE lcos.audience_questions SET sanitized_text=$2, status='DEIDENTIFIED',
         deid_confidence=1, quarantine_reason=NULL WHERE id=$1 AND status='QUARANTINED' RETURNING id`,
      [req.params.id, text]);
    if (!row) return reply.code(404).send(err(404, 'NOT_FOUND', 'not in quarantine'));
    await audit(null, { actor: req.actor, action: 'question.redacted', objectType: 'QUESTION', objectId: row.id });
    return { ok: true };
  });
  app.post('/questions/:id/reject', { preHandler: requirePerm('question.redact') }, async (req) => {
    await q(`UPDATE lcos.audience_questions SET status='PURGED', sanitized_text='[purged]' WHERE id=$1`,
      [req.params.id]);
    await audit(null, { actor: req.actor, action: 'question.purged', objectType: 'QUESTION', objectId: req.params.id });
    return { ok: true };
  });

  // ----- classification + embedding (WF03 equivalent, callable inline) -----
  app.post('/questions/:id/classify', async (req, reply) => {
    if (!req.actor?.permissions?.some(p => ['question.ingest', 'cluster.manage'].includes(p))) {
      return reply.code(403).send(err(403, 'FORBIDDEN', 'requires question.ingest'));
    }
    const result = await classifyQuestion(req.params.id);
    if (!result) return reply.code(404).send(err(404, 'NOT_FOUND', 'question not found or not deidentified'));
    return result;
  });

  app.get('/questions/search', { preHandler: requirePerm('question.read') }, async (req, reply) => {
    const text = req.query.semantic;
    if (!text) return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'semantic query required'));
    const v = toVectorLiteral(await embed(text));
    const r = await q(
      `SELECT id, sanitized_text, channel, captured_at, 1 - (embedding <=> $1::vector) AS similarity
       FROM lcos.audience_questions WHERE embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector LIMIT LEAST(COALESCE($2::int,20), 50)`,
      [v, req.query.k ?? null]);
    return { items: r.rows };
  });

  // ----- clusters -----
  app.get('/clusters', { preHandler: requirePerm('question.read') }, async () => {
    const r = await q(
      `SELECT qc.id, qc.code, qc.label_en, qc.label_am, qc.representative_question,
              qc.member_count, qc.last_seen_at, t.code AS topic_code, kc.code AS card_code
       FROM lcos.question_clusters qc
       LEFT JOIN lcos.topics t ON t.id=qc.topic_id
       LEFT JOIN lcos.knowledge_cards kc ON kc.id=qc.knowledge_card_id
       WHERE qc.is_active ORDER BY qc.member_count DESC LIMIT 200`);
    return { items: r.rows };
  });

  // ----- demand board -----
  app.post('/demand/recompute', { preHandler: requirePerm('settings.manage') }, async () => computeDemand());
  app.get('/demand/coverage-gaps', { preHandler: requirePerm('question.read') }, async () => {
    const r = await q(`SELECT * FROM lcos.v_coverage_gaps LIMIT 100`);
    return { items: r.rows };
  });
  app.get('/demand/priority', { preHandler: requirePerm('question.read') }, async () => {
    const r = await q(
      `SELECT tps.*, t.code AS topic_code, t.name_en, kc.code AS card_code
       FROM lcos.topic_priority_scores tps
       JOIN lcos.topics t ON t.id=tps.topic_id
       LEFT JOIN lcos.knowledge_cards kc ON kc.id=tps.knowledge_card_id
       WHERE tps.computed_for=(SELECT max(computed_for) FROM lcos.topic_priority_scores)
       ORDER BY tps.priority_score DESC LIMIT 100`);
    return { items: r.rows };
  });
}

// ---------- pipeline functions (exported for the orchestrator and tests) ----------
export async function classifyQuestion(questionId) {
  const question = await one(
    `SELECT * FROM lcos.audience_questions WHERE id=$1 AND status IN ('DEIDENTIFIED','CLASSIFIED')`,
    [questionId]);
  if (!question) return null;
  const topics = (await q(`SELECT code, name_en FROM lcos.topics WHERE is_active`)).rows;
  const cards = (await q(
    `SELECT id, code, canonical_question_en FROM lcos.knowledge_cards WHERE status='APPROVED'`)).rows;
  const hintMap = Object.fromEntries((await q(
    `SELECT emr_category, topic_code FROM lcos.emr_category_map WHERE topic_code IS NOT NULL`)).rows
    .map(r => [r.emr_category, r.topic_code]));

  const out = await invokeAgent('question_classifier', {
    question_text: question.sanitized_text,
    topics, cards: cards.map(c => ({ code: c.code, canonical_question_en: c.canonical_question_en })),
    emr_category_hints: question.category_hints, hint_topic_map: hintMap,
    urgency_hint: question.urgency_hint,
  }, { objectType: 'QUESTION', objectId: questionId, workflowCode: 'WF03' });

  // Never trust agent-invented codes: resolve against real rows, else null.
  const topic = out.topic_code ? await one(`SELECT id FROM lcos.topics WHERE code=$1`, [out.topic_code]) : null;
  const card = out.knowledge_card_code
    ? await one(`SELECT id FROM lcos.knowledge_cards WHERE code=$1 AND status='APPROVED'`, [out.knowledge_card_code]) : null;
  const segment = out.audience_segment_slug
    ? await one(`SELECT id FROM lcos.audience_segments WHERE slug=$1`, [out.audience_segment_slug]) : null;

  // EMR hint agreement boost.
  let conf = out.match_confidence;
  if (question.category_hints?.length && out.topic_code
      && question.category_hints.some(h => hintMap[h] === out.topic_code)) {
    conf = Math.min(1, conf + Number((await one(
      `SELECT value FROM lcos.settings WHERE key='emr.hint_confidence_boost'`))?.value ?? 0.15));
  }

  await q(
    `INSERT INTO lcos.question_classifications (question_id, topic_id, subtopic, intent, is_myth,
       myth_text, fear_expressed, urgency, clinical_risk, audience_segment_id, knowledge_card_id,
       match_confidence, content_value, content_opportunity, referral_relevant, sentiment, raw_output)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (question_id) DO UPDATE SET topic_id=EXCLUDED.topic_id,
       knowledge_card_id=EXCLUDED.knowledge_card_id, match_confidence=EXCLUDED.match_confidence,
       raw_output=EXCLUDED.raw_output`,
    [questionId, topic?.id ?? null, out.subtopic ?? null, out.intent, out.is_myth,
     out.myth_text ?? null, out.fear_expressed ?? null, out.urgency, out.clinical_risk,
     segment?.id ?? null, card?.id ?? null, conf, out.content_value,
     out.content_opportunity ?? null, out.referral_relevant ?? false,
     out.sentiment ?? null, JSON.stringify(out)]);

  const vec = toVectorLiteral(await embed(question.sanitized_text));
  await q(`UPDATE lcos.audience_questions SET embedding=$2::vector, status='CLASSIFIED',
             language=COALESCE(language, $3::lcos.content_language)
           WHERE id=$1`, [questionId, vec, out.language]);
  await assignCluster(questionId, topic?.id ?? null, card?.id ?? null, question.sanitized_text, vec);
  return { question_id: questionId, ...out, match_confidence: conf,
    resolved: { topic: !!topic, card: card?.id ?? null } };
}

async function assignCluster(questionId, topicId, cardId, text, vecLiteral) {
  const dupT = Number(await setting('cluster.duplicate_threshold', 0.97));
  const simT = Number(await setting('cluster.similarity_threshold', 0.86));
  // Guard: same topic, and clinically-distinct clusters never absorb.
  const near = await one(
    `SELECT id, 1 - (centroid <=> $1::vector) AS sim FROM lcos.question_clusters
     WHERE centroid IS NOT NULL AND is_active
       AND ($2::uuid IS NULL OR topic_id IS NOT DISTINCT FROM $2::uuid)
       AND clinically_distinct_note IS NULL
       AND ($3::uuid IS NULL OR knowledge_card_id IS NULL OR knowledge_card_id=$3::uuid)
     ORDER BY centroid <=> $1::vector LIMIT 1`, [vecLiteral, topicId, cardId]);
  if (near && near.sim >= simT) {
    await q(`INSERT INTO lcos.question_cluster_members (cluster_id, question_id, similarity, relation)
             VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [near.id, questionId, Math.min(near.sim, 1), near.sim >= dupT ? 'DUPLICATE' : 'PARAPHRASE']);
  } else {
    const code = 'CL-' + crypto.randomUUID().slice(0, 8);
    const label = await invokeAgent('cluster_labeller',
      { questions: [text], topic_name: null }, { objectType: 'CLUSTER', workflowCode: 'WF04' })
      .catch(() => ({ label_en: text.slice(0, 60), label_am: null, representative_question: text }));
    const cl = await one(
      `INSERT INTO lcos.question_clusters (code, label_en, label_am, representative_question,
         topic_id, knowledge_card_id, centroid)
       VALUES ($1,$2,$3,$4,$5,$6,$7::vector) RETURNING id`,
      [code, label.label_en, label.label_am, label.representative_question, topicId, cardId, vecLiteral]);
    await q(`INSERT INTO lcos.question_cluster_members (cluster_id, question_id, similarity, relation)
             VALUES ($1,$2,1,'PARAPHRASE')`, [cl.id, questionId]);
  }
  await q(`UPDATE lcos.audience_questions SET status='CLUSTERED' WHERE id=$1`, [questionId]);
}

export async function computeDemand() {
  const weights = await setting('priority.weights',
    { volume: 0.28, growth: 0.20, unanswered: 0.14, coverage_gap: 0.18, clinical: 0.12, strategic: 0.08 });
  const rows = (await q(
    `SELECT t.id AS topic_id, t.clinical_weight, t.strategic_weight, qc.knowledge_card_id,
       count(*) FILTER (WHERE aq.captured_at > now() - interval '30 days')::int AS question_count_30d,
       count(*) FILTER (WHERE aq.captured_at BETWEEN now() - interval '60 days' AND now() - interval '30 days')::int AS question_count_prev_30d,
       count(*) FILTER (WHERE aq.captured_at > now() - interval '30 days' AND qc.knowledge_card_id IS NULL)::int AS unanswered_count
     FROM lcos.question_classifications qc
     JOIN lcos.audience_questions aq ON aq.id=qc.question_id
     JOIN lcos.topics t ON t.id=qc.topic_id
     GROUP BY t.id, t.clinical_weight, t.strategic_weight, qc.knowledge_card_id`)).rows;
  const content = Object.fromEntries((await q(
    `SELECT knowledge_card_id, count(*)::int AS n FROM lcos.published_content
     WHERE published_at > now() - interval '90 days' GROUP BY knowledge_card_id`)).rows
    .map(r => [r.knowledge_card_id, r.n]));
  const maxVol = Math.max(...rows.map(r => r.question_count_30d), 1);
  const today = new Date().toISOString().slice(0, 10);
  let inserted = 0;
  for (const r of rows) {
    const contentN = content[r.knowledge_card_id] ?? 0;
    const p = priorityScore({ ...r, content_count_90d: contentN,
      clinical_weight: Number(r.clinical_weight), strategic_weight: Number(r.strategic_weight),
      seasonal_factor: 1 }, weights, maxVol);
    await q(
      `INSERT INTO lcos.topic_priority_scores (computed_for, topic_id, knowledge_card_id,
         question_count_30d, question_count_prev_30d, growth_rate, unanswered_rate,
         content_count_90d, coverage_ratio, clinical_weight, strategic_weight,
         priority_score, gap_flag, formula_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'v1')
       ON CONFLICT (computed_for, topic_id, knowledge_card_id, audience_segment_id)
       DO UPDATE SET priority_score=EXCLUDED.priority_score, gap_flag=EXCLUDED.gap_flag`,
      [today, r.topic_id, r.knowledge_card_id,
       r.question_count_30d, r.question_count_prev_30d,
       p.components.growth_n, p.components.unanswered_n, contentN,
       p.components.coverage_gap, r.clinical_weight, r.strategic_weight,
       p.score, p.gap_flag]);
    const card = r.knowledge_card_id
      ? await one(`SELECT status, review_due_at FROM lcos.knowledge_cards WHERE id=$1`, [r.knowledge_card_id]) : null;
    const state = coverageState({
      has_approved_card: card?.status === 'APPROVED',
      card_expires_in_days: card?.review_due_at
        ? Math.round((new Date(card.review_due_at) - Date.now()) / 86400000) : null,
      question_count_30d: r.question_count_30d, content_count_90d: contentN });
    await q(
      `INSERT INTO lcos.coverage_snapshots (computed_for, knowledge_card_id, topic_id,
         has_approved_card, content_pieces_90d, coverage_state)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (computed_for, topic_id, knowledge_card_id) DO UPDATE SET coverage_state=EXCLUDED.coverage_state`,
      [today, r.knowledge_card_id, r.topic_id, card?.status === 'APPROVED', contentN, state]);
    inserted++;
  }
  return { computed_for: today, rows: inserted };
}
