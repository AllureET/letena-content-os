// Video Studio burned-in overlays (0035_studio_overlays.sql, 19 Aug 2026):
// title cards, on-screen labels, the closing door/CTA card, and icon
// moments -- closing the gap the real "Spotting on the Pill" brief exposed
// (assemble() had zero capability to burn anything in before tonight). Same
// login/token/call() `/api/v1`-prefixed helper pattern as studio_archive.
// test.mjs / studio_assembly.test.mjs; this file does not import or modify
// studio.test.mjs and none of these tests touch the tests those files
// already own.
//
// Coverage:
//   - creating each of the four kinds with valid data succeeds, and each
//     is rejected (422 VALIDATION, specific message) with invalid data
//   - PATCH un-approves an approved overlay (mirrors the lock-revision
//     "an edit invalidates the prior approval" pattern)
//   - the TITLE_CARD/DOOR_CARD same-anchor time-collision guard on create
//   - assemble() refuses (422 GUARD_FAILED, naming which ones) when any
//     overlay on the project is unapproved, and succeeds once every
//     overlay is approved, recording overlay_count on the FINAL_CUT asset
//     -- exercised via MOCK adapter mode (no real ffmpeg needed for the
//     guard itself, since it runs before the MOCK/real branch)
//   - compileOverlaySvg unit tests (no ffmpeg) for a TITLE_CARD and for
//     DOOR_CARD's multi-line case, asserting hex colors/text/rx appear
//   - an end-to-end test that actually runs real ffmpeg: builds a tiny
//     lavfi base video, burns in one approved TITLE_CARD overlay through
//     the exact same buildOverlayFilterGraph/compileOverlayLayerSvg code
//     path assemble()'s real (non-MOCK) branch uses, and asserts the
//     output file exists with nonzero size. This does NOT go through the
//     HTTP /assemble route in real-adapter mode, because that would also
//     require real Kling/Veo generation for the fixture shots (no
//     credentials in this environment) -- same reasoning
//     studio_assembly.test.mjs already documents for why its own
//     crossfade-mismatch guard is unit-tested via describeClipMismatch
//     directly rather than through the HTTP route. ffmpeg IS installed in
//     this environment, so the test runs for real rather than skipping;
//     it only skips gracefully if `which ffmpeg` fails.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileP = promisify(execFile);

process.env.NODE_ENV = 'test';
process.env.LCOS_AI_PROVIDER = 'MOCK';
process.env.LCOS_ADAPTER_MODE = 'MOCK';
process.env.LCOS_STORAGE_DIR = '/tmp/lcos-test-storage';

const { buildServer } = await import('../src/server.mjs');
const { pool } = await import('../src/core.mjs');
const { compileOverlaySvg, buildOverlayFilterGraph, compileOverlayLayerSvg, loadEthiopicFontsBase64 } =
  await import('../src/modules/studio_overlays.mjs');

let app, token;
const login = async (email) => (await app.inject({ method: 'POST', url: '/api/v1/auth/login',
  payload: { email, password: 'letena-dev-2026' } })).json().token;
const call = (method, url, payload) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` }, payload });

before(async () => {
  app = await buildServer();
  token = await login('producer@letena.local'); // producer holds studio.write/generate/approve and asset.manage
});
after(async () => { await app.close(); await pool.end(); });

const newProject = async (title) => {
  const r = await call('POST', '/studio/projects', { title, format: 'explainer', aspect_ratio: '9:16', language: 'am' });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};

const TITLE_CARD_DATA = {
  text: 'DM አርጊን ብነጽ እንረዳሻለን!',
  font_family: 'bold', font_size_px: 40, text_color: '#EBAB20',
  background_color: '#16103F', background_opacity: 0.9, corner_radius_px: 16,
  position: { anchor: 'top', inset_px: 40 },
  animation_in: { type: 'fade', duration_s: 0.4 },
  animation_out: { type: 'fade', duration_s: 0.4 },
};

const LABEL_DATA = {
  text: 'Share this', font_family: 'regular', font_size_px: 24, text_color: '#FFFFFF',
  background_color: '#CD6962', background_opacity: 1, corner_radius_px: 10,
  position: { anchor: 'top-right', inset_px: 24 },
  animation_in: { type: 'slide-left', duration_s: 0.5 },
  animation_out: { type: 'none', duration_s: 0 },
};

const DOOR_CARD_DATA = {
  background_color: '#16103F',
  lines: [
    { text: 'Line one', font_family: 'bold', font_size_px: 36, text_color: '#FFFFFF', delay_s: 0 },
    { text: 'Line two', font_family: 'regular', font_size_px: 24, text_color: '#EBAB20', delay_s: 0.4 },
    { text: 'Line three', font_family: 'regular', font_size_px: 24, text_color: '#EBAB20', delay_s: 0.8 },
    { text: 'Line four', font_family: 'regular', font_size_px: 24, text_color: '#EBAB20', delay_s: 1.2 },
  ],
};

// ---------------------------------------------------------------------
// Fixture: one ICON-kind asset in the library, needed for ICON overlay
// creation tests (data.asset_id must resolve to an existing ICON asset --
// see the POST /studio/projects/:id/overlays route).
// ---------------------------------------------------------------------
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
let iconAssetId, nonIconAssetId;

test('fixture: create an ICON asset and a non-ICON asset in the library', async () => {
  const icon = await call('POST', '/production/assets',
    { title: 'test icon', kind: 'ICON', mime_type: 'image/png', content_base64: TINY_PNG_B64 });
  assert.equal(icon.statusCode, 201, icon.body);
  iconAssetId = icon.json().id;

  const nonIcon = await call('POST', '/production/assets',
    { title: 'test background', kind: 'BACKGROUND', mime_type: 'image/png', content_base64: TINY_PNG_B64 });
  assert.equal(nonIcon.statusCode, 201, nonIcon.body);
  nonIconAssetId = nonIcon.json().id;
});

// ---------------------------------------------------------------------
// Creating each kind with valid data, and rejecting invalid data.
// ---------------------------------------------------------------------
let projectId;

test('fixture: create a project for overlay tests', async () => {
  const p = await newProject('Overlay kinds fixture');
  projectId = p.id;
});

test('TITLE_CARD: valid data creates an overlay', async () => {
  const r = await call('POST', `/studio/projects/${projectId}/overlays`,
    { kind: 'TITLE_CARD', start_s: 0, end_s: 2, data: TITLE_CARD_DATA });
  assert.equal(r.statusCode, 200, r.body);
  const o = r.json();
  assert.equal(o.kind, 'TITLE_CARD');
  assert.equal(Number(o.start_s), 0);
  assert.equal(Number(o.end_s), 2);
  assert.equal(o.data.text, TITLE_CARD_DATA.text);
  assert.equal(o.approved_at, null);
});

test('TITLE_CARD: missing text is rejected with a specific 422', async () => {
  const r = await call('POST', `/studio/projects/${projectId}/overlays`,
    { kind: 'TITLE_CARD', start_s: 10, end_s: 12, data: { ...TITLE_CARD_DATA, text: '' } });
  assert.equal(r.statusCode, 422, r.body);
  assert.equal(r.json().code, 'VALIDATION');
  assert.ok(r.json().detail.includes('data.text is required'), r.json().detail);
});

test('TITLE_CARD: bad hex color is rejected with a specific 422', async () => {
  const r = await call('POST', `/studio/projects/${projectId}/overlays`,
    { kind: 'TITLE_CARD', start_s: 10, end_s: 12, data: { ...TITLE_CARD_DATA, text_color: 'orange' } });
  assert.equal(r.statusCode, 422, r.body);
  assert.equal(r.json().code, 'VALIDATION');
  assert.ok(r.json().detail.includes('data.text_color must be a #rrggbb hex color'), r.json().detail);
});

test('TITLE_CARD: bad anchor is rejected with a specific 422', async () => {
  const r = await call('POST', `/studio/projects/${projectId}/overlays`,
    { kind: 'TITLE_CARD', start_s: 10, end_s: 12, data: { ...TITLE_CARD_DATA, position: { anchor: 'bottom-left', inset_px: 10 } } });
  assert.equal(r.statusCode, 422, r.body);
  assert.equal(r.json().code, 'VALIDATION');
  assert.ok(r.json().detail.includes('data.position.anchor must be one of'), r.json().detail);
});

test('LABEL: valid data creates an overlay', async () => {
  const r = await call('POST', `/studio/projects/${projectId}/overlays`,
    { kind: 'LABEL', start_s: 2, end_s: 6, data: LABEL_DATA });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().kind, 'LABEL');
});

test('LABEL: bad animation_in.type is rejected with a specific 422', async () => {
  const r = await call('POST', `/studio/projects/${projectId}/overlays`,
    { kind: 'LABEL', start_s: 20, end_s: 22, data: { ...LABEL_DATA, animation_in: { type: 'zoom', duration_s: 1 } } });
  assert.equal(r.statusCode, 422, r.body);
  assert.equal(r.json().code, 'VALIDATION');
  assert.ok(r.json().detail.includes('data.animation_in.type must be one of'), r.json().detail);
});

test('DOOR_CARD: valid data with four staggered lines creates an overlay', async () => {
  const r = await call('POST', `/studio/projects/${projectId}/overlays`,
    { kind: 'DOOR_CARD', start_s: 20, end_s: 25, data: DOOR_CARD_DATA });
  assert.equal(r.statusCode, 200, r.body);
  const o = r.json();
  assert.equal(o.kind, 'DOOR_CARD');
  assert.equal(o.data.lines.length, 4);
});

test('DOOR_CARD: empty lines array is rejected with a specific 422', async () => {
  const r = await call('POST', `/studio/projects/${projectId}/overlays`,
    { kind: 'DOOR_CARD', start_s: 40, end_s: 45, data: { background_color: '#16103F', lines: [] } });
  assert.equal(r.statusCode, 422, r.body);
  assert.equal(r.json().code, 'VALIDATION');
  assert.ok(r.json().detail.includes('data.lines must be a non-empty array'), r.json().detail);
});

test('DOOR_CARD: a line missing text is rejected, naming the exact line index', async () => {
  const r = await call('POST', `/studio/projects/${projectId}/overlays`,
    { kind: 'DOOR_CARD', start_s: 40, end_s: 45,
      data: { background_color: '#16103F', lines: [{ text: 'ok', delay_s: 0 }, { text: '', delay_s: 0.4 }] } });
  assert.equal(r.statusCode, 422, r.body);
  assert.equal(r.json().code, 'VALIDATION');
  assert.ok(r.json().detail.includes('data.lines[1].text is required'), r.json().detail);
});

test('ICON: valid data with a real ICON asset creates an overlay', async () => {
  const r = await call('POST', `/studio/projects/${projectId}/overlays`,
    { kind: 'ICON', start_s: 5, end_s: 8,
      data: { asset_id: iconAssetId, position: { anchor: 'top-right', inset_px: 20 }, width_px: 80 } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().kind, 'ICON');
});

test('ICON: an asset_id that does not resolve to an existing asset is rejected', async () => {
  const r = await call('POST', `/studio/projects/${projectId}/overlays`,
    { kind: 'ICON', start_s: 60, end_s: 62,
      data: { asset_id: '00000000-0000-0000-0000-000000000000', position: { anchor: 'top-right', inset_px: 20 }, width_px: 80 } });
  assert.equal(r.statusCode, 422, r.body);
  assert.equal(r.json().code, 'VALIDATION');
  assert.ok(r.json().detail.includes('does not resolve to an existing asset'), r.json().detail);
});

test('ICON: an asset_id that resolves to a non-ICON asset is rejected, naming the actual kind', async () => {
  const r = await call('POST', `/studio/projects/${projectId}/overlays`,
    { kind: 'ICON', start_s: 60, end_s: 62,
      data: { asset_id: nonIconAssetId, position: { anchor: 'top-right', inset_px: 20 }, width_px: 80 } });
  assert.equal(r.statusCode, 422, r.body);
  assert.equal(r.json().code, 'VALIDATION');
  assert.ok(r.json().detail.includes('BACKGROUND'), r.json().detail);
  assert.ok(r.json().detail.includes('not ICON'), r.json().detail);
});

test('an unrecognized kind is rejected with a specific 422', async () => {
  const r = await call('POST', `/studio/projects/${projectId}/overlays`,
    { kind: 'BANNER', start_s: 0, end_s: 2, data: {} });
  assert.equal(r.statusCode, 422, r.body);
  assert.equal(r.json().code, 'VALIDATION');
  assert.ok(r.json().detail.includes('kind must be one of'), r.json().detail);
});

test('end_s must be greater than start_s', async () => {
  const r = await call('POST', `/studio/projects/${projectId}/overlays`,
    { kind: 'TITLE_CARD', start_s: 5, end_s: 5, data: TITLE_CARD_DATA });
  assert.equal(r.statusCode, 422, r.body);
  assert.equal(r.json().code, 'VALIDATION');
});

// ---------------------------------------------------------------------
// Same-anchor time-collision guard (TITLE_CARD/DOOR_CARD only).
// ---------------------------------------------------------------------
test('two TITLE_CARDs at the same anchor with overlapping time ranges collide on create', async () => {
  const first = await call('POST', `/studio/projects/${projectId}/overlays`,
    { kind: 'TITLE_CARD', start_s: 100, end_s: 105, data: { ...TITLE_CARD_DATA, position: { anchor: 'center', inset_px: 0 } } });
  assert.equal(first.statusCode, 200, first.body);

  const second = await call('POST', `/studio/projects/${projectId}/overlays`,
    { kind: 'TITLE_CARD', start_s: 102, end_s: 108, data: { ...TITLE_CARD_DATA, position: { anchor: 'center', inset_px: 0 } } });
  assert.equal(second.statusCode, 422, second.body);
  assert.equal(second.json().code, 'GUARD_FAILED');
  assert.ok(second.json().detail.includes('overlaps with existing TITLE_CARD'), second.json().detail);
});

test('two TITLE_CARDs at DIFFERENT anchors with the same overlapping time do not collide', async () => {
  const r = await call('POST', `/studio/projects/${projectId}/overlays`,
    { kind: 'TITLE_CARD', start_s: 100, end_s: 105, data: { ...TITLE_CARD_DATA, position: { anchor: 'top-right', inset_px: 0 } } });
  assert.equal(r.statusCode, 200, r.body);
});

test('two DOOR_CARDs (always full-screen) with overlapping time collide regardless of any position field', async () => {
  const first = await call('POST', `/studio/projects/${projectId}/overlays`,
    { kind: 'DOOR_CARD', start_s: 200, end_s: 205, data: DOOR_CARD_DATA });
  assert.equal(first.statusCode, 200, first.body);
  const second = await call('POST', `/studio/projects/${projectId}/overlays`,
    { kind: 'DOOR_CARD', start_s: 203, end_s: 208, data: DOOR_CARD_DATA });
  assert.equal(second.statusCode, 422, second.body);
  assert.equal(second.json().code, 'GUARD_FAILED');
});

// ---------------------------------------------------------------------
// Approve / PATCH un-approves.
// ---------------------------------------------------------------------
let approveTestOverlayId;

test('fixture: create an overlay to approve and edit', async () => {
  const r = await call('POST', `/studio/projects/${projectId}/overlays`,
    { kind: 'LABEL', start_s: 300, end_s: 302, data: LABEL_DATA });
  assert.equal(r.statusCode, 200, r.body);
  approveTestOverlayId = r.json().id;
});

test('approving an overlay sets approved_at/approved_by', async () => {
  const r = await call('POST', `/studio/overlays/${approveTestOverlayId}/approve`, {});
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(r.json().approved_at);
});

test('editing an approved overlay un-approves it', async () => {
  const r = await call('PATCH', `/studio/overlays/${approveTestOverlayId}`,
    { data: { ...LABEL_DATA, text: 'Share this now' } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().approved_at, null);
  assert.equal(r.json().data.text, 'Share this now');
});

test('deleting an overlay removes it from the project list', async () => {
  const del = await call('DELETE', `/studio/overlays/${approveTestOverlayId}`);
  assert.equal(del.statusCode, 200, del.body);
  const list = await call('GET', `/studio/projects/${projectId}/overlays`);
  assert.ok(!list.json().items.some(o => o.id === approveTestOverlayId));
});

// ---------------------------------------------------------------------
// Assemble refuses when unapproved overlays exist; succeeds once every
// overlay is approved. Own project, MOCK adapter mode (the unapproved
// guard runs before the MOCK/real branch, so it is fully exercisable
// here; MOCK mode itself never claims a real burn-in happened, matching
// the transition/music MOCK branches' own honesty pattern).
// ---------------------------------------------------------------------
let assembleProjectId;

const newAcceptedShot = async (projId, shotCode, orderIndex) => {
  const s = await call('POST', `/studio/projects/${projId}/shots`,
    { shot_code: shotCode, order_index: orderIndex, duration_target_s: 4, story: { beat: 'a beat' } });
  assert.equal(s.statusCode, 200, s.body);
  const shot = s.json();
  const gen = await call('POST', `/studio/shots/${shot.id}/generate`, {});
  assert.equal(gen.statusCode, 200, gen.body);
  const assetId = gen.json().asset.id;
  const accept = await call('POST', `/studio/assets/${assetId}/accept`, {});
  assert.equal(accept.statusCode, 200, accept.body);
  return shot;
};

test('fixture: build an assemble-guard project with one accepted shot', async () => {
  const p = await newProject('Overlay assemble guard fixture');
  assembleProjectId = p.id;
  await newAcceptedShot(assembleProjectId, 'SH-010', 0);
});

test('assemble refuses with 422 GUARD_FAILED naming the unapproved overlay', async () => {
  const ov = await call('POST', `/studio/projects/${assembleProjectId}/overlays`,
    { kind: 'TITLE_CARD', start_s: 0, end_s: 2, data: TITLE_CARD_DATA });
  assert.equal(ov.statusCode, 200, ov.body);

  const r = await call('POST', `/studio/projects/${assembleProjectId}/assemble`, {});
  assert.equal(r.statusCode, 422, r.body);
  assert.equal(r.json().code, 'GUARD_FAILED');
  assert.ok(r.json().detail.includes('every overlay needs to be approved'), r.json().detail);
  assert.ok(r.json().detail.includes('TITLE_CARD'), r.json().detail);
  assert.ok(r.json().detail.includes(ov.json().id), r.json().detail);
});

test('assemble succeeds once the overlay is approved, and records overlay_count on the FINAL_CUT asset', async () => {
  const overlays = (await call('GET', `/studio/projects/${assembleProjectId}/overlays`)).json().items;
  await call('POST', `/studio/overlays/${overlays[0].id}/approve`, {});

  const r = await call('POST', `/studio/projects/${assembleProjectId}/assemble`, {});
  assert.equal(r.statusCode, 200, r.body);
  const finalAsset = r.json();
  assert.equal(finalAsset.kind, 'FINAL_CUT');
  assert.equal(finalAsset.settings.overlay_count, 1);
  assert.equal(finalAsset.generator.mock, true, 'MOCK mode must never claim a real burn-in happened');
});

test('a project with zero overlays assembles exactly as before (no overlay_count field at all)', async () => {
  const p = await newProject('Zero-overlay regression project');
  await newAcceptedShot(p.id, 'SH-010', 0);
  const r = await call('POST', `/studio/projects/${p.id}/assemble`, {});
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().settings.overlay_count, undefined);
});

// ---------------------------------------------------------------------
// compileOverlaySvg: pure, no ffmpeg needed.
// ---------------------------------------------------------------------
test('compileOverlaySvg: TITLE_CARD contains the exact hex colors, the text, and the corner radius', () => {
  const overlay = { kind: 'TITLE_CARD', data: TITLE_CARD_DATA };
  const svg = compileOverlaySvg(overlay, 1080, 1920, 'BOLDFONTBASE64', 'REGULARFONTBASE64');
  assert.ok(svg.includes('<svg'), svg.slice(0, 200));
  assert.ok(svg.includes(TITLE_CARD_DATA.text), 'must contain the exact title text');
  assert.ok(svg.includes('fill="#16103F"'), 'must contain the exact background hex color');
  assert.ok(svg.includes('fill="#EBAB20"'), 'must contain the exact text hex color');
  assert.ok(svg.includes('rx="16"'), 'must contain the exact corner radius');
  assert.ok(svg.includes('BOLDFONTBASE64'), 'bold font_family must select the embedded bold font data');
});

test('compileOverlaySvg: LABEL with font_family regular selects the embedded regular font data', () => {
  const overlay = { kind: 'LABEL', data: LABEL_DATA };
  const svg = compileOverlaySvg(overlay, 1080, 1920, 'BOLDFONTBASE64', 'REGULARFONTBASE64');
  assert.ok(svg.includes('font-family="EthiopicRegular"'));
  assert.ok(svg.includes('fill="#CD6962"'));
});

test('compileOverlaySvg: DOOR_CARD multi-line case contains every line\'s exact text and hex color', () => {
  const overlay = { kind: 'DOOR_CARD', data: DOOR_CARD_DATA };
  const svg = compileOverlaySvg(overlay, 1080, 1920, 'BOLDFONTBASE64', 'REGULARFONTBASE64');
  for (const line of DOOR_CARD_DATA.lines) {
    assert.ok(svg.includes(line.text), `missing line text: ${line.text}`);
  }
  assert.ok(svg.includes('fill="#16103F"'), 'must contain the card background hex color');
  assert.ok(svg.includes('fill="#FFFFFF"'), 'must contain line one\'s hex color');
  assert.ok(svg.includes('fill="#EBAB20"'), 'must contain the other lines\' hex color');
  // Full-screen background per the DOOR_CARD schema (no position field):
  assert.ok(svg.includes('width="1080" height="1920"'), svg.slice(0, 300));
});

test('compileOverlaySvg: an unknown kind throws rather than silently returning something', () => {
  assert.throws(() => compileOverlaySvg({ kind: 'BANNER', data: {} }, 1080, 1920, '', ''));
});

// ---------------------------------------------------------------------
// buildOverlayFilterGraph: pure filter-graph construction.
// ---------------------------------------------------------------------
test('buildOverlayFilterGraph: a DOOR_CARD expands into a background layer plus one layer per line', () => {
  const overlay = { id: 'ov-door', kind: 'DOOR_CARD', start_s: 20, end_s: 25, data: DOOR_CARD_DATA };
  const graph = buildOverlayFilterGraph([overlay], 30, 1080, 1920);
  assert.equal(graph.layers.length, 1 + DOOR_CARD_DATA.lines.length);
  assert.equal(graph.layers[0].role, 'background');
  assert.equal(graph.layers[1].role, 'line');
  assert.equal(graph.layers[1].startS, 20); // delay_s 0
  assert.equal(graph.layers[2].startS, 20.4); // delay_s 0.4
  assert.ok(graph.filterComplex.includes('[1:v]'), 'filter graph must reference input 1 (the first layer)');
  assert.ok(graph.outputLabel === '[vout]');
});

test('buildOverlayFilterGraph: a TITLE_CARD/LABEL/ICON overlay is exactly one layer', () => {
  const overlay = { id: 'ov-title', kind: 'TITLE_CARD', start_s: 0, end_s: 2, data: TITLE_CARD_DATA };
  const graph = buildOverlayFilterGraph([overlay], 10, 1080, 1920);
  assert.equal(graph.layers.length, 1);
  assert.equal(graph.layers[0].role, 'card');
});

test('buildOverlayFilterGraph: an overlay starting at or after the base video duration is dropped', () => {
  const overlay = { id: 'ov-late', kind: 'TITLE_CARD', start_s: 50, end_s: 52, data: TITLE_CARD_DATA };
  const graph = buildOverlayFilterGraph([overlay], 10, 1080, 1920);
  assert.equal(graph.layers.length, 0);
  assert.equal(graph.outputLabel, '[0:v]');
});

test('buildOverlayFilterGraph: no overlays returns a pass-through output label', () => {
  const graph = buildOverlayFilterGraph([], 10, 1080, 1920);
  assert.equal(graph.layers.length, 0);
  assert.equal(graph.filterComplex, '');
  assert.equal(graph.outputLabel, '[0:v]');
});

// ---------------------------------------------------------------------
// End-to-end, real ffmpeg: builds a tiny base video and burns in one
// approved TITLE_CARD overlay through the exact code path assemble()'s
// real branch uses, asserting the output file exists with nonzero size.
// Skips gracefully if ffmpeg is not on PATH; it is installed in this
// environment, so this runs for real.
// ---------------------------------------------------------------------
test('end-to-end: real ffmpeg burns a TITLE_CARD overlay into a tiny base video', async (t) => {
  try { await execFileP('which', ['ffmpeg']); }
  catch { t.skip('ffmpeg not available in this environment'); return; }

  const workDir = await mkdtemp(join(tmpdir(), 'lcos-overlay-e2e-'));
  try {
    const basePath = join(workDir, 'base.mp4');
    await execFileP('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=270x480:rate=15:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', basePath]);
    const baseStat = await stat(basePath);
    assert.ok(baseStat.size > 0, 'fixture base video must actually be produced');

    const overlay = { id: 'ov-e2e', kind: 'TITLE_CARD', start_s: 0, end_s: 1, data: TITLE_CARD_DATA };
    const fonts = await loadEthiopicFontsBase64();
    assert.ok(fonts.bold.length > 1000, 'the embedded bold font must be real base64 content, not a stub');
    const graph = buildOverlayFilterGraph([overlay], 2, 270, 480);
    assert.equal(graph.layers.length, 1);

    const svg = compileOverlayLayerSvg(graph.layers[0], overlay, 270, 480, fonts.bold, fonts.regular);
    const svgPath = join(workDir, 'overlay-0.svg');
    await writeFile(svgPath, svg, 'utf8');

    const outPath = join(workDir, 'out.mp4');
    await execFileP('ffmpeg', ['-y', '-i', basePath,
      '-itsoffset', graph.layers[0].startS.toFixed(3), '-loop', '1',
      '-t', (graph.layers[0].endS - graph.layers[0].startS).toFixed(3), '-i', svgPath,
      '-filter_complex', graph.filterComplex, '-map', graph.outputLabel, '-map', '0:a?',
      '-c:v', 'libx264', outPath]);

    const outStat = await stat(outPath);
    assert.ok(outStat.size > 0, 'the overlay burn-in must produce a real, nonzero-size output file');
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
