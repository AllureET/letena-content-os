// What shape a piece of content actually is, as opposed to which template
// renders it. Added 14 Aug 2026, widened the same day for the unified
// content machine (Run One): the format registry in lcos.content_formats now
// carries ~36 formats across five surfaces, and each registry row names one
// of the BODY_KINDS below as the contract between the writer and everything
// downstream.
//
// Nate: "I know were producing 4 different outputs in production. Dont we
// need the right script for each one." Each output type did already get its
// own script, but every script was written to one video-shaped schema (hook,
// spoken_script, on-screen text timed to seconds, a scene plan with start and
// end times). Production then reassembled video parts into whatever the
// format actually was: carousel slides were built from caption cues timed to
// video seconds, a single static graphic ran the same multi-page code path,
// and a Telegram text post had no text output at all so it fell through to
// the video renderer with no template. All three also generated an AI
// voiceover first, because nothing asked whether the format has audio.
//
// video_family is a render-routing key (which Creatomate template, which
// engine). This is the orthogonal question the system never asked: what kind
// of thing is this, and therefore what does the writer need to write.

// The body kinds a script_versions row can carry. A registry format maps to
// exactly one of these; several registry formats can share a kind (save_it
// and carousel are both CAROUSEL bodies with different headings and rules).
//   VIDEO     spoken_script + onscreen_text + scene_plan
//   CAROUSEL  carousel_slides
//   STATIC    static_graphic
//   POST      post_text
//   ARTICLE   body.sections (long form: blog, library article, one-pager)
//   MICROCOPY body.items (FAQ, app copy, sample questions, insight cards)
//   PUSH      body.push (title, body, abeba:// deep link)
//   AUDIO     spoken_script only, written to be heard once with no visual
//   LIVE      body.segments + pinned_message + cutdown_briefs (run of show)
export const BODY_KINDS = Object.freeze([
  'VIDEO', 'CAROUSEL', 'STATIC', 'POST', 'ARTICLE', 'MICROCOPY', 'PUSH', 'AUDIO', 'LIVE',
]);

export const FORMAT = {
  V01_QUESTION_EXPLAINER: 'VIDEO',
  V02_CHAT_STORY: 'VIDEO',
  V03_ILLUSTRATED_SCENARIO: 'VIDEO',
  V04_MEDICAL_VISUAL_EXPLAINER: 'VIDEO',
  V05_DIGITAL_PRESENTER: 'VIDEO',
  V06_REAL_ETHIOPIA_HYBRID: 'VIDEO',
  C01_CAROUSEL: 'CAROUSEL',
  C02_STATIC_GRAPHIC: 'STATIC',
  C03_TELEGRAM_POST: 'POST',
};

// Unknown families fall back to VIDEO deliberately: that is the shape the
// whole pipeline already handles end to end, so a family added to the enum
// without being listed here degrades to today's behaviour instead of
// producing a script with no usable body. Registry-driven concepts do not
// pass through here at all: their body kind comes from
// content_formats.body_kind, which is the authoritative answer when present.
export function formatOf(videoFamily) {
  return FORMAT[videoFamily] ?? 'VIDEO';
}

// Only VIDEO and AUDIO are spoken. The others are read, so generating a
// voiceover for them is a real ElevenLabs charge for audio nothing will
// ever play.
export function hasAudio(videoFamily) {
  return formatOf(videoFamily) === 'VIDEO';
}
export function bodyKindHasAudio(bodyKind) {
  return bodyKind === 'VIDEO' || bodyKind === 'AUDIO';
}

// Every human-readable line in a piece, whatever format it is.
//
// This exists because "the text of this script" was `spoken_script`
// everywhere, which silently became the empty string for the non-video
// formats the moment the writer started filling format-specific bodies. Four
// separate things read that field: the content hash, the house-style lint,
// the claim validator, and the Amharic localizer. A carousel whose slides
// were never added here would be content-hashed on its hook alone, linted on
// nothing, VALIDATED WITHOUT ITS ACTUAL MEDICAL CLAIMS EVER BEING CHECKED,
// and localized to an empty Amharic string.
//
// The validator one is the dangerous one and is the reason this is a single
// shared function rather than four call sites each assembling their own
// string: a claim stated on slide 3 must be checked exactly as hard as the
// same claim spoken in a reel.
//
// Two hardenings for Run One (14 Aug 2026):
//
// 1. The generic `body` jsonb column is walked recursively and EVERY string
//    leaf is collected. This is deliberate over-collection: a new body shape
//    added to the registry is covered by the validator, the lint, the hash
//    and the localizer automatically, with no code change to forget. The
//    cost is that non-prose strings (a deep link, an emoji) also enter the
//    text; that is noise the validator tolerates, where the opposite error
//    (a claim in an unwalked field) is the exact near-miss that motivated
//    this function. Do not add a skip-list of "non-text" keys without a
//    test proving no claim-bearing field can ever land under it.
//
// 2. Captions are now part of the body text. They were not before, which
//    meant the Facebook/Telegram caption, which by rule "teaches even if
//    no one plays the video" and therefore carries medical statements, was
//    never claim-validated. That was a real hole, closed here.
export function bodyTextOf(v) {
  if (!v) return '';
  const parts = [v.hook, v.spoken_script, v.post_text];
  const slides = Array.isArray(v.carousel_slides) ? v.carousel_slides
    : (v.carousel_slides ? JSON.parse(JSON.stringify(v.carousel_slides)) : []);
  for (const sl of slides ?? []) parts.push(sl?.title, sl?.body);
  const g = v.static_graphic;
  if (g) parts.push(g.headline, g.body, g.footer);
  const onscreen = Array.isArray(v.onscreen_text) ? v.onscreen_text : [];
  for (const t of onscreen) parts.push(t?.text);
  collectStrings(v.body, parts);
  parts.push(v.cta);
  // caption is the pre-Run-One single caption; caption_short/fbtg/x are the
  // legacy letenav2 trio columns; captions{} is the writer's output shape
  // (since 14 Aug 2026 keyed by PLATFORM, per the owner's caption
  // correction); captions_by_platform is the stored platform-keyed set.
  // All of them are claim-bearing surfaces, so every value is walked, not
  // a fixed key list: a platform added later is covered automatically.
  parts.push(v.caption, v.caption_short, v.caption_fbtg, v.caption_x);
  collectStrings(v.captions, parts);
  collectStrings(v.captions_by_platform, parts);
  return parts.filter(x => typeof x === 'string' && x.trim()).join(' ').trim();
}

// Depth-first walk collecting every string leaf. Bounded against cycles and
// pathological depth; jsonb from Postgres is acyclic but this function also
// receives raw model output, which is not trusted to be anything.
function collectStrings(node, out, depth = 0) {
  if (node == null || depth > 12) return;
  if (typeof node === 'string') { out.push(node); return; }
  if (Array.isArray(node)) { for (const x of node) collectStrings(x, out, depth + 1); return; }
  if (typeof node === 'object') {
    for (const k of Object.keys(node)) collectStrings(node[k], out, depth + 1);
  }
}
