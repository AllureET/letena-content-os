// Video Studio: phase 1 of the Allure Autonomous AI Video Studio Playbook
// v2.0 (uploaded 18 Aug 2026), built as its OWN system per the owner's
// explicit direction: "this is a much more robust system that should
// operate as its own system outside of these... So its new but much
// more." It lives in the `studio` Postgres schema, separate from `lcos`,
// and nothing here is called by send_it/save_it or the existing one-job
// Creatomate/Kling render path in production.mjs. It reuses the same app,
// the same users/auth/RBAC, and the same provider adapters as the rest of
// LCOS, because it is a new capability inside LCOS, not a separate
// deployment.
//
// PHASE 1 SCOPE ("core loop plus automated QC", owner's explicit choice):
// projects, versioned continuity locks, a shot manifest, per-shot
// generation with automated technical + continuity QC, and an assemble
// step that concatenates accepted shots into a final cut.
//
// NOT built tonight, and not silently faked:
//   - Budget guardrail enforcement (playbook 21) IS now built (18 Aug 2026
//     follow-up): every paid-generation route warns at 60%/80% of
//     budget_cap_usd and blocks at/above 90% unless an approver overrides
//     with override_budget:true (studio.approve required); spent_usd is
//     incremented from the adapter's real cost_usd when one is reported,
//     else from the placeholder ESTIMATED_COST_USD table below. A null
//     budget_cap_usd still means no cap, never blocked, never warned.
//   - A retry/repair/fallback ladder (playbook 15) IS now built (18 Aug
//     2026, second follow-up), but ONLY at the one call site it was
//     scoped to: POST /shots/:shotId/generate. See runGenerationLadder
//     below for the classification and retry/fallback rules. It is NOT
//     the playbook's full multi-agent orchestrator or retry-class routing
//     (playbook 5, 13) -- there is no repair-prompt pass, no cross-shot
//     awareness, and no ladder on any other route (lock reference, shot
//     voice, project music still make one direct call and surface the
//     raw failure, same as generate did before tonight).
//   - A real timeline/EDL (playbook 18.1) is still NOT built. assemble()
//     concatenates accepted shots in order_index order and (18 Aug 2026,
//     third follow-up) now supports an optional crossfade transition
//     between adjacent shots -- the default stays a hard cut -- plus one
//     optional project-music layer mixed under the final cut, ducked by a
//     flat volume envelope when the project has any VOICE assets rather
//     than a true time-aligned sidechain (building that would mean
//     building exactly the shot-by-shot audio timeline this bullet still
//     says is out of scope). It still does not support retiming, more
//     than one music layer, or a separate SFX mix.
//   - C2PA/Content Credentials embedding (playbook 19.5).
// Every endpoint below says so in its own comment where it matters, so a
// future reader does not mistake "phase 1 shipped" for "the playbook
// shipped."
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { q, one, audit, requirePerm, err } from '../core.mjs';
import { storage, videoEngine, gemini, suno, azureSpeech } from '../adapters/index.mjs';
import { invokeAgent } from '../ai/gateway.mjs';
import { formatOf } from '../formats.mjs';
import { OVERLAY_KINDS, validateOverlayData, describeOverlayCollision, buildOverlayFilterGraph,
  compileOverlayLayerSvg, resolveCanvasSizeForAspect, loadEthiopicFontsBase64 } from './studio_overlays.mjs';

const execFileP = promisify(execFile);
const code = (p) => `${p}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
const MOCK = () => (process.env.LCOS_ADAPTER_MODE || 'MOCK').toUpperCase() === 'MOCK';

// Estimated per-unit cost of each paid generation call (playbook section
// 21's budget guardrail needs SOME number to check spend against). These
// are PLACEHOLDERS pending a real pricing pass against each vendor's
// actual rate card, not verified figures — they exist so the 60/80/90%
// guardrail below has something concrete to compare against tonight. Every
// paid route computes estimatedCost from this table BEFORE calling the
// adapter, so the guardrail can refuse before money is spent; the ACTUAL
// spend recorded afterward prefers the adapter's own cost_usd when it
// reports a real one (see resolveSpendAmount below), so once real pricing
// is wired into adapters/index.mjs, spend tracking becomes accurate
// automatically without this table needing to change.
const ESTIMATED_COST_USD = {
  KLING_VIDEO_PER_S: 0.35,       // Kling generative video, per second of output
  VEO_VIDEO_PER_S: 0.50,         // Veo generative video, per second of output
  GEMINI_REFERENCE_IMAGE: 0.04,  // Gemini reference/keyframe still, flat per image
  GEMINI_COMPOSE_IMAGE: 0.04,    // Gemini character+environment composite still, flat per image
  SUNO_MUSIC_TRACK: 0.20,        // Suno music bed, flat per generated track
  AZURE_TTS_PER_CHAR: 0.000016,  // Azure neural TTS, per character of input text
  GEMINI_REMIX_IMAGE: 0.04,      // Gemini image-edit on an existing reference/keyframe, flat per remix
};

// ===========================================================================
// Library bridge (21 Aug 2026 -- owner request: images generated inside
// Video Studio were invisible everywhere else in LCOS). Mirrors a
// studio.assets image row into lcos.assets, the Production > Asset library
// every other part of LCOS already browses, right after it's generated,
// and records the mirror on the studio row (migration 0038) so nothing is
// ever bridged twice. kindHint maps a lock's entity_type onto the
// library's existing filters so "Character references" / "Backgrounds"
// stay meaningful for studio-generated work instead of dumping everything
// into one generic bucket; anything without a clear entity (a composed
// KEYFRAME, a remix not attached to a lock) falls back to IMAGE_PHOTO.
// Never throws into the caller's request: a bridge failure (e.g. a code
// collision) is logged as a studio event instead of failing the whole
// generation the human was actually waiting on.
async function bridgeAssetToLibrary({ asset, kindHint, title, actorId }) {
  const kind = kindHint === 'CHARACTER' ? 'CHARACTER_REFERENCE'
    : kindHint === 'ENVIRONMENT' ? 'BACKGROUND'
    : 'IMAGE_PHOTO';
  try {
    const lib = await one(
      `INSERT INTO lcos.assets (code, kind, origin, title, storage_key, mime_type, is_ai_generated,
         ai_generation_meta, is_active, uploaded_by)
       VALUES ($1,$2::lcos.asset_kind,'AI_GENERATED'::lcos.asset_origin,$3,$4,'image/png',true,$5,true,$6)
       RETURNING id`,
      [code('STUDIO'), kind, title.slice(0, 200), asset.storage_key,
       JSON.stringify({ studio_asset_id: asset.id, ...(asset.generator ?? {}) }), actorId ?? null]);
    await q(`UPDATE studio.assets SET library_asset_id=$2 WHERE id=$1`, [asset.id, lib.id]);
    return lib.id;
  } catch (e) {
    await q(`INSERT INTO studio.events (project_id, note) VALUES ($1,$2)`,
      [asset.project_id, `could not mirror asset ${asset.id} into the library: ${e.message}`]).catch(() => {});
    return null;
  }
}

// Loads the actual asset rows behind each lock's reference_asset_ids
// (newest last, matching the append-only discipline everywhere else this
// array is read) so the frontend can render a real thumbnail and a
// version history instead of the bare "has reference image" text it had
// before. Mutates each lock in place; a lock with no references gets [].
async function attachReferenceAssets(locks) {
  const allIds = [...new Set(locks.flatMap(l => l.reference_asset_ids ?? []))];
  const rows = allIds.length
    ? (await q(`SELECT id, storage_key, generator, created_at FROM studio.assets
                WHERE id = ANY($1) ORDER BY created_at`, [allIds])).rows
    : [];
  const byId = new Map(rows.map(r => [r.id, r]));
  for (const l of locks) {
    l.reference_assets = (l.reference_asset_ids ?? []).map((id) => byId.get(id)).filter(Boolean);
  }
  return locks;
}

// ===========================================================================
// Prompt compilation (playbook 12). Deterministic assembly from locks and
// shot intent, never a creative rewrite: the same discipline this session
// already applied to the canonical CTA text tonight (code assembles the
// load-bearing text, the model never freehands it). A model is free to
// help draft shot.action/camera fields upstream of this function; this
// function itself makes no model call.
// ===========================================================================

// Still/keyframe prompt grammar (playbook 12.2), used for lock reference
// generation and any first-frame still a shot needs.
export function compileStillPrompt(lock) {
  const d = lock.data ?? {};
  const lines = [];
  if (d.style_summary) lines.push(`[STYLE] ${d.style_summary}`);
  if (lock.entity_type === 'CHARACTER') {
    lines.push(`[SUBJECT] ${d.name ?? lock.entity_code}: ${[d.apparent_age, d.silhouette, d.face, d.hair]
      .filter(Boolean).join('; ')}`);
    if (d.wardrobe_variants?.default) lines.push(`[WARDROBE] ${d.wardrobe_variants.default}`);
  } else if (lock.entity_type === 'ENVIRONMENT') {
    lines.push(`[ENVIRONMENT] ${[d.architecture, d.palette, d.time, d.weather].filter(Boolean).join('; ')}`);
  } else if (lock.entity_type === 'PROP') {
    lines.push(`[PROP] ${[d.material, d.color, d.wear, d.scale_reference].filter(Boolean).join('; ')}`);
  }
  if (d.composition) lines.push(`[COMPOSITION] ${d.composition}`);
  if (d.lighting) lines.push(`[LIGHTING] ${d.lighting}`);
  if (d.aspect_ratio) lines.push(`[ASPECT] ${d.aspect_ratio}`);
  lines.push('Positive, visual description only. No embedded text, subtitles, logos, or watermark.');
  return lines.join('\n');
}

// Composition prompt grammar (Video Studio "character into background"
// step, 19 Aug 2026): a still-image prompt that places a locked
// character's subject description into a locked environment's setting
// description, for use with gemini.generateImage's referenceImageKeys --
// the model gets both this text prompt AND the two locks' own reference
// images, and the text spells out that both must be preserved exactly as
// locked, not reinterpreted. Reuses compileStillPrompt's own
// [STYLE]/[SUBJECT]/[ENVIRONMENT]/[LIGHTING] bracket-label grammar rather
// than inventing a second one, and ends with the same no-embedded-text
// rule. Pure function, no I/O, same discipline as compileStillPrompt and
// compileMotionPrompt above.
export function compileComposePrompt(characterLock, environmentLock, styleLock) {
  const cd = characterLock.data ?? {};
  const ed = environmentLock.data ?? {};
  const lines = [];
  const styleSummary = styleLock?.data?.style_summary ?? cd.style_summary ?? ed.style_summary;
  if (styleSummary) lines.push(`[STYLE] ${styleSummary}`);
  lines.push(`[SUBJECT] ${cd.name ?? characterLock.entity_code}: ${[cd.apparent_age, cd.silhouette, cd.face, cd.hair]
    .filter(Boolean).join('; ')}`);
  if (cd.wardrobe_variants?.default) lines.push(`[WARDROBE] ${cd.wardrobe_variants.default}`);
  lines.push(`[ENVIRONMENT] ${[ed.architecture, ed.palette, ed.time, ed.weather].filter(Boolean).join('; ')}`);
  lines.push(`[COMPOSITION] Place the [SUBJECT] into the [ENVIRONMENT], preserving the character's identity, wardrobe, and physical features EXACTLY as locked, and preserving the environment's architecture, palette, and setting EXACTLY as locked. Do not invent a different character or a different place -- this is the same character, this is the same place, seen together for the first time.`);
  if (ed.lighting || cd.lighting) lines.push(`[LIGHTING] ${ed.lighting ?? cd.lighting}`);
  if (styleLock?.data?.motion_grammar) lines.push(`STYLE OF MOTION: ${styleLock.data.motion_grammar}`);
  lines.push('Positive, visual description only. No embedded text, subtitles, logos, or watermark.');
  return lines.join('\n');
}

// Motion prompt grammar (playbook 12.3): subject/camera/scene motion,
// temporal order, performance, end condition. Does not redescribe
// appearance when a first_frame reference drives the shot.
export function compileMotionPrompt(shot, locks) {
  const a = shot.action ?? {};
  const c = shot.camera ?? {};
  const lines = [];
  if (a.subject) lines.push(`SUBJECT MOTION: ${a.subject}`);
  if (c.movement) lines.push(`CAMERA MOTION: ${c.movement}${c.movement_intensity ? ` (${c.movement_intensity} intensity)` : ''}`);
  if (a.environment) lines.push(`SCENE MOTION: ${a.environment}`);
  if (Array.isArray(a.temporal_beats) && a.temporal_beats.length) {
    lines.push(`TEMPORAL ORDER: ${a.temporal_beats.join(' -> ')}`);
  }
  if (a.performance) lines.push(`PERFORMANCE: ${a.performance}`);
  const styleLock = (locks ?? []).find(l => l.entity_type === 'STYLE');
  if (styleLock?.data?.motion_grammar) lines.push(`STYLE OF MOTION: ${styleLock.data.motion_grammar}`);
  if (shot.acceptance?.required?.length) lines.push(`END CONDITION: ${shot.acceptance.required.join('; ')}`);
  return lines.join('\n');
}

function negativePromptFor(locks) {
  const forbidden = (locks ?? []).flatMap(l => l.data?.forbidden_drift ?? []);
  const base = ['identity mutation', 'duplicate subjects', 'extra limbs', 'fused hands',
    'unintended text', 'subtitles', 'logo', 'watermark', 'camera shake unless specified', 'morphing'];
  return [...base, ...forbidden].join(', ');
}

const LOCK_ENTITY_TYPES = ['STYLE', 'CHARACTER', 'ENVIRONMENT', 'PROP'];

// Turns the flat field set the studio_lock_drafter agent returns into the
// nested lock.data shape compileStillPrompt() actually reads (see its own
// field reads above: d.wardrobe_variants?.default, not a flat
// wardrobe_default -- the flat shape is just easier for the model to fill
// reliably). Drops null/empty fields entirely rather than writing them out
// as null, so a lock created from a thin description stays honestly thin
// instead of carrying a wall of nulls into stored data.
function reshapeLockDraft(fields) {
  const f = fields ?? {};
  const data = {};
  const direct = ['name', 'apparent_age', 'silhouette', 'face', 'hair', 'style_summary',
    'motion_grammar', 'architecture', 'palette', 'time', 'weather', 'material', 'color',
    'wear', 'scale_reference'];
  for (const key of direct) {
    if (f[key] != null && String(f[key]).trim() !== '') data[key] = f[key];
  }
  if (f.wardrobe_default != null && String(f.wardrobe_default).trim() !== '') {
    data.wardrobe_variants = { default: f.wardrobe_default };
  }
  if (Array.isArray(f.forbidden_drift) && f.forbidden_drift.length) {
    data.forbidden_drift = f.forbidden_drift;
  }
  return data;
}

// ===========================================================================
// Technical QC (playbook 19.1) via ffprobe. Real when the file is a real
// media file; when LCOS_ADAPTER_MODE is MOCK, generated assets are text
// placeholders (see adapters/index.mjs), so ffprobe would correctly fail
// on them for a reason that has nothing to do with the shot. Report that
// honestly as PASS_WITH_NOTES rather than either crashing or lying about
// having validated a real file.
// ===========================================================================
async function technicalQc(localPath, expected) {
  if (MOCK()) {
    return { disposition: 'PASS_WITH_NOTES', report: { skipped: true,
      reason: 'LCOS_ADAPTER_MODE is MOCK; the asset is a placeholder file, not real media, so ffprobe validation was skipped rather than run against it dishonestly.' } };
  }
  try {
    const { stdout } = await execFileP('ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', localPath]);
    const probe = JSON.parse(stdout);
    const vStream = probe.streams?.find(s => s.codec_type === 'video');
    const aStream = probe.streams?.find(s => s.codec_type === 'audio');
    const durationS = Number(probe.format?.duration ?? vStream?.duration ?? 0);
    const issues = [];
    if (!vStream && expected?.kind === 'VIDEO') issues.push('no video stream found');
    if (expected?.duration_target_s && vStream) {
      const tolerance = Math.max(1, expected.duration_target_s * 0.25);
      if (Math.abs(durationS - expected.duration_target_s) > tolerance) {
        issues.push(`duration ${durationS.toFixed(2)}s is outside tolerance of target ${expected.duration_target_s}s`);
      }
    }
    if (expected?.aspect_ratio && vStream?.width && vStream?.height) {
      const [w, h] = expected.aspect_ratio.split(':').map(Number);
      const targetRatio = w / h;
      const actualRatio = vStream.width / vStream.height;
      if (Math.abs(targetRatio - actualRatio) > 0.05) {
        issues.push(`aspect ratio ${vStream.width}x${vStream.height} does not match target ${expected.aspect_ratio}`);
      }
    }
    return { disposition: issues.length ? 'REWORK' : 'PASS',
      report: { duration_s: durationS, width: vStream?.width ?? null, height: vStream?.height ?? null,
        video_codec: vStream?.codec_name ?? null, audio_codec: aStream?.codec_name ?? null, issues } };
  } catch (e) {
    return { disposition: 'BLOCKED', report: { error: `ffprobe failed: ${e.message}` } };
  }
}

// Pull the LAST frame of a video asset as a still PNG (owner request, 21
// Aug 2026: "kling offers this thing where the last frame of a video
// becomes the first frame of the next video... can we implement that
// with runway"). Reproduces the trick provider-agnostically instead of
// depending on any one vendor's built-in continuation feature: extract
// the frame ourselves, then feed it back in through the exact same
// generation.first_frame_asset_id path compose-first-frame already uses,
// so /shots/:shotId/generate needs no changes to consume it. Input-seeks
// to just before the end (fast -- no full decode -- and frame-accurate
// enough that "the last frame" vs "0.08s before it" makes no visible
// difference for continuity purposes) rather than reading through the
// whole file. In MOCK mode the stored "video" is a placeholder text file
// written by the mock adapters, not real media -- ffmpeg would just fail
// against it -- so this writes an honest 1x1 placeholder PNG instead of
// pretending to extract anything, matching technicalQc/continuityQc's
// own MOCK discipline above.
async function extractLastFrame(videoLocalPath, outPath) {
  if (MOCK()) {
    const PLACEHOLDER_PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    await writeFile(outPath, PLACEHOLDER_PNG);
    return;
  }
  const { stdout } = await execFileP('ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoLocalPath]);
  const duration = Number(stdout.trim()) || 0;
  const seekTo = Math.max(0, duration - 0.08);
  await execFileP('ffmpeg', ['-y', '-ss', String(seekTo), '-i', videoLocalPath, '-frames:v', '1', '-q:v', '2', outPath]);
}

// Continuity QC (playbook 19.2) via Gemini vision comparison. Only runs
// when the shot has reference images to compare against; otherwise there
// is nothing to check continuity against and the report says so rather
// than guessing.
async function continuityQc(candidateLocalPath, referenceAssets, checklist) {
  if (!referenceAssets?.length) {
    return { disposition: 'PASS_WITH_NOTES', report: { skipped: true, reason: 'no reference images on this shot to compare against' } };
  }
  if (MOCK()) {
    return { disposition: 'PASS_WITH_NOTES', report: { skipped: true, reason: 'MOCK mode' } };
  }
  try {
    // For a video candidate, pull one representative frame; for a still,
    // read it directly.
    let candidateB64;
    if (candidateLocalPath.endsWith('.mp4')) {
      const framePath = `${candidateLocalPath}.qc-frame.png`;
      await execFileP('ffmpeg', ['-y', '-i', candidateLocalPath, '-vf', 'select=eq(n\\,0)', '-vframes', '1', framePath]);
      candidateB64 = (await readFile(framePath)).toString('base64');
    } else {
      candidateB64 = (await readFile(candidateLocalPath)).toString('base64');
    }
    const refB64s = await Promise.all(referenceAssets.map(async (a) =>
      (await readFile(storage.localPath(a.storage_key))).toString('base64')));
    const cmp = await gemini.compareContinuity({ candidateImageBase64: candidateB64,
      referenceImageBase64s: refB64s, checklist, assetId: crypto.randomUUID() });
    return { disposition: cmp.verdict === 'CONSISTENT' ? 'PASS' : 'REWORK',
      report: { verdict: cmp.verdict, confidence: cmp.confidence, notes: cmp.notes } };
  } catch (e) {
    return { disposition: 'BLOCKED', report: { error: `continuity check failed: ${e.message}` } };
  }
}

function worseDisposition(a, b) {
  const rank = { PASS: 0, PASS_WITH_NOTES: 1, REWORK: 2, BLOCKED: 3 };
  return rank[b] > rank[a] ? b : a;
}

// ===========================================================================
// Budget guardrail (playbook section 21), shared by every paid-generation
// route below (shot video generate, lock reference image, shot voice,
// project music) so the warn-at-60/80%, block-at-90% logic and the
// override path live in exactly one place instead of four near-copies.
// ===========================================================================
class BudgetExceededError extends Error {}

// Call BEFORE the paid adapter call, with the estimated cost of THIS call
// (from ESTIMATED_COST_USD). Returns { warning }, where warning is null
// below 60% of budget_cap_usd or {threshold, spent_usd, budget_cap_usd,
// estimated_cost_usd} at the 60/80/90% bands. Throws BudgetExceededError
// when this call would bring spend to at/above 90% of budget_cap_usd and
// the actor did not both request AND hold permission for an override —
// spending past the guardrail is an approver decision (studio.approve),
// not something studio.generate alone authorizes. A project with no
// budget_cap_usd set (null) always returns { warning: null } here: null
// means no cap, never block, never warn, per the column's own contract.
// Does NOT touch spent_usd itself — the caller records that only once the
// paid call has actually succeeded (spendBudget below), so a refusal, a
// thrown error, or an adapter failure never gets charged.
async function checkAndSpendBudget(project, estimatedCost, actor, overrideRequested) {
  if (project.budget_cap_usd == null) return { warning: null };
  const cap = Number(project.budget_cap_usd);
  const spent = Number(project.spent_usd);
  const projected = spent + estimatedCost;
  const ratio = cap > 0 ? projected / cap : Infinity;
  const overridden = overrideRequested === true && (actor?.permissions ?? []).includes('studio.approve');
  if (ratio >= 0.9 && !overridden) {
    throw new BudgetExceededError(
      `this call is estimated at $${estimatedCost.toFixed(2)}, which would bring project spend to ` +
      `$${projected.toFixed(2)} of its $${cap.toFixed(2)} budget cap ($${spent.toFixed(2)} already spent) — ` +
      `at or above the 90% guardrail. Pass override_budget:true from an actor with studio.approve to proceed anyway.`);
  }
  if (ratio >= 0.9) {
    await q(`INSERT INTO studio.events (project_id, actor_id, note) VALUES ($1,$2,$3)`,
      [project.id, actor?.id ?? null,
       `budget guardrail overridden by ${actor?.label ?? actor?.id ?? 'unknown actor'} at $${projected.toFixed(2)} of $${cap.toFixed(2)} cap`]);
    return { warning: { threshold: 90, spent_usd: spent, budget_cap_usd: cap, estimated_cost_usd: estimatedCost } };
  }
  if (ratio >= 0.8) return { warning: { threshold: 80, spent_usd: spent, budget_cap_usd: cap, estimated_cost_usd: estimatedCost } };
  if (ratio >= 0.6) return { warning: { threshold: 60, spent_usd: spent, budget_cap_usd: cap, estimated_cost_usd: estimatedCost } };
  return { warning: null };
}

// The amount to actually record against spent_usd once a paid call has
// succeeded: the adapter's own cost_usd when it reports a real positive
// number, else the estimate that was already checked against the
// guardrail above. Every adapter currently returns cost_usd: 0 in MOCK
// mode (see adapters/index.mjs header), so today this always falls back
// to the estimate — an honest fallback, not a silent no-op, and it starts
// tracking real spend automatically the day an adapter reports a real cost.
function resolveSpendAmount(gen, estimatedCost) {
  return (typeof gen?.cost_usd === 'number' && gen.cost_usd > 0) ? gen.cost_usd : estimatedCost;
}

async function spendBudget(projectId, amount) {
  if (!amount) return;
  await q(`UPDATE studio.projects SET spent_usd = spent_usd + $2 WHERE id=$1`, [projectId, amount]);
}

// ===========================================================================
// Retry / repair / fallback ladder (playbook section 15), phase 1, scoped
// ONLY to the one call site that needed it tonight: POST
// /shots/:shotId/generate's single engine.textToVideo/imageToVideo call.
// Every other paid route in this file still makes one direct call and
// surfaces the raw failure -- extending the ladder to those is future work,
// not silently implied by this section existing.
//
// Adapters (adapters/index.mjs) throw plain Error objects with no
// structured error code today, so classification below keys on the
// message text. That matching is deliberately liberal and documented
// inline so a future reader knows exactly what strings decide each class
// rather than having to reverse-engineer it:
//   POLICY         a content-policy/moderation rejection. Checked FIRST,
//                   ahead of the other patterns, because a real vendor
//                   message could plausibly contain both a policy word and
//                   something that looks like a status code (e.g. "429:
//                   content blocked by safety filter"), and POLICY must
//                   win that ambiguity -- it is a hard gate (15.3): never
//                   retried and never rerouted to the other engine, since
//                   silently rerouting around a safety rejection is
//                   exactly the kind of constraint-relaxation the playbook
//                   forbids.
//   PROVIDER_DOWN  checked SECOND: explicit "this whole provider looks
//                   broken" wording ('unavailable', standalone 'down').
//                   Checked ahead of the 5xx pattern below on purpose, so
//                   a message like "503 Service Unavailable" reads as
//                   PROVIDER_DOWN (skip the same-engine retry, it is
//                   unlikely to help) rather than TRANSIENT.
//   TRANSIENT      checked THIRD: everything that looks recoverable by
//                   simply trying again and wasn't already claimed above
//                   -- a timeout, ECONNRESET, an explicit rate-limit
//                   mention, a bare 429, or a generic 5xx-shaped number.
//   PROVIDER_DOWN  the catch-all: anything left over falls here too, on
//                   the theory that an unrecognized failure from a video
//                   provider is more likely "something is wrong with the
//                   provider" than "this exact request was uniquely bad."
// ===========================================================================
function classifyGenerationError(message) {
  const m = String(message ?? '').toLowerCase();
  if (/polic|moderat|safety|blocked content/.test(m)) return 'POLICY';
  if (/unavailable|\bdown\b/.test(m)) return 'PROVIDER_DOWN';
  if (/timeout|econnreset|rate limit|429|5\d\d/.test(m)) return 'TRANSIENT';
  return 'PROVIDER_DOWN';
}

function callVideoEngine(engineObj, mode, callArgs) {
  return mode === 'image_to_video' ? engineObj.imageToVideo(callArgs) : engineObj.textToVideo(callArgs);
}

// One real provider call. Logged to studio.events unconditionally --
// success or failure -- so a human reading the project's event timeline
// sees every attempt the ladder made, not just whichever one ended it.
async function attemptGenerationOnce({ project, actorId, engineObj, engineLabel, mode, callArgs, attemptNumber }) {
  try {
    const gen = await callVideoEngine(engineObj, mode, callArgs);
    await q(`INSERT INTO studio.events (project_id, actor_id, note) VALUES ($1,$2,$3)`,
      [project.id, actorId, `generate attempt ${attemptNumber} on ${engineLabel}: SUCCEEDED`]);
    return { ok: true, gen };
  } catch (e) {
    const errorClass = classifyGenerationError(e.message);
    await q(`INSERT INTO studio.events (project_id, actor_id, note) VALUES ($1,$2,$3)`,
      [project.id, actorId, `generate attempt ${attemptNumber} on ${engineLabel}: FAILED (${errorClass}) ${e.message}`]);
    return { ok: false, errorClass, message: e.message };
  }
}

// The ladder. Hard cap of 3 real provider calls total for one /generate
// request (2 same-engine + 1 fallback-engine), matching the playbook's
// default per-shot retry budget -- this never loops past that no matter
// what keeps failing.
//   TRANSIENT      -> one retry on the SAME engine/model with the SAME
//                     prompt, after a short real backoff (~50ms, well
//                     under this phase's 200ms latency budget), then
//                     falls back to the other engine if still failing.
//   POLICY         -> stops immediately wherever it occurs (attempt 1 or
//                     the same-engine retry). No retry, no fallback.
//   PROVIDER_DOWN  -> skips the same-engine retry and goes straight to
//                     the ONE fallback attempt on the other engine. This
//                     is a documented phase-1 choice (task explicitly
//                     left it open): a "provider down" reading is
//                     presumed to describe the whole engine being
//                     unhealthy right now rather than this one request,
//                     so retrying the same engine again is judged
//                     unlikely to help -- go straight to the other one.
// A TRANSIENT failure still failing after its one same-engine retry falls
// through to that same single fallback attempt, so the worst case is
// exactly 3 attempts: same engine, same engine again, then the fallback.
async function runGenerationLadder({ project, actorId, engine, engineName, mode, callArgs }) {
  const failedAttempts = [];
  let n = 0;

  n += 1;
  let r = await attemptGenerationOnce({ project, actorId, engineObj: engine, engineLabel: engineName, mode, callArgs, attemptNumber: n });
  if (r.ok) return { success: true, gen: r.gen, engineLabel: engineName, attemptCount: n, fallbackUsed: false };
  failedAttempts.push({ engine: engineName, attempt_number: n, error_class: r.errorClass, message: r.message });
  if (r.errorClass === 'POLICY') return { success: false, attempts: failedAttempts };

  if (r.errorClass === 'TRANSIENT') {
    await new Promise((resolve) => setTimeout(resolve, 50));
    n += 1;
    r = await attemptGenerationOnce({ project, actorId, engineObj: engine, engineLabel: engineName, mode, callArgs, attemptNumber: n });
    if (r.ok) return { success: true, gen: r.gen, engineLabel: engineName, attemptCount: n, fallbackUsed: false };
    failedAttempts.push({ engine: engineName, attempt_number: n, error_class: r.errorClass, message: r.message });
    if (r.errorClass === 'POLICY') return { success: false, attempts: failedAttempts };
  }

  const fallbackEngineName = engineName === 'VEO' ? 'KLING' : 'VEO';
  const fallbackEngine = videoEngine(fallbackEngineName);
  n += 1;
  r = await attemptGenerationOnce({ project, actorId, engineObj: fallbackEngine, engineLabel: fallbackEngineName, mode, callArgs, attemptNumber: n });
  if (r.ok) return { success: true, gen: r.gen, engineLabel: fallbackEngineName, attemptCount: n, fallbackUsed: true };
  failedAttempts.push({ engine: fallbackEngineName, attempt_number: n, error_class: r.errorClass, message: r.message });
  return { success: false, attempts: failedAttempts };
}

// ===========================================================================
// Crossfade transitions + project-music mixing for assemble() (playbook
// 18.1/16.2, phase-1-scoped -- 18 Aug 2026, third follow-up). Deliberately
// NOT a general timeline/EDL: this covers exactly two things, a crossfade
// blend between adjacent accepted shots and one optional music layer, and
// nothing else (no retiming, no per-shot audio alignment, no SFX mix).
// ===========================================================================

// ffprobe reports frame rate as a rational string ("30000/1001", "30/1"),
// not a float; parse it honestly instead of Number()'ing it (which would
// silently yield NaN).
function evalFrameRate(rateStr) {
  const [n, d] = String(rateStr ?? '').split('/').map(Number);
  return d ? n / d : (Number.isFinite(n) ? n : null);
}

// Real-ffprobe-only: reads width/height/fps/duration/hasAudio off one local
// media file. Used both for the crossfade compatibility guard and for
// sizing the music mix to the assembled video's actual runtime. There is no
// MOCK-mode equivalent -- MOCK has no real media to probe (see the assemble
// route's MOCK branch below), so this is only ever called on the real path.
async function probeClip(localPath) {
  const { stdout } = await execFileP('ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', localPath]);
  const probe = JSON.parse(stdout);
  const vStream = probe.streams?.find(s => s.codec_type === 'video');
  const aStream = probe.streams?.find(s => s.codec_type === 'audio');
  return {
    width: vStream?.width ?? null,
    height: vStream?.height ?? null,
    fps: vStream?.r_frame_rate ? evalFrameRate(vStream.r_frame_rate) : null,
    durationS: Number(probe.format?.duration ?? vStream?.duration ?? 0),
    hasAudio: !!aStream,
  };
}

// Pure and independently testable (see test/studio_assembly.test.mjs) on
// purpose: this is the one piece of the crossfade guard that does NOT need
// a real ffprobe call to unit test, so it is factored out rather than left
// inline in the route. Takes two {width,height,fps}-shaped probe results
// (or any object with that shape) plus the shot codes they came from, and
// returns a string naming EXACTLY what differs, or null when the pair is
// close enough to crossfade cleanly -- same "never silently degrade, name
// the exact problem" principle the missing-accepted-asset guard above
// already applies to assembly. fps is compared with a small tolerance
// because 29.97 vs 30 reads as "the same" to a human editor even though
// the floats never match exactly.
export function describeClipMismatch(a, b, aCode, bCode) {
  const diffs = [];
  if (a.width !== b.width || a.height !== b.height) {
    diffs.push(`${aCode} is ${a.width}x${a.height} but ${bCode} is ${b.width}x${b.height}`);
  }
  if (a.fps != null && b.fps != null && Math.abs(a.fps - b.fps) > 0.05) {
    diffs.push(`${aCode} is ${a.fps.toFixed(2)}fps but ${bCode} is ${b.fps.toFixed(2)}fps`);
  }
  return diffs.length ? diffs.join('; ') : null;
}

// Builds the filter_complex fragment that chains ffmpeg's `xfade` video
// filter across N inputs. xfade takes two video streams and an `offset` --
// the timestamp IN THE FIRST STREAM at which the blend begins -- and
// produces one shorter stream (shorter by transitionDurationS, since the
// blend region is shared between the two clips, not inserted between them).
// Chaining more than one xfade therefore means each subsequent offset has
// to be computed against the RUNNING (already-shortened) duration of the
// chain so far, not the naive sum of raw clip durations -- get that wrong
// and every blend past the first pair drifts out of sync with the source
// clips. This is why runningDuration is threaded through the loop instead
// of precomputing offsets from `durations` directly.
function buildCrossfadeVideoGraph(durations, transitionDurationS) {
  const filters = [];
  let runningDuration = durations[0];
  let prevLabel = '[0:v]';
  for (let i = 1; i < durations.length; i++) {
    const offset = runningDuration - transitionDurationS;
    const outLabel = i === durations.length - 1 ? '[vout]' : `[v${i}]`;
    filters.push(`${prevLabel}[${i}:v]xfade=transition=fade:duration=${transitionDurationS}:offset=${offset.toFixed(3)}${outLabel}`);
    runningDuration = runningDuration + durations[i] - transitionDurationS;
    prevLabel = outLabel;
  }
  return { filterComplex: filters.join(';'), outputLabel: '[vout]', totalDurationS: runningDuration };
}

// The audio equivalent, using `acrossfade` instead of `xfade`. Unlike
// xfade, acrossfade needs no offset argument -- it always blends the tail
// of the running chain into the head of the next input over `d` seconds --
// so this is simpler than the video graph above. Only called when every
// accepted clip in the project actually has an audio stream (checked by the
// caller); most Kling/Veo b-roll has none, in which case shot audio is
// simply left out of the mix rather than guessing at a fake audio track.
function buildCrossfadeAudioGraph(clipCount, transitionDurationS) {
  const filters = [];
  let prevLabel = '[0:a]';
  for (let i = 1; i < clipCount; i++) {
    const outLabel = i === clipCount - 1 ? '[aout]' : `[a${i}]`;
    filters.push(`${prevLabel}[${i}:a]acrossfade=d=${transitionDurationS}${outLabel}`);
    prevLabel = outLabel;
  }
  return { filterComplex: filters.join(';'), outputLabel: '[aout]' };
}

// Lays the project's music bed under an already-assembled video file (a
// second ffmpeg pass, deliberately separate from whatever produced
// videoPath, so the no-music 'cut' invocation elsewhere in this file stays
// byte-for-byte identical to what it was before this feature existed).
// Loops the music (via -stream_loop -1 on the input) and trims it to the
// assembled video's OWN measured duration via ffprobe, rather than trusting
// the sum of shot duration_target_s, since a hard-cut concat's real runtime
// can drift slightly from the sum of targets.
//
// Ducking: this function only knows a VOICE asset EXISTS somewhere in the
// project (hasVoice, resolved by the caller from studio.assets), not WHEN
// in the timeline it plays -- knowing that would require the same
// shot-by-shot audio timeline the file header says is out of scope for this
// phase. So instead of a real sidechaincompress keyed against a
// time-aligned dialogue track, this applies a flatter, more-attenuated
// music volume for the WHOLE track whenever any dialogue exists anywhere in
// the project (0.07, roughly -23dB) versus a normal bed level when it
// doesn't (0.126, roughly -18dB per the task's own reference point). Less
// precise than a true dynamic duck tied to when dialogue actually speaks,
// but honest about what this function actually knows, and it never risks
// drowning out dialogue that exists somewhere in a timeline it cannot see.
async function mixMusicOntoVideo({ workDir, videoPath, musicAsset, hasVoice }) {
  const videoInfo = await probeClip(videoPath);
  const musicVolume = hasVoice ? 0.07 : 0.126;
  const musicLocalPath = storage.localPath(musicAsset.storage_key);
  const outPath = join(workDir, 'assembled-with-music.mp4');
  const filter = videoInfo.hasAudio
    ? `[1:a]volume=${musicVolume},atrim=0:${videoInfo.durationS.toFixed(3)},asetpts=PTS-STARTPTS[music];` +
      `[0:a][music]amix=inputs=2:duration=first:dropout_transition=0[aout]`
    : `[1:a]volume=${musicVolume},atrim=0:${videoInfo.durationS.toFixed(3)},asetpts=PTS-STARTPTS[aout]`;
  await execFileP('ffmpeg', ['-y', '-i', videoPath, '-stream_loop', '-1', '-i', musicLocalPath,
    '-filter_complex', filter, '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', outPath]);
  return outPath;
}

export default async function routes(app) {
  // -------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------
  app.get('/studio/projects', { preHandler: requirePerm('studio.read') }, async (req) => {
    const includeArchived = ['1', 'true'].includes(String(req.query?.include_archived ?? ''));
    const r = await q(
      `SELECT * FROM studio.projects ${includeArchived ? '' : 'WHERE archived_at IS NULL'} ORDER BY created_at DESC`);
    return { items: r.rows };
  });

  app.post('/studio/projects', { preHandler: requirePerm('studio.write') }, async (req, reply) => {
    const b = req.body ?? {};
    if (!b.title) return reply.code(422).send(err(422, 'VALIDATION', 'title is required'));
    const p = await one(
      `INSERT INTO studio.projects (code, title, format, autonomy_level, brief, aspect_ratio, fps, language,
         budget_cap_usd, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [code('STU'), b.title, b.format ?? 'ai_story', b.autonomy_level ?? 'A1',
       JSON.stringify(b.brief ?? {}), b.aspect_ratio ?? '9:16', b.fps ?? 30, b.language ?? 'am',
       b.budget_cap_usd ?? null, req.actor?.id ?? null]);
    await q(`INSERT INTO studio.events (project_id, to_state, actor_id, note) VALUES ($1,$2,$3,$4)`,
      [p.id, p.state, req.actor?.id ?? null, 'project created']);
    await audit(null, { actor: req.actor, action: 'studio.project.create', objectType: 'STUDIO_PROJECT',
      objectId: p.id, objectCode: p.code });
    return p;
  });

  app.get('/studio/projects/:id', { preHandler: requirePerm('studio.read') }, async (req, reply) => {
    const p = await one(`SELECT * FROM studio.projects WHERE id=$1`, [req.params.id]);
    if (!p) return reply.code(404).send(err(404, 'NOT_FOUND', 'project not found'));
    const locks = (await q(`SELECT * FROM studio.locks WHERE project_id=$1 AND is_active ORDER BY entity_type, entity_code`,
      [p.id])).rows;
    await attachReferenceAssets(locks);
    const shots = (await q(`SELECT * FROM studio.shots WHERE project_id=$1 ORDER BY order_index`, [p.id])).rows;
    const events = (await q(`SELECT * FROM studio.events WHERE project_id=$1 ORDER BY at DESC LIMIT 50`, [p.id])).rows;
    return { ...p, locks, shots, events };
  });

  // Manual state transition. Phase 1 does not gate this against
  // prerequisites the way the playbook's full state machine would
  // (section 4); it records the transition honestly and leaves gate
  // enforcement to a later phase.
  app.post('/studio/projects/:id/state', { preHandler: requirePerm('studio.approve') }, async (req, reply) => {
    const p = await one(`SELECT * FROM studio.projects WHERE id=$1`, [req.params.id]);
    if (!p) return reply.code(404).send(err(404, 'NOT_FOUND', 'project not found'));
    const to = req.body?.state;
    const valid = ['REQUEST','INTAKE_VALIDATED','TREATMENT_APPROVED','SCRIPT_APPROVED','LOCKS_APPROVED',
      'SHOT_MANIFEST_FROZEN','ANIMATIC_APPROVED','GENERATION_COMPLETE','ROUGH_CUT_VALIDATED',
      'AUDIO_LOCKED','PICTURE_LOCKED','MASTER_QC_PASSED','DELIVERED'];
    if (!valid.includes(to)) return reply.code(422).send(err(422, 'VALIDATION', `state must be one of ${valid.join(', ')}`));
    await q(`UPDATE studio.projects SET state=$2, updated_at=now() WHERE id=$1`, [p.id, to]);
    await q(`INSERT INTO studio.events (project_id, from_state, to_state, actor_id, note) VALUES ($1,$2,$3,$4,$5)`,
      [p.id, p.state, to, req.actor?.id ?? null, req.body?.note ?? null]);
    return { id: p.id, from_state: p.state, to_state: to };
  });

  // Archive / unarchive (19 Aug 2026). Reversible: hides the project from
  // the default list without touching its locks/shots/assets/events. Gated
  // on studio.approve, same tier as /state and /assemble, since removing a
  // whole project from view is a project-level decision, not a working edit.
  app.post('/studio/projects/:id/archive', { preHandler: requirePerm('studio.approve') }, async (req, reply) => {
    const p = await one(`SELECT * FROM studio.projects WHERE id=$1`, [req.params.id]);
    if (!p) return reply.code(404).send(err(404, 'NOT_FOUND', 'project not found'));
    if (p.archived_at) return { id: p.id, archived_at: p.archived_at };
    const updated = await one(
      `UPDATE studio.projects SET archived_at=now(), updated_at=now() WHERE id=$1 RETURNING archived_at`, [p.id]);
    await q(`INSERT INTO studio.events (project_id, from_state, to_state, actor_id, note) VALUES ($1,$2,$2,$3,$4)`,
      [p.id, p.state, req.actor?.id ?? null, req.body?.note ?? 'project archived']);
    await audit(null, { actor: req.actor, action: 'studio.project.archive', objectType: 'STUDIO_PROJECT',
      objectId: p.id, objectCode: p.code });
    return { id: p.id, archived_at: updated.archived_at };
  });

  app.post('/studio/projects/:id/unarchive', { preHandler: requirePerm('studio.approve') }, async (req, reply) => {
    const p = await one(`SELECT * FROM studio.projects WHERE id=$1`, [req.params.id]);
    if (!p) return reply.code(404).send(err(404, 'NOT_FOUND', 'project not found'));
    if (!p.archived_at) return { id: p.id, archived_at: null };
    await q(`UPDATE studio.projects SET archived_at=NULL, updated_at=now() WHERE id=$1`, [p.id]);
    await q(`INSERT INTO studio.events (project_id, from_state, to_state, actor_id, note) VALUES ($1,$2,$2,$3,$4)`,
      [p.id, p.state, req.actor?.id ?? null, 'project unarchived']);
    await audit(null, { actor: req.actor, action: 'studio.project.unarchive', objectType: 'STUDIO_PROJECT',
      objectId: p.id, objectCode: p.code });
    return { id: p.id, archived_at: null };
  });

  // -------------------------------------------------------------------
  // Brief import (19 Aug 2026): the real gap "Spotting on the Pill" (a
  // 25s Send-It format brief) exposed -- Nate had to retype an entire
  // structured brief by hand into a lock, one shot, and several overlays,
  // one field at a time. POST /import-brief turns a free-text brief into
  // a structured DRAFT via the studio_brief_importer agent (gateway.mjs);
  // exactly like /studio/locks/draft above, this SAVES NOTHING -- the
  // human reviews the draft, then either edits it and calls .../apply, or
  // makes their own manual create-shot/create-overlay calls same as
  // before this endpoint existed.
  //
  // THE ONE-SHOT RULE: a Send-It brief like this is ONE continuous
  // presenter take -- a single person talking to camera for the whole
  // runtime -- with several SCRIPT/OVERLAY timing beats (a hook, a share
  // moment, a caveat, a door card, and so on) layered on top of that one
  // take, not six separate camera setups. The draft always contains
  // exactly one presenter_shot, however many timed beats the brief
  // names; see the studio_brief_importer prompt (0036 migration) for the
  // same rule spelled out for a real model.
  // -------------------------------------------------------------------
  app.post('/studio/projects/:id/import-brief', { preHandler: requirePerm('studio.write') }, async (req, reply) => {
    const p = await one(`SELECT * FROM studio.projects WHERE id=$1`, [req.params.id]);
    if (!p) return reply.code(404).send(err(404, 'NOT_FOUND', 'project not found'));
    const freeText = req.body?.free_text;
    if (!freeText || !String(freeText).trim()) {
      return reply.code(422).send(err(422, 'VALIDATION', 'free_text is required'));
    }
    const out = await invokeAgent('studio_brief_importer',
      { free_text: freeText, project_aspect_ratio: p.aspect_ratio, project_language: p.language },
      { objectType: 'STUDIO_BRIEF_IMPORT', objectId: p.id, workflowCode: 'studio' });
    return out;
  });

  // Applies a (possibly human-edited) draft from the endpoint above: this
  // is the one place in the whole Video Studio vertical where reviewed,
  // structured data becomes real rows in a single call -- a human still
  // had to look at and submit the draft object (nothing here is
  // triggered automatically off the free-text call above), this just
  // collapses the mechanical "now type each field back into five
  // separate forms" step the brief's format made painfully obvious.
  // Creates the one presenter shot, creates every overlay that has
  // valid, complete data, and updates whichever project fields are still
  // unset (title/format/aspect_ratio/language are all NOT NULL with a
  // factory default on this table today, so in practice this only ever
  // fires for a future nullable project field -- documented rather than
  // silently dead code, so a later migration that adds one gets this for
  // free without another engineer having to rediscover the pattern).
  // Overlays this cannot safely create -- an ICON with no asset_id
  // (drafted that way on purpose, see studio_brief_importer's own rule:
  // it never invents an asset id), or any row that fails
  // validateOverlayData, or one whose entity_code lock does not
  // resolve -- are SKIPPED and reported by kind/timing/reason, never
  // silently dropped and never allowed to create a broken row that
  // points at nothing.
  app.post('/studio/projects/:id/import-brief/apply', { preHandler: requirePerm('studio.write') }, async (req, reply) => {
    const p = await one(`SELECT * FROM studio.projects WHERE id=$1`, [req.params.id]);
    if (!p) return reply.code(404).send(err(404, 'NOT_FOUND', 'project not found'));
    const draft = req.body ?? {};
    if (!draft.presenter_shot || typeof draft.presenter_shot !== 'object') {
      return reply.code(422).send(err(422, 'VALIDATION', 'draft.presenter_shot is required'));
    }

    const projField = { title: 'title', format: 'format', aspect_ratio: 'aspect_ratio', language: 'language' };
    const projectUpdates = {};
    for (const [draftKey, col] of Object.entries(projField)) {
      const val = draft.project?.[draftKey];
      if (val != null && String(val).trim() !== '' && p[col] == null) projectUpdates[col] = val;
    }
    if (Object.keys(projectUpdates).length) {
      const sets = Object.keys(projectUpdates).map((c, i) => `${c}=$${i + 2}`);
      await q(`UPDATE studio.projects SET ${sets.join(', ')}, updated_at=now() WHERE id=$1`,
        [p.id, ...Object.values(projectUpdates)]);
    }

    // The one presenter shot. Mirrors POST /studio/projects/:id/shots'
    // own field reads exactly (story/continuity/camera/action/audio/
    // generation), so a shot created here behaves identically to one a
    // human typed into that form by hand.
    const ps = draft.presenter_shot;
    const shotCode = (ps.shot_code && String(ps.shot_code).trim()) || code('SH');
    const continuity = ps.continuity ?? {};
    const entityCodes = [...(continuity.characters ?? []), continuity.environment, ...(continuity.props ?? [])].filter(Boolean);
    const lockRows = entityCodes.length
      ? (await q(`SELECT id FROM studio.locks WHERE project_id=$1 AND entity_code = ANY($2) AND is_active`,
          [p.id, entityCodes])).rows
      : [];
    const existingCount = (await one(`SELECT count(*)::int AS n FROM studio.shots WHERE project_id=$1`, [p.id])).n;
    const shot = await one(
      `INSERT INTO studio.shots (project_id, shot_code, order_index, duration_target_s, story, continuity,
         camera, action, audio, graphics, generation, acceptance, locked_lock_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [p.id, shotCode, existingCount, ps.duration_target_s ?? 25,
       JSON.stringify(ps.story ?? {}), JSON.stringify(continuity), JSON.stringify(ps.camera ?? {}),
       JSON.stringify(ps.action ?? {}), JSON.stringify(ps.audio ?? {}), JSON.stringify({}),
       JSON.stringify(ps.generation ?? {}), JSON.stringify({}), lockRows.map(l => l.id)]);
    await q(`INSERT INTO studio.events (project_id, actor_id, artifact, note) VALUES ($1,$2,$3,$4)`,
      [p.id, req.actor?.id ?? null, `shots/${shot.shot_code}`, `created presenter shot ${shot.shot_code} from an imported brief`]);

    // Overlays: skip -- never crash, never guess -- anything that cannot
    // validate as a real, complete overlay row. Runs the exact same
    // validateOverlayData/describeOverlayCollision/asset-kind checks
    // POST /studio/projects/:id/overlays itself uses, so an overlay that
    // gets created here is held to the identical bar as one a human
    // typed in by hand.
    const createdOverlays = [];
    const skippedOverlays = [];
    const collisionPool = (await q(`SELECT id, kind, start_s, end_s, data FROM studio.overlays WHERE project_id=$1`, [p.id])).rows;
    for (const ov of (draft.overlays ?? [])) {
      const reasons = [];
      if (!OVERLAY_KINDS.includes(ov?.kind)) reasons.push(`kind must be one of ${OVERLAY_KINDS.join(', ')}`);
      if (typeof ov?.start_s !== 'number' || typeof ov?.end_s !== 'number' || !(ov.end_s > ov.start_s)) {
        reasons.push('start_s and end_s are required numbers, and end_s must be greater than start_s');
      }
      if (!reasons.length) reasons.push(...validateOverlayData(ov.kind, ov.data));
      if (!reasons.length && ov.kind === 'ICON') {
        const iconAsset = ov.data?.asset_id ? await one(`SELECT id, kind FROM lcos.assets WHERE id=$1`, [ov.data.asset_id]) : null;
        if (!iconAsset) reasons.push(`data.asset_id ${ov.data?.asset_id ?? '(none)'} does not resolve to an existing asset -- upload the icon image to the asset library first, then set asset_id and create this overlay directly`);
        else if (iconAsset.kind !== 'ICON') reasons.push(`data.asset_id ${ov.data.asset_id} resolves to a ${iconAsset.kind} asset, not ICON`);
      }
      if (!reasons.length) {
        const collision = describeOverlayCollision([...collisionPool, ...createdOverlays], ov.kind, ov.data, ov.start_s, ov.end_s);
        if (collision) reasons.push(collision);
      }
      if (reasons.length) {
        skippedOverlays.push({ kind: ov?.kind ?? null, start_s: ov?.start_s ?? null, end_s: ov?.end_s ?? null,
          reason: reasons.join('; ') });
        continue;
      }
      const saved = await one(
        `INSERT INTO studio.overlays (project_id, kind, start_s, end_s, order_index, data, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [p.id, ov.kind, ov.start_s, ov.end_s, ov.order_index ?? 0, JSON.stringify(ov.data ?? {}), req.actor?.id ?? null]);
      createdOverlays.push(saved);
    }
    await q(`INSERT INTO studio.events (project_id, actor_id, artifact, note) VALUES ($1,$2,$3,$4)`,
      [p.id, req.actor?.id ?? null, `shots/${shot.shot_code}`,
       `applied brief import: ${createdOverlays.length} overlay(s) created` +
       (skippedOverlays.length ? `, ${skippedOverlays.length} overlay(s) skipped (see response)` : '')]);

    // caption_draft is passed straight through, never saved: nothing in
    // Video Studio currently stores caption/publishing text (see
    // studio_brief_importer's own prompt on why) -- it is the one part
    // of this draft a human still has to place manually, same as before
    // this endpoint existed.
    return { project_updates: projectUpdates, shot, overlays_created: createdOverlays,
      overlays_skipped: skippedOverlays, caption_draft: draft.caption_draft ?? null };
  });

  // -------------------------------------------------------------------
  // Script import (19 Aug 2026): the sibling of the brief-import feature
  // just above, for the OTHER on-ramp into Video Studio. createProductionJob
  // (production.mjs) already refuses any APPROVED script whose format is
  // VIDEO-kind with a 422 pointing here ("Approve this script, then start a
  // Video Studio project from it instead") -- HeyGen and Creatomate were
  // retired 19 Aug 2026, and that pipeline never rendered anything but
  // VIDEO-kind pieces through them, so a VIDEO-kind script now has nowhere
  // else to go. These two routes are what that message points at.
  //
  // Same draft/apply split as import-brief, same discipline: POST
  // .../draft calls the studio_script_importer agent (gateway.mjs) and
  // SAVES NOTHING; a human reviews the draft (editing project fields,
  // shots, overlays, and choosing which continuity entities to reuse from
  // an existing approved lock vs. draft fresh), then POST .../apply turns
  // that reviewed draft into the real project/shots/locks/overlays.
  //
  // THE DIFFERENCE FROM import-brief, load-bearing: a Send-It brief is
  // always one continuous presenter take. A general approved script's
  // scene_plan can describe ONE continuous take or SEVERAL genuinely
  // distinct shots/scenes -- the agent decides based on what scene_plan
  // actually contains (see gateway.mjs's S.studio_script_importer comment
  // and the 0037 migration's prompt for the full rule). This module does
  // not force either shape; draft.shots is simply however many shots the
  // agent (or the human, after editing the draft) decided the script needs.
  app.post('/studio/projects/from-script/draft', { preHandler: requirePerm('studio.write') }, async (req, reply) => {
    const scriptId = req.body?.script_id;
    if (!scriptId) return reply.code(422).send(err(422, 'VALIDATION', 'script_id is required'));
    const script = await one(`SELECT * FROM lcos.scripts WHERE id=$1`, [scriptId]);
    if (!script) return reply.code(404).send(err(404, 'NOT_FOUND', 'script not found'));
    if (script.status !== 'APPROVED') {
      return reply.code(422).send(err(422, 'GUARD_FAILED',
        'Only an APPROVED script can start a Video Studio project.', { guard: 'scriptApproved' }));
    }

    // Resolve body_kind exactly the way createProductionJob (production.mjs)
    // does: the format registry's own body_kind first, falling back to the
    // legacy video_family mapping for a concept with no format_code. A
    // script that is not VIDEO-kind has no business here -- it either
    // already produces fine through the regular pipeline, or (a non-VIDEO
    // format) was never blocked from it in the first place.
    const concept = await one(`SELECT * FROM lcos.content_concepts WHERE id=$1`, [script.concept_id]);
    const fmtRow = concept?.format_code
      ? await one(`SELECT body_kind FROM lcos.content_formats WHERE code=$1`, [concept.format_code]) : null;
    const bodyKind = fmtRow?.body_kind ?? formatOf(concept?.video_family);
    if (bodyKind !== 'VIDEO') {
      return reply.code(422).send(err(422, 'GUARD_FAILED',
        `This script is a ${bodyKind} piece, not video -- produce it through the regular production pipeline instead of Video Studio.`,
        { guard: 'scriptIsVideoKind' }));
    }

    // Idempotent re-entry: a script that already has a linked project (see
    // studio.projects.source_script_id, 0037 migration) returns that
    // project instead of drafting again, so double-clicking "Start Video
    // Studio project" or reloading mid-review can never spawn a second
    // project for the same script. POST .../apply enforces the same rule
    // server-side, so this is a convenience short-circuit, not the only
    // guard against a duplicate.
    const existing = await one(`SELECT * FROM studio.projects WHERE source_script_id=$1`, [script.id]);
    if (existing) return { existing_project: existing };

    const version = await one(
      `SELECT * FROM lcos.script_versions WHERE script_id=$1 AND version=$2`,
      [script.id, script.approved_version ?? script.current_version]);
    if (!version) return reply.code(404).send(err(404, 'NOT_FOUND', 'the script has no approved version to import'));

    const out = await invokeAgent('studio_script_importer', {
      hook: version.hook, spoken_script: version.spoken_script, onscreen_text: version.onscreen_text,
      scene_plan: version.scene_plan, cta: version.cta, caption: version.caption,
      estimated_duration_s: version.estimated_duration_s, language: script.language,
      format_code: concept?.format_code ?? null, concept_title: concept?.title ?? null,
      concept_characters: concept?.characters ?? [],
    }, { objectType: 'STUDIO_SCRIPT_IMPORT', objectId: script.id, workflowCode: 'studio' });

    // Reuse candidates: for every entity_code the draft names, search
    // studio.locks GLOBALLY -- no project_id filter, UNLIKE import-brief's
    // project-scoped lookup a few hundred lines above (`WHERE project_id=$1
    // AND entity_code = ANY($2)`). That project-scoped search is right for
    // resolving a shot's OWN lock versions within a project that already
    // exists; this search is answering a different question -- "does an
    // approved lock for this entity already exist ANYWHERE" -- because a
    // recurring entity like "Dr Letena" is meant to be reused across
    // projects, not redrawn from scratch every time a new project happens
    // to need her. Only an ACTIVE, APPROVED lock counts as a candidate: an
    // unapproved draft lock in some other project is not something this
    // project should silently inherit.
    const entityCodes = [...new Set(out.entity_codes_needed ?? [])];
    const reuse_candidates = [];
    for (const entityCode of entityCodes) {
      const candidate = await one(
        `SELECT l.id AS source_lock_id, l.entity_type, l.entity_code, l.version, l.data,
                l.reference_asset_ids, p.id AS project_id, p.code AS project_code, p.title AS project_title
         FROM studio.locks l JOIN studio.projects p ON p.id = l.project_id
         WHERE l.entity_code=$1 AND l.is_active AND l.approved_at IS NOT NULL
         ORDER BY l.version DESC LIMIT 1`, [entityCode]);
      reuse_candidates.push({ entity_code: entityCode, candidate: candidate ?? null });
    }

    return { draft: out, reuse_candidates,
      script: { id: script.id, code: script.code, language: script.language } };
  });

  // Applies a (possibly human-edited) draft from the endpoint above. Mirrors
  // import-brief/apply's own discipline exactly -- a human still had to look
  // at and submit the draft object, nothing here triggers automatically off
  // the draft call, and any overlay that cannot validate is SKIPPED and
  // reported with a reason, never silently dropped and never allowed to
  // create a broken row. Two things import-brief/apply did not need to
  // handle: MULTIPLE shots (looped instead of a single presenter_shot
  // insert), and reuse_locks (copying a chosen existing approved lock into
  // this new project instead of leaving every continuity entity to be
  // drafted from zero).
  app.post('/studio/projects/from-script/apply', { preHandler: requirePerm('studio.write') }, async (req, reply) => {
    const { script_id: scriptId, draft, reuse_locks: reuseLocks } = req.body ?? {};
    if (!scriptId) return reply.code(422).send(err(422, 'VALIDATION', 'script_id is required'));
    const script = await one(`SELECT * FROM lcos.scripts WHERE id=$1`, [scriptId]);
    if (!script) return reply.code(404).send(err(404, 'NOT_FOUND', 'script not found'));
    if (!draft || !Array.isArray(draft.shots) || !draft.shots.length) {
      return reply.code(422).send(err(422, 'VALIDATION', 'draft.shots is required and must be a non-empty array'));
    }

    // Refuse a second project for the same script server-side too (the
    // draft endpoint's existing_project short-circuit is a convenience, not
    // the only guard -- a caller could skip straight to apply).
    const already = await one(`SELECT * FROM studio.projects WHERE source_script_id=$1`, [script.id]);
    if (already) {
      return reply.code(422).send(err(422, 'GUARD_FAILED',
        `Script ${script.code} already has a Video Studio project (${already.code}). Open it instead of creating another.`,
        { guard: 'oneProjectPerScript' }));
    }

    // Validate every reuse_locks entry BEFORE creating anything, so a stale
    // or wrong entry fails the whole call cleanly rather than leaving a
    // half-built project behind. In the normal flow every entry here came
    // straight from a reuse_candidate the draft endpoint itself already
    // vetted as active+approved moments earlier, so this should essentially
    // never fire -- it exists for the edge case where the underlying lock
    // changed (deactivated, or reused entity_code changed) between draft
    // and apply, which deserves a loud, specific refusal, not a silent
    // "draft new instead" fallback the human never asked for.
    const sourceLockByEntityCode = {};
    for (const r of (reuseLocks ?? [])) {
      if (!r?.entity_code || !r?.source_lock_id) {
        return reply.code(422).send(err(422, 'VALIDATION',
          'each reuse_locks entry needs both entity_code and source_lock_id'));
      }
      const src = await one(`SELECT * FROM studio.locks WHERE id=$1`, [r.source_lock_id]);
      if (!src || src.entity_code !== r.entity_code || !src.is_active || !src.approved_at) {
        return reply.code(422).send(err(422, 'GUARD_FAILED',
          `reuse_locks entry for ${r.entity_code} does not resolve to a currently active, approved lock (source_lock_id ${r.source_lock_id}) -- it may have been revised or deactivated since the draft was reviewed. Refresh the draft and choose again.`,
          { guard: 'lockReuseInvalid' }));
      }
      sourceLockByEntityCode[r.entity_code] = src;
    }

    const projTitle = (draft.project?.title && String(draft.project.title).trim()) || script.code;
    const projAspect = (draft.project?.aspect_ratio && String(draft.project.aspect_ratio).trim()) || '9:16';
    const projLanguage = String(draft.project?.language || script.language || 'AM').toLowerCase();
    const project = await one(
      `INSERT INTO studio.projects (code, title, format, autonomy_level, brief, aspect_ratio, fps, language,
         source_script_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [code('STU'), projTitle, 'ai_story', 'A1', JSON.stringify({}), projAspect, 30, projLanguage,
       script.id, req.actor?.id ?? null]);
    await q(`INSERT INTO studio.events (project_id, to_state, actor_id, note) VALUES ($1,$2,$3,$4)`,
      [project.id, project.state, req.actor?.id ?? null, `project created from script ${script.code}`]);

    // Reuse locks: copy each chosen source lock's (entity_type, entity_code,
    // data, reference_asset_ids) into a NEW row scoped to THIS project,
    // version 1, active, carrying over the source's approval -- a lock a
    // human already approved once should not need re-approving just
    // because it is now attached to a second project (10.8: an approved
    // reference is immutable, but that immutability is about not silently
    // rewriting it, not about forcing needless re-review of an unchanged
    // fact). The SOURCE row is never mutated or touched: two projects can
    // each hold their own copy of "Dr Letena" without one project's later
    // revision silently changing the other's.
    const lockIdByEntityCode = {};
    const locksReused = [];
    for (const [entityCode, src] of Object.entries(sourceLockByEntityCode)) {
      const copy = await one(
        `INSERT INTO studio.locks (project_id, level, entity_type, entity_code, version, data,
           reference_asset_ids, is_active, approved_at, approved_by)
         VALUES ($1,$2,$3,$4,1,$5,$6,true,$7,$8) RETURNING *`,
        [project.id, src.level, src.entity_type, src.entity_code, JSON.stringify(src.data),
         src.reference_asset_ids, src.approved_at, src.approved_by]);
      lockIdByEntityCode[entityCode] = copy.id;
      locksReused.push({ entity_code: entityCode, source_lock_id: src.id, source_project_id: src.project_id, new_lock_id: copy.id });
      await q(`INSERT INTO studio.events (project_id, actor_id, artifact, note) VALUES ($1,$2,$3,$4)`,
        [project.id, req.actor?.id ?? null, `locks/${copy.entity_code}.v1`,
         `reused lock ${copy.entity_code} from project ${src.project_id} (source lock ${src.id}); the already-approved reference was carried over without re-approval`]);
    }

    // One studio.shots row per draft shot, in array order. locked_lock_ids
    // links whichever of the just-created (reused) locks match that shot's
    // own continuity entity codes -- an entity the human chose NOT to
    // reuse is simply absent from locked_lock_ids for now, exactly as the
    // task describes; it gets a lock the normal way (create-shot's own
    // resolution, or a manual lock) once one exists.
    const shotsCreated = [];
    for (let i = 0; i < draft.shots.length; i++) {
      const sh = draft.shots[i] ?? {};
      const continuity = sh.continuity ?? {};
      const entityCodes = [...(continuity.characters ?? []), continuity.environment, ...(continuity.props ?? [])]
        .filter(Boolean);
      const lockedIds = entityCodes.map(c => lockIdByEntityCode[c]).filter(Boolean);
      const shotCode = (sh.shot_code && String(sh.shot_code).trim()) || code('SH');
      const shot = await one(
        `INSERT INTO studio.shots (project_id, shot_code, order_index, duration_target_s, story, continuity,
           camera, action, audio, graphics, generation, acceptance, locked_lock_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [project.id, shotCode, sh.order_index ?? i, sh.duration_target_s ?? 5,
         JSON.stringify(sh.story ?? {}), JSON.stringify(continuity), JSON.stringify(sh.camera ?? {}),
         JSON.stringify(sh.action ?? {}), JSON.stringify(sh.audio ?? {}), JSON.stringify({}),
         JSON.stringify(sh.generation ?? {}), JSON.stringify({}), lockedIds]);
      shotsCreated.push(shot);
      await q(`INSERT INTO studio.events (project_id, actor_id, artifact, note) VALUES ($1,$2,$3,$4)`,
        [project.id, req.actor?.id ?? null, `shots/${shot.shot_code}`,
         `created shot ${shot.shot_code} (${i + 1} of ${draft.shots.length}) from script ${script.code}`]);
    }

    // Overlays: identical validate/collision/skip-with-reason discipline as
    // import-brief/apply, reusing the exact same shared functions. The
    // collision pool starts empty (a brand-new project has no other
    // overlays yet) and grows as each one is created, same pattern as
    // import-brief/apply's own loop.
    const createdOverlays = [];
    const skippedOverlays = [];
    for (const ov of (draft.overlays ?? [])) {
      const reasons = [];
      if (!OVERLAY_KINDS.includes(ov?.kind)) reasons.push(`kind must be one of ${OVERLAY_KINDS.join(', ')}`);
      if (typeof ov?.start_s !== 'number' || typeof ov?.end_s !== 'number' || !(ov.end_s > ov.start_s)) {
        reasons.push('start_s and end_s are required numbers, and end_s must be greater than start_s');
      }
      if (!reasons.length) reasons.push(...validateOverlayData(ov.kind, ov.data));
      if (!reasons.length && ov.kind === 'ICON') {
        const iconAsset = ov.data?.asset_id ? await one(`SELECT id, kind FROM lcos.assets WHERE id=$1`, [ov.data.asset_id]) : null;
        if (!iconAsset) reasons.push(`data.asset_id ${ov.data?.asset_id ?? '(none)'} does not resolve to an existing asset -- upload the icon image to the asset library first, then set asset_id and create this overlay directly`);
        else if (iconAsset.kind !== 'ICON') reasons.push(`data.asset_id ${ov.data.asset_id} resolves to a ${iconAsset.kind} asset, not ICON`);
      }
      if (!reasons.length) {
        const collision = describeOverlayCollision(createdOverlays, ov.kind, ov.data, ov.start_s, ov.end_s);
        if (collision) reasons.push(collision);
      }
      if (reasons.length) {
        skippedOverlays.push({ kind: ov?.kind ?? null, start_s: ov?.start_s ?? null, end_s: ov?.end_s ?? null,
          reason: reasons.join('; ') });
        continue;
      }
      const saved = await one(
        `INSERT INTO studio.overlays (project_id, kind, start_s, end_s, order_index, data, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [project.id, ov.kind, ov.start_s, ov.end_s, ov.order_index ?? 0, JSON.stringify(ov.data ?? {}), req.actor?.id ?? null]);
      createdOverlays.push(saved);
    }

    await q(`INSERT INTO studio.events (project_id, actor_id, artifact, note) VALUES ($1,$2,$3,$4)`,
      [project.id, req.actor?.id ?? null, `projects/${project.code}`,
       `applied script import from ${script.code}: ${shotsCreated.length} shot(s), ${createdOverlays.length} overlay(s) created` +
       (skippedOverlays.length ? `, ${skippedOverlays.length} overlay(s) skipped (see response)` : '') +
       (locksReused.length ? `, ${locksReused.length} lock(s) reused from an existing approved project` : '')]);
    await audit(null, { actor: req.actor, action: 'studio.project.from_script', objectType: 'STUDIO_PROJECT',
      objectId: project.id, objectCode: project.code });

    return { project, shots_created: shotsCreated, locks_reused: locksReused,
      overlays_created: createdOverlays, overlays_skipped: skippedOverlays,
      caption_draft: draft.caption_draft ?? null };
  });

  // -------------------------------------------------------------------
  // Locks (playbook section 10)
  // -------------------------------------------------------------------
  app.get('/studio/projects/:id/locks', { preHandler: requirePerm('studio.read') }, async (req) => {
    const r = await q(`SELECT * FROM studio.locks WHERE project_id=$1 AND is_active ORDER BY entity_type, entity_code`,
      [req.params.id]);
    await attachReferenceAssets(r.rows);
    return { items: r.rows };
  });

  // Reusable reference images a lock of THIS entity_type could pick from
  // the library, without spending on a fresh Gemini generation -- feeds
  // the Video Studio "pick from library" panel. Reuses the same
  // lcos.assets table and kind filter the Production > Asset library
  // already reads (CHARACTER_REFERENCE / BACKGROUND); a PROP or STYLE lock
  // gets no library shortcut yet since neither kind exists in the library
  // today.
  app.get('/studio/locks/library-candidates', { preHandler: requirePerm('studio.read') }, async (req, reply) => {
    const entityType = req.query?.entity_type;
    const kind = entityType === 'CHARACTER' ? 'CHARACTER_REFERENCE' : entityType === 'ENVIRONMENT' ? 'BACKGROUND' : null;
    if (!kind) return { items: [] };
    const r = await q(
      `SELECT id, code, title, storage_key, mime_type, is_ai_generated, created_at FROM lcos.assets
       WHERE kind=$1::lcos.asset_kind AND is_active ORDER BY created_at DESC LIMIT 60`, [kind]);
    return { items: r.rows };
  });

  // AI-assisted lock intake (18 Aug 2026): turns a free-text description a
  // non-technical person can actually write into the structured fields a
  // lock needs, via the studio_lock_drafter agent (gateway.mjs). Nothing
  // is saved here -- this returns a draft `data` object for the New lock
  // form to show and let the human edit before POSTing the actual lock, so
  // the deterministic prompt compiler downstream still only ever sees
  // reviewed, structured data, never a raw model output. Gated on
  // studio.write, same as creating the lock itself, since this doesn't
  // touch paid image/video generation (that's studio.generate); the
  // org-wide daily AI text-spend cap in invokeAgent() still applies.
  app.post('/studio/locks/draft', { preHandler: requirePerm('studio.write') }, async (req, reply) => {
    const { entity_type, free_text } = req.body ?? {};
    if (!entity_type || !LOCK_ENTITY_TYPES.includes(entity_type)) {
      return reply.code(422).send(err(422, 'VALIDATION', `entity_type must be one of ${LOCK_ENTITY_TYPES.join(', ')}`));
    }
    if (!free_text || !String(free_text).trim()) {
      return reply.code(422).send(err(422, 'VALIDATION', 'free_text is required'));
    }
    const out = await invokeAgent('studio_lock_drafter', { entity_type, free_text },
      { objectType: 'STUDIO_LOCK_DRAFT', workflowCode: 'studio' });
    return { data: reshapeLockDraft(out.fields), clarifying_note: out.clarifying_note ?? null };
  });

  // Creates the NEXT version of a lock. Approving a new version does not
  // mutate the old row (10.8: an approved reference is immutable); it
  // deactivates the old version and, per 5.4, marks any shot generated
  // against it STALE unless that shot's asset is already ACCEPTED (an
  // accepted shot is flagged in the response, not silently invalidated).
  app.post('/studio/projects/:id/locks', { preHandler: requirePerm('studio.write') }, async (req, reply) => {
    const p = await one(`SELECT * FROM studio.projects WHERE id=$1`, [req.params.id]);
    if (!p) return reply.code(404).send(err(404, 'NOT_FOUND', 'project not found'));
    const b = req.body ?? {};
    if (!b.entity_code || !b.level || !b.entity_type) {
      return reply.code(422).send(err(422, 'VALIDATION', 'level, entity_type and entity_code are required'));
    }
    const prior = await one(
      `SELECT * FROM studio.locks WHERE project_id=$1 AND entity_code=$2 ORDER BY version DESC LIMIT 1`,
      [p.id, b.entity_code]);
    const version = (prior?.version ?? 0) + 1;
    const lock = await one(
      `INSERT INTO studio.locks (project_id, level, entity_type, entity_code, version, data, reference_asset_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [p.id, b.level, b.entity_type, b.entity_code, version, JSON.stringify(b.data ?? {}), b.reference_asset_ids ?? []]);
    let staled = [];
    if (prior) {
      await q(`UPDATE studio.locks SET is_active=false WHERE id=$1`, [prior.id]);
      const affected = await q(
        `UPDATE studio.shots SET status='STALE', updated_at=now()
         WHERE project_id=$1 AND $2 = ANY(locked_lock_ids) AND status <> 'ACCEPTED'
         RETURNING id, shot_code`, [p.id, prior.id]);
      staled = affected.rows;
      const stillAccepted = (await q(
        `SELECT id, shot_code FROM studio.shots WHERE project_id=$1 AND $2 = ANY(locked_lock_ids) AND status='ACCEPTED'`,
        [p.id, prior.id])).rows;
      if (stillAccepted.length) {
        await q(`INSERT INTO studio.events (project_id, actor_id, note) VALUES ($1,$2,$3)`,
          [p.id, req.actor?.id ?? null,
           `lock ${b.entity_code} revised to v${version}; shots already ACCEPTED against the old version were NOT invalidated: ${stillAccepted.map(s => s.shot_code).join(', ')}. Review whether they still hold.`]);
      }
    }
    await q(`INSERT INTO studio.events (project_id, actor_id, artifact, note) VALUES ($1,$2,$3,$4)`,
      [p.id, req.actor?.id ?? null, `locks/${b.entity_code}.v${version}`,
       `${prior ? 'revised' : 'created'} lock ${b.entity_code} v${version}`]);
    return { ...lock, staled_shots: staled };
  });

  app.post('/studio/locks/:lockId/approve', { preHandler: requirePerm('studio.approve') }, async (req, reply) => {
    const lock = await one(`SELECT * FROM studio.locks WHERE id=$1`, [req.params.lockId]);
    if (!lock) return reply.code(404).send(err(404, 'NOT_FOUND', 'lock not found'));
    await q(`UPDATE studio.locks SET approved_at=now(), approved_by=$2 WHERE id=$1`, [lock.id, req.actor?.id ?? null]);
    await q(`INSERT INTO studio.events (project_id, actor_id, artifact, note) VALUES ($1,$2,$3,$4)`,
      [lock.project_id, req.actor?.id ?? null, `locks/${lock.entity_code}.v${lock.version}`, `approved lock ${lock.entity_code} v${lock.version}`]);
    return { ok: true };
  });

  // Generate a reference/keyframe still for a lock (character/environment/
  // prop turnaround) via Gemini image generation, compiled deterministically
  // from the lock's own data (compileStillPrompt), and append it to the
  // lock's reference_asset_ids.
  app.post('/studio/locks/:lockId/reference', { preHandler: requirePerm('studio.generate') }, async (req, reply) => {
    const lock = await one(`SELECT * FROM studio.locks WHERE id=$1`, [req.params.lockId]);
    if (!lock) return reply.code(404).send(err(404, 'NOT_FOUND', 'lock not found'));
    const project = await one(`SELECT * FROM studio.projects WHERE id=$1`, [lock.project_id]);
    const estimatedCost = ESTIMATED_COST_USD.GEMINI_REFERENCE_IMAGE;
    let budget;
    try {
      budget = await checkAndSpendBudget(project, estimatedCost, req.actor, req.body?.override_budget === true);
    } catch (e) {
      if (!(e instanceof BudgetExceededError)) throw e;
      return reply.code(422).send(err(422, 'BUDGET_EXCEEDED', e.message));
    }
    const assetId = crypto.randomUUID();
    const prompt = compileStillPrompt(lock);
    const gen = await gemini.generateImage({ prompt, assetId });
    const asset = await one(
      `INSERT INTO studio.assets (id, project_id, kind, status, storage_key, generator, prompt_job_code, settings)
       VALUES ($1,$2,'REFERENCE_IMAGE','GENERATED',$3,$4,$5,$6) RETURNING *`,
      [assetId, lock.project_id, gen.storage_key, JSON.stringify({ provider: 'GEMINI', model: 'gemini-2.5-flash-image' }),
       code('JOB'), JSON.stringify({ prompt })]);
    await q(`UPDATE studio.locks SET reference_asset_ids = array_append(reference_asset_ids, $2) WHERE id=$1`,
      [lock.id, asset.id]);
    await bridgeAssetToLibrary({ asset, kindHint: lock.entity_type,
      title: `${lock.entity_code} reference — ${project.title}`, actorId: req.actor?.id });
    await spendBudget(project.id, resolveSpendAmount(gen, estimatedCost));
    return { ...asset, ...(budget.warning ? { budget_warning: budget.warning } : {}) };
  });

  // Attach an EXISTING library asset (Production > Asset library, or an
  // image a previous studio project already generated) as this lock's
  // newest reference version, instead of paying for a new Gemini call.
  // Copies the storage_key into a fresh studio.assets row so version
  // history and the compose-first-frame step work exactly as if Gemini
  // had just generated it; generator.provider records where it actually
  // came from so that's never confused with a real generation.
  app.post('/studio/locks/:lockId/reference/attach', { preHandler: requirePerm('studio.generate') }, async (req, reply) => {
    const lock = await one(`SELECT * FROM studio.locks WHERE id=$1`, [req.params.lockId]);
    if (!lock) return reply.code(404).send(err(404, 'NOT_FOUND', 'lock not found'));
    const libAssetId = req.body?.library_asset_id;
    if (!libAssetId) return reply.code(422).send(err(422, 'VALIDATION', 'library_asset_id is required'));
    const libAsset = await one(`SELECT * FROM lcos.assets WHERE id=$1 AND is_active`, [libAssetId]);
    if (!libAsset) return reply.code(404).send(err(404, 'NOT_FOUND', 'library asset not found'));
    const assetId = crypto.randomUUID();
    const asset = await one(
      `INSERT INTO studio.assets (id, project_id, kind, status, storage_key, generator, prompt_job_code, settings, library_asset_id)
       VALUES ($1,$2,'REFERENCE_IMAGE','GENERATED',$3,$4,$5,$6,$7) RETURNING *`,
      [assetId, lock.project_id, libAsset.storage_key,
       JSON.stringify({ provider: 'LIBRARY', source_library_asset_id: libAsset.id, source_title: libAsset.title }),
       code('JOB'), JSON.stringify({}), libAsset.id]);
    await q(`UPDATE studio.locks SET reference_asset_ids = array_append(reference_asset_ids, $2) WHERE id=$1`,
      [lock.id, asset.id]);
    await q(`INSERT INTO studio.events (project_id, actor_id, artifact, note) VALUES ($1,$2,$3,$4)`,
      [lock.project_id, req.actor?.id ?? null, `locks/${lock.entity_code}`,
       `attached library asset "${libAsset.title}" as a reference for ${lock.entity_code}`]);
    return asset;
  });

  // Upload a reference image from outside Gemini entirely -- a real photo
  // of Letena's actual presenter, a hand-picked stock backdrop, anything a
  // producer already has -- as a lock's newest reference, same version
  // history as a generated one. Base64 in the JSON body (not multipart) to
  // match every other write route in this API; the frontend reads the
  // chosen file client-side via FileReader before posting.
  app.post('/studio/locks/:lockId/reference/upload',
    { preHandler: requirePerm('studio.generate'), bodyLimit: 12 * 1024 * 1024 }, async (req, reply) => {
    const lock = await one(`SELECT * FROM studio.locks WHERE id=$1`, [req.params.lockId]);
    if (!lock) return reply.code(404).send(err(404, 'NOT_FOUND', 'lock not found'));
    const project = await one(`SELECT * FROM studio.projects WHERE id=$1`, [lock.project_id]);
    const { image_base64, mime_type } = req.body ?? {};
    if (!image_base64) return reply.code(422).send(err(422, 'VALIDATION', 'image_base64 is required'));
    const mt = mime_type || 'image/png';
    const ext = mt === 'image/jpeg' ? 'jpg' : mt === 'image/webp' ? 'webp' : 'png';
    const assetId = crypto.randomUUID();
    const key = `assets/uploaded/${assetId}/image.${ext}`;
    let buf;
    try { buf = Buffer.from(image_base64, 'base64'); }
    catch { return reply.code(422).send(err(422, 'VALIDATION', 'image_base64 is not valid base64')); }
    if (buf.length > 8 * 1024 * 1024) {
      return reply.code(422).send(err(422, 'VALIDATION', 'uploads are capped at 8MB'));
    }
    await storage.put(key, buf);
    const asset = await one(
      `INSERT INTO studio.assets (id, project_id, kind, status, storage_key, generator, prompt_job_code, settings)
       VALUES ($1,$2,'REFERENCE_IMAGE','GENERATED',$3,$4,$5,$6) RETURNING *`,
      [assetId, lock.project_id, key, JSON.stringify({ provider: 'UPLOAD', mime_type: mt }), code('JOB'), JSON.stringify({})]);
    await q(`UPDATE studio.locks SET reference_asset_ids = array_append(reference_asset_ids, $2) WHERE id=$1`,
      [lock.id, asset.id]);
    await bridgeAssetToLibrary({ asset, kindHint: lock.entity_type,
      title: `${lock.entity_code} reference (uploaded) — ${project.title}`, actorId: req.actor?.id });
    await q(`INSERT INTO studio.events (project_id, actor_id, artifact, note) VALUES ($1,$2,$3,$4)`,
      [lock.project_id, req.actor?.id ?? null, `locks/${lock.entity_code}`, `uploaded a reference image for ${lock.entity_code}`]);
    return asset;
  });

  // Make an OLDER reference version this lock's current one (owner
  // question, 21 Aug 2026: "i dont understand how to change the
  // references"). The convention everywhere in this file is append-only /
  // newest-wins, so "select" simply re-appends the chosen asset id --
  // history is preserved, no rows are deleted, and every consumer that
  // already reads "last entry wins" keeps working unchanged. Free: no
  // generation call, no new storage.
  app.post('/studio/locks/:lockId/reference/select', { preHandler: requirePerm('studio.generate') }, async (req, reply) => {
    const lock = await one(`SELECT * FROM studio.locks WHERE id=$1`, [req.params.lockId]);
    if (!lock) return reply.code(404).send(err(404, 'NOT_FOUND', 'lock not found'));
    const assetId = req.body?.asset_id;
    if (!assetId) return reply.code(422).send(err(422, 'VALIDATION', 'asset_id is required'));
    if (!(lock.reference_asset_ids ?? []).includes(assetId)) {
      return reply.code(422).send(err(422, 'VALIDATION',
        'asset_id is not one of this lock\'s reference versions -- use /reference/attach for a library asset instead'));
    }
    if (lock.reference_asset_ids[lock.reference_asset_ids.length - 1] === assetId) {
      return { ok: true, already_current: true };
    }
    await q(`UPDATE studio.locks SET reference_asset_ids = array_append(reference_asset_ids, $2) WHERE id=$1`,
      [lock.id, assetId]);
    await q(`INSERT INTO studio.events (project_id, actor_id, artifact, note) VALUES ($1,$2,$3,$4)`,
      [lock.project_id, req.actor?.id ?? null, `locks/${lock.entity_code}`,
       `re-selected an earlier reference version as current for ${lock.entity_code}`]);
    return { ok: true, already_current: false };
  });

  // Remix an existing reference/keyframe through Gemini image editing
  // (owner request, 21 Aug 2026: "recall characters and backgrounds
  // directly from the studio... and remix them"): send the SAME image back
  // to Gemini with a NEW instruction ("make the coat blue", "add glasses",
  // "same doctor, different clinic room") instead of generating from
  // scratch. If the source image is currently a lock's reference, the
  // remix becomes that lock's newest version too -- reference_asset_ids
  // is append-only everywhere else in this file, so the newest entry
  // already wins by convention; this keeps that convention rather than
  // inventing a second one. The prior version is never deleted.
  app.post('/studio/assets/:assetId/remix', { preHandler: requirePerm('studio.generate') }, async (req, reply) => {
    const source = await one(`SELECT * FROM studio.assets WHERE id=$1`, [req.params.assetId]);
    if (!source) return reply.code(404).send(err(404, 'NOT_FOUND', 'asset not found'));
    if (!['REFERENCE_IMAGE', 'KEYFRAME'].includes(source.kind)) {
      return reply.code(422).send(err(422, 'VALIDATION', 'only a REFERENCE_IMAGE or KEYFRAME asset can be remixed'));
    }
    const prompt = req.body?.prompt?.trim();
    if (!prompt) return reply.code(422).send(err(422, 'VALIDATION', 'prompt is required'));
    const project = await one(`SELECT * FROM studio.projects WHERE id=$1`, [source.project_id]);
    const estimatedCost = ESTIMATED_COST_USD.GEMINI_REMIX_IMAGE;
    let budget;
    try {
      budget = await checkAndSpendBudget(project, estimatedCost, req.actor, req.body?.override_budget === true);
    } catch (e) {
      if (!(e instanceof BudgetExceededError)) throw e;
      return reply.code(422).send(err(422, 'BUDGET_EXCEEDED', e.message));
    }
    const assetId = crypto.randomUUID();
    const gen = await gemini.generateImage({ prompt, assetId, referenceImageKeys: [source.storage_key] });
    const asset = await one(
      `INSERT INTO studio.assets (id, project_id, shot_id, kind, status, storage_key, generator, prompt_job_code, settings, source_asset_id)
       VALUES ($1,$2,$3,$4,'GENERATED',$5,$6,$7,$8,$9) RETURNING *`,
      [assetId, project.id, source.shot_id, source.kind, gen.storage_key,
       JSON.stringify({ provider: 'GEMINI', model: 'gemini-2.5-flash-image', remixed_from: source.id }),
       code('JOB'), JSON.stringify({ prompt, remixed_from: source.id }), source.id]);

    const owningLock = await one(
      `SELECT * FROM studio.locks WHERE $1 = ANY(reference_asset_ids) AND is_active`, [source.id]);
    if (owningLock) {
      await q(`UPDATE studio.locks SET reference_asset_ids = array_append(reference_asset_ids, $2) WHERE id=$1`,
        [owningLock.id, asset.id]);
    }
    // If the source is currently SOME shot's first_frame_asset_id (set by
    // compose-first-frame or continue-from-previous, neither of which
    // attaches to a lock), the remix must become that shot's first frame
    // too -- otherwise Generate would silently keep using the un-remixed
    // frame while the UI shows the remixed one, which defeats the entire
    // point of remix being an "editable checkpoint" before generating.
    const owningShot = await one(
      `SELECT * FROM studio.shots WHERE generation->>'first_frame_asset_id' = $1`, [source.id]);
    if (owningShot) {
      await q(`UPDATE studio.shots SET generation = generation || $2::jsonb, updated_at=now() WHERE id=$1`,
        [owningShot.id, JSON.stringify({ first_frame_asset_id: asset.id })]);
    }
    await bridgeAssetToLibrary({ asset, kindHint: owningLock?.entity_type ?? null,
      title: `remix — ${prompt.slice(0, 60)}`, actorId: req.actor?.id });
    await q(`INSERT INTO studio.events (project_id, actor_id, note) VALUES ($1,$2,$3)`,
      [project.id, req.actor?.id ?? null,
       `remixed asset ${source.id}${owningLock ? ` (now the newest reference for ${owningLock.entity_code})` : ''}` +
       `${owningShot ? ` (now shot ${owningShot.shot_code}'s first frame)` : ''}: "${prompt.slice(0, 100)}"`]);
    await spendBudget(project.id, resolveSpendAmount(gen, estimatedCost));
    return { ...asset, attached_to_lock: owningLock ? { id: owningLock.id, entity_code: owningLock.entity_code } : null,
      attached_to_shot: owningShot ? { id: owningShot.id, shot_code: owningShot.shot_code } : null,
      ...(budget.warning ? { budget_warning: budget.warning } : {}) };
  });

  // -------------------------------------------------------------------
  // Shots (playbook section 11)
  // -------------------------------------------------------------------
  app.post('/studio/projects/:id/shots', { preHandler: requirePerm('studio.write') }, async (req, reply) => {
    const p = await one(`SELECT * FROM studio.projects WHERE id=$1`, [req.params.id]);
    if (!p) return reply.code(404).send(err(404, 'NOT_FOUND', 'project not found'));
    const b = req.body ?? {};
    if (!b.shot_code) return reply.code(422).send(err(422, 'VALIDATION', 'shot_code is required'));
    // Resolve the ACTIVE lock ids for whatever entity codes the shot's
    // continuity block names, so locked_lock_ids records exactly which
    // lock VERSIONS this shot was authored against (needed for STALE
    // detection on a later lock revision).
    const entityCodes = [
      ...(b.continuity?.characters ?? []), b.continuity?.environment, ...(b.continuity?.props ?? []),
    ].filter(Boolean);
    const lockRows = entityCodes.length
      ? (await q(`SELECT id FROM studio.locks WHERE project_id=$1 AND entity_code = ANY($2) AND is_active`,
          [p.id, entityCodes])).rows
      : [];
    const shot = await one(
      `INSERT INTO studio.shots (project_id, shot_code, order_index, duration_target_s, story, continuity,
         camera, action, audio, graphics, generation, acceptance, locked_lock_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [p.id, b.shot_code, b.order_index ?? 0, b.duration_target_s ?? 5,
       JSON.stringify(b.story ?? {}), JSON.stringify(b.continuity ?? {}), JSON.stringify(b.camera ?? {}),
       JSON.stringify(b.action ?? {}), JSON.stringify(b.audio ?? {}), JSON.stringify(b.graphics ?? {}),
       JSON.stringify(b.generation ?? {}), JSON.stringify(b.acceptance ?? {}), lockRows.map(l => l.id)]);
    return shot;
  });

  app.patch('/studio/shots/:shotId', { preHandler: requirePerm('studio.write') }, async (req, reply) => {
    const shot = await one(`SELECT * FROM studio.shots WHERE id=$1`, [req.params.shotId]);
    if (!shot) return reply.code(404).send(err(404, 'NOT_FOUND', 'shot not found'));
    if (!['DRAFT', 'STALE'].includes(shot.status)) {
      return reply.code(422).send(err(422, 'GUARD_FAILED',
        `shot is ${shot.status}; edit intent only while DRAFT or STALE, otherwise generate a new shot version instead of rewriting one with accepted or in-flight work`));
    }
    const b = req.body ?? {};
    const fields = ['story', 'continuity', 'camera', 'action', 'audio', 'graphics', 'generation', 'acceptance'];
    const sets = []; const vals = [shot.id]; let i = 2;
    for (const f of fields) {
      if (b[f] !== undefined) { sets.push(`${f}=$${i}`); vals.push(JSON.stringify(b[f])); i++; }
    }
    if (b.duration_target_s !== undefined) { sets.push(`duration_target_s=$${i}`); vals.push(b.duration_target_s); i++; }
    if (!sets.length) return shot;
    sets.push('status=\'DRAFT\'', 'updated_at=now()');
    const updated = await one(`UPDATE studio.shots SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, vals);
    return updated;
  });

  // Compose a shot's first frame from its locked CHARACTER + ENVIRONMENT
  // (Video Studio "step by step" shot generation, 19 Aug 2026): Letena's
  // real doctor-presenter Instagram content is the same doctor across two
  // different backdrops -- character identity fixed, background swapped --
  // and this route is the step that was missing to build that first frame
  // deliberately instead of leaving image_to_video's first_frame_asset_id
  // for a human to hand-assemble outside the system. It does NOT generate
  // video and does NOT touch shot.status; it only produces one composed
  // still and points the shot's generation block at it, so the existing
  // /generate route picks it up as an image_to_video first frame exactly
  // as it already knows how to.
  app.post('/studio/shots/:shotId/compose-first-frame', { preHandler: requirePerm('studio.generate') }, async (req, reply) => {
    const shot = await one(`SELECT * FROM studio.shots WHERE id=$1`, [req.params.shotId]);
    if (!shot) return reply.code(404).send(err(404, 'NOT_FOUND', 'shot not found'));
    const project = await one(`SELECT * FROM studio.projects WHERE id=$1`, [shot.project_id]);
    const locks = (await q(`SELECT * FROM studio.locks WHERE id = ANY($1)`, [shot.locked_lock_ids])).rows;
    const characterLock = locks.find(l => l.entity_type === 'CHARACTER');
    const environmentLock = locks.find(l => l.entity_type === 'ENVIRONMENT');
    const styleLock = locks.find(l => l.entity_type === 'STYLE');

    if (!characterLock) {
      return reply.code(422).send(err(422, 'GUARD_FAILED',
        'this shot has no CHARACTER lock attached -- attach one before composing a first frame'));
    }
    if (!environmentLock) {
      return reply.code(422).send(err(422, 'GUARD_FAILED',
        'this shot has no ENVIRONMENT lock attached -- attach one before composing a first frame'));
    }
    if (!characterLock.approved_at) {
      return reply.code(422).send(err(422, 'GUARD_FAILED',
        'the CHARACTER lock on this shot is not approved yet -- approve it before composing a first frame'));
    }
    if (!environmentLock.approved_at) {
      return reply.code(422).send(err(422, 'GUARD_FAILED',
        'the ENVIRONMENT lock on this shot is not approved yet -- approve it before composing a first frame'));
    }
    if (!characterLock.reference_asset_ids?.length) {
      return reply.code(422).send(err(422, 'GUARD_FAILED',
        'the CHARACTER lock has no reference image yet -- generate one via POST /studio/locks/:lockId/reference first'));
    }
    if (!environmentLock.reference_asset_ids?.length) {
      return reply.code(422).send(err(422, 'GUARD_FAILED',
        'the ENVIRONMENT lock has no reference image yet -- generate one via POST /studio/locks/:lockId/reference first'));
    }

    const estimatedCost = ESTIMATED_COST_USD.GEMINI_COMPOSE_IMAGE;
    let budget;
    try {
      budget = await checkAndSpendBudget(project, estimatedCost, req.actor, req.body?.override_budget === true);
    } catch (e) {
      if (!(e instanceof BudgetExceededError)) throw e;
      return reply.code(422).send(err(422, 'BUDGET_EXCEEDED', e.message));
    }

    // reference_asset_ids is appended-to (array_append), so the LAST entry
    // is the most recently generated -- and presumably best -- reference.
    const characterRefId = characterLock.reference_asset_ids[characterLock.reference_asset_ids.length - 1];
    const environmentRefId = environmentLock.reference_asset_ids[environmentLock.reference_asset_ids.length - 1];
    const [characterRef, environmentRef] = await Promise.all([
      one(`SELECT storage_key FROM studio.assets WHERE id=$1`, [characterRefId]),
      one(`SELECT storage_key FROM studio.assets WHERE id=$1`, [environmentRefId]),
    ]);

    const assetId = crypto.randomUUID();
    const prompt = compileComposePrompt(characterLock, environmentLock, styleLock);
    const gen = await gemini.generateImage({ prompt, assetId,
      referenceImageKeys: [characterRef.storage_key, environmentRef.storage_key] });
    const asset = await one(
      `INSERT INTO studio.assets (id, project_id, shot_id, kind, status, storage_key, generator, prompt_job_code, settings)
       VALUES ($1,$2,$3,'KEYFRAME','GENERATED',$4,$5,$6,$7) RETURNING *`,
      [assetId, project.id, shot.id, gen.storage_key,
       JSON.stringify({ provider: 'GEMINI', model: 'gemini-2.5-flash-image',
         composed_from: { character_lock_id: characterLock.id, environment_lock_id: environmentLock.id } }),
       code('JOB'), JSON.stringify({ prompt })]);

    // Point the shot's generation block at the new first frame, preserving
    // every other existing key already in shot.generation -- same
    // field-merge discipline as PATCH /studio/shots/:shotId, applied
    // directly here since that route also re-flips status to DRAFT, which
    // this step should not do.
    await q(`UPDATE studio.shots SET generation = generation || $2::jsonb, updated_at=now() WHERE id=$1`,
      [shot.id, JSON.stringify({ first_frame_asset_id: asset.id, mode_preference: 'image_to_video' })]);

    await bridgeAssetToLibrary({ asset, kindHint: null,
      title: `${shot.shot_code} first frame — ${project.title}`, actorId: req.actor?.id });
    await spendBudget(project.id, resolveSpendAmount(gen, estimatedCost));

    return { asset, character_lock: { id: characterLock.id, entity_code: characterLock.entity_code },
      environment_lock: { id: environmentLock.id, entity_code: environmentLock.entity_code },
      ...(budget.warning ? { budget_warning: budget.warning } : {}) };
  });

  // Continue a shot from the shot before it (owner request, 21 Aug 2026:
  // Kling advertises "the last frame of a video becomes the first frame
  // of the next", and the ask was to reproduce that with Runway too).
  // Rather than depending on any one video vendor's native continuation
  // feature, this pulls the LAST frame of an earlier shot's own ACCEPTED
  // video with ffmpeg (extractLastFrame above) and points THIS shot's
  // first_frame_asset_id at it -- the exact same field compose-first-
  // frame already writes, so /generate needs no changes to consume it and
  // this works with Kling, Runway, or VEO identically. Deliberately a
  // manual, per-shot action (not automatic chaining) and the resulting
  // frame is a normal KEYFRAME asset the producer can review, and remix
  // through Gemini (POST /studio/assets/:assetId/remix already accepts
  // KEYFRAME) before Generate ever runs -- an editable checkpoint, not a
  // black box.
  //
  // Only ever reads from an ACCEPTED asset, never a raw generated
  // candidate: continuity should build on reviewed work, not on
  // something that might still get reworked or rejected. Defaults to the
  // immediately preceding shot in this project's own order_index
  // sequence; body.source_shot_id overrides that to continue from a
  // specific non-adjacent shot instead (e.g. skipping a cutaway).
  app.post('/studio/shots/:shotId/continue-from-previous', { preHandler: requirePerm('studio.generate') }, async (req, reply) => {
    const shot = await one(`SELECT * FROM studio.shots WHERE id=$1`, [req.params.shotId]);
    if (!shot) return reply.code(404).send(err(404, 'NOT_FOUND', 'shot not found'));
    const project = await one(`SELECT * FROM studio.projects WHERE id=$1`, [shot.project_id]);

    let sourceShot;
    if (req.body?.source_shot_id) {
      sourceShot = await one(`SELECT * FROM studio.shots WHERE id=$1 AND project_id=$2`,
        [req.body.source_shot_id, shot.project_id]);
      if (!sourceShot) {
        return reply.code(404).send(err(404, 'NOT_FOUND', 'source_shot_id does not resolve to a shot in this project'));
      }
    } else {
      sourceShot = await one(
        `SELECT * FROM studio.shots WHERE project_id=$1 AND order_index < $2 ORDER BY order_index DESC LIMIT 1`,
        [shot.project_id, shot.order_index]);
      if (!sourceShot) {
        return reply.code(422).send(err(422, 'GUARD_FAILED',
          'this is the first shot in the project by order_index -- there is no earlier shot to continue from. Pass source_shot_id to continue from a specific non-adjacent shot instead.'));
      }
    }
    if (sourceShot.id === shot.id) {
      return reply.code(422).send(err(422, 'GUARD_FAILED', 'a shot cannot continue from itself'));
    }
    if (!sourceShot.accepted_asset_id) {
      return reply.code(422).send(err(422, 'GUARD_FAILED',
        `shot ${sourceShot.shot_code} has no ACCEPTED video yet -- accept its generated video (POST /studio/assets/:assetId/accept) before continuing from it, so a shot only ever builds on reviewed work`));
    }
    const sourceAsset = await one(`SELECT * FROM studio.assets WHERE id=$1`, [sourceShot.accepted_asset_id]);
    if (!sourceAsset || sourceAsset.kind !== 'VIDEO') {
      return reply.code(422).send(err(422, 'GUARD_FAILED',
        `shot ${sourceShot.shot_code}'s accepted asset is not a VIDEO -- cannot extract a last frame from it`));
    }

    const assetId = crypto.randomUUID();
    const scratchPath = storage.localPath(`assets/generated/${assetId}/last-frame-scratch.png`);
    await mkdir(join(scratchPath, '..'), { recursive: true });
    await extractLastFrame(storage.localPath(sourceAsset.storage_key), scratchPath);
    const key = `assets/generated/${assetId}/last-frame.png`;
    await storage.put(key, await readFile(scratchPath));

    const asset = await one(
      `INSERT INTO studio.assets (id, project_id, shot_id, kind, status, storage_key, generator, prompt_job_code, settings, source_asset_id)
       VALUES ($1,$2,$3,'KEYFRAME','GENERATED',$4,$5,$6,$7,$8) RETURNING *`,
      [assetId, project.id, shot.id, key,
       JSON.stringify({ provider: 'FRAME_EXTRACT', continued_from_shot_id: sourceShot.id, continued_from_asset_id: sourceAsset.id }),
       code('JOB'), JSON.stringify({ continued_from_shot_code: sourceShot.shot_code }), sourceAsset.id]);

    // Same field-merge discipline as compose-first-frame: only touch
    // generation.first_frame_asset_id/mode_preference/continued_from_shot_id,
    // preserve every other existing key, and do not flip shot.status.
    await q(`UPDATE studio.shots SET generation = generation || $2::jsonb, updated_at=now() WHERE id=$1`,
      [shot.id, JSON.stringify({ first_frame_asset_id: asset.id, mode_preference: 'image_to_video',
        continued_from_shot_id: sourceShot.id })]);

    await bridgeAssetToLibrary({ asset, kindHint: null,
      title: `${shot.shot_code} continued from ${sourceShot.shot_code} — ${project.title}`, actorId: req.actor?.id });

    await q(`INSERT INTO studio.events (project_id, actor_id, artifact, note) VALUES ($1,$2,$3,$4)`,
      [project.id, req.actor?.id ?? null, `shots/${shot.shot_code}`,
       `pulled the last frame of ${sourceShot.shot_code}'s accepted video as ${shot.shot_code}'s first frame, for continuity`]);

    return { asset, continued_from: { shot_id: sourceShot.id, shot_code: sourceShot.shot_code, asset_id: sourceAsset.id } };
  });

  // Generate a candidate for a shot: compile the prompt, run it through the
  // retry/repair/fallback ladder (playbook 15; see runGenerationLadder
  // above -- TRANSIENT retries the same engine once, POLICY stops cold,
  // PROVIDER_DOWN falls back to the other engine, capped at 3 real calls),
  // store the asset from whichever attempt succeeded, then run automated
  // technical + continuity QC before returning. A REWORK/BLOCKED QC
  // disposition on an asset that DID generate is still returned for a
  // human or a follow-up call to act on, not automatically retried -- the
  // ladder only covers the provider call itself failing outright, not a
  // QC judgment on a candidate that came back.
  app.post('/studio/shots/:shotId/generate', { preHandler: requirePerm('studio.generate') }, async (req, reply) => {
    const shot = await one(`SELECT * FROM studio.shots WHERE id=$1`, [req.params.shotId]);
    if (!shot) return reply.code(404).send(err(404, 'NOT_FOUND', 'shot not found'));
    const project = await one(`SELECT * FROM studio.projects WHERE id=$1`, [shot.project_id]);
    const locks = (await q(`SELECT * FROM studio.locks WHERE id = ANY($1)`, [shot.locked_lock_ids])).rows;

    const engine = videoEngine(shot.generation?.engine ?? project.video_engine);
    const engineName = engine === videoEngine('VEO') ? 'VEO' : 'KLING';
    const estimatedCost = (engineName === 'VEO' ? ESTIMATED_COST_USD.VEO_VIDEO_PER_S : ESTIMATED_COST_USD.KLING_VIDEO_PER_S)
      * Number(shot.duration_target_s);
    // Budget check happens BEFORE the shot is touched at all: a refusal
    // here means nothing was attempted, so the shot's status is left
    // exactly as it was rather than being flipped to GENERATING/NEEDS_REVIEW.
    let budget;
    try {
      budget = await checkAndSpendBudget(project, estimatedCost, req.actor, req.body?.override_budget === true);
    } catch (e) {
      if (!(e instanceof BudgetExceededError)) throw e;
      return reply.code(422).send(err(422, 'BUDGET_EXCEEDED', e.message));
    }

    await q(`UPDATE studio.shots SET status='GENERATING', updated_at=now() WHERE id=$1`, [shot.id]);

    const assetId = crypto.randomUUID();
    const motionPrompt = compileMotionPrompt(shot, locks);
    const negative = negativePromptFor(locks);
    const mode = shot.generation?.mode_preference ?? 'text_to_video';

    let firstFrame = null;
    if (mode === 'image_to_video') {
      firstFrame = shot.generation?.first_frame_asset_id
        ? await one(`SELECT storage_key FROM studio.assets WHERE id=$1`, [shot.generation.first_frame_asset_id])
        : null;
      if (!firstFrame) {
        await q(`UPDATE studio.shots SET status='NEEDS_REVIEW', updated_at=now() WHERE id=$1`, [shot.id]);
        return reply.code(422).send(err(422, 'VALIDATION',
          'generation.mode_preference is image_to_video but generation.first_frame_asset_id does not resolve to a stored asset'));
      }
    }
    const callArgs = mode === 'image_to_video'
      ? { prompt: motionPrompt, negativePrompt: negative, referenceImageKey: firstFrame.storage_key, assetId }
      : { prompt: motionPrompt, negativePrompt: negative, assetId };

    // Retry/repair/fallback ladder (playbook 15) replaces what used to be
    // a single unguarded provider call here -- see runGenerationLadder for
    // the classification and retry/fallback rules it applies.
    const ladder = await runGenerationLadder({ project, actorId: req.actor?.id ?? null, engine, engineName, mode, callArgs });
    if (!ladder.success) {
      await q(`UPDATE studio.shots SET status='NEEDS_REVIEW', updated_at=now() WHERE id=$1`, [shot.id]);
      const last = ladder.attempts[ladder.attempts.length - 1];
      // Never hide the attempt history: a human reviewing this failure
      // sees every real call the ladder tried, not just the last error.
      return reply.code(502).send(err(502, 'GENERATION_FAILED', last.message, { attempts: ladder.attempts }));
    }
    const gen = ladder.gen;
    // The engine that ACTUALLY produced the accepted candidate -- the
    // originally-requested one unless a PROVIDER_DOWN fallback occurred,
    // in which case this is the other engine (rule 4 of the retry ladder).
    const finalEngineName = ladder.engineLabel;

    const asset = await one(
      `INSERT INTO studio.assets (id, project_id, shot_id, kind, status, storage_key, generator,
         prompt_job_code, reference_ids, settings, cost_usd)
       VALUES ($1,$2,$3,'VIDEO','GENERATED',$4,$5,$6,$7,$8,$9) RETURNING *`,
      [assetId, project.id, shot.id, gen.storage_key,
       // attempt_count/fallback_used are purely additive alongside the
       // pre-existing provider/mode/job_id shape, so anything that already
       // reads generator.provider/mode/job_id is unaffected.
       JSON.stringify({ provider: finalEngineName, mode, job_id: gen.provider_job_id,
         attempt_count: ladder.attemptCount, fallback_used: ladder.fallbackUsed }),
       code('JOB'), (shot.generation?.reference_ids ?? []), JSON.stringify({ prompt: motionPrompt, negative }),
       gen.cost_usd ?? null]);
    // Spend is recorded only now that generation actually succeeded and the
    // asset exists (playbook 21): the estimate that passed the guardrail
    // check above -- computed from the ORIGINALLY selected engine and NOT
    // re-run against a fallback engine's (possibly different) per-second
    // rate even when a fallback occurred, a deliberate phase-1
    // simplification -- unless the adapter reported a real cost (see
    // resolveSpendAmount); every adapter returns 0 in MOCK mode today.
    // Called exactly once no matter how many attempts the ladder made.
    await spendBudget(project.id, resolveSpendAmount(gen, estimatedCost));

    // Automated QC (playbook 19.1, 19.2). Technical always runs; continuity
    // runs when the shot has reference images through its locks.
    const localPath = storage.localPath(asset.storage_key);
    const technical = await technicalQc(localPath,
      { kind: 'VIDEO', duration_target_s: Number(shot.duration_target_s), aspect_ratio: project.aspect_ratio });
    const referenceAssets = locks.flatMap(l => l.reference_asset_ids ?? []);
    const refRows = referenceAssets.length
      ? (await q(`SELECT id, storage_key FROM studio.assets WHERE id = ANY($1)`, [referenceAssets])).rows : [];
    const continuity = await continuityQc(localPath, refRows,
      locks.flatMap(l => l.data?.forbidden_drift ?? []));

    const disposition = worseDisposition(technical.disposition, continuity.disposition);
    const qc = await one(
      `INSERT INTO studio.qc_reports (asset_id, disposition, technical, continuity, issues)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [asset.id, disposition, JSON.stringify(technical.report), JSON.stringify(continuity.report),
       JSON.stringify([...(technical.report.issues ?? []), continuity.report.notes].filter(Boolean))]);

    const assetStatus = { PASS: 'QC_PASS', PASS_WITH_NOTES: 'QC_PASS_WITH_NOTES',
      REWORK: 'QC_REWORK', BLOCKED: 'QC_BLOCKED' }[disposition];
    await q(`UPDATE studio.assets SET status=$2 WHERE id=$1`, [asset.id, assetStatus]);
    await q(`UPDATE studio.shots SET status='NEEDS_REVIEW', updated_at=now() WHERE id=$1`, [shot.id]);

    return { asset: { ...asset, status: assetStatus }, qc_report: qc,
      ...(budget.warning ? { budget_warning: budget.warning } : {}) };
  });

  // Voice for one shot's dialogue/narration line (playbook 16.1), stored
  // as its own VOICE asset rather than baked into the video asset, so a
  // line can be re-recorded without regenerating the shot's video.
  app.post('/studio/shots/:shotId/voice', { preHandler: requirePerm('studio.generate') }, async (req, reply) => {
    const shot = await one(`SELECT * FROM studio.shots WHERE id=$1`, [req.params.shotId]);
    if (!shot) return reply.code(404).send(err(404, 'NOT_FOUND', 'shot not found'));
    const text = req.body?.text ?? shot.audio?.dialogue ?? shot.story?.narration;
    if (!text) return reply.code(422).send(err(422, 'VALIDATION',
      'no text to voice: pass body.text, or set shot.audio.dialogue or shot.story.narration'));
    const project = await one(`SELECT * FROM studio.projects WHERE id=$1`, [shot.project_id]);
    const estimatedCost = ESTIMATED_COST_USD.AZURE_TTS_PER_CHAR * text.length;
    let budget;
    try {
      budget = await checkAndSpendBudget(project, estimatedCost, req.actor, req.body?.override_budget === true);
    } catch (e) {
      if (!(e instanceof BudgetExceededError)) throw e;
      return reply.code(422).send(err(422, 'BUDGET_EXCEEDED', e.message));
    }
    const assetId = crypto.randomUUID();
    const gen = await azureSpeech.tts({ text, language: project.language === 'am' ? 'am-ET' : 'en-US', assetId });
    const asset = await one(
      `INSERT INTO studio.assets (id, project_id, shot_id, kind, status, storage_key, generator, settings)
       VALUES ($1,$2,$3,'VOICE','GENERATED',$4,$5,$6) RETURNING *`,
      [assetId, shot.project_id, shot.id, gen.storage_key,
       JSON.stringify({ provider: 'AZURE' }), JSON.stringify({ text })]);
    await spendBudget(project.id, resolveSpendAmount(gen, estimatedCost));
    return { ...asset, ...(budget.warning ? { budget_warning: budget.warning } : {}) };
  });

  // Project-level music bed (playbook 16.2). Not attached to a single
  // shot; assembly (below) does not yet mix this into the final cut, so
  // this is generated and stored for a human to lay in during finishing,
  // not automatically applied.
  app.post('/studio/projects/:id/music', { preHandler: requirePerm('studio.generate') }, async (req, reply) => {
    const p = await one(`SELECT * FROM studio.projects WHERE id=$1`, [req.params.id]);
    if (!p) return reply.code(404).send(err(404, 'NOT_FOUND', 'project not found'));
    const brief = req.body?.brief ?? p.brief?.music_brief;
    if (!brief?.prompt) return reply.code(422).send(err(422, 'VALIDATION', 'body.brief.prompt is required'));
    const estimatedCost = ESTIMATED_COST_USD.SUNO_MUSIC_TRACK;
    let budget;
    try {
      budget = await checkAndSpendBudget(p, estimatedCost, req.actor, req.body?.override_budget === true);
    } catch (e) {
      if (!(e instanceof BudgetExceededError)) throw e;
      return reply.code(422).send(err(422, 'BUDGET_EXCEEDED', e.message));
    }
    const assetId = crypto.randomUUID();
    const gen = await suno.generateMusic({ prompt: brief.prompt, tempoBpm: brief.tempo_bpm,
      durationS: brief.duration_s, assetId });
    const asset = await one(
      `INSERT INTO studio.assets (id, project_id, kind, status, storage_key, generator, settings)
       VALUES ($1,$2,'MUSIC','GENERATED',$3,$4,$5) RETURNING *`,
      [assetId, p.id, gen.storage_key, JSON.stringify({ provider: 'SUNO', job_id: gen.provider_job_id }),
       JSON.stringify(brief)]);
    await spendBudget(p.id, resolveSpendAmount(gen, estimatedCost));
    return { ...asset, ...(budget.warning ? { budget_warning: budget.warning } : {}) };
  });

  app.get('/studio/shots/:shotId/assets', { preHandler: requirePerm('studio.read') }, async (req) => {
    const assets = (await q(`SELECT * FROM studio.assets WHERE shot_id=$1 ORDER BY created_at DESC`,
      [req.params.shotId])).rows;
    for (const a of assets) {
      a.qc_reports = (await q(`SELECT * FROM studio.qc_reports WHERE asset_id=$1 ORDER BY created_at DESC`, [a.id])).rows;
    }
    return { items: assets };
  });

  app.post('/studio/assets/:assetId/qc', { preHandler: requirePerm('studio.generate') }, async (req, reply) => {
    const asset = await one(`SELECT * FROM studio.assets WHERE id=$1`, [req.params.assetId]);
    if (!asset) return reply.code(404).send(err(404, 'NOT_FOUND', 'asset not found'));
    const shot = asset.shot_id ? await one(`SELECT * FROM studio.shots WHERE id=$1`, [asset.shot_id]) : null;
    const project = await one(`SELECT * FROM studio.projects WHERE id=$1`, [asset.project_id]);
    const localPath = storage.localPath(asset.storage_key);
    const technical = await technicalQc(localPath,
      shot ? { kind: 'VIDEO', duration_target_s: Number(shot.duration_target_s), aspect_ratio: project.aspect_ratio } : {});
    const locks = shot ? (await q(`SELECT * FROM studio.locks WHERE id = ANY($1)`, [shot.locked_lock_ids])).rows : [];
    const referenceAssets = locks.flatMap(l => l.reference_asset_ids ?? []);
    const refRows = referenceAssets.length
      ? (await q(`SELECT id, storage_key FROM studio.assets WHERE id = ANY($1)`, [referenceAssets])).rows : [];
    const continuity = await continuityQc(localPath, refRows, locks.flatMap(l => l.data?.forbidden_drift ?? []));
    const disposition = worseDisposition(technical.disposition, continuity.disposition);
    const qc = await one(
      `INSERT INTO studio.qc_reports (asset_id, disposition, technical, continuity, issues)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [asset.id, disposition, JSON.stringify(technical.report), JSON.stringify(continuity.report),
       JSON.stringify([...(technical.report.issues ?? []), continuity.report.notes].filter(Boolean))]);
    return qc;
  });

  // Human gate: an asset only becomes usable in assembly once explicitly
  // accepted. This is the one step this playbook insists automated QC can
  // never substitute for (19.6: PASS is a machine disposition, not an
  // approval).
  app.post('/studio/assets/:assetId/accept', { preHandler: requirePerm('studio.approve') }, async (req, reply) => {
    const asset = await one(`SELECT * FROM studio.assets WHERE id=$1`, [req.params.assetId]);
    if (!asset) return reply.code(404).send(err(404, 'NOT_FOUND', 'asset not found'));
    if (asset.status === 'QC_BLOCKED') {
      return reply.code(422).send(err(422, 'GUARD_FAILED',
        'this asset is QC_BLOCKED; a hard-constraint QC failure cannot be accepted, regenerate or repair it first'));
    }
    await q(`UPDATE studio.assets SET status='ACCEPTED' WHERE id=$1`, [asset.id]);
    if (asset.shot_id) {
      await q(`UPDATE studio.shots SET status='ACCEPTED', accepted_asset_id=$2, updated_at=now() WHERE id=$1`,
        [asset.shot_id, asset.id]);
    }
    await q(`INSERT INTO studio.events (project_id, actor_id, artifact, note) VALUES ($1,$2,$3,$4)`,
      [asset.project_id, req.actor?.id ?? null, asset.id, `accepted asset for shot ${asset.shot_id ?? '(none)'}`]);
    return { ok: true };
  });

  // -------------------------------------------------------------------
  // Overlays (0035_studio_overlays.sql, 19 Aug 2026): burned-in title
  // cards, on-screen labels, the closing door/CTA card, and icon moments
  // -- the real gap the "Spotting on the Pill" brief exposed, since
  // assemble() below had zero capability to burn anything in before
  // tonight. Reviewable structured data, same continuity-lock philosophy
  // as studio.locks: apps/api/src/modules/studio_overlays.mjs compiles the
  // actual SVG/ffmpeg burn-in deterministically from these APPROVED rows
  // inside assemble()'s final pass, never generated fresh at render time.
  // -------------------------------------------------------------------
  app.get('/studio/projects/:id/overlays', { preHandler: requirePerm('studio.read') }, async (req) => {
    const r = await q(`SELECT * FROM studio.overlays WHERE project_id=$1 ORDER BY start_s, order_index`, [req.params.id]);
    return { items: r.rows };
  });

  app.post('/studio/projects/:id/overlays', { preHandler: requirePerm('studio.write') }, async (req, reply) => {
    const p = await one(`SELECT * FROM studio.projects WHERE id=$1`, [req.params.id]);
    if (!p) return reply.code(404).send(err(404, 'NOT_FOUND', 'project not found'));
    const b = req.body ?? {};
    if (!OVERLAY_KINDS.includes(b.kind)) {
      return reply.code(422).send(err(422, 'VALIDATION', `kind must be one of ${OVERLAY_KINDS.join(', ')}`));
    }
    if (typeof b.start_s !== 'number' || typeof b.end_s !== 'number' || !(b.end_s > b.start_s)) {
      return reply.code(422).send(err(422, 'VALIDATION', 'start_s and end_s are required numbers, and end_s must be greater than start_s'));
    }
    const dataErrors = validateOverlayData(b.kind, b.data);
    if (dataErrors.length) return reply.code(422).send(err(422, 'VALIDATION', dataErrors.join('; ')));
    if (b.kind === 'ICON') {
      const iconAsset = await one(`SELECT id, kind FROM lcos.assets WHERE id=$1`, [b.data.asset_id]);
      if (!iconAsset) return reply.code(422).send(err(422, 'VALIDATION', `data.asset_id ${b.data.asset_id} does not resolve to an existing asset`));
      if (iconAsset.kind !== 'ICON') return reply.code(422).send(err(422, 'VALIDATION', `data.asset_id ${b.data.asset_id} resolves to a ${iconAsset.kind} asset, not ICON`));
    }
    const existing = (await q(`SELECT id, kind, start_s, end_s, data FROM studio.overlays WHERE project_id=$1`, [p.id])).rows;
    const collision = describeOverlayCollision(existing, b.kind, b.data, b.start_s, b.end_s);
    if (collision) return reply.code(422).send(err(422, 'GUARD_FAILED', collision));
    const overlay = await one(
      `INSERT INTO studio.overlays (project_id, kind, start_s, end_s, order_index, data, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [p.id, b.kind, b.start_s, b.end_s, b.order_index ?? 0, JSON.stringify(b.data ?? {}), req.actor?.id ?? null]);
    await q(`INSERT INTO studio.events (project_id, actor_id, artifact, note) VALUES ($1,$2,$3,$4)`,
      [p.id, req.actor?.id ?? null, `overlays/${overlay.id}`, `created ${b.kind} overlay (${b.start_s}s-${b.end_s}s)`]);
    return overlay;
  });

  // Editing an overlay un-approves it, mirroring how a lock revision
  // deactivates the prior approved version (10.8) rather than letting a
  // change to reviewed content quietly keep its old approval.
  app.patch('/studio/overlays/:overlayId', { preHandler: requirePerm('studio.write') }, async (req, reply) => {
    const overlay = await one(`SELECT * FROM studio.overlays WHERE id=$1`, [req.params.overlayId]);
    if (!overlay) return reply.code(404).send(err(404, 'NOT_FOUND', 'overlay not found'));
    const b = req.body ?? {};
    const kind = b.kind ?? overlay.kind;
    if (b.kind != null && !OVERLAY_KINDS.includes(b.kind)) {
      return reply.code(422).send(err(422, 'VALIDATION', `kind must be one of ${OVERLAY_KINDS.join(', ')}`));
    }
    const startS = b.start_s ?? overlay.start_s;
    const endS = b.end_s ?? overlay.end_s;
    if (!(Number(endS) > Number(startS))) {
      return reply.code(422).send(err(422, 'VALIDATION', 'end_s must be greater than start_s'));
    }
    const data = b.data ?? overlay.data;
    const dataErrors = validateOverlayData(kind, data);
    if (dataErrors.length) return reply.code(422).send(err(422, 'VALIDATION', dataErrors.join('; ')));
    if (kind === 'ICON' && b.data) {
      const iconAsset = await one(`SELECT id, kind FROM lcos.assets WHERE id=$1`, [data.asset_id]);
      if (!iconAsset) return reply.code(422).send(err(422, 'VALIDATION', `data.asset_id ${data.asset_id} does not resolve to an existing asset`));
      if (iconAsset.kind !== 'ICON') return reply.code(422).send(err(422, 'VALIDATION', `data.asset_id ${data.asset_id} resolves to a ${iconAsset.kind} asset, not ICON`));
    }
    const updated = await one(
      `UPDATE studio.overlays SET kind=$2, start_s=$3, end_s=$4, order_index=$5, data=$6,
         approved_at=NULL, approved_by=NULL, updated_at=now()
       WHERE id=$1 RETURNING *`,
      [overlay.id, kind, startS, endS, b.order_index ?? overlay.order_index, JSON.stringify(data)]);
    return updated;
  });

  app.post('/studio/overlays/:overlayId/approve', { preHandler: requirePerm('studio.approve') }, async (req, reply) => {
    const overlay = await one(`SELECT * FROM studio.overlays WHERE id=$1`, [req.params.overlayId]);
    if (!overlay) return reply.code(404).send(err(404, 'NOT_FOUND', 'overlay not found'));
    const updated = await one(`UPDATE studio.overlays SET approved_at=now(), approved_by=$2 WHERE id=$1 RETURNING *`,
      [overlay.id, req.actor?.id ?? null]);
    await q(`INSERT INTO studio.events (project_id, actor_id, artifact, note) VALUES ($1,$2,$3,$4)`,
      [overlay.project_id, req.actor?.id ?? null, `overlays/${overlay.id}`, `approved ${overlay.kind} overlay`]);
    return updated;
  });

  // Straightforward hard delete, unlike projects: an overlay has no
  // generated media or audit-history weight of its own -- deleting one
  // just removes a burn-in instruction, nothing is orphaned.
  app.delete('/studio/overlays/:overlayId', { preHandler: requirePerm('studio.write') }, async (req, reply) => {
    const overlay = await one(`SELECT * FROM studio.overlays WHERE id=$1`, [req.params.overlayId]);
    if (!overlay) return reply.code(404).send(err(404, 'NOT_FOUND', 'overlay not found'));
    await q(`DELETE FROM studio.overlays WHERE id=$1`, [overlay.id]);
    return { ok: true };
  });

  // -------------------------------------------------------------------
  // Assembly (playbook 18.2, phase 1 subset): concatenate every shot's
  // ACCEPTED asset, in order_index order, into one file, either as a hard
  // cut (default, ffmpeg concat/-c copy, no re-encode) or -- 18 Aug 2026,
  // third follow-up -- as a crossfade between each adjacent pair
  // (ffmpeg xfade, which requires re-encoding), plus one optional
  // project-music layer mixed under the result. Still no retiming, no more
  // than one music layer, no separate SFX mix, and no general timeline/EDL
  // (see the file header). Every shot must have an accepted asset or the
  // endpoint refuses, naming which ones are missing, rather than silently
  // skipping gaps (playbook 15.4/18: never hide a missing asset with
  // filler) -- that guard is unchanged from before tonight.
  // -------------------------------------------------------------------
  app.post('/studio/projects/:id/assemble', { preHandler: requirePerm('studio.approve') }, async (req, reply) => {
    const p = await one(`SELECT * FROM studio.projects WHERE id=$1`, [req.params.id]);
    if (!p) return reply.code(404).send(err(404, 'NOT_FOUND', 'project not found'));
    const b = req.body ?? {};

    const transition = b.transition ?? 'cut';
    if (!['cut', 'crossfade'].includes(transition)) {
      return reply.code(422).send(err(422, 'VALIDATION', `transition must be 'cut' or 'crossfade', got '${transition}'`));
    }
    const transitionDurationS = b.transition_duration_s ?? 0.5;
    if (typeof transitionDurationS !== 'number' || !(transitionDurationS > 0)) {
      return reply.code(422).send(err(422, 'VALIDATION', 'transition_duration_s must be a positive number'));
    }
    // music_asset_id is validated up front, against the SAME three
    // possible problems every time, so the error always names the
    // accurate one rather than a generic "invalid music_asset_id".
    let musicAsset = null;
    if (b.music_asset_id) {
      musicAsset = await one(`SELECT * FROM studio.assets WHERE id=$1`, [b.music_asset_id]);
      if (!musicAsset) {
        return reply.code(422).send(err(422, 'VALIDATION', `music_asset_id ${b.music_asset_id} does not resolve to an existing asset`));
      }
      if (musicAsset.kind !== 'MUSIC') {
        return reply.code(422).send(err(422, 'VALIDATION', `music_asset_id ${b.music_asset_id} resolves to a ${musicAsset.kind} asset, not MUSIC`));
      }
      if (musicAsset.project_id !== p.id) {
        return reply.code(422).send(err(422, 'VALIDATION', `music_asset_id ${b.music_asset_id} belongs to a different project`));
      }
    }

    const shots = (await q(`SELECT * FROM studio.shots WHERE project_id=$1 ORDER BY order_index`, [p.id])).rows;
    if (!shots.length) return reply.code(422).send(err(422, 'VALIDATION', 'project has no shots'));
    const missing = shots.filter(s => !s.accepted_asset_id).map(s => s.shot_code);
    if (missing.length) {
      return reply.code(422).send(err(422, 'GUARD_FAILED',
        `every shot needs an ACCEPTED asset before assembly; missing: ${missing.join(', ')}`));
    }
    const assets = await Promise.all(shots.map(s =>
      one(`SELECT * FROM studio.assets WHERE id=$1`, [s.accepted_asset_id])));

    // Overlays (0035_studio_overlays.sql, 19 Aug 2026): refuse assembly
    // outright when any overlay on this project is not yet approved,
    // rather than silently burning in only the approved ones. An overlay
    // a producer added but has not reviewed should never quietly end up
    // in a cut nobody signed off on -- same "the system tells you exactly
    // why, never silently does something you didn't ask for" ethos as the
    // missing-accepted-asset guard just above. A project with zero
    // overlays hits neither branch and assembles exactly as it did before
    // tonight.
    const allOverlays = (await q(`SELECT * FROM studio.overlays WHERE project_id=$1 ORDER BY start_s, order_index`, [p.id])).rows;
    const unapprovedOverlays = allOverlays.filter(o => !o.approved_at);
    if (unapprovedOverlays.length) {
      return reply.code(422).send(err(422, 'GUARD_FAILED',
        `every overlay needs to be approved before assembly; unapproved: ${unapprovedOverlays.map(o => `${o.kind} ${o.id} (${o.start_s}s-${o.end_s}s)`).join(', ')}`));
    }
    const approvedOverlays = allOverlays;

    const settingsBase = { shot_count: shots.length, transition,
      ...(transition === 'crossfade' ? { transition_duration_s: transitionDurationS } : {}),
      ...(musicAsset ? { music_asset_id: musicAsset.id } : {}),
      ...(approvedOverlays.length ? { overlay_count: approvedOverlays.length, overlay_ids: approvedOverlays.map(o => o.id) } : {}) };
    const generatorTool = transition === 'crossfade' ? 'ffmpeg-xfade' : 'ffmpeg-concat';

    if (MOCK()) {
      // MOCK mode has no real media to process: it cannot actually verify
      // adjacent clips share resolution/frame rate, and it does not
      // produce a real crossfaded or music-mixed file -- it only records
      // the options that were requested, the same honesty pattern
      // technicalQc/continuityQc's MOCK branches already use above.
      const optionsNote = `transition=${transition}${transition === 'crossfade' ? `(${transitionDurationS}s)` : ''} music=${musicAsset ? musicAsset.id : 'none'} overlays=${approvedOverlays.length}`;
      const finalKey = `studio/${p.code}/final/assembled.mp4`;
      await storage.put(finalKey, Buffer.from(
        `MOCK-ASSEMBLE ${p.code} shots=${shots.map(s => s.shot_code).join(',')} ${optionsNote}`));
      const finalAsset = await one(
        `INSERT INTO studio.assets (project_id, kind, status, storage_key, generator, settings)
         VALUES ($1,'FINAL_CUT','GENERATED',$2,$3,$4) RETURNING *`,
        [p.id, finalKey, JSON.stringify({ tool: generatorTool, mock: true }), JSON.stringify(settingsBase)]);
      await q(`UPDATE studio.projects SET final_asset_id=$2, state='ROUGH_CUT_VALIDATED', updated_at=now() WHERE id=$1`,
        [p.id, finalAsset.id]);
      return finalAsset;
    }

    const workDir = storage.localPath(`studio/${p.code}/final`);
    await mkdir(workDir, { recursive: true });
    // Only resolved once, and only when a music layer was actually
    // requested, since it needs its own studio.assets query.
    const hasVoice = musicAsset
      ? (await one(`SELECT 1 AS x FROM studio.assets WHERE project_id=$1 AND kind='VOICE' AND shot_id = ANY($2) LIMIT 1`,
          [p.id, shots.map(s => s.id)])) != null
      : false;

    let outPath;
    if (transition === 'cut') {
      // UNCHANGED from before tonight's crossfade/music work when no music
      // is requested: byte-for-byte the same ffmpeg invocation, because
      // studio.test.mjs's assembly tests exercise exactly this path and
      // must keep passing unmodified.
      const listPath = join(workDir, 'concat-list.txt');
      const listContent = assets.map(a => `file '${storage.localPath(a.storage_key)}'`).join('\n');
      await writeFile(listPath, listContent, 'utf8');
      outPath = join(workDir, 'assembled.mp4');
      try {
        await execFileP('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath]);
      } catch (e) {
        return reply.code(502).send(err(502, 'ASSEMBLY_FAILED',
          `ffmpeg concat failed, most likely because the accepted clips do not share codec/resolution/frame rate: ${e.message}`));
      }
    } else {
      // Crossfade path: requires re-encoding through an xfade filter graph
      // (you cannot -c copy through a filter graph), and every adjacent
      // pair of accepted clips must share resolution and frame rate or the
      // blend will desync or ffmpeg will simply refuse -- so probe every
      // clip FIRST and refuse clearly, naming the exact pair and what
      // differs, before spending an ffmpeg call on a doomed job. Same
      // "name the exact problem" principle as the missing-accepted-asset
      // guard above.
      const clipPaths = assets.map(a => storage.localPath(a.storage_key));
      let probes;
      try {
        probes = await Promise.all(clipPaths.map(cp => probeClip(cp)));
      } catch (e) {
        return reply.code(502).send(err(502, 'ASSEMBLY_FAILED', `ffprobe failed while checking clips for crossfade compatibility: ${e.message}`));
      }
      for (let i = 0; i < probes.length - 1; i++) {
        const mismatch = describeClipMismatch(probes[i], probes[i + 1], shots[i].shot_code, shots[i + 1].shot_code);
        if (mismatch) {
          return reply.code(422).send(err(422, 'GUARD_FAILED',
            `crossfade requires adjacent clips to share resolution and frame rate; ${mismatch}`));
        }
      }
      outPath = join(workDir, 'assembled.mp4');
      if (probes.length === 1) {
        // Nothing to crossfade against -- fall back to a straight copy of
        // the one clip, same as the cut path produces for a one-shot
        // project.
        try {
          await execFileP('ffmpeg', ['-y', '-i', clipPaths[0], '-c', 'copy', outPath]);
        } catch (e) {
          return reply.code(502).send(err(502, 'ASSEMBLY_FAILED', `ffmpeg failed on the single-clip case: ${e.message}`));
        }
      } else {
        const durations = probes.map(pr => pr.durationS);
        const allHaveAudio = probes.every(pr => pr.hasAudio);
        const videoGraph = buildCrossfadeVideoGraph(durations, transitionDurationS);
        const filters = [videoGraph.filterComplex];
        const outputMaps = ['-map', videoGraph.outputLabel];
        if (allHaveAudio) {
          const audioGraph = buildCrossfadeAudioGraph(probes.length, transitionDurationS);
          filters.push(audioGraph.filterComplex);
          outputMaps.push('-map', audioGraph.outputLabel);
        }
        // Shot clips without audio (most Kling/Veo b-roll) simply carry no
        // audio into the crossfaded output; that is correct, not a bug --
        // see the file header on why a per-shot audio EDL is out of scope.
        const inputArgs = clipPaths.flatMap(cp => ['-i', cp]);
        try {
          await execFileP('ffmpeg', ['-y', ...inputArgs, '-filter_complex', filters.join(';'),
            ...outputMaps, '-c:v', 'libx264', ...(allHaveAudio ? ['-c:a', 'aac'] : []), outPath]);
        } catch (e) {
          return reply.code(502).send(err(502, 'ASSEMBLY_FAILED', `ffmpeg xfade crossfade failed: ${e.message}`));
        }
      }
    }

    let finalLocalPath = outPath;
    if (musicAsset) {
      // Second pass, deliberately kept separate from whichever ffmpeg call
      // produced outPath above, so the no-music invocations above stay
      // exactly what they were before this feature existed.
      finalLocalPath = await mixMusicOntoVideo({ workDir, videoPath: outPath, musicAsset, hasVoice });
    }

    if (approvedOverlays.length) {
      // Overlay burn-in: a THIRD pass, deliberately last (after crossfade/
      // concat and music mixing), so overlays always composite onto the
      // fully-assembled cut rather than a partial one, and so a project
      // with zero overlays never touches this code path at all -- the
      // no-overlay invocations above stay exactly what they were before
      // tonight's overlay work, same discipline the music pass already
      // established for itself.
      const probeForOverlay = await probeClip(finalLocalPath);
      const canvasSize = (probeForOverlay.width && probeForOverlay.height)
        ? { width: probeForOverlay.width, height: probeForOverlay.height }
        : resolveCanvasSizeForAspect(p.aspect_ratio);
      const fonts = await loadEthiopicFontsBase64();
      const graph = buildOverlayFilterGraph(approvedOverlays, probeForOverlay.durationS, canvasSize.width, canvasSize.height);
      if (graph.layers.length) {
        const overlayById = new Map(approvedOverlays.map(o => [o.id, o]));
        const inputArgs = [];
        for (let i = 0; i < graph.layers.length; i++) {
          const layer = graph.layers[i];
          const overlay = overlayById.get(layer.overlayId);
          let iconBase64;
          if (overlay.kind === 'ICON') {
            const iconAsset = await one(`SELECT storage_key FROM lcos.assets WHERE id=$1`, [overlay.data?.asset_id]);
            if (iconAsset) iconBase64 = (await readFile(storage.localPath(iconAsset.storage_key))).toString('base64');
          }
          const svg = compileOverlayLayerSvg(layer, overlay, canvasSize.width, canvasSize.height, fonts.bold, fonts.regular, iconBase64);
          const svgPath = join(workDir, `overlay-${i}.svg`);
          await writeFile(svgPath, svg, 'utf8');
          inputArgs.push('-itsoffset', layer.startS.toFixed(3), '-loop', '1',
            '-t', Math.max(0.04, layer.endS - layer.startS).toFixed(3), '-i', svgPath);
        }
        const overlaidPath = join(workDir, 'assembled-with-overlays.mp4');
        try {
          await execFileP('ffmpeg', ['-y', '-i', finalLocalPath, ...inputArgs,
            '-filter_complex', graph.filterComplex, '-map', graph.outputLabel, '-map', '0:a?',
            '-c:v', 'libx264', '-c:a', 'copy', overlaidPath]);
        } catch (e) {
          return reply.code(502).send(err(502, 'ASSEMBLY_FAILED', `ffmpeg overlay burn-in failed: ${e.message}`));
        }
        finalLocalPath = overlaidPath;
      }
    }

    const finalKey = `studio/${p.code}/final/assembled.mp4`;
    await storage.put(finalKey, await readFile(finalLocalPath));
    const finalAsset = await one(
      `INSERT INTO studio.assets (project_id, kind, status, storage_key, generator, settings)
       VALUES ($1,'FINAL_CUT','GENERATED',$2,$3,$4) RETURNING *`,
      [p.id, finalKey, JSON.stringify({ tool: generatorTool }), JSON.stringify(settingsBase)]);
    await q(`UPDATE studio.projects SET final_asset_id=$2, state='ROUGH_CUT_VALIDATED', updated_at=now() WHERE id=$1`,
      [p.id, finalAsset.id]);
    await q(`INSERT INTO studio.events (project_id, actor_id, artifact, note) VALUES ($1,$2,$3,$4)`,
      [p.id, req.actor?.id ?? null, finalAsset.id,
       `assembled ${shots.length} shots into final cut (transition=${transition}${musicAsset ? `, music=${musicAsset.id}` : ''}${approvedOverlays.length ? `, overlays=${approvedOverlays.length}` : ''})`]);
    return finalAsset;
  });
}
