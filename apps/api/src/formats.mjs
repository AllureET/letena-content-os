// What shape a piece of content actually is, as opposed to which template
// renders it. Added 14 Aug 2026.
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
// producing a script with no usable body.
export function formatOf(videoFamily) {
  return FORMAT[videoFamily] ?? 'VIDEO';
}

// Only VIDEO is spoken. The other three are read, so generating a voiceover
// for them is a real ElevenLabs charge for audio nothing will ever play.
export function hasAudio(videoFamily) {
  return formatOf(videoFamily) === 'VIDEO';
}

// Every human-readable line in a piece, whatever format it is.
//
// This exists because "the text of this script" was `spoken_script`
// everywhere, which silently became the empty string for the three non-video
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
// same claim spoken in a reel. If a new format is added, add its body here
// and every one of those four paths picks it up.
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
  parts.push(v.cta);
  return parts.filter(x => typeof x === 'string' && x.trim()).join(' ').trim();
}
