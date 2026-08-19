// Video Studio: approved-script-to-project bridge (19 Aug 2026). POST
// /studio/projects/from-script/draft and /apply are the sibling of the
// brief-import feature (studio_brief_import.test.mjs) for the OTHER on-ramp
// into Video Studio -- a structured, already-approved lcos.scripts row
// instead of a pasted free-text brief. MOCK mode uses a deterministic
// reshape (provider.mjs's agent_studio_script_importer), not a real model,
// so these prove the wiring, the shot-count rule, the reuse-candidate
// search, and the apply-time row creation, not real draft quality.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.LCOS_AI_PROVIDER = 'MOCK';
process.env.LCOS_ADAPTER_MODE = 'MOCK';
process.env.LCOS_STORAGE_DIR = '/tmp/lcos-test-storage';

const { buildServer } = await import('../src/server.mjs');
const { pool, q, one } = await import('../src/core.mjs');

let app, token;
const login = async (email) => (await app.inject({ method: 'POST', url: '/api/v1/auth/login',
  payload: { email, password: 'letena-dev-2026' } })).json().token;
const call = (method, url, payload) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` }, payload });

let adminId, cardVersionId, segmentId;

before(async () => {
  app = await buildServer();
  token = await login('producer@letena.local');
  const admin = await one(`SELECT id FROM lcos.users WHERE email='admin@letena.local'`);
  adminId = admin.id;
  const card = await one(`SELECT id FROM lcos.knowledge_cards WHERE code='EC-001'`);
  const cv = await one(
    `INSERT INTO lcos.knowledge_card_versions (card_id, version, canonical_answer_en, content_sha256, created_by)
     VALUES ($1, 998, 'Test answer body for script import.', 'testsha-scriptimport', $2)
     ON CONFLICT (card_id, version) DO UPDATE SET canonical_answer_en=EXCLUDED.canonical_answer_en
     RETURNING id`, [card.id, adminId]);
  cardVersionId = cv.id;
  const seg = await one(`SELECT id FROM lcos.audience_segments LIMIT 1`);
  segmentId = seg.id;
});
after(async () => { await app.close(); await pool.end(); });

// Builds a fresh, APPROVED, VIDEO-kind (or any given format_code) script
// with a script_versions row shaped exactly as production would leave it,
// bypassing the full generate/validate/approve pipeline (same shortcut
// formats_registry.test.mjs and modules5.test.mjs already take) so each
// test controls scene_plan/onscreen_text/characters precisely. EN language
// avoids the scripts_localized_has_parent constraint's parent_script_id
// requirement for non-EN, non-DRAFT rows.
async function makeApprovedScript({
  formatCode = 'send_it', videoFamily = 'V01_QUESTION_EXPLAINER',
  scenePlan = [], onscreenText = [], hook = 'Test hook', spokenScript = 'Test spoken script content.',
  cta = 'Message Letena.', caption = null, characters = [], estimatedDurationS = 25,
} = {}) {
  const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
  const fam = await one(
    `INSERT INTO lcos.content_families (code, title, knowledge_card_id, knowledge_card_version_id,
       primary_segment_id, risk_tier, created_by)
     VALUES ($1, 'Script import test family', (SELECT card_id FROM lcos.knowledge_card_versions WHERE id=$2),
       $2, $3, 'TIER_2', $4) RETURNING id`,
    [`CF-SI-${suffix}`, cardVersionId, segmentId, adminId]);
  const con = await one(
    `INSERT INTO lcos.content_concepts (code, family_id, video_family, title, hook_line, premise, treatment,
       characters, format_code)
     VALUES ($1, $2, $3, 'Script import test concept', 'Hook', 'Premise', 'Treatment', $4, $5) RETURNING *`,
    [`CC-SI-${suffix}`, fam.id, videoFamily, JSON.stringify(characters), formatCode]);
  const script = await one(
    `INSERT INTO lcos.scripts (code, concept_id, family_id, knowledge_card_version_id, language, risk_tier,
       created_by, status, validation_result, approved_by, approved_at, approved_version, current_version)
     VALUES ($1,$2,$3,$4,'EN','TIER_2',$5,'APPROVED','PASS',$5,now(),1,1) RETURNING *`,
    [`SC-SI-${suffix}`, con.id, fam.id, cardVersionId, adminId]);
  await q(
    `INSERT INTO lcos.script_versions (script_id, version, hook, spoken_script, onscreen_text, scene_plan,
       cta, caption, estimated_duration_s, content_sha256)
     VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [script.id, hook, spokenScript, JSON.stringify(onscreenText), JSON.stringify(scenePlan),
     cta, caption, estimatedDurationS, `sha-${suffix}`]);
  return { script, concept: con };
}

const ONE_SCENE = [
  { index: 1, start_s: 0, end_s: 25, visual_brief: 'One continuous presenter take',
    asset_requirement: { kind: 'VIDEO', tags: ['presenter'] } },
];
const THREE_SCENES = [
  { index: 1, start_s: 0, end_s: 5, visual_brief: 'Hook typography over calm b-roll',
    asset_requirement: { kind: 'VIDEO', tags: ['addis', 'evening'], must_be_ethiopian: true } },
  { index: 2, start_s: 5, end_s: 20, visual_brief: 'Answer cards over gradient',
    asset_requirement: { kind: 'TYPOGRAPHY_ONLY', tags: [] } },
  { index: 3, start_s: 20, end_s: 25, visual_brief: 'CTA end card',
    asset_requirement: { kind: 'TYPOGRAPHY_ONLY', tags: [] } },
];
const ONSCREEN = [
  { at_second: 0, text: 'Seeing spotting?', role: 'HOOK', emphasis: 'STRONG' },
  { at_second: 20, text: 'Message us on Telegram', role: 'DOOR' },
];

test('draft refuses a script that is not APPROVED', async () => {
  const { script } = await makeApprovedScript();
  await q(`UPDATE lcos.scripts SET status='DRAFT', validation_result='NOT_RUN', approved_by=NULL,
             approved_at=NULL, approved_version=NULL WHERE id=$1`, [script.id]);
  const r = await call('POST', '/studio/projects/from-script/draft', { script_id: script.id });
  assert.equal(r.statusCode, 422, r.body);
  assert.equal(r.json().guard, 'scriptApproved');
});

test('draft refuses a non-VIDEO body_kind script with a guard pointing at the regular pipeline', async () => {
  const { script } = await makeApprovedScript({ formatCode: 'save_it', videoFamily: 'C01_CAROUSEL' });
  const r = await call('POST', '/studio/projects/from-script/draft', { script_id: script.id });
  assert.equal(r.statusCode, 422, r.body);
  assert.equal(r.json().guard, 'scriptIsVideoKind');
  assert.match(r.json().detail ?? r.json().message ?? JSON.stringify(r.json()), /CAROUSEL/);
});

test('draft returns one shot spanning the whole runtime when scene_plan has a single entry', async () => {
  const { script } = await makeApprovedScript({ scenePlan: ONE_SCENE, onscreenText: ONSCREEN });
  const r = await call('POST', '/studio/projects/from-script/draft', { script_id: script.id });
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.equal(body.draft.shots.length, 1, 'a single scene_plan entry should draft exactly one shot');
  assert.equal(body.draft.shots[0].duration_target_s, 25);
});

test('draft returns one shot with no scene_plan at all', async () => {
  const { script } = await makeApprovedScript({ scenePlan: [], onscreenText: [] });
  const r = await call('POST', '/studio/projects/from-script/draft', { script_id: script.id });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().draft.shots.length, 1, 'an empty scene_plan should still draft exactly one shot');
});

test('draft returns one shot per distinct scene when scene_plan has multiple entries', async () => {
  const { script } = await makeApprovedScript({ scenePlan: THREE_SCENES, onscreenText: ONSCREEN });
  const r = await call('POST', '/studio/projects/from-script/draft', { script_id: script.id });
  assert.equal(r.statusCode, 200, r.body);
  const shots = r.json().draft.shots;
  assert.equal(shots.length, 3, 'three distinct scene_plan entries should draft three shots');
  assert.deepEqual(shots.map(s => s.order_index), [0, 1, 2]);
  assert.equal(shots[0].story.beat, 'Hook typography over calm b-roll');
  assert.equal(shots[2].story.beat, 'CTA end card');
});

test('draft never saves anything: no project, shot or overlay exists after a draft call', async () => {
  const { script } = await makeApprovedScript({ scenePlan: THREE_SCENES, onscreenText: ONSCREEN });
  await call('POST', '/studio/projects/from-script/draft', { script_id: script.id });
  const proj = await q(`SELECT id FROM studio.projects WHERE source_script_id=$1`, [script.id]);
  assert.equal(proj.rows.length, 0, 'drafting must never create a project row by itself');
});

test('draft surfaces a reuse candidate for an entity_code with an existing active, approved lock', async () => {
  // A lock for "Selam <suffix>" already exists, approved, in some unrelated
  // project A. The name carries a per-run suffix so this test's own
  // entity_code can never collide with a lock any earlier test run left in
  // this (real, persistent-between-runs) database -- reuse candidates are
  // found by a GLOBAL search with no project or test-run scoping, by design.
  const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
  const entityCode = `SELAM_${suffix}`;
  const projA = (await call('POST', '/studio/projects', { title: 'Project A', format: 'ai_story' })).json();
  const lockRes = await call('POST', `/studio/projects/${projA.id}/locks`,
    { entity_code: entityCode, level: 'L1_ENTITY', entity_type: 'CHARACTER', data: { name: `Selam ${suffix}` } });
  const lock = lockRes.json();
  const approveRes = await call('POST', `/studio/locks/${lock.id}/approve`);
  assert.equal(approveRes.statusCode, 200, approveRes.body);

  // A different script names a fictional character "Selam <suffix>" -> the
  // mock derives the same entity_code (mockScriptEntityCode: uppercase,
  // spaces to underscores) from the concept's own characters field.
  const { script } = await makeApprovedScript({
    scenePlan: ONE_SCENE, onscreenText: ONSCREEN,
    characters: [{ name: `Selam ${suffix}`, age: 24, context: 'a fictional peer', is_fictional: true }],
  });
  const r = await call('POST', '/studio/projects/from-script/draft', { script_id: script.id });
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.ok(body.draft.entity_codes_needed.includes(entityCode), JSON.stringify(body.draft.entity_codes_needed));
  const found = body.reuse_candidates.find(c => c.entity_code === entityCode);
  assert.ok(found, `expected a reuse_candidates entry for ${entityCode}`);
  assert.ok(found.candidate, `expected a candidate to be found for the approved ${entityCode} lock`);
  assert.equal(found.candidate.source_lock_id, lock.id);
  assert.equal(found.candidate.project_code, projA.code);
});

test('draft on a script that already has a linked project returns existing_project, not a fresh draft', async () => {
  const { script } = await makeApprovedScript({ scenePlan: ONE_SCENE, onscreenText: ONSCREEN });
  const first = await call('POST', '/studio/projects/from-script/draft', { script_id: script.id });
  const applied = await call('POST', '/studio/projects/from-script/apply',
    { script_id: script.id, draft: first.json().draft });
  assert.equal(applied.statusCode, 200, applied.body);

  const second = await call('POST', '/studio/projects/from-script/draft', { script_id: script.id });
  assert.equal(second.statusCode, 200, second.body);
  assert.ok(second.json().existing_project, 'expected existing_project on a re-draft');
  assert.equal(second.json().existing_project.id, applied.json().project.id);

  const projects = await q(`SELECT id FROM studio.projects WHERE source_script_id=$1`, [script.id]);
  assert.equal(projects.rows.length, 1, 'exactly one project must exist for this script, never two');
});

test('apply requires draft.shots to be a non-empty array', async () => {
  const { script } = await makeApprovedScript({ scenePlan: ONE_SCENE });
  const r = await call('POST', '/studio/projects/from-script/apply', { script_id: script.id, draft: { shots: [] } });
  assert.equal(r.statusCode, 422, r.body);
  assert.equal(r.json().code, 'VALIDATION');
});

test('apply creates the project (with source_script_id set), every shot, and every valid overlay', async () => {
  const { script } = await makeApprovedScript({
    scenePlan: THREE_SCENES, onscreenText: ONSCREEN, caption: 'AM: caption text',
  });
  const draftRes = await call('POST', '/studio/projects/from-script/draft', { script_id: script.id });
  const draft = draftRes.json().draft;

  const applyRes = await call('POST', '/studio/projects/from-script/apply', { script_id: script.id, draft });
  assert.equal(applyRes.statusCode, 200, applyRes.body);
  const applied = applyRes.json();

  assert.equal(applied.project.source_script_id, script.id);
  assert.equal(applied.shots_created.length, 3);
  assert.deepEqual(applied.shots_created.map(s => s.order_index), [0, 1, 2]);
  assert.equal(applied.overlays_created.length, draft.overlays.length,
    'both onscreen_text-derived overlays (TITLE_CARD, DOOR_CARD) should validate and be created');
  assert.equal(applied.overlays_skipped.length, 0);
  assert.equal(applied.caption_draft, 'AM: caption text');

  const projectGet = await call('GET', `/studio/projects/${applied.project.id}`);
  assert.equal(projectGet.json().shots.length, 3);
  const overlaysGet = await call('GET', `/studio/projects/${applied.project.id}/overlays`);
  assert.equal(overlaysGet.json().items.length, draft.overlays.length);
});

test('apply skips an overlay with invalid data and reports a specific reason, without crashing', async () => {
  const { script } = await makeApprovedScript({ scenePlan: ONE_SCENE, onscreenText: ONSCREEN });
  const draftRes = await call('POST', '/studio/projects/from-script/draft', { script_id: script.id });
  const draft = draftRes.json().draft;
  // Corrupt the TITLE_CARD overlay's text so validateOverlayData rejects it.
  const titleCard = draft.overlays.find(o => o.kind === 'TITLE_CARD');
  titleCard.data.text = '';

  const applyRes = await call('POST', '/studio/projects/from-script/apply', { script_id: script.id, draft });
  assert.equal(applyRes.statusCode, 200, applyRes.body);
  const applied = applyRes.json();
  assert.equal(applied.overlays_skipped.length, 1);
  assert.equal(applied.overlays_skipped[0].kind, 'TITLE_CARD');
  assert.match(applied.overlays_skipped[0].reason, /data\.text is required/);
  assert.equal(applied.overlays_created.length, draft.overlays.length - 1);
});

test('apply refuses a second project for the same script', async () => {
  const { script } = await makeApprovedScript({ scenePlan: ONE_SCENE, onscreenText: [] });
  const draft = (await call('POST', '/studio/projects/from-script/draft', { script_id: script.id })).json().draft;
  const first = await call('POST', '/studio/projects/from-script/apply', { script_id: script.id, draft });
  assert.equal(first.statusCode, 200, first.body);

  const second = await call('POST', '/studio/projects/from-script/apply', { script_id: script.id, draft });
  assert.equal(second.statusCode, 422, second.body);
  assert.equal(second.json().guard, 'oneProjectPerScript');
  const projects = await q(`SELECT id FROM studio.projects WHERE source_script_id=$1`, [script.id]);
  assert.equal(projects.rows.length, 1);
});

test('apply with a reuse_locks entry copies the lock without re-approval and without mutating the source', async () => {
  // Suffixed for the same reason as the reuse-candidate test above: reuse
  // search is global and this database persists across test runs.
  const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
  const entityCode = `DR_LETENA_${suffix}`;
  const projA = (await call('POST', '/studio/projects', { title: 'Project A2', format: 'ai_story' })).json();
  const lock = (await call('POST', `/studio/projects/${projA.id}/locks`,
    { entity_code: entityCode, level: 'L1_ENTITY', entity_type: 'CHARACTER',
      data: { name: `Dr Letena ${suffix}`, apparent_age: 'late 30s' } })).json();
  const approvedAt1 = (await call('POST', `/studio/locks/${lock.id}/approve`)).json();
  assert.equal(approvedAt1.ok, true);
  const sourceBefore = await one(`SELECT * FROM studio.locks WHERE id=$1`, [lock.id]);
  assert.ok(sourceBefore.approved_at);

  const { script } = await makeApprovedScript({
    scenePlan: ONE_SCENE, onscreenText: [],
    characters: [{ name: `Dr Letena ${suffix}`, age: 38, context: 'the presenter', is_fictional: true }],
  });
  const draftRes = await call('POST', '/studio/projects/from-script/draft', { script_id: script.id });
  const { draft, reuse_candidates } = draftRes.json();
  const candidate = reuse_candidates.find(c => c.entity_code === entityCode);
  assert.ok(candidate?.candidate, `expected a reuse candidate for ${entityCode}`);

  const applyRes = await call('POST', '/studio/projects/from-script/apply', {
    script_id: script.id, draft,
    reuse_locks: [{ entity_code: entityCode, source_lock_id: candidate.candidate.source_lock_id }],
  });
  assert.equal(applyRes.statusCode, 200, applyRes.body);
  const applied = applyRes.json();
  assert.equal(applied.locks_reused.length, 1);
  assert.equal(applied.locks_reused[0].entity_code, entityCode);
  assert.equal(applied.locks_reused[0].source_lock_id, lock.id);

  const newLock = await one(`SELECT * FROM studio.locks WHERE id=$1`, [applied.locks_reused[0].new_lock_id]);
  assert.equal(newLock.project_id, applied.project.id);
  assert.equal(newLock.entity_code, entityCode);
  assert.ok(newLock.approved_at, 'a reused lock should already be approved, not need re-approval');
  assert.equal(newLock.approved_by, sourceBefore.approved_by);
  assert.equal(newLock.data.name, `Dr Letena ${suffix}`);

  // The new project's shot should link the reused lock in locked_lock_ids.
  const projectGet = await call('GET', `/studio/projects/${applied.project.id}`);
  const shot = projectGet.json().shots[0];
  assert.ok(shot.locked_lock_ids.includes(newLock.id));

  // The SOURCE lock is untouched: same id, same data, still only in project A.
  const sourceAfter = await one(`SELECT * FROM studio.locks WHERE id=$1`, [lock.id]);
  assert.equal(sourceAfter.project_id, projA.id);
  assert.deepEqual(sourceAfter.data, sourceBefore.data);
  assert.equal(sourceAfter.approved_at.getTime?.() ?? sourceAfter.approved_at, sourceBefore.approved_at.getTime?.() ?? sourceBefore.approved_at);
});

test('apply refuses a reuse_locks entry that no longer resolves to an active, approved lock', async () => {
  const projA = (await call('POST', '/studio/projects', { title: 'Project A3', format: 'ai_story' })).json();
  const lock = (await call('POST', `/studio/projects/${projA.id}/locks`,
    { entity_code: 'UNAPPROVED_ONE', level: 'L1_ENTITY', entity_type: 'CHARACTER', data: {} })).json();
  // Deliberately never approved.

  const { script } = await makeApprovedScript({ scenePlan: ONE_SCENE, onscreenText: [] });
  const draft = (await call('POST', '/studio/projects/from-script/draft', { script_id: script.id })).json().draft;

  const r = await call('POST', '/studio/projects/from-script/apply', {
    script_id: script.id, draft,
    reuse_locks: [{ entity_code: 'UNAPPROVED_ONE', source_lock_id: lock.id }],
  });
  assert.equal(r.statusCode, 422, r.body);
  assert.equal(r.json().guard, 'lockReuseInvalid');
  const projects = await q(`SELECT id FROM studio.projects WHERE source_script_id=$1`, [script.id]);
  assert.equal(projects.rows.length, 0, 'a bad reuse_locks entry must not leave a half-built project behind');
});
