// Core: db re-export, audit, auth, RBAC, state machine. One file because these
// five things are one concern: who may move what, and proving they did.
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { pool, q, one, tx } from '../../../packages/db/src/pool.mjs';

export { pool, q, one, tx };
export const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';

// ---------- audit ----------
export async function audit(client, { actor, action, objectType, objectId = null,
  objectCode = null, fromState = null, toState = null, reason = null, diff = null, requestId = null }) {
  const exec = client?.query ? client : pool;
  await exec.query(
    `INSERT INTO lcos.audit_log (actor_user_id, actor_type, actor_label, action,
       object_type, object_id, object_code, from_state, to_state, reason, diff, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [actor?.id ?? null, actor?.type ?? 'USER', actor?.label ?? null, action,
     objectType, objectId, objectCode, fromState, toState, reason,
     diff ? JSON.stringify(diff) : null, requestId]);
}

// ---------- TOTP (RFC 6238, SHA-1, 30s step, 6 digits) ----------
import crypto from 'node:crypto';
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function totpSecret() {
  const buf = crypto.randomBytes(20);
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}
function b32decode(s) {
  let bits = '';
  for (const c of s.toUpperCase().replace(/=+$/, '')) {
    const v = B32.indexOf(c); if (v < 0) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
export function totpCode(secret, t = Date.now(), step = 30) {
  const counter = Math.floor(t / 1000 / step);
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', b32decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const num = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(num % 1_000_000).padStart(6, '0');
}
export function totpVerify(secret, code, t = Date.now()) {
  return [-1, 0, 1].some(w => totpCode(secret, t + w * 30_000) === String(code).padStart(6, '0'));
}

// ---------- auth ----------
export async function login(email, password, totp) {
  const u = await one(
    `SELECT id, email, full_name, password_hash, is_active, totp_enabled, totp_secret
     FROM lcos.users WHERE lower(email) = lower($1)`, [email]);
  if (!u || !u.is_active || !u.password_hash) return null;
  if (!bcrypt.compareSync(password, u.password_hash)) return null;
  if (u.totp_enabled) {
    if (!totp || !totpVerify(u.totp_secret, totp)) return { totp_required: true };
  }
  const perms = await userPermissions(u.id);
  const roles = await userRoles(u.id);
  const token = jwt.sign({ sub: u.id, email: u.email, roles }, JWT_SECRET, { expiresIn: '12h' });
  await q('UPDATE lcos.users SET last_login_at = now() WHERE id = $1', [u.id]);
  return { token, user: { id: u.id, email: u.email, full_name: u.full_name, roles, permissions: perms } };
}

// Effective permissions = the union of every role the user holds, with
// per-user overrides applied last (0027_user_permission_overrides.sql).
// REVOKE always wins over a role grant for the same slug; GRANT adds a
// permission none of the user's roles carry. This runs on every request
// (permissions are not cached in the JWT), so an override takes effect
// immediately, no re-login needed.
export async function userPermissions(userId) {
  const r = await q(
    `SELECT p.slug,
            bool_or(rp.permission_id IS NOT NULL) AS from_role,
            (SELECT effect FROM lcos.user_permission_overrides upo
             WHERE upo.user_id = $1 AND upo.permission_id = p.id) AS override
     FROM lcos.permissions p
     LEFT JOIN lcos.role_permissions rp ON rp.permission_id = p.id
       AND rp.role_id IN (SELECT role_id FROM lcos.user_roles WHERE user_id = $1)
     GROUP BY p.id, p.slug`, [userId]);
  return r.rows.filter(x => x.override === 'REVOKE' ? false : x.override === 'GRANT' ? true : x.from_role)
    .map(x => x.slug);
}
export async function userRoles(userId) {
  const r = await q(
    `SELECT ro.slug FROM lcos.roles ro JOIN lcos.user_roles ur ON ur.role_id = ro.id
     WHERE ur.user_id = $1`, [userId]);
  return r.rows.map(x => x.slug);
}

// ---------- rate limiting (in-memory token bucket, per IP + bucket) ----------
const buckets = new Map();
export function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const b = buckets.get(key) ?? { count: 0, reset: now + windowMs };
  if (now > b.reset) { b.count = 0; b.reset = now + windowMs; }
  b.count++; buckets.set(key, b);
  if (buckets.size > 50_000) buckets.clear();   // crude memory bound
  return b.count <= limit;
}

// Fastify decorators: request.actor populated by the auth hook.
export function authPlugin(app) {
  app.decorateRequest('actor', null);
  app.decorateRequest('rawBody', null);

  // Keep the raw JSON bytes: HMAC callers (the PHP exporter) sign the exact
  // bytes they send, and PHP's json_encode escaping (unicode, slashes) differs
  // from JSON.stringify, so verification MUST run over the raw body.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = body;
    try { done(null, body.length ? JSON.parse(body) : {}); }
    catch (e) { e.statusCode = 400; done(e); }
  });

  // Security headers on every response.
  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; script-src 'self'; img-src 'self' data:; " +
      "connect-src 'self'");
  });

  // Rate limits: login brute force, and generation endpoints that spend money.
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    const ip = req.ip ?? 'unknown';
    if (path === '/api/v1/auth/login' && !rateLimit(`login:${ip}`, 10, 15 * 60_000)) {
      return reply.code(429).send(err(429, 'RATE_LIMITED', 'Too many login attempts. Wait 15 minutes.'));
    }
    if ((path.includes('turn-into-content') || path.endsWith('/generate') || path.includes(':generate'))
        && !rateLimit(`gen:${ip}`, 30, 60 * 60_000)) {
      return reply.code(429).send(err(429, 'RATE_LIMITED', 'Generation limit reached for this hour.'));
    }
  });
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    // /api/v1/auth/sso is exempt too: it's the EMR hand-off itself, so by
    // definition there's no LCOS bearer token yet. The route verifies the
    // HMAC-signed EMR token on its own; this hook isn't a second gate for
    // it. Fixed 14 Aug 2026: this hook was rejecting it with "missing
    // token" before the route ever ran, which is the entire SSO 401 bug.
    if (['/api/v1/auth/login', '/api/v1/auth/sso', '/healthz', '/', '/app.js'].includes(path)) return;
    // Media previews load through <img>/<video>/<audio> tags, which cannot
    // send an Authorization header, so the media route verifies its own
    // ?token= JWT (same secret, same expiry) instead of this hook.
    if (path.startsWith('/api/v1/media/')) return;
    // Ingest is auth-optional at the hook: HMAC callers carry no bearer token
    // and are verified inside the route; bearer callers still get an actor.
    const authOptional = path === '/api/v1/ingest/questions';
    const h = req.headers.authorization || '';
    if (authOptional && !h) return;
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (token && token.startsWith('svc_')) {
      const expected = process.env.LCOS_SERVICE_TOKEN || 'svc_dev_automation';
      if (token !== expected) return reply.code(401).send(err(401, 'UNAUTHENTICATED', 'bad service token'));
      const svc = await one(`SELECT id FROM lcos.users WHERE email='automation@letena.local'`);
      req.actor = { id: svc?.id ?? null, type: 'SERVICE', label: 'automation',
        permissions: await servicePermissions(), roles: ['automation'] };
      return;
    }
    if (!token) return reply.code(401).send(err(401, 'UNAUTHENTICATED', 'missing token'));
    try {
      const p = jwt.verify(token, JWT_SECRET);
      req.actor = { id: p.sub, type: 'USER', label: p.email, roles: p.roles,
        permissions: await userPermissions(p.sub) };
    } catch {
      return reply.code(401).send(err(401, 'UNAUTHENTICATED', 'invalid token'));
    }
  });
}
let _svcPerms = null;
async function servicePermissions() {
  if (!_svcPerms) {
    const r = await q(
      `SELECT p.slug FROM lcos.permissions p
       JOIN lcos.role_permissions rp ON rp.permission_id = p.id
       JOIN lcos.roles ro ON ro.id = rp.role_id WHERE ro.slug = 'automation'`);
    _svcPerms = r.rows.map(x => x.slug);
  }
  return _svcPerms;
}

export function requirePerm(perm) {
  return async (req, reply) => {
    if (!req.actor?.permissions?.includes(perm)) {
      return reply.code(403).send(err(403, 'FORBIDDEN', `requires ${perm}`));
    }
  };
}

export function err(status, code, detail, extra = {}) {
  return { type: `https://os.letena.et/errors/${code.toLowerCase()}`, title: code,
    status, code, detail, ...extra };
}

// ---------- settings ----------
const settingsCache = new Map();
export async function setting(key, fallback = null) {
  if (settingsCache.has(key) && settingsCache.get(key).t > Date.now() - 30_000) {
    return settingsCache.get(key).v;
  }
  const r = await one('SELECT value FROM lcos.settings WHERE key = $1', [key]);
  const v = r ? r.value : fallback;
  settingsCache.set(key, { v, t: Date.now() });
  return v;
}
// A write through PUT /platform/settings must take effect immediately, not
// after the cache's 30s window (a stale approval.override or publishing.mode
// read is a safety-gate bug, not a performance nuisance).
export function invalidateSetting(key) {
  settingsCache.delete(key);
}

// ---------- state machine ----------
// Guards receive ({object, ctx, client}) and throw GuardError on refusal.
export class GuardError extends Error {
  constructor(guard, message) { super(message); this.guard = guard; }
}
const G = {
  hasReason: (name) => ({ ctx }) => {
    if (!ctx.reason) throw new GuardError(name, 'A reason is required for this transition.');
  },
  // Maker-checker: the person who drafted a card or claim cannot also be its
  // only approval, so a real second set of eyes is on record for every piece
  // of clinical content. admin is exempted (owner decision, Nate/MD, 12 Aug
  // 2026): in a small team the MD is sometimes the only person available to
  // both draft and clear a card, and as the org's top authority they take
  // that responsibility knowingly rather than being blocked by a rule meant
  // to catch everyone else. This does not relax anything else in the
  // approval chain, claim validation and the publish-time card check still
  // apply exactly as before.
  reviewerIsNotAuthor: ({ object, ctx }) => {
    if (ctx.actor?.roles?.includes('admin')) return;
    if (object.created_by && object.created_by === ctx.actor.id) {
      throw new GuardError('reviewerIsNotAuthor', 'You cannot approve your own work.');
    }
  },
  contentHashMatches: async ({ object, ctx }) => {
    if (object.content_sha256 && ctx.content_sha256 && object.content_sha256 !== ctx.content_sha256) {
      throw new GuardError('contentHashMatches', 'Content changed since it was reviewed. Re-review required.');
    }
  },
};

export const machines = {
  knowledge_card: {
    table: 'lcos.knowledge_cards', objectType: 'KNOWLEDGE_CARD',
    transitions: {
      'DRAFT>IN_REVIEW': { perm: 'knowledge.submit',
        guards: [async ({ object, client }) => {
          const c = await client.query(
            'SELECT count(*)::int AS n FROM lcos.knowledge_card_claims WHERE card_id=$1', [object.id]);
          if (!c.rows[0].n) throw new GuardError('hasClaims', 'Attach at least one claim before review.');
          if (!object.current_version_id) throw new GuardError('hasVersion', 'Write the card body first.');
        }] },
      'IN_REVIEW>APPROVED': { perm: 'knowledge.approve',
        guards: [G.reviewerIsNotAuthor, async ({ object, client, ctx }) => {
          const bad = await client.query(
            `SELECT mc.code FROM lcos.knowledge_card_claims kcc
             JOIN lcos.medical_claims mc ON mc.id = kcc.claim_id
             WHERE kcc.card_id=$1 AND mc.status <> 'APPROVED' LIMIT 3`, [object.id]);
          if (bad.rows.length) {
            throw new GuardError('allClaimsApproved',
              `Unapproved claims attached: ${bad.rows.map(r => r.code).join(', ')}`);
          }
          if (!ctx.review_due_months) throw new GuardError('reviewDueSet', 'Set a review interval.');
        }],
        apply: async ({ object, ctx, client }) => {
          await client.query(
            `UPDATE lcos.knowledge_cards SET approved_version_id = current_version_id,
               reviewed_by=$2, reviewed_at=now(),
               review_due_at = CURRENT_DATE + ($3 || ' months')::interval
             WHERE id=$1`, [object.id, ctx.actor.id, String(ctx.review_due_months)]);
        } },
      'IN_REVIEW>DRAFT': { perm: 'knowledge.approve', guards: [G.hasReason('changesNeedReason')] },
      'APPROVED>NEEDS_UPDATE': { perm: 'knowledge.draft' },
      'NEEDS_UPDATE>IN_REVIEW': { perm: 'knowledge.submit' },
      'DRAFT>RETIRED': { perm: 'knowledge.retire', guards: [G.hasReason('retireNeedsReason')], apply: retireCard },
      'APPROVED>RETIRED': { perm: 'knowledge.retire', guards: [G.hasReason('retireNeedsReason')], apply: retireCard },
      'NEEDS_UPDATE>RETIRED': { perm: 'knowledge.retire', guards: [G.hasReason('retireNeedsReason')], apply: retireCard },
    },
  },
  medical_claim: {
    table: 'lcos.medical_claims', objectType: 'MEDICAL_CLAIM',
    transitions: {
      'DRAFT>IN_REVIEW': { perm: 'knowledge.submit',
        guards: [async ({ object, client }) => {
          const s = await client.query(
            `SELECT count(*)::int AS n FROM lcos.claim_sources cs
             JOIN lcos.medical_sources ms ON ms.id = cs.source_id
             WHERE cs.claim_id=$1 AND ms.status='ACTIVE'`, [object.id]);
          if (!s.rows[0].n) throw new GuardError('hasActiveSource', 'Attach an active source first.');
        }] },
      'IN_REVIEW>APPROVED': { perm: 'knowledge.approve',
        guards: [G.reviewerIsNotAuthor],
        apply: async ({ object, ctx, client }) => {
          await client.query(
            `UPDATE lcos.medical_claims SET reviewed_by=$2, reviewed_at=now(),
               review_due_at = CURRENT_DATE + interval '12 months' WHERE id=$1`,
            [object.id, ctx.actor.id]);
        } },
      'IN_REVIEW>DRAFT': { perm: 'knowledge.approve', guards: [G.hasReason('changesNeedReason')] },
      'APPROVED>NEEDS_UPDATE': { perm: 'knowledge.draft' },
      'NEEDS_UPDATE>IN_REVIEW': { perm: 'knowledge.submit' },
      'APPROVED>RETIRED': { perm: 'knowledge.retire', guards: [G.hasReason('retireNeedsReason')],
        apply: async ({ object, ctx, client }) => {
          await client.query('UPDATE lcos.medical_claims SET retired_reason=$2 WHERE id=$1',
            [object.id, ctx.reason]);
        } },
    },
  },
  script: {
    table: 'lcos.scripts', objectType: 'SCRIPT',
    transitions: {
      'DRAFT>VALIDATING': { perm: 'script.write',
        guards: [async ({ object, client }) => {
          const card = await client.query(
            `SELECT kc.status FROM lcos.content_families cf
             JOIN lcos.knowledge_cards kc ON kc.id = cf.knowledge_card_id
             WHERE cf.id = $1`, [object.family_id]);
          if (card.rows[0]?.status !== 'APPROVED') {
            throw new GuardError('cardIsApproved', 'The knowledge card is not approved.');
          }
        }] },
      'DRAFT>NEEDS_KNOWLEDGE': { perm: 'script.write' },
      // Universal reject, added 15 Aug 2026 after Nate hit three APPROVED
      // scripts with no way to kill them: "I don't care if it's been
      // approved. I should be able to bring it back." Every non-terminal
      // status gets the same REJECTED exit NEEDS_KNOWLEDGE/VALIDATION_FAILED
      // already had, all using rejectScript so the reason is recorded the
      // same way regardless of where in the pipeline the piece was.
      // Rejecting an APPROVED script does not touch anything already
      // produced or published; it only stops it being picked up for
      // production going forward. Deleting it afterward still goes through
      // the REJECTED-only DELETE route, which itself still refuses if
      // production/publishing rows already reference it.
      'DRAFT>REJECTED': { perm: 'script.write', guards: [G.hasReason('rejectNeedsReason')], apply: rejectScript },
      'NEEDS_KNOWLEDGE>DRAFT': { perm: 'script.write' },
      // A piece the writer stopped on because it needed a fact that is not
      // an approved claim can sit here indefinitely with no way to close it
      // out (Nate, 15 Aug 2026: "no way of rejecting or deleting the first
      // 2 failed ones"). This app never hard-deletes anything, every object
      // type only ever moves through audited status transitions, so the
      // fix is a real REJECTED exit here, not a delete endpoint.
      'NEEDS_KNOWLEDGE>REJECTED': { perm: 'script.write', guards: [G.hasReason('rejectNeedsReason')],
        apply: rejectScript },
      'VALIDATING>VALIDATED': { perm: 'script.write',
        guards: [async ({ object }) => {
          if (object.validation_result !== 'PASS') {
            throw new GuardError('validationPassed', 'Claim validation has not passed.');
          }
        }] },
      'VALIDATING>VALIDATION_FAILED': { perm: 'script.write' },
      'VALIDATING>REJECTED': { perm: 'script.write', guards: [G.hasReason('rejectNeedsReason')], apply: rejectScript },
      'VALIDATION_FAILED>DRAFT': { perm: 'script.write' },
      'VALIDATION_FAILED>REJECTED': { perm: 'script.write', guards: [G.hasReason('rejectNeedsReason')],
        apply: rejectScript },
      'VALIDATED>LOCALIZING': { perm: 'script.write' },
      'VALIDATED>CLINICAL_REVIEW': { perm: 'script.write' },
      'VALIDATED>REJECTED': { perm: 'script.write', guards: [G.hasReason('rejectNeedsReason')], apply: rejectScript },
      'VALIDATED>APPROVED': { perm: 'script.approve_editorial',
        guards: [G.reviewerIsNotAuthor, G.contentHashMatches,
          async ({ object }) => {
            if (['TIER_3', 'TIER_4'].includes(object.risk_tier)) {
              throw new GuardError('riskTierAtMost2', 'Tier 3 and 4 scripts require clinical review.');
            }
            if (object.validation_result !== 'PASS') {
              throw new GuardError('validationPassed', 'Claim validation has not passed.');
            }
          }],
        apply: approveScript },
      'LOCALIZING>LANGUAGE_REVIEW': { perm: 'script.write' },
      'LOCALIZING>REJECTED': { perm: 'script.write', guards: [G.hasReason('rejectNeedsReason')], apply: rejectScript },
      'LANGUAGE_REVIEW>CLINICAL_REVIEW': { perm: 'script.approve_language' },
      'LANGUAGE_REVIEW>APPROVED': { perm: 'script.approve_language',
        guards: [G.contentHashMatches, async ({ object }) => {
          if (['TIER_3', 'TIER_4'].includes(object.risk_tier)) {
            throw new GuardError('riskTierAtMost2', 'Tier 3 and 4 scripts require clinical review.');
          }
        }],
        apply: approveScript },
      'LANGUAGE_REVIEW>DRAFT': { perm: 'script.approve_language', guards: [G.hasReason('changesNeedReason')] },
      'LANGUAGE_REVIEW>REJECTED': { perm: 'script.write', guards: [G.hasReason('rejectNeedsReason')], apply: rejectScript },
      'CLINICAL_REVIEW>APPROVED': { perm: 'script.approve_clinical',
        guards: [G.reviewerIsNotAuthor, G.contentHashMatches,
          async ({ object, ctx, client }) => {
            if (object.validation_result !== 'PASS') {
              throw new GuardError('validationPassed', 'Claim validation has not passed.');
            }
            if (object.risk_tier === 'TIER_4') {
              const r = await client.query(
                `SELECT 1 FROM lcos.user_roles ur JOIN lcos.roles ro ON ro.id=ur.role_id
                 WHERE ur.user_id=$1 AND ro.slug IN ('medical_director','admin')`, [ctx.actor.id]);
              if (!r.rows.length) {
                throw new GuardError('tier4RequiresDirector', 'Tier 4 requires the medical director.');
              }
            }
            const card = await client.query(
              `SELECT kc.status FROM lcos.content_families cf
               JOIN lcos.knowledge_cards kc ON kc.id=cf.knowledge_card_id WHERE cf.id=$1`,
              [object.family_id]);
            if (card.rows[0]?.status !== 'APPROVED') {
              throw new GuardError('cardIsApproved', 'The knowledge card is no longer approved.');
            }
          }],
        apply: approveScriptClinical },
      'CLINICAL_REVIEW>DRAFT': { perm: 'script.approve_clinical', guards: [G.hasReason('changesNeedReason')] },
      'CLINICAL_REVIEW>REJECTED': { perm: 'script.approve_clinical', guards: [G.hasReason('rejectNeedsReason')],
        apply: rejectScript },
      'APPROVED>SUPERSEDED': { perm: 'script.write' },
      'APPROVED>REJECTED': { perm: 'script.write', guards: [G.hasReason('rejectNeedsReason')], apply: rejectScript },
    },
  },
};
async function retireCard({ object, ctx, client }) {
  await client.query('UPDATE lcos.knowledge_cards SET retired_reason=$2 WHERE id=$1',
    [object.id, ctx.reason]);
}
// Shared by every *>REJECTED script transition (clinical rejection, and the
// two writer-stage exits from NEEDS_KNOWLEDGE/VALIDATION_FAILED added 15 Aug
// 2026): a rejected script keeps its full audit trail instead of vanishing,
// which is the whole point of never hard-deleting content here.
async function rejectScript({ object, ctx, client }) {
  await client.query('UPDATE lcos.scripts SET rejected_reason=$2 WHERE id=$1',
    [object.id, ctx.reason]);
}
async function approveScript({ object, ctx, client }) {
  await client.query(
    `UPDATE lcos.scripts SET approved_by=$2, approved_at=now(), approved_version=current_version
     WHERE id=$1`, [object.id, ctx.actor.id]);
}
// The clinical approval transition also signs the medical_review gate (Run
// One, 14 Aug 2026): the doctor's CLINICAL_REVIEW>APPROVED decision IS the
// medical review, so the signed-gate ledger the publish transition checks
// records the same act instead of demanding a second click for it. The
// editorial and language approval paths deliberately do NOT sign it: their
// permission is not clinical, and medical_review before publish has no
// exceptions, so content approved on those paths still waits for a
// clinical signature before it can go out.
async function approveScriptClinical({ object, ctx, client }) {
  await approveScript({ object, ctx, client });
  await client.query(
    `INSERT INTO lcos.script_gates (script_id, gate, signed_by, note)
     VALUES ($1,'medical_review',$2,'clinical approval transition')
     ON CONFLICT (script_id, gate) DO NOTHING`, [object.id, ctx.actor.id]);
}

export async function transition(machineName, objectId, to, ctx) {
  const m = machines[machineName];
  if (!m) throw new Error(`unknown machine ${machineName}`);
  return tx(async (client) => {
    const r = await client.query(`SELECT * FROM ${m.table} WHERE id=$1 FOR UPDATE`, [objectId]);
    const object = r.rows[0];
    if (!object) { const e = new Error('not found'); e.status = 404; throw e; }
    const key = `${object.status}>${to}`;
    const t = m.transitions[key];
    if (!t) {
      const e = new Error(`No transition ${key} for ${machineName}`);
      e.status = 409; e.code = 'INVALID_TRANSITION'; throw e;
    }
    if (!ctx.actor?.permissions?.includes(t.perm)) {
      const e = new Error(`Transition ${key} requires ${t.perm}`);
      e.status = 403; e.code = 'FORBIDDEN'; throw e;
    }
    for (const guard of t.guards ?? []) {
      try { await guard({ object, ctx, client }); }
      catch (ge) {
        if (ge instanceof GuardError) {
          const e = new Error(ge.message); e.status = 422; e.code = 'GUARD_FAILED'; e.guard = ge.guard;
          throw e;
        }
        throw ge;
      }
    }
    // apply() runs before the status write so that DB check constraints of the
    // form "APPROVED requires approved_by" hold at every point in time.
    if (t.apply) await t.apply({ object, ctx, client });
    await client.query(`UPDATE ${m.table} SET status=$2 WHERE id=$1`, [objectId, to]);
    await audit(client, { actor: ctx.actor, action: `${machineName}.${to.toLowerCase()}`,
      objectType: m.objectType, objectId, objectCode: object.code ?? null,
      fromState: object.status, toState: to, reason: ctx.reason ?? null });
    const after = await client.query(`SELECT * FROM ${m.table} WHERE id=$1`, [objectId]);
    return after.rows[0];
  });
}
