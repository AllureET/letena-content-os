// Video Studio AI-assisted lock drafting (18 Aug 2026). POST /studio/locks/draft
// turns free text into the structured fields a lock needs, via the new
// studio_lock_drafter agent (apps/api/src/ai/gateway.mjs), without saving
// anything -- the New lock form shows the draft for the human to review or
// edit before an actual lock is ever POSTed. This file only tests the
// endpoint's own plumbing (validation, the agent call, reshaping the flat
// agent output into the nested lock.data shape compileStillPrompt() reads);
// it does not touch studio.test.mjs. MOCK mode uses a simple regex stand-in
// (provider.mjs's agent_studio_lock_drafter), not a real model, so these
// prove the wiring works, not real draft quality.
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

test('drafting a CHARACTER lock extracts fields into the nested shape compileStillPrompt reads', async () => {
  const r = await call('POST', '/studio/locks/draft', { entity_type: 'CHARACTER',
    free_text: 'Maya is a woman in her late 20s with black hair, wearing an ochre jacket. No earrings.' });
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.equal(body.data.name, 'Maya');
  assert.equal(body.data.apparent_age, 'late 20s');
  assert.equal(body.data.hair, 'black hair');
  assert.ok(body.data.wardrobe_variants?.default?.includes('ochre jacket'),
    `expected wardrobe_variants.default to mention the ochre jacket, got ${JSON.stringify(body.data.wardrobe_variants)}`);
  assert.deepEqual(body.data.forbidden_drift, ['no earrings']);
  // A flat field like wardrobe_default must never leak into the returned
  // data verbatim -- only the reshaped wardrobe_variants.default.
  assert.equal(body.data.wardrobe_default, undefined);
  assert.equal(body.clarifying_note, null);
});

test('a thin description gets a clarifying note instead of fabricated detail, and no empty fields', async () => {
  const r = await call('POST', '/studio/locks/draft', { entity_type: 'CHARACTER', free_text: 'a person' });
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.ok(body.clarifying_note, 'a thin description should come back with a clarifying note, not silent fabrication');
  assert.deepEqual(body.data, {}, 'nothing meaningful was extractable, so data should be empty rather than padded with nulls');
});

test('a STYLE draft fills style_summary, not the character-only fields', async () => {
  const r = await call('POST', '/studio/locks/draft',
    { entity_type: 'STYLE', free_text: 'warm gouache illustration, soft edges, gentle motion' });
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.ok(body.data.style_summary?.includes('gouache'));
  assert.equal(body.data.name, undefined);
  assert.equal(body.data.apparent_age, undefined);
});

test('rejects a missing or unknown entity_type', async () => {
  const missing = await call('POST', '/studio/locks/draft', { free_text: 'someone' });
  assert.equal(missing.statusCode, 422);
  assert.equal(missing.json().code, 'VALIDATION');

  const bad = await call('POST', '/studio/locks/draft', { entity_type: 'VEHICLE', free_text: 'a red car' });
  assert.equal(bad.statusCode, 422);
  assert.equal(bad.json().code, 'VALIDATION');
});

test('rejects empty free_text', async () => {
  const r = await call('POST', '/studio/locks/draft', { entity_type: 'CHARACTER', free_text: '   ' });
  assert.equal(r.statusCode, 422);
  assert.equal(r.json().code, 'VALIDATION');
});

test('the draft is never saved as a lock: the project still has zero locks after drafting', async () => {
  const proj = await call('POST', '/studio/projects', { title: 'Draft-only check', format: 'ai_story',
    aspect_ratio: '9:16', language: 'am' });
  const projectId = proj.json().id;
  await call('POST', '/studio/locks/draft',
    { entity_type: 'CHARACTER', free_text: 'Sara is in her 30s with curly hair, wearing a green scarf.' });
  const locks = await call('GET', `/studio/projects/${projectId}/locks`);
  assert.equal(locks.json().items.length, 0,
    'drafting must never create a lock row by itself; the human still has to submit Create lock');
});
