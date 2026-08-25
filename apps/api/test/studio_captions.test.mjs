// Pure-function tests for the caption timing engine (25 Aug 2026). No DB,
// no ffmpeg -- detectSpeechSegments (the one function that shells out) is
// deliberately not exercised here; parseSilenceDetect/speechSegmentsFromSilences
// are tested directly against hand-built ffmpeg-shaped input instead, same
// split this codebase already uses for compileOverlaySvg vs the real
// assemble ffmpeg call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkNarrationText, parseSilenceDetect, speechSegmentsFromSilences,
  assignChunkTimings, defaultCaptionData, alignWordsToChunks,
  captionTimingsForNarrationASR,
} from '../src/modules/studio_captions.mjs';

test('chunks a short line as one caption', () => {
  const chunks = chunkNarrationText('You are not alone in this.');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], 'You are not alone in this.');
});

test('splits on sentence marks, keeping word order intact', () => {
  const chunks = chunkNarrationText('Spotting is common. It is not always a problem.');
  assert.deepEqual(chunks, ['Spotting is common.', 'It is not always a problem.']);
});

test('splits on Amharic sentence mark (።)', () => {
  const chunks = chunkNarrationText('ደም መፍሰስ የተለመደ ነው። ሁልጊዜ ችግር አይደለም።');
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].includes('ደም መፍሰስ የተለመደ ነው'));
});

test('does not split on the Amharic word-space mark (፡)', () => {
  const chunks = chunkNarrationText('አንድ ቃል፡ ሌላ ቃል፡ ሶስተኛ ቃል');
  // ፡ is a soft word-space, not a sentence end -- must not fragment this
  // into three one-"sentence" chunks before the word-budget even applies.
  assert.equal(chunks.length, 1);
});

test('sub-splits an overlong sentence on clause marks without dropping words', () => {
  const longSentence = 'This is the first clause here, and this is the second clause here, and this is the third one too.';
  const chunks = chunkNarrationText(longSentence, { maxWords: 6, maxChars: 40 });
  assert.ok(chunks.length > 1);
  const rejoined = chunks.join(' ').replace(/\s+/g, ' ');
  const original = longSentence.replace(/\s+/g, ' ');
  // Every word from the original survives, in order (punctuation/spacing
  // around split points may differ slightly, so compare word streams).
  const words = (s) => s.split(/\s+/).filter(Boolean).map(w => w.replace(/[,.]/g, ''));
  assert.deepEqual(words(rejoined), words(original));
  for (const c of chunks) assert.ok(c.length <= 40 || c.split(/\s+/).length === 1, `chunk too long: "${c}"`);
});

test('never splits inside a single long word', () => {
  const chunks = chunkNarrationText('supercalifragilisticexpialidocious', { maxWords: 2, maxChars: 5 });
  assert.deepEqual(chunks, ['supercalifragilisticexpialidocious']);
});

test('empty/whitespace-only text produces no chunks', () => {
  assert.deepEqual(chunkNarrationText(''), []);
  assert.deepEqual(chunkNarrationText('   '), []);
  assert.deepEqual(chunkNarrationText(null), []);
});

test('parses silence_start/silence_end pairs from real ffmpeg stderr shape', () => {
  const stderr = `
[silencedetect @ 0x1] silence_start: 2.400000
[silencedetect @ 0x1] silence_end: 2.700000 | silence_duration: 0.300000
[silencedetect @ 0x1] silence_start: 6.100000
[silencedetect @ 0x1] silence_end: 6.550000 | silence_duration: 0.450000
`;
  const silences = parseSilenceDetect(stderr, 10);
  assert.deepEqual(silences, [{ start: 2.4, end: 2.7 }, { start: 6.1, end: 6.55 }]);
});

test('a silence still open at end of stream closes at totalDurationS', () => {
  const stderr = `[silencedetect @ 0x1] silence_start: 8.000000\n`;
  const silences = parseSilenceDetect(stderr, 10);
  assert.deepEqual(silences, [{ start: 8, end: 10 }]);
});

test('speech segments are the complement of silences, tiny slivers dropped', () => {
  const silences = [{ start: 2, end: 2.3 }, { start: 5, end: 5.05 }];
  const segs = speechSegmentsFromSilences(silences, 10, 0.12);
  // [0,2] and [2.3,5] survive; [5,5.05] silence gap too short to matter,
  // [5.05,10] survives. The 0.05s sliver between the two silences is real
  // speech time and must not be silently merged away.
  assert.deepEqual(segs, [{ start: 0, end: 2 }, { start: 2.3, end: 5 }, { start: 5.05, end: 10 }]);
});

test('no silences at all: the whole clip is one speech segment', () => {
  assert.deepEqual(speechSegmentsFromSilences([], 7.5), [{ start: 0, end: 7.5 }]);
});

test('chunk timings land in order, never overlapping, never past totalDurationS', () => {
  const chunks = ['Short one.', 'A somewhat longer second phrase here.', 'End.'];
  const segments = [{ start: 0, end: 2 }, { start: 2.5, end: 6 }];
  const timings = assignChunkTimings(chunks, segments, 6);
  assert.equal(timings.length, 3);
  for (const t of timings) {
    assert.ok(t.start_s >= 0 && t.end_s <= 6, `out of bounds: ${JSON.stringify(t)}`);
    assert.ok(t.end_s > t.start_s, `non-positive duration: ${JSON.stringify(t)}`);
  }
  for (let i = 1; i < timings.length; i++) {
    assert.ok(timings[i].start_s >= timings[i - 1].end_s,
      `overlap between "${timings[i - 1].text}" and "${timings[i].text}"`);
  }
});

test('a caption never starts or ends inside a real detected silence gap', () => {
  // One big pause right in the middle -- no chunk boundary should land
  // strictly inside [2, 4).
  const chunks = ['First half of the line.', 'Second half of the line.'];
  const segments = [{ start: 0, end: 2 }, { start: 4, end: 8 }];
  const timings = assignChunkTimings(chunks, segments, 8);
  for (const t of timings) {
    for (const boundary of [t.start_s, t.end_s]) {
      const insideGap = boundary > 2 && boundary < 4;
      assert.ok(!insideGap, `boundary ${boundary} lands inside the silence gap`);
    }
  }
});

test('longer chunks get proportionally more of the speaking time than shorter ones', () => {
  const chunks = ['Hi.', 'This is a much, much longer phrase than the first one by far.'];
  const timings = assignChunkTimings(chunks, [{ start: 0, end: 10 }], 10);
  const dur = (t) => t.end_s - t.start_s;
  assert.ok(dur(timings[1]) > dur(timings[0]), 'the longer phrase should get more screen time');
});

test('a very short weight still gets at least the minimum caption duration', () => {
  // 3 chunks at a real 0.6s floor need at least 1.8s of room; give it 4s so
  // the floor is actually achievable, unlike a synthetic 1.2s clip where
  // 3 * 0.6s cannot possibly fit and degrading is the only honest option.
  const timings = assignChunkTimings(['Hi.', 'Ok.', 'Bye now, everyone here.'], [{ start: 0, end: 4 }], 4);
  for (const t of timings) assert.ok(t.end_s - t.start_s >= 0.6 - 1e-9, `too short to read: ${JSON.stringify(t)}`);
});

test('alignWordsToChunks maps chunks onto real ASR word timings by position', () => {
  // 'Hi there.' (2 words) + 'Bye now friend.' (3 words) = 5 script words,
  // matched 1-to-1 against 5 ASR words of known timing.
  const chunks = ['Hi there.', 'Bye now friend.'];
  const asrWords = [
    { word: 'Hi', start_s: 0.0, end_s: 0.4 },
    { word: 'there', start_s: 0.4, end_s: 1.0 },
    { word: 'Bye', start_s: 1.5, end_s: 1.9 },
    { word: 'now', start_s: 1.9, end_s: 2.2 },
    { word: 'friend', start_s: 2.2, end_s: 2.8 },
  ];
  const timings = alignWordsToChunks(chunks, asrWords, 3);
  assert.equal(timings.length, 2);
  assert.equal(timings[0].start_s, 0);
  assert.equal(timings[0].end_s, 1);
  assert.equal(timings[1].start_s, 1.5);
  assert.equal(timings[1].end_s, 2.8);
});

test('alignWordsToChunks degrades gracefully when ASR heard a different word count than the script', () => {
  // Script has 6 words across 2 chunks; ASR only recognized 4 words (missed
  // one, merged another) -- must still produce in-order, non-overlapping,
  // in-bounds timings rather than throwing or running off the end.
  const chunks = ['This is the first chunk.', 'This is the second one.'];
  const asrWords = [
    { word: 'this', start_s: 0, end_s: 0.5 },
    { word: 'is', start_s: 0.5, end_s: 0.8 },
    { word: 'chunk', start_s: 0.8, end_s: 1.3 },
    { word: 'second', start_s: 1.3, end_s: 1.8 },
  ];
  const timings = alignWordsToChunks(chunks, asrWords, 2);
  assert.equal(timings.length, 2);
  for (const t of timings) {
    assert.ok(t.start_s >= 0 && t.end_s <= 2, `out of bounds: ${JSON.stringify(t)}`);
    assert.ok(t.end_s > t.start_s, `non-positive duration: ${JSON.stringify(t)}`);
  }
  assert.ok(timings[1].start_s >= timings[0].end_s, 'chunks must not overlap');
});

test('alignWordsToChunks returns null (not a crash) when there is no usable ASR data', () => {
  assert.equal(alignWordsToChunks(['Hello.'], null, 5), null);
  assert.equal(alignWordsToChunks(['Hello.'], [], 5), null);
  assert.equal(alignWordsToChunks([], [{ word: 'x', start_s: 0, end_s: 1 }], 5), null);
});

test('captionTimingsForNarrationASR prefers real ASR word timing when it is available', async () => {
  const asrWords = [
    { word: 'you', start_s: 0.1, end_s: 0.3 },
    { word: 'are', start_s: 0.3, end_s: 0.5 },
    { word: 'not', start_s: 0.5, end_s: 0.8 },
    { word: 'alone', start_s: 0.8, end_s: 1.3 },
  ];
  const result = await captionTimingsForNarrationASR(
    'You are not alone.', '/nonexistent/audio.wav', 2, async () => asrWords);
  assert.equal(result.method, 'asr_word_timing');
  assert.equal(result.timings.length, 1);
  assert.equal(result.timings[0].start_s, 0.1);
  assert.equal(result.timings[0].end_s, 1.3);
});

test('captionTimingsForNarrationASR falls back to the pause heuristic when ASR is unavailable', async () => {
  // getWordTimings resolving null (no Azure key / mock mode) must fall
  // through to the exact same heuristic captionTimingsForNarration already
  // uses -- proven here by comparing against a real audio path is not
  // needed, only that it degrades instead of throwing.
  const resultNull = await captionTimingsForNarrationASR(
    'Spotting is common. It is not always a problem.', '/nonexistent/audio.wav', 6, async () => null);
  assert.equal(resultNull.method, 'pause_heuristic');
  assert.ok(resultNull.timings.length >= 1);

  // getWordTimings throwing (a real Azure network/API failure) must fall
  // through the same way, never bubble up to the caller.
  const resultThrow = await captionTimingsForNarrationASR(
    'Spotting is common. It is not always a problem.', '/nonexistent/audio.wav', 6,
    async () => { throw new Error('azure stt 503'); });
  assert.equal(resultThrow.method, 'pause_heuristic');
  assert.ok(resultThrow.timings.length >= 1);
});

test('defaultCaptionData renders as a bottom-anchored, readable card', () => {
  const d = defaultCaptionData('Hello there.');
  assert.equal(d.text, 'Hello there.');
  assert.equal(d.position.anchor, 'bottom');
  assert.ok(d.background_opacity > 0 && d.background_opacity < 1);
  assert.equal(d.text_shadow, true);
});
