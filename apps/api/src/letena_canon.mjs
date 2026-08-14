// Letena canonical text, ported from letenav2 lib/content_script.php on
// 14 Aug 2026 as part of the unified content machine (Run One). The Amharic
// blocks below were EXTRACTED PROGRAMMATICALLY from LETENA_CS_AMHARIC_BLOCKS
// in that file, byte for byte. The source comment there says it and it is
// right: retyping introduces drift. Never retype these, never "fix" spacing
// inside them (the onscreen block's wide runs of spaces are deliberate
// layout), and never paraphrase them. Every public piece ends at the door.
//
// TRAP, learned before it bit: these blocks must NEVER ride inside an agent
// call's context payload. invokeAgent() asserts containsForbidden() on the
// JSON-encoded context, and the bot block contains @LetenaEthBot, which
// matches the forbidden HANDLE pattern and would terminate every call with
// BLOCKED_PII. The blocks therefore live in the script_writer prompt text
// itself (migration 0021), which the PII assertion does not scan; this
// module is the code-side source for scaffolds, door appending and the
// drift test that compares the active prompt against these constants.
export const LETENA_AMHARIC_BLOCKS = Object.freeze({
  door: 'በሚስጥር በቀጥታ ጻፊልን፦ ዋትስአፕ 0908 182 838፣ ቴሌግራም ወይም ሜሴንጀር። ማንም አያይም። ነፃ። በስልክ ማውራት ከመረጥሽ ደግሞ ደውዪ።',
  vo_close: 'ጥያቄ ካለሽ በቀጥታ በሚስጥር ጻፊልን። ከታች ባለው አገናኝ ቴሌግራም፣ ዋትስአፕ ወይም ሜሴንጀር ላይ። ማንም አያይም። መልዕክት ከከበደሽ ደግሞ ደውዪልን።',
  onscreen: 'በሚስጥር በቀጥታ ጻፊልን     ዋትስአፕ 0908 182 838 · ቴሌግራም · ሜሴንጀር     ማንም አያይም · ነፃ     ለጓደኛሽ በግል ላኪላት',
  bot: 'ስም መስጠት ካልፈለግሽ፣ ስም ሳትገልጪ @LetenaEthBot ላይ መጠየቅ ትችያለሽ።',
  send: 'ይሄ የሚመለከታት ጓደኛ ካለሽ በግል ላኪላት።',
  cost: 'ክፍያ እንቅፋት ከሆነ ጻፊልን፤ ነፃ አገልግሎት ከሚሰጡ አካላት ጋር እናገናኝሻለን።',
});

// The clinical governance gates, from letena_cs_build_prompt() in letenav2
// lib/content_script.php, minus one line. Nate, 14 Aug 2026: the red-flag /
// senior-on-call escalation line "refers to the EMR, and is unnecessary in
// producing content", so it is removed from content prompts. Everything
// else (the abortion boundary, the 72-hour PEP pathway, EC and post-assault
// PEP in the private consult only, no clinic names, the cost barrier) is
// about what content may say and stays verbatim. Reviewer routing anywhere
// in this system stays by role, never by name.
export const CLINICAL_GOVERNANCE_RULES = [
  'CLINICAL GOVERNANCE GATES',
  '- Inform and refer, never diagnose in comments or DMs.',
  '- PEP and any 72-hour pathway leads with the phone. Exposure within 72 hours routes to phone first.',
  '- Abortion content stays at options counseling, post-abortion care, and accompaniment. No methods, no dosing, no sourcing, no how-to, on screen or in captions. Warning-signs content is the one safety exception and stays.',
  '- Emergency contraception and PEP after assault are raised in the private consult only, never on screen.',
  '- No clinic names publicly. A cost barrier routes to the free-care line.',
].join('\n');

// Per-platform caption rules (Nate, 14 Aug 2026: "Three cotion system
// misses allour other outputs from tiktok to instgram to linkedin").
// letenav2's fixed trio (short / fbtg / x) is replaced by a caption per
// platform in the format's platforms array. The compositional rules that
// existed carry over (Facebook/Telegram standalone teaching, X value in the
// main post with the door in a self-reply); the missing platforms get their
// own. LinkedIn is the one surface whose audience is institutions, never
// patients, so it carries no door block.
export const PLATFORM_CAPTION_RULES = Object.freeze({
  TIKTOK: 'The searchable words in the first line, conversational, native to the feed.',
  INSTAGRAM: 'Leads with the value, line breaks, hashtags at the end.',
  FACEBOOK: 'Informative and standalone, teaches even if nobody plays the video.',
  TELEGRAM: 'Informative and standalone, the door in the message itself.',
  TWITTER: 'Value in the main post, the door in a self-reply. Never the door in the main post.',
  LINKEDIN: 'Professional and donor-facing register, not the patient voice, no door block.',
  YOUTUBE: 'A title, a description carrying the door, and chapters for long form.',
});

// The CTA assembler (Nate, 14 Aug 2026: "The goal is to get them to call us
// or DM us for help"). A format's cta_spec (content_formats.cta_spec) names
// canonical blocks by key; this turns them into the exact canonical text,
// so the phone number is carried from the door block and never retyped.
// deep_link and contact cover the surfaces that cannot carry the door (a
// push notification, the app, an institutional document).
export function assembleCta(ctaSpec) {
  if (!ctaSpec || typeof ctaSpec !== 'object') return null;
  const parts = (ctaSpec.blocks ?? [])
    .map((b) => LETENA_AMHARIC_BLOCKS[b])
    .filter(Boolean);
  if (ctaSpec.deep_link) parts.push(String(ctaSpec.deep_link));
  if (ctaSpec.contact) parts.push(String(ctaSpec.contact));
  return parts.length ? parts.join('\n') : null;
}

// Abortion-adjacent detection, ported from letena_cb_is_abortion_adjacent()
// in letenav2 lib/content_board.php. Defence in depth: a piece whose text
// trips this always carries needs_clinical_signoff, and per the owner rule
// the flag can be set by a client but NEVER cleared once detection fires.
const ABORTION_ADJACENT_NEEDLES = [
  'abortion', 'terminate', 'termination', 'miscarriage', 'post-abortion',
  'medication abortion', 'mva',
];
export function isAbortionAdjacent(text) {
  const t = String(text ?? '').toLowerCase();
  return ABORTION_ADJACENT_NEEDLES.some(n => t.includes(n));
}
