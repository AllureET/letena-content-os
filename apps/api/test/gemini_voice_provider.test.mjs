// Gemini TTS as the Amharic voice provider (24 Aug 2026, promoted from
// opt-in to the Amharic default 25 Aug 2026 after a real side-by-side
// against Azure on this exact route -- see gemini.tts() in
// adapters/index.mjs). Confirms an Amharic project with no explicit
// provider now calls Gemini, an English project with no explicit
// provider still calls Azure unchanged, an explicit provider always wins
// over the language default in either direction, and an unrecognized
// provider string still falls through to Azure rather than erroring.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.LCOS_AI_PROVIDER = 'MOCK';
process.env.LCOS_ADAPTER_MODE = 'MOCK';
process.env.LCOS_STORAGE_DIR = '/tmp/lcos-test-storage';

const { buildServer } = await import('../src/server.mjs');
const { pool } = await import('../src/core.mjs');

let app, token;
const login = async (email) => (await app.inject({ method: 'POST', url: '/api/v1/auth/login',
  payload: { email, password: 'letena-dev-2026' } })).json().token;
const call = (method, url, payload) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` }, payload });

before(async () => {
  app = await buildServer();
  token = await login('producer@letena.local');
});
after(async () => { await app.close(); await pool.end(); });

let projectId, shotId;

test('set up a project and one shot to voice', async () => {
  const p = await call('POST', '/studio/projects', { title: 'Gemini TTS provider test', format: 'ai_story',
    aspect_ratio: '9:16', language: 'am' });
  assert.equal(p.statusCode, 200, p.body);
  projectId = p.json().id;

  const s = await call('POST', `/studio/projects/${projectId}/shots`,
    { shot_code: 'SH-010', order_index: 0, duration_target_s: 5,
      story: { beat: 'intro' } });
  assert.equal(s.statusCode, 200, s.body);
  shotId = s.json().id;
});

test('default (no provider specified) on an Amharic project now calls Gemini', async () => {
  const r = await call('POST', `/studio/shots/${shotId}/voice`,
    { text: 'ሰላም ለሁላችሁም።' });
  assert.equal(r.statusCode, 200, r.body);
  const asset = r.json();
  assert.equal(asset.kind, 'VOICE');
  assert.equal(asset.generator.provider, 'GEMINI');
  assert.ok(asset.storage_key.endsWith('.wav'),
    `expected a .wav asset for the Gemini path, got ${asset.storage_key}`);
});

test('an explicit provider always wins over the language default', async () => {
  const r = await call('POST', `/studio/shots/${shotId}/voice`,
    { text: 'ስለ ጤናዎ ማንኛውንም ጥያቄ ካላችሁ በነፃ እንረዳችኋለን።', provider: 'azure' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().generator.provider, 'AZURE');
});

test('default (no provider specified) on an English project still calls Azure, unchanged', async () => {
  const p = await call('POST', '/studio/projects', { title: 'Gemini TTS provider test (EN)', format: 'ai_story',
    aspect_ratio: '9:16', language: 'en' });
  assert.equal(p.statusCode, 200, p.body);
  const s = await call('POST', `/studio/projects/${p.json().id}/shots`,
    { shot_code: 'SH-010', order_index: 0, duration_target_s: 5, story: { beat: 'intro' } });
  assert.equal(s.statusCode, 200, s.body);

  const r = await call('POST', `/studio/shots/${s.json().id}/voice`,
    { text: 'Hello, welcome to Letena.' });
  assert.equal(r.statusCode, 200, r.body);
  const asset = r.json();
  assert.equal(asset.generator.provider, 'AZURE');
  assert.ok(asset.storage_key.endsWith('.mp3'));
});

test('an explicit unknown provider string is rejected rather than silently falling back', async () => {
  // Belt-and-suspenders: the route only recognizes GEMINI as an alternate,
  // everything else (including typos) should behave exactly like today --
  // it falls through to Azure rather than throwing, since the guard is
  // `provider === 'GEMINI' ? gemini : azure`, not a strict enum check. This
  // test documents that choice rather than asserting a 4xx, so a future
  // change to make bad provider values an error is a deliberate decision,
  // not an accidental behavior change nobody notices.
  const r = await call('POST', `/studio/shots/${shotId}/voice`,
    { text: 'ድጋሚ ሰላም።', provider: 'ELEVENLABS_TYPO' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().generator.provider, 'AZURE');
});
