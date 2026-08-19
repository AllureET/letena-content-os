// Production module: assets, production jobs, router, renders via adapters.
import crypto from 'node:crypto';
import { q, one, audit, requirePerm, err, setting } from '../core.mjs';
import { kling, tts, gemini, canva, storage, videoEngine } from '../adapters/index.mjs';
import { formatOf, hasAudio } from '../formats.mjs';
import { embed, toVectorLiteral } from '../ai/gateway.mjs';

const code = (p) => `${p}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

// ---------- spend (Part 2, 14 Aug 2026) ----------
// "Respect the existing spend caps and show how close today is to them.
// Refuse politely and clearly at the cap rather than failing mid-render."
// Both caps already existed as settings; nothing read them before a render.
export async function spendToday() {
  const ai = await one(
    `SELECT COALESCE(SUM(cost_usd),0) AS spent FROM lcos.ai_invocations
     WHERE occurred_at >= date_trunc('day', now())`);
  const render = await one(
    `SELECT COALESCE(SUM(cost_usd),0) AS spent FROM lcos.renders
     WHERE created_at >= date_trunc('day', now())`);
  const aiCap = Number(await setting('ai.daily_spend_cap_usd', 40));
  const renderCap = Number(await setting('render.daily_spend_cap_usd', 60));
  return {
    ai: { spent_usd: Number(ai.spent), cap_usd: aiCap },
    render: { spent_usd: Number(render.spent), cap_usd: renderCap },
  };
}

// The subtitle presets FFmpeg renders (Part 1 decision; the thing the owner
// specifically liked about VEED). Labels and plain descriptions for the
// plan screen; the Amharic sample is rendered client side in Ethiopic,
// because Ethiopic is where the rendering is actually at risk.
export const SUBTITLE_PRESETS = Object.freeze([
  { code: 'WORD_HIGHLIGHT', label: 'Word by word highlight', description: 'Each word lights up as it is spoken. The VEED style. Best for fast hook-led clips.' },
  { code: 'POP_ON', label: 'Pop on', description: 'Each phrase pops on as a block. Calm, readable, good for stories.' },
  { code: 'BOXED', label: 'Boxed', description: 'Text in a solid box. Strongest legibility over busy footage.' },
  { code: 'CLEAN', label: 'Clean', description: 'Plain subtitles, no effects. Best for the doctor on camera.' },
]);

// Plain-language production step descriptions per engine key, with honest
// costs: only Gemini and Kling/Veo meter (Video Studio). Assembly, cutting,
// subtitling and carousel rendering run with FFmpeg / an HTML template on
// the Hetzner box Letena already pays for, so they are INCLUDED, never a
// fake dollar figure (owner, Part 2 brief, 14 Aug 2026).
function money(estimates, key, count = 1) {
  const per = Number(estimates?.[key] ?? 0);
  return { est_cost_usd: Math.round(per * count * 100) / 100, metered: per > 0 && count > 0 };
}

// Format -> engine routing. VIDEO-kind formats (V01-V06, and any
// registry-driven format whose body_kind is VIDEO) are not routed here at
// all: video production moved to Video Studio (apps/api/src/modules/studio.mjs)
// on 19 Aug 2026, when HeyGen and Creatomate were retired for good (owner's
// decision). createProductionJob() blocks a VIDEO-kind script before it ever
// reaches this table. What remains here is the MANUAL_UPLOAD family: Canva
// carousels and statics, and the plain Telegram post.
// Pre-0018 scripts have no post_text, so fall back to what a post would have
// been assembled from before the format work.
function bodyFallbackForPost(v) {
  return [v.hook, v.spoken_script, v.cta].filter(Boolean).join('\n\n');
}

const ROUTE = {
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
    try {
      const job = await createProductionJob(s, req.actor);
      return reply.code(201).send(job);
    } catch (e) {
      const status = e.status ?? 500;
      return reply.code(status).send(err(status, e.code ?? 'INTERNAL', e.message, e.guard ? { guard: e.guard } : {}));
    }
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

  // The browsable library (Part 2, 14 Aug 2026: "Nobody browses a reference
  // library as a list of codes"). Filters for kind, origin, AI-generated,
  // clinical approval and free text; include_pending surfaces generated
  // assets still waiting for producer review (inactive), clearly marked, so
  // saving one is one click from where it appeared. mime_type and
  // storage_key feed the media route for real thumbnails and previews.
  app.get('/production/assets', { preHandler: requirePerm('asset.read') }, async (req) => {
    const { kind, origin, ai, clinical, text, include_pending } = req.query ?? {};
    const r = await q(
      `SELECT a.id, a.code, a.kind, a.origin, a.title, a.description, a.is_ai_generated,
              a.clinically_approved, a.is_active, a.storage_key, a.mime_type, a.created_at,
              COALESCE((SELECT array_agg(t.namespace || ':' || t.value) FROM lcos.asset_tags t
                        WHERE t.asset_id = a.id), '{}') AS tags
       FROM lcos.assets a
       WHERE (a.is_active OR ($6::boolean AND a.is_ai_generated))
         AND ($1::text IS NULL OR a.kind = $1::lcos.asset_kind)
         AND ($2::text IS NULL OR a.origin = $2::lcos.asset_origin)
         AND ($3::boolean IS NULL OR a.is_ai_generated = $3::boolean)
         AND ($4::boolean IS NULL OR a.clinically_approved = $4::boolean)
         AND ($5::text IS NULL OR a.title ILIKE '%' || $5 || '%' OR a.description ILIKE '%' || $5 || '%'
              OR a.code ILIKE '%' || $5 || '%')
       ORDER BY a.created_at DESC LIMIT 200`,
      [kind || null, origin || null,
       ai === 'true' ? true : ai === 'false' ? false : null,
       clinical === 'true' ? true : clinical === 'false' ? false : null,
       text || null, include_pending === '1' || include_pending === 'true']);
    return { items: r.rows };
  });

  // ---------- Part 2: the plan and the cost BEFORE spending ----------
  // "Nothing shows this today. Money is spent and Girum finds out
  // afterwards." Read-only: computes what producing this piece will run,
  // step by step, in plain language, with the honest cost of each step and
  // what the library already has for every scene, so binding an approved
  // asset (free, instant) is the default and generating is the fallback.
  app.get('/production/plan/:scriptId', { preHandler: requirePerm('production.read') }, async (req, reply) => {
    const s = await one(`SELECT * FROM lcos.scripts WHERE id=$1`, [req.params.scriptId]);
    if (!s) return reply.code(404).send(err(404, 'NOT_FOUND', 'script'));
    const v = await one(`SELECT * FROM lcos.script_versions WHERE script_id=$1 AND version=$2`,
      [s.id, s.approved_version ?? s.current_version]);
    const concept = await one(`SELECT * FROM lcos.content_concepts WHERE id=$1`, [s.concept_id]);
    const fmtRow = concept?.format_code
      ? await one(`SELECT * FROM lcos.content_formats WHERE code=$1`, [concept.format_code]) : null;
    const bodyKind = fmtRow?.body_kind ?? formatOf(concept?.video_family);
    const estimates = await setting('production.cost_estimates', {});
    const engineDefault = String(fmtRow?.video_engine ?? await setting('production.video_engine', 'KLING'));
    const aiVoiceTiers = await setting('voice.ai_allowed_tiers', ['TIER_1', 'TIER_2']);

    const steps = [];
    const sceneSuggestions = [];
    if (bodyKind === 'VIDEO') {
      const scenes = Array.isArray(v?.scene_plan) ? v.scene_plan : [];
      const visualScenes = scenes.filter(sc => (sc.asset_requirement?.kind ?? 'TYPOGRAPHY_ONLY') !== 'TYPOGRAPHY_ONLY');
      // What the library already has, per scene. Same pgvector search
      // production itself uses, surfaced BEFORE the run so Girum can bind
      // an existing asset instead of paying to generate a new one.
      for (const scene of visualScenes) {
        const reqmt = scene.asset_requirement ?? {};
        const vec = toVectorLiteral(await embed(
          `${scene.visual_brief ?? ''} ${(reqmt.tags ?? []).join(' ')}`));
        const hits = (await q(
          `SELECT id, code, title, kind, is_ai_generated, clinically_approved, storage_key, mime_type,
                  1 - (embedding <=> $1::vector) AS similarity
           FROM lcos.assets
           WHERE is_active AND embedding IS NOT NULL AND storage_key IS NOT NULL
             AND (kind <> 'MEDICAL_ILLUSTRATION' OR clinically_approved)
           ORDER BY embedding <=> $1::vector LIMIT 3`, [vec])).rows;
        sceneSuggestions.push({ scene: scene.index, visual_brief: scene.visual_brief ?? '',
          requirement: reqmt,
          matches: hits.map(h => ({ ...h, similarity: Math.round(h.similarity * 100) / 100 })) });
      }
      const clipKey = engineDefault === 'VEO' ? 'VEO_CLIP' : 'KLING_CLIP';
      const nClips = Math.max(visualScenes.length, 0);
      if (nClips > 0) {
        steps.push({ step: 'reference_image', label: 'Reference image', engine: 'Gemini',
          detail: 'A still that locks the look (and the character, when there is one) before any video is generated.',
          ...money(estimates, 'GEMINI_IMAGE', 1) });
        steps.push({ step: 'broll', label: `Generative video, ${nClips} scene${nClips === 1 ? '' : 's'}`,
          engine: engineDefault === 'VEO' ? 'Veo' : 'Kling',
          detail: `Each scene that is not bound to a library asset is generated. Binding a library asset makes that scene free and instant.`,
          ...money(estimates, clipKey, nClips) });
      }
      const aiVoiceAllowed = aiVoiceTiers.includes(s.risk_tier);
      steps.push({ step: 'voice', label: 'Amharic voice', engine: 'Azure (AI) or a live recording',
        detail: aiVoiceAllowed
          ? 'AI voice (Azure am-ET neural) is allowed at this tier. A live human recording is always available and is the first-class path for story formats.'
          : `At ${s.risk_tier} the AI voice is not permitted: a live human recording is the path here, recorded by a person and uploaded.`,
        ...money(estimates, 'AZURE_TTS', aiVoiceAllowed ? 1 : 0), human_alternative: true });
      steps.push({ step: 'assembly', label: 'Assembly and cutting', engine: 'FFmpeg on Letena’s own server',
        detail: 'Scenes, voice and music assembled and cut on the Hetzner box Letena already pays for.',
        est_cost_usd: 0, metered: false, included: true });
      steps.push({ step: 'subtitles', label: 'Subtitles', engine: 'FFmpeg on Letena’s own server',
        detail: 'Burned in with the preset chosen below. Ethiopic rendering is checked on the sample.',
        est_cost_usd: 0, metered: false, included: true });
    } else if (bodyKind === 'CAROUSEL' || bodyKind === 'STATIC') {
      steps.push({ step: 'render_cards', label: bodyKind === 'CAROUSEL' ? 'Carousel rendered' : 'Graphic rendered',
        engine: 'HTML template on Letena’s own server',
        detail: 'Rendered from the approved copy with the Letena template. No metered service involved.',
        est_cost_usd: 0, metered: false, included: true });
    } else if (bodyKind === 'AUDIO') {
      steps.push({ step: 'voice', label: 'Amharic voice', engine: 'Azure (AI) or a live recording',
        detail: 'Audio only, written to be heard once. AI voice or a human recording.',
        ...money(estimates, 'AZURE_TTS', 1), human_alternative: true });
    } else {
      steps.push({ step: 'no_production', label: 'Nothing to produce', engine: 'none',
        detail: 'The finished artifact IS the text. It goes straight to the publish queue once approved.',
        est_cost_usd: 0, metered: false, included: true });
    }
    for (const st of steps) if (st.est_cost_usd === 0 && !st.metered) st.included = true;
    const total = Math.round(steps.reduce((n, st) => n + (st.est_cost_usd || 0), 0) * 100) / 100;

    const spend = await spendToday();
    const atCap = spend.render.spent_usd >= spend.render.cap_usd;
    return {
      script_id: s.id, script_code: s.code, body_kind: bodyKind,
      format: fmtRow ? { code: fmtRow.code, label: fmtRow.label } : null,
      production_path: s.production_path,
      steps, total_est_usd: total,
      cost_note: total > 0
        ? 'Estimates, not invoices: generative video is where the money actually goes, and everything self-hosted is included. Binding library assets below brings the total down.'
        : 'This piece costs nothing to produce: every step runs on Letena’s own server.',
      video_engine: { default: engineDefault, options: ['KLING', 'VEO'],
        note: 'Both engines are candidates. Neither is proven better until the first real test runs (first-plus-last-frame conditioning, Amharic lip-sync). Swapping is configuration, not code.' },
      subtitle: { presets: SUBTITLE_PRESETS, default: fmtRow?.subtitle_preset ?? 'CLEAN',
        applies: bodyKind === 'VIDEO' },
      voice: {
        options: [
          { code: 'AI_TTS', label: 'AI voice (Azure Amharic)', metered: true },
          { code: 'HUMAN', label: 'Live human recording', metered: false,
            note: 'Recorded by a person and uploaded. First class, not a downgrade: the AI story line assumes a live Amharic voice.' },
          { code: 'NONE', label: 'No voice', metered: false },
        ],
        ai_allowed_at_tier: aiVoiceTiers.includes(s.risk_tier),
      },
      scene_suggestions: sceneSuggestions,
      spend_today: spend,
      at_render_cap: atCap,
      cap_message: atCap
        ? `Today’s render spend ($${spend.render.spent_usd}) has reached the daily cap ($${spend.render.cap_usd}). Nothing more renders today; the queue picks up tomorrow, or an admin can raise the cap in Settings.`
        : null,
    };
  });

  // Save the plan choices onto a queued job, before anything runs. This is
  // the moment the flow decides engine, subtitles, voice and which scenes
  // reuse the library instead of generating.
  app.post('/production/jobs/:id/plan', { preHandler: requirePerm('production.request') }, async (req, reply) => {
    const job = await one(`SELECT * FROM lcos.production_jobs WHERE id=$1`, [req.params.id]);
    if (!job) return reply.code(404).send(err(404, 'NOT_FOUND', 'job'));
    if (!['QUEUED', 'ASSETS_PENDING', 'VOICE_PENDING'].includes(job.status)) {
      return reply.code(422).send(err(422, 'GUARD_FAILED',
        `This job is ${job.status}; the plan can only change before the run starts.`, { guard: 'jobNotStarted' }));
    }
    const { video_engine, subtitle_preset, voice_source, asset_bindings } = req.body ?? {};
    if (video_engine != null && !['KLING', 'VEO'].includes(video_engine)) {
      return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'video_engine must be KLING or VEO'));
    }
    if (subtitle_preset != null && !SUBTITLE_PRESETS.some(p => p.code === subtitle_preset)) {
      return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'unknown subtitle_preset'));
    }
    if (voice_source != null && !['HUMAN', 'AI_TTS', 'NONE'].includes(voice_source)) {
      return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'voice_source must be HUMAN, AI_TTS or NONE'));
    }
    const bindings = [];
    for (const b of Array.isArray(asset_bindings) ? asset_bindings : []) {
      const a = await one(`SELECT id, code, kind, clinically_approved, is_active FROM lcos.assets WHERE id=$1`,
        [b.asset_id]);
      if (!a || !a.is_active) {
        return reply.code(422).send(err(422, 'GUARD_FAILED',
          'An asset binding points at an inactive or missing asset. Only reviewed, active library assets can be bound.',
          { guard: 'assetActive' }));
      }
      // The existing rule, not routed around by the new interface: medical
      // illustrations bind only when clinically approved.
      if (a.kind === 'MEDICAL_ILLUSTRATION' && !a.clinically_approved) {
        return reply.code(422).send(err(422, 'GUARD_FAILED',
          `${a.code} is a medical illustration without clinical approval; it cannot be bound.`,
          { guard: 'medicalIllustrationApproved' }));
      }
      bindings.push({ scene: Number(b.scene), asset_id: a.id, asset_code: a.code, chosen: true });
    }
    const nj = await one(
      `UPDATE lcos.production_jobs SET
         video_engine = COALESCE($2, video_engine),
         subtitle_preset = COALESCE($3, subtitle_preset),
         voice_source = COALESCE($4, voice_source),
         plan = plan || $5::jsonb
       WHERE id=$1 RETURNING *`,
      [job.id, video_engine ?? null, subtitle_preset ?? null, voice_source ?? null,
       JSON.stringify({ asset_bindings: bindings, decided_by: req.actor.id, decided_at: new Date().toISOString() })]);
    await audit(null, { actor: req.actor, action: 'production_job.plan', objectType: 'PRODUCTION_JOB',
      objectId: job.id, objectCode: job.code,
      reason: `engine=${nj.video_engine ?? 'default'} subtitles=${nj.subtitle_preset ?? 'format default'} voice=${nj.voice_source} bindings=${bindings.length}` });
    return { ok: true, job_id: nj.id, video_engine: nj.video_engine, subtitle_preset: nj.subtitle_preset,
      voice_source: nj.voice_source, asset_bindings: bindings,
      summary: `Plan saved: ${bindings.length ? `${bindings.length} scene${bindings.length === 1 ? '' : 's'} reuse the library, ` : ''}voice is ${nj.voice_source === 'HUMAN' ? 'a live human recording' : nj.voice_source === 'AI_TTS' ? 'AI (Azure Amharic)' : 'none'}. Nothing has been spent yet.` };
  });

  app.get('/production/spend-today', { preHandler: requirePerm('production.read') }, async () => {
    return spendToday();
  });

  // ---------- Part 2: watch it happen ----------
  // Per step, live: what finished, what is running, what is queued, what
  // failed and why, with what a failure means and what to do about it.
  // "RENDER_FAILED" tells Girum nothing. Polled by the UI on an interval;
  // no held requests, no websockets.
  app.get('/production/progress', { preHandler: requirePerm('production.read') }, async () => {
    const jobs = (await q(
      `SELECT pj.*, s.code AS script_code, s.risk_tier, cc.format_code, cf.label AS format_label
       FROM lcos.production_jobs pj
       JOIN lcos.scripts s ON s.id = pj.script_id
       JOIN lcos.content_concepts cc ON cc.id = s.concept_id
       LEFT JOIN lcos.content_formats cf ON cf.code = cc.format_code
       ORDER BY pj.created_at DESC LIMIT 50`)).rows;
    const renders = (await q(
      `SELECT r.* FROM lcos.renders r
       WHERE r.production_job_id = ANY($1::uuid[]) ORDER BY r.created_at`,
      [jobs.map(j => j.id)])).rows;
    const explain = (j) => {
      switch (j.status) {
        case 'QUEUED': return { text: 'Waiting to start. Nothing has been spent.', action: 'Run it, or change the plan first.' };
        case 'ASSETS_PENDING': return { text: 'Waiting on assets that are not in the library yet.', action: 'Bind library assets on the plan, or generate them on the Assets screen.' };
        case 'VOICE_PENDING': return { text: 'The Amharic is not language-approved yet, so the AI voice is on hold rather than voicing unreviewed Amharic.', action: 'Approve the Amharic on its review screen, then run again.' };
        case 'RENDERING': return { text: 'Running now.', action: 'Nothing to do; this screen updates itself.' };
        case 'RENDERED': return { text: 'Finished. The file is ready for final approval.', action: 'Preview it, then approve or send it back.' };
        case 'FAILED': return {
          text: `Failed: ${j.last_error ?? 'no detail recorded'}. Completed steps are not lost.`,
          action: 'Run it again to retry from the failed step. If it keeps failing, the error above says which service to check in Settings.' };
        case 'CANCELLED': return { text: 'Cancelled.', action: 'Create a new job from the script if it should still be produced.' };
        default: return { text: j.status, action: '' };
      }
    };
    return {
      items: jobs.map(j => ({ ...j,
        renders: renders.filter(r => r.production_job_id === j.id)
          .map(r => ({ id: r.id, status: r.status, storage_key: r.storage_key, cost_usd: r.cost_usd,
            error_detail: r.error_detail, created_at: r.created_at })),
        ...explain(j) })),
      spend_today: await spendToday(),
    };
  });
}

export async function createProductionJob(script, actor) {
  const concept = await one(`SELECT * FROM lcos.content_concepts WHERE id=$1`, [script.concept_id]);
  // The plan defaults (Part 2): the format's own subtitle preset, and the
  // format's engine override when one exists (NULL resolves to the
  // production.video_engine setting at run time, so swapping the system
  // default later applies to queued jobs too). body_kind is also read from
  // here first, falling back to the legacy video_family mapping, because
  // it is the authoritative shape for registry-driven formats (Run One).
  const fmtRow = concept.format_code
    ? await one(`SELECT body_kind, subtitle_preset, video_engine FROM lcos.content_formats WHERE code=$1`,
        [concept.format_code]) : null;
  const bodyKind = fmtRow?.body_kind ?? formatOf(concept.video_family);
  // Video production moved to Video Studio on 19 Aug 2026 (owner's decision:
  // HeyGen and Creatomate are retired for good). This pipeline never rendered
  // anything but VIDEO-kind pieces through those two engines, so a VIDEO-kind
  // script fails closed here, at the door, with an honest redirect, instead
  // of creating a job this module has no way to run.
  if (bodyKind === 'VIDEO') {
    throw Object.assign(new Error(
      'Video production now runs through Video Studio, not this pipeline. Approve this script, ' +
      'then start a Video Studio project from it instead.'),
      { status: 422, code: 'GUARD_FAILED', guard: 'videoMovedToStudio' });
  }
  const route = ROUTE[concept.video_family] ?? { engine: 'MANUAL_UPLOAD' };
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
       routing_reason, voice_source, requested_by, subtitle_preset, video_engine)
     VALUES ($1,$2,$3,$4,$5::lcos.render_engine,'QUEUED',$6,$7,$8,$9,$10) RETURNING *`,
    [code('PJ'), script.id, script.family_id, template?.id ?? null, route.engine,
     `${concept.video_family} -> ${route.engine}`,
     voice, actor?.id ?? null, fmtRow?.subtitle_preset ?? null, fmtRow?.video_engine ?? null]);
  await audit(null, { actor, action: 'production_job.create', objectType: 'PRODUCTION_JOB',
    objectId: job.id, objectCode: job.code });
  return job;
}

export async function runProductionJob(jobId, actor) {
  const job = await one(`SELECT * FROM lcos.production_jobs WHERE id=$1`, [jobId]);
  if (!job) return null;
  // The daily render cap refuses POLITELY at the door, before any money
  // moves, instead of failing mid-render (Part 2, 14 Aug 2026). The job
  // stays QUEUED, loses nothing, and the message says what to do.
  const spend = await spendToday();
  if (spend.render.spent_usd >= spend.render.cap_usd) {
    return { job_id: job.id, status: 'CAP_REACHED',
      reason: `Today's render spend ($${spend.render.spent_usd}) has reached the daily cap ($${spend.render.cap_usd}). This job stays queued and nothing was spent. It can run tomorrow, or an admin can raise render.daily_spend_cap_usd in Settings.` };
  }
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
    if (formatOf(concept.video_family) === 'VIDEO') {
      // Video production moved to Video Studio on 19 Aug 2026 (HeyGen and
      // Creatomate are retired for good). createProductionJob() already
      // refuses to create a fresh VIDEO-kind job, so the only way this branch
      // is reached is a job that was queued before that change (engine
      // CREATOMATE or HEYGEN in the historical data). Fail closed, honestly,
      // rather than calling either retired adapter.
      throw new Error('Video production now runs through Video Studio, not this pipeline. ' +
        'This job predates that change; start a Video Studio project from the approved script instead.');
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
      // No known production path for this body kind. VIDEO is caught above;
      // CAROUSEL, STATIC and POST are the only other shapes this pipeline
      // has ever rendered, so reaching here means an unrecognised video_family.
      throw new Error(`No production path for video_family ${concept.video_family}.`);
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
