// Increment 5 tests: English translation of patient text (on classify + the
// backfill route), the question detail endpoint shape, the voice pronunciation
// lexicon, TTS normalization, and the voice preview endpoint in mock mode.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.LCOS_AI_PROVIDER = 'MOCK';
process.env.LCOS_ADAPTER_MODE = 'MOCK';
process.env.LCOS_STORAGE_DIR = '/tmp/lcos-test-storage';

const { buildServer } = await import('../src/server.mjs');
const { pool, q, one } = await import('../src/core.mjs');
const { applyVoiceLexicon, normalizeForTts, amharicNumber } = await import('../src/modules/voice.mjs');

let app, tokens = {};
const login = async (email) => (await app.inject({ method: 'POST', url: '/api/v1/auth/login',
  payload: { email, password: 'letena-dev-2026' } })).json().token;
const call = (method, url, token, payload) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });

before(async () => {
  app = await buildServer();
  for (const r of ['admin', 'intake', 'content', 'language', 'producer', 'dev', 'social']) {
    tokens[r] = await login(`${r}@letena.local`);
  }
});
after(async () => { await app.close(); await pool.end(); });

// Unique per run: rows persist in the dev database between test runs and the
// ingest route treats a repeated source_hash as a duplicate.
const RUN = crypto.randomUUID().slice(0, 8);
const AM_TEXT = 'ፖስትፒል ሁለት ጊዜ ወስጃለሁ። ልጅ መውለድ እችላለሁ? postpill infertility worry';
const AM_ANSWER = 'ፖስትፒል ደጋግሞ መውሰድ የመውለድ አቅምን አይጎዳም። ከሐኪም ጋር ስለ መደበኛ መከላከያ ይነጋገሩ።';

async function ingestAmharicQuestion(hash) {
  const r = await call('POST', '/api/v1/ingest/questions', tokens.intake, {
    questions: [{ text: AM_TEXT, channel: 'TELEGRAM', source_hash: `${hash}-${RUN}`,
      language_hint: 'AM', consult_mode: 'WRITTEN',
      answer_text: AM_ANSWER, answered_at: new Date().toISOString(),
      thread: [
        { role: 'patient', text: 'ስጋት አለብኝ። ችግር አለው?' },
        { role: 'doctor', text: 'ችግር የለውም። መደበኛ መከላከያ ይሻላል።' },
      ] }] });
  assert.equal(r.statusCode, 202, r.body);
  assert.equal(r.json().accepted, 1, r.body);
  return r.json().question_ids[0];
}

test('translation happens on classify: question, answer and thread segments', async () => {
  const id = await ingestAmharicQuestion('test-i5-translate-1');
  const c = await call('POST', `/api/v1/questions/${id}/classify`, tokens.intake);
  assert.equal(c.statusCode, 200, c.body);
  const row = await one(
    `SELECT translation_en, answer_translation_en, thread, sanitized_text, answer_text
     FROM lcos.audience_questions WHERE id=$1`, [id]);
  assert.ok(row.translation_en, 'translation_en set');
  assert.ok(row.translation_en.startsWith('EN: '), row.translation_en);
  assert.equal(row.translation_en, 'EN: ' + row.sanitized_text.slice(0, 120));
  assert.ok(row.answer_translation_en?.startsWith('EN: '), 'answer translated');
  assert.equal(row.answer_translation_en, 'EN: ' + row.answer_text.slice(0, 120));
  assert.equal(row.thread.length, 2);
  for (const seg of row.thread) {
    assert.ok(seg.translation_en?.startsWith('EN: '), `segment translated: ${JSON.stringify(seg)}`);
    assert.equal(seg.translation_en, 'EN: ' + seg.text.slice(0, 120));
    assert.ok(['patient', 'doctor', 'note'].includes(seg.role), 'segment shape preserved');
  }
});

test('classify leaves pure-English questions untranslated', async () => {
  const r = await call('POST', '/api/v1/ingest/questions', tokens.intake, {
    questions: [{ text: 'Can I take the pill every day without any breaks at all?',
      channel: 'WEBSITE', source_hash: `test-i5-en-1-${RUN}` }] });
  assert.equal(r.statusCode, 202, r.body);
  const id = r.json().question_ids[0];
  const c = await call('POST', `/api/v1/questions/${id}/classify`, tokens.intake);
  assert.equal(c.statusCode, 200, c.body);
  const row = await one(`SELECT translation_en FROM lcos.audience_questions WHERE id=$1`, [id]);
  assert.equal(row.translation_en, null);
});

test('GET /questions/:id returns the exact contract shape', async () => {
  const id = await ingestAmharicQuestion('test-i5-detail-1');
  await call('POST', `/api/v1/questions/${id}/classify`, tokens.intake);
  const r = await call('GET', `/api/v1/questions/${id}`, tokens.content);
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.deepEqual(Object.keys(body).sort(), ['classification', 'question']);
  assert.deepEqual(Object.keys(body.question).sort(),
    ['answer_text', 'answer_translation_en', 'captured_at', 'category_hints', 'channel',
     'consult_mode', 'deid_confidence', 'id', 'sanitized_text', 'status', 'thread',
     'translation_en', 'urgency_hint'].sort());
  assert.equal(body.question.id, id);
  assert.equal(body.question.consult_mode, 'WRITTEN');
  assert.ok(body.question.translation_en.startsWith('EN: '));
  assert.ok(Array.isArray(body.question.thread));
  assert.ok(!('embedding' in body.question), 'embedding stripped');
  assert.ok(body.classification, 'classification present after classify');
  assert.deepEqual(Object.keys(body.classification).sort(),
    ['intent', 'knowledge_card_code', 'match_confidence', 'topic_code', 'urgency'].sort());
});

test('GET /questions/:id: classification null when absent, 404 when missing', async () => {
  const id = await ingestAmharicQuestion('test-i5-detail-2');
  const r = await call('GET', `/api/v1/questions/${id}`, tokens.content);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().classification, null);
  const gone = await call('GET', `/api/v1/questions/${crypto.randomUUID()}`, tokens.content);
  assert.equal(gone.statusCode, 404);
  const badId = await call('GET', '/api/v1/questions/not-a-uuid', tokens.content);
  assert.equal(badId.statusCode, 404);
  const denied = await call('GET', `/api/v1/questions/${id}`, tokens.producer);
  assert.equal(denied.statusCode, 403);
});

test('translate-missing backfills untranslated Ethiopic questions', async () => {
  const id = await ingestAmharicQuestion('test-i5-backfill-1');
  const denied = await call('POST', '/api/v1/questions/translate-missing', tokens.content, { limit: 5 });
  assert.equal(denied.statusCode, 403);
  const r = await call('POST', '/api/v1/questions/translate-missing', tokens.admin, { limit: 200 });
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(r.json().translated >= 1, r.body);
  const row = await one(`SELECT translation_en FROM lcos.audience_questions WHERE id=$1`, [id]);
  assert.ok(row.translation_en?.startsWith('EN: '));
  // Second run finds nothing new for this row
  const again = await call('POST', '/api/v1/questions/translate-missing', tokens.admin, {});
  assert.equal(again.statusCode, 200);
  const still = await one(`SELECT count(*)::int n FROM lcos.audience_questions
    WHERE id=$1 AND translation_en IS NOT NULL`, [id]);
  assert.equal(still.n, 1);
});

test('voice lexicon: upsert, list, permission gates and delete via empty say_as', async () => {
  const up = await call('PUT', '/api/v1/platform/voice-lexicon', tokens.language,
    { term: 'Postpill', say_as: 'ፖስት ፒል', notes: 'brand name' });
  assert.equal(up.statusCode, 200, up.body);
  assert.equal(up.json().term, 'Postpill');
  // settings.manage path (developer) also allowed; producer has neither perm
  const dev = await call('PUT', '/api/v1/platform/voice-lexicon', tokens.dev,
    { term: 'IUD', say_as: 'አይ ዩ ዲ' });
  assert.equal(dev.statusCode, 200, dev.body);
  const denied = await call('PUT', '/api/v1/platform/voice-lexicon', tokens.producer,
    { term: 'HIV', say_as: 'ኤች አይ ቪ' });
  assert.equal(denied.statusCode, 403);
  // update in place, not duplicate
  const up2 = await call('PUT', '/api/v1/platform/voice-lexicon', tokens.language,
    { term: 'Postpill', say_as: 'ፖስትፒል' });
  assert.equal(up2.statusCode, 200);
  const list = await call('GET', '/api/v1/platform/voice-lexicon', tokens.producer);
  assert.equal(list.statusCode, 200);
  const items = list.json().items;
  assert.equal(items.filter(i => i.term === 'Postpill').length, 1);
  assert.equal(items.find(i => i.term === 'Postpill').say_as, 'ፖስትፒል');
  // empty say_as deletes
  const del = await call('PUT', '/api/v1/platform/voice-lexicon', tokens.dev,
    { term: 'IUD', say_as: '' });
  assert.equal(del.statusCode, 200);
  assert.equal(del.json().deleted, true);
  const after = await call('GET', '/api/v1/platform/voice-lexicon', tokens.producer);
  assert.ok(!after.json().items.some(i => i.term === 'IUD'));
});

test('applyVoiceLexicon: longest term first, whole-word Latin, substring Ethiopic', () => {
  const entries = [
    { term: 'EC', say_as: 'ኢ ሲ' },
    { term: 'EC pill', say_as: 'የአስቸኳይ ጊዜ ኪኒን' },
    { term: 'ፖስትፒል', say_as: 'ፖስት ፒል' },
  ];
  // longest term wins over its prefix
  assert.equal(applyVoiceLexicon('take the EC pill today', entries),
    'take the የአስቸኳይ ጊዜ ኪኒን today');
  // whole-word only for Latin terms: DECK and RECS untouched
  assert.equal(applyVoiceLexicon('DECK RECS EC', entries), 'DECK RECS ኢ ሲ');
  // Latin match is case-insensitive
  assert.equal(applyVoiceLexicon('what is ec?', entries), 'what is ኢ ሲ?');
  // Ethiopic term replaces as plain substring, even attached to other letters
  assert.equal(applyVoiceLexicon('ፖስትፒልን ወሰድኩ', entries), 'ፖስት ፒልን ወሰድኩ');
  // no entries: identity
  assert.equal(applyVoiceLexicon('unchanged', []), 'unchanged');
});

test('normalizeForTts: digits, teens, tens and percentages become Amharic words', () => {
  assert.equal(amharicNumber(0), 'ዜሮ');
  assert.equal(amharicNumber(5), 'አምስት');
  assert.equal(amharicNumber(11), 'አስራ አንድ');
  assert.equal(amharicNumber(22), 'ሃያ ሁለት');
  assert.equal(amharicNumber(95), 'ዘጠና አምስት');
  assert.equal(amharicNumber(100), 'መቶ');
  assert.equal(amharicNumber(101), null);
  assert.equal(normalizeForTts('ውጤቱ 95% ነው'), 'ውጤቱ ዘጠና አምስት በመቶ ነው');
  assert.equal(normalizeForTts('በ 3 ቀናት ውስጥ'), 'በ ሶስት ቀናት ውስጥ');
  assert.equal(normalizeForTts('ከ 72 ሰዓት በፊት'), 'ከ ሰባ ሁለት ሰዓት በፊት');
  assert.equal(normalizeForTts('0 ችግር'), 'ዜሮ ችግር');
  // out-of-range and decimal numbers stay as written
  assert.equal(normalizeForTts('250 ብር'), '250 ብር');
  assert.equal(normalizeForTts('3.5 mg'), '3.5 mg');
});

// Minimal knowledge chain so the voice preview has a script + version to read,
// independent of whether the e2e suite ran in this process.
async function makeScriptWithVersion() {
  const admin = await one(`SELECT id FROM lcos.users WHERE email='admin@letena.local'`);
  const card = await one(`SELECT id FROM lcos.knowledge_cards WHERE code='EC-001'`);
  const seg = await one(`SELECT id FROM lcos.audience_segments LIMIT 1`);
  const cv = await one(
    `INSERT INTO lcos.knowledge_card_versions (card_id, version, canonical_answer_en, content_sha256, created_by)
     VALUES ($1, 999, 'Test answer body.', 'testsha-i5', $2)
     ON CONFLICT (card_id, version) DO UPDATE SET canonical_answer_en=EXCLUDED.canonical_answer_en
     RETURNING id`, [card.id, admin.id]);
  const fam = await one(
    `INSERT INTO lcos.content_families (code, title, knowledge_card_id, knowledge_card_version_id,
       primary_segment_id, risk_tier, created_by)
     VALUES ('CF-TEST-I5-VOICE', 'Voice preview test family', $1, $2, $3, 'TIER_2', $4)
     ON CONFLICT (code) DO UPDATE SET title=EXCLUDED.title RETURNING id`,
    [card.id, cv.id, seg.id, admin.id]);
  const con = await one(
    `INSERT INTO lcos.content_concepts (code, family_id, video_family, title, hook_line, premise, treatment)
     VALUES ('CC-TEST-I5-VOICE', $1, 'V01_QUESTION_EXPLAINER', 'Voice test', 'Hook', 'Premise', 'Treatment')
     ON CONFLICT (code) DO UPDATE SET title=EXCLUDED.title RETURNING id`, [fam.id]);
  const script = await one(
    `INSERT INTO lcos.scripts (code, concept_id, family_id, knowledge_card_version_id, language, risk_tier, created_by)
     VALUES ('SC-TEST-I5-VOICE', $1, $2, $3, 'EN', 'TIER_2', $4)
     ON CONFLICT (code) DO UPDATE SET updated_at=now() RETURNING *`,
    [con.id, fam.id, cv.id, admin.id]);
  await q(
    `INSERT INTO lcos.script_versions (script_id, version, hook, spoken_script, cta, content_sha256)
     VALUES ($1, 1, 'Hook line', 'Postpill works within 3 days and is 95% effective.', 'Message Letena.', 'testsha-i5-v1')
     ON CONFLICT (script_id, version) DO NOTHING`, [script.id]);
  return script;
}

test('voice preview: mock mode returns a url and the normalized lexicon-applied text', async () => {
  const script = await makeScriptWithVersion();
  await call('PUT', '/api/v1/platform/voice-lexicon', tokens.language,
    { term: 'Postpill', say_as: 'ፖስት ፒል' });
  const denied = await call('POST', '/api/v1/production/voice-preview', tokens.language,
    { script_id: script.id });
  assert.equal(denied.statusCode, 403, 'production.request required');
  const r = await call('POST', '/api/v1/production/voice-preview', tokens.producer,
    { script_id: script.id });
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.ok(body.url?.startsWith('file://'), body.url);
  assert.ok(body.url.endsWith('.mp3'));
  assert.ok(body.text_used.includes('ፖስት ፒል'), `lexicon applied: ${body.text_used}`);
  assert.ok(body.text_used.includes('ሶስት'), `3 expanded: ${body.text_used}`);
  assert.ok(body.text_used.includes('ዘጠና አምስት በመቶ'), `95% expanded: ${body.text_used}`);
  assert.ok(!/(?<!\d)(3|95)(?!\d)/.test(body.text_used), `digits gone: ${body.text_used}`);
  // AMEHA voice variant also succeeds
  const r2 = await call('POST', '/api/v1/production/voice-preview', tokens.producer,
    { script_id: script.id, voice: 'AMEHA' });
  assert.equal(r2.statusCode, 200, r2.body);
  // missing script 404s
  const gone = await call('POST', '/api/v1/production/voice-preview', tokens.producer,
    { script_id: crypto.randomUUID() });
  assert.equal(gone.statusCode, 404);
});
