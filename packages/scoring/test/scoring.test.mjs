import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  priorityScore, coverageState, validatorOverlay, overallResult,
  computeRiskTier, compositeScore, trigramSimilarity,
} from '../src/index.mjs';

const W = { volume: 0.28, growth: 0.20, unanswered: 0.14, coverage_gap: 0.18, clinical: 0.12, strategic: 0.08 };

test('high demand + zero coverage flags a gap', () => {
  const r = priorityScore({ question_count_30d: 98, question_count_prev_30d: 60,
    unanswered_count: 40, content_count_90d: 0, clinical_weight: 2, strategic_weight: 2,
    seasonal_factor: 1 }, W, 120);
  assert.ok(r.gap_flag);
  assert.ok(r.score > 40);
});

test('well covered topic does not flag', () => {
  const r = priorityScore({ question_count_30d: 87, question_count_prev_30d: 80,
    unanswered_count: 5, content_count_90d: 7, clinical_weight: 1, strategic_weight: 1,
    seasonal_factor: 1 }, W, 120);
  assert.ok(!r.gap_flag);
});

test('coverage states', () => {
  assert.equal(coverageState({ has_approved_card: false }), 'NO_KNOWLEDGE');
  assert.equal(coverageState({ has_approved_card: true, card_expires_in_days: 10, question_count_30d: 5, content_count_90d: 3 }), 'STALE');
  assert.equal(coverageState({ has_approved_card: true, question_count_30d: 50, content_count_90d: 0 }), 'KNOWLEDGE_NO_CONTENT');
  assert.equal(coverageState({ has_approved_card: true, question_count_30d: 100, content_count_90d: 1 }), 'UNDER_COVERED');
});

const CLAIMS = [
  { claim_text_en: 'Emergency contraceptive pills do not terminate an established pregnancy.', certainty: 'ESTABLISHED' },
  { claim_text_en: 'Emergency contraceptive pills should be taken within 72 hours, and some types work up to 120 hours.', certainty: 'ESTABLISHED' },
];
const CARD = {
  prohibited_claims: ['Any statement giving a dose or number of tablets',
    'Emergency contraception ends a pregnancy'],
  approved_ctas: ['Message Letena on Telegram to talk to a doctor privately. It is free.'],
  referral_conditions: ['period more than 7 days late'],
};

test('overlay catches an altered time window', () => {
  const f = validatorOverlay({
    scriptText: 'Take it within 3 days for it to work.', claims: CLAIMS, card: CARD,
    riskTier: 'TIER_3', cta: CARD.approved_ctas[0] });
  assert.ok(f.some(x => x.code === 'TIME_WINDOW_ALTERED' && x.severity === 'BLOCKER'));
});

test('overlay catches a number not present in claims', () => {
  const f = validatorOverlay({
    scriptText: 'It is 95% effective for everyone.', claims: CLAIMS, card: CARD,
    riskTier: 'TIER_2', cta: CARD.approved_ctas[0] });
  assert.ok(f.some(x => x.code === 'NUMBER_ALTERED'));
});

test('overlay passes a clean script using claim numbers exactly', () => {
  const f = validatorOverlay({
    scriptText: 'Emergency pills do not end a pregnancy that has started. Take them within 72 hours.',
    claims: CLAIMS, card: CARD, riskTier: 'TIER_3', cta: CARD.approved_ctas[0] });
  const blockers = f.filter(x => x.severity === 'BLOCKER');
  assert.equal(blockers.length, 0, JSON.stringify(blockers));
});

test('overlay catches prohibited claim in different wording', () => {
  const f = validatorOverlay({
    scriptText: 'Emergency contraception ends the pregnancy quickly and safely for you.',
    claims: CLAIMS, card: CARD, riskTier: 'TIER_3', cta: CARD.approved_ctas[0] });
  assert.ok(f.some(x => x.code === 'PROHIBITED_CLAIM'));
});

test('tier 4 without referral phrase is blocked', () => {
  const f = validatorOverlay({
    scriptText: 'This is very serious information about your safety only.',
    claims: CLAIMS, card: { ...CARD, referral_conditions: [] }, riskTier: 'TIER_4', cta: null });
  assert.ok(f.some(x => x.code === 'MISSING_REFERRAL' && x.severity === 'BLOCKER'));
});

test('presenter credential label is blocked', () => {
  const f = validatorOverlay({ scriptText: 'ok', claims: CLAIMS, card: CARD,
    riskTier: 'TIER_1', presenterLabel: 'Dr. Letena' });
  assert.ok(f.some(x => x.code === 'IMPLIED_CREDENTIALS'));
});

test('overall result fails on any unsupported statement', () => {
  assert.equal(overallResult([{ verdict: 'SUPPORTED' }, { verdict: 'UNSUPPORTED' }], []), 'FAIL');
  assert.equal(overallResult([{ verdict: 'SUPPORTED' }], [{ severity: 'BLOCKER' }]), 'FAIL');
  assert.equal(overallResult([{ verdict: 'SUPPORTED' }], [{ severity: 'MINOR' }]), 'PASS');
});

test('risk tier escalates and never lowers', () => {
  assert.equal(computeRiskTier({ cardTiers: ['TIER_2'], claimTypes: ['REFERRAL_TRIGGER'] }), 'TIER_3');
  assert.equal(computeRiskTier({ cardTiers: ['TIER_1'], topicCodes: ['SAFE'] }), 'TIER_4');
  assert.equal(computeRiskTier({ cardTiers: ['TIER_3'], manualOverride: 'TIER_2' }), 'TIER_3');
});

test('composite underweights reach by design', () => {
  const highReachNoService = compositeScore(95, 20, 5);
  const modestReachHighService = compositeScore(40, 80, 85);
  assert.ok(modestReachHighService > highReachNoService);
});

test('trigram similarity is sane', () => {
  assert.ok(trigramSimilarity('emergency pills end a pregnancy', 'Emergency contraception ends a pregnancy') > 0.4);
  assert.ok(trigramSimilarity('completely unrelated text here', 'Emergency contraception ends a pregnancy') < 0.2);
});
