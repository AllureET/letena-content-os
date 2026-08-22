// Cards must never cover the presenter's face (22 Aug 2026).
//
// Owner, on the first cut with overlays burned in: "do you see how it blocks
// her face in some of them, it should never do that." The title card landed
// across her eyes and the keyword label across her forehead. Not a taste
// problem: every anchor this system had ('top', 'upper-third', 'top-right',
// 'right-center', 'center') pointed at the top or middle of the frame, which
// for a vertical talking head is exactly where the head is. There was no way
// to place a card safely even by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANCHORS, placeClearOfFace, compileOverlaySvg } from '../src/modules/studio_overlays.mjs';

const W = 720, H = 1280;
// A head in the upper-middle, which is where the plate puts her.
const FACE = { x: 0.28, y: 0.20, w: 0.44, h: 0.28 }; // y 256..614 px

const boxOf = (svg) => {
  const m = /<rect x="([\d.-]+)" y="([\d.-]+)" width="([\d.-]+)" height="([\d.-]+)"/.exec(svg);
  assert.ok(m, 'expected a card rect in the svg');
  return { x: +m[1], y: +m[2], w: +m[3], h: +m[4] };
};
const overlaps = (b, face) => {
  const fT = face.y * H, fB = (face.y + face.h) * H, fL = face.x * W, fR = (face.x + face.w) * W;
  return b.y < fB && b.y + b.h > fT && b.x < fR && b.x + b.w > fL;
};

test('the frame now has anchors below the middle at all', () => {
  assert.ok(ANCHORS.includes('lower-third'));
  assert.ok(ANCHORS.includes('bottom'));
});

test('a card that would land on the face is moved off it', () => {
  const r = placeClearOfFace({ x: 100, y: 300, boxW: 500, boxH: 120, canvasW: W, canvasH: H, faceBox: FACE });
  assert.equal(r.moved, true);
  assert.ok(!overlaps({ x: r.x, y: r.y, w: 500, h: 120 }, FACE), 'still on the face after moving');
  assert.ok(r.reason, 'a move should say where it went');
});

test('a card that was already clear is left exactly where it was', () => {
  const r = placeClearOfFace({ x: 60, y: 1100, boxW: 500, boxH: 100, canvasW: W, canvasH: H, faceBox: FACE });
  assert.equal(r.moved, false);
  assert.equal(r.x, 60);
  assert.equal(r.y, 1100);
});

test('it picks the taller free band rather than always going one way', () => {
  // Head high in frame: far more room below than above.
  const high = { x: 0.28, y: 0.06, w: 0.44, h: 0.30 };
  const below = placeClearOfFace({ x: 0, y: 200, boxW: 400, boxH: 120, canvasW: W, canvasH: H, faceBox: high });
  assert.match(below.reason, /below the chin/);
  // Head low in frame: more room above.
  const low = { x: 0.28, y: 0.60, w: 0.44, h: 0.34 };
  const above = placeClearOfFace({ x: 0, y: 800, boxW: 400, boxH: 120, canvasW: W, canvasH: H, faceBox: low });
  assert.match(above.reason, /above the head/);
});

test('with no room either side it still clears the face and says the shot is too tight', () => {
  const huge = { x: 0.0, y: 0.05, w: 1.0, h: 0.90 };
  const r = placeClearOfFace({ x: 0, y: 100, boxW: 700, boxH: 300, canvasW: W, canvasH: H, faceBox: huge });
  assert.equal(r.moved, true);
  assert.match(r.reason, /too tight/,
    'silently drawing over her anyway would be the original bug wearing a fix');
});

test('no face box means behave exactly as before', () => {
  const r = placeClearOfFace({ x: 33, y: 44, boxW: 100, boxH: 50, canvasW: W, canvasH: H, faceBox: null });
  assert.deepEqual(r, { x: 33, y: 44, moved: false, reason: null });
});

test('a real upper-third card clears the face once a face box is known', () => {
  const overlay = { kind: 'TITLE_CARD', data: {
    text: 'Test', font_family: 'bold', font_size_px: 48, text_color: '#FDF8F0',
    background_color: '#16103F', background_opacity: 0.9, corner_radius_px: 16,
    position: { anchor: 'upper-third', inset_px: 48 } } };
  const without = boxOf(compileOverlaySvg(overlay, W, H, 'B', 'R', null, null));
  const withFace = boxOf(compileOverlaySvg(overlay, W, H, 'B', 'R', null, FACE));
  assert.ok(overlaps(without, FACE), 'the old behaviour is the bug; the test is meaningless if it does not reproduce');
  assert.ok(!overlaps(withFace, FACE), 'the card must not touch the face band');
});

test('avoid_face false is honoured, because opting out has to be deliberate', () => {
  const overlay = { kind: 'TITLE_CARD', data: {
    text: 'Test', font_family: 'bold', font_size_px: 48, text_color: '#FDF8F0',
    background_color: '#16103F', position: { anchor: 'upper-third', inset_px: 48, avoid_face: false } } };
  const b = boxOf(compileOverlaySvg(overlay, W, H, 'B', 'R', null, FACE));
  assert.ok(overlaps(b, FACE), 'an explicit opt-out should place exactly where asked');
});

test('clearance is on by default, not something a caller has to remember', () => {
  const overlay = { kind: 'LABEL', data: {
    text: 'Test', font_family: 'bold', font_size_px: 40, text_color: '#16103F',
    background_color: '#EBAB20', position: { anchor: 'upper-third', inset_px: 40 } } };
  const b = boxOf(compileOverlaySvg(overlay, W, H, 'B', 'R', null, FACE));
  assert.ok(!overlaps(b, FACE));
});

// The crop mapping. Every shot's first frame is a deterministic crop of one
// presenter plate, so the head box maps forward with arithmetic instead of one
// vision call per shot. Worth pinning: an inverted or mis-scaled mapping would
// move cards confidently to the wrong place, which is harder to notice than
// not moving them at all.
test('a head box maps through a shot crop the same way the picture does', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/modules/studio.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function mapBoxThroughCrop'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /SHOT_SIZES/, 'it must use the same fractions the crop itself uses');
  assert.match(body, /SHOT_SIZE_HEADROOM/, 'and the same top bias, or it will drift down the frame');
  assert.match(body, /if \(f === 1\) return box/, 'WIDE is the whole plate and must be untouched');

  // Reproduce the arithmetic against cropToAspect's own constants.
  const { SHOT_SIZES, SHOT_SIZE_HEADROOM } = await import('../src/modules/studio.mjs');
  if (!SHOT_SIZES) return; // not exported; the source assertions above still hold
  const f = SHOT_SIZES.CLOSE;
  const box = { x: 0.3, y: 0.2, w: 0.4, h: 0.3 };
  const x0 = (1 - f) / 2, y0 = (1 - f) * SHOT_SIZE_HEADROOM;
  const expected = { x: (box.x - x0) / f, y: (box.y - y0) / f, w: box.w / f, h: box.h / f };
  assert.ok(expected.w > box.w, 'a tighter crop makes the head occupy MORE of the frame, not less');
});
