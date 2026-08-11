// Asset library: upload (base64 JSON, bounded), tagging, semantic search,
// and the generation path (Gemini images, Kling b-roll) which ALWAYS lands in
// producer review and NEVER produces medical illustration.
import crypto from 'node:crypto';
import { q, one, audit, requirePerm, err } from '../core.mjs';
import { invokeAgent, embed, toVectorLiteral } from '../ai/gateway.mjs';
import { storage, gemini, kling } from '../adapters/index.mjs';

const code = (p) => `${p}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
const MAX_UPLOAD = 8 * 1024 * 1024; // 8 MB base64 payload bound

export default async function routes(app) {
  app.post('/production/assets', { preHandler: requirePerm('asset.manage') }, async (req, reply) => {
    const { title, kind, origin, description, content_base64, mime_type,
      people_present, people_consent_ref, tags = [], topic_codes = [] } = req.body ?? {};
    if (!title || !kind || !mime_type) {
      return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'title, kind, mime_type required'));
    }
    if (people_present && !people_consent_ref) {
      return reply.code(422).send(err(422, 'GUARD_FAILED',
        'Assets showing people require a consent reference.', { guard: 'peopleNeedConsent' }));
    }
    let storageKey = null, bytes = null;
    if (content_base64) {
      if (content_base64.length > MAX_UPLOAD) {
        return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'upload exceeds 8MB'));
      }
      const buf = Buffer.from(content_base64, 'base64');
      bytes = buf.length;
      const ext = (mime_type.split('/')[1] ?? 'bin').slice(0, 4);
      storageKey = `assets/raw/${crypto.randomUUID()}/${title.replace(/[^\w.-]+/g, '_').slice(0, 60)}.${ext}`;
      await storage.put(storageKey, buf);
    }
    const assetCode = code('AST');
    const vec = toVectorLiteral(await embed(`${title} ${description ?? ''} ${tags.join(' ')}`));
    const a = await one(
      `INSERT INTO lcos.assets (code, kind, origin, title, description, storage_key, mime_type, bytes,
         people_present, people_consent_ref, topic_ids, embedding, uploaded_by)
       VALUES ($1,$2::lcos.asset_kind,COALESCE($3,'SHOT_IN_HOUSE')::lcos.asset_origin,$4,$5,$6,$7,$8,
         COALESCE($9,false),$10,
         COALESCE((SELECT array_agg(id) FROM lcos.topics WHERE code = ANY($11::text[])),'{}'),
         $12::vector,$13)
       RETURNING *`,
      [assetCode, kind, origin, title, description ?? null, storageKey, mime_type, bytes,
       people_present, people_consent_ref ?? null, topic_codes, vec, req.actor.id]);
    for (const t of tags) {
      const [ns, val] = String(t).includes(':') ? String(t).split(':', 2) : ['general', t];
      await q(`INSERT INTO lcos.asset_tags (asset_id, namespace, value, tagged_by)
               VALUES ($1,$2,$3,'HUMAN') ON CONFLICT DO NOTHING`, [a.id, ns, val]);
    }
    await audit(null, { actor: req.actor, action: 'asset.upload', objectType: 'ASSET',
      objectId: a.id, objectCode: assetCode });
    return reply.code(201).send(a);
  });

  app.get('/production/assets/search', { preHandler: requirePerm('asset.read') }, async (req, reply) => {
    const { semantic, tags, kind } = req.query;
    if (!semantic && !tags) return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'semantic or tags required'));
    let rows;
    if (semantic) {
      const v = toVectorLiteral(await embed(semantic));
      rows = (await q(
        `SELECT a.id, a.code, a.title, a.kind, a.origin, a.is_ai_generated, a.clinically_approved,
                1 - (a.embedding <=> $1::vector) AS similarity
         FROM lcos.assets a WHERE a.is_active AND a.embedding IS NOT NULL
           AND ($2::text IS NULL OR a.kind=$2::lcos.asset_kind)
         ORDER BY a.embedding <=> $1::vector LIMIT 30`, [v, kind ?? null])).rows;
    } else {
      const pairs = String(tags).split(',').map(t => t.includes(':') ? t.split(':', 2) : ['general', t]);
      rows = (await q(
        `SELECT DISTINCT a.id, a.code, a.title, a.kind, a.origin, a.is_ai_generated, a.clinically_approved
         FROM lcos.assets a JOIN lcos.asset_tags t ON t.asset_id=a.id
         WHERE a.is_active AND (t.namespace, t.value) IN
           (${pairs.map((_, i) => `($${i * 2 + 1},$${i * 2 + 2})`).join(',')}) LIMIT 50`,
        pairs.flat())).rows;
    }
    return { items: rows };
  });

  // Generation path. Medical illustration is refused here, before any agent
  // or provider is reached — the same rule the DB constraint enforces at use.
  app.post('/production/assets/generate', { preHandler: requirePerm('asset.manage') }, async (req, reply) => {
    const { brief, kind = 'IMAGE_PHOTO', aspect_ratio = '9:16', reference_asset_id } = req.body ?? {};
    if (!brief) return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'brief required'));
    if (kind === 'MEDICAL_ILLUSTRATION') {
      return reply.code(422).send(err(422, 'GUARD_FAILED',
        'Medical illustrations are never generated. They come from the clinically approved library.',
        { guard: 'noGenerativeMedicalIllustration' }));
    }
    const promptOut = await invokeAgent('asset_prompt_writer',
      { brief, aspect_ratio, scene_index: 1 }, { objectType: 'ASSET', workflowCode: 'WF12' });
    if (promptOut.result === 'REFUSED') {
      return reply.code(422).send(err(422, 'GUARD_FAILED',
        `Prompt writer refused: ${promptOut.refusal_reason}`, { guard: 'assetPromptRefused' }));
    }
    const p = promptOut.prompts[0];
    const assetId = crypto.randomUUID();
    // Character consistency: with a reference asset (an ACTIVE, producer-
    // approved Gemini reference image of a recurring character), video goes
    // through Kling image-to-video instead of text-to-video.
    let refKey = null;
    if (reference_asset_id) {
      const ref = await one(
        `SELECT storage_key FROM lcos.assets WHERE id=$1 AND is_active AND storage_key IS NOT NULL`,
        [reference_asset_id]);
      if (!ref) return reply.code(422).send(err(422, 'VALIDATION_ERROR',
        'reference_asset_id must be an active asset with stored content'));
      refKey = ref.storage_key;
    }
    const gen = kind === 'VIDEO'
      ? (refKey
          ? await kling.imageToVideo({ prompt: p.prompt, negativePrompt: p.negative_prompt,
              referenceImageKey: refKey, assetId })
          : await kling.textToVideo({ prompt: p.prompt, negativePrompt: p.negative_prompt, assetId }))
      : await gemini.generateImage({ prompt: p.prompt, assetId });
    const vec = toVectorLiteral(await embed(brief));
    const a = await one(
      `INSERT INTO lcos.assets (code, kind, origin, title, description, storage_key, mime_type,
         is_ai_generated, ai_generation_meta, embedding, is_active, uploaded_by)
       VALUES ($1,$2::lcos.asset_kind,'AI_GENERATED',$3,$4,$5,$6,true,$7,$8::vector,false,$9)
       RETURNING *`,
      [code('GEN'), kind, brief.slice(0, 100), p.prompt, gen.storage_key,
       kind === 'VIDEO' ? 'video/mp4' : 'image/png',
       JSON.stringify({ provider: kind === 'VIDEO' ? 'KLING' : 'GEMINI',
         prompt: p.prompt, negative: p.negative_prompt }), vec, req.actor.id]);
    // Generated assets are inactive until the producer reviews them.
    const role = await one(`SELECT id FROM lcos.roles WHERE slug='producer'`);
    await q(`INSERT INTO lcos.review_tasks (review_type, object_type, object_id, required_role_id, sla_hours)
             VALUES ('ASSET','ASSET',$1,$2,48)`, [a.id, role.id]);
    await audit(null, { actor: req.actor, action: 'asset.generated', objectType: 'ASSET',
      objectId: a.id, objectCode: a.code, reason: brief.slice(0, 120) });
    return reply.code(201).send({ ...a, review: 'queued for producer approval; inactive until approved' });
  });

  app.post('/production/assets/:id/activate', { preHandler: requirePerm('asset.manage') }, async (req, reply) => {
    const a = await one(`UPDATE lcos.assets SET is_active=true WHERE id=$1 RETURNING *`, [req.params.id]);
    if (!a) return reply.code(404).send(err(404, 'NOT_FOUND', 'asset'));
    await q(`UPDATE lcos.review_tasks SET status='COMPLETED', completed_at=now(), assigned_to=$2
             WHERE object_type='ASSET' AND object_id=$1 AND status IN ('OPEN','IN_PROGRESS')`,
      [a.id, req.actor.id]);
    await audit(null, { actor: req.actor, action: 'asset.activate', objectType: 'ASSET', objectId: a.id });
    return a;
  });
}
