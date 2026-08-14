// Part 2 (guided flow) tests, 14 Aug 2026: the production plan and its
// honest costs before spend, the daily-cap polite refusal, the aua_recap
// transcript confirmation gate, steerable single-piece regeneration with
// the conservative medical reset, the browsable asset library with the
// authenticated media route, plan choices on a job (engine slot, subtitle
// preset, voice, library bindings), and role-scoped gate visibility.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.LCOS_AI_PROVIDER = 'MOCK';
process.env.LCOS_ADAPTER_MODE = 'MOCK';
process.env.LCOS_STORAGE_DIR = '/tmp/lcos-test-storage';

const { buildServer } = await import('../src/server.mjs');
const { pool, q, one } = await import('../src/core.mjs');
const { parsePastedTranscript } = await import('../src/modules/transcripts.mjs');
const { SUBTITLE_PRESETS } = await import('../src/modules/production.mjs');

let app, tokens = {};
const login = async (email) => (await app.inject({ method: 'POST', url: '/api/v1/auth/login',
  payload: { email, password: 'letena-dev-2026' } })).json().token;
const call = (method, url, token, payload) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });

let cardId;
before(async () => {
  app = await buildServer();
  for (const r of ['admin', 'content', 'doctor', 'producer', 'language', 'dev']) {
    tokens[r] = await login(`${r}@letena.local`);
  }
  cardId = (await one(`SELECT id FROM lcos.knowledge_cards WHERE code='EC-004'`)).id;
});
after(async () => { await app.close(); await pool.end(); });

const genOne = async (format, extra = {}) => {
  const res = await call('POST', '/api/v1/content/generate', tokens.admin,
    { card_id: cardId, formats: [format], languages: ['EN'], ...extra });
  assert.equal(res.statusCode, 202, res.body);
  const scriptId = res.json().scripts[0].script_id ?? res.json().scripts[0].id;
  return one(`SELECT * FROM lcos.scripts WHERE id=$1`, [scriptId]);
};

// ---------------------------------------------------------------------
// Transcripts (step 6b)
// ---------------------------------------------------------------------

test('pasted transcripts parse timecodes and keep untimed lines rather than dropping them', () => {
  const segs = parsePastedTranscript(
    '[00:05] Postpill works within 72 hours.\n02:10 Second point here.\nAn untimed doctor sentence.');
  assert.equal(segs.length, 3);
  assert.equal(segs[0].start_s, 5);
  assert.equal(segs[1].start_s, 130);
  assert.equal(segs[2].start_s, null);
  assert.ok(segs[2].text.includes('untimed'));
});

test('aua_recap refuses to generate without a CONFIRMED transcript, and runs with one', async () => {
  const refused = await call('POST', '/api/v1/content/generate', tokens.admin,
    { card_id: cardId, formats: ['aua_recap'], languages: ['EN'] });
  assert.equal(refused.statusCode, 422);
  assert.equal(refused.json().guard, 'transcriptRequired');

  const created = await call('POST', '/api/v1/content/transcripts', tokens.content,
    { title: 'AUA live 14 Aug', transcript_text: '[00:12] Postpill can prevent pregnancy within 72 hours.' });
  assert.equal(created.statusCode, 201, created.body);
  const t = created.json();
  // Never presented as ground truth.
  assert.ok(t.warning.includes('confirms'));

  const draftRefused = await call('POST', '/api/v1/content/generate', tokens.admin,
    { card_id: cardId, formats: ['aua_recap'], languages: ['EN'], transcript_id: t.id });
  assert.equal(draftRefused.statusCode, 422);
  assert.equal(draftRefused.json().guard, 'transcriptConfirmed');

  const confirmed = await call('POST', `/api/v1/content/transcripts/${t.id}/confirm`, tokens.content);
  assert.equal(confirmed.statusCode, 200);
  const ok = await call('POST', '/api/v1/content/generate', tokens.admin,
    { card_id: cardId, formats: ['aua_recap'], languages: ['EN'], transcript_id: t.id });
  assert.equal(ok.statusCode, 202, ok.body);
  const scriptId = ok.json().scripts[0].script_id ?? ok.json().scripts[0].id;
  const concept = await one(
    `SELECT cc.transcript_id FROM lcos.scripts s JOIN lcos.content_concepts cc ON cc.id=s.concept_id
     WHERE s.id=$1`, [scriptId]);
  assert.equal(concept.transcript_id, t.id, 'the recap remembers which transcript it came from');
});

test('a video upload records that its audio was stripped; machine transcription is marked', async () => {
  const created = await call('POST', '/api/v1/content/transcripts', tokens.content,
    { title: 'video upload', media_base64: Buffer.from('fake-video').toString('base64'),
      media_mime_type: 'video/mp4' });
  assert.equal(created.statusCode, 201, created.body);
  const t = created.json();
  assert.equal(t.source, 'VIDEO_UPLOAD_AUDIO_STRIPPED');
  assert.ok(t.note.includes('stripped'));
  assert.equal(t.machine_transcribed, true);
  assert.ok(t.warning.includes('machine transcription'));
});

test('editing a CONFIRMED transcript returns it to DRAFT', async () => {
  const created = await call('POST', '/api/v1/content/transcripts', tokens.content,
    { title: 'edit-after-confirm', transcript_text: '[00:01] Original line.' });
  const id = created.json().id;
  await call('POST', `/api/v1/content/transcripts/${id}/confirm`, tokens.content);
  const edited = await call('PUT', `/api/v1/content/transcripts/${id}`, tokens.content,
    { segments: [{ start_s: 1, end_s: 9, speaker: 'doctor', text: 'Corrected line.' }] });
  assert.equal(edited.statusCode, 200);
  assert.equal(edited.json().status, 'DRAFT');
  assert.equal(edited.json().reconfirm_needed, true);
});

// ---------------------------------------------------------------------
// The production plan: the truth before the spend (step 6)
// ---------------------------------------------------------------------

test('the plan shows metered steps with costs and self-hosted steps as included, never a fake price', async () => {
  const s = await genOne('send_it');
  const r = await call('GET', `/api/v1/production/plan/${s.id}`, tokens.producer);
  assert.equal(r.statusCode, 200, r.body);
  const plan = r.json();
  assert.equal(plan.body_kind, 'VIDEO');
  const assembly = plan.steps.find(st => st.step === 'assembly');
  const subtitles = plan.steps.find(st => st.step === 'subtitles');
  assert.ok(assembly.included && assembly.est_cost_usd === 0, 'FFmpeg assembly is included, not priced');
  assert.ok(subtitles.included && subtitles.est_cost_usd === 0);
  assert.ok(assembly.engine.includes('own server'));
  // The engine slot: default from settings, both options named, neither
  // presented as better before the first real test.
  assert.equal(plan.video_engine.default, 'KLING');
  assert.deepEqual(plan.video_engine.options, ['KLING', 'VEO']);
  assert.ok(plan.video_engine.note.includes('Neither is proven'));
  // Subtitle presets with the format's own default.
  assert.equal(plan.subtitle.default, 'WORD_HIGHLIGHT');
  assert.equal(plan.subtitle.presets.length, SUBTITLE_PRESETS.length);
  // The human voice is first class, never a downgrade.
  const human = plan.voice.options.find(o => o.code === 'HUMAN');
  assert.ok(human.note.includes('First class'));
  // Spend visibility rides along.
  assert.ok(plan.spend_today.render.cap_usd > 0);
});

test('a carousel plan is entirely included: rendered from an HTML template on our own server', async () => {
  const s = await genOne('save_it');
  const plan = (await call('GET', `/api/v1/production/plan/${s.id}`, tokens.producer)).json();
  assert.equal(plan.total_est_usd, 0);
  assert.ok(plan.steps.every(st => st.included));
  assert.ok(plan.cost_note.includes('nothing'));
});

test('plan choices persist on the job; inactive assets and unapproved medical illustrations refuse to bind', async () => {
  const s = await genOne('send_it');
  await call('POST', '/api/v1/reviews/batch-approve', tokens.admin, { script_ids: [s.id] });
  const job = (await call('POST', '/api/v1/production/jobs', tokens.producer, { script_id: s.id })).json();
  const saved = await call('POST', `/api/v1/production/jobs/${job.id}/plan`, tokens.producer,
    { video_engine: 'VEO', subtitle_preset: 'BOXED', voice_source: 'HUMAN' });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().video_engine, 'VEO');
  assert.ok(saved.json().summary.includes('live human recording'));
  const row = await one(`SELECT * FROM lcos.production_jobs WHERE id=$1`, [job.id]);
  assert.equal(row.video_engine, 'VEO');
  assert.equal(row.subtitle_preset, 'BOXED');
  assert.equal(row.voice_source, 'HUMAN');

  // An unapproved medical illustration cannot even EXIST active (DB check
  // constraint assets_medical_illustration_needs_approval), so the bind
  // guard a caller can actually hit is the inactive-asset refusal; the
  // medicalIllustrationApproved guard in the endpoint stays as belt and
  // braces should that constraint ever loosen.
  const med = await one(
    `INSERT INTO lcos.assets (code, kind, origin, title, storage_key, mime_type, clinically_approved, is_active)
     VALUES ('AST-P2MED', 'MEDICAL_ILLUSTRATION', 'SHOT_IN_HOUSE', 'unapproved anatomy',
             'assets/raw/p2med/a.png', 'image/png', false, false)
     ON CONFLICT (code) DO UPDATE SET clinically_approved=false, is_active=false RETURNING id`);
  const refused = await call('POST', `/api/v1/production/jobs/${job.id}/plan`, tokens.producer,
    { asset_bindings: [{ scene: 1, asset_id: med.id }] });
  assert.equal(refused.statusCode, 422);
  assert.equal(refused.json().guard, 'assetActive');
});

test('the daily render cap refuses politely at the door, before any money moves', async () => {
  const s = await genOne('send_it');
  await call('POST', '/api/v1/reviews/batch-approve', tokens.admin, { script_ids: [s.id] });
  const job = (await call('POST', '/api/v1/production/jobs', tokens.producer, { script_id: s.id })).json();
  const set = await call('PUT', '/api/v1/platform/settings', tokens.admin,
    { key: 'render.daily_spend_cap_usd', value: 0 });
  assert.equal(set.statusCode, 200, set.body);
  try {
    const run = await call('POST', `/api/v1/production/jobs/${job.id}/run`, tokens.producer);
    assert.equal(run.statusCode, 200, run.body);
    assert.equal(run.json().status, 'CAP_REACHED');
    assert.ok(run.json().reason.includes('stays queued'));
    const jrow = await one(`SELECT status FROM lcos.production_jobs WHERE id=$1`, [job.id]);
    assert.equal(jrow.status, 'QUEUED', 'the job loses nothing at the cap');
  } finally {
    await call('PUT', '/api/v1/platform/settings', tokens.admin,
      { key: 'render.daily_spend_cap_usd', value: 60 });
  }
});

test('spend-today reports both meters against their caps', async () => {
  const r = await call('GET', '/api/v1/production/spend-today', tokens.producer);
  assert.equal(r.statusCode, 200);
  const sp = r.json();
  assert.ok('spent_usd' in sp.ai && 'cap_usd' in sp.ai);
  assert.ok('spent_usd' in sp.render && 'cap_usd' in sp.render);
});

test('progress explains every job state in plain language with a next action', async () => {
  const r = await call('GET', '/api/v1/production/progress', tokens.producer);
  assert.equal(r.statusCode, 200);
  for (const j of r.json().items) {
    assert.ok(j.text?.length > 5, `job ${j.code} has no explanation`);
    assert.ok(typeof j.action === 'string');
  }
});

// ---------------------------------------------------------------------
// Regeneration (step 3): one piece, steerable, conservative reset
// ---------------------------------------------------------------------

test('regenerating one piece versions it, withdraws the medical sign-off, and revalidates', async () => {
  const s = await genOne('telegram_post');
  // Sign medical review first so the withdrawal is observable.
  await call('POST', '/api/v1/content/scripts/' + s.id + '/validate', tokens.admin, {});
  await call('POST', `/api/v1/pipeline/scripts/${s.id}/gates/medical_review`, tokens.doctor, {});
  const gatesBefore = await q(`SELECT gate FROM lcos.script_gates WHERE script_id=$1`, [s.id]);
  assert.ok(gatesBefore.rows.some(g => g.gate === 'medical_review'), 'fixture: gate must be signed');

  const r = await call('POST', `/api/v1/content/scripts/${s.id}/regenerate`, tokens.content,
    { direction: 'shorter, less clinical, warmer' });
  assert.equal(r.statusCode, 200, r.body);
  const out = r.json();
  assert.equal(out.version, 2);
  assert.equal(out.direction_used, 'shorter, less clinical, warmer');
  assert.ok(out.note.includes('medical review starts over'));
  const gatesAfter = await q(`SELECT gate FROM lcos.script_gates WHERE script_id=$1`, [s.id]);
  assert.ok(!gatesAfter.rows.some(g => g.gate === 'medical_review'),
    'the whole body was replaced; the sign-off no longer describes it');
  const row = await one(`SELECT * FROM lcos.scripts WHERE id=$1`, [s.id]);
  assert.equal(row.current_version, 2);
  // Validation reran as part of the regeneration.
  assert.notEqual(row.validation_result, 'NOT_RUN');
  const v2 = await one(`SELECT change_summary FROM lcos.script_versions WHERE script_id=$1 AND version=2`, [s.id]);
  assert.ok(v2.change_summary.includes('shorter'));
});

// ---------------------------------------------------------------------
// The asset library: browsable, filterable, previewable
// ---------------------------------------------------------------------

test('the library filters by kind and text, carries tags and mime for previews, and the new kinds exist', async () => {
  await q(`INSERT INTO lcos.assets (code, kind, origin, title, storage_key, mime_type, is_active)
           VALUES ('AST-P2BG', 'BACKGROUND', 'SHOT_IN_HOUSE', 'gradient dawn background', 'assets/raw/p2bg/bg.png', 'image/png', true)
           ON CONFLICT (code) DO NOTHING`);
  await q(`INSERT INTO lcos.assets (code, kind, origin, title, storage_key, mime_type, is_active)
           VALUES ('AST-P2CHAR', 'CHARACTER_REFERENCE', 'AI_GENERATED', 'Hiwot locked reference', 'assets/raw/p2char/ref.png', 'image/png', true)
           ON CONFLICT (code) DO NOTHING`);
  const bg = await call('GET', '/api/v1/production/assets?kind=BACKGROUND', tokens.producer);
  assert.ok(bg.json().items.some(a => a.code === 'AST-P2BG'));
  assert.ok(bg.json().items.every(a => a.kind === 'BACKGROUND'));
  const byName = await call('GET', '/api/v1/production/assets?text=Hiwot', tokens.producer);
  assert.ok(byName.json().items.some(a => a.code === 'AST-P2CHAR'),
    'locked character references are findable by name');
  const item = byName.json().items.find(a => a.code === 'AST-P2CHAR');
  assert.ok('mime_type' in item && 'storage_key' in item && Array.isArray(item.tags));
});

test('saving to the library is one call carrying title and tags; reclassifying into MEDICAL_ILLUSTRATION is refused', async () => {
  const gen = await call('POST', '/api/v1/production/assets/generate', tokens.producer,
    { brief: 'quiet compound wall at dusk, addis', kind: 'IMAGE_PHOTO' });
  assert.equal(gen.statusCode, 201, gen.body);
  const a = gen.json();
  assert.equal(a.is_active, false, 'generated assets stay inactive until reviewed');
  const refused = await call('POST', `/api/v1/production/assets/${a.id}/activate`, tokens.producer,
    { kind: 'MEDICAL_ILLUSTRATION' });
  assert.equal(refused.statusCode, 422);
  const saved = await call('POST', `/api/v1/production/assets/${a.id}/activate`, tokens.producer,
    { title: 'Compound wall, dusk', tags: ['setting:compound', 'time:dusk'], kind: 'BACKGROUND' });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().is_active, true);
  assert.equal(saved.json().kind, 'BACKGROUND');
  assert.ok(saved.json().message.includes('Saved to the library'));
  const tags = await q(`SELECT namespace, value FROM lcos.asset_tags WHERE asset_id=$1`, [a.id]);
  assert.ok(tags.rows.some(t => t.namespace === 'setting' && t.value === 'compound'));
});

test('the media route streams stored files with a token and refuses without one', async () => {
  const key = 'assets/raw/p2media/test.png';
  const { storage } = await import('../src/adapters/index.mjs');
  await storage.put(key, Buffer.from('png-bytes'));
  const no = await app.inject({ method: 'GET', url: `/api/v1/media/${key}` });
  assert.equal(no.statusCode, 401);
  const yes = await app.inject({ method: 'GET', url: `/api/v1/media/${key}?token=${tokens.producer}` });
  assert.equal(yes.statusCode, 200);
  assert.equal(yes.headers['content-type'], 'image/png');
  const traversal = await app.inject({ method: 'GET',
    url: `/api/v1/media/..%2F..%2Fetc%2Fpasswd?token=${tokens.producer}` });
  assert.equal(traversal.statusCode, 404);
});

// ---------------------------------------------------------------------
// Role-scoped gate visibility
// ---------------------------------------------------------------------

test('gate-signers shows each user only the gates their role signs; admin is the marked override', async () => {
  const doctor = (await call('GET', '/api/v1/pipeline/gate-signers', tokens.doctor)).json();
  assert.ok(doctor.mine.includes('medical_review'));
  assert.ok(!doctor.mine.includes('publish'));
  assert.equal(doctor.admin_override, false);
  const admin = (await call('GET', '/api/v1/pipeline/gate-signers', tokens.admin)).json();
  assert.equal(admin.admin_override, true);
  const producer = (await call('GET', '/api/v1/pipeline/gate-signers', tokens.producer)).json();
  assert.ok(producer.mine.includes('produce'));
  assert.ok(!producer.mine.includes('medical_review'));
});

// ---------------------------------------------------------------------
// The script detail carries what the flow stepper needs
// ---------------------------------------------------------------------

test('script detail returns signed gates and format info so the sequence is visible on screen', async () => {
  const s = await genOne('send_it');
  const r = await call('GET', `/api/v1/content/scripts/${s.id}`, tokens.content);
  assert.equal(r.statusCode, 200);
  const d = r.json();
  assert.ok(Array.isArray(d.gates));
  assert.equal(d.format_info.code, 'send_it');
  assert.equal(d.format_info.body_kind, 'VIDEO');
  assert.ok(Array.isArray(d.format_info.stages_applicable));
});
