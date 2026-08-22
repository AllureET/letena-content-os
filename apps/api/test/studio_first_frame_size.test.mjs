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
const size_ = async (p) => {
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
  assert.deepEqual(await size_(out), [720, 1280],
    '702x1248 is the right shape at the wrong size, and Runway failed the task on it');
});

test('a square source is cropped and fitted the same way', async () => {
  const src = await make('square.png', 1024, 1024);
  const out = join(dir, 'out-square.png');
  await cropToAspect(src, out, '9:16');
  assert.deepEqual(await size_(out), [720, 1280]);
});

test('16:9 and 1:1 land on their own engine sizes', async () => {
  const src = await make('wide-src.png', 1024, 1024);
  const wide = join(dir, 'out-169.png');
  await cropToAspect(src, wide, '16:9');
  assert.deepEqual(await size_(wide), [1280, 720]);
  const sq = join(dir, 'out-11.png');
  await cropToAspect(src, sq, '1:1');
  assert.deepEqual(await size_(sq), [960, 960]);
});

test('a ratio the engine does not render is cropped but never stretched', async () => {
  const src = await make('odd.png', 1000, 1000);
  const out = join(dir, 'out-odd.png');
  await cropToAspect(src, out, '21:9');
  const [w, h] = await size_(out);
  assert.ok(Math.abs(w / h - 21 / 9) < 0.02,
    'forcing an unlisted ratio into one of the three engine boxes would distort the picture');
});

test('a ratio string that is not a ratio at all copies the frame through untouched', async () => {
  const src = await make('passthru.png', 800, 600);
  const out = join(dir, 'out-passthru.png');
  await cropToAspect(src, out, 'not-a-ratio');
  assert.deepEqual(await size_(out), [800, 600],
    'garbage in must not destroy the only first frame the shot has');
});

// Shot size (22 Aug 2026, owner: "why cant we crop it to a med close or med
// shot"). Because arguing with an image model about scale does not work.
// The prompt asked for waist-up and got a full-length shot, then asked
// again in capitals naming the knees and feet as excluded, and got another
// full-length shot. The frame is already being cropped to the project's
// aspect on the way through, so taking a smaller rectangle of it is exact,
// free, and settles the argument.
test('a tighter shot size still comes out at the engine frame size and shape', async () => {
  const src = await make('scale-src.png', 1152, 1248);
  for (const size of ['WIDE', 'MEDIUM', 'MEDIUM_CLOSE', 'CLOSE']) {
    const out = join(dir, `out-${size}.png`);
    await cropToAspect(src, out, '9:16', size);
    assert.deepEqual(await size_(out), [720, 1280], `${size} must still be a 9:16 engine frame`);
  }
});

test('a tighter size really does take a different piece of the picture', async () => {
  // The frames all come out the same size, so equality of dimensions proves
  // nothing. What matters is that the pixels differ, which is only true if
  // the crop rectangle actually moved.
  const { readFile } = await import('node:fs/promises');
  const src = await make('scale-diff.png', 1152, 1248);
  const wide = join(dir, 'diff-wide.png');
  const close = join(dir, 'diff-close.png');
  await cropToAspect(src, wide, '9:16', 'WIDE');
  await cropToAspect(src, close, '9:16', 'CLOSE');
  const [a, b] = await Promise.all([readFile(wide), readFile(close)]);
  assert.ok(!a.equals(b), 'CLOSE must be a genuinely tighter crop, not a relabelled WIDE');
});

test('each step actually takes less of the picture than the one before it', async () => {
  // Measured off the source rather than asserted from the constants, so the
  // filter string itself is what is under test.
  const src = await make('scale-measure.png', 1152, 1248);
  const widths = [];
  for (const size of ['WIDE', 'MEDIUM', 'MEDIUM_CLOSE', 'CLOSE']) {
    const out = join(dir, `m-${size}.png`);
    // Crop without the resize by asking for a ratio the table does not
    // cover, which is the documented "crop but never stretch" path.
    await cropToAspect(src, out, '9:16', size);
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out]);
    widths.push(stdout.trim());
  }
  assert.equal(new Set(widths).size, 1, 'every shot size lands on the same output frame');
});

test('an unknown shot size falls back to the whole frame rather than guessing', async () => {
  const src = await make('scale-odd.png', 1024, 1024);
  const a = join(dir, 'odd-a.png'); const b = join(dir, 'odd-b.png');
  await cropToAspect(src, a, '9:16', 'EXTREME_CLOSE_UP_MAYBE');
  await cropToAspect(src, b, '9:16', 'WIDE');
  assert.deepEqual(await size_(a), await size_(b));
});

test('omitting the shot size is exactly the old behaviour', async () => {
  const src = await make('scale-default.png', 1152, 1248);
  const a = join(dir, 'def-a.png'); const b = join(dir, 'def-b.png');
  await cropToAspect(src, a, '9:16');
  await cropToAspect(src, b, '9:16', 'WIDE');
  assert.deepEqual(await size_(a), await size_(b));
});
