// Deterministic de-identification pass. First of three defenses (deterministic
// rules -> model NER sweep -> confidence gate). Pure functions, no I/O.
// Redactions replace spans with typed placeholders so sentence structure
// survives for classification. Amharic-aware where patterns allow.

const RULES = [
  // Ethiopian phones: +251 9/7 xxxxxxxx, 09/07 xxxxxxxx, with spaces/dashes/dots
  { type: 'PHONE', re: /(?:\+?251[\s.-]?|0)[79][\s.-]?\d(?:[\s.-]?\d){7}/g },
  // Generic international numbers 10+ digits
  { type: 'PHONE', re: /\+\d(?:[\s.-]?\d){9,13}/g },
  { type: 'EMAIL', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { type: 'HANDLE', re: /(?<![\w.])@[A-Za-z0-9_.]{3,32}/g },
  { type: 'HANDLE', re: /\bt\.me\/[A-Za-z0-9_]{3,32}/g },
  { type: 'URL', re: /https?:\/\/\S+/g },
  // letena.et identifiers: LET/123/2026 visit refs, mtr_/pat_ prefixes, consult ids
  { type: 'ID', re: /\bLET\/\d{1,6}\/\d{4}\b/gi },
  { type: 'ID', re: /\b(?:mtr|pat|cons|vis)_[A-Za-z0-9]{4,}\b/g },
  { type: 'ID', re: /\b(?:patient|consult|matter|case|ticket)\s*(?:id|no|number|#)\s*[:#]?\s*\d{2,}\b/gi },
  // Ethiopian national ID / long digit runs (8+ digits not already caught)
  { type: 'ID', re: /\b\d{8,16}\b/g },
];

// Common Ethiopian given names (starter set, extend in fixtures) — matched only
// when following a self-identification cue, to avoid stripping topic words.
const NAME_CUES = [
  /(?:my name is|i am called|this is|call me|እባላለሁ|ስሜ)\s+([A-Zሀ-፿][\wሀ-፿]{2,20})/gi,
  /(?:ስሜ|ስሜ ማን እንደሆነ)\s*[:\-]?\s*([ሀ-፿]{2,20})/g,
];

const PLACEHOLDER = {
  PHONE: '[PHONE]', EMAIL: '[EMAIL]', HANDLE: '[HANDLE]', URL: '[URL]',
  ID: '[ID]', PERSON: '[NAME]', ADDRESS: '[PLACE]', PLACE_FINE: '[PLACE]',
};

export function deterministicPass(text) {
  const redactions = [];
  let out = text;
  for (const { type, re } of RULES) {
    out = out.replace(re, (m) => {
      redactions.push({ type, length: m.length });
      return PLACEHOLDER[type] || '[REDACTED]';
    });
  }
  for (const re of NAME_CUES) {
    out = out.replace(re, (m, name) => {
      redactions.push({ type: 'PERSON', length: name.length });
      return m.replace(name, PLACEHOLDER.PERSON);
    });
  }
  return { text: out, redactions };
}

// Applies model-reported spans (from the deid_sweep agent) to text. Spans are
// {start,end,type}. The agent never rewrites text; we do the replacement.
export function applySpans(text, spans) {
  const valid = (spans || [])
    .filter(s => Number.isInteger(s.start) && Number.isInteger(s.end)
      && s.start >= 0 && s.end > s.start && s.end <= text.length)
    .sort((a, b) => b.start - a.start);
  const redactions = [];
  let out = text;
  for (const s of valid) {
    redactions.push({ type: s.type, length: s.end - s.start });
    out = out.slice(0, s.start) + (PLACEHOLDER[s.type] || '[REDACTED]') + out.slice(s.end);
  }
  return { text: out, redactions };
}

// Forbidden patterns that must never appear in text sent to an AI provider or
// stored as sanitized. Used both post-deid and as the gateway PII assertion.
export const FORBIDDEN_PATTERNS = [
  /(?:\+?251|0)[79]\d{8}/,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  /(?<![\w.])@[A-Za-z0-9_.]{4,}/,
  /\b(?:mtr|pat|cons)_[A-Za-z0-9]{4,}\b/,
  /\bLET\/\d{1,6}\/\d{4}\b/i,
  /\b\d{10,}\b/,
];

export function containsForbidden(text) {
  return FORBIDDEN_PATTERNS.some(re => re.test(text));
}

// Confidence: 1.0 baseline, reduced by residual risk signals. The threshold
// (settings deid.confidence_threshold, default 0.85) gates quarantine.
export function confidenceScore({ residualFound = 0, sweepRisk = 'NONE', hadRedactions = false }) {
  let c = 1.0;
  c -= 0.4 * Math.min(residualFound, 2) / 2;
  c -= { NONE: 0, LOW: 0.05, MEDIUM: 0.2, HIGH: 0.5 }[sweepRisk] ?? 0.2;
  if (hadRedactions && sweepRisk !== 'NONE') c -= 0.05;
  return Math.max(0, Math.round(c * 1000) / 1000);
}

// Full local pipeline used when no model sweep is available (demo mode):
// deterministic pass, then forbidden re-scan as the residual check.
export function deidentify(text) {
  const pass1 = deterministicPass(text);
  const residual = containsForbidden(pass1.text) ? 1 : 0;
  const confidence = confidenceScore({
    residualFound: residual, sweepRisk: residual ? 'HIGH' : 'NONE',
    hadRedactions: pass1.redactions.length > 0,
  });
  return { text: pass1.text, redactions: pass1.redactions, confidence, residual };
}
