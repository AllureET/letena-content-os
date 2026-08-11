import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deidentify, deterministicPass, containsForbidden, applySpans } from '../src/index.mjs';

const IDENTIFIED = [
  ['phone +251', 'Call me on +251911234567 please', '[PHONE]'],
  ['phone 09', 'my number is 0911 23 45 67', '[PHONE]'],
  ['phone 07', 'text 0712345678 after 6', '[PHONE]'],
  ['email', 'reach me at hana.t@gmail.com', '[EMAIL]'],
  ['handle', 'my telegram is @hana_addis22', '[HANDLE]'],
  ['tme link', 'find me t.me/hana_addis', '[HANDLE]'],
  ['visit ref', 'my ref is LET/482/2026 from last time', '[ID]'],
  ['matter id', 'about mtr_9f3k2a please', '[ID]'],
  ['patient no', 'patient id: 44821 said to ask', '[ID]'],
  ['long digits', 'my fayda is 123456789012', '[ID]'],
  ['name cue en', 'My name is Hana and I took Postpill', '[NAME]'],
  ['name cue am', 'ስሜ ሐና እባላለሁ። ፖስትፒል ወስጃለሁ', '[NAME]'],
];

for (const [label, input, placeholder] of IDENTIFIED) {
  test(`redacts ${label}`, () => {
    const r = deidentify(input);
    assert.ok(r.text.includes(placeholder), `expected ${placeholder} in "${r.text}"`);
    assert.ok(!containsForbidden(r.text), `forbidden residual in "${r.text}"`);
    assert.ok(r.redactions.length > 0);
  });
}

test('clean amharic question passes untouched with full confidence', () => {
  const input = 'ፖስትፒል በወር ሁለት ጊዜ ወስጃለሁ። ልጅ መውለድ እችላለሁ?';
  const r = deidentify(input);
  assert.equal(r.text, input);
  assert.equal(r.confidence, 1);
});

test('clean english question passes untouched', () => {
  const input = 'I took Postpill twice this month. Will I still be able to have children?';
  const r = deidentify(input);
  assert.equal(r.text, input);
  assert.equal(r.confidence, 1);
});

test('age, city and gender are NOT redacted', () => {
  const input = 'I am 22, female, in Addis Ababa. Is my implant bleeding normal?';
  const r = deidentify(input);
  assert.equal(r.text, input);
});

test('applySpans replaces model spans without model rewriting', () => {
  const text = 'Hana in Bole clinic asked about EC';
  const r = applySpans(text, [
    { start: 0, end: 4, type: 'PERSON' },
    { start: 8, end: 19, type: 'PLACE_FINE' },
  ]);
  assert.equal(r.text, '[NAME] in [PLACE] asked about EC');
});

test('applySpans ignores invalid spans', () => {
  const r = applySpans('short', [{ start: 2, end: 99, type: 'PERSON' }, { start: -1, end: 2, type: 'ID' }]);
  assert.equal(r.text, 'short');
});

test('multiple identifiers in one message all removed', () => {
  const r = deidentify('My name is Sara, call 0911234567 or @sara_a, ref LET/12/2026');
  for (const p of ['[NAME]', '[PHONE]', '[HANDLE]', '[ID]']) {
    assert.ok(r.text.includes(p), `missing ${p} in "${r.text}"`);
  }
  assert.ok(!containsForbidden(r.text));
});
