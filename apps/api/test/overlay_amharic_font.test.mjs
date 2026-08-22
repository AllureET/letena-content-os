// Amharic actually drawing (22 Aug 2026).
//
// The four overlay cards came back from a real assembly with every Amharic
// glyph a tofu box carrying its own codepoint, while Latin words on the same
// card rendered perfectly. Layout, colour, timing and animation were all
// correct. Only the script was missing.
//
// The cause was a claim in studio_overlays.mjs's own header: that embedding
// the font as a base64 @font-face data URL "works identically wherever
// ffmpeg+librsvg exists". librsvg ignores @font-face with a data: src.
// Rendering the same SVG with fontconfig pointed at an empty directory draws
// zero pixels; with the font installed, it draws. The embedding never worked.
// It was masked, everywhere it was tested, by the test machine happening to
// have Noto Sans Ethiopic installed. The production server did not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

process.env.NODE_ENV = 'test';
const { ensureEthiopicFontsInstalled, ETHIOPIC_FAMILY } = await import('../src/modules/studio_overlays.mjs');

test('the bundled font files are actually in the repo', async () => {
  for (const f of ['NotoSansEthiopic-Bold.ttf', 'NotoSansEthiopic-Regular.ttf']) {
    const b = await readFile(new URL(`../assets/fonts/${f}`, import.meta.url));
    assert.ok(b.length > 100_000, `${f} looks too small to be a real font`);
  }
});

test('the font is installed where fontconfig can see it', async () => {
  const r = await ensureEthiopicFontsInstalled();
  assert.equal(r.ok, true, r.note);
  const { stdout } = await run('fc-list', [], { maxBuffer: 8 * 1024 * 1024 });
  assert.match(stdout, /ethiopic/i);
});

test('installing twice is idempotent and returns the same answer', async () => {
  const a = await ensureEthiopicFontsInstalled();
  const b = await ensureEthiopicFontsInstalled();
  assert.deepEqual(a, b, 'the promise is memoised; a restart should not rewrite fonts on every render');
});

test('a card names the real fontconfig family, not only the embedded one', async () => {
  const src = await readFile(new URL('../src/modules/studio_overlays.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function fontFamilyName'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /ETHIOPIC_FAMILY/,
    'librsvg can only resolve the family fontconfig knows about');
  assert.match(body, /EthiopicBold|EthiopicRegular/,
    'the embedded family stays first for renderers that do honour @font-face');
});

test('the header no longer claims the embedding is sufficient on its own', async () => {
  const src = await readFile(new URL('../src/modules/studio_overlays.mjs', import.meta.url), 'utf8');
  assert.match(src, /librsvg ignores @font-face with a data: src/,
    'the false claim cost a whole build; the correction has to stay written down');
});

// The regression that matters. Render Amharic with fontconfig pointed at a
// directory containing nothing, then at one containing the bundled font, and
// assert the difference. Without the fix the first case is what production
// was doing every time.
test('Amharic draws no pixels without the font, and real pixels with it', async (t) => {
  const { mkdtemp, mkdir, writeFile, copyFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'lcos-font-'));
  const fontsDir = join(dir, 'fonts'), cacheDir = join(dir, 'cache');
  await mkdir(fontsDir, { recursive: true }); await mkdir(cacheDir, { recursive: true });
  const conf = join(dir, 'fonts.conf');
  await writeFile(conf, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>`
    + `<dir>${fontsDir}</dir><cachedir>${cacheDir}</cachedir></fontconfig>`);
  const svg = join(dir, 'card.svg');
  await writeFile(svg, `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="120">`
    + `<rect width="600" height="120" fill="#16103F"/>`
    + `<text x="20" y="80" font-family="'${ETHIOPIC_FAMILY}', sans-serif" font-size="48" fill="#FDF8F0">ጥያቄ አለሽ</text></svg>`);

  const inkOf = async (out) => {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', svg, out],
      { env: { ...process.env, FONTCONFIG_FILE: conf } });
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'frame=pkt_size',
      '-of', 'csv=p=0', out]).catch(() => ({ stdout: '' }));
    const buf = await readFile(out);
    return { bytes: buf.length, probe: stdout.trim() };
  };
  try { await run('fc-cache', ['-f', fontsDir], { env: { ...process.env, FONTCONFIG_FILE: conf } }); } catch { /* empty dir */ }
  const before = await inkOf(join(dir, 'before.png'));

  await copyFile(new URL('../assets/fonts/NotoSansEthiopic-Bold.ttf', import.meta.url), join(fontsDir, 'b.ttf'));
  await copyFile(new URL('../assets/fonts/NotoSansEthiopic-Regular.ttf', import.meta.url), join(fontsDir, 'r.ttf'));
  await run('fc-cache', ['-f', fontsDir], { env: { ...process.env, FONTCONFIG_FILE: conf } });
  const after = await inkOf(join(dir, 'after.png'));

  assert.ok(after.bytes > before.bytes,
    `a card with glyphs must be a bigger PNG than one with none (before ${before.bytes}, after ${after.bytes})`);
});
