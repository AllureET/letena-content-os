// House rules on every image prompt, and deleting failed work (21 Aug 2026).
//
// Owner, after a remix asked to take books off a shelf came back with a
// room full of pottery: "why would your remix prompt say that, cant you set
// some standards for it so it sticks to the main themes always" and "We
// should be able to delete failed ones easier".
//
// The first half: a remix prompt is free text written in the moment, and
// nothing underneath it held the line on Letena's palette, the kind of room
// it is meant to be, or the hard no-print rule that a video engine's output
// check depends on. There is a floor now, appended last to every image
// prompt this module sends, and it says it wins over anything above it.
//
// The second half: Video Studio accumulates dead ends fast and nothing
// could be removed. These are generated artifacts, so a real delete is
// right -- but only behind guards that refuse, by name, anything the
// project still depends on.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.LCOS_AI_PROVIDER = 'MOCK';
process.env.LCOS_ADAPTER_MODE = 'MOCK';
process.env.LCOS_STORAGE_DIR = '/tmp/lcos-houserules-test-storage';

const { buildServer } = await import('../src/server.mjs');
const { pool, q, one } = await import('../src/core.mjs');
const { compileStillPrompt, compileComposePrompt, withHouseRules, HOUSE_IMAGE_RULES } =
  await import('../src/modules/studio.mjs');

let app, token;
const login = async (email) => (await app.inject({ method: 'POST', url: '/api/v1/auth/login',
  payload: { email, password: 'letena-dev-2026' } })).json().token;
const call = (method, url, payload) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` }, payload });

before(async () => { app = await buildServer(); token = await login('producer@letena.local'); });
after(async () => { await app.close(); await pool.end(); });

// ---------- house rules ----------

test('the house rules name the palette, the setting, and the no-print rule', () => {
  for (const must of ['teal', 'mustard', 'terracotta', 'Ethiopian', 'consultation',
    'no books with visible spines', 'no lit screens', 'NEVER draw the Letena logo',
    // Added 22 Aug 2026 after two rounds of the same mistake: told to take
    // the books off the shelf, the model filled it with pottery; told to
    // drop the pottery, it filled it with stacked towels and the room read
    // as a gym. The rule that stops it is not a longer ban list, it is
    // saying what the surfaces are FOR.
    'must be something that room actually uses', 'DECORATIVE CRAFT: none']) {
    assert.ok(HOUSE_IMAGE_RULES.includes(must), `the house rules must state: ${must}`);
  }
});

test('they sit last, so the model weights them over the instruction above', () => {
  const out = withHouseRules('a room full of pottery');
  assert.ok(out.startsWith('a room full of pottery'));
  assert.ok(out.trimEnd().endsWith(HOUSE_IMAGE_RULES.split('\n').pop()));
  assert.match(out, /override anything above them/);
});

test('a lock reference prompt carries them', () => {
  const p = compileStillPrompt({ entity_type: 'ENVIRONMENT', entity_code: 'ENV-T',
    data: { architecture: 'a room' } });
  assert.ok(p.includes(HOUSE_IMAGE_RULES), 'every image prompt, not just the remix that caused this');
});

test('a composed first frame prompt carries them', () => {
  const p = compileComposePrompt({ entity_code: 'CHR-T', data: { name: 'T' } },
    { entity_code: 'ENV-T', data: { architecture: 'a room' } }, null, '9:16', null);
  assert.ok(p.includes(HOUSE_IMAGE_RULES));
});

test('a remix sends the instruction WITH the house rules under it', async () => {
  const proj = (await call('POST', '/studio/projects',
    { title: 'House rules test', format: 'explainer', aspect_ratio: '9:16', language: 'am' })).json();
  const lock = (await call('POST', `/studio/projects/${proj.id}/locks`,
    { level: 'L1_ENTITY', entity_type: 'ENVIRONMENT', entity_code: 'ENV-HR',
      data: { architecture: 'a room' } })).json();
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const ref = (await call('POST', `/studio/locks/${lock.id}/reference/upload`, { image_base64: PNG })).json();
  const r = await call('POST', `/studio/assets/${ref.id}/remix`, { prompt: 'take the books off the shelf' });
  assert.equal(r.statusCode, 200, r.body);
  const asset = await one(`SELECT settings FROM studio.assets WHERE id=$1`, [r.json().asset?.id ?? r.json().id]);
  // The stored prompt is what a person reads back later, so it must be the
  // instruction they gave, not the instruction plus a wall of boilerplate.
  assert.equal(asset.settings.prompt, 'take the books off the shelf');
});

// ---------- deleting failed work ----------

let projectId, shotId, assetId;

test('set up a project with a generated take', async () => {
  projectId = (await call('POST', '/studio/projects',
    { title: 'Delete test', format: 'explainer', aspect_ratio: '9:16', language: 'am' })).json().id;
  shotId = (await call('POST', `/studio/projects/${projectId}/shots`,
    { shot_code: 'SH-DEL', order_index: 0, duration_target_s: 5, story: { beat: 'del' },
      generation: { mode_preference: 'text_to_video' } })).json().id;
  assetId = (await call('POST', `/studio/shots/${shotId}/generate`, {})).json().asset.id;
});

test('an accepted take refuses to be deleted, and says why', async () => {
  await call('POST', `/studio/assets/${assetId}/accept`, {});
  const r = await call('DELETE', `/studio/assets/${assetId}`);
  assert.equal(r.statusCode, 422);
  assert.equal(r.json().guard, 'assetInUse');
  assert.match(r.json().detail, /accepted/);
});

test('a rejected take deletes cleanly and takes its QC reports with it', async () => {
  await call('POST', `/studio/assets/${assetId}/reject`, { note: 'wrong room' });
  const r = await call('DELETE', `/studio/assets/${assetId}`);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(await one(`SELECT id FROM studio.assets WHERE id=$1`, [assetId]), null);
  assert.equal(await one(`SELECT id FROM studio.qc_reports WHERE asset_id=$1`, [assetId]), null);
});

test('a reference a lock still uses refuses to be deleted, naming the lock', async () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const lock = (await call('POST', `/studio/projects/${projectId}/locks`,
    { level: 'L1_ENTITY', entity_type: 'CHARACTER', entity_code: 'CHR-DEL', data: { name: 'Del' } })).json();
  const ref = (await call('POST', `/studio/locks/${lock.id}/reference/upload`, { image_base64: PNG })).json();
  const r = await call('DELETE', `/studio/assets/${ref.id}`);
  assert.equal(r.statusCode, 422);
  assert.match(r.json().detail, /CHR-DEL/);
});

test('a draft shot deletes along with the images made for it', async () => {
  const shot = (await call('POST', `/studio/projects/${projectId}/shots`,
    { shot_code: 'SH-DEL2', order_index: 1, duration_target_s: 5, story: { beat: 'del2' },
      generation: { mode_preference: 'text_to_video' } })).json();
  const a = (await call('POST', `/studio/shots/${shot.id}/generate`, {})).json().asset;
  await call('POST', `/studio/assets/${a.id}/reject`, {});
  const r = await call('DELETE', `/studio/shots/${shot.id}`);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().deleted_assets, 1);
  assert.equal(await one(`SELECT id FROM studio.shots WHERE id=$1`, [shot.id]), null);
});

test('an environment reference is generated as an empty room', () => {
  const p = compileStillPrompt({ entity_type: 'ENVIRONMENT', entity_code: 'ENV-T',
    data: { architecture: 'a consulting room' } });
  assert.match(p, /\[EMPTY ROOM\]/);
  assert.match(p, /No people/,
    'left unsaid the model puts someone in the chair, and that reference then conditions every composed frame');
});

test('a character reference is NOT told the room is empty', () => {
  const p = compileStillPrompt({ entity_type: 'CHARACTER', entity_code: 'CHR-T', data: { name: 'T' } });
  assert.ok(!p.includes('[EMPTY ROOM]'), 'the rule is about places, and a character lock is a person');
});

test('a shot whose render failed can be deleted even though it never left NEEDS_REVIEW', async () => {
  // The exact trap this replaced: no video to reject, wrong status to
  // delete, so the shot could not be removed at all.
  const shot = (await call('POST', `/studio/projects/${projectId}/shots`,
    { shot_code: 'SH-STUCK', order_index: 8, duration_target_s: 5, story: { beat: 'stuck' },
      generation: { mode_preference: 'text_to_video' } })).json();
  await q(`UPDATE studio.shots SET status='NEEDS_REVIEW' WHERE id=$1`, [shot.id]);
  const r = await call('DELETE', `/studio/shots/${shot.id}`);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(await one(`SELECT id FROM studio.shots WHERE id=$1`, [shot.id]), null);
});

test('a shot with a composed first frame does not block its own deletion', async () => {
  // The guard was self-referential on the first real attempt: a shot's own
  // first frame is by definition "in use by a shot", and that shot is the
  // one going away. It reported "SH-01 cannot be deleted: SH-01 uses it as
  // its first frame" and refused every shot deletion outright.
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const ch = (await call('POST', `/studio/projects/${projectId}/locks`,
    { level: 'L1_ENTITY', entity_type: 'CHARACTER', entity_code: 'CHR-SELF', data: { name: 'Self' } })).json();
  const en = (await call('POST', `/studio/projects/${projectId}/locks`,
    { level: 'L1_ENTITY', entity_type: 'ENVIRONMENT', entity_code: 'ENV-SELF', data: { architecture: 'a room' } })).json();
  await call('POST', `/studio/locks/${ch.id}/reference/upload`, { image_base64: PNG });
  await call('POST', `/studio/locks/${en.id}/reference/upload`, { image_base64: PNG });
  await call('POST', `/studio/locks/${ch.id}/approve`, {});
  await call('POST', `/studio/locks/${en.id}/approve`, {});
  const shot = (await call('POST', `/studio/projects/${projectId}/shots`,
    { shot_code: 'SH-SELF', order_index: 9, duration_target_s: 5, story: { beat: 'self' },
      continuity: { characters: ['CHR-SELF'], environment: 'ENV-SELF' },
      generation: { mode_preference: 'image_to_video' } })).json();
  const frame = await call('POST', `/studio/shots/${shot.id}/compose-first-frame`, {});
  assert.equal(frame.statusCode, 200, frame.body);

  const r = await call('DELETE', `/studio/shots/${shot.id}`);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(await one(`SELECT id FROM studio.assets WHERE id=$1`, [frame.json().asset.id]), null,
    'the frame goes with the shot it belonged to');
  // The locks that frame was composed from are untouched.
  const lock = await one(`SELECT reference_asset_ids FROM studio.locks WHERE id=$1`, [ch.id]);
  assert.equal(lock.reference_asset_ids.length, 1);
});

test('a shot holding an accepted video is not deletable', async () => {
  const shot = (await call('POST', `/studio/projects/${projectId}/shots`,
    { shot_code: 'SH-KEEP', order_index: 2, duration_target_s: 5, story: { beat: 'keep' },
      generation: { mode_preference: 'text_to_video' } })).json();
  const a = (await call('POST', `/studio/shots/${shot.id}/generate`, {})).json().asset;
  await call('POST', `/studio/assets/${a.id}/accept`, {});
  const r = await call('DELETE', `/studio/shots/${shot.id}`);
  assert.equal(r.statusCode, 422);
  assert.equal(r.json().guard, 'shotAccepted');
});

test('clearing rejected takes removes them and reports anything it kept', async () => {
  const shot = (await call('POST', `/studio/projects/${projectId}/shots`,
    { shot_code: 'SH-PRUNE', order_index: 3, duration_target_s: 5, story: { beat: 'prune' },
      generation: { mode_preference: 'text_to_video' } })).json();
  for (let i = 0; i < 2; i++) {
    const a = (await call('POST', `/studio/shots/${shot.id}/generate`, {})).json().asset;
    await call('POST', `/studio/assets/${a.id}/reject`, {});
  }
  const r = await call('POST', `/studio/projects/${projectId}/assets/prune-rejected`, {});
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(r.json().deleted.length >= 2);
  const left = await q(`SELECT id FROM studio.assets WHERE project_id=$1 AND status='REJECTED'`, [projectId]);
  assert.equal(left.rows.length, 0);
});

test('deleting something that is already gone is a 404, not a silent success', async () => {
  const r = await call('DELETE', '/studio/assets/00000000-0000-0000-0000-000000000000');
  assert.equal(r.statusCode, 404);
});
