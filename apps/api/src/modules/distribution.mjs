// Distribution + analytics: publishing jobs, published content, performance,
// scores. Guards at publish time re-check the knowledge card is still APPROVED.
import crypto from 'node:crypto';
import { q, one, tx, audit, requirePerm, err } from '../core.mjs';
import { publishers, collectors, storage } from '../adapters/index.mjs';
import { getPlatformSpec, evaluateContent } from './platform_specs.mjs';
import { reachScore, educationScore, serviceScore, compositeScore } from '../../../../packages/scoring/src/index.mjs';
import { publishRule } from '../pipeline_rules.mjs';

const code = (p) => `${p}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

export default async function routes(app) {
  app.post('/distribution/jobs', { preHandler: requirePerm('publish.schedule') }, async (req, reply) => {
    const { render_id, platform, caption, scheduled_for } = req.body ?? {};
    const render = await one(`SELECT * FROM lcos.renders WHERE id=$1`, [render_id]);
    if (!render) return reply.code(404).send(err(404, 'NOT_FOUND', 'render'));
    if (render.status !== 'SUCCEEDED') {
      return reply.code(422).send(err(422, 'GUARD_FAILED', 'render has not succeeded', { guard: 'renderSucceeded' }));
    }
    // Final review approval must exist for this render.
    const approved = await one(
      `SELECT 1 FROM lcos.clinical_reviews WHERE render_id=$1 AND decision IN ('APPROVED','APPROVED_WITH_EDITS')`,
      [render.id]);
    if (!approved) {
      return reply.code(422).send(err(422, 'GUARD_FAILED', 'final render review approval missing',
        { guard: 'finalReviewApproved' }));
    }
    const account = await one(
      `SELECT * FROM lcos.platform_accounts WHERE platform=$1::lcos.publish_platform AND is_active
       ORDER BY is_primary DESC LIMIT 1`, [platform]);
    if (!account) return reply.code(422).send(err(422, 'VALIDATION_ERROR', `no account for ${platform}`));
    const script = await one(`SELECT * FROM lcos.scripts WHERE id=$1`, [render.script_id]);
    // Per-platform copy: explicit caption wins; else the script's
    // platform_variants block; else the base caption.
    const v = await one(
      `SELECT caption, hashtags, platform_variants FROM lcos.script_versions
       WHERE script_id=$1 AND version=$2`,
      [script.id, script.approved_version ?? script.current_version]);
    const variant = v?.platform_variants?.[platform] ?? {};
    const effectiveCaption = caption ?? variant.caption ?? v?.caption ?? null;
    // 2026 platform sizing: look up the target's spec (lcos.platform_specs,
    // admin-editable via GET/PUT /platform/specs) and flag -- never block --
    // a render whose duration or aspect ratio does not fit it. The spec and
    // any warnings ride along on the job's payload so the Queue screen (and
    // whatever renders next) can show them without a second lookup.
    const spec = await getPlatformSpec(platform);
    const warnings = evaluateContent(spec, { durationSeconds: render.duration_s, aspectRatio: render.aspect_ratio });
    const job = await one(
      `INSERT INTO lcos.publishing_jobs (code, render_id, family_id, platform, platform_account_id,
         status, scheduled_for, title, caption, hashtags, approved_by, approved_at, created_by, payload)
       VALUES ($1,$2,$3,$4::lcos.publish_platform,$5,'SCHEDULED',COALESCE($6::timestamptz, now()),
               $7,$8,COALESCE($9::text[],'{}'),$10,now(),$10,$11)
       RETURNING *`,
      [code('PUB'), render.id, script.family_id, platform, account.id, scheduled_for ?? null,
       variant.title ?? null, effectiveCaption, v?.hashtags ?? null, req.actor.id,
       JSON.stringify({ platform_spec: spec, warnings })]);
    await audit(null, { actor: req.actor, action: 'publish.schedule', objectType: 'PUBLISHING_JOB',
      objectId: job.id, objectCode: job.code, reason: warnings.length ? warnings.map(w => w.code).join(',') : null });
    return reply.code(201).send({ ...job, platform_spec: spec, warnings });
  });

  app.post('/distribution/jobs/:id/publish-now', { preHandler: requirePerm('publish.execute') }, async (req, reply) => {
    const result = await executePublish(req.params.id, req.actor);
    if (result.error) return reply.code(result.status).send(err(result.status, result.code, result.error, { guard: result.guard }));
    return result;
  });

  // Calendar: scheduled and published, by day, for the calendar screen.
  app.get('/distribution/calendar', { preHandler: requirePerm('publish.read') }, async (req) => {
    const from = req.query.from ?? new Date(Date.now() - 7 * 86400000).toISOString();
    const to = req.query.to ?? new Date(Date.now() + 21 * 86400000).toISOString();
    const scheduled = (await q(
      `SELECT pj.id, pj.code, pj.platform, pj.status, pj.scheduled_for, pj.caption,
              cf.code AS family_code, kc.code AS card_code, s.language, s.risk_tier
       FROM lcos.publishing_jobs pj
       JOIN lcos.content_families cf ON cf.id=pj.family_id
       JOIN lcos.knowledge_cards kc ON kc.id=cf.knowledge_card_id
       JOIN lcos.renders r ON r.id=pj.render_id
       JOIN lcos.scripts s ON s.id=r.script_id
       WHERE pj.status IN ('SCHEDULED','PUBLISHING','FAILED')
         AND pj.scheduled_for BETWEEN $1::timestamptz AND $2::timestamptz
       ORDER BY pj.scheduled_for`, [from, to])).rows;
    const published = (await q(
      `SELECT pc.id, pc.platform, pc.published_at, pc.platform_url, pc.language,
              cf.code AS family_code, kc.code AS card_code
       FROM lcos.published_content pc
       JOIN lcos.content_families cf ON cf.id=pc.family_id
       JOIN lcos.knowledge_cards kc ON kc.id=pc.knowledge_card_id
       WHERE pc.published_at BETWEEN $1::timestamptz AND $2::timestamptz
       ORDER BY pc.published_at DESC`, [from, to])).rows;
    return { scheduled, published };
  });

  // Due-jobs sweep for WF16: automation calls this every 5 minutes; each due
  // SCHEDULED job publishes through the normal guarded path.
  app.post('/distribution/publish-due', async (req, reply) => {
    if (!req.actor.permissions.includes('publish.execute')) {
      return reply.code(403).send(err(403, 'FORBIDDEN', 'publish.execute'));
    }
    const due = (await q(
      `SELECT id FROM lcos.publishing_jobs WHERE status='SCHEDULED'
         AND scheduled_for <= now() ORDER BY scheduled_for LIMIT 20`)).rows;
    const results = [];
    for (const j of due) {
      const r = await executePublish(j.id, req.actor);
      results.push({ job_id: j.id, ok: !r.error, detail: r.error ?? r.platform_post_id });
    }
    return { attempted: due.length, results };
  });

  // The whole draft-to-published picture in one call, for the Queue screen:
  // what awaits the batch click, what needs producing, what is ready to
  // publish (with caption + downloadable asset so any channel without an API
  // key can be posted by copy/paste), and what just went out.
  app.get('/distribution/queue', { preHandler: requirePerm('publish.read') }, async () => {
    const awaiting = (await q(
      `SELECT s.id, s.code, s.language, s.status, s.risk_tier, s.validation_result, s.created_at,
              cf.code AS family_code, kc.code AS card_code,
              sv.hook, sv.caption
       FROM lcos.scripts s
       JOIN lcos.content_families cf ON cf.id=s.family_id
       JOIN lcos.knowledge_cards kc ON kc.id=cf.knowledge_card_id
       LEFT JOIN lcos.script_versions sv ON sv.script_id=s.id AND sv.version=s.current_version
       WHERE s.status IN ('VALIDATED','LANGUAGE_REVIEW','CLINICAL_REVIEW') AND s.validation_result='PASS'
       ORDER BY s.created_at DESC LIMIT 100`)).rows;
    const toProduce = (await q(
      `SELECT s.id, s.code, s.language, s.risk_tier, s.created_at, cf.code AS family_code
       FROM lcos.scripts s JOIN lcos.content_families cf ON cf.id=s.family_id
       WHERE s.status='APPROVED' AND NOT EXISTS (
         SELECT 1 FROM lcos.production_jobs pj WHERE pj.script_id=s.id
           AND pj.status NOT IN ('FAILED','CANCELLED'))
       ORDER BY s.created_at DESC LIMIT 100`)).rows;
    const toPublish = (await q(
      `SELECT r.id AS render_id, r.script_id, r.storage_key, r.duration_s, r.created_at,
              s.code AS script_code, s.language, s.risk_tier, cf.code AS family_code,
              sv.caption, sv.hashtags, sv.platform_variants,
              EXISTS (SELECT 1 FROM lcos.clinical_reviews cr WHERE cr.render_id=r.id
                        AND cr.decision IN ('APPROVED','APPROVED_WITH_EDITS')) AS final_approved
       FROM lcos.renders r
       JOIN lcos.scripts s ON s.id=r.script_id
       JOIN lcos.content_families cf ON cf.id=s.family_id
       LEFT JOIN lcos.script_versions sv ON sv.script_id=s.id
         AND sv.version=COALESCE(s.approved_version, s.current_version)
       WHERE r.status='SUCCEEDED' AND NOT EXISTS (
         SELECT 1 FROM lcos.publishing_jobs pj WHERE pj.render_id=r.id AND pj.status <> 'FAILED')
       ORDER BY r.created_at DESC LIMIT 100`)).rows
      .map(r => ({ ...r, download_url: r.storage_key ? storage.url(r.storage_key) : null }));
    const recent = (await q(
      `SELECT pc.id, pc.platform, pc.published_at, pc.platform_url, cf.code AS family_code
       FROM lcos.published_content pc JOIN lcos.content_families cf ON cf.id=pc.family_id
       ORDER BY pc.published_at DESC LIMIT 20`)).rows;
    return { awaiting_approval: awaiting, to_produce: toProduce, to_publish: toPublish, recent };
  });

  app.get('/distribution/published', { preHandler: requirePerm('publish.read') }, async () => {
    const r = await q(
      `SELECT pc.*, cf.code AS family_code, kc.code AS card_code FROM lcos.published_content pc
       JOIN lcos.content_families cf ON cf.id=pc.family_id
       JOIN lcos.knowledge_cards kc ON kc.id=pc.knowledge_card_id
       ORDER BY pc.published_at DESC LIMIT 100`);
    return { items: r.rows };
  });

  app.get('/distribution/published/:id/lineage', { preHandler: requirePerm('publish.read') }, async (req, reply) => {
    const r = await one(`SELECT * FROM lcos.v_content_lineage WHERE published_content_id=$1`, [req.params.id]);
    if (!r) return reply.code(404).send(err(404, 'NOT_FOUND', 'published content'));
    return r;
  });

  // ----- analytics -----
  app.post('/analytics/collect/:publishedId', async (req, reply) => {
    if (!req.actor.permissions.some(p => ['analytics.read', 'workflow.operate'].includes(p))) {
      return reply.code(403).send(err(403, 'FORBIDDEN', 'analytics access required'));
    }
    const pc = await one(`SELECT * FROM lcos.published_content WHERE id=$1`, [req.params.publishedId]);
    if (!pc) return reply.code(404).send(err(404, 'NOT_FOUND', 'published content'));
    const { metrics, metrics_available } = await collectors.collect(pc.platform, pc.platform_post_id);
    const today = new Date().toISOString().slice(0, 10);
    const row = await one(
      `INSERT INTO lcos.content_performance (published_content_id, metric_date, granularity,
         views, reach, views_3s, avg_watch_time_s, completion_rate, likes, comments, shares, saves,
         link_clicks, questions_attributed, consultations_attributed, referrals_attributed, metrics_available)
       VALUES ($1,$2,'LIFETIME',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13,0),COALESCE($14,0),COALESCE($15,0),$16)
       ON CONFLICT (published_content_id, metric_date, granularity) DO UPDATE SET views=EXCLUDED.views,
         completion_rate=EXCLUDED.completion_rate, metrics_available=EXCLUDED.metrics_available
       RETURNING *`,
      [pc.id, today, metrics.views ?? null, metrics.reach ?? null, metrics.views_3s ?? null,
       metrics.avg_watch_time_s ?? null, metrics.completion_rate ?? null, metrics.likes ?? null,
       metrics.comments ?? null, metrics.shares ?? null, metrics.saves ?? null, metrics.link_clicks ?? null,
       req.body?.questions_attributed, req.body?.consultations_attributed, req.body?.referrals_attributed,
       metrics_available]);
    return row;
  });

  app.post('/analytics/scores/:publishedId', async (req, reply) => {
    if (!req.actor.permissions.includes('analytics.read')) {
      return reply.code(403).send(err(403, 'FORBIDDEN', 'analytics.read'));
    }
    const result = await computeScores(req.params.publishedId);
    if (!result) return reply.code(404).send(err(404, 'NOT_FOUND', 'no performance data'));
    return result;
  });

  app.get('/analytics/content', { preHandler: requirePerm('analytics.read') }, async () => {
    const r = await q(
      `SELECT pc.id, pc.platform, pc.published_at, cf.code AS family_code, kc.code AS card_code,
              cp.views, cp.completion_rate, cp.shares, cp.saves, cp.metrics_available,
              cs.reach_score, cs.education_score, cs.service_score, cs.composite_score
       FROM lcos.published_content pc
       JOIN lcos.content_families cf ON cf.id=pc.family_id
       JOIN lcos.knowledge_cards kc ON kc.id=pc.knowledge_card_id
       LEFT JOIN lcos.content_performance cp ON cp.published_content_id=pc.id AND cp.granularity='LIFETIME'
       LEFT JOIN lcos.content_scores cs ON cs.published_content_id=pc.id
       ORDER BY pc.published_at DESC LIMIT 100`);
    return { items: r.rows };
  });
}

export async function executePublish(jobId, actor) {
  const job = await one(`SELECT * FROM lcos.publishing_jobs WHERE id=$1`, [jobId]);
  if (!job) return { error: 'not found', status: 404, code: 'NOT_FOUND' };
  if (job.status !== 'SCHEDULED') {
    return { error: `job is ${job.status}`, status: 422, code: 'GUARD_FAILED', guard: 'jobScheduled' };
  }
  const render = await one(`SELECT * FROM lcos.renders WHERE id=$1`, [job.render_id]);
  const script = await one(`SELECT * FROM lcos.scripts WHERE id=$1`, [render.script_id]);
  const family = await one(`SELECT * FROM lcos.content_families WHERE id=$1`, [job.family_id]);
  // The card must STILL be approved at publish time. A card retired between
  // approval and publish blocks here.
  const card = await one(`SELECT * FROM lcos.knowledge_cards WHERE id=$1`, [family.knowledge_card_id]);
  if (card.status !== 'APPROVED') {
    await q(`UPDATE lcos.publishing_jobs SET status='CANCELLED', error_code='KNOWLEDGE_INVALIDATED' WHERE id=$1`, [job.id]);
    return { error: `knowledge card ${card.code} is ${card.status}; publish cancelled`,
      status: 422, code: 'GUARD_FAILED', guard: 'cardStillApproved' };
  }
  // The signed-gate side condition at the publish transition (Run One,
  // 14 Aug 2026): medical_review must be signed for every piece, and
  // clinical_signoff too when the piece is abortion-adjacent. The job is
  // NOT cancelled on refusal, unlike the card check above: an unsigned gate
  // is a pending human action, so the job stays SCHEDULED and publishes
  // normally once the signature exists. An edit to the script after review
  // deletes these rows (invalidateMedicalSignoff), so a stale sign-off can
  // never carry a changed piece through here.
  const signedGates = new Set((await q(
    `SELECT gate FROM lcos.script_gates WHERE script_id=$1`, [script.id])).rows.map(r => r.gate));
  const gateCheck = publishRule(script, signedGates);
  if (!gateCheck.ok) {
    return { error: gateCheck.reason, status: 422, code: 'GUARD_FAILED', guard: gateCheck.guard };
  }
  await q(`UPDATE lcos.publishing_jobs SET status='PUBLISHING', attempts=attempts+1 WHERE id=$1`, [job.id]);
  try {
    const publisher = publishers[job.platform];
    const out = await publisher({ job, videoUrl: render.storage_key ? storage.url(render.storage_key) : null });
    return tx(async (client) => {
      await client.query(`UPDATE lcos.publishing_jobs SET status='PUBLISHED' WHERE id=$1`, [job.id]);
      const segment = await client.query(`SELECT primary_segment_id, knowledge_card_version_id FROM lcos.content_families WHERE id=$1`, [family.id]);
      const concept = await client.query(
        `SELECT cc.video_family FROM lcos.content_concepts cc WHERE cc.id=$1`, [script.concept_id]);
      const pc = (await client.query(
        `INSERT INTO lcos.published_content (publishing_job_id, render_id, family_id, script_id,
           knowledge_card_id, knowledge_card_version_id, script_version, template_code, template_version,
           platform, platform_account_id, platform_post_id, platform_url, language, video_family,
           audience_segment_id, risk_tier, duration_s, published_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::lcos.publish_platform,$11,$12,$13,$14::lcos.content_language,
                 $15::lcos.video_family,$16,$17,$18, now()) RETURNING *`,
        [job.id, render.id, family.id, script.id, family.knowledge_card_id,
         segment.rows[0].knowledge_card_version_id, script.approved_version ?? script.current_version,
         render.template_code, render.template_version, job.platform, job.platform_account_id,
         out.platform_post_id, out.platform_url, script.language,
         concept.rows[0]?.video_family ?? 'V01_QUESTION_EXPLAINER',
         segment.rows[0].primary_segment_id, script.risk_tier, render.duration_s])).rows[0];
      await audit(client, { actor, action: 'publish.executed', objectType: 'PUBLISHED_CONTENT',
        objectId: pc.id, reason: `${job.platform} ${out.platform_post_id}` });
      return { published_content_id: pc.id, platform: job.platform,
        platform_post_id: out.platform_post_id, platform_url: out.platform_url };
    });
  } catch (e) {
    await q(`UPDATE lcos.publishing_jobs SET status='FAILED', error_detail=$2 WHERE id=$1`, [job.id, e.message]);
    await q(`INSERT INTO lcos.workflow_events (workflow_code, object_type, object_id, status, error_detail, owner_role)
             VALUES ('WF16','PUBLISHING_JOB',$1,'DEAD_LETTER',$2,'social_lead')`, [job.id, e.message]);
    return { error: e.message, status: 502, code: 'PROVIDER_ERROR' };
  }
}

export async function computeScores(publishedId) {
  const pc = await one(`SELECT * FROM lcos.published_content WHERE id=$1`, [publishedId]);
  const m = await one(
    `SELECT * FROM lcos.content_performance WHERE published_content_id=$1 AND granularity='LIFETIME'
     ORDER BY metric_date DESC LIMIT 1`, [publishedId]);
  if (!pc || !m) return null;
  const peersRaw = (await q(
    `SELECT cp.views, cp.completion_rate, cp.shares, cp.saves, cp.avg_watch_time_s, cp.link_clicks,
            cp.questions_attributed, cp.consultations_attributed, cp.referrals_attributed
     FROM lcos.content_performance cp
     JOIN lcos.published_content p ON p.id=cp.published_content_id
     WHERE p.platform=$1 AND cp.granularity='LIFETIME' AND p.id<>$2 LIMIT 500`,
    [pc.platform, publishedId])).rows;
  const per1k = (n, v) => n != null && v ? (n / v) * 1000 : null;
  const peers = {
    views: peersRaw.map(p => Number(p.views)).filter(Number.isFinite),
    completion_rate: peersRaw.map(p => Number(p.completion_rate)).filter(Number.isFinite),
    shares_per_1k: peersRaw.map(p => per1k(p.shares, p.views)).filter(v => v != null),
    saves_per_1k: peersRaw.map(p => per1k(p.saves, p.views)).filter(v => v != null),
    avg_watch_time_s: peersRaw.map(p => Number(p.avg_watch_time_s)).filter(Number.isFinite),
    c_rate: peersRaw.map(p => per1k(p.consultations_attributed, p.views)).filter(v => v != null),
    q_rate: peersRaw.map(p => per1k(p.questions_attributed, p.views)).filter(v => v != null),
    r_rate: peersRaw.map(p => per1k(p.referrals_attributed, p.views)).filter(v => v != null),
    click_rate: peersRaw.map(p => per1k(p.link_clicks, p.views)).filter(v => v != null),
  };
  const metrics = { views: Number(m.views), completion_rate: Number(m.completion_rate),
    shares: Number(m.shares), saves: Number(m.saves), avg_watch_time_s: Number(m.avg_watch_time_s),
    link_clicks: Number(m.link_clicks), questions_attributed: m.questions_attributed,
    consultations_attributed: m.consultations_attributed, referrals_attributed: m.referrals_attributed };
  const reach = reachScore(metrics, peers);
  const education = educationScore({ demand_match: 0.7, coverage_state_at_publish: 'UNDER_COVERED',
    myth_addressed: true, comprehension: null,
    avg_watch_time_s: metrics.avg_watch_time_s, spoken_duration_s: Number(pc.duration_s) || 30 });
  const service = serviceScore(metrics, peers);
  const composite = compositeScore(reach, education, service);
  const confidence = peersRaw.length < 10 ? 'LOW' : 'FULL';
  const today = new Date().toISOString().slice(0, 10);
  await q(
    `INSERT INTO lcos.content_scores (published_content_id, computed_for, reach_score,
       education_score, service_score, composite_score, confidence, formula_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'v1')
     ON CONFLICT (published_content_id, computed_for, window_days)
     DO UPDATE SET composite_score=EXCLUDED.composite_score, confidence=EXCLUDED.confidence`,
    [publishedId, today, reach, education, service, composite, confidence]);
  return { published_content_id: publishedId, reach_score: reach, education_score: education,
    service_score: service, composite_score: composite, confidence };
}
