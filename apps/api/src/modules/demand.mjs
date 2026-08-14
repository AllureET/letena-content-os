// Demand module: ingest (HMAC, forbidden keys, EMR hints), de-identification,
// classification, embeddings, clustering, priority + coverage.
import crypto from 'node:crypto';
import { q, one, audit, requirePerm, err, setting } from '../core.mjs';
import { deidentify } from '../../../../packages/deid/src/index.mjs';
import { invokeAgent, embed, toVectorLiteral } from '../ai/gateway.mjs';
import { priorityScore, coverageState } from '../../../../packages/scoring/src/index.mjs';

const FORBIDDEN_KEYS = ['patient_id', 'matter_id', 'consult_id', 'alias', 'phone',
  'phone_number', 'name', 'full_name', 'email', 'telegram_id', 'platform_user_id', 'msisdn'];

// Full-inquiry ingest (v2): a record may carry the clinician's answer and the
// back-and-forth beyond the opening message. Thread segments are strictly
// shaped so an exporter bug cannot smuggle an identifier in through a nested
// object: only these keys, only these roles. 'note' = clinical note
// (owner-approved as content material, Aug 2026).
const THREAD_ROLES = ['patient', 'doctor', 'note'];
const THREAD_KEYS = ['role', 'text', 'at'];
const MAX_THREAD_SEGMENTS = 60;

// Exact-match (after lowercasing + stripping .!?,\s) greeting/placeholder
// strings quarantined on sight, before classification ever runs -- see the
// longer comment at the ingest loop for why this exists and what it does
// NOT do (it is not spam detection). English, common Amharic greetings
// (native script and transliterated), and one known frontend placeholder
// string ("Ask a question") observed being submitted verbatim.
const GREETING_FILLER_SET = new Set([
  'hi', 'hii', 'hiii', 'hey', 'heyy', 'hello', 'helo', 'yo',
  'selam', 'slm', 'sls', 'selamu', 'salam', 'hay',
  'ሰላም', 'ጤና ይስጥልኝ', 'ጤናይስጥልኝ',
  'ask a question', 'question', 'test', 'testing',
]);

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
      // Sign over the RAW bytes the caller sent (PHP json_encode escaping
      // differs from JSON.stringify; re-serialization breaks the signature).
      const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body));
      const expect = 'sha256=' + crypto.createHmac('sha256', secret)
        .update(Buffer.concat([Buffer.from(`${ts}.`), raw])).digest('hex');
      if (!crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(String(sig).padEnd(expect.length).slice(0, expect.length)))) {
        return reply.code(401).send(err(401, 'UNAUTHENTICATED', 'bad signature'));
      }
    } else if (!req.actor?.permissions?.includes('question.ingest')) {
      return reply.code(401).send(err(401, 'UNAUTHENTICATED', 'signature or question.ingest required'));
    }

    // Forbidden keys reject the WHOLE batch, deliberately loud: one leaked
    // field means the exporting job is misconfigured and the rest is suspect.
    // The scan covers thread segments too, and segments are additionally held
    // to a strict shape (only role/text/at, only known roles) so a nested
    // object can never carry an identifier past the top-level key check.
    const rejectBatch = async (i, why) => {
      await audit(null, { actor: { type: 'SYSTEM', label: 'ingest' }, action: 'ingest.rejected_forbidden_key',
        objectType: 'INGEST_BATCH', reason: `record ${i}: ${why}` });
      return reply.code(422).send(err(422, 'VALIDATION_ERROR',
        `record ${i}: ${why}; whole batch rejected`));
    };
    for (let i = 0; i < questions.length; i++) {
      for (const k of Object.keys(questions[i])) {
        if (FORBIDDEN_KEYS.includes(k.toLowerCase())) {
          return rejectBatch(i, `contains forbidden key "${k}"`);
        }
      }
      const thread = questions[i].thread;
      if (thread !== undefined) {
        if (!Array.isArray(thread) || thread.length > MAX_THREAD_SEGMENTS) {
          return rejectBatch(i, `thread must be an array of at most ${MAX_THREAD_SEGMENTS} segments`);
        }
        for (const seg of thread) {
          if (typeof seg !== 'object' || seg === null || Array.isArray(seg)) {
            return rejectBatch(i, 'thread segment is not an object');
          }
          for (const k of Object.keys(seg)) {
            if (!THREAD_KEYS.includes(k)) return rejectBatch(i, `thread segment carries unexpected key "${k}"`);
          }
          if (!THREAD_ROLES.includes(seg.role)) return rejectBatch(i, `thread segment role must be one of ${THREAD_ROLES.join('/')}`);
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

    let accepted = 0, duplicates = 0, updated = 0, quarantined = 0;
    const ids = [];
    const threshold = Number(await setting('deid.confidence_threshold', 0.85));
    for (const item of questions) {
      const text = String(item.text ?? '').trim();
      if (text.length < 3 || text.length > 4000) continue;
      // Stopgap greeting/filler quarantine. This is NOT spam detection --
      // real spam and off-topic detection belongs to the AI classifier
      // (question_classifier), and only works once LCOS_AI_PROVIDER is set
      // to ANTHROPIC in Settings; the MOCK provider is keyword-based and
      // has no concept of "this isn't a real question." This deny-list only
      // catches the handful of exact greeting/placeholder strings observed
      // flooding Question clusters in practice (confirmed live 13 Aug 2026:
      // "Selam" x7, "Hii" x3, "Ask a question" x3 -- the last one is the
      // intake form's own placeholder text being submitted verbatim, a
      // separate frontend bug worth fixing at the source). It will miss
      // most real spam and most Amharic variants -- it is a bandage, not
      // the fix.
      const bare = text.toLowerCase().replace(/[.!?,\s]+/g, '');
      const isGreetingOrFiller = GREETING_FILLER_SET.has(bare);
      const hash = item.source_hash
        ?? crypto.createHash('sha256').update('adhoc:' + text).digest('hex');
      // De-identify IN MEMORY before any insert. Raw text is never stored.
      // Every part of the inquiry goes through the same scrubber: the opening
      // question, the clinician's answer, and each thread segment. One low
      // confidence anywhere quarantines the whole row; a partially-scrubbed
      // inquiry is not safer than a partially-scrubbed question.
      const deid = deidentify(text);
      let minConf = deid.confidence;

      const answerRaw = String(item.answer_text ?? '').trim();
      let answerText = null;
      if (answerRaw.length >= 3) {
        const d = deidentify(answerRaw.slice(0, 8000));
        answerText = d.text.slice(0, 8000);
        minConf = Math.min(minConf, d.confidence);
      }

      const threadClean = [];
      for (const seg of item.thread ?? []) {
        const segText = String(seg.text ?? '').trim();
        if (segText.length < 3) continue;
        const d = deidentify(segText.slice(0, 4000));
        minConf = Math.min(minConf, d.confidence);
        threadClean.push({ role: seg.role, text: d.text.slice(0, 4000) });
      }

      const consultMode = ['WRITTEN', 'PHONE'].includes(item.consult_mode) ? item.consult_mode : null;
      const status = isGreetingOrFiller ? 'QUARANTINED'
        : (minConf >= threshold ? 'DEIDENTIFIED' : 'QUARANTINED');
      const quarantineReason = isGreetingOrFiller ? 'greeting_or_placeholder_text'
        : (status === 'QUARANTINED' ? 'low de-identification confidence' : null);
      if (status === 'QUARANTINED') quarantined++;
      try {
        const row = await one(
          `INSERT INTO lcos.audience_questions (batch_id, channel, source_hash, sanitized_text,
             language, status, deid_confidence, deid_redactions, quarantine_reason,
             category_hints, urgency_hint, captured_at,
             answer_text, answered_at, thread, consult_mode)
           VALUES ($1, COALESCE($2,'OTHER')::lcos.ingest_channel, $3, $4,
             $5::lcos.content_language, $6::lcos.question_status, $7, $8, $9, $10, $11, COALESCE($12::timestamptz, now()),
             $13, $14::timestamptz, $15::jsonb, $16)
           RETURNING id`,
          [batch.id, item.channel ?? null, hash, deid.text,
           ['EN','AM','OM','TI'].includes((item.language_hint ?? '').toUpperCase()) ? item.language_hint.toUpperCase() : null,
           status, minConf, JSON.stringify(deid.redactions), quarantineReason,
           item.category_hints ?? [], item.urgency_hint ?? null, item.captured_at ?? null,
           answerText, item.answered_at ?? null, JSON.stringify(threadClean), consultMode]);
        accepted++; ids.push(row.id);
      } catch (e) {
        if (e.code !== '23505') throw e;
        // Same source_hash seen before. If this record brings substance the
        // stored row lacks (an answer, a fuller thread), attach it instead of
        // dropping it: this is how the archive's answers and the v2 exporter's
        // threads reach questions ingested earlier as bare text. A quarantined
        // record never updates a clean row.
        if (status !== 'QUARANTINED' && (answerText || threadClean.length)) {
          const row = await one(
            `UPDATE lcos.audience_questions SET
               answer_text  = COALESCE($2::text, answer_text),
               answered_at  = COALESCE($3::timestamptz, answered_at),
               thread       = CASE WHEN jsonb_array_length($4::jsonb) > jsonb_array_length(thread)
                                   THEN $4::jsonb ELSE thread END,
               consult_mode = COALESCE($5::text, consult_mode),
               updated_at   = now()
             WHERE source_hash = $1
               AND (($2::text IS NOT NULL AND answer_text IS DISTINCT FROM $2::text)
                    OR jsonb_array_length($4::jsonb) > jsonb_array_length(thread))
             RETURNING id`,
            [hash, answerText, item.answered_at ?? null, JSON.stringify(threadClean), consultMode]);
          if (row) { updated++; ids.push(row.id); continue; }
        }
        duplicates++;
      }
    }
    await q(`UPDATE lcos.ingest_batches SET accepted_count=$2, quarantined_count=$3, rejected_count=$4 WHERE id=$1`,
      [batch.id, accepted + updated, quarantined, duplicates]);
    return reply.code(202).send({ batch_id: batch.id, accepted, duplicates, updated, quarantined, question_ids: ids });
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
    // How many are still sitting at DEIDENTIFIED (ingested but not yet run
    // through classifyQuestion) -- the number "Classify pending questions"
    // will actually chew through. Without this the button gives no sense of
    // how much backlog is left after a click.
    const pendingCount = (await one(
      `SELECT count(*)::int AS n FROM lcos.audience_questions WHERE status='DEIDENTIFIED'`)).n;
    return { items: r.rows.map(({ embedding, ...rest }) => rest), pending_count: pendingCount };
  });

  // Question detail: the web app codes against this exact shape.
  app.get('/questions/:id', { preHandler: requirePerm('question.read') }, async (req, reply) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) {
      return reply.code(404).send(err(404, 'NOT_FOUND', 'question'));
    }
    const row = await one(
      `SELECT aq.id, aq.sanitized_text, aq.translation_en, aq.channel, aq.status, aq.captured_at,
              aq.consult_mode, aq.answer_text, aq.answer_translation_en, aq.thread,
              aq.category_hints, aq.urgency_hint, aq.deid_confidence,
              (qc.id IS NOT NULL) AS has_classification,
              t.code AS topic_code, qc.intent, qc.urgency,
              kc.code AS knowledge_card_code, qc.match_confidence
       FROM lcos.audience_questions aq
       LEFT JOIN lcos.question_classifications qc ON qc.question_id = aq.id
       LEFT JOIN lcos.topics t ON t.id = qc.topic_id
       LEFT JOIN lcos.knowledge_cards kc ON kc.id = qc.knowledge_card_id
       WHERE aq.id=$1`, [req.params.id]);
    if (!row) return reply.code(404).send(err(404, 'NOT_FOUND', 'question'));
    const { has_classification, topic_code, intent, urgency,
      knowledge_card_code, match_confidence, ...question } = row;
    return { question,
      classification: has_classification
        ? { topic_code, intent, urgency, knowledge_card_code, match_confidence } : null };
  });

  // Backfill: translate stored (already de-identified) Ethiopic-containing
  // questions that classification has not translated yet.
  app.post('/questions/translate-missing', { preHandler: requirePerm('settings.manage') }, async (req) => {
    const rows = (await q(
      `SELECT id FROM lcos.audience_questions
       WHERE status IN ('DEIDENTIFIED','CLASSIFIED','CLUSTERED')
         AND translation_en IS NULL AND sanitized_text ~ '[ሀ-፿]'
       ORDER BY captured_at DESC LIMIT LEAST(COALESCE($1::int, 50), 200)`,
      [req.body?.limit ?? null])).rows;
    let translated = 0;
    for (const r of rows) {
      if (await translateQuestion(r.id).catch(() => null)) translated++;
    }
    return { translated };
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

  // One-time cleanup for content ingested before two things were true: (1)
  // the greeting/placeholder quarantine at ingest existed, and (2) a real
  // AI provider was configured (was MOCK -- keyword classifier, trigram-hash
  // "embeddings" that only ever merge near-verbatim text, not real meaning).
  // classify-pending only ever picks up status='DEIDENTIFIED', so nothing
  // already at CLASSIFIED/CLUSTERED gets touched by it, no matter how many
  // times it runs or how good the AI provider now is -- confirmed live 13
  // Aug 2026 (switched to ANTHROPIC, backlog re-ran, but old junk clusters
  // like "[legacy phone consult notes] Reason: Consult" x114 and "Selam"
  // x7 stayed exactly as they were). This is the one-time fix: junk gets
  // quarantined and removed from its cluster; everything else gets its
  // cluster membership and classification cleared and its status reset to
  // DEIDENTIFIED so classify-pending picks it up again -- this time for
  // real, with whatever AI provider Settings is actually configured with.
  app.post('/questions/cleanup-and-requeue', { preHandler: requirePerm('settings.manage') }, async (req, reply) => {
    const rows = (await q(
      `SELECT id, sanitized_text FROM lcos.audience_questions
       WHERE status IN ('DEIDENTIFIED','CLASSIFIED','CLUSTERED')`)).rows;
    let quarantined = 0, requeued = 0;
    for (const row of rows) {
      const bare = row.sanitized_text.toLowerCase().trim().replace(/[.!?,\s]+/g, '');
      const isJunk = GREETING_FILLER_SET.has(bare)
        || /^\[legacy phone consult notes\]/i.test(row.sanitized_text.trim());
      await q(`DELETE FROM lcos.question_cluster_members WHERE question_id=$1`, [row.id]);
      if (isJunk) {
        await q(`DELETE FROM lcos.question_classifications WHERE question_id=$1`, [row.id]);
        await q(`UPDATE lcos.audience_questions SET status='QUARANTINED',
                   quarantine_reason='greeting_or_placeholder_text_cleanup', embedding=NULL
                 WHERE id=$1`, [row.id]);
        quarantined++;
      } else {
        await q(`DELETE FROM lcos.question_classifications WHERE question_id=$1`, [row.id]);
        await q(`UPDATE lcos.audience_questions SET status='DEIDENTIFIED', embedding=NULL WHERE id=$1`, [row.id]);
        requeued++;
      }
    }
    // Any cluster left with zero members (every member was junk, or was
    // requeued away) should stop showing up in the UI immediately rather
    // than lingering until something else happens to touch it.
    const deactivated = (await q(
      `UPDATE lcos.question_clusters SET is_active=false
       WHERE is_active AND member_count=0 RETURNING id`)).rows.length;
    await audit(null, { actor: req.actor, action: 'question.cleanup_and_requeue', objectType: 'INGEST_BATCH',
      reason: `${quarantined} quarantined, ${requeued} requeued, ${deactivated} clusters emptied` });
    return reply.code(202).send({ quarantined, requeued, clusters_deactivated: deactivated,
      note: requeued > 0
        ? `${requeued} real questions are back in the pending queue. Run "Classify pending questions" (maybe more than once) to reclassify and re-cluster them with the current AI provider.`
        : 'Nothing needed requeuing.' });
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
    // Same backlog signal as /questions: how many classified-but-unclustered
    // and not-yet-classified questions remain, so the screen can say how
    // much is left instead of just "here are however many clusters exist."
    const pendingCount = (await one(
      `SELECT count(*)::int AS n FROM lcos.audience_questions WHERE status='DEIDENTIFIED'`)).n;
    return { items: r.rows, pending_count: pendingCount };
  });

  // Bulk classification sweep. classifyQuestion() previously only ran when
  // someone opened one question and clicked it (or as a side effect of
  // Turn Into Content for that one question). With the EMR backfill landing
  // thousands of questions at once (BUILD_STATE.md, Aug 2026), the queue
  // piled up at DEIDENTIFIED and never reached a cluster or the gap board --
  // confirmed live 2026-08-12: one cluster total against thousands ingested.
  // This walks the backlog newest-first (matching the backfill's own
  // "freshest demand drives content first" policy) in a bounded batch so a
  // click (or a future cron) makes real progress without one uncapped call
  // running an unbounded number of AI classification calls.
  app.post('/questions/classify-pending', { preHandler: requirePerm('cluster.manage') }, async (req, reply) => {
    const result = await classifyPendingBatch(req.body?.limit);
    await audit(null, { actor: req.actor, action: 'question.bulk_classify', objectType: 'INGEST_BATCH',
      reason: `${result.classified}/${result.attempted} classified, ${result.quarantined_not_genuine} not genuine questions, ${result.failed} failed` });
    return reply.code(202).send(result);
  });

  // ----- demand board -----
  app.post('/demand/recompute', { preHandler: requirePerm('settings.manage') }, async () => computeDemand());
  app.get('/demand/coverage-gaps', { preHandler: requirePerm('question.read') }, async () => {
    const r = await q(`SELECT * FROM lcos.v_coverage_gaps LIMIT 100`);
    return { items: r.rows };
  });

  // Question volume per topic over time, for the Plan screen (Nate, 14 Aug
  // 2026: "analyze our past questions maybe by week/by month etc. And we can
  // get an understanding of how much of what content to make, then we can
  // decide what topic"). Everything downstream of this decision already
  // existed; what was missing was the decision itself having any evidence
  // behind it. Until now demand was a single frozen number,
  // question_count_30d, so you could not see that a topic doubled last month
  // or has been fading since March.
  //
  // Counts CLASSIFIED questions only (a question with no topic yet cannot be
  // attributed to one) and buckets on captured_at, the time the person
  // actually asked, not when the classifier happened to get to it, so a
  // backlog sweep does not create a fake spike on the day it ran.
  app.get('/demand/trend', { preHandler: requirePerm('question.read') }, async (req) => {
    // Whitelist, never interpolate: this value reaches date_trunc directly.
    const bucket = req.query?.bucket === 'month' ? 'month' : 'week';
    const periods = Math.min(Math.max(Number(req.query?.periods) || 12, 2), 52);
    const r = await q(
      `WITH buckets AS (
         SELECT generate_series(
           date_trunc($1, now()) - (($2::int - 1) || ' ' || $1)::interval,
           date_trunc($1, now()),
           ('1 ' || $1)::interval)::date AS bucket_start
       ),
       counts AS (
         SELECT qc.topic_id,
                date_trunc($1, aq.captured_at)::date AS bucket_start,
                count(*)::int AS n
         FROM lcos.audience_questions aq
         JOIN lcos.question_classifications qc ON qc.question_id = aq.id
         WHERE qc.topic_id IS NOT NULL
           AND aq.captured_at >= date_trunc($1, now()) - (($2::int - 1) || ' ' || $1)::interval
         GROUP BY qc.topic_id, 2
       )
       SELECT t.code AS topic_code, t.name_en AS topic_name, t.id AS topic_id,
              b.bucket_start, COALESCE(c.n, 0) AS n
       FROM lcos.topics t
       CROSS JOIN buckets b
       LEFT JOIN counts c ON c.topic_id = t.id AND c.bucket_start = b.bucket_start
       WHERE t.is_active
       ORDER BY t.sort_order, b.bucket_start`,
      [bucket, periods]);

    // Pivot to one row per topic with a dense series, so the client never has
    // to reconstruct missing buckets (a topic with no questions in week 3
    // must render a zero, not a gap, or the sparkline lies about the shape).
    const byTopic = new Map();
    for (const row of r.rows) {
      if (!byTopic.has(row.topic_code)) {
        byTopic.set(row.topic_code, { topic_code: row.topic_code, topic_name: row.topic_name,
          topic_id: row.topic_id, series: [], total: 0 });
      }
      const t = byTopic.get(row.topic_code);
      t.series.push({ bucket_start: row.bucket_start, n: row.n });
      t.total += row.n;
    }
    const items = [...byTopic.values()].map((t) => {
      const half = Math.floor(t.series.length / 2);
      const older = t.series.slice(0, half).reduce((a, x) => a + x.n, 0);
      const recent = t.series.slice(half).reduce((a, x) => a + x.n, 0);
      return { ...t, current: t.series[t.series.length - 1]?.n ?? 0,
        // Direction compares the recent half against the older half rather
        // than last bucket against previous: a single quiet week should not
        // read as a topic falling off.
        direction: recent > older ? 'UP' : recent < older ? 'DOWN' : 'FLAT',
        recent_half: recent, older_half: older };
    }).sort((a, b) => b.total - a.total);

    return { bucket, periods, buckets: [...new Set(r.rows.map(x => x.bucket_start))].sort(),
      items };
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
// Bounded batch of classify-pending work, shared by the route handler and
// the background sweep at the bottom of this file (added 14 Aug 2026:
// manual/browser-driven sweeping of the backlog measured ~10-11s/question,
// so clearing thousands of DEIDENTIFIED questions needed a real recurring
// job, not a click).
export async function classifyPendingBatch(limit = 100) {
  limit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const pending = (await q(
    `SELECT id FROM lcos.audience_questions WHERE status='DEIDENTIFIED'
     ORDER BY captured_at DESC LIMIT $1`, [limit])).rows;
  let classified = 0, quarantinedNotGenuine = 0;
  const failures = [];
  for (const row of pending) {
    try {
      const result = await classifyQuestion(row.id);
      if (result?.quarantined) quarantinedNotGenuine++;
      else if (result) classified++;
    } catch (e) {
      failures.push({ question_id: row.id, error: e.message });
    }
  }
  // Recompute the coverage-gap board in the same pass: it reads a
  // materialized snapshot (topic_priority_scores/coverage_snapshots), not
  // question_classifications live, so without this a freshly classified
  // batch would sit invisible on Coverage gaps until someone with
  // settings.manage separately clicked "Recompute now" -- confirmed live
  // 13 Aug 2026 (classified questions existed, board stayed empty). Only
  // bother if this batch actually classified something.
  if (classified > 0) await computeDemand().catch(() => null);
  const remaining = (await one(
    `SELECT count(*)::int AS n FROM lcos.audience_questions WHERE status='DEIDENTIFIED'`)).n;
  return { attempted: pending.length, classified, quarantined_not_genuine: quarantinedNotGenuine,
    failed: failures.length, failures: failures.slice(0, 10), remaining_pending: remaining };
}

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

  // thread/answer_text (migration 0004) are sent whenever the source consult
  // actually captured more than the opening message -- found live 13 Aug
  // 2026 that this was being silently dropped, so classification only ever
  // saw question_text even when a fuller exchange was on the row. Most rows
  // still won't have one (see the 0010 migration comment for why), but when
  // they do, the classifier needs to read the whole thing, not just the
  // opening line, to judge what was actually being asked.
  const out = await invokeAgent('question_classifier', {
    question_text: question.sanitized_text,
    thread: Array.isArray(question.thread) && question.thread.length ? question.thread : undefined,
    answer_text: question.answer_text || undefined,
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

  // Not a real question -- a greeting, an acknowledgment, a bare demographic
  // answer with no question attached, whatever the model judged this record
  // to actually be given what context it had (see migration 0010). The
  // classification above stays on record (so a human can see why), but the
  // question itself is quarantined rather than embedded/clustered/
  // translated: it has no content-demand signal to contribute, and letting
  // it through is exactly what produced junk single-message clusters like
  // "Eshi" and "Age 28, addis abeba" tonight.
  if (out.is_genuine_question === false) {
    await q(`UPDATE lcos.audience_questions SET status='QUARANTINED',
               quarantine_reason='not_a_genuine_question',
               language=COALESCE(language, $2::lcos.content_language)
             WHERE id=$1`, [questionId, out.language]);
    return { question_id: questionId, ...out, match_confidence: conf,
      resolved: { topic: false, card: null }, quarantined: true };
  }

  const vec = toVectorLiteral(await embed(question.sanitized_text));
  await q(`UPDATE lcos.audience_questions SET embedding=$2::vector, status='CLASSIFIED',
             language=COALESCE(language, $3::lcos.content_language)
           WHERE id=$1`, [questionId, vec, out.language]);
  await assignCluster(questionId, topic?.id ?? null, card?.id ?? null, question.sanitized_text, vec);

  // English translation for the clinical/editorial view. Runs strictly AFTER
  // classification succeeds and only over STORED fields, which are already
  // de-identified; nothing ever reaches translation before de-identification.
  // A translation failure never undoes a good classification; the
  // translate-missing backfill picks the row up later.
  if (out.language !== 'EN' || ETHIOPIC_RE.test(question.sanitized_text)) {
    await translateQuestion(questionId).catch(() => null);
  }
  return { question_id: questionId, ...out, match_confidence: conf,
    resolved: { topic: !!topic, card: card?.id ?? null } };
}

const ETHIOPIC_RE = /[ሀ-፿]/;

// Translate a stored (de-identified) question into English: sanitized_text ->
// translation_en, answer_text -> answer_translation_en, and each thread
// segment's text -> segment.translation_en, written back in one UPDATE.
export async function translateQuestion(questionId) {
  const question = await one(
    `SELECT id, sanitized_text, answer_text, thread FROM lcos.audience_questions WHERE id=$1`,
    [questionId]);
  if (!question) return null;
  const meta = { objectType: 'QUESTION', objectId: questionId, workflowCode: 'WF03' };
  const translate = async (text) =>
    (await invokeAgent('question_translator', { text }, meta)).translation_en;

  const translationEn = await translate(question.sanitized_text);
  const answerTranslationEn = question.answer_text ? await translate(question.answer_text) : null;
  const thread = [];
  for (const seg of Array.isArray(question.thread) ? question.thread : []) {
    thread.push(seg?.text
      ? { ...seg, translation_en: await translate(seg.text) }
      : { ...seg });
  }
  await q(
    `UPDATE lcos.audience_questions
     SET translation_en=$2, answer_translation_en=$3, thread=$4::jsonb, updated_at=now()
     WHERE id=$1`,
    [questionId, translationEn, answerTranslationEn, JSON.stringify(thread)]);
  return { question_id: questionId, translation_en: translationEn,
    answer_translation_en: answerTranslationEn, segments_translated: thread.filter(s => s.translation_en).length };
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

// ---------- background sweep (added 14 Aug 2026) ----------
// Clears the classify-pending backlog automatically so it doesn't require
// someone to keep a browser tab open and click a button every few minutes.
// Guarded against overlapping runs (a slow AI call could otherwise let two
// sweeps stack up) and against test runs (matches the NODE_ENV convention
// already used in server.mjs for the request logger).
let sweepRunning = false;
async function backgroundClassifySweep() {
  if (sweepRunning) return;
  sweepRunning = true;
  try {
    const result = await classifyPendingBatch(30);
    if (result.attempted > 0) {
      await audit(null, { actor: { type: 'SYSTEM', label: 'classify-sweep' },
        action: 'question.bulk_classify', objectType: 'INGEST_BATCH',
        reason: `scheduled sweep: ${result.classified}/${result.attempted} classified, ` +
          `${result.quarantined_not_genuine} not genuine, ${result.failed} failed, ` +
          `${result.remaining_pending} still pending` }).catch(() => null);
    }
  } catch (e) {
    // A bad interval tick must never crash the server -- swallow and retry
    // on the next tick.
  } finally {
    sweepRunning = false;
  }
}
if (process.env.NODE_ENV !== 'test') {
  setInterval(backgroundClassifySweep, 5 * 60 * 1000);
}
