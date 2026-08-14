// Production module: assets, production jobs, router, renders via adapters.
import crypto from 'node:crypto';
import { q, one, audit, requirePerm, err, setting } from '../core.mjs';
import { creatomate, heygen, kling, tts, gemini, canva, storage } from '../adapters/index.mjs';
import { formatOf, hasAudio } from '../formats.mjs';
import { embed, toVectorLiteral } from '../ai/gateway.mjs';

const code = (p) => `${p}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

// Format -> engine routing. Kling/Gemini generate b-roll assets, never the
// final render; Canva handles carousel/static; Creatomate assembles video;
// HeyGen only for the presenter family and never at TIER_4.
// Pre-0018 scripts have no post_text, so fall back to what a post would have
// been assembled from before the format work.
function bodyFallbackForPost(v) {
  return [v.hook, v.spoken_script, v.cta].filter(Boolean).join('\n\n');
}

const ROUTE = {
  V01_QUESTION_EXPLAINER: { engine: 'CREATOMATE', template: 'LETENA_QA_30S_V1' },
  V02_CHAT_STORY: { engine: 'CREATOMATE', template: 'LETENA_CHAT_35S_V1' },
  V03_ILLUSTRATED_SCENARIO: { engine: 'CREATOMATE', template: 'LETENA_STORY_40S_V1', gen: 'GEMINI' },
  V04_MEDICAL_VISUAL_EXPLAINER: { engine: 'CREATOMATE', template: 'LETENA_MEDVIS_45S_V1', libraryOnly: true },
  V05_DIGITAL_PRESENTER: { engine: 'HEYGEN', template: 'LETENA_PRESENTER_V1', blockTier: 'TIER_4' },
  V06_REAL_ETHIOPIA_HYBRID: { engine: 'CREATOMATE', template: 'LETENA_BROLL_30S_V1', gen: 'KLING' },
  C01_CAROUSEL: { engine: 'MANUAL_UPLOAD', design: 'CANVA' },
  C02_STATIC_GRAPHIC: { engine: 'MANUAL_UPLOAD', design: 'CANVA' },
  C03_TELEGRAM_POST: { engine: 'MANUAL_UPLOAD' },
};

export default async function routes(app) {
  app.get('/production/jobs', { preHandler: requirePerm('production.read') }, async () => {
    const r = await q(
      `SELECT pj.*, s.code AS script_code, vt.code AS template_code FROM lcos.production_jobs pj
       JOIN lcos.scripts s ON s.id=pj.script_id
       LEFT JOIN lcos.video_templates vt ON vt.id=pj.template_id
       ORDER BY pj.created_at DESC LIMIT 100`);
    return { items: r.rows };
  });

  app.post('/production/jobs', { preHandler: requirePerm('production.request') }, async (req, reply) => {
    const { script_id } = req.body ?? {};
    const s = await one(`SELECT * FROM lcos.scripts WHERE id=$1`, [script_id]);
    if (!s) return reply.code(404).send(err(404, 'NOT_FOUND', 'script'));
    if (s.status !== 'APPROVED') {
      return reply.code(422).send(err(422, 'GUARD_FAILED',
        'Only APPROVED scripts enter production.', { guard: 'scriptApproved' }));
    }
    const job = await createProductionJob(s, req.actor);
    return reply.code(201).send(job);
  });

  app.post('/production/jobs/:id/run', async (req, reply) => {
    if (!req.actor.permissions.some(p => ['production.request', 'workflow.operate'].includes(p))) {
      return reply.code(403).send(err(403, 'FORBIDDEN', 'production.request required'));
    }
    const result = await runProductionJob(req.params.id, req.actor);
    if (!result) return reply.code(404).send(err(404, 'NOT_FOUND', 'job'));
    return result;
  });

  app.get('/production/renders/:id', { preHandler: requirePerm('production.read') }, async (req, reply) => {
    const r = await one(`SELECT * FROM lcos.renders WHERE id=$1`, [req.params.id]);
    if (!r) return reply.code(404).send(err(404, 'NOT_FOUND', 'render'));
    return { ...r, preview_url: r.storage_key ? storage.url(r.storage_key) : null };
  });

  app.post('/production/renders/:id/approve', { preHandler: requirePerm('production.approve_final') }, async (req, reply) => {
    const r = await one(`SELECT * FROM lcos.renders WHERE id=$1`, [req.params.id]);
    if (!r) return reply.code(404).send(err(404, 'NOT_FOUND', 'render'));
    if (r.status !== 'SUCCEEDED') {
      // A failed render can never be approved into a publishable asset.
      return reply.code(422).send(err(422, 'GUARD_FAILED',
        `Render is ${r.status}; only SUCCEEDED renders can be approved.`, { guard: 'renderSucceeded' }));
    }
    const s = await one(`SELECT * FROM lcos.scripts WHERE id=$1`, [r.script_id]);
    // TIER_4 final render approval requires the medical director.
    if (s.risk_tier === 'TIER_4') {
      const ok = req.actor.roles?.some(x => ['medical_director', 'admin'].includes(x));
      if (!ok) return reply.code(403).send(err(403, 'FORBIDDEN', 'Tier 4 final approval requires the medical director.'));
    }
    await q(`INSERT INTO lcos.clinical_reviews (object_type, object_id, render_id, script_id,
               reviewer_user_id, reviewer_role, decision, risk_tier_at_review, content_sha256)
             VALUES ('RENDER',$1,$1,$2,$3,$4,'APPROVED',$5,$6)`,
      [r.id, r.script_id, req.actor.id, req.actor.roles?.[0] ?? 'unknown', s.risk_tier,
       crypto.createHash('sha256').update(r.storage_key ?? r.id).digest('hex')]);
    await audit(null, { actor: req.actor, action: 'render.approve', objectType: 'RENDER', objectId: r.id });
    return { ok: true, render_id: r.id, next: 'create publishing job' };
  });

  app.get('/production/assets', { preHandler: requirePerm('asset.read') }, async () => {
    const r = await q(`SELECT id, code, kind, origin, title, is_ai_generated, clinically_approved,
                        storage_key, created_at FROM lcos.assets WHERE is_active ORDER BY created_at DESC LIMIT 200`);
    return { items: r.rows };
  });
}

export async function createProductionJob(script, actor) {
  const concept = await one(`SELECT * FROM lcos.content_concepts WHERE id=$1`, [script.concept_id]);
  const route = ROUTE[concept.video_family] ?? ROUTE.V01_QUESTION_EXPLAINER;
  if (route.blockTier && script.risk_tier === route.blockTier) {
    throw Object.assign(new Error(`${concept.video_family} is not permitted at ${script.risk_tier}`),
      { status: 422, code: 'GUARD_FAILED' });
  }
  const template = route.template
    ? await one(`SELECT * FROM lcos.video_templates WHERE code=$1 AND status='APPROVED'`, [route.template]) : null;
  const aiVoiceTiers = await setting('voice.ai_allowed_tiers', ['TIER_1', 'TIER_2']);
  // A carousel, a static graphic and a Telegram post are read, not heard.
  // Until 14 Aug 2026 nothing asked, so all three were routed AI_TTS and
  // every one of them spent a real ElevenLabs generation on audio that no
  // surface would ever play.
  const voice = !hasAudio(concept.video_family) ? 'NONE'
    : script.language === 'AM' && !aiVoiceTiers.includes(script.risk_tier) ? 'HUMAN' : 'AI_TTS';
  const job = await one(
    `INSERT INTO lcos.production_jobs (code, script_id, family_id, template_id, engine, status,
       routing_reason, voice_source, requested_by)
     VALUES ($1,$2,$3,$4,$5::lcos.render_engine,'QUEUED',$6,$7,$8) RETURNING *`,
    [code('PJ'), script.id, script.family_id, template?.id ?? null, route.engine,
     `${concept.video_family} -> ${route.engine}${route.libraryOnly ? ' (library-only assets)' : ''}`,
     voice, actor?.id ?? null]);
  await audit(null, { actor, action: 'production_job.create', objectType: 'PRODUCTION_JOB',
    objectId: job.id, objectCode: job.code });
  return job;
}

export async function runProductionJob(jobId, actor) {
  const job = await one(`SELECT * FROM lcos.production_jobs WHERE id=$1`, [jobId]);
  if (!job) return null;
  const script = await one(`SELECT * FROM lcos.scripts WHERE id=$1`, [job.script_id]);
  const v = await one(`SELECT * FROM lcos.script_versions WHERE script_id=$1 AND version=$2`,
    [script.id, script.approved_version ?? script.current_version]);
  const template = job.template_id
    ? await one(`SELECT * FROM lcos.video_templates WHERE id=$1`, [job.template_id]) : null;
  const concept = await one(`SELECT * FROM lcos.content_concepts WHERE id=$1`, [script.concept_id]);

  await q(`UPDATE lcos.production_jobs SET status='RENDERING', attempts=attempts+1 WHERE id=$1`, [job.id]);

  // Voice first (AI path via ElevenLabs when permitted; human voice must
  // already be attached as voice_asset_id otherwise). GOVERNANCE GATE: an
  // Amharic translation may only be voiced after the language editor approved
  // it. An unapproved translation holds the job rather than voicing English
  // at an Amharic audience or unreviewed Amharic at anyone.
  let voiceKey = null;
  if (job.voice_source === 'AI_TTS') {
    const trans = await one(
      `SELECT translated_text, status FROM lcos.translations
       WHERE object_type='SCRIPT' AND object_id=$1 AND language='AM'`, [script.id]);
    if (trans && trans.status !== 'APPROVED') {
      await q(`UPDATE lcos.production_jobs SET status='VOICE_PENDING', last_error=$2 WHERE id=$1`,
        [job.id, 'Amharic translation awaiting language approval; AI voice held']);
      return { job_id: job.id, status: 'VOICE_PENDING',
        reason: 'Amharic translation is not yet language-approved. Approve it in Language Review, then run again.' };
    }
    const voiced = await tts({ text: trans?.translated_text ?? v.spoken_script,
      language: trans ? 'AM' : 'EN', assetId: job.id });
    voiceKey = voiced.storage_key;
  }

  const render = await one(
    `INSERT INTO lcos.renders (production_job_id, script_id, template_id, template_code, template_version,
       engine, status, variant_label, payload)
     VALUES ($1,$2,$3,$4,$5,$6::lcos.render_engine,'PENDING','primary',$7) RETURNING *`,
    [job.id, script.id, job.template_id, template?.code ?? null, template?.version ?? null,
     job.engine, JSON.stringify({ voice_key: voiceKey })]);

  try {
    let result;
    if (job.engine === 'HEYGEN') {
      result = await heygen.submit({ script: v.spoken_script, audioUrl: voiceKey ? storage.url(voiceKey) : null,
        renderId: render.id });
    } else if (formatOf(concept.video_family) === 'CAROUSEL') {
      // Slides now come from carousel_slides, written as slides. They used to
      // be built from onscreen_text, which the writer produces as captions
      // timed to appear at specific seconds of a video, so a carousel was
      // assembled out of video timing cues.
      const slides = Array.isArray(v.carousel_slides) ? v.carousel_slides : [];
      const pages = slides.length
        ? slides.map(sl => ({ text: [sl.title, sl.body].filter(Boolean).join('\n\n') }))
        : (v.onscreen_text ?? []).map(t => ({ text: t.text }));  // pre-0018 scripts
      result = await canva.createDesign({ title: v.hook, pages, designId: render.id });
      result.external_render_id = `canva-${render.id.slice(0, 8)}`;
    } else if (formatOf(concept.video_family) === 'STATIC') {
      // One image, so one page. This ran the carousel path and turned a
      // single graphic into a multi-page design.
      const g = v.static_graphic ?? null;
      const text = g ? [g.headline, g.body, g.footer].filter(Boolean).join('\n\n')
        : [v.hook, v.onscreen_text?.[0]?.text].filter(Boolean).join('\n\n');
      result = await canva.createDesign({ title: g?.headline ?? v.hook,
        pages: [{ text }], designId: render.id });
      result.external_render_id = `canva-${render.id.slice(0, 8)}`;
    } else if (formatOf(concept.video_family) === 'POST') {
      // A text post has nothing to render. It had no branch at all, so it
      // fell through to Creatomate and a plain Telegram post was submitted
      // to a video rendering service with a null template. The finished
      // artifact IS the text, so the job completes here and the text goes to
      // the publish queue.
      result = { status: 'SUCCEEDED', storage_key: null,
        external_render_id: `post-${render.id.slice(0, 8)}`,
        post_text: v.post_text ?? bodyFallbackForPost(v) };
    } else {
      const modifications = {
        Question_Text: v.hook, Answer_Text: v.onscreen_text?.[1]?.text ?? v.onscreen_text?.[0]?.text ?? '',
        CTA_Text: v.cta, Voiceover: voiceKey ? storage.url(voiceKey) : null,
      };
      // Asset binding (WF12): for each scene that needs a visual, search the
      // ACTIVE library semantically. Library first; typography fallback;
      // MEDICAL_ILLUSTRATION binds only clinically approved assets.
      const scenes = Array.isArray(v.scene_plan) ? v.scene_plan : [];
      const bound = [];
      for (const scene of scenes.slice(0, 3)) {
        const reqmt = scene.asset_requirement ?? {};
        if (!reqmt.kind || reqmt.kind === 'TYPOGRAPHY_ONLY') continue;
        const vec = toVectorLiteral(await embed(
          `${scene.visual_brief ?? ''} ${(reqmt.tags ?? []).join(' ')}`));
        const hit = await one(
          `SELECT id, code, storage_key, 1 - (embedding <=> $1::vector) AS sim
           FROM lcos.assets
           WHERE is_active AND embedding IS NOT NULL AND storage_key IS NOT NULL
             AND ($2::text IS NULL OR kind = $2::lcos.asset_kind)
             AND (kind <> 'MEDICAL_ILLUSTRATION' OR clinically_approved)
           ORDER BY embedding <=> $1::vector LIMIT 1`,
          [vec, reqmt.kind === 'VIDEO' ? 'VIDEO' : null]);
        if (hit && hit.sim >= 0.25) {
          modifications[`Scene_${scene.index}`] = storage.url(hit.storage_key);
          bound.push({ scene: scene.index, asset_code: hit.code, similarity: Math.round(hit.sim * 100) / 100 });
        }
      }
      if (bound.length) {
        await q(`UPDATE lcos.production_jobs SET asset_plan=$2 WHERE id=$1`,
          [job.id, JSON.stringify(bound)]);
      }
      result = await creatomate.submit({ templateExternalId: template?.external_template_id,
        modifications, renderId: render.id });
    }
    const done = result.status === 'SUCCEEDED';
    // Test-mode renders (script.is_test_content, per the admin approval-override
    // path) get a "_test" suffix on the final filename itself rather than a UI
    // badge, so the file is unmistakably marked wherever it's downloaded or
    // shared, per owner direction 2026-08-12 ("just adding _test in the final
    // filename is enough"). Insert before the extension: output.mp4 -> output_test.mp4.
    const finalStorageKey = (script.is_test_content && result.storage_key)
      ? result.storage_key.replace(/(\.[a-zA-Z0-9]+)$/, '_test$1')
      : result.storage_key ?? null;
    await q(`UPDATE lcos.renders SET status=$2::lcos.render_status, external_render_id=$3,
               storage_key=$4, duration_s=$5, cost_usd=$6, submitted_at=now(),
               completed_at=CASE WHEN $2='SUCCEEDED' THEN now() END
             WHERE id=$1`,
      [render.id, result.status, result.external_render_id, finalStorageKey,
       result.duration_s ?? null, result.cost_usd ?? null]);
    await q(`UPDATE lcos.production_jobs SET status=$2::lcos.production_status,
               actual_cost_usd=$3, completed_at=CASE WHEN $2='RENDERED' THEN now() END WHERE id=$1`,
      [job.id, done ? 'RENDERED' : 'RENDERING', result.cost_usd ?? null]);
    if (done) {
      // Final-content review task for the producer (or MD at tier 4).
      const slug = script.risk_tier === 'TIER_4' ? 'medical_director' : 'producer';
      const role = await one(`SELECT id FROM lcos.roles WHERE slug=$1`, [slug]);
      await q(`INSERT INTO lcos.review_tasks (review_type, object_type, object_id, risk_tier, required_role_id, sla_hours)
               VALUES ($1,'RENDER',$2,$3,$4,24)`,
        [script.risk_tier === 'TIER_4' ? 'CLINICAL_FINAL' : 'EDITORIAL', render.id, script.risk_tier, role.id]);
    }
    return { job_id: job.id, render_id: render.id, status: done ? 'RENDERED' : 'SUBMITTED',
      preview_url: result.storage_key ? storage.url(result.storage_key) : null };
  } catch (e) {
    await q(`UPDATE lcos.renders SET status='FAILED', error_detail=$2 WHERE id=$1`, [render.id, e.message]);
    await q(`UPDATE lcos.production_jobs SET status='FAILED', last_error=$2 WHERE id=$1`, [job.id, e.message]);
    await q(`INSERT INTO lcos.workflow_events (workflow_code, workflow_name, object_type, object_id,
               status, error_detail, owner_role) VALUES ('WF14','render',$1,$2,'DEAD_LETTER',$3,'producer')`,
      ['RENDER', render.id, e.message]);
    throw e;
  }
}
