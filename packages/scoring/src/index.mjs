// Pure scoring and validation functions. No I/O. Every formula the system
// uses lives here so it can be unit tested and fixture-pinned.

// ---------- Topic priority (formula v1, weights from settings) ----------
export function priorityScore(row, weights, maxVolume) {
  const w = weights;
  const volume_n = Math.log(1 + row.question_count_30d) / Math.log(1 + Math.max(maxVolume, 2));
  const growth_n = clamp(
    (row.question_count_30d - row.question_count_prev_30d) / Math.max(row.question_count_prev_30d, 5),
    -1, 2) / 2;
  const unanswered_n = row.unanswered_count / Math.max(row.question_count_30d, 1);
  const target = Math.ceil(row.question_count_30d / 25);
  const coverage_gap = 1 - Math.min(target === 0 ? 1 : row.content_count_90d / target, 1);
  const clinical_n = (row.clinical_weight ?? 1) / 2.5;
  const strategic_n = (row.strategic_weight ?? 1) / 2.0;
  const score = 100 * (row.seasonal_factor ?? 1) * (
    w.volume * volume_n + w.growth * growth_n + w.unanswered * unanswered_n +
    w.coverage_gap * coverage_gap + w.clinical * clinical_n + w.strategic * strategic_n);
  return {
    score: round3(score),
    gap_flag: coverage_gap >= 0.6 && volume_n >= 0.35,
    components: { volume_n, growth_n, unanswered_n, coverage_gap, clinical_n, strategic_n },
  };
}

export function coverageState(row) {
  if (!row.has_approved_card) return 'NO_KNOWLEDGE';
  if (row.card_expires_in_days != null && row.card_expires_in_days <= 30) return 'STALE';
  const target = Math.ceil(row.question_count_30d / 25);
  if (row.content_count_90d === 0 && row.question_count_30d > 0) return 'KNOWLEDGE_NO_CONTENT';
  if (row.content_count_90d < target) return 'UNDER_COVERED';
  if (row.content_count_90d > 2 * Math.max(target, 1)) return 'SATURATED';
  return 'ADEQUATE';
}

// ---------- Three performance scores (v1) ----------
// pct() percentile helpers take an array of comparable values.
export function percentile(value, population) {
  if (value == null || !population.length) return null;
  const below = population.filter(v => v < value).length;
  return below / population.length;
}

export function reachScore(m, peers) {
  const parts = [
    [0.30, percentile(m.views, peers.views)],
    [0.25, percentile(m.completion_rate, peers.completion_rate)],
    [0.20, percentile(per1k(m.shares, m.views), peers.shares_per_1k)],
    [0.15, percentile(per1k(m.saves, m.views), peers.saves_per_1k)],
    [0.10, percentile(m.avg_watch_time_s, peers.avg_watch_time_s)],
  ];
  return weighted(parts);
}

export function educationScore(m) {
  const gapFill = { NO_KNOWLEDGE: 1, KNOWLEDGE_NO_CONTENT: 1, UNDER_COVERED: 0.6 }[m.coverage_state_at_publish] ?? 0.2;
  const depth = m.avg_watch_time_s && m.spoken_duration_s
    ? Math.min(m.avg_watch_time_s / m.spoken_duration_s, 1) : null;
  const parts = [
    [0.30, m.demand_match ?? null],
    [0.25, gapFill],
    [0.15, m.myth_addressed ? 1 : 0],
    [0.15, m.comprehension ?? 0.5],
    [0.15, depth],
  ];
  return weighted(parts);
}

export function serviceScore(m, peers) {
  const parts = [
    [0.40, percentile(per1k(m.consultations_attributed, m.views), peers.c_rate)],
    [0.25, percentile(per1k(m.questions_attributed, m.views), peers.q_rate)],
    [0.20, percentile(per1k(m.referrals_attributed, m.views), peers.r_rate)],
    [0.15, percentile(per1k(m.link_clicks, m.views), peers.click_rate)],
  ];
  return weighted(parts);
}

export function compositeScore(reach, education, service) {
  if ([reach, education, service].every(v => v == null)) return null;
  return round2(0.25 * (reach ?? 0) + 0.40 * (education ?? 0) + 0.35 * (service ?? 0));
}

// ---------- Deterministic claim-validator overlay ----------
// Runs AFTER the model validator; can only ADD findings, never remove.
// Numbers, time windows, prohibited phrases and referral presence are
// checkable with code, so they are checked with code.

const NUM_RE = /\d+(?:[.,]\d+)?/g;
const TIME_RE = /\b(\d+)\s*(hour|hr|day|week|month|year|ሰዓት|ቀን|ሳምንት|ወር|ዓመት)s?\b/gi;
const ABSOLUTES = /\b(always|never|guaranteed|100\s*%|completely safe|impossible|ምንም ጊዜ|ሁልጊዜ|በፍጹም)\b/i;
const CREDENTIAL_RE = /\b(dr\.?|doctor|physician|ሐኪም|ዶክተር)\b/i;

// Qualitative-predicate anchors: the words a prohibited claim most often
// hangs on when it has no number and no ABSOLUTES word (e.g. "Never say a
// test is reliable the day after sex"). Added 18 Aug 2026 after a live
// false positive: the correct, approved phrasing of that same guardrail
// ("testing the day after sex will not give you an accurate result") was
// blocked, because with no anchor at all the code fell back to raw topical
// trigram containment, which has no notion of negation. See the
// PROHIBITED_CLAIM block below for how this is used and guarded.
const QUALITATIVE_ANCHORS = /\b(reliable|accurate|effective|safe|works|guaranteed|trustworthy|certain|definite|conclusive|dependable)\b/i;
const NEGATION_RE = /\b(not|n't|never|no|won't|isn't|doesn't|didn't|cannot|can't|without)\b/i;

// True if a negation marker appears within `windowChars` before the given
// anchor word's first occurrence in `sentenceLower`. English negation
// typically precedes the predicate it governs ("will not give ... an
// accurate result", "is not reliable"), often with a few words between
// ("not give you an accurate"), hence the generous window.
export function isNegatedBefore(sentenceLower, anchorLower, windowChars = 40) {
  const idx = sentenceLower.indexOf(anchorLower);
  if (idx === -1) return false;
  return NEGATION_RE.test(sentenceLower.slice(Math.max(0, idx - windowChars), idx));
}

export function extractNumbers(text) {
  return [...(text.matchAll(NUM_RE))].map(m => m[0].replace(',', '.'));
}
export function extractTimeWindows(text) {
  return [...(text.matchAll(TIME_RE))].map(m => `${m[1]} ${m[2].toLowerCase()}`);
}

// A prohibited-claims entry is normally phrased as an instruction, "Never
// claim X" or "Never say X". The actual assertion to check for is X, not
// the wrapper. Stripping the wrapper keeps the wrapper's own vocabulary
// (the word "never" itself, for instance) from diluting or contaminating
// the similarity check below.
const PROHIBITION_PREFIX = /^\s*(never|do\s*not|don.?t|avoid)\s+(claim|say|state|imply|suggest)(\s+that)?\s+/i;
export function coreProhibitedAssertion(p) {
  return p.replace(PROHIBITION_PREFIX, '').trim();
}

function trigramSet(s) {
  const t = s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
  const grams = new Set();
  for (let i = 0; i < t.length - 2; i++) grams.add(t.slice(i, i + 3));
  return grams;
}
export function trigramSimilarity(a, b) {
  const A = trigramSet(a), B = trigramSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

// Containment: how much of phrase `needle` is present in `haystack`. Right
// for prohibited-claim detection, where the sentence may carry extra words.
export function trigramContainment(needle, haystack) {
  const N = trigramSet(needle), H = trigramSet(haystack);
  if (!N.size) return 0;
  let inter = 0;
  for (const g of N) if (H.has(g)) inter++;
  return inter / N.size;
}

// canonicalBlocks (added 18 Aug 2026): the standard, pre-approved Amharic
// door/CTA text a script is instructed to copy byte for byte (see the
// script_writer prompt's "THE CTA, every format" section). These are
// constants owned by the caller (apps/api/src/letena_canon.mjs), passed in
// rather than imported here, so this package stays dependency-free per its
// own header comment. A number or CTA phrase that only ever appears because
// it's part of a correctly-copied canonical block is not an alteration; the
// two checks below treat canonicalBlocks as pre-approved, not as text that
// still needs to independently satisfy the claims-derived checks.
export function validatorOverlay({ scriptText, claims, card, riskTier, cta, presenterLabel, canonicalBlocks }) {
  const findings = [];
  const claimText = claims.map(c => c.claim_text_en).join(' ');
  const canonText = (canonicalBlocks ?? []).join(' ');

  // Numbers in script must be a subset of numbers in claims OR in a
  // canonical block (the door/onscreen blocks carry the real phone number).
  const claimNums = new Set(extractNumbers(claimText));
  const canonNums = new Set(extractNumbers(canonText));
  for (const n of new Set(extractNumbers(scriptText))) {
    if (!claimNums.has(n) && !canonNums.has(n)) {
      findings.push({ code: 'NUMBER_ALTERED', severity: 'BLOCKER',
        statement: `number "${n}"`,
        explanation: `The number ${n} appears in the script but in no approved claim.` });
    }
  }
  // Time windows must match exactly.
  const claimTimes = new Set(extractTimeWindows(claimText));
  for (const t of new Set(extractTimeWindows(scriptText))) {
    if (!claimTimes.has(t)) {
      findings.push({ code: 'TIME_WINDOW_ALTERED', severity: 'BLOCKER',
        statement: `time window "${t}"`,
        explanation: `The time expression "${t}" does not appear in any approved claim.` });
    }
  }
  // Prohibited claims: match against the card's prohibited list. Entries
  // are plain strings from the demo/manual seed, or {reason, statement}
  // objects from the basics-library seed; normalize.
  //
  // Trigram containment of the FULL "Never claim X" sentence against each
  // script sentence used to be the whole check, at a flat 0.6 threshold.
  // That was unreliable in both directions, confirmed against a real case
  // 2026-08-12 (card CON-001, condom effectiveness): a sentence about the
  // barrier mechanism and lab studies, with no percentage in it at all,
  // scored 0.615 and got wrongly blocked, while a sentence that actually
  // said "condoms are 100% effective" scored only 0.538 and would have
  // sailed through. Ordinary shared vocabulary ("condoms", "effective",
  // "pregnancy") moves that score more than the one distinguishing token
  // ("100%") does, since the token is a small fraction of the needle's
  // trigrams either way.
  //
  // Fixed by anchoring on the distinguishing part of the claim instead of
  // the sentence as a whole. Most prohibited claims exist to rule out a
  // specific number or absolute qualifier (100%, always, guaranteed, ...).
  // When the core assertion has one of those, the sentence must contain
  // that same anchor to be flagged at all, on top of a moderate topical
  // floor so a stray, unrelated "100" elsewhere can't trigger it alone.
  // When the assertion has no numeric/absolute anchor (e.g. "lubricant type
  // does not matter"), the next-best anchor is a qualitative predicate word
  // (reliable, accurate, effective, safe, ...), checked below with a
  // negation guard so a sentence that asserts the OPPOSITE of the predicate
  // is not treated as making the claim. The two anchor kinds are tiered,
  // not combined: a claim with a numeric/absolute anchor (e.g. "100%
  // effective") is judged on that number alone, exactly as before, so a
  // correct lower percentage that happens to share the word "effective"
  // still is not flagged. Qualitative anchoring only kicks in when there is
  // no numeric/absolute anchor at all. When neither kind of anchor exists,
  // this falls back to raw trigram containment of the core assertion at the
  // original 0.6 bar.
  for (const entry of card?.prohibited_claims ?? []) {
    const p = typeof entry === 'string' ? entry : entry?.statement;
    if (!p) continue;
    const core = coreProhibitedAssertion(p);
    const numericAbsoluteAnchors = [...extractNumbers(core),
      ...(core.match(new RegExp(ABSOLUTES.source, 'gi')) ?? [])]
      .map(a => a.toLowerCase().replace(/\s+/g, ''));
    const qualitativeAnchors = numericAbsoluteAnchors.length ? [] : [...new Set(
      (core.match(new RegExp(QUALITATIVE_ANCHORS.source, 'gi')) ?? []).map(a => a.toLowerCase()))];
    for (const sentence of scriptText.split(/(?<=[.!?።])\s+/)) {
      if (sentence.length <= 15) continue;
      const containment = trigramContainment(core, sentence);
      const sentenceLower = sentence.toLowerCase();
      const compact = sentenceLower.replace(/\s+/g, '');
      let matches;
      if (numericAbsoluteAnchors.length) {
        matches = numericAbsoluteAnchors.some(a => compact.includes(a)) && containment >= 0.35;
      } else if (qualitativeAnchors.length) {
        matches = qualitativeAnchors.some(a =>
          sentenceLower.includes(a) && !isNegatedBefore(sentenceLower, a)) && containment >= 0.35;
      } else {
        matches = containment >= 0.6;
      }
      if (matches) {
        findings.push({ code: 'PROHIBITED_CLAIM', severity: 'BLOCKER',
          statement: sentence.slice(0, 200),
          explanation: `Matches prohibited claim: "${p}"` });
      }
    }
  }
  // Tier 4 requires a referral/help-seeking phrase.
  if (riskTier === 'TIER_4') {
    const referralPhrases = [...(card?.referral_conditions ?? []), 'talk to', 'seek care', 'clinic',
      'doctor', 'ሐኪም', 'ጤና ጣቢያ', 'እርዳታ'];
    const present = referralPhrases.some(p => scriptText.toLowerCase().includes(String(p).toLowerCase()));
    if (!present) {
      findings.push({ code: 'MISSING_REFERRAL', severity: 'BLOCKER',
        explanation: 'Tier 4 content must tell the viewer when and where to seek care.' });
    }
  }
  // Certainty inflation: absolutes where no claim is ESTABLISHED-certain absolute.
  if (ABSOLUTES.test(scriptText)) {
    const anyAbsoluteClaim = claims.some(c => ABSOLUTES.test(c.claim_text_en) && c.certainty === 'ESTABLISHED');
    if (!anyAbsoluteClaim) {
      findings.push({ code: 'CERTAINTY_INFLATION', severity: 'MAJOR',
        explanation: 'Script uses absolute language no ESTABLISHED claim uses.' });
    }
  }
  // CTA must be on the approved list, OR be (built from) a canonical Letena
  // door/CTA block. card.approved_ctas is a vestigial English-only list from
  // before the canonical bilingual Amharic door blocks existed; a correct
  // script_writer output copies those blocks byte for byte, so a plain
  // trigramSimilarity against the English list can never pass a genuine
  // canonical CTA. Treat containment of a canonical block as an equally
  // valid pass condition instead of tightening the English-list check.
  if (cta && (card?.approved_ctas?.length || (canonicalBlocks ?? []).length)) {
    const okByCard = card?.approved_ctas?.some(a => trigramSimilarity(cta, a) >= 0.5) ?? false;
    const okByCanon = (canonicalBlocks ?? []).some(b => trigramContainment(b, cta) >= 0.6);
    if (!okByCard && !okByCanon) {
      findings.push({ code: 'CTA_CONTRADICTION', severity: 'MAJOR',
        statement: cta, explanation: 'CTA is not on the card approved list.' });
    }
  }
  // Presenter may never carry clinical credentials.
  if (presenterLabel && CREDENTIAL_RE.test(presenterLabel)) {
    findings.push({ code: 'IMPLIED_CREDENTIALS', severity: 'BLOCKER',
      statement: presenterLabel,
      explanation: 'Presenter labels must never imply clinical credentials.' });
  }
  return findings;
}

export function overallResult(statements, findings) {
  const badVerdict = statements.some(s =>
    ['UNSUPPORTED', 'CONTRADICTED', 'AMBIGUOUS'].includes(s.verdict));
  const blocker = findings.some(f => f.severity === 'BLOCKER');
  return badVerdict || blocker ? 'FAIL' : 'PASS';
}

// ---------- Risk tier ----------
const TIER_ORDER = ['TIER_1', 'TIER_2', 'TIER_3', 'TIER_4'];
export function maxTier(...tiers) {
  return tiers.filter(Boolean).sort((a, b) => TIER_ORDER.indexOf(b) - TIER_ORDER.indexOf(a))[0] ?? 'TIER_1';
}
export function computeRiskTier({ cardTiers = [], claimTypes = [], topicCodes = [], manualOverride = null }) {
  let tier = maxTier(...cardTiers);
  const escalators = ['REFERRAL_TRIGGER', 'CONTRAINDICATION', 'TIME_WINDOW', 'SAFETY_WARNING'];
  if (claimTypes.some(t => escalators.includes(t))) tier = maxTier(tier, 'TIER_3');
  if (topicCodes.includes('SAFE')) tier = 'TIER_4';
  return manualOverride ? maxTier(tier, manualOverride) : tier;
}

// ---------- helpers ----------
function per1k(n, views) { return n != null && views ? (n / views) * 1000 : null; }
function weighted(parts) {
  const usable = parts.filter(([, v]) => v != null);
  if (!usable.length) return null;
  const wsum = usable.reduce((s, [w]) => s + w, 0);
  return round2(100 * usable.reduce((s, [w, v]) => s + w * v, 0) / wsum);
}
function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }
function round2(v) { return Math.round(v * 100) / 100; }
function round3(v) { return Math.round(v * 1000) / 1000; }
