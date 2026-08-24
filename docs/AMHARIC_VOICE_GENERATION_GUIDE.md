# Amharic voice generation: Gemini TTS source guide

**Status: experimental, under evaluation (24 Aug 2026).** This is not yet the default. It is a second Amharic narration option, tried alongside the existing Azure Speech path, not a replacement for it. Update this status line once a real sample has been reviewed and a decision made either way.

## Why this exists

Azure Speech (`am-ET-MekdesNeural` / `am-ET-AmehaNeural`) has been the only Amharic voice option in Video Studio so far. Google's Gemini API now has its own native text-to-speech models, and unlike most TTS systems, Gemini's TTS is *prompt-directed*: you describe the accent, pacing, warmth, and emphasis you want in plain language, in the same request as the text to speak, instead of picking from fixed voice parameters or writing SSML. That is a genuinely different, potentially better fit for getting narration to sound like a real Ethiopian speaker rather than a foreign accent reading Amharic off a page, which is the main long-running quality risk with any TTS system on a lower-resource language.

This document is the style guide for getting good results out of that prompt-directed control, written for whoever is preparing Amharic scripts for TTS, human or AI. It doubles as the reference for how `gemini.tts()` (`apps/api/src/adapters/index.mjs`) actually talks to the model.

## How this is wired into LCOS

- `POST /studio/shots/:shotId/voice` accepts an optional `provider` field. Omitted or `"AZURE"` behaves exactly as before. `"GEMINI"` routes to `gemini.tts()` instead.
- `gemini.tts()` prepends a condensed version of the master voice direction below (`AMHARIC_VOICE_DIRECTION` in the adapter) to whatever line it's given, calls `gemini-3.1-flash-tts-preview` (Settings key `GEMINI_TTS_MODEL`, blank uses that default), and asks for the `Sulafat` voice (Settings key `GEMINI_TTS_VOICE`) unless a different voice is passed.
- Gemini returns headerless 24kHz mono 16-bit PCM. The adapter wraps it in a proper WAV container before storing it, so it plays and probes the same as any other VOICE asset.
- Cost is computed from the real returned audio length (Gemini's TTS pricing: $20 per 1M audio tokens, 25 tokens/second, roughly $0.03/minute) rather than estimated from character count, the same pattern already used for Runway's real per-call cost.
- Gemini has no Ethiopian-accent voice preset. The accent comes entirely from the style direction sent with every line, not from voice selection — this is the whole point of using a prompt-directed TTS model instead of a parameter-driven one.

---

## Goal

Prepare Amharic narration so Gemini produces speech that sounds:

- Native and fluent
- Ethiopian rather than foreign-accented
- Natural in rhythm, inflection, emphasis, and sentence melody
- Appropriate for an Addis Ababa broadcast/conversational style
- Warm, confident, and professional
- Easy to use for audio-driven lip syncing in fal.ai

## Recommended workflow

```text
Amharic Script
    ↓
Gemini TTS
    ↓
Clean WAV / PCM Audio
    ↓
fal.ai Lip Sync
    ↓
Final AI Video
```

Use Gemini to control pronunciation, accent, pacing, emotion, pauses, and emphasis. Use fal.ai primarily to synchronize the finished audio to the face/video.

## 1. Write in proper Amharic script

Prefer standard Ethiopic/Geʽez script.

Good: `ዛሬ ስለ አዲስ የቴክኖሎጂ እድገት እንነጋገራለን።`

Avoid: `Zare sile adis ye technology idget ennegageralen.`

Avoid Latin transliteration unless correcting a foreign name, acronym, or unusual pronunciation.

## 2. Write spoken Amharic, not literal English translation

The script should sound like something a fluent Ethiopian speaker would naturally say aloud.

Prefer natural Ethiopian phrasing, normal spoken sentence order, short clear sentences, familiar transitions, comfortable breath length, and vocabulary appropriate for the audience.

Avoid literal English sentence structures, overly formal bureaucratic Amharic, long multi-clause sentences, unnatural translated expressions, and repetition a native speaker would normally simplify.

A useful test: *would a fluent Ethiopian speaker naturally say this sentence this way?* If not, rewrite it before generating audio.

## 3. Break the script into short semantic chunks

Do not generate an entire page as one TTS request.

- 1-2 sentences per chunk
- One complete idea per chunk
- Roughly 5-15 seconds of speech
- Split before major topic or emotional changes
- Align chunks with video shots when possible

Short chunks make it easier to regenerate one bad line without recreating the entire narration — this maps directly onto Video Studio's per-shot `POST /studio/shots/:shotId/voice` call.

## 4. Do not split in the middle of a thought

Good chunk boundaries: end of a complete sentence, end of one idea, before a new subject, before an important reveal, before a major tone change, at a video shot change.

Avoid splitting between a noun and modifier, in the middle of a quotation, halfway through a sentence, or immediately before a word whose meaning depends heavily on the previous phrase.

## Master voice direction

This is what `AMHARIC_VOICE_DIRECTION` in the adapter actually sends, condensed from the fuller version below:

```text
Speak fluent native Ethiopian Amharic with a natural contemporary
Addis Ababa broadcast/conversational accent.

The speaker should sound like a fluent native Ethiopian Amharic speaker,
never like a foreign speaker reading Amharic.

Use natural Ethiopian phrasing, rhythm, stress, timing, and sentence melody.

Pronounce every word clearly and accurately, but do not over-enunciate.

Use natural meaning-based emphasis. Emphasize the words and ideas that matter
most while allowing supporting words to remain conversational.

Use a comfortable conversational-to-broadcast pace.

Slow slightly before or during important points when it sounds natural.

Use realistic pauses between complete ideas and important transitions.
Do not insert pauses mechanically after every phrase.

The delivery should sound confident, intelligent, warm, composed, and engaging.

Avoid excessive drama, theatrical acting, exaggerated announcer delivery,
robotic cadence, monotone delivery, or an artificial AI-presenter sound.

Do not imitate an American, British, or other foreign accent.

Maintain consistent Ethiopian Amharic pronunciation, speaker identity,
accent, vocal character, and approximate pace across all generated chunks.
```

## Detailed performance controls

**Accent** — natural contemporary Addis Ababa Ethiopian Amharic broadcast/conversational accent; never a foreign speaker who has learned Amharic.

**Pronunciation** — natural as a fluent native speaker; do not apply English pronunciation patterns to Amharic words; integrate foreign names and technical terms naturally into the surrounding Amharic sentence.

**Rhythm and sentence melody** — natural Ethiopian Amharic rhythm; do not give every word equal stress; let less important words stay relaxed and conversational.

**Emphasis** — emphasize the words carrying the main meaning of each sentence; give important contrasts, names, numbers, conclusions, and key claims slightly stronger emphasis; do not emphasize every important-looking word.

**Pacing** — comfortable conversational-to-broadcast pace; slow slightly around important information, technical terminology, important numbers, or major conclusions; do not sound artificially slow.

**Pauses** — short natural pauses at meaningful sentence boundaries; a slightly longer pause before a major new idea or important reveal when appropriate; do not pause mechanically after every clause.

**Tone** — confident, warm, intelligent, composed, credible, engaging.

**Avoid** — foreign-sounding Amharic, English-style intonation, robotic cadence, monotone delivery, excessive drama, theatrical voice acting, exaggerated radio-announcer delivery, shouting, over-enunciation, unnatural pauses, rushing through important information.

## Chunk template

```text
CHUNK ID: 001

PURPOSE:
[What this line is doing in the video]

CONTEXT:
[Optional explanation of what the speaker means]

PERFORMANCE:
[Specific tone, emotion, pace, pause, or emphasis instructions]

AMHARIC:
[Final native-quality Amharic text]
```

## Scene-specific performance instructions

**Informational / explainer** — clear, knowledgeable, relaxed, helpful; conversational educational tone; emphasize the central explanation without sounding like a lecturer.

**News / documentary** — composed Ethiopian broadcast tone; authoritative and clear without becoming stiff; restrained, credible emotional expression.

**Advertisement** — positive, confident, inviting; energy up slightly without sounding like an exaggerated commercial; natural emphasis on the main benefit.

**Serious subject** — energy down slightly; calm, respectful, thoughtful delivery; more space around the most important statements; never melodramatic.

**Motivational** — gradually increasing conviction and energy; warmth and confidence on the central message; grounded and believable, not theatrical.

**Casual presenter** — confident Ethiopian presenter talking directly to one person; friendly, relaxed, spontaneous; never sounding like reading from a script.

## Give Gemini meaning, not just text

For important or ambiguous lines, include context. Example:

```text
CONTEXT:
The speaker is calmly correcting a common misunderstanding. They are not angry.

PERFORMANCE:
Sound certain and clear. Emphasize the correction, but remain friendly.
```

## Emphasis instructions

Prefer semantic instructions over punctuation. Good: "Emphasize the contrast between the first option and the second option." Good: "The final sentence is the key takeaway — build naturally toward it and give it slightly greater emphasis." Avoid forcing emphasis through repeated punctuation or unusual capitalization.

## Numbers, names, acronyms, and technical terms

Review carefully before final generation: names, company names, product names, English words, acronyms, dates, percentages, currency, large numbers, technical terms. If Gemini repeatedly mispronounces something, isolate that line and test alternate natural spellings or pronunciation guidance rather than altering the rest of the sentence.

## Generate multiple takes for important lines

```text
TAKE A: Natural / neutral
TAKE B: Slightly warmer
TAKE C: Slightly stronger emphasis
```

Choose the take with the best native pronunciation, sentence melody, emotional interpretation, emphasis, timing, consistency, and lack of foreign accent. Then send that finished audio to fal.ai for lip syncing.

## Keep voice identity consistent

Across all chunks, keep stable: the Gemini voice, the Ethiopian Amharic accent, speaker personality, general pace, pronunciation style, vocal energy range. Only vary: scene emotion, local emphasis, short pauses, energy, pace for specific information. This is what makes separate chunks sound like one continuous speaker.

## fal.ai lip-sync preparation

1. Use the final approved TTS take.
2. Prefer clean WAV or high-quality lossless audio when supported.
3. Remove unnecessary silence at the beginning and end.
4. Keep speech free of background music during lip-sync generation.
5. Do not time-stretch the audio after lip syncing unless necessary.
6. Match one logical narration chunk to one video shot when practical.
7. If a line lip-syncs poorly, try a shorter video/audio chunk before changing the Amharic wording.
8. Keep speech pacing natural; unnaturally fast speech makes mouth sync less convincing.

Add music, ambience, and sound effects during the final edit rather than baking them into the voice track used for lip syncing.

## Final quality checklist

Before accepting a generated line, check: does it sound Ethiopian? Is the pronunciation native? Is the sentence melody natural? Are the correct words emphasized? Does it sound like spoken Amharic rather than translated prose? Are pauses based on meaning? Is the pace comfortable? Does it avoid a foreign accent? Does it avoid exaggerated acting? Does it match the previous chunks? Is the audio clean enough for fal.ai lip syncing?

If any answer is no, regenerate only that chunk rather than the entire narration.
