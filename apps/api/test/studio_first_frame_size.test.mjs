// First-frame crop-and-fit (21 Aug 2026). Two Runway failures in one
// evening produced this file.
//
// Gemini returns whatever square-ish frame it likes, so a 9:16 project's
// composed first frame has to be reshaped before a video engine sees it.
// The crop alone was not enough: cropping a 1152x1248 frame to 9:16 leaves
// 702x1248, a correct SHAPE at the wrong SIZE, smaller in both dimensions
// than the 720x1280 the engine renders. Runway accepted that task and then
// failed it with a bare "An unexpected error occurred", reproducibly,
// twice, on a frame that differed from a working run only in its
// dimensions. Resizing to the engine's own output size after the crop
// removes the ambiguity.
//
// These run real ffmpeg against real generated images, because the bug was
// in the pixels and a mocked ffmpeg would have proved nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.LCOS_AI_PROVIDER = 'MOCK';
process.env.LCOS_ADAPTER_MODE = 'MOCK';
process.env.LCOS_STORAGE_DIR = '/tmp/lcos-firstframe-test-storage';

const { cropToAspect } = await import('../src/modules/studio.mjs');
const { pool } = await import('../src/core.mjs');
const run = promisify(execFile);

let dir;
const make = async (name, w, h) => {
  dir ??= await mkdtemp(join(tmpdir(), 'lcos-frame-'));
  const p = join(dir, name);
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', `testsrc=size=${w}x${h}:duration=1:rate=1`, '-frames:v', '1', p]);
  return p;
};
const size = async (p) => {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', p]);
  return stdout.trim().split(',').map(Number);
};

test.after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  await pool.end();
});

test('the exact frame that failed on Runway comes out at the engine size', async () => {
  const src = await make('gemini.png', 1152, 1248);
  const out = join(dir, 'out-916.png');
  await cropToAspect(src, out, '9:16');
  assert.deepEqual(await size(out), [720, 1280],
    '702x1248 is the right shape at the wrong size, and Runway failed the task on it');
});

test('a square source is cropped and fitted the same way', async () => {
  const src = await make('square.png', 1024, 1024);
  const out = join(dir, 'out-square.png');
  await cropToAspect(src, out, '9:16');
  assert.deepEqual(await size(out), [720, 1280]);
});

test('16:9 and 1:1 land on their own engine sizes', async () => {
  const src = await make('wide-src.png', 1024, 1024);
  const wide = join(dir, 'out-169.png');
  await cropToAspect(src, wide, '16:9');
  assert.deepEqual(await size(wide), [1280, 720]);
  const sq = join(dir, 'out-11.png');
  await cropToAspect(src, sq, '1:1');
  assert.deepEqual(await size(sq), [960, 960]);
});

test('a ratio the engine does not render is cropped but never stretched', async () => {
  const src = await make('odd.png', 1000, 1000);
  const out = join(dir, 'out-odd.png');
  await cropToAspect(src, out, '21:9');
  const [w, h] = await size(out);
  assert.ok(Math.abs(w / h - 21 / 9) < 0.02,
    'forcing an unlisted ratio into one of the three engine boxes would distort the picture');
});

test('a ratio string that is not a ratio at all copies the frame through untouched', async () => {
  const src = await make('passthru.png', 800, 600);
  const out = join(dir, 'out-passthru.png');
  await cropToAspect(src, out, 'not-a-ratio');
  assert.deepEqual(await size(out), [800, 600],
    'garbage in must not destroy the only first frame the shot has');
});
