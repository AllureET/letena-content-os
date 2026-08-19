// Pure pipeline rules. No I/O, no imports, so the publish predicate can be
// unit tested without a database and reused by both the pipeline module and
// the publish transition in distribution.mjs without import cycles.
// Ported from letenav2 lib/content_board.php (letena_cb_publish_rule and
// LETENA_CB_STAGES) as part of the unified content machine, 14 Aug 2026.

// The stages, in walk order. Every format walks this sequence, minus the
// stages its registry row marks not applicable and minus the production
// stages its piece's production_path removes. 'produce' was added 14 Aug
// 2026 (owner: "it should default to digital production with our
// piepleine"): on the DIGITAL path a single produce stage covers the
// adapter pipeline (Gemini, Kling, ElevenLabs, Canva) and replaces
// shoot+edit; the LIVE path keeps shoot and edit for real shoots and the
// AUA live; NONE (text and app surfaces) has no production at all. HeyGen
// and Creatomate, both referenced in this pipeline's original design, were
// retired 19 Aug 2026 (owner's decision); DIGITAL video production now
// runs through Video Studio (apps/api/src/modules/studio.mjs), not this
// adapter pipeline.
export const STAGES = Object.freeze([
  'plan', 'script', 'medical_review', 'produce', 'shoot', 'edit',
  'approve', 'publish', 'repurpose', 'measure',
]);

export const PRODUCTION_PATHS = Object.freeze(['DIGITAL', 'LIVE', 'NONE']);

// The stages a specific PIECE actually walks: the format's applicable
// stages filtered by the piece's production path. Pure so both the board
// and the advance endpoint use one definition.
export function effectiveStages(applicable, productionPath) {
  const base = applicable ?? STAGES;
  const path = productionPath ?? 'LIVE'; // legacy pieces predate the produce stage
  if (path === 'DIGITAL') return base.filter((st) => st !== 'shoot' && st !== 'edit');
  if (path === 'LIVE') return base.filter((st) => st !== 'produce');
  if (path === 'NONE') return base.filter((st) => st !== 'produce' && st !== 'shoot' && st !== 'edit');
  return base;
}

// The gate names: the stages plus clinical_signoff, which has no matching
// stage. Since 14 Aug 2026 (owner: "it should block the medical review from
// being acccepted right?") clinical_signoff is required to LEAVE the
// medical_review stage on a flagged piece, so it stops where a clinician is
// already looking; the publish-time check stays as a backstop.
export const GATES = Object.freeze([...STAGES, 'clinical_signoff']);

// The publish rule as a pure predicate over a piece and its signed-gate
// set. A piece may reach publish only when medical_review is signed and,
// when the piece needs a clinical sign-off (abortion-adjacent), the
// clinical_signoff gate is signed too. There is no format, tier, mode or
// admin exception to the medical_review half: "medical_review must be
// signed before publish. Always." (kickoff brief, owner decision,
// 14 Aug 2026).
export function publishRule(piece, signedGates) {
  const signed = signedGates instanceof Set ? signedGates : new Set(signedGates ?? []);
  if (!signed.has('medical_review')) {
    return { ok: false, guard: 'medicalReviewSigned',
      reason: 'Medical review is not signed. Every piece is medically reviewed before publish, whatever its format.' };
  }
  if (piece?.needs_clinical_signoff && !signed.has('clinical_signoff')) {
    return { ok: false, guard: 'clinicalSignoffSigned',
      reason: 'This piece is abortion-adjacent and needs a clinical sign-off before publish.' };
  }
  return { ok: true, guard: null, reason: null };
}

// ---------------------------------------------------------------------------
// Edit classification (owner ruling, 14 Aug 2026): "if the edit is to a
// medical term, it should go back to medical review, if its to just the
// content then it should go through". Run One invalidated the medical
// sign-off on ANY body change; too blunt. This computes what actually
// changed, deterministically, and errs medical at the boundary: a false
// re-review costs a click; a false pass ships unreviewed medical content.
//
// An edit is MEDICAL when any of these changed between the old and the new
// body text:
//   - a claim-mapped statement that was present in the old text is no
//     longer present verbatim in the new text;
//   - the multiset of numbers (which covers doses and time windows);
//   - the count of time/dose unit words (hour, day, week, mg, ml...);
//   - the count of negation words;
//   - the count of load-bearing hedge words (can, may, might, could);
//   - the count of any stay-English terminology term or its avoid-listed
//     Amharic rendering.
// Anything else (a hook rewrite, pacing, a slide title carrying no claim,
// an Amharic phrasing correction) passes and the sign-off stands.

const NEGATION_WORDS = ['not', 'never', 'no', 'cannot', "can't", "don't", "doesn't", "won't", 'without'];
const HEDGE_WORDS = ['can', 'may', 'might', 'could', 'sometimes', 'usually', 'often'];
const UNIT_WORDS = ['hour', 'hours', 'day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years',
  'minute', 'minutes', 'mg', 'ml', 'mcg', 'microgram', 'micrograms', 'milligram', 'milligrams',
  'ሰዓት', 'ቀን', 'ሳምንት', 'ወር'];

function countOccurrences(lowerText, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  const nl = String(needle).toLowerCase();
  for (;;) {
    i = lowerText.indexOf(nl, i);
    if (i < 0) return n;
    n++; i += nl.length;
  }
}
function wordCounts(lowerText, words) {
  const out = {};
  for (const w of words) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'giu');
    out[w] = (lowerText.match(re) ?? []).length;
  }
  return out;
}
function numberList(text) {
  return (String(text).match(/\d+(?:[.,]\d+)?/g) ?? []).sort();
}
const normWs = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

export function classifyEdit({ oldText, newText, claimStatements = [], terminologyTerms = [] } = {}) {
  // Conservative at the boundary: if we cannot tell, it is medical.
  if (oldText == null || newText == null) {
    return { medical: true, reasons: ['edit could not be compared; treated as medical'] };
  }
  const oldNorm = normWs(oldText), newNorm = normWs(newText);
  if (oldNorm === newNorm) return { medical: false, reasons: ['no textual change'] };
  const reasons = [];

  for (const st of claimStatements) {
    const stNorm = normWs(st);
    if (stNorm && oldNorm.includes(stNorm) && !newNorm.includes(stNorm)) {
      reasons.push(`claim-mapped statement changed or removed: "${String(st).slice(0, 80)}"`);
    }
  }
  const oldNums = numberList(oldNorm), newNums = numberList(newNorm);
  if (JSON.stringify(oldNums) !== JSON.stringify(newNums)) {
    reasons.push('a number, dose or time window changed');
  }
  for (const [label, words] of [['negation', NEGATION_WORDS], ['hedge', HEDGE_WORDS], ['time or dose unit', UNIT_WORDS]]) {
    const a = wordCounts(oldNorm, words), b = wordCounts(newNorm, words);
    const diff = words.filter((w) => a[w] !== b[w]);
    if (diff.length) reasons.push(`${label} wording changed (${diff.join(', ')})`);
  }
  for (const term of terminologyTerms) {
    for (const variant of [term.term_en, ...(term.avoid_am ?? [])]) {
      if (!variant) continue;
      if (countOccurrences(oldNorm, variant) !== countOccurrences(newNorm, variant)) {
        reasons.push(`terminology term usage changed: ${term.term_en}`);
        break;
      }
    }
  }
  return { medical: reasons.length > 0, reasons: reasons.length ? reasons : ['non-medical text only'] };
}
