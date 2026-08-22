// LCOS API server. Fastify, one process, modules registered under /api/v1.
// Also serves the admin UI (apps/web) as static files.
import Fastify from 'fastify';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { authPlugin, login, err, q, one, totpSecret, totpVerify, audit, invalidateSetting, userPermissions, userRoles, setting } from './core.mjs';
import { aiDailyBudgetStatus } from './ai/gateway.mjs';
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
import pipeline from './modules/pipeline.mjs';
import transcripts from './modules/transcripts.mjs';
import studio from './modules/studio.mjs';

export async function buildServer() {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test',
    bodyLimit: 2 * 1024 * 1024 });

  // Put the Ethiopic font where fontconfig can find it before anything asks
  // for a card (22 Aug 2026). Fire and forget: the promise is memoised inside,
  // every overlay render awaits the same one, and a failure here degrades a
  // card rather than stopping the server. See studio_overlays.mjs for why the
  // embedded @font-face was never enough.
  import('./modules/studio_overlays.mjs')
    .then(m => m.ensureEthiopicFontsInstalled())
    .then(r => { if (!r?.ok) app.log?.warn?.({ font: r }, 'Amharic font not installed'); })
    .catch(() => {});

  app.get('/healthz', async () => {
    await q('SELECT 1');
    // Whether Amharic can actually be drawn is a health fact. It failed
    // silently for a whole build otherwise: the cards rendered, they just had
    // boxes where the words were.
    let fonts = null;
    try { fonts = await (await import('./modules/studio_overlays.mjs')).ensureEthiopicFontsInstalled(); }
    catch (e) { fonts = { ok: false, note: e.message }; }
    return { ok: true, service: 'lcos-api', amharic_font: fonts };
  });

  // DB-backed provider credentials (Settings screen). Env stays the fallback.
  await loadCreds().catch(() => {});

  // Admin UI (no build step; EMR design language)
  const webDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

  // Cache-busting the front end, automatically (22 Aug 2026).
  //
  // index.html loaded the script as `/app.js?v=9`, a version number a human
  // was supposed to bump by hand on every deploy. Nobody did, for a long
  // time. The consequence is nastier than a stale page: the API deploys and
  // the browser does not, so a person is running old JavaScript against a
  // new server and every screen looks like it simply ignored the fix that
  // just shipped. A whole evening of "the viewer is not there" turned out
  // to be exactly this -- the code was live on the server the entire time.
  //
  // The stamp is now a hash of app.js as it sits on disk, computed once at
  // boot and substituted into whatever ?v= the file carries. It changes
  // when and only when the file changes, so an unchanged deploy keeps the
  // cache and a changed one breaks it, with nothing to remember.
  const appJsPath = join(webDir, 'app.js');
  const appJsStamp = crypto.createHash('sha256')
    .update(readFileSync(appJsPath)).digest('hex').slice(0, 12);
  const indexHtml = readFileSync(join(webDir, 'index.html'), 'utf8')
    .replace(/\/app\.js\?v=[^"']*/g, `/app.js?v=${appJsStamp}`);
  app.get('/', async (req, reply) => reply.type('text/html').send(indexHtml));
  app.get('/app.js', async (req, reply) =>
    reply.type('text/javascript').send(readFileSync(appJsPath, 'utf8')));

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

  // Authenticated media streaming for the asset library and render previews
  // (Part 2, 14 Aug 2026). The storage adapter's url() returns file:// paths
  // that a browser cannot open, which is the whole reason the existing
  // asset screen was "a text table with no pictures". <img>/<video>/<audio>
  // tags cannot send an Authorization header, so this route accepts the
  // session JWT as ?token= and verifies it itself (the auth hook in
  // core.mjs skips /api/v1/media/ for exactly this reason). Path traversal
  // is refused by resolving against the storage root.
  app.get('/api/v1/media/*', async (req, reply) => {
    const jwtLib = (await import('jsonwebtoken')).default;
    const { JWT_SECRET } = await import('./core.mjs');
    const nodePath = await import('node:path');
    const fs = await import('node:fs');
    const token = String(req.query?.token ?? (req.headers.authorization ?? '').replace(/^Bearer /, ''));
    try { jwtLib.verify(token, JWT_SECRET); }
    catch { return reply.code(401).send(err(401, 'UNAUTHENTICATED', 'valid token required for media')); }
    const store = process.env.LCOS_STORAGE_DIR || '/tmp/lcos-storage';
    const key = String(req.params['*'] ?? '');
    const full = nodePath.resolve(store, key);
    if (!full.startsWith(nodePath.resolve(store) + nodePath.sep) || !fs.existsSync(full)
        || !fs.statSync(full).isFile()) {
      return reply.code(404).send(err(404, 'NOT_FOUND', 'media'));
    }
    // 21 Aug 2026: 'mpeg', 'm4a', 'mov' and 'aac' were added after the house
    // background track uploaded as audio/mpeg came back through this route as
    // application/octet-stream and would not play in the library's <audio>
    // tag. The upload path in modules/assets.mjs derives the stored file's
    // extension from the mime SUBTYPE, so audio/mpeg lands on disk as .mpeg,
    // not .mp3, and this table had no row for it. assets.mjs now maps mime
    // types to real extensions, but files already on disk keep the extension
    // they were written with, so both halves of the fix are needed.
    const types = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      webp: 'image/webp', svg: 'image/svg+xml',
      mp3: 'audio/mpeg', mpeg: 'audio/mpeg', mpga: 'audio/mpeg', m4a: 'audio/mp4',
      aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', json: 'application/json' };
    const ext = full.split('.').pop().toLowerCase();
    const mime = types[ext] ?? 'application/octet-stream';
    const size = fs.statSync(full).size;

    // Byte ranges (22 Aug 2026). This route streamed whole files and answered
    // no Range header, so no browser could seek any video it served: setting
    // currentTime silently did nothing and the element sat at frame zero.
    // Every video in the app was therefore unscrubbable -- the rough-cut
    // player included, which is the one place a producer most needs to jump
    // to 0:18 and look at something. It presented as "the player is broken",
    // which is why it went unfixed: nothing errored, it just refused to move.
    //
    // Accept-Ranges is advertised for every file so a client knows it may ask.
    // A malformed or unsatisfiable range gets 416 with the real size rather
    // than a silent full-body reply, because a client that asked for bytes it
    // cannot have should be told so.
    reply.header('Accept-Ranges', 'bytes');
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
      if (!m || (m[1] === '' && m[2] === '')) {
        return reply.code(416).header('Content-Range', `bytes */${size}`)
          .send(err(416, 'RANGE_NOT_SATISFIABLE', `could not read the Range header: ${range}`));
      }
      // "bytes=-500" means the LAST 500 bytes, not "from 0 to 500". Getting
      // this backwards serves the wrong part of the file with a 206 on it,
      // which looks like corruption rather than like a bug.
      let start, end;
      if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; }
      else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
        return reply.code(416).header('Content-Range', `bytes */${size}`)
          .send(err(416, 'RANGE_NOT_SATISFIABLE', `range ${range} does not fit a ${size} byte file`));
      }
      reply.code(206)
        .header('Content-Range', `bytes ${start}-${end}/${size}`)
        .header('Content-Length', String(end - start + 1))
        .type(mime);
      return reply.send(fs.createReadStream(full, { start, end }));
    }
    reply.header('Content-Length', String(size)).type(mime);
    return reply.send(fs.createReadStream(full));
  });

  // The brand kit, served to anything that needs a Letena value (22 Aug 2026).
  // Deliberately outside the authenticated plugin below and alongside media:
  // a colour is not a secret, and a burn-in job or a build step that has to
  // authenticate to learn what shade of blue the brand is will end up with a
  // hard-coded shade of blue instead. Which is exactly what kept happening.
  app.get('/api/v1/brand', async () => {
    const { LETENA_BRAND, BRAND_HEX } = await import('./brand.mjs');
    return { ...LETENA_BRAND, hex: BRAND_HEX };
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
    await v1.register(pipeline);
    await v1.register(transcripts);
    await v1.register(studio);

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
    // Reactivate closes the loop Deactivate opened: Nate, 15 Aug 2026, just
    // wanted a way back, not a separate archived state.
    v1.post('/platform/users/:id/reactivate', async (req, reply) => {
      if (!req.actor.permissions.includes('user.manage')) {
        return reply.code(403).send(err(403, 'FORBIDDEN', 'user.manage'));
      }
      await q(`UPDATE lcos.users SET is_active=true WHERE id=$1`, [req.params.id]);
      await audit(null, { actor: req.actor, action: 'user.reactivated', objectType: 'USER',
        objectId: req.params.id });
      return { ok: true };
    });
    v1.get('/platform/roles', async (req, reply) => {
      if (!req.actor.permissions.includes('user.manage')) {
        return reply.code(403).send(err(403, 'FORBIDDEN', 'user.manage'));
      }
      const r = await q(
        `SELECT slug, name, description, is_clinical FROM lcos.roles
         WHERE slug != 'automation' ORDER BY name`);
      return { items: r.rows };
    });
    v1.get('/platform/permissions', async (req, reply) => {
      if (!req.actor.permissions.includes('user.manage')) {
        return reply.code(403).send(err(403, 'FORBIDDEN', 'user.manage'));
      }
      const r = await q(`SELECT slug, domain, description FROM lcos.permissions ORDER BY domain, slug`);
      return { items: r.rows };
    });
    // Full detail for the user editor screen: roles, any per-user permission
    // overrides on top of those roles, and the effective permission set
    // those two combine into, so the screen never has to recompute the
    // override logic itself.
    v1.get('/platform/users/:id', async (req, reply) => {
      if (!req.actor.permissions.includes('user.manage')) {
        return reply.code(403).send(err(403, 'FORBIDDEN', 'user.manage'));
      }
      const u = await one(
        `SELECT id, email, full_name, is_active, totp_enabled, last_login_at FROM lcos.users WHERE id=$1`,
        [req.params.id]);
      if (!u) return reply.code(404).send(err(404, 'NOT_FOUND', 'user'));
      const roles = await userRoles(u.id);
      const overrides = (await q(
        `SELECT p.slug, upo.effect, upo.reason, upo.set_at
         FROM lcos.user_permission_overrides upo JOIN lcos.permissions p ON p.id = upo.permission_id
         WHERE upo.user_id = $1`, [u.id])).rows;
      const effective_permissions = await userPermissions(u.id);
      return { ...u, roles, overrides, effective_permissions };
    });
    // Name and email only (Nate, 15 Aug 2026: phone and photo are not worth
    // it yet -- these are staff accounts, the schema has neither field, and
    // a photo means real file storage, not just a form).
    v1.patch('/platform/users/:id', async (req, reply) => {
      if (!req.actor.permissions.includes('user.manage')) {
        return reply.code(403).send(err(403, 'FORBIDDEN', 'user.manage'));
      }
      const { full_name, email } = req.body ?? {};
      if (!full_name && !email) {
        return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'full_name or email required'));
      }
      const sets = []; const vals = [req.params.id]; let i = 2;
      if (full_name) { sets.push(`full_name=$${i++}`); vals.push(full_name); }
      if (email) { sets.push(`email=$${i++}`); vals.push(email); }
      let u;
      try {
        u = await one(
          `UPDATE lcos.users SET ${sets.join(', ')}, updated_at=now() WHERE id=$1
           RETURNING id, email, full_name`, vals);
      } catch (e) {
        if (e.code === '23505') return reply.code(409).send(err(409, 'CONFLICT', 'email already exists'));
        throw e;
      }
      if (!u) return reply.code(404).send(err(404, 'NOT_FOUND', 'user'));
      await audit(null, { actor: req.actor, action: 'user.profile_edited', objectType: 'USER',
        objectId: u.id, reason: [full_name ? 'name' : null, email ? 'email' : null].filter(Boolean).join(', ') });
      return u;
    });
    // Reset an existing user's password, either admin-typed or auto-generated.
    // The plain password is returned in the response body exactly once, for
    // the admin to copy and hand to that person; it is never stored,
    // logged, or written into the audit reason (only "generated"/"set by
    // admin" is recorded there). Added 15 Aug 2026, Nate: "I cant set a
    // password or have you autogenerate a password, or change the password
    // or reset it."
    v1.post('/platform/users/:id/password', async (req, reply) => {
      if (!req.actor.permissions.includes('user.manage')) {
        return reply.code(403).send(err(403, 'FORBIDDEN', 'user.manage'));
      }
      const { password, generate } = req.body ?? {};
      let plain;
      if (generate) {
        const crypto = await import('node:crypto');
        // Excludes visually ambiguous characters (0/O, 1/l/I) since a
        // generated password is often read aloud or retyped by hand.
        const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
        plain = Array.from(crypto.randomBytes(16)).map(b => alphabet[b % alphabet.length]).join('');
      } else if (password) {
        if (password.length < 12) {
          return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'password must be at least 12 characters'));
        }
        plain = password;
      } else {
        return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'password or generate required'));
      }
      const bcrypt = (await import('bcryptjs')).default;
      const u = await one(
        `UPDATE lcos.users SET password_hash=$2, updated_at=now() WHERE id=$1 RETURNING id, email, full_name`,
        [req.params.id, bcrypt.hashSync(plain, 10)]);
      if (!u) return reply.code(404).send(err(404, 'NOT_FOUND', 'user'));
      await audit(null, { actor: req.actor, action: 'user.password_reset', objectType: 'USER',
        objectId: u.id, reason: generate ? 'generated' : 'set by admin' });
      return { ok: true, password: generate ? plain : undefined };
    });
    v1.delete('/platform/users/:id/roles/:slug', async (req, reply) => {
      if (!req.actor.permissions.includes('user.manage')) {
        return reply.code(403).send(err(403, 'FORBIDDEN', 'user.manage'));
      }
      if (req.params.id === req.actor.id && req.params.slug === 'admin') {
        return reply.code(422).send(err(422, 'GUARD_FAILED',
          'You cannot remove your own admin role.', { guard: 'notSelfAdmin' }));
      }
      const current = await userRoles(req.params.id);
      if (current.length <= 1 && current.includes(req.params.slug)) {
        return reply.code(422).send(err(422, 'GUARD_FAILED',
          'A user must hold at least one role. Add another role before removing this one.',
          { guard: 'lastRole' }));
      }
      await q(
        `DELETE FROM lcos.user_roles WHERE user_id=$1
         AND role_id=(SELECT id FROM lcos.roles WHERE slug=$2)`, [req.params.id, req.params.slug]);
      await audit(null, { actor: req.actor, action: 'user.role_revoked', objectType: 'USER',
        objectId: req.params.id, reason: req.params.slug });
      return { ok: true };
    });
    // The permission-override layer itself: GRANT adds a permission the
    // user's roles don't carry, REVOKE removes one they would otherwise
    // have, effect: null clears the override back to whatever the role(s)
    // say by default. userPermissions() in core.mjs applies this on every
    // request, so it takes effect immediately, no re-login needed.
    v1.post('/platform/users/:id/permissions', async (req, reply) => {
      if (!req.actor.permissions.includes('user.manage')) {
        return reply.code(403).send(err(403, 'FORBIDDEN', 'user.manage'));
      }
      const { permission_slug, effect, reason } = req.body ?? {};
      if (!permission_slug || ![null, undefined, 'GRANT', 'REVOKE'].includes(effect)) {
        return reply.code(422).send(err(422, 'VALIDATION_ERROR',
          'permission_slug required; effect must be GRANT, REVOKE, or null to clear'));
      }
      const perm = await one(`SELECT id FROM lcos.permissions WHERE slug=$1`, [permission_slug]);
      if (!perm) return reply.code(422).send(err(422, 'VALIDATION_ERROR', `unknown permission ${permission_slug}`));
      if (!effect) {
        await q(`DELETE FROM lcos.user_permission_overrides WHERE user_id=$1 AND permission_id=$2`,
          [req.params.id, perm.id]);
      } else {
        await q(
          `INSERT INTO lcos.user_permission_overrides (user_id, permission_id, effect, set_by, reason)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (user_id, permission_id) DO UPDATE SET effect=$3, set_by=$4, reason=$5, set_at=now()`,
          [req.params.id, perm.id, effect, req.actor.id, reason ?? null]);
      }
      await audit(null, { actor: req.actor, action: 'user.permission_override', objectType: 'USER',
        objectId: req.params.id, reason: `${permission_slug} -> ${effect ?? 'default'}` });
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
      const { key } = req.body ?? {};
      let { value } = req.body ?? {};
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
      // review.clinical_review_enabled: whether a TIER_3/TIER_4 script that
      // passes claim validation stops for a doctor's clinical sign-off, or
      // auto-approves straight through (routeReviews() in content.mjs).
      // Added 14 Aug 2026 (Nate: "we dont want to have clinical review
      // anymore... allow this to just run so we can see that it works
      // first... add an admin toggle... have it off for now") to unblock
      // testing the rest of the pipeline (production, publish) without a
      // human reviewer in the loop, with an explicit path back to turning
      // it on. Admin-only and strict-boolean for the same reason
      // approval.override is: this is a safety gate, not a preference, so a
      // typo or a non-admin flipping it must not be possible.
      if (key === 'review.clinical_review_enabled') {
        if (typeof value !== 'boolean') {
          return reply.code(422).send(err(422, 'VALIDATION_ERROR',
            'review.clinical_review_enabled must be true or false'));
        }
        if (!req.actor.roles?.includes('admin')) {
          return reply.code(403).send(err(403, 'FORBIDDEN',
            'review.clinical_review_enabled may only be changed by the admin role', { guard: 'adminOnlySetting' }));
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
      // ai.daily_spend_cap_usd: pre-existing setting (default 40, "Hard stop
      // for AI spend per day") that turned out not to actually stop
      // anything -- found live 16 Aug 2026 that it was read-and-displayed
      // only, never enforced against real invokeAgent() calls. Fixed in
      // ai/gateway.mjs's aiDailyBudgetStatus(), which now genuinely gates
      // every call. null/blank means no cap; anything else must be a
      // non-negative number.
      if (key === 'ai.daily_spend_cap_usd') {
        if (value !== null && value !== '' && (typeof value !== 'number' || value < 0)) {
          return reply.code(422).send(err(422, 'VALIDATION_ERROR',
            'ai.daily_spend_cap_usd must be a non-negative number, or blank for no cap'));
        }
        if (value === '') value = null;
      }
      // demand.backlog_notify_threshold: how many pending-classification
      // questions accumulate before the in-app banner tells someone to run
      // a batch. Replaces the old automatic every-5-minute sweep with a
      // "tell me, I'll pull it" model (Nate, 15 Aug 2026).
      if (key === 'demand.backlog_notify_threshold') {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
          return reply.code(422).send(err(422, 'VALIDATION_ERROR',
            'demand.backlog_notify_threshold must be a whole number of 1 or more'));
        }
      }
      const row = await q(
        `UPDATE lcos.settings SET value=$2::jsonb, updated_by=$3, updated_at=now()
         WHERE key=$1 AND NOT is_secret RETURNING key`,
        [key, JSON.stringify(value), req.actor.id ?? null]);
      if (!row.rows.length) return reply.code(404).send(err(404, 'NOT_FOUND', 'unknown setting'));
      invalidateSetting(key);
      await audit(null, { actor: req.actor, action: 'setting.updated', objectType: 'SETTING', objectCode: key,
        toState: ['approval.override', 'publishing.mode', 'review.clinical_review_enabled'].includes(key) ? String(value) : null });
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
      const [qToday, quarantine, scriptsReview, rendering, awaitingApproval, scheduled, cardsDue, deadLetters,
             pendingClassification, backlogThreshold, budget] =
        await Promise.all([
          q(`SELECT count(*)::int n FROM lcos.audience_questions WHERE ingested_at > now() - interval '24 hours'`),
          q(`SELECT count(*)::int n FROM lcos.audience_questions WHERE status='QUARANTINED'`),
          q(`SELECT count(*)::int n FROM lcos.scripts WHERE status IN ('CLINICAL_REVIEW','LANGUAGE_REVIEW')`),
          q(`SELECT count(*)::int n FROM lcos.production_jobs WHERE status IN ('QUEUED','RENDERING')`),
          q(`SELECT count(*)::int n FROM lcos.review_tasks WHERE status IN ('OPEN','IN_PROGRESS')`),
          q(`SELECT count(*)::int n FROM lcos.publishing_jobs WHERE status='SCHEDULED'`),
          q(`SELECT count(*)::int n FROM lcos.knowledge_cards WHERE status='APPROVED' AND review_due_at < CURRENT_DATE + 30`),
          q(`SELECT count(*)::int n FROM lcos.workflow_events WHERE status='DEAD_LETTER' AND NOT resolved`),
          q(`SELECT count(*)::int n FROM lcos.audience_questions WHERE status='DEIDENTIFIED'`),
          setting('demand.backlog_notify_threshold', 50),
          aiDailyBudgetStatus(),
        ]);
      return {
        questions_24h: qToday.rows[0].n, quarantine: quarantine.rows[0].n,
        scripts_awaiting_review: scriptsReview.rows[0].n, videos_rendering: rendering.rows[0].n,
        reviews_open: awaitingApproval.rows[0].n, scheduled_posts: scheduled.rows[0].n,
        cards_due_review: cardsDue.rows[0].n, dead_letters: deadLetters.rows[0].n,
        // Backlog/budget banner (15 Aug 2026): replaces the old automatic
        // classify sweep. Nothing runs by itself; this just tells whoever
        // is looking that a batch is worth pulling, or that spend hit its
        // ceiling for the day.
        pending_classification: pendingClassification.rows[0].n,
        backlog_notify_threshold: Number(backlogThreshold),
        ai_budget: budget,
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
