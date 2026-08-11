// FINAL ACCEPTANCE DEMONSTRATION — the full pilot workflow with demo data.
// Run:  npm run demo   (API must NOT be running; this drives the app in-process)
// Requires: migrated + demo-seeded database (npm run migrate && npm run seed:demo)
process.env.NODE_ENV = 'test';
process.env.LCOS_AI_PROVIDER = process.env.LCOS_AI_PROVIDER || 'MOCK';
process.env.LCOS_ADAPTER_MODE = process.env.LCOS_ADAPTER_MODE || 'MOCK';
process.env.LCOS_STORAGE_DIR = process.env.LCOS_STORAGE_DIR || '/tmp/lcos-demo-storage';

const { buildServer } = await import('../apps/api/src/server.mjs');
const { pool, one } = await import('../apps/api/src/core.mjs');

const app = await buildServer();
const say = (step, msg) => console.log(`\n\x1b[36m[${step}]\x1b[0m ${msg}`);
const login = async (email) => (await app.inject({ method: 'POST', url: '/api/v1/auth/login',
  payload: { email, password: 'letena-dev-2026' } })).json().token;
const call = async (method, url, token, payload) => {
  const r = await app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
  if (r.statusCode >= 400) throw new Error(`${method} ${url} -> ${r.statusCode}: ${r.body}`);
  return r.json();
};

const t = {};
for (const r of ['intake', 'doctor', 'producer', 'social', 'content', 'admin', 'language']) t[r] = await login(`${r}@letena.local`);

console.log('\n════ LETENA CONTENT OS — PILOT WORKFLOW DEMONSTRATION ════');

say('1 INGEST', 'A question arrives from Telegram (via the letena.et EMR exporter contract):');
const QUESTION = 'My name is Hana, call me on 0911234567. I took Postpill twice this month. Will I still be able to have children?';
console.log(`   "${QUESTION}"`);
const ingest = await call('POST', '/api/v1/ingest/questions', t.intake, {
  questions: [{ channel: 'TELEGRAM', source_hash: 'demo-' + Date.now(), text: QUESTION,
    language_hint: 'EN', category_hints: ['contraception'], urgency_hint: 'consult',
    captured_at: new Date().toISOString() }] });
const qid = ingest.question_ids[0];

say('2 DE-IDENTIFY', 'Stored text after in-memory de-identification (raw text was never written):');
const stored = await one('SELECT sanitized_text, deid_confidence FROM lcos.audience_questions WHERE id=$1', [qid]);
console.log(`   "${stored.sanitized_text}"  (confidence ${stored.deid_confidence})`);

say('3 CLASSIFY', 'Topic, intent, fear, EMR-hint agreement, approved-card match:');
const cls = await call('POST', `/api/v1/questions/${qid}/classify`, t.intake);
console.log(`   topic=${cls.topic_code} intent=${cls.intent} myth=${cls.is_myth} fear="${cls.fear_expressed}"`);
console.log(`   matched card=${cls.knowledge_card_code} confidence=${cls.match_confidence} (EMR hint boosted)`);

say('4 TURN INTO CONTENT', 'Rudy presses the button. Concepts, scripts, validation, Amharic, review routing:');
const tic = await call('POST', '/api/v1/content/turn-into-content', t.intake, { question_id: qid });
for (const s of tic.steps) console.log(`   ${s.step.padEnd(20)} ${s.status}`);
console.log(`   family=${tic.family_code} tier=${tic.risk_tier} concepts=${tic.concepts.length} scripts=${tic.scripts.length}`);

const scriptId = tic.scripts[0].id;
const script = await call('GET', `/api/v1/content/scripts/${scriptId}`, t.doctor);
say('5 CLAIM MAP', 'Every medical sentence traced to an approved claim:');
for (const m of script.claim_map) console.log(`   [${m.verdict ?? '—'}] "${m.statement.slice(0, 70)}..." -> ${m.claim_code}`);

say('6 AMHARIC', 'Localized with a blind back-translation for the language editor:');
console.log(`   AM:   ${script.translation.translated_text.slice(0, 90)}...`);
console.log(`   BACK: ${script.translation.back_translation.slice(0, 90)}...`);
console.log(`   drift score: ${script.translation.drift_score}`);

say('6b LANGUAGE REVIEW', 'The language editor approves the Amharic (AI voice is held until this happens):');
await call('POST', `/api/v1/content/scripts/${scriptId}/language-review`, t.language,
  { decision: 'APPROVED', naturalness_score: 4, meaning_preserved: true });
console.log('   APPROVED by language@letena.local; translation now voiceable');

say('7 CLINICAL REVIEW', `Tier ${script.risk_tier} → consulting doctor approves the script:`);
await call('POST', `/api/v1/content/scripts/${scriptId}/transition`, t.doctor, { to: 'APPROVED' });
console.log('   APPROVED by doctor@letena.local (developers and content leads are refused by RBAC)');

say('8 PRODUCTION', 'Router picks the engine and template; mock Creatomate renders:');
const job = await call('POST', '/api/v1/production/jobs', t.producer, { script_id: scriptId });
const run = await call('POST', `/api/v1/production/jobs/${job.id}/run`, t.producer);
console.log(`   ${job.engine} -> ${run.status}, preview: ${run.preview_url}`);

say('9 FINAL REVIEW', 'Producer approves the finished render:');
await call('POST', `/api/v1/production/renders/${run.render_id}/approve`, t.producer);

say('10 PUBLISH', 'Scheduled and published to Telegram (mock connector; live token drops in via .env):');
const pub = await call('POST', '/api/v1/distribution/jobs', t.social,
  { render_id: run.render_id, platform: 'TELEGRAM', caption: 'ጥያቄዎ መልስ አለው። ለቴና' });
const live = await call('POST', `/api/v1/distribution/jobs/${pub.id}/publish-now`, t.social);
console.log(`   ${live.platform} post ${live.platform_post_id} -> ${live.platform_url}`);

say('11 LINEAGE', 'The published piece answers: which card, which claims, who approved:');
const lin = await call('GET', `/api/v1/distribution/published/${live.published_content_id}/lineage`, t.content);
console.log(`   card=${lin.card_code} v${lin.card_version} · claims=${(lin.claim_codes ?? []).join(', ')}`);
console.log(`   clinical reviewer recorded: ${lin.clinical_reviewer_id ? 'yes' : 'no'}`);

say('12 ANALYTICS', 'Metrics attach (honest nulls for what a platform does not return), scores compute:');
await call('POST', `/api/v1/analytics/collect/${live.published_content_id}`, t.social,
  { questions_attributed: 4, consultations_attributed: 2 });
const scores = await call('POST', `/api/v1/analytics/scores/${live.published_content_id}`, t.social);
console.log(`   reach=${scores.reach_score} education=${scores.education_score} service=${scores.service_score}`);
console.log(`   composite=${scores.composite_score} confidence=${scores.confidence}`);

say('13 LEARNING LOOP', 'Demand board recomputes; the loop closes:');
const demand = await call('POST', '/api/v1/demand/recompute', t.admin);
console.log(`   priority rows recomputed: ${demand.rows}`);

console.log('\n════ DEMONSTRATION COMPLETE — the full loop ran end to end ════\n');
await app.close(); await pool.end();
