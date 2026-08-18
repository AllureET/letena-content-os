// Regression tests for applyDeterministicCta (18 Aug 2026). No DB needed:
// the function is pure over its (fmtRow, sc) arguments, so these run
// against plain mock format rows rather than the live content_formats
// registry. See test/part1_corrections.test.mjs for the DB-backed check
// that every REAL registry row's cta_spec assembles cleanly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDeterministicCta } from '../src/modules/content.mjs';
import { LETENA_AMHARIC_BLOCKS } from '../src/letena_canon.mjs';

const SEND_IT_FMT = {
  body_kind: 'VIDEO',
  cta_spec: { blocks: ['door', 'vo_close', 'onscreen'], actions: ['call', 'dm'] },
};

test('applyDeterministicCta overwrites a corrupted/paraphrased cta with the canonical assembly', () => {
  const sc = { cta: 'Message us on Telegram only, no phone number', onscreen_text: [
    { at_second: 0, text: 'hook text', emphasis: 'NORMAL' },
    { at_second: 12, text: 'a paraphrased, incomplete CTA someone hand-wrote', emphasis: 'STRONG' },
  ] };
  applyDeterministicCta(SEND_IT_FMT, sc);
  assert.ok(sc.cta.includes('0908 182 838'), 'assembled cta must carry the real WhatsApp number');
  assert.ok(sc.cta.includes(LETENA_AMHARIC_BLOCKS.door));
  assert.ok(sc.cta.includes(LETENA_AMHARIC_BLOCKS.vo_close));
  assert.ok(sc.cta.includes(LETENA_AMHARIC_BLOCKS.onscreen));
});

test('applyDeterministicCta replaces only the final onscreen beat with the canonical onscreen block, keeping timing', () => {
  const sc = { cta: 'draft', onscreen_text: [
    { at_second: 0, text: 'hook text', emphasis: 'NORMAL' },
    { at_second: 12, text: 'stripped-down CTA missing the phone number', emphasis: 'STRONG' },
  ] };
  applyDeterministicCta(SEND_IT_FMT, sc);
  assert.equal(sc.onscreen_text[0].text, 'hook text', 'non-door beats are untouched');
  assert.equal(sc.onscreen_text[1].at_second, 12, 'timing is preserved');
  assert.equal(sc.onscreen_text[1].text, LETENA_AMHARIC_BLOCKS.onscreen);
});

test('applyDeterministicCta leaves cta untouched for a format with an empty cta_spec', () => {
  const sc = { cta: 'UI strings carry no CTA', onscreen_text: [] };
  applyDeterministicCta({ body_kind: 'MICROCOPY', cta_spec: {} }, sc);
  assert.equal(sc.cta, 'UI strings carry no CTA');
});

test('applyDeterministicCta assembles a deep_link/contact CTA for a non-door surface (push notification)', () => {
  const sc = { cta: 'anything the model wrote', onscreen_text: [] };
  applyDeterministicCta({ body_kind: 'PUSH', cta_spec: { blocks: [], actions: ['dm'], deep_link: 'abeba://ask' } }, sc);
  assert.equal(sc.cta, 'abeba://ask');
});

test('applyDeterministicCta prefers a role:"DOOR" tagged beat over positional last-beat fallback', () => {
  const sc = { cta: 'x', onscreen_text: [
    { at_second: 0, text: 'hook', role: 'HOOK' },
    { at_second: 8, text: 'stripped CTA', role: 'DOOR' },
    { at_second: 14, text: 'a trailing share nudge that is not the door', role: 'SHARE' },
  ] };
  applyDeterministicCta(SEND_IT_FMT, sc);
  assert.equal(sc.onscreen_text[1].text, LETENA_AMHARIC_BLOCKS.onscreen, 'the role:DOOR beat gets the canonical text');
  assert.equal(sc.onscreen_text[2].text, 'a trailing share nudge that is not the door', 'the trailing non-door beat is untouched');
});

test('applyDeterministicCta never touches onscreen_text for a non-VIDEO body_kind even with an onscreen block', () => {
  const sc = { cta: 'x', onscreen_text: [{ at_second: 0, text: 'should not change', emphasis: 'NORMAL' }] };
  applyDeterministicCta({ body_kind: 'CAROUSEL', cta_spec: { blocks: ['door', 'onscreen'] } }, sc);
  assert.equal(sc.onscreen_text[0].text, 'should not change');
});
