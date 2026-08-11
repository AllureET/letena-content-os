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

export function extractNumbers(text) {
  return [...(text.matchAll(NUM_RE))].map(m => m[0].replace(',', '.'));
}
export function extractTimeWindows(text) {
  return [...(text.matchAll(TIME_RE))].map(m => `${m[1]} ${m[2].toLowerCase()}`);
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

export function validatorOverlay({ scriptText, claims, card, riskTier, cta, presenterLabel }) {
  const findings = [];
  const claimText = claims.map(c => c.claim_text_en).join(' ');

  // Numbers in script must be a subset of numbers in claims.
  const claimNums = new Set(extractNumbers(claimText));
  for (const n of new Set(extractNumbers(scriptText))) {
    if (!claimNums.has(n)) {
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
  // Prohibited claims: trigram match against the card's prohibited list.
  for (const p of card?.prohibited_claims ?? []) {
    for (const sentence of scriptText.split(/(?<=[.!?።])\s+/)) {
      if (sentence.length > 15 && trigramContainment(p, sentence) >= 0.6) {
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
  // CTA must be on the approved list.
  if (cta && card?.approved_ctas?.length) {
    const ok = card.approved_ctas.some(a => trigramSimilarity(cta, a) >= 0.5);
    if (!ok) {
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
