// Video Studio AI-assisted brief import (19 Aug 2026). POST /import-brief
// turns a free-text production brief into a structured DRAFT via the new
// studio_brief_importer agent (apps/api/src/ai/gateway.mjs), without saving
// anything -- exactly like /studio/locks/draft (studio_lock_draft.test.mjs),
// this only tests the endpoints' own plumbing (validation, the agent call,
// and /apply's create-rows-from-a-reviewed-draft behaviour). MOCK mode uses
// a block/regex stand-in (provider.mjs's agent_studio_brief_importer), not a
// real model, so these prove the wiring works, not real draft quality.
//
// The fixture below is an abbreviated version of the real trigger brief,
// "Spotting on the Pill" (a 25s Send-It format clip): real timing markers
// ("0:00-0:02"), real hex colors, a four-line door-card CTA, and icon
// mentions -- the same shape the mock's block parser is tuned to.
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

const SPOTTING_ON_THE_PILL_BRIEF = `
DURATION: 25 seconds
FORMAT: Send-It
ASPECT: 9:16
PRESENTER: One doctor/health-educator presenter talking to camera for the whole duration. NOT six separate shots -- one continuous take with six script beats layered on top.

SCRIPT MOMENTS:
HOOK (0:00-0:02): AM: "ደም ትታያለሽ? ልክ ነሽ" EN: "Seeing spotting? You are not alone."
SHARE (0:02-0:06): AM: "ይሄን ለጓደኛሽ ላኪ" EN: "Share this with a friend who needs it."
REASSURE (0:06-0:09): AM: "አትደንግጪ፣ የተለመደ ነው" EN: "Do not panic, this is common."
EXPLAIN (0:09-0:15): AM: "የሆርሞን እንክብል ስትጀምሪ ደም መፍሰስ የተለመደ ነው" EN: "Spotting when you start the pill is a known, common side effect."
CAVEAT (0:15-0:20): AM: "ደሙ ከቀጠለ ወይም ጠንከር ካለ ሐኪም አማክሪ" EN: "If bleeding continues or gets heavy, talk to a doctor."
CTA (0:20-0:25): AM: "ጥያቄ አለሽ? በቴሌግራም ላኪልን" EN: "Have a question? Message us on Telegram."

TITLE CARD (0:00-0:02): text "የሆርሞን እንክብል ስትወስጂ ደም መፍሰስ?" | font Noto Sans Ethiopic Bold 70-80px | text color #EBAB20 | background #16103F 90% opacity rounded pill | position upper-third | fade out 0.2s

SHARE LABEL (0:02.5-0:05.5): text "ሼር አድርጊ" | 40-44px | text color #FFFFFF | background #CD6962 80% opacity | position top-right | slide-in from left 0.25s | fade out 0.2s

KEYWORD LABEL (0:11-0:15): text "በመጀመሪያዎቹ ሶስት ወራት ላይ የተለመደ ነው" | 48-52px | text color #FFFFFF | background #477287 85% opacity | position right-center | slide-in from right 0.25s

DOOR CARD (0:20-0:25): background #16103F
LINE 1: "DM አርጊን" 64px #EBAB20 fade in at 0:20
LINE 2: "በነፃ ነው" 38px white fade in at 0:20.5
LINE 3: "Link in bio" 32px #477287 fade in at 0:21
LINE 4: "ለጓደኛሽም ላኪላት" 28px white 50% opacity fade in at 0:21.5

ICONS:
- ICON: pill icon (from Flaticon) | position top-left | time 0:00-0:02
- ICON: share arrow icon (from Flaticon) | position top-right | time 0:02.5-0:05.5
- ICON: 3-months calendar icon (from Flaticon) | position right-center | time 0:09-0:15
- ICON: attention icon (from Flaticon) | position center | time 0:15-0:20
- ICON: chat bubble icon (from Flaticon) | position top | time 0:20-0:25

CAPTION:
AM: "ደም ማየት አስፈሪ አይደለም። እንክብል ስትጀምሪ የተለመደ ነው። ጥያቄ ካለሽ ላኪልን።"
EN: "Spotting is not scary. It is common when starting the pill. Message us with questions."
HASHTAGS: #letena #srh #familyplanning
`;

async function newProject(title) {
  const r = await call('POST', '/studio/projects', { title, format: 'send_it', aspect_ratio: '9:16', language: 'am' });
  return r.json();
}

test('drafting a brief returns exactly ONE presenter shot, not one per script moment', async () => {
  const p = await newProject('Spotting on the Pill');
  const r = await call('POST', `/studio/projects/${p.id}/import-brief`, { free_text: SPOTTING_ON_THE_PILL_BRIEF });
  assert.equal(r.statusCode, 200, r.body);
  const draft = r.json();
  assert.equal(typeof draft.presenter_shot, 'object');
  assert.ok(!Array.isArray(draft.presenter_shot), 'presenter_shot must be a single object, never an array of shots');
  assert.equal(draft.presenter_shot.duration_target_s, 25);
  // The full Amharic voiceover spans the whole take -- every script
  // moment's AM text should be present in the one shot's dialogue, not
  // split across several shots.
  assert.ok(draft.presenter_shot.audio.dialogue.includes('ደም ትታያለሽ'), 'HOOK text missing from dialogue');
  assert.ok(draft.presenter_shot.audio.dialogue.includes('ጥያቄ አለሽ'), 'CTA text missing from dialogue');
  assert.equal(draft.presenter_shot.action.temporal_beats.length, 6,
    'six script beats should be recorded as timing beats within the one shot, not as six shots');
});

test('the draft overlays include a TITLE_CARD and a DOOR_CARD with multiple lines', async () => {
  const p = await newProject('Spotting on the Pill 2');
  const r = await call('POST', `/studio/projects/${p.id}/import-brief`, { free_text: SPOTTING_ON_THE_PILL_BRIEF });
  const draft = r.json();
  const titleCard = draft.overlays.find(o => o.kind === 'TITLE_CARD');
  assert.ok(titleCard, 'expected a TITLE_CARD overlay in the draft');
  assert.equal(titleCard.data.text, 'የሆርሞን እንክብል ስትወስጂ ደም መፍሰስ?');
  assert.equal(titleCard.data.text_color, '#EBAB20');
  assert.equal(titleCard.data.background_color, '#16103F');
  assert.equal(titleCard.data.position.anchor, 'upper-third');

  const doorCard = draft.overlays.find(o => o.kind === 'DOOR_CARD');
  assert.ok(doorCard, 'expected a DOOR_CARD overlay in the draft');
  assert.ok(doorCard.data.lines.length >= 4, `expected at least 4 door-card lines, got ${doorCard.data.lines.length}`);
  assert.equal(doorCard.data.background_color, '#16103F');
  assert.equal(doorCard.data.lines[0].text, 'DM አርጊን');
  assert.equal(doorCard.data.lines[0].font_size_px, 64);
});

test('at least one ICON overlay has a null asset_id with a clarifying note about the missing upload', async () => {
  const p = await newProject('Spotting on the Pill 3');
  const r = await call('POST', `/studio/projects/${p.id}/import-brief`, { free_text: SPOTTING_ON_THE_PILL_BRIEF });
  const draft = r.json();
  const icons = draft.overlays.filter(o => o.kind === 'ICON');
  assert.ok(icons.length >= 1, 'expected at least one ICON overlay draft');
  for (const icon of icons) {
    assert.equal(icon.data.asset_id, null, 'an icon overlay must never invent an asset_id');
    assert.ok(icon.note && /upload/i.test(icon.note), `expected icon overlay note to mention uploading the asset, got: ${icon.note}`);
  }
});

test('caption_draft is filled from the brief and never attached to the shot or an overlay', async () => {
  const p = await newProject('Spotting on the Pill 4');
  const r = await call('POST', `/studio/projects/${p.id}/import-brief`, { free_text: SPOTTING_ON_THE_PILL_BRIEF });
  const draft = r.json();
  assert.ok(draft.caption_draft?.includes('#letena'), `expected caption_draft to include the hashtags, got: ${draft.caption_draft}`);
  assert.equal(JSON.stringify(draft.presenter_shot).includes('#letena'), false);
});

test('rejects empty free_text', async () => {
  const p = await newProject('Spotting on the Pill 5');
  const r = await call('POST', `/studio/projects/${p.id}/import-brief`, { free_text: '   ' });
  assert.equal(r.statusCode, 422);
  assert.equal(r.json().code, 'VALIDATION');
});

test('drafting a brief never saves anything: zero shots and zero overlays exist after the draft call', async () => {
  const p = await newProject('Spotting on the Pill 6');
  await call('POST', `/studio/projects/${p.id}/import-brief`, { free_text: SPOTTING_ON_THE_PILL_BRIEF });
  const project = await call('GET', `/studio/projects/${p.id}`);
  assert.equal(project.json().shots.length, 0, 'drafting must never create a shot row by itself');
  const overlays = await call('GET', `/studio/projects/${p.id}/overlays`);
  assert.equal(overlays.json().items.length, 0, 'drafting must never create overlay rows by itself');
});

test('/import-brief/apply creates the presenter shot and every valid overlay from a reviewed draft', async () => {
  const p = await newProject('Spotting on the Pill 7');
  const draftRes = await call('POST', `/studio/projects/${p.id}/import-brief`, { free_text: SPOTTING_ON_THE_PILL_BRIEF });
  const draft = draftRes.json();

  const applyRes = await call('POST', `/studio/projects/${p.id}/import-brief/apply`, draft);
  assert.equal(applyRes.statusCode, 200, applyRes.body);
  const applied = applyRes.json();

  assert.equal(Number(applied.shot.duration_target_s), 25);
  assert.equal(applied.shot.project_id, p.id);

  const nonIconOverlaysInDraft = draft.overlays.filter(o => o.kind !== 'ICON').length;
  assert.equal(applied.overlays_created.length, nonIconOverlaysInDraft,
    'every non-ICON overlay in the draft should have been created (TITLE_CARD, LABEL x2, DOOR_CARD)');

  const iconOverlaysInDraft = draft.overlays.filter(o => o.kind === 'ICON').length;
  assert.equal(applied.overlays_skipped.length, iconOverlaysInDraft,
    'every ICON overlay with a null asset_id should be skipped, not silently dropped or crashed on');
  for (const skipped of applied.overlays_skipped) {
    assert.equal(skipped.kind, 'ICON');
    assert.ok(skipped.reason && skipped.reason.length > 0, 'a skipped overlay must report a specific reason');
  }

  // Confirm the rows are really there.
  const project = await call('GET', `/studio/projects/${p.id}`);
  assert.equal(project.json().shots.length, 1);
  const overlays = await call('GET', `/studio/projects/${p.id}/overlays`);
  assert.equal(overlays.json().items.length, nonIconOverlaysInDraft);
  assert.ok(overlays.json().items.every(o => o.kind !== 'ICON'),
    'no ICON overlay pointing at a null asset_id should ever have been saved');
});

test('/import-brief/apply requires a presenter_shot on the submitted draft', async () => {
  const p = await newProject('Spotting on the Pill 8');
  const r = await call('POST', `/studio/projects/${p.id}/import-brief/apply`, { overlays: [] });
  assert.equal(r.statusCode, 422);
  assert.equal(r.json().code, 'VALIDATION');
});
