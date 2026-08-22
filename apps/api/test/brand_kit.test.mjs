// The brand kit as code (22 Aug 2026).
//
// Owner, after I invented three hex codes for overlay cards: "you have the
// real letena values in this project and in the brand kit in the github and
// many other places.. Make sure its somewhere easily findable in the OS."
//
// The values existed in at least four places -- the Brand Style Guide, the
// Flutter app's letena_theme.dart, the LCOS token doc, the GitHub brand kit --
// and none were reachable from the code that burns colour into video. Four
// sources of truth and no source of truth are the same thing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.LCOS_AI_PROVIDER = 'MOCK';
process.env.LCOS_ADAPTER_MODE = 'MOCK';

const { buildServer } = await import('../src/server.mjs');
const { pool } = await import('../src/core.mjs');
const { LETENA_BRAND, BRAND_HEX, brandColor } = await import('../src/brand.mjs');

let app;
before(async () => { app = await buildServer(); });
after(async () => { await app.close(); await pool.end(); });

test('the five identity colours are the style guide values', () => {
  assert.equal(LETENA_BRAND.colors.marigold.hex, '#EBAB20');
  assert.equal(LETENA_BRAND.colors.fuzzyWuzzy.hex, '#CD6962');
  assert.equal(LETENA_BRAND.colors.jellyBeanBlue.hex, '#477287');
  assert.equal(LETENA_BRAND.colors.cetaceanBlue.hex, '#16103F');
  assert.equal(LETENA_BRAND.colors.plumpPurple.hex, '#5D489C');
});

test('cream is the ground, and it is not white', () => {
  assert.equal(LETENA_BRAND.neutrals.cream.hex, '#FDF8F0');
  assert.notEqual(LETENA_BRAND.neutrals.cream.hex.toUpperCase(), '#FFFFFF');
});

test('brandColor resolves a name, passes a literal hex, and refuses anything else', () => {
  assert.equal(brandColor('marigold'), '#EBAB20');
  assert.equal(brandColor('#16103F'), '#16103F');
  assert.equal(brandColor('#16103f'), '#16103F', 'case is normalised so two spellings are one colour');
  assert.throws(() => brandColor('teal-ish'), /not a Letena brand colour/);
  assert.throws(() => brandColor('teal-ish'), /brand\.mjs/,
    'the error should say where to look, since the whole problem was not knowing where to look');
});

test('an unknown colour throws rather than quietly becoming black', () => {
  assert.throws(() => brandColor('#GGGGGG'));
  assert.throws(() => brandColor(''));
  assert.throws(() => brandColor(null));
});

test('every overlay pairing uses real brand values on both sides', () => {
  const known = new Set(Object.values(BRAND_HEX));
  for (const [name, pair] of Object.entries(LETENA_BRAND.overlayPairs)) {
    assert.ok(known.has(pair.background), `${name} background ${pair.background} is not a brand colour`);
    assert.ok(known.has(pair.text), `${name} text ${pair.text} is not a brand colour`);
    assert.ok(pair.use, `${name} should say what it is for`);
  }
});

test('the logo is a file and a rule, never a colour to be drawn', () => {
  assert.match(LETENA_BRAND.logo.rule, /[Nn]ever ask an image model to draw/);
  assert.equal(LETENA_BRAND.logo.assetKind, 'ICON');
  assert.ok(LETENA_BRAND.logo.status, 'the page has to be able to say whether the real file exists yet');
});

test('the kit is served without authentication', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/v1/brand' });
  assert.equal(r.statusCode, 200, r.body);
  const b = r.json();
  assert.equal(b.colors.marigold.hex, '#EBAB20');
  assert.equal(b.hex.cetaceanBlue, '#16103F');
  assert.ok(Array.isArray(b.rules) && b.rules.length);
});

test('a colour is not a secret; requiring a token would recreate the problem', async () => {
  const src = await (await import('node:fs/promises')).readFile(
    new URL('../src/server.mjs', import.meta.url), 'utf8');
  const route = src.slice(src.indexOf("app.get('/api/v1/brand'"), src.indexOf("app.post('/api/v1/auth/login'"));
  assert.doesNotMatch(route, /jwt|token|requirePerm/i,
    'a build step that has to authenticate to learn a brand colour will hard-code a brand colour instead');
});

test('the web app has a Brand page in the nav that reads this endpoint', async () => {
  const web = await (await import('node:fs/promises')).readFile(
    new URL('../../web/app.js', import.meta.url), 'utf8');
  assert.match(web, /\['brand', 'Brand'\]/, 'it has to be findable, which was the whole ask');
  assert.match(web, /async brand\(\) \{/);
  assert.match(web, /api\('GET', '\/brand'\)/,
    'the page must read the same file the renderer reads, or it can drift from what is actually burned in');
});
