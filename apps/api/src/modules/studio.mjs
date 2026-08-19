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
  SUNO_MUSIC_TRACK: 0.20,        // Suno music bed, flat per generated track
  AZURE_TTS_PER_CHAR: 0.000016,  // Azure neural TTS, per character of input text
};

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
  // Locks (playbook section 10)
  // -------------------------------------------------------------------
  app.get('/studio/projects/:id/locks', { preHandler: requirePerm('studio.read') }, async (req) => {
    const r = await q(`SELECT * FROM studio.locks WHERE project_id=$1 AND is_active ORDER BY entity_type, entity_code`,
      [req.params.id]);
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
    await spendBudget(project.id, resolveSpendAmount(gen, estimatedCost));
    return { ...asset, ...(budget.warning ? { budget_warning: budget.warning } : {}) };
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

    const settingsBase = { shot_count: shots.length, transition,
      ...(transition === 'crossfade' ? { transition_duration_s: transitionDurationS } : {}),
      ...(musicAsset ? { music_asset_id: musicAsset.id } : {}) };
    const generatorTool = transition === 'crossfade' ? 'ffmpeg-xfade' : 'ffmpeg-concat';

    if (MOCK()) {
      // MOCK mode has no real media to process: it cannot actually verify
      // adjacent clips share resolution/frame rate, and it does not
      // produce a real crossfaded or music-mixed file -- it only records
      // the options that were requested, the same honesty pattern
      // technicalQc/continuityQc's MOCK branches already use above.
      const optionsNote = `transition=${transition}${transition === 'crossfade' ? `(${transitionDurationS}s)` : ''} music=${musicAsset ? musicAsset.id : 'none'}`;
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
       `assembled ${shots.length} shots into final cut (transition=${transition}${musicAsset ? `, music=${musicAsset.id}` : ''})`]);
    return finalAsset;
  });
}
