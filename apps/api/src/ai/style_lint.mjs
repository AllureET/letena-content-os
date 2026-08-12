// Lightweight post-generation style lint (Nate, 12 Aug 2026: house writing
// rules). Pure function, no I/O, unit-testable in isolation. It scans
// already-generated English text for the MECHANICAL violations of the
// house ban list and returns plain warning strings.
//
// This is a safety net, not the enforcement mechanism: the instruction to
// avoid these lives in HOUSE_STYLE_RULES (apps/api/src/ai/gateway.mjs) and
// is sent to the model on every call. What lintStyle() catches:
//   - the em dash character (—)
//   - a short deny-list of hedge-filler phrases
//   - a short deny-list of AI sign-off phrases
// What it deliberately does NOT try to catch: antithesis ("it is not X, it
// is Y" used as a rhetorical flourish) and tricolons ("safe, simple, and
// effective" used as a rhetorical flourish). Detecting those reliably in
// free text is inherently fuzzy; a naive pattern match would flag genuine,
// medically necessary contrasts and lists as often as it caught real
// violations. Those are left to human review.

const EM_DASH = '—';

const HEDGE_PHRASES = [
  'might', 'could potentially', "it's possible that", 'it is possible that',
  'may or may not', 'perhaps', 'possibly', 'it could be that',
  'in some cases it may', 'there is a chance that',
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

// lintStyle(text) -> string[] of human-readable warnings, [] when clean.
export function lintStyle(text) {
  if (!text) return [];
  const warnings = [];
  if (text.includes(EM_DASH)) {
    warnings.push('em_dash: contains an em dash (—); house style forbids it, use a period or comma.');
  }
  const lower = text.toLowerCase();
  warnings.push(...findPhrases(lower, HEDGE_PHRASES, 'hedge_phrase'));
  warnings.push(...findPhrases(lower, AI_SIGNOFF_PHRASES, 'ai_signoff'));
  return warnings;
}
