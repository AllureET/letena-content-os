// Experiments + the weekly editorial intelligence report.
import crypto from 'node:crypto';
import { q, one, audit, requirePerm, err } from '../core.mjs';
import { invokeAgent } from '../ai/gateway.mjs';

const code = (p) => `${p}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

export default async function routes(app) {
  app.get('/experiments', { preHandler: requirePerm('analytics.read') }, async () => {
    const r = await q(
      `SELECT e.*, (SELECT count(*)::int FROM lcos.experiment_variants v WHERE v.experiment_id=e.id) AS variant_count
       FROM lcos.experiments e ORDER BY e.created_at DESC LIMIT 100`);
    return { items: r.rows };
  });

  app.post('/experiments', { preHandler: requirePerm('experiment.manage') }, async (req, reply) => {
    const { title, hypothesis, variable_tested, primary_metric, platform, minimum_sample } = req.body ?? {};
    if (!title || !hypothesis || !variable_tested || !primary_metric) {
      return reply.code(422).send(err(422, 'VALIDATION_ERROR',
        'title, hypothesis, variable_tested, primary_metric required'));
    }
    const e = await one(
      `INSERT INTO lcos.experiments (code, title, hypothesis, variable_tested, primary_metric,
         platform, minimum_sample, status, owner_user_id)
       VALUES ($1,$2,$3,$4,$5,$6::lcos.publish_platform,COALESCE($7,1000),'DESIGNED',$8) RETURNING *`,
      [code('EXP'), title, hypothesis, variable_tested, primary_metric,
       platform ?? null, minimum_sample, req.actor.id]);
    await audit(null, { actor: req.actor, action: 'experiment.create', objectType: 'EXPERIMENT',
      objectId: e.id, objectCode: e.code });
    return reply.code(201).send(e);
  });

  app.post('/experiments/:id/variants', { preHandler: requirePerm('experiment.manage') }, async (req, reply) => {
    const { label, description, is_control, published_content_id } = req.body ?? {};
    if (!label || !description) return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'label, description required'));
    const v = await one(
      `INSERT INTO lcos.experiment_variants (experiment_id, label, description, is_control, published_content_id)
       VALUES ($1,$2,$3,COALESCE($4,false),$5) RETURNING *`,
      [req.params.id, label, description, is_control, published_content_id ?? null]);
    return reply.code(201).send(v);
  });

  app.post('/experiments/:id/start', { preHandler: requirePerm('experiment.manage') }, async (req, reply) => {
    const nVariants = await one(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE is_control)::int AS controls
       FROM lcos.experiment_variants WHERE experiment_id=$1`, [req.params.id]);
    if (nVariants.n < 2 || nVariants.controls !== 1) {
      return reply.code(422).send(err(422, 'GUARD_FAILED',
        'An experiment needs at least two variants and exactly one control.', { guard: 'experimentShape' }));
    }
    const e = await one(
      `UPDATE lcos.experiments SET status='RUNNING', start_date=CURRENT_DATE WHERE id=$1 RETURNING *`,
      [req.params.id]);
    return e;
  });

  app.post('/experiments/:id/conclude', { preHandler: requirePerm('experiment.manage') }, async (req, reply) => {
    const { winner_variant_id, conclusion, confidence_note } = req.body ?? {};
    if (!conclusion) return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'conclusion required'));
    // Auto-attach measured values: the experiment's primary_metric maps to a
    // performance column; each variant with published content gets its
    // measured value and sample size filled before conclusion is recorded.
    const exp = await one(`SELECT * FROM lcos.experiments WHERE id=$1`, [req.params.id]);
    const METRIC_MAP = {
      '3s_view_rate': (m) => m.views ? Number(m.views_3s) / Number(m.views) : null,
      completion_rate: (m) => m.completion_rate != null ? Number(m.completion_rate) : null,
      views: (m) => m.views != null ? Number(m.views) : null,
      reach: (m) => m.reach != null ? Number(m.reach) : null,
      shares: (m) => m.shares != null ? Number(m.shares) : null,
      saves: (m) => m.saves != null ? Number(m.saves) : null,
      shares_per_1k: (m) => m.views ? (Number(m.shares) / Number(m.views)) * 1000 : null,
    };
    const metricFn = METRIC_MAP[exp?.primary_metric] ?? METRIC_MAP.views;
    const variants = (await q(
      `SELECT v.id, v.published_content_id FROM lcos.experiment_variants v WHERE v.experiment_id=$1`,
      [req.params.id])).rows;
    for (const v of variants) {
      if (!v.published_content_id) continue;
      const m = await one(
        `SELECT views, reach, views_3s, completion_rate, shares, saves FROM lcos.content_performance
         WHERE published_content_id=$1 AND granularity='LIFETIME' ORDER BY metric_date DESC LIMIT 1`,
        [v.published_content_id]);
      if (m) {
        const value = metricFn(m);
        await q(`UPDATE lcos.experiment_variants SET sample_size=$2, primary_metric_value=$3 WHERE id=$1`,
          [v.id, m.views, value == null ? null : Math.round(value * 10000) / 10000]);
      }
    }
    const e = await one(
      `UPDATE lcos.experiments SET status='CONCLUDED', end_date=CURRENT_DATE,
         winner_variant_id=$2, conclusion=$3, confidence_note=$4 WHERE id=$1 RETURNING *`,
      [req.params.id, winner_variant_id ?? null, conclusion, confidence_note ?? null]);
    await audit(null, { actor: req.actor, action: 'experiment.conclude', objectType: 'EXPERIMENT',
      objectId: e.id, objectCode: e.code, reason: conclusion });
    return e;
  });

  // ----- weekly editorial intelligence report (WF18) -----
  app.get('/analytics/weekly-report', { preHandler: requirePerm('analytics.read') }, async () => {
    const performance = (await q(
      `SELECT pc.platform, pc.language, pc.video_family, kc.code AS card_code,
              cp.views, cp.completion_rate, cp.shares, cp.saves,
              cs.reach_score, cs.education_score, cs.service_score, cs.composite_score
       FROM lcos.published_content pc
       JOIN lcos.knowledge_cards kc ON kc.id=pc.knowledge_card_id
       LEFT JOIN lcos.content_performance cp ON cp.published_content_id=pc.id AND cp.granularity='LIFETIME'
       LEFT JOIN lcos.content_scores cs ON cs.published_content_id=pc.id
       WHERE pc.published_at > now() - interval '28 days'
       ORDER BY cs.composite_score DESC NULLS LAST LIMIT 50`)).rows;
    const gaps = (await q(`SELECT * FROM lcos.v_coverage_gaps LIMIT 20`)).rows;
    const knowledgeGaps = (await q(
      `SELECT s.needs_knowledge_note, kc.code AS card_code FROM lcos.scripts s
       JOIN lcos.content_families cf ON cf.id=s.family_id
       JOIN lcos.knowledge_cards kc ON kc.id=cf.knowledge_card_id
       WHERE s.status='NEEDS_KNOWLEDGE' LIMIT 20`)).rows;
    const running = (await q(
      `SELECT code, title, variable_tested, primary_metric FROM lcos.experiments WHERE status='RUNNING'`)).rows;
    const report = await invokeAgent('editorial_analyst', {
      window_days: 28, performance, coverage_gaps: gaps,
      knowledge_gaps: knowledgeGaps, running_experiments: running,
    }, { objectType: 'REPORT', workflowCode: 'WF18' });
    return { generated_at: new Date().toISOString(), inputs: {
      pieces: performance.length, gaps: gaps.length,
      knowledge_gaps: knowledgeGaps.length, running_experiments: running.length }, report };
  });
}
