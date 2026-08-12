// LCOS API server. Fastify, one process, modules registered under /api/v1.
// Also serves the admin UI (apps/web) as static files.
import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { authPlugin, login, err, q, one, totpSecret, totpVerify, audit, invalidateSetting } from './core.mjs';
import { CRED_REGISTRY, loadCreds, credStatus, setCred } from './creds.mjs';
import knowledge from './modules/knowledge.mjs';
import demand from './modules/demand.mjs';
import content from './modules/content.mjs';
import production from './modules/production.mjs';
import distribution from './modules/distribution.mjs';
import language from './modules/language.mjs';
import assets from './modules/assets.mjs';
import experiments from './modules/experiments.mjs';
import voice from './modules/voice.mjs';
import platformSpecs from './modules/platform_specs.mjs';

export async function buildServer() {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test',
    bodyLimit: 2 * 1024 * 1024 });

  app.get('/healthz', async () => {
    await q('SELECT 1');
    return { ok: true, service: 'lcos-api' };
  });

  // DB-backed provider credentials (Settings screen). Env stays the fallback.
  await loadCreds().catch(() => {});

  // Admin UI (no build step; EMR design language)
  const webDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
  app.get('/', async (req, reply) =>
    reply.type('text/html').send(readFileSync(join(webDir, 'index.html'), 'utf8')));
  app.get('/app.js', async (req, reply) =>
    reply.type('text/javascript').send(readFileSync(join(webDir, 'app.js'), 'utf8')));

  // SSO from the Letena EMR. The EMR's api/lcos_sso.php sends a short-lived
  // token: base64url(payload json).hex_hmac_sha256(b64, shared ingest secret),
  // payload {email, full_name, role, exp}. Verify, upsert the user with that
  // role, issue a normal LCOS JWT, and land the browser on /#sso=<jwt> where
  // the web app stores it. Same shared secret as ingest, deliberately: one
  // secret to rotate, one trust relationship with the EMR.
  app.get('/api/v1/auth/sso', async (req, reply) => {
    const crypto = await import('node:crypto');
    const jwt = (await import('jsonwebtoken')).default;
    const token = String(req.query?.token ?? '');
    const [b64, sig] = token.split('.');
    if (!b64 || !sig) return reply.code(401).send(err(401, 'UNAUTHENTICATED', 'bad sso token'));
    const secret = process.env.LETENA_INGEST_SHARED_SECRET || 'dev-ingest-secret';
    const expect = crypto.createHmac('sha256', secret).update(b64).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(String(sig).padEnd(expect.length).slice(0, expect.length)))) {
      return reply.code(401).send(err(401, 'UNAUTHENTICATED', 'bad sso signature'));
    }
    let payload;
    try { payload = JSON.parse(Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); }
    catch { return reply.code(401).send(err(401, 'UNAUTHENTICATED', 'bad sso payload')); }
    if (!payload?.email || !payload?.exp || payload.exp < Date.now() / 1000) {
      return reply.code(401).send(err(401, 'UNAUTHENTICATED', 'sso token expired'));
    }
    const roleSlug = ['admin', 'medical_director', 'consulting_doctor', 'intake_coordinator',
      'content_lead', 'language_editor', 'social_lead', 'producer'].includes(payload.role)
      ? payload.role : 'content_lead';
    const bcrypt = (await import('bcryptjs')).default;
    const u = await one(
      `INSERT INTO lcos.users (email, full_name, password_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT ((lower(email))) DO UPDATE SET full_name = EXCLUDED.full_name, last_login_at = now()
       RETURNING id, email`,
      [String(payload.email).toLowerCase(), payload.full_name ?? payload.email,
       bcrypt.hashSync(crypto.randomUUID(), 10)]);
    const role = await one(`SELECT id FROM lcos.roles WHERE slug=$1`, [roleSlug]);
    if (role) {
      await q(`INSERT INTO lcos.user_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [u.id, role.id]);
    }
    const roles = (await q(
      `SELECT ro.slug FROM lcos.user_roles ur JOIN lcos.roles ro ON ro.id=ur.role_id WHERE ur.user_id=$1`,
      [u.id])).rows.map(r => r.slug);
    const { JWT_SECRET } = await import('./core.mjs');
    const lcosJwt = jwt.sign({ sub: u.id, email: u.email, roles }, JWT_SECRET, { expiresIn: '12h' });
    await audit(null, { actor: { type: 'SYSTEM', label: 'emr-sso' }, action: 'auth.sso_login',
      objectType: 'SETTING', reason: `emr sso for ${u.email} as ${roleSlug}` });
    return reply.redirect('/#sso=' + lcosJwt);
  });

  app.post('/api/v1/auth/login', async (req, reply) => {
    const { email, password, totp } = req.body ?? {};
    if (!email || !password) return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'email and password required'));
    const result = await login(email, password, totp);
    if (!result) return reply.code(401).send(err(401, 'UNAUTHENTICATED', 'bad credentials'));
    if (result.totp_required) return reply.code(401).send(err(401, 'TOTP_REQUIRED', 'TOTP code required'));
    return result;
  });

  authPlugin(app);

  await app.register(async (v1) => {
    await v1.register(knowledge);
    await v1.register(demand);
    await v1.register(content);
    await v1.register(production);
    await v1.register(distribution);
    await v1.register(language);
    await v1.register(assets);
    await v1.register(experiments);
    await v1.register(voice);
    await v1.register(platformSpecs);

    // TOTP enrolment (any authenticated user, own account only)
    v1.post('/auth/totp/enroll', async (req) => {
      const secret = totpSecret();
      await q('UPDATE lcos.users SET totp_secret=$2, totp_enabled=false WHERE id=$1',
        [req.actor.id, secret]);
      return { secret,
        otpauth_url: `otpauth://totp/Letena%20OS:${encodeURIComponent(req.actor.label)}?secret=${secret}&issuer=Letena%20OS` };
    });
    v1.post('/auth/totp/verify', async (req, reply) => {
      const u = await one('SELECT totp_secret FROM lcos.users WHERE id=$1', [req.actor.id]);
      if (!u?.totp_secret || !totpVerify(u.totp_secret, req.body?.code)) {
        return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'code does not match'));
      }
      await q('UPDATE lcos.users SET totp_enabled=true WHERE id=$1', [req.actor.id]);
      return { ok: true, totp_enabled: true };
    });

    // ----- retention sweep (quarantine 14d purge, sanitized text 24m purge) -----
    v1.post('/platform/retention-sweep', async (req, reply) => {
      const allowed = req.actor.permissions.includes('settings.manage')
        || req.actor.roles?.includes('automation') || req.actor.roles?.includes('admin');
      if (!allowed) return reply.code(403).send(err(403, 'FORBIDDEN', 'settings.manage or automation'));
      const quarantinePurged = (await q(
        `UPDATE lcos.audience_questions
         SET status='PURGED', sanitized_text='[purged: quarantine expired]', embedding=NULL,
             deid_redactions='[]'
         WHERE status='QUARANTINED' AND ingested_at < now() - interval '14 days'
         RETURNING id`)).rows.length;
      const retentionPurged = (await q(
        `UPDATE lcos.audience_questions
         SET sanitized_text='[purged: retention window passed]', embedding=NULL, status='ARCHIVED'
         WHERE purge_after < CURRENT_DATE AND status NOT IN ('PURGED','ARCHIVED')
         RETURNING id`)).rows.length;
      const { audit } = await import('./core.mjs');
      await audit(null, { actor: req.actor, action: 'retention.sweep', objectType: 'QUESTION',
        reason: `quarantine_purged=${quarantinePurged} retention_purged=${retentionPurged}` });
      return { quarantine_purged: quarantinePurged, retention_purged: retentionPurged };
    });

    // ----- costs -----
    v1.get('/analytics/costs', async (req, reply) => {
      if (!req.actor.permissions.includes('analytics.read')) {
        return reply.code(403).send(err(403, 'FORBIDDEN', 'analytics.read'));
      }
      const [byMonth, byAgent, renders, perPiece] = await Promise.all([
        q(`SELECT to_char(date_trunc('month', occurred_at), 'YYYY-MM') AS month,
                  count(*)::int AS calls, COALESCE(sum(input_tokens),0)::bigint AS input_tokens,
                  COALESCE(sum(output_tokens),0)::bigint AS output_tokens,
                  COALESCE(sum(cost_usd),0)::numeric(12,4) AS ai_cost_usd
           FROM lcos.ai_invocations GROUP BY 1 ORDER BY 1 DESC LIMIT 12`),
        q(`SELECT agent_name, count(*)::int AS calls,
                  COALESCE(sum(cost_usd),0)::numeric(12,4) AS cost_usd,
                  count(*) FILTER (WHERE outcome <> 'SUCCESS')::int AS failures
           FROM lcos.ai_invocations GROUP BY agent_name ORDER BY cost_usd DESC`),
        q(`SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
                  count(*)::int AS renders, COALESCE(sum(cost_usd),0)::numeric(12,4) AS render_cost_usd
           FROM lcos.renders GROUP BY 1 ORDER BY 1 DESC LIMIT 12`),
        q(`SELECT * FROM lcos.v_cost_per_piece ORDER BY published_pieces DESC NULLS LAST LIMIT 50`),
      ]);
      return { by_month: byMonth.rows, by_agent: byAgent.rows,
        renders_by_month: renders.rows, per_piece: perPiece.rows };
    });

    // ----- users & roles (admin) -----
    v1.get('/platform/users', async (req, reply) => {
      if (!req.actor.permissions.includes('user.manage')) {
        return reply.code(403).send(err(403, 'FORBIDDEN', 'user.manage'));
      }
      const r = await q(
        `SELECT u.id, u.email, u.full_name, u.is_active, u.totp_enabled, u.last_login_at,
                array_agg(ro.slug ORDER BY ro.slug) FILTER (WHERE ro.slug IS NOT NULL) AS roles
         FROM lcos.users u
         LEFT JOIN lcos.user_roles ur ON ur.user_id=u.id
         LEFT JOIN lcos.roles ro ON ro.id=ur.role_id
         WHERE NOT u.is_service_account
         GROUP BY u.id ORDER BY u.full_name`);
      return { items: r.rows };
    });
    v1.post('/platform/users', async (req, reply) => {
      if (!req.actor.permissions.includes('user.manage')) {
        return reply.code(403).send(err(403, 'FORBIDDEN', 'user.manage'));
      }
      const { email, full_name, password, role_slug } = req.body ?? {};
      if (!email || !full_name || !password || !role_slug) {
        return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'email, full_name, password, role_slug required'));
      }
      if (password.length < 12) {
        return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'password must be at least 12 characters'));
      }
      const bcrypt = (await import('bcryptjs')).default;
      const u = await one(
        `INSERT INTO lcos.users (email, full_name, password_hash) VALUES ($1,$2,$3)
         ON CONFLICT ((lower(email))) DO NOTHING RETURNING id, email, full_name`,
        [email, full_name, bcrypt.hashSync(password, 10)]);
      if (!u) return reply.code(409).send(err(409, 'CONFLICT', 'email already exists'));
      const granted = await one(
        `INSERT INTO lcos.user_roles (user_id, role_id)
         SELECT $1, id FROM lcos.roles WHERE slug=$2 RETURNING user_id`, [u.id, role_slug]);
      if (!granted) return reply.code(422).send(err(422, 'VALIDATION_ERROR', `unknown role ${role_slug}`));
      const { audit } = await import('./core.mjs');
      await audit(null, { actor: req.actor, action: 'user.create', objectType: 'USER',
        objectId: u.id, reason: `role ${role_slug}` });
      return reply.code(201).send({ ...u, role: role_slug });
    });
    v1.post('/platform/users/:id/roles', async (req, reply) => {
      if (!req.actor.permissions.includes('user.manage')) {
        return reply.code(403).send(err(403, 'FORBIDDEN', 'user.manage'));
      }
      const granted = await one(
        `INSERT INTO lcos.user_roles (user_id, role_id)
         SELECT $1, id FROM lcos.roles WHERE slug=$2
         ON CONFLICT DO NOTHING RETURNING user_id`, [req.params.id, req.body?.role_slug]);
      const { audit } = await import('./core.mjs');
      await audit(null, { actor: req.actor, action: 'user.role_granted', objectType: 'USER',
        objectId: req.params.id, reason: req.body?.role_slug });
      return { ok: true, granted: !!granted };
    });
    v1.post('/platform/users/:id/deactivate', async (req, reply) => {
      if (!req.actor.permissions.includes('user.manage')) {
        return reply.code(403).send(err(403, 'FORBIDDEN', 'user.manage'));
      }
      if (req.params.id === req.actor.id) {
        return reply.code(422).send(err(422, 'GUARD_FAILED', 'You cannot deactivate yourself.',
          { guard: 'notSelf' }));
      }
      await q(`UPDATE lcos.users SET is_active=false WHERE id=$1`, [req.params.id]);
      const { audit } = await import('./core.mjs');
      await audit(null, { actor: req.actor, action: 'user.deactivated', objectType: 'USER',
        objectId: req.params.id });
      return { ok: true };
    });

    // platform: audit read, settings, dashboard
    v1.get('/platform/audit', async (req, reply) => {
      if (!req.actor.permissions.includes('audit.read')) {
        return reply.code(403).send(err(403, 'FORBIDDEN', 'audit.read'));
      }
      const r = await q(`SELECT * FROM lcos.audit_log ORDER BY occurred_at DESC LIMIT 200`);
      return { items: r.rows };
    });
    v1.get('/platform/settings', async (req, reply) => {
      if (!req.actor.permissions.includes('settings.read')) {
        return reply.code(403).send(err(403, 'FORBIDDEN', 'settings.read'));
      }
      const r = await q(`SELECT key, value, description FROM lcos.settings WHERE NOT is_secret ORDER BY key`);
      return { items: r.rows };
    });
    // Editable operational settings. Non-secret keys only; cred.* goes through
    // the credentials route. publishing.mode and approval.override get their
    // values validated so a typo cannot silently turn a safety gate off.
    // approval.override is additionally admin-role-gated (Nate: "place
    // override options in settings for me as admin"): settings.manage alone
    // (also held by the developer role) is not enough to flip this one.
    v1.put('/platform/settings', async (req, reply) => {
      if (!req.actor.permissions.includes('settings.manage')) {
        return reply.code(403).send(err(403, 'FORBIDDEN', 'settings.manage'));
      }
      const { key, value } = req.body ?? {};
      if (!key || String(key).startsWith('cred.')) {
        return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'bad settings key'));
      }
      if (key === 'publishing.mode'
          && !['DRAFT_BATCH', 'AUTO_EXCEPT_SENSITIVE', 'FULL_AUTO'].includes(value)) {
        return reply.code(422).send(err(422, 'VALIDATION_ERROR',
          'publishing.mode must be DRAFT_BATCH, AUTO_EXCEPT_SENSITIVE or FULL_AUTO'));
      }
      if (key === 'approval.override') {
        if (!['OFF', 'ADMIN_TEST_MODE'].includes(value)) {
          return reply.code(422).send(err(422, 'VALIDATION_ERROR',
            'approval.override must be OFF or ADMIN_TEST_MODE'));
        }
        if (!req.actor.roles?.includes('admin')) {
          return reply.code(403).send(err(403, 'FORBIDDEN',
            'approval.override may only be changed by the admin role', { guard: 'adminOnlySetting' }));
        }
      }
      // content.tone_preset selects the default tone/voice for AI-generated
      // copy (apps/api/src/ai/gateway.mjs); only a known, active preset key
      // is accepted so a typo cannot silently fall through to no guidance.
      if (key === 'content.tone_preset') {
        const preset = await one(
          `SELECT key FROM lcos.tone_presets WHERE key=$1 AND is_active`, [value]);
        if (!preset) {
          return reply.code(422).send(err(422, 'VALIDATION_ERROR',
            `content.tone_preset must be an active tone preset key (e.g. LETENA_DEFAULT)`));
        }
      }
      const row = await q(
        `UPDATE lcos.settings SET value=$2::jsonb, updated_by=$3, updated_at=now()
         WHERE key=$1 AND NOT is_secret RETURNING key`,
        [key, JSON.stringify(value), req.actor.id ?? null]);
      if (!row.rows.length) return reply.code(404).send(err(404, 'NOT_FOUND', 'unknown setting'));
      invalidateSetting(key);
      await audit(null, { actor: req.actor, action: 'setting.updated', objectType: 'SETTING', objectCode: key,
        toState: key === 'approval.override' || key === 'publishing.mode' ? String(value) : null });
      return { ok: true, key, value };
    });
    // Provider credentials: statuses only, never values. settings.manage gated.
    v1.get('/platform/credentials', async (req, reply) => {
      if (!req.actor.permissions.includes('settings.manage')) {
        return reply.code(403).send(err(403, 'FORBIDDEN', 'settings.manage'));
      }
      return { items: CRED_REGISTRY.map((r) => ({
        key: r.key, label: r.label, group: r.group, secret: r.secret,
        hint: r.hint, status: credStatus(r.key) })) };
    });
    v1.put('/platform/credentials', async (req, reply) => {
      if (!req.actor.permissions.includes('settings.manage')) {
        return reply.code(403).send(err(403, 'FORBIDDEN', 'settings.manage'));
      }
      const { key, value } = req.body ?? {};
      if (!key) return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'key required'));
      await setCred(key, String(value ?? '').trim(), req.actor.id ?? null);
      await audit(null, { actor: req.actor,
        action: String(value ?? '').trim() ? 'credential.set' : 'credential.cleared',
        objectType: 'SETTING', objectCode: key });
      return { ok: true, key, status: credStatus(key) };
    });
    v1.get('/platform/dashboard', async () => {
      const [qToday, quarantine, scriptsReview, rendering, awaitingApproval, scheduled, cardsDue, deadLetters] =
        await Promise.all([
          q(`SELECT count(*)::int n FROM lcos.audience_questions WHERE ingested_at > now() - interval '24 hours'`),
          q(`SELECT count(*)::int n FROM lcos.audience_questions WHERE status='QUARANTINED'`),
          q(`SELECT count(*)::int n FROM lcos.scripts WHERE status IN ('CLINICAL_REVIEW','LANGUAGE_REVIEW')`),
          q(`SELECT count(*)::int n FROM lcos.production_jobs WHERE status IN ('QUEUED','RENDERING')`),
          q(`SELECT count(*)::int n FROM lcos.review_tasks WHERE status IN ('OPEN','IN_PROGRESS')`),
          q(`SELECT count(*)::int n FROM lcos.publishing_jobs WHERE status='SCHEDULED'`),
          q(`SELECT count(*)::int n FROM lcos.knowledge_cards WHERE status='APPROVED' AND review_due_at < CURRENT_DATE + 30`),
          q(`SELECT count(*)::int n FROM lcos.workflow_events WHERE status='DEAD_LETTER' AND NOT resolved`),
        ]);
      return {
        questions_24h: qToday.rows[0].n, quarantine: quarantine.rows[0].n,
        scripts_awaiting_review: scriptsReview.rows[0].n, videos_rendering: rendering.rows[0].n,
        reviews_open: awaitingApproval.rows[0].n, scheduled_posts: scheduled.rows[0].n,
        cards_due_review: cardsDue.rows[0].n, dead_letters: deadLetters.rows[0].n,
      };
    });
  }, { prefix: '/api/v1' });

  app.setErrorHandler((e, req, reply) => {
    req.log?.error?.(e);
    reply.code(e.statusCode ?? 500).send(err(e.statusCode ?? 500, 'INTERNAL', e.message));
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await buildServer();
  const port = Number(process.env.PORT || 8080);
  app.listen({ port, host: '0.0.0.0' })
    .then(() => console.log(`lcos-api listening on :${port} (AI=${process.env.LCOS_AI_PROVIDER || 'MOCK'}, adapters=${process.env.LCOS_ADAPTER_MODE || 'MOCK'})`))
    .catch((e) => { console.error(e); process.exit(1); });
}
