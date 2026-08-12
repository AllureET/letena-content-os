// Platform export specs: per-platform video/image sizing (aspect ratio,
// pixel dimensions, duration guidance, UI safe zone), admin-editable so the
// social lead can update a number without a code change when a platform's
// algorithm or upload rules move. Backed by lcos.platform_specs (migration
// 0008); the seeded rows and their sourcing are documented in that
// migration's comments.
//
// getPlatformSpec() is the read side other modules call (distribution.mjs,
// at publish-job creation). evaluateContent() is the pure warning logic,
// exported separately so it is testable without a database: given a spec
// and a render's duration/aspect ratio, it returns a non-blocking list of
// warnings (never throws, never blocks scheduling -- the pivot's operating
// model treats sizing mismatches the same way it treats everything else
// downstream of an approved card: flag, do not gate).
import { q, one, audit, requirePerm, err } from '../core.mjs';

export async function getPlatformSpec(platform) {
  return one(`SELECT * FROM lcos.platform_specs WHERE platform=$1::lcos.publish_platform`, [platform]);
}

// Pure: no DB, no I/O. spec is a platform_specs row (or the shape of one);
// content is { durationSeconds, aspectRatio }. Either input field may be
// absent, in which case that check is skipped.
export function evaluateContent(spec, content = {}) {
  const warnings = [];
  if (!spec) return warnings;
  const { durationSeconds, aspectRatio } = content;
  const dur = durationSeconds != null ? Number(durationSeconds) : null;
  if (dur != null && Number.isFinite(dur)) {
    if (spec.max_duration_seconds != null && dur > Number(spec.max_duration_seconds)) {
      warnings.push({
        code: 'DURATION_EXCEEDS_MAX',
        message: `${dur}s exceeds ${spec.platform}'s maximum of ${spec.max_duration_seconds}s.`,
      });
    } else if (spec.recommended_duration_seconds != null && dur > Number(spec.recommended_duration_seconds)) {
      warnings.push({
        code: 'DURATION_EXCEEDS_RECOMMENDED',
        message: `${dur}s exceeds ${spec.platform}'s recommended ${spec.recommended_duration_seconds}s; `
          + 'longer content mostly reaches existing followers rather than new audiences.',
      });
    }
  }
  if (aspectRatio && spec.aspect_ratio && String(aspectRatio) !== String(spec.aspect_ratio)) {
    warnings.push({
      code: 'ASPECT_RATIO_MISMATCH',
      message: `Source is ${aspectRatio}; ${spec.platform} expects ${spec.aspect_ratio} `
        + `(${spec.width}x${spec.height}).`,
    });
  }
  return warnings;
}

const anyPerm = (...perms) => async (req, reply) => {
  if (!perms.some((p) => req.actor?.permissions?.includes(p))) {
    return reply.code(403).send(err(403, 'FORBIDDEN', `requires ${perms.join(' or ')}`));
  }
};

export default async function routes(app) {
  app.get('/platform/specs', { preHandler: requirePerm('publish.read') }, async () => {
    const r = await q(`SELECT * FROM lcos.platform_specs ORDER BY platform`);
    return { items: r.rows };
  });

  app.put('/platform/specs/:platform',
    { preHandler: anyPerm('publish.schedule', 'settings.manage') },
    async (req, reply) => {
      const platform = String(req.params.platform ?? '').toUpperCase();
      const { aspect_ratio, width, height, max_duration_seconds, recommended_duration_seconds,
        safe_zone, format_notes } = req.body ?? {};
      if (!aspect_ratio || !width || !height) {
        return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'aspect_ratio, width and height are required'));
      }
      let row;
      try {
        row = await one(
          `INSERT INTO lcos.platform_specs (platform, aspect_ratio, width, height,
             max_duration_seconds, recommended_duration_seconds, safe_zone, format_notes, updated_by)
           VALUES ($1::lcos.publish_platform,$2,$3,$4,$5,$6,COALESCE($7::jsonb,'{}'::jsonb),$8,$9)
           ON CONFLICT (platform) DO UPDATE SET aspect_ratio=EXCLUDED.aspect_ratio, width=EXCLUDED.width,
             height=EXCLUDED.height, max_duration_seconds=EXCLUDED.max_duration_seconds,
             recommended_duration_seconds=EXCLUDED.recommended_duration_seconds,
             safe_zone=EXCLUDED.safe_zone, format_notes=EXCLUDED.format_notes,
             updated_by=EXCLUDED.updated_by, updated_at=now()
           RETURNING *`,
          [platform, aspect_ratio, width, height, max_duration_seconds ?? null,
           recommended_duration_seconds ?? null, safe_zone ? JSON.stringify(safe_zone) : null,
           format_notes ?? null, req.actor?.id ?? null]);
      } catch (e) {
        if (e.code === '22P02') return reply.code(422).send(err(422, 'VALIDATION_ERROR', `unknown platform: ${platform}`));
        throw e;
      }
      await audit(null, { actor: req.actor, action: 'platform_spec.upsert', objectType: 'PLATFORM_SPEC',
        objectId: row.id, objectCode: platform });
      return row;
    });
}
