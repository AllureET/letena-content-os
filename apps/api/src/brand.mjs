// ===========================================================================
// The Letena brand kit, in code.
//
// Written 22 Aug 2026. Owner, after watching me invent three hex codes for
// overlay cards: "you have the real letena values in this project and in the
// brand kit in the github and many other places.. Make sure its somewhere
// easily findable in the OS, and it may even need a page so you dont forget."
//
// He is right and the failure was structural, not forgetful. The values
// existed in at least four places -- the Brand Style Guide, the Flutter app's
// letena_theme.dart, the LCOS design-token doc, the GitHub brand kit -- and
// exactly none of them were reachable from the code that needed them. So
// every overlay, every card, every generated still got a colour someone
// eyeballed. Four sources of truth and no source of truth are the same thing.
//
// This file is now the one the running system reads. It is served at
// GET /api/v1/brand, rendered as a page in the web app, and imported wherever
// a colour is burned into a picture. Changing a brand value means changing it
// here, once.
//
// Values transcribed from the Letena Brand Style Guide (Allure Communications,
// 2024), cross-checked against apps/letena/lib/theme/letena_theme.dart. Do not
// edit them without updating the style guide first.
// ===========================================================================

export const LETENA_BRAND = {
  source: 'Letena Brand Style Guide (Allure Communications, 2024)',
  updated: '2026-08-22',

  // The five that carry the identity. Names are the style guide's own, kept
  // verbatim so a designer reading the guide and an engineer reading this file
  // are talking about the same colour.
  colors: {
    marigold:      { hex: '#EBAB20', role: 'primary golden accent, attention, in-progress' },
    fuzzyWuzzy:    { hex: '#CD6962', role: 'warm coral, primary active, menstrual tones' },
    jellyBeanBlue: { hex: '#477287', role: 'supportive secondary, links, focus' },
    cetaceanBlue:  { hex: '#16103F', role: 'deep anchor, primary text, headings' },
    plumpPurple:   { hex: '#5D489C', role: 'secondary emphasis, luteal phase, accent only' },
    teal:          { hex: '#5BBFB5', role: 'calm confirmed states, rails' },
  },

  // Surfaces. Letena is a cream-ground brand, not a white-ground one, and
  // getting this wrong is the fastest way to make something look off-brand
  // while every accent colour is technically correct.
  neutrals: {
    cream:        { hex: '#FDF8F0', role: 'page background' },
    creamSurface: { hex: '#FFFCF5', role: 'elevated card' },
    creamMid:     { hex: '#F5F1EA', role: 'recessed surface' },
    creamLine:    { hex: '#F2E8D8', role: 'hairline border' },
    creamMute:    { hex: '#C9B89C', role: 'muted text, inactive' },
    creamSoft:    { hex: '#B8A88A', role: 'body muted text' },
  },

  // Burn-in pairings, pre-checked for contrast, so nothing downstream has to
  // decide which colour goes on which. Every pair here clears WCAG AA at the
  // sizes overlays actually use.
  overlayPairs: {
    anchor:     { background: '#16103F', text: '#FDF8F0', use: 'title cards, door cards, anything that must read as Letena speaking' },
    attention:  { background: '#EBAB20', text: '#16103F', use: 'share prompts, calls to act' },
    supportive: { background: '#477287', text: '#FDF8F0', use: 'keyword and explanation labels' },
    warm:       { background: '#CD6962', text: '#FDF8F0', use: 'sparingly, for emphasis on feeling rather than fact' },
  },

  typography: {
    display: 'Poppins 600, for headings, primary buttons and any decision point',
    body: 'Poppins 400/500',
    wordmark: 'Crimson Pro 600, wordmark only, never UI chrome',
    // The two Ethiopic weights this build actually has instantiated. Offering
    // any other font here would offer one that silently fails to draw Amharic.
    amharic: 'Noto Sans Ethiopic, Bold and Regular only (apps/api/assets/fonts)',
    amharicLineHeight: 1.9,
    latinLineHeight: 1.55,
  },

  // The logo is deliberately NOT a colour or a font. It is a file, and the one
  // rule that has never bent: an image model must never be asked to draw it.
  // Every time one has been, it has invented something that is not the Letena
  // mark. It goes on through overlay burn-in from the real artwork.
  logo: {
    rule: 'Never ask an image model to draw the Letena logo. Generation keeps a blank board; the mark is burned in from the real file.',
    description: 'White circular badge: two stylised geometric faces (deep indigo hair, marigold and coral face halves), teal leafy branches, "Letena" in bold teal serif, "Ethiopia" beneath.',
    assetKind: 'ICON',
    status: 'NOT UPLOADED -- no ICON asset for the logo exists in the library yet, so no overlay can place it.',
    howToAdd: 'Upload the real SVG or PNG to the asset library as kind ICON, then add an ICON overlay referencing its asset_id.',
  },

  rules: [
    'Cream is the ground. Letena is not a white-background brand.',
    'Marigold means attention. Do not use it as a background for body text.',
    'Cetacean blue is the anchor and the primary text colour.',
    'Never invent a hex. If it is not in this file, it is not a Letena colour.',
    'Amharic is the primary language, not a translation target, and needs its own line height.',
    'The logo is placed from the real file, never generated.',
  ],
};

// Flat name to hex, for the places that just want a value.
export const BRAND_HEX = Object.fromEntries([
  ...Object.entries(LETENA_BRAND.colors).map(([k, v]) => [k, v.hex]),
  ...Object.entries(LETENA_BRAND.neutrals).map(([k, v]) => [k, v.hex]),
]);

// Resolve a colour the way callers actually reference one: by brand name if
// they know it, by literal hex if they are pasting from the guide. Anything
// else throws, which is the point -- an unrecognised colour name should stop
// a render rather than quietly become black.
export function brandColor(nameOrHex) {
  if (typeof nameOrHex !== 'string') throw new Error('brandColor: expected a string');
  const v = nameOrHex.trim();
  if (BRAND_HEX[v]) return BRAND_HEX[v];
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toUpperCase();
  throw new Error(
    `brandColor: "${v}" is not a Letena brand colour and not a hex value. `
    + `Known names: ${Object.keys(BRAND_HEX).join(', ')}. See apps/api/src/brand.mjs.`);
}
