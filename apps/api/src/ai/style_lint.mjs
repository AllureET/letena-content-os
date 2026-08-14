// Lightweight post-generation style lint (Nate, 12 Aug 2026: house writing
// rules; corrected 14 Aug 2026: hedging made precise, the comment ban
// replaced by the self-disclosure rule, and the stay-English terminology
// check added). Pure functions, no I/O, unit-testable in isolation. They
// scan already-generated text for the MECHANICAL violations of the house
// rules and return plain warning strings.
//
// This is a safety net, not the enforcement mechanism: the instruction to
// avoid these lives in HOUSE_STYLE_RULES (apps/api/src/ai/gateway.mjs) and
// the writer prompt, sent to the model on every call. What it deliberately
// does NOT try to catch: antithesis and tricolons used as rhetorical
// flourishes, and whether a specific hedge is load-bearing against a
// specific approved claim. Detecting those reliably in free text is
// inherently fuzzy; they are left to human review.

const EM_DASH = '—';

// Hedging, made precise (Nate, 14 Aug 2026: "the AI over hedging you do. I
// understand if its needed in this kind of content but not the BS").
// FILLER_HEDGES add nothing and are banned in every format, hedging_allowed
// or not: removing them never changes what the sentence claims.
const FILLER_HEDGES = [
  "it's important to note", 'it is important to note',
  'may potentially', 'could potentially',
  "it's generally recommended", 'it is generally recommended',
  'some experts suggest', 'this could possibly',
  'results may vary',
  "it's possible that", 'it is possible that', 'it could be that',
  'may or may not', 'in some cases it may', 'there is a chance that',
];
// UNCERTAINTY_WORDS can be load-bearing (a claim that says a symptom "can"
// indicate something must keep the hedge). The lint cannot compare against
// the claim, so these are flagged only where the format bans hedging
// (hedging_allowed=false), as warnings for a human to judge, never a block.
const UNCERTAINTY_WORDS = ['might', 'perhaps', 'possibly'];

// Comments, corrected (Nate, 14 Aug 2026: "we definitley can get some
// comments in various posts and even ask"). The blanket ban is gone. The
// real rule: never invite anyone to disclose something private in public.
// A comment invitation is fine when it asks for a NON-disclosing response
// (an opinion, a vote, a myth heard, a topic request, a quiz answer,
// tag-a-friend) AND the format allows comment prompts at all.
const COMMENT_INVITES = [
  'comment below', 'in the comments', 'drop a comment', 'leave a comment',
  'tell us below', 'let us know below', 'reply with', 'comment your',
];
// Direct self-disclosure invitations: flagged wherever they appear, with or
// without a comment-invite phrase around them.
const DISCLOSURE_INVITES = [
  'share your story', 'share your experience', 'tell us your story',
  'tell us your experience', 'tell us what happened to you',
  'share what happened to you',
];
// Disclosure subjects: flagged only when a comment invite appears in the
// same text, because "your period" inside teaching copy is normal; inside
// "comment below" copy it is an invitation to disclose.
const DISCLOSURE_SUBJECTS = [
  'your story', 'your experience', 'your symptom', 'your symptoms',
  'your diagnosis', 'your period', 'your pregnancy', 'your body',
  'your test result', 'your status', 'have you ever had',
  'what happened to you',
];

const AI_SIGNOFF_PHRASES = [
  'i hope this helps', 'i hope that helps', 'hope this helps',
  'let me know if', 'feel free to ask', 'feel free to reach out',
  'please let me know', 'if you have any further questions',
  'if you have any other questions', "don't hesitate to",
  'as an ai', 'i am an ai', "i'm an ai language model",
];

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function findPhrases(lowerText, phrases, category) {
  const hits = [];
  for (const phrase of phrases) {
    const re = new RegExp(`\\b${escapeRe(phrase)}\\b`, 'i');
    if (re.test(lowerText)) hits.push(`${category}: contains the phrase "${phrase}"`);
  }
  return hits;
}

// Deterministic stay-English terminology check (Nate, 14 Aug 2026: "we dont
// use amharic for sex organs or words like postpill or condom, we still use
// english for those, and that should be respected"). entries come from
// lcos.terminology WHERE keep_english: each carries term_en and the
// avoid_am renderings (the known Amharic translations/transliterations).
// A body that contains any avoid rendering has translated or transliterated
// a stay-English term. Deterministic, not a model judgment.
export function lintStayEnglish(text, entries = []) {
  if (!text || !entries.length) return [];
  const warnings = [];
  for (const e of entries) {
    for (const raw of e.avoid_am ?? []) {
      // Seeded avoid strings may carry slash-separated variants.
      for (const variant of String(raw).split('/').map((x) => x.trim()).filter(Boolean)) {
        if (text.includes(variant)) {
          warnings.push(`terminology_stay_english: "${e.term_en}" must stay in English inside Amharic copy; found "${variant}"`);
        }
      }
    }
  }
  return warnings;
}

// lintStyle(text, opts) -> string[] of human-readable warnings, [] when clean.
//
// opts.hedgingAllowed: the documented tension, preserved: filler hedges are
//   banned everywhere, but the bare uncertainty words are REQUIRED where
//   the uncertainty is factually true (cycle predictions, push
//   notifications). The registry (content_formats.hedging_allowed) decides
//   per format.
// opts.commentPromptAllowed: from content_formats.comment_prompt_allowed.
//   When false, any comment invitation is flagged. When true, only a
//   disclosure-shaped invitation is flagged: asking for an opinion, a vote,
//   a myth, a topic or a quiz answer is fine and often good.
// opts.stayEnglish: terminology entries for lintStayEnglish.
export function lintStyle(text, opts = {}) {
  if (!text) return [];
  const warnings = [];
  if (text.includes(EM_DASH)) {
    warnings.push('em_dash: contains an em dash (—); house style forbids it, use a period or comma.');
  }
  if (/!{2,}/.test(text)) {
    warnings.push('exclamation_stacking: contains stacked exclamation marks; calm is the register.');
  }
  const lower = text.toLowerCase();
  warnings.push(...findPhrases(lower, FILLER_HEDGES, 'hedge_phrase'));
  if (!opts.hedgingAllowed) {
    warnings.push(...findPhrases(lower, UNCERTAINTY_WORDS, 'hedge_phrase'));
  }
  warnings.push(...findPhrases(lower, AI_SIGNOFF_PHRASES, 'ai_signoff'));
  warnings.push(...findPhrases(lower, DISCLOSURE_INVITES, 'comment_self_disclosure'));
  const invites = findPhrases(lower, COMMENT_INVITES, 'comment_invite');
  if (invites.length) {
    const subjects = findPhrases(lower, DISCLOSURE_SUBJECTS, 'comment_self_disclosure');
    if (subjects.length) {
      // A comment invitation next to a disclosure subject is an invitation
      // to disclose. The private door is the route for anything personal.
      warnings.push(...subjects);
    }
    if (opts.commentPromptAllowed === false) {
      warnings.push(...invites.map((w) => w.replace('comment_invite:', 'comment_prompt_not_allowed:')));
    }
  }
  warnings.push(...lintStayEnglish(text, opts.stayEnglish ?? []));
  return warnings;
}
