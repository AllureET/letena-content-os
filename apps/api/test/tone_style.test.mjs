// Tests for the house writing style rules + configurable tone/voice presets
// (Nate, 12 Aug 2026): apps/api/src/ai/style_lint.mjs (pure lint function)
// and the tone preset machinery in apps/api/src/ai/gateway.mjs (migration
// 0009_tone_presets.sql). Runs against the real Postgres with MOCK AI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.LCOS_AI_PROVIDER = 'MOCK';
process.env.LCOS_ADAPTER_MODE = 'MOCK';
process.env.LCOS_STORAGE_DIR = '/tmp/lcos-test-storage';

const { lintStyle } = await import('../src/ai/style_lint.mjs');
const { buildAgentSystemPrompt, HOUSE_STYLE_RULES, getTonePresetInstructions, invokeAgent } =
  await import('../src/ai/gateway.mjs');
const { MockAIProvider } = await import('../src/ai/provider.mjs');
const { buildServer } = await import('../src/server.mjs');
const { pool, q, one } = await import('../src/core.mjs');

// =====================================================================
// lintStyle: pure function, clear pass/fail examples
// =====================================================================

test('lintStyle: clean, plain-prose text has no warnings', () => {
  const text = 'Emergency contraception works mainly by delaying ovulation. Take it as soon as you can after unprotected sex.';
  assert.deepEqual(lintStyle(text), []);
});

test('lintStyle: empty and nullish input has no warnings', () => {
  assert.deepEqual(lintStyle(''), []);
  assert.deepEqual(lintStyle(null), []);
  assert.deepEqual(lintStyle(undefined), []);
});

test('lintStyle: flags the em dash character', () => {
  const warnings = lintStyle('It works well — most people tolerate it fine.');
  assert.ok(warnings.some(w => w.startsWith('em_dash:')), JSON.stringify(warnings));
});

test('lintStyle: a plain hyphen or comma does not trip the em dash check', () => {
  const warnings = lintStyle('It is a well-known method, and most people tolerate it fine.');
  assert.ok(!warnings.some(w => w.startsWith('em_dash:')), JSON.stringify(warnings));
});

test('lintStyle: flags a hedge-filler phrase', () => {
  const warnings = lintStyle('This might cause light spotting for a few days.');
  assert.ok(warnings.some(w => w.startsWith('hedge_phrase:') && w.includes('"might"')), JSON.stringify(warnings));
});

test('lintStyle: flags multiple distinct hedge phrases in one text', () => {
  const warnings = lintStyle('It could potentially help, and it is possible that side effects occur.');
  const hedgeHits = warnings.filter(w => w.startsWith('hedge_phrase:'));
  assert.ok(hedgeHits.length >= 2, JSON.stringify(warnings));
});

test('lintStyle: hedge word match is whole-word, not a substring of an unrelated word', () => {
  // "mighty" contains "might" as a substring but is not the hedge word.
  const warnings = lintStyle('The mighty Blue Nile flows through the highlands.');
  assert.ok(!warnings.some(w => w.startsWith('hedge_phrase:')), JSON.stringify(warnings));
});

test('lintStyle: flags AI sign-off phrases', () => {
  const warnings = lintStyle('I hope this helps! Let me know if you have any other questions.');
  const signoffHits = warnings.filter(w => w.startsWith('ai_signoff:'));
  assert.ok(signoffHits.length >= 2, JSON.stringify(warnings));
});

test('lintStyle: a clean sign-off-shaped sentence that is not on the deny-list passes', () => {
  const warnings = lintStyle('Message Letena on Telegram any time, it is free and private.');
  assert.ok(!warnings.some(w => w.startsWith('ai_signoff:')), JSON.stringify(warnings));
});

test('lintStyle: combined violations are all reported at once', () => {
  const text = 'It might help — I hope this helps!';
  const warnings = lintStyle(text);
  assert.ok(warnings.some(w => w.startsWith('em_dash:')));
  assert.ok(warnings.some(w => w.startsWith('hedge_phrase:')));
  assert.ok(warnings.some(w => w.startsWith('ai_signoff:')));
  assert.ok(warnings.length >= 3, JSON.stringify(warnings));
});

test('lintStyle: matching is case-insensitive', () => {
  const warnings = lintStyle('I HOPE THIS HELPS with your question.');
  assert.ok(warnings.some(w => w.startsWith('ai_signoff:')), JSON.stringify(warnings));
});

// =====================================================================
// prompt assembly (pure composition): house rules + tone + base prompt
// =====================================================================

test('buildAgentSystemPrompt: house rules lead, then tone, then the base prompt, in order', () => {
  const result = buildAgentSystemPrompt('AGENT TASK INSTRUCTIONS HERE', 'TONE INSTRUCTIONS HERE');
  assert.ok(result.startsWith(HOUSE_STYLE_RULES), 'house rules must lead the assembled prompt');
  assert.ok(result.includes('TONE INSTRUCTIONS HERE'));
  assert.ok(result.includes('AGENT TASK INSTRUCTIONS HERE'));
  assert.ok(result.indexOf('TONE INSTRUCTIONS HERE') < result.indexOf('AGENT TASK INSTRUCTIONS HERE'),
    'tone block must come before the agent-specific task instructions');
});

test('buildAgentSystemPrompt: empty tone instructions omit the tone block cleanly', () => {
  const result = buildAgentSystemPrompt('BASE PROMPT', '');
  assert.ok(!result.includes('Tone and voice for this piece'));
  assert.ok(result.includes('BASE PROMPT'));
});

test('HOUSE_STYLE_RULES: bans every rule from the owner spec', () => {
  const rules = HOUSE_STYLE_RULES.toLowerCase();
  assert.match(rules, /em dash/);
  assert.match(rules, /not this, but that|contrastive/);
  assert.match(rules, /hedge/);
  assert.match(rules, /parenthetical/);
  assert.match(rules, /sign off|assistant/);
  assert.match(rules, /antithesis/);
  assert.match(rules, /rule-of-three|tricolon/);
});

// =====================================================================
// tone preset resolution (DB-backed: lcos.tone_presets, migration 0009)
// =====================================================================

test('getTonePresetInstructions: each named preset returns distinct, on-topic instructions', async () => {
  const [def, clinical, friendly] = await Promise.all([
    getTonePresetInstructions('LETENA_DEFAULT'),
    getTonePresetInstructions('CLINICAL_DIRECT'),
    getTonePresetInstructions('FRIENDLY_CASUAL'),
  ]);
  assert.match(def, /warm/i);
  assert.match(clinical, /clipped and factual/i);
  assert.match(friendly, /conversational/i);
  assert.notEqual(def, clinical);
  assert.notEqual(def, friendly);
  assert.notEqual(clinical, friendly);
});

test('getTonePresetInstructions: an unknown or inactive key fails safe to LETENA_DEFAULT', async () => {
  const fallback = await getTonePresetInstructions('NOT_A_REAL_PRESET_KEY');
  const def = await getTonePresetInstructions('LETENA_DEFAULT');
  assert.equal(fallback, def);
});

// =====================================================================
// gateway.mjs actually sends the tone text to the provider
// =====================================================================

test('invokeAgent: the assembled system prompt sent to the provider carries both the tone preset text and the house rules', async () => {
  const originalGenerate = MockAIProvider.prototype.generateStructured;
  let captured = null;
  MockAIProvider.prototype.generateStructured = function (args) {
    captured = args;
    return originalGenerate.call(this, args);
  };
  try {
    await invokeAgent('question_classifier', { question_text: 'Is a condom effective against HIV?' },
      { tone_preset: 'CLINICAL_DIRECT' });
  } finally {
    MockAIProvider.prototype.generateStructured = originalGenerate;
  }
  assert.ok(captured, 'provider.generateStructured was called');
  assert.ok(captured.system.includes('clipped and factual'),
    'system prompt sent to the provider must carry the CLINICAL_DIRECT tone text');
  assert.ok(captured.system.includes('Never use an em dash'),
    'system prompt sent to the provider must carry the house style rules');
});

test('invokeAgent: a different tone_preset override changes the assembled system prompt sent', async () => {
  const originalGenerate = MockAIProvider.prototype.generateStructured;
  const seen = [];
  MockAIProvider.prototype.generateStructured = function (args) {
    seen.push(args.system);
    return originalGenerate.call(this, args);
  };
  try {
    await invokeAgent('question_classifier', { question_text: 'Is a condom effective against HIV?' },
      { tone_preset: 'FRIENDLY_CASUAL' });
    await invokeAgent('question_classifier', { question_text: 'Is a condom effective against HIV?' },
      { tone_preset: 'CLINICAL_DIRECT' });
  } finally {
    MockAIProvider.prototype.generateStructured = originalGenerate;
  }
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1], 'switching the tone preset must change what is sent to the provider');
  assert.ok(seen[0].includes('conversational'));
  assert.ok(seen[1].includes('clipped and factual'));
});

// =====================================================================
// end to end: settings + route + generated-content surfaces
// =====================================================================

let app, tokens = {};
const login = async (email) => {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
    payload: { email, password: 'letena-dev-2026' } });
  assert.equal(res.statusCode, 200, `login failed for ${email}: ${res.body}`);
  return res.json().token;
};
const call = (method, url, token, payload) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });

before(async () => {
  app = await buildServer();
  for (const r of ['intake', 'dev', 'admin']) tokens[r] = await login(`${r}@letena.local`);
  await q(`UPDATE lcos.content_families SET origin_question_id=NULL
           WHERE origin_question_id IN (SELECT id FROM lcos.audience_questions WHERE source_hash LIKE 'test-tone-%')`);
  await q(`DELETE FROM lcos.audience_questions WHERE source_hash LIKE 'test-tone-%'`);
});
after(async () => { await app.close(); await pool.end(); });

test('GET /content/tone-presets lists the three named presets and the current default', async () => {
  const res = await call('GET', '/api/v1/content/tone-presets', tokens.intake);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  const keys = body.items.map(i => i.key).sort();
  assert.deepEqual(keys, ['CLINICAL_DIRECT', 'FRIENDLY_CASUAL', 'LETENA_DEFAULT']);
  assert.equal(body.default, 'LETENA_DEFAULT');
});

test('PUT /platform/settings rejects an unknown content.tone_preset value', async () => {
  const res = await call('PUT', '/api/v1/platform/settings', tokens.dev,
    { key: 'content.tone_preset', value: 'MADE_UP_PRESET' });
  assert.equal(res.statusCode, 422, res.body);
});

test('PUT /platform/settings accepts a real content.tone_preset value and rolls it back', async () => {
  const set = await call('PUT', '/api/v1/platform/settings', tokens.dev,
    { key: 'content.tone_preset', value: 'CLINICAL_DIRECT' });
  assert.equal(set.statusCode, 200, set.body);
  assert.equal(set.json().value, 'CLINICAL_DIRECT');
  const restore = await call('PUT', '/api/v1/platform/settings', tokens.dev,
    { key: 'content.tone_preset', value: 'LETENA_DEFAULT' });
  assert.equal(restore.statusCode, 200, restore.body);
});

test('turn-into-content: a per-request tone_preset override threads through to the generated scripts and their style_warnings', async () => {
  const ingest = await call('POST', '/api/v1/ingest/questions', tokens.intake, {
    batch_id: 'test-tone-batch-1',
    questions: [{
      channel: 'TELEGRAM', source_hash: 'test-tone-postpill-1',
      text: 'I took Postpill twice this month. Will I still be able to have children?',
      language_hint: 'EN', urgency_hint: 'consult', captured_at: new Date().toISOString(),
    }],
  });
  assert.equal(ingest.statusCode, 202, ingest.body);
  const questionId = ingest.json().question_ids[0];
  const classified = await call('POST', `/api/v1/questions/${questionId}/classify`, tokens.intake);
  assert.equal(classified.statusCode, 200, classified.body);

  const res = await call('POST', '/api/v1/content/turn-into-content', tokens.intake,
    { question_id: questionId, languages: ['EN'], tone_preset: 'CLINICAL_DIRECT' });
  assert.equal(res.statusCode, 202, res.body);
  const body = res.json();
  assert.equal(body.tone_preset, 'CLINICAL_DIRECT');
  const generated = body.scripts.filter(s => s.id);
  assert.ok(generated.length >= 1, 'at least one script generated');
  for (const s of generated) {
    assert.equal(s.tone_preset, 'CLINICAL_DIRECT');
    assert.ok(Array.isArray(s.style_warnings), 'style_warnings must be an array wherever a script is returned');
  }

  // GET /content/scripts/:id exposes the same fields on its version record.
  const detail = await call('GET', `/api/v1/content/scripts/${generated[0].id}`, tokens.intake);
  assert.equal(detail.statusCode, 200, detail.body);
  const dv = detail.json().version;
  assert.equal(dv.tone_preset, 'CLINICAL_DIRECT');
  assert.ok(Array.isArray(dv.style_warnings));

  // And the row landed in Postgres with the resolved tone recorded.
  const row = await one(
    `SELECT tone_preset, style_warnings FROM lcos.script_versions WHERE script_id=$1 AND version=1`,
    [generated[0].id]);
  assert.equal(row.tone_preset, 'CLINICAL_DIRECT');
  assert.ok(Array.isArray(row.style_warnings));
});

test('turn-into-content: omitting tone_preset falls back to the content.tone_preset setting', async () => {
  const ingest = await call('POST', '/api/v1/ingest/questions', tokens.intake, {
    batch_id: 'test-tone-batch-2',
    questions: [{
      channel: 'TELEGRAM', source_hash: 'test-tone-postpill-2',
      text: 'I used Postpill again this month, will it affect my ability to have children later?',
      language_hint: 'EN', urgency_hint: 'consult', captured_at: new Date().toISOString(),
    }],
  });
  assert.equal(ingest.statusCode, 202, ingest.body);
  const questionId = ingest.json().question_ids[0];
  await call('POST', `/api/v1/questions/${questionId}/classify`, tokens.intake);

  const res = await call('POST', '/api/v1/content/turn-into-content', tokens.intake,
    { question_id: questionId, languages: ['EN'] });
  assert.equal(res.statusCode, 202, res.body);
  assert.equal(res.json().tone_preset, 'LETENA_DEFAULT');
});
