// What the Runway adapter actually puts in promptText (21 Aug 2026).
//
// Three consecutive generations failed with INTERNAL.BAD_OUTPUT.CODE01 on a
// perfectly ordinary shot of a doctor talking to camera. Runway has no
// negative-prompt field, and this adapter had been folding the studio's
// negative list into the positive prompt as "Avoid: ... unintended text,
// subtitles, logo, watermark ...". promptText is a description of what to
// SHOW, so that was asking the model for the exact artifacts Runway's own
// docs name as the most common cause of that failure code.
//
// These tests pin the two rules that came out of it: the negative list
// never reaches Runway, and promptText never exceeds Runway's documented
// 1000-character limit.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.LCOS_ADAPTER_MODE = 'PRODUCTION';
process.env.RUNWAY_API_KEY = 'key_test_not_a_real_key';
process.env.LCOS_STORAGE_DIR = '/tmp/lcos-runwayprompt-test-storage';

const { runway } = await import('../src/adapters/index.mjs');
const { pool } = await import('../src/core.mjs');

const FRAME = 'assets/test/frame.png';
const realFetch = globalThis.fetch;
let sent = [];

before(() => {
  mkdirSync(join(process.env.LCOS_STORAGE_DIR, 'assets/test'), { recursive: true });
  writeFileSync(join(process.env.LCOS_STORAGE_DIR, FRAME), Buffer.from('not-really-a-png'));
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.endsWith('/image_to_video') || u.endsWith('/text_to_video')) {
      sent.push({ url: u, body: JSON.parse(opts.body) });
      return { ok: true, json: async () => ({ id: 'task-test' }) };
    }
    if (u.includes('/tasks/')) {
      return { ok: true, json: async () => ({ status: 'SUCCEEDED', output: ['https://example.test/out.mp4'] }) };
    }
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
  };
});

after(async () => {
  globalThis.fetch = realFetch;
  await pool.end();
});

const NEGATIVE = 'identity mutation, duplicate subjects, extra limbs, fused hands, unintended text, '
  + 'subtitles, logo, watermark, no written text of any kind in the image';

test('the negative list never reaches Runway on the image path', async () => {
  sent = [];
  await runway.imageToVideo({ prompt: 'SUBJECT MOTION: she speaks to camera.', negativePrompt: NEGATIVE,
    referenceImageKey: FRAME, assetId: 'aaaaaaaa-0000-0000-0000-000000000001', durationS: 5, aspectRatio: '9:16' });
  const { body } = sent[0];
  assert.equal(body.promptText, 'SUBJECT MOTION: she speaks to camera.');
  for (const word of ['Avoid', 'watermark', 'logo', 'subtitles', 'extra limbs']) {
    assert.ok(!body.promptText.includes(word),
      `"${word}" in a positive prompt asks Runway to draw it, which is how BAD_OUTPUT happened`);
  }
  assert.equal(body.ratio, '720:1280');
  assert.equal(body.duration, 5);
});

test('the negative list never reaches Runway on the text path either', async () => {
  sent = [];
  await runway.textToVideo({ prompt: 'A quiet consulting room.', negativePrompt: NEGATIVE,
    assetId: 'aaaaaaaa-0000-0000-0000-000000000002', durationS: 5, aspectRatio: '9:16' });
  assert.equal(sent[0].body.promptText, 'A quiet consulting room.');
});

test('promptText is capped at Runway\'s 1000-character limit', async () => {
  sent = [];
  await runway.imageToVideo({ prompt: 'x'.repeat(1500), referenceImageKey: FRAME,
    assetId: 'aaaaaaaa-0000-0000-0000-000000000003', durationS: 5, aspectRatio: '9:16' });
  assert.equal(sent[0].body.promptText.length, 1000,
    'losing a whole generation to a 400 for the sake of a slice is a bad trade');
});
