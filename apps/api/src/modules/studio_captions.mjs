// Caption/subtitle timing (25 Aug 2026, Nate: "if we had like subtitles,
// can we make it so they match the timing of her mouth somehow?").
//
// There is no per-word timing anywhere in this pipeline. Gemini/Azure/
// ElevenLabs TTS (adapters/index.mjs) all hand back one finished audio file
// and nothing else -- no phoneme boundaries, no word timestamps. True
// forced alignment (feeding audio plus the exact text it says into a model
// that returns word-level timing) needs an acoustic model per language, and
// nothing like that is installed in this environment, nor is Amharic
// support in the common open tools (Montreal Forced Aligner, wav2vec2 CTC
// aligners) something this sandbox can verify or vendor safely tonight.
//
// So this leans on the two things every TTS engine's OUTPUT already gives
// for free, with zero new dependencies: real detected pauses in the audio
// (ffmpeg's own silencedetect filter, already in this build) and the exact
// narration text that was voiced (already known -- it is literally what
// was sent to the TTS call, stored on the shot). Captions are chunked into
// subtitle-sized phrases from that known text, then walked across the REAL
// speech segments (the gaps between detected silences) in proportion to
// each phrase's length. A caption's start and end land on a real detected
// pause whenever one exists nearby, rather than splitting a spoken phrase
// down the middle -- closer to her actual mouth timing than one flat rate
// across the whole clip, but it is pause-anchored phrase timing, not
// phoneme-level lip sync. Worth being exact about that with a non-technical
// reviewer: watch the captions against the real cut before approving, same
// as any other overlay.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// Amharic and Latin sentence-ending punctuation. '።' (U+1362) is the Ge'ez
// full stop. '፡' (U+1361), the old word-space mark, is deliberately NOT
// treated as a sentence end -- in real Amharic text it shows up far more
// often than an actual sentence boundary would, and splitting on it would
// chop captions after almost every word.
const SENTENCE_END = /([።፨.!?]+)\s*/g;
// Clause-level marks used to sub-split a sentence still too long for one
// caption card: Ge'ez comma/semicolon/colon (፣ ፤ ፥ ፦) plus the Latin
// comma/semicolon/colon Amharic keyboards commonly borrow.
const CLAUSE_END = /([፣፤፥፦,;:]+)\s*/g;

const DEFAULT_MAX_WORDS = 7;
const DEFAULT_MAX_CHARS = 46;
const MIN_CAPTION_DUR_S = 0.6;
const MIN_SPEECH_SEGMENT_S = 0.12;

function splitOn(text, re) {
  const parts = [];
  let last = 0;
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    parts.push(text.slice(last, end).trim());
    last = end;
  }
  const rest = text.slice(last).trim();
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

function wordCount(s) { return s.trim().split(/\s+/).filter(Boolean).length; }

// Splits one piece of text at plain word boundaries so no chunk exceeds
// maxWords/maxChars, never inside a word. The last-resort sub-splitter,
// used only when a clause has no comma-level break to lean on and is still
// too long for one card.
function splitByWords(text, maxWords, maxChars) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const chunks = [];
  let current = [];
  for (const w of words) {
    const trial = [...current, w];
    if (current.length && (trial.length > maxWords || trial.join(' ').length > maxChars)) {
      chunks.push(current.join(' '));
      current = [w];
    } else {
      current = trial;
    }
  }
  if (current.length) chunks.push(current.join(' '));
  return chunks;
}

// Splits narration text into subtitle-sized reading chunks, in order, never
// reordering or dropping words. Sentence marks are the primary break;
// anything still too long is sub-split on clause marks, then on plain word
// boundaries as a last resort. Pure and deterministic -- same text always
// produces the same chunks, which is what makes this independently
// unit-testable without any audio at all.
export function chunkNarrationText(text, opts = {}) {
  const maxWords = opts.maxWords ?? DEFAULT_MAX_WORDS;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = splitOn(clean, SENTENCE_END);
  const chunks = [];
  for (const sentence of sentences) {
    if (wordCount(sentence) <= maxWords && sentence.length <= maxChars) { chunks.push(sentence); continue; }
    const clauses = splitOn(sentence, CLAUSE_END);
    for (const clause of clauses) {
      if (wordCount(clause) <= maxWords && clause.length <= maxChars) { chunks.push(clause); continue; }
      chunks.push(...splitByWords(clause, maxWords, maxChars));
    }
  }
  return chunks;
}

// Parses ffmpeg's `-af silencedetect=noise=X:d=Y -f null -` stderr into a
// list of silence intervals, clamped to [0, totalDurationS]. ffmpeg always
// emits silence_start before its matching silence_end; a silence still
// running when the stream ends emits silence_start with no matching end,
// closed here at totalDurationS rather than dropped.
export function parseSilenceDetect(stderrText, totalDurationS) {
  const text = String(stderrText ?? '');
  const starts = [...text.matchAll(/silence_start:\s*([\d.]+)/g)].map(m => Number(m[1]));
  const ends = [...text.matchAll(/silence_end:\s*([\d.]+)/g)].map(m => Number(m[1]));
  return starts
    .map((s, i) => ({ start: s, end: ends[i] ?? totalDurationS }))
    .map(iv => ({ start: Math.max(0, iv.start), end: Math.min(totalDurationS, iv.end) }))
    .filter(iv => iv.end > iv.start);
}

// The complement of the silence intervals within [0, totalDurationS]: the
// stretches where she is actually speaking. Silences are assumed sorted by
// start and non-overlapping, which is how ffmpeg's own silencedetect always
// reports them.
export function speechSegmentsFromSilences(silences, totalDurationS, minSegmentS = MIN_SPEECH_SEGMENT_S) {
  const segs = [];
  let cursor = 0;
  for (const s of silences) {
    if (s.start > cursor) segs.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < totalDurationS) segs.push({ start: cursor, end: totalDurationS });
  return segs.filter(seg => seg.end - seg.start >= minSegmentS);
}

// The core timing assignment. Chunks are walked across the real speech
// segments in proportion to character length -- a plain, language-agnostic
// stand-in for spoken duration (no syllable model for Amharic exists here;
// character count is the same rough proxy compileCardSvg's text-box sizing
// already leans on). A virtual "speaking-only" clock (0..total speaking
// time, silences removed) places each chunk boundary, which is then mapped
// back onto the real, gapped clock -- so a chunk's start/end always falls
// where real speech actually is, never partway through a detected silence.
export function assignChunkTimings(chunks, speechSegments, totalDurationS) {
  if (!chunks.length) return [];
  const segments = (speechSegments && speechSegments.length) ? speechSegments : [{ start: 0, end: totalDurationS }];
  const totalSpeakS = segments.reduce((sum, s) => sum + (s.end - s.start), 0) || totalDurationS || 1;
  const weights = chunks.map(c => Math.max(1, String(c ?? '').trim().length));
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;

  const virtualToReal = (vt) => {
    let remaining = Math.max(0, vt);
    for (const seg of segments) {
      const segDur = seg.end - seg.start;
      if (remaining <= segDur) return seg.start + remaining;
      remaining -= segDur;
    }
    return segments[segments.length - 1].end;
  };

  let vCursor = 0;
  const timings = [];
  for (let i = 0; i < chunks.length; i++) {
    const vStart = vCursor;
    vCursor += totalSpeakS * (weights[i] / totalWeight);
    const start = virtualToReal(vStart);
    let end = virtualToReal(vCursor);
    if (end - start < MIN_CAPTION_DUR_S) end = Math.min(totalDurationS, start + MIN_CAPTION_DUR_S);
    timings.push({ text: chunks[i], start_s: Math.round(start * 100) / 100, end_s: Math.round(end * 100) / 100 });
  }
  // The MIN_CAPTION_DUR_S floor above can push one chunk's end past the
  // next chunk's natural start (a run of very short chunks near the end of
  // the clip). Clamp forward so two captions are never asked to show at
  // once, then re-apply the same floor to the pushed-forward chunk -- just
  // clamping start without re-flooring end would quietly let the floor
  // evaporate for whichever chunk got shoved. Only degrades below the floor
  // when there truly is not enough total time left for it (chunks.length *
  // MIN_CAPTION_DUR_S exceeds what remains), which a real narration clip of
  // any normal length never runs into.
  for (let i = 1; i < timings.length; i++) {
    if (timings[i].start_s < timings[i - 1].end_s) timings[i].start_s = timings[i - 1].end_s;
    const minEnd = Math.min(totalDurationS, timings[i].start_s + MIN_CAPTION_DUR_S);
    if (timings[i].end_s < minEnd) timings[i].end_s = minEnd;
  }
  return timings;
}

// Positional alignment of REAL ASR word timings (e.g. from Azure Speech-to-
// Text, see adapters/index.mjs's azureSTT.wordTimings) onto OUR
// already-known-correct caption chunks. The ASR's own recognized TEXT is
// never trusted or used here -- Amharic ASR mis-hears plenty of words, and
// our script is already correct (it is what was fed to the TTS call). Only
// the ASR's per-word TIMING is used, matched onto our chunks by word
// POSITION rather than by text match. If the ASR heard a different number of
// words than our script has (a missed word, a number read as digits, a
// filler sound), matching position 1-to-1 would start out right and drift
// further wrong with every later word, so each of our word positions is
// instead linearly resampled onto the ASR's word index range -- keeps the
// two streams roughly in step across the whole clip instead of accurate
// only near the start. Returns null (never throws) when there is no usable
// ASR data, so callers can fall straight through to the pause-anchored
// heuristic below with one `?? await captionTimingsForNarration(...)`-style
// fallback.
export function alignWordsToChunks(chunks, asrWords, totalDurationS) {
  if (!chunks.length) return null;
  if (!asrWords || !asrWords.length) return null;
  const chunkWordCounts = chunks.map(c => Math.max(1, wordCount(c)));
  const totalWords = chunkWordCounts.reduce((a, b) => a + b, 0) || 1;
  const scale = asrWords.length > 1 ? (asrWords.length - 1) / Math.max(1, totalWords - 1) : 0;
  const asrIndexFor = (wordPos) => Math.min(asrWords.length - 1, Math.max(0, Math.round(wordPos * scale)));

  const timings = [];
  let wordCursor = 0;
  for (let i = 0; i < chunks.length; i++) {
    const n = chunkWordCounts[i];
    const firstIdx = asrIndexFor(wordCursor);
    const lastIdx = Math.max(firstIdx, asrIndexFor(wordCursor + n - 1));
    const start = asrWords[firstIdx].start_s;
    let end = asrWords[lastIdx].end_s;
    if (end - start < MIN_CAPTION_DUR_S) end = Math.min(totalDurationS, start + MIN_CAPTION_DUR_S);
    timings.push({
      text: chunks[i],
      start_s: Math.round(Math.max(0, start) * 100) / 100,
      end_s: Math.round(Math.min(totalDurationS, end) * 100) / 100,
    });
    wordCursor += n;
  }
  // Same forward-clamp-then-re-floor as assignChunkTimings, for the same
  // reason: two ASR words with an odd overlap (or the MIN_CAPTION_DUR_S
  // floor above) must never leave two captions asking to show at once.
  for (let i = 1; i < timings.length; i++) {
    if (timings[i].start_s < timings[i - 1].end_s) timings[i].start_s = timings[i - 1].end_s;
    const minEnd = Math.min(totalDurationS, timings[i].start_s + MIN_CAPTION_DUR_S);
    if (timings[i].end_s < minEnd) timings[i].end_s = minEnd;
  }
  return timings;
}

// End-to-end with a real ASR word-timing source layered in front of the
// pause-anchored heuristic. getWordTimings is INJECTED, not imported --
// keeps this module needing zero vendor credentials to unit test, same
// discipline as detectSpeechSegments shelling out to ffmpeg directly rather
// than going through a mockable adapter layer would have broken. Pass a
// function `(localAudioPath) => Promise<[{word,start_s,end_s}]|null>` (Azure
// STT already shaped that way); its result feeding alignWordsToChunks. Any
// failure -- Azure down, no credentials, clip over the 60s REST limit, no
// usable words back -- falls through to captionTimingsForNarration, exactly
// as if this function had never been called. Returns both the timings and
// which method actually produced them, since that is worth surfacing to
// whoever reviews the captions afterward.
export async function captionTimingsForNarrationASR(text, localAudioPath, durationS, getWordTimings, opts = {}) {
  const chunks = chunkNarrationText(text, opts);
  if (!chunks.length || !(durationS > 0)) return { timings: [], method: 'none' };
  if (typeof getWordTimings === 'function') {
    try {
      const words = await getWordTimings(localAudioPath);
      const aligned = alignWordsToChunks(chunks, words, durationS);
      if (aligned) return { timings: aligned, method: 'asr_word_timing' };
    } catch { /* Azure unavailable/failed -- fall through to the heuristic */ }
  }
  const timings = await captionTimingsForNarration(text, localAudioPath, durationS, opts);
  return { timings, method: 'pause_heuristic' };
}

// Runs ffmpeg's silencedetect over a local audio/video file and returns the
// speech segments (the complement of detected silence) within
// [0, totalDurationS]. noiseDb/minSilenceS are tuned for a clean TTS
// narration track; a real room recording with background noise would need
// a louder noise floor, which is why both are exposed rather than baked in.
export async function detectSpeechSegments(localAudioPath, totalDurationS, opts = {}) {
  const noiseDb = opts.noiseDb ?? '-30dB';
  const minSilenceS = opts.minSilenceS ?? MIN_SPEECH_SEGMENT_S;
  let stderr = '';
  try {
    await execFileP('ffmpeg', [
      '-i', localAudioPath, '-af', `silencedetect=noise=${noiseDb}:d=${minSilenceS}`,
      '-f', 'null', '-',
    ]);
  } catch (e) {
    // `-f null -` still exits non-zero on some ffmpeg builds even on
    // success; the silencedetect log lines are on stderr either way, which
    // is all this actually needs.
    stderr = e.stderr ?? '';
  }
  const silences = parseSilenceDetect(stderr, totalDurationS);
  return speechSegmentsFromSilences(silences, totalDurationS);
}

// End-to-end: known narration text + a local audio file -> caption timings
// in LOCAL time (0..durationS, relative to that one clip). The caller is
// responsible for offsetting these onto the project's absolute assembled
// timeline -- different shots land on different cursors depending on
// whether their narration is a separate voice track or already baked into
// the picture (see studio.mjs's assemble route and its layVoiceOntoVideo
// header for why those two cursors differ).
export async function captionTimingsForNarration(text, localAudioPath, durationS, opts = {}) {
  const chunks = chunkNarrationText(text, opts);
  if (!chunks.length || !(durationS > 0)) return [];
  let segments;
  try {
    segments = await detectSpeechSegments(localAudioPath, durationS, opts);
  } catch {
    segments = [];
  }
  return assignChunkTimings(chunks, segments, durationS);
}

// Default styling for an auto-generated caption overlay -- a bottom-
// anchored, dark semi-transparent box behind light text, the way subtitles
// read on a vertical talking-head video. Text shadow stays on together with
// the box (a light background under a bright dress does not wash the words
// out even without the box); a reviewer can turn either off afterward in
// the same friendly fields any other LABEL uses.
export function defaultCaptionData(text) {
  return {
    text,
    font_family: 'bold',
    font_size_px: 34,
    text_color: '#FFFFFF',
    background_color: '#000000',
    background_opacity: 0.55,
    corner_radius_px: 10,
    text_shadow: true,
    position: { anchor: 'bottom', inset_px: 64, avoid_face: true },
  };
}
