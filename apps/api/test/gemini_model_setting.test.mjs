// Which Gemini model each call uses (21 Aug 2026).
//
// Every non-image Gemini call was hard-wired to gemini-2.5-flash, and
// Google retired it for new callers in the middle of a build: "This model
// models/gemini-2.5-flash is no longer available to new users. Please
// update your code to use models/gemini-3.6-flash." That one string sat in
// three unrelated features -- reference-sheet splitting, Amharic
// transcription and continuity QC -- so a vendor deprecation could take
// all three out at once and the only fix was a code change and a deploy.
//
// A model name is a fact about a vendor's catalogue, not about Letena, so
// it is a setting now. These tests pin the default and the override, and
// that the image model is tracked separately from the vision/text one:
// they deprecate on different schedules and conflating them is how one
// retirement takes out both.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.LCOS_ADAPTER_MODE = 'PRODUCTION';
process.env.GEMINI_API_KEY = 'test-not-a-real-key';
process.env.LCOS_STORAGE_DIR = '/tmp/lcos-geminimodel-test-storage';

const { gemini } = await import('../src/adapters/index.mjs');
const { pool } = await import('../src/core.mjs');

const realFetch = globalThis.fetch;
let urls = [];
before(() => {
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"panels":[]}' }] } }] }) };
  };
});
after(async () => { globalThis.fetch = realFetch; await pool.end(); });

const modelIn = (url) => String(url).split('/models/')[1]?.split(':')[0];

test('sheet splitting uses the current vision model by default', async () => {
  urls = [];
  await gemini.detectSheetPanels({ imageBase64: 'AA==' });
  assert.equal(modelIn(urls[0]), 'gemini-3.6-flash');
});

test('continuity QC and transcription use the same one', async () => {
  urls = [];
  await gemini.compareContinuity({ candidateImageBase64: 'AA==', referenceImageBase64s: [], checklist: [] });
  await gemini.transcribeAudio({ audioBase64: 'AA==' });
  assert.deepEqual(urls.map(modelIn), ['gemini-3.6-flash', 'gemini-3.6-flash'],
    'one setting, so one deprecation notice is one change');
});

test('the setting overrides the default without a deploy', async () => {
  process.env.GEMINI_TEXT_MODEL = 'gemini-4.0-flash-someday';
  urls = [];
  await gemini.detectSheetPanels({ imageBase64: 'AA==' });
  assert.equal(modelIn(urls[0]), 'gemini-4.0-flash-someday');
  delete process.env.GEMINI_TEXT_MODEL;
});

test('the image model is a separate setting from the vision one', async () => {
  process.env.GEMINI_TEXT_MODEL = 'vision-only-change';
  urls = [];
  await gemini.generateImage({ prompt: 'a room', assetId: 'aaaaaaaa-0000-0000-0000-00000000000a' })
    .catch(() => {}); // no image comes back from the stub; the URL is what matters
  assert.equal(modelIn(urls[0]), 'gemini-2.5-flash-image',
    'changing the vision model must not silently change which model draws pictures');
  delete process.env.GEMINI_TEXT_MODEL;
});
