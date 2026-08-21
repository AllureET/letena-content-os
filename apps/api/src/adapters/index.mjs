// External service adapters. Interface + mock + production skeleton for each.
// The rest of the application never sees a vendor response shape.
// Production stack (what Letena actually uses, 19 Aug 2026 -- HeyGen and
// Creatomate are retired, no templated-render engine and no presenter-avatar
// engine remain):
//   KLING/VEO   generative, continuity-locked video (Video Studio)
//   ELEVENLABS/AZURE  TTS, Amharic-capable                  GEMINI  images
//   CANVA       carousels + statics
//   TELEGRAM/META/YOUTUBE/TIKTOK                     publishing
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { cred } from '../creds.mjs';

const MOCK = () => (cred('LCOS_ADAPTER_MODE') || 'MOCK').toUpperCase() === 'MOCK';
const STORE = process.env.LCOS_STORAGE_DIR || '/tmp/lcos-storage';

// ---------- storage ----------
export const storage = {
  async put(key, buf) {
    if (process.env.R2_ACCESS_KEY_ID && !MOCK()) {
      throw new Error('R2 adapter: wire @aws-sdk/client-s3 with R2 endpoint (skeleton)');
    }
    const path = join(STORE, key);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, buf);
    return { storage_key: key, local_path: path };
  },
  url(key) { return `file://${join(STORE, key)}`; },
  // Local filesystem path for a storage key (Video Studio phase 1, 18 Aug
  // 2026): ffprobe/ffmpeg need a real path, not a file:// URL string, and
  // no other module had reason to reconstruct one before now.
  localPath(key) { return join(STORE, key); },
};

// ---------- generative b-roll: Kling ----------
export const kling = {
  // Never used for anatomy or medical illustration; the production router
  // blocks MEDICAL_ILLUSTRATION from ever reaching a generative adapter.
  async textToVideo({ prompt, negativePrompt, assetId }) {
    if (MOCK()) {
      const key = `assets/generated/${assetId}/broll.mp4`;
      await storage.put(key, Buffer.from(`MOCK-KLING ${prompt.slice(0, 120)}`));
      return { status: 'SUCCEEDED', storage_key: key, provider_job_id: `mock-kling-${assetId.slice(0, 8)}`, cost_usd: 0 };
    }
    // Kling API access key/secret JWT auth; see Kling docs. Skeleton:
    throw new Error('Kling production adapter requires KLING_ACCESS_KEY/KLING_SECRET_KEY (skeleton)');
  },
  // Character-consistency path: a Gemini-generated (producer-approved)
  // reference image drives image-to-video, so Mimi/Sara/Miki look the same
  // across every piece. referenceImageKey is a storage key of an ACTIVE asset.
  async imageToVideo({ prompt, negativePrompt, referenceImageKey, assetId }) {
    if (MOCK()) {
      const key = `assets/generated/${assetId}/character-broll.mp4`;
      await storage.put(key, Buffer.from(`MOCK-KLING-I2V ref=${referenceImageKey} ${prompt.slice(0, 100)}`));
      return { status: 'SUCCEEDED', storage_key: key, provider_job_id: `mock-kling-i2v-${assetId.slice(0, 8)}`, cost_usd: 0 };
    }
    throw new Error('Kling image_to_video production adapter requires KLING_ACCESS_KEY/KLING_SECRET_KEY (skeleton)');
  },
};

// ---------- generative video: Google Veo (same Gemini key) ----------
// Part 2, 14 Aug 2026: the owner's Foundations drama companion specifies
// Veo through AI Studio, and Veo rides the SAME Gemini key Letena is
// already getting, so the system has two candidate video engines and no
// reason to hard-wire either. Identical interface to kling, deliberately:
// the engine is a slot (videoEngine() below), and swapping is the
// production.video_engine setting or a per-format/per-piece override,
// never a code change. The first real test once keys exist (one clip
// through each engine, first-plus-last-frame conditioning and lip-sync on
// Amharic audio) decides the default per format; until then neither engine
// is presented as better.
export const veo = {
  async textToVideo({ prompt, negativePrompt, assetId }) {
    if (MOCK()) {
      const key = `assets/generated/${assetId}/broll-veo.mp4`;
      await storage.put(key, Buffer.from(`MOCK-VEO ${prompt.slice(0, 120)}`));
      return { status: 'SUCCEEDED', storage_key: key, provider_job_id: `mock-veo-${assetId.slice(0, 8)}`, cost_usd: 0 };
    }
    // Veo via the Gemini API: models/veo-*:predictLongRunning, then poll the
    // operation. Skeleton until the first real engine test runs.
    throw new Error('Veo production adapter requires GEMINI_API_KEY and the engine test (skeleton)');
  },
  async imageToVideo({ prompt, negativePrompt, referenceImageKey, assetId }) {
    if (MOCK()) {
      const key = `assets/generated/${assetId}/character-broll-veo.mp4`;
      await storage.put(key, Buffer.from(`MOCK-VEO-I2V ref=${referenceImageKey} ${prompt.slice(0, 100)}`));
      return { status: 'SUCCEEDED', storage_key: key, provider_job_id: `mock-veo-i2v-${assetId.slice(0, 8)}`, cost_usd: 0 };
    }
    throw new Error('Veo image_to_video production adapter requires GEMINI_API_KEY and the engine test (skeleton)');
  },
};

// ---------- generative video: Runway (the one REAL implementation) ----------
// Built 21 Aug 2026 on the owner's direction ("I don't want this running
// through veo. I think runway is cheaper is it not?"). It is, substantially:
//
//   Runway Gen-4 Turbo   ~$0.05/s   (5 credits/s at $0.01/credit)
//   Runway Gen-4.5       ~$0.12/s   (12 credits/s)
//   Veo 3.1 Fast         ~$0.15/s
//   Kling (our estimate) ~$0.35/s
//   Veo 3.1              ~$0.40/s
//
// Beyond price, Runway's single developer API also fronts Veo, Kling and
// Seedance, so this one adapter removes the need to ever finish the two
// skeletons above. Unlike kling/veo, everything below is a real HTTP
// implementation, not a throw.
//
// Auth is a single bearer key from dev.runwayml.com (NOT the same thing as
// a Runway app subscription, and not the same as any MCP connection):
// RUNWAY_API_KEY in the admin settings page. The X-Runway-Version header is
// required on every call.
const RUNWAY_BASE = 'https://api.dev.runwayml.com/v1';
const RUNWAY_VERSION = '2024-11-06';
const RUNWAY_DEFAULT_I2V_MODEL = 'gen4_turbo';   // cheapest real path: animate a composed first frame
const RUNWAY_DEFAULT_T2V_MODEL = 'gen4.5';       // gen4_turbo has no text-only mode

// Runway bills in whole supported durations, not arbitrary seconds.
function runwayDuration(seconds) {
  const n = Number(seconds) || 5;
  return n > 7 ? 10 : 5;
}
// Runway wants an explicit pixel ratio string, not "9:16".
function runwayRatio(aspect, model) {
  const a = String(aspect ?? '9:16');
  if (model === 'gen4_turbo') return a === '16:9' ? '1280:720' : a === '1:1' ? '960:960' : '720:1280';
  return a === '16:9' ? '1280:720' : a === '1:1' ? '960:960' : '720:1280';
}

// Runway's promptText, and the negative prompt that must NOT go into it.
//
// 21 Aug 2026, three straight failures with INTERNAL.BAD_OUTPUT.CODE01.
// Runway has no negative-prompt field, so this adapter originally folded
// the studio's negative list in as "Avoid: identity mutation, duplicate
// subjects, extra limbs, fused hands, unintended text, subtitles, logo,
// watermark, ... no written text of any kind in the image". That is
// exactly backwards for this model: promptText is a POSITIVE description,
// and naming "logo", "watermark", "subtitles", "text", "extra limbs" in it
// asks the model to put those things in the picture. Runway's own docs
// list "logos, watermarks, or overlaid text" and "prompts requesting
// explicit text generation" as the most common causes of
// INTERNAL.BAD_OUTPUT.01, which is the code we got.
//
// So the negative prompt is deliberately DROPPED on this engine rather
// than translated. It stays in the adapter interface because the kling and
// veo skeletons take a real negative field, and because dropping it in the
// caller would hide the decision from anyone reading the Runway path.
// Steering away from artifacts on Runway belongs in positive phrasing in
// the motion prompt.
//
// The length cap is Runway's documented 1000-character promptText limit.
// Nothing the studio compiles today comes close, but a long temporal-beats
// list plus a performance note could, and losing a whole generation to a
// 400 for the sake of a slice is a bad trade.
const RUNWAY_PROMPT_MAX = 1000;
function runwayPromptText(prompt) {
  return String(prompt ?? '').slice(0, RUNWAY_PROMPT_MAX);
}

async function runwayPoll(taskId, key) {
  // Runway generations take tens of seconds to a few minutes. Poll with a
  // hard ceiling so a stuck job surfaces as a clear error instead of
  // hanging the caller's request forever.
  const deadline = Date.now() + 10 * 60 * 1000;
  let delayMs = 5000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, delayMs));
    delayMs = Math.min(delayMs * 1.3, 20000);
    const res = await fetch(`${RUNWAY_BASE}/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${key}`, 'X-Runway-Version': RUNWAY_VERSION },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`runway task poll ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
    }
    const task = await res.json();
    if (task.status === 'SUCCEEDED') {
      const url = Array.isArray(task.output) ? task.output[0] : task.output;
      if (!url) throw new Error('runway reported SUCCEEDED but returned no output url');
      return url;
    }
    if (task.status === 'FAILED' || task.status === 'CANCELLED') {
      // Surface Runway's own failure text (content moderation, bad input,
      // and so on) rather than a bare status, so runGenerationLadder's
      // classifier upstream can see words like "moderation" and treat a
      // policy rejection as POLICY instead of blindly retrying.
      //
      // 21 Aug 2026: carry the failureCode AND the task id, not just the
      // prose. Runway's generic "An unexpected error occurred" says nothing
      // on its own, and without the task id there is no way to look the run
      // up in Runway's own dashboard afterwards. The one real instance of
      // this so far turned out to be an input frame smaller than the
      // requested output resolution, which nothing in the message hinted at.
      const why = [task.failure, task.failureCode].filter(Boolean).join(' / ') || 'no reason given';
      throw new Error(`runway ${task.status} (task ${taskId}): ${why}`);
    }
  }
  throw new Error('runway generation timed out after 10 minutes');
}

async function runwayStore(url, key, assetId, suffix) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`runway output download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const storageKey = `assets/generated/${assetId}/${suffix}.mp4`;
  await storage.put(storageKey, buf);
  return storageKey;
}

export const runway = {
  // Animate an existing still (the composed first frame) -- the path Video
  // Studio actually uses, and the cheap one. The image is sent as a base64
  // data URI so nothing has to be publicly reachable first.
  async imageToVideo({ prompt, negativePrompt, referenceImageKey, assetId, durationS, aspectRatio, model }) {
    if (MOCK()) {
      const key = `assets/generated/${assetId}/character-broll-runway.mp4`;
      await storage.put(key, Buffer.from(`MOCK-RUNWAY-I2V ref=${referenceImageKey} ${String(prompt).slice(0, 100)}`));
      return { status: 'SUCCEEDED', storage_key: key, provider_job_id: `mock-runway-i2v-${assetId.slice(0, 8)}`, cost_usd: 0 };
    }
    const key = need('RUNWAY_API_KEY');
    // Precedence: an explicit per-shot model, else the RUNWAY_MODEL
    // setting, else the cheap default. Same order as every other adapter
    // here reads its own settings.
    const useModel = model || cred('RUNWAY_MODEL') || RUNWAY_DEFAULT_I2V_MODEL;
    const imgB64 = readFileSync(storage.localPath(referenceImageKey)).toString('base64');
    const duration = runwayDuration(durationS);
    const body = {
      model: useModel,
      promptImage: `data:image/png;base64,${imgB64}`,
      promptText: runwayPromptText(prompt),
      ratio: runwayRatio(aspectRatio, useModel),
      duration,
    };
    const res = await fetch(`${RUNWAY_BASE}/image_to_video`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'X-Runway-Version': RUNWAY_VERSION, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`runway image_to_video ${res.status}${errBody ? `: ${errBody.slice(0, 400)}` : ''}`);
    }
    const { id } = await res.json();
    const outUrl = await runwayPoll(id, key);
    const storageKey = await runwayStore(outUrl, key, assetId, 'character-broll-runway');
    // Real per-second rates, so spent_usd stops being an estimate the day
    // this adapter goes live (resolveSpendAmount prefers a real cost_usd).
    const perS = useModel === 'gen4_turbo' ? 0.05 : 0.12;
    return { status: 'SUCCEEDED', storage_key: storageKey, provider_job_id: id, cost_usd: Number((perS * duration).toFixed(4)) };
  },

  async textToVideo({ prompt, negativePrompt, assetId, durationS, aspectRatio, model }) {
    if (MOCK()) {
      const key = `assets/generated/${assetId}/broll-runway.mp4`;
      await storage.put(key, Buffer.from(`MOCK-RUNWAY ${String(prompt).slice(0, 120)}`));
      return { status: 'SUCCEEDED', storage_key: key, provider_job_id: `mock-runway-${assetId.slice(0, 8)}`, cost_usd: 0 };
    }
    const key = need('RUNWAY_API_KEY');
    // gen4_turbo has no text-only mode, so a RUNWAY_MODEL of gen4_turbo is
    // deliberately ignored on this path rather than sent and rejected.
    const configured = cred('RUNWAY_MODEL');
    const useModel = model || (configured && configured !== 'gen4_turbo' ? configured : RUNWAY_DEFAULT_T2V_MODEL);
    const duration = runwayDuration(durationS);
    const res = await fetch(`${RUNWAY_BASE}/text_to_video`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'X-Runway-Version': RUNWAY_VERSION, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: useModel,
        promptText: runwayPromptText(prompt),
        ratio: runwayRatio(aspectRatio, useModel),
        duration,
      }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`runway text_to_video ${res.status}${errBody ? `: ${errBody.slice(0, 400)}` : ''}`);
    }
    const { id } = await res.json();
    const outUrl = await runwayPoll(id, key);
    const storageKey = await runwayStore(outUrl, key, assetId, 'broll-runway');
    return { status: 'SUCCEEDED', storage_key: storageKey, provider_job_id: id, cost_usd: Number((0.12 * duration).toFixed(4)) };
  },
};

// The video engine slot. Everything that generates video asks this, so the
// vendor is one configuration read, never a hard-wired import. RUNWAY is
// the default (21 Aug 2026): it is the only one of the three with a real
// implementation, and the cheapest. An explicit 'KLING'/'VEO' still
// resolves to those skeletons so the setting keeps its meaning, but they
// throw in production mode until someone implements them.
export function videoEngine(name) {
  const n = String(name ?? '').toUpperCase();
  if (n === 'VEO') return veo;
  if (n === 'KLING') return kling;
  return runway;
}

// ---------- voice: Azure Speech (PRIMARY for Amharic) ----------
// Azure has real Amharic neural voices: am-ET-MekdesNeural (female),
// am-ET-AmehaNeural (male). Tier rules still apply (settings
// voice.ai_allowed_tiers) and the language-approval gate runs upstream.
export const azureSpeech = {
  async tts({ text, language = 'am-ET', voice, assetId }) {
    if (MOCK()) {
      const key = `voice/generated/${assetId}.mp3`;
      await storage.put(key, Buffer.from(`MOCK-AZURE-TTS ${language} ${text.slice(0, 120)}`));
      return { status: 'SUCCEEDED', storage_key: key, cost_usd: 0, provider: 'AZURE' };
    }
    const k = need('AZURE_SPEECH_KEY'); const region = need('AZURE_SPEECH_REGION');
    const v = voice ?? (language.startsWith('am') ? 'am-ET-MekdesNeural' : 'en-US-JennyNeural');
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const ssml = `<speak version='1.0' xml:lang='${language}'><voice name='${v}'>${esc(text)}</voice></speak>`;
    const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': k, 'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3' },
      body: ssml,
    });
    if (!res.ok) throw new Error(`azure speech ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const key = `voice/generated/${assetId}.mp3`;
    await storage.put(key, Buffer.from(await res.arrayBuffer()));
    return { status: 'SUCCEEDED', storage_key: key, provider: 'AZURE' };
  },
};

// Voice preview TTS: hear a script's prepared spoken text without running a
// production job. Mock mode (or a missing Azure key) writes a placeholder mp3
// via the storage adapter; PRODUCTION with AZURE_SPEECH_KEY set calls the real
// Azure am-ET voices.
export async function previewTts({ text, voice = 'am-ET-MekdesNeural', previewId }) {
  if (MOCK() || !cred('AZURE_SPEECH_KEY')) {
    const key = `voice/previews/${previewId}.mp3`;
    await storage.put(key, Buffer.from(`MOCK-VOICE-PREVIEW ${voice} ${text.slice(0, 160)}`));
    return { status: 'SUCCEEDED', storage_key: key, cost_usd: 0, provider: 'MOCK' };
  }
  return azureSpeech.tts({ text, language: 'am-ET', voice, assetId: `previews/${previewId}` });
}

// Provider-agnostic TTS entry point. Amharic routes to Azure by default
// (LCOS_TTS_PROVIDER overrides); English routes to ElevenLabs when a key
// exists, else Azure.
export async function tts({ text, language = 'AM', assetId }) {
  const pref = (cred('LCOS_TTS_PROVIDER') || (language === 'AM' ? 'AZURE' : 'ELEVENLABS')).toUpperCase();
  if (pref === 'AZURE') {
    return azureSpeech.tts({ text, language: language === 'AM' ? 'am-ET' : 'en-US', assetId });
  }
  return elevenlabs.tts({ text, assetId });
}

// ---------- voice: ElevenLabs (English + fallback) ----------
export const elevenlabs = {
  // AI Amharic voice is permitted for tiers 1-2 only (settings voice.ai_allowed_tiers),
  // and only after the blind listening test. Human-recorded voice otherwise.
  async tts({ text, voiceId, assetId }) {
    if (MOCK()) {
      const key = `voice/generated/${assetId}.mp3`;
      await storage.put(key, Buffer.from(`MOCK-11LABS ${text.slice(0, 120)}`));
      return { status: 'SUCCEEDED', storage_key: key, cost_usd: 0 };
    }
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId ?? need('ELEVENLABS_VOICE_ID')}`, {
      method: 'POST',
      headers: { 'xi-api-key': need('ELEVENLABS_API_KEY'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
    });
    if (!res.ok) throw new Error(`elevenlabs ${res.status}`);
    const key = `voice/generated/${assetId}.mp3`;
    await storage.put(key, Buffer.from(await res.arrayBuffer()));
    return { status: 'SUCCEEDED', storage_key: key };
  },
};

// ---------- images: Gemini ----------
export const gemini = {
  // referenceImageKeys (Video Studio character+environment composition,
  // 19 Aug 2026): an optional array of 0-2 existing storage keys to hand
  // to Gemini alongside the text prompt, so it composes FROM those images
  // (e.g. "put this locked character into this locked background")
  // instead of generating from text alone. Purely additive -- every
  // existing caller (lock reference generation) omits referenceImageKeys
  // and gets byte-for-byte the same text-to-image call as before. Per
  // Gemini's actual multi-image API shape, each reference is sent as an
  // inlineData part BEFORE the text part.
  async generateImage({ prompt, assetId, referenceImageKeys }) {
    const refCount = referenceImageKeys?.length ?? 0;
    if (MOCK()) {
      const key = `assets/generated/${assetId}/image.png`;
      await storage.put(key, Buffer.from(`MOCK-GEMINI-PNG refs=${refCount} ${prompt.slice(0, 100)}`));
      return { status: 'SUCCEEDED', storage_key: key, cost_usd: 0 };
    }
    const imageParts = (referenceImageKeys ?? []).map((k) =>
      ({ inlineData: { mimeType: 'image/png', data: readFileSync(storage.localPath(k)).toString('base64') } }));
    const parts = [...imageParts, { text: prompt }];
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${need('GEMINI_API_KEY')}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // responseModalities (21 Aug 2026 fix): without this, a request that
      // hands the model one or more existing images alongside the prompt
      // (composition, remix) came back 400 in production -- confirmed live
      // against the real API, not a guess. A pure text->image call (zero
      // reference images) happened to work without it, which is why this
      // was missed until compose-first-frame exercised the multi-image
      // path for the first time. Both TEXT and IMAGE are requested because
      // Gemini's image models normally return a short caption alongside
      // the image; asking for IMAGE alone is rejected by some API versions.
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`gemini ${res.status}${body ? `: ${body.slice(0, 500)}` : ''}`);
    }
    const d = await res.json();
    const b64 = d.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData?.data;
    if (!b64) throw new Error('gemini returned no image');
    const key = `assets/generated/${assetId}/image.png`;
    await storage.put(key, Buffer.from(b64, 'base64'));
    return { status: 'SUCCEEDED', storage_key: key };
  },
  // Amharic speech-to-text for aua_recap (Part 2, 14 Aug 2026). The result
  // is MACHINE TRANSCRIPTION OF AMHARIC, which is unreliable in every
  // engine, and it carries medical statements a doctor said out loud, so
  // the caller (transcripts module) never marks it CONFIRMED: a human
  // confirms it on screen before anything generates from it.
  async transcribeAudio({ audioBase64, mimeType = 'audio/mpeg', transcriptId }) {
    if (MOCK()) {
      return { status: 'SUCCEEDED', cost_usd: 0, segments: [
        { start_s: 0, end_s: 14, speaker: 'doctor',
          text: 'ሰላም። ዛሬ ስለ ድንገተኛ የእርግዝና መከላከያ እንነጋገራለን። Postpill ከግንኙነት በኋላ በ72 ሰዓት ውስጥ ከተወሰደ እርግዝናን መከላከል ይችላል።' },
        { start_s: 14, end_s: 26, speaker: 'doctor',
          text: 'ብዙ ጊዜ የሚነሳ ጥያቄ፦ Postpill ወደፊት መውለድን ይከለክላል ወይ? አይከለክልም።' },
      ] };
    }
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${need('GEMINI_API_KEY')}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [
        { text: 'Transcribe this Amharic recording. Return strict JSON: an array of {start_s, end_s, speaker, text}. speaker is "doctor" or "guest". Keep clinical/brand terms (Postpill, Condom, HIV, IUD) in Latin script exactly as spoken.' },
        { inlineData: { mimeType, data: audioBase64 } },
      ] }] }),
    });
    if (!res.ok) throw new Error(`gemini transcribe ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const d = await res.json();
    const text = d.candidates?.[0]?.content?.parts?.map(p => p.text).join('') ?? '[]';
    const jsonText = text.replace(/^```json?\s*/i, '').replace(/```\s*$/, '');
    let segments;
    try { segments = JSON.parse(jsonText); } catch { segments = [{ start_s: 0, end_s: null, speaker: 'doctor', text }]; }
    return { status: 'SUCCEEDED', segments, cost_usd: null };
  },
  // Break a reference SHEET into its individual pictures (21 Aug 2026,
  // owner: "why dont you take the character and location reference and just
  // break it down into the individual pieces so we can use whats needed").
  //
  // A reference sheet is a typeset document -- a grid of small pictures with
  // a title, section headings and a caption under every panel. That makes
  // the whole sheet useless as a conditioning image, because an image model
  // handed a page of print tries to reproduce print (three Runway
  // generations died on exactly that). The pictures ON it are excellent
  // references. This locates them.
  //
  // The boxes must exclude captions, which is the entire point and the one
  // thing a geometric row/column split cannot do: the caption sits inside
  // the same cell as the picture it labels, so cutting on the gutters keeps
  // the words. A vision model can see where the photograph stops and the
  // lettering starts.
  //
  // Returns normalised boxes (0-1 of width/height) so the caller can crop at
  // whatever the real pixel size turns out to be, plus a coarse `use` tag
  // and a has_text flag per panel. has_text is what decides whether a piece
  // is safe to condition on, so the model is told to be pessimistic: if it
  // is unsure whether lettering is inside the box, say true.
  async detectSheetPanels({ imageBase64, mimeType = 'image/png' }) {
    if (MOCK()) {
      return { status: 'SUCCEEDED', cost_usd: 0, panels: [
        { label: 'front view', use: 'FRONT', has_text: false, box: { x: 0.05, y: 0.10, w: 0.20, h: 0.35 } },
        { label: 'three quarter view', use: 'THREE_QUARTER', has_text: false, box: { x: 0.28, y: 0.10, w: 0.20, h: 0.35 } },
        { label: 'title block', use: 'TEXT_BLOCK', has_text: true, box: { x: 0.00, y: 0.00, w: 1.00, h: 0.06 } },
      ] };
    }
    const uses = 'FRONT, THREE_QUARTER, SIDE, BACK, EXPRESSION, POSE, COSTUME_DETAIL, SWATCH, '
      + 'LOCATION_ANGLE, LOCATION_LAYOUT, PROP, TEXT_BLOCK, OTHER';
    const parts = [
      { text: `This is a reference sheet: a page of small pictures with headings and captions. Find every individual PICTURE on it.

For each picture return a box that contains ONLY the picture. Exclude the caption or label printed under, over or beside it, and exclude any heading above it. Crop tight to the image itself; it is better to lose a few pixels of the picture than to include one letter.

Return strict JSON and nothing else:
{"panels":[{"label":"short plain description, lowercase","use":"one of: ${uses}","has_text":true or false,"box":{"x":0-1,"y":0-1,"w":0-1,"h":0-1}}]}

x and y are the top-left corner as a fraction of the full image width and height. w and h are the width and height as fractions. use is your best guess at what the picture shows. has_text is true if ANY lettering, number, caption, watermark or logo falls inside the box you returned -- if you are not sure, say true. Include colour swatches and material squares as their own panels with use SWATCH. Include blocks that are purely type, with use TEXT_BLOCK and has_text true, so the caller knows they were seen and skipped.` },
      { inlineData: { mimeType, data: imageBase64 } },
    ];
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${need('GEMINI_API_KEY')}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }] }),
    });
    if (!res.ok) throw new Error(`gemini sheet split ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const d = await res.json();
    const text = d.candidates?.[0]?.content?.parts?.map(p => p.text).join('') ?? '{}';
    const jsonText = text.replace(/^```json?\s*/i, '').replace(/```\s*$/, '');
    let parsed;
    try { parsed = JSON.parse(jsonText); } catch {
      throw new Error(`gemini sheet split returned unparseable JSON: ${text.slice(0, 300)}`);
    }
    return { status: 'SUCCEEDED', panels: Array.isArray(parsed.panels) ? parsed.panels : [], cost_usd: null };
  },

  // Video Studio automated continuity QC (playbook 19.2, phase 1, 18 Aug
  // 2026). This is the honest version of "AI checks continuity": a vision
  // model comparing one candidate frame against the locked reference
  // image(s) and returning a verdict plus its reasoning, NOT a numeric
  // identity-similarity score from a trained embedding model (LCOS has no
  // such model wired in). Treat the verdict as a second opinion a human
  // QC reviewer would still want to see, not a pass/fail oracle.
  async compareContinuity({ candidateImageBase64, referenceImageBase64s, checklist, assetId }) {
    if (MOCK()) {
      return { status: 'SUCCEEDED', verdict: 'CONSISTENT', confidence: 0.5,
        notes: 'MOCK mode: no real comparison was run.', cost_usd: 0 };
    }
    const parts = [
      { text: `Compare the CANDIDATE frame against the REFERENCE image(s) of the same locked character/environment/prop. Checklist: ${(checklist ?? []).join('; ') || 'general identity, wardrobe, and setting consistency'}. Return strict JSON: {"verdict": "CONSISTENT" or "DRIFT_DETECTED", "confidence": 0-1, "notes": "what matches or what drifted, specifically"}.` },
      { text: 'CANDIDATE:' }, { inlineData: { mimeType: 'image/png', data: candidateImageBase64 } },
      ...(referenceImageBase64s ?? []).flatMap((b64, i) => [
        { text: `REFERENCE ${i + 1}:` }, { inlineData: { mimeType: 'image/png', data: b64 } }]),
    ];
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${need('GEMINI_API_KEY')}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }] }),
    });
    if (!res.ok) throw new Error(`gemini continuity compare ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const d = await res.json();
    const text = d.candidates?.[0]?.content?.parts?.map(p => p.text).join('') ?? '{}';
    const jsonText = text.replace(/^```json?\s*/i, '').replace(/```\s*$/, '');
    let parsed;
    try { parsed = JSON.parse(jsonText); } catch { parsed = { verdict: 'DRIFT_DETECTED', confidence: 0, notes: `unparseable model response: ${text.slice(0, 300)}` }; }
    return { status: 'SUCCEEDED', ...parsed, cost_usd: null };
  },
};

// ---------- music: Suno (Video Studio phase 1, 18 Aug 2026) ----------
// Music briefs (playbook 16.2) are structured, not a one-line mood word;
// the adapter takes the same instrumentation/tempo/structure shape the
// playbook's music brief uses so the caller never has to translate.
export const suno = {
  async generateMusic({ prompt, tempoBpm, durationS, assetId }) {
    if (MOCK()) {
      const key = `assets/generated/${assetId}/music.mp3`;
      await storage.put(key, Buffer.from(`MOCK-SUNO ${prompt.slice(0, 120)}`));
      return { status: 'SUCCEEDED', storage_key: key, provider_job_id: `mock-suno-${assetId.slice(0, 8)}`, cost_usd: 0 };
    }
    const res = await fetch('https://api.sunoapi.org/api/v1/generate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${need('SUNO_API_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, instrumental: true,
        tags: tempoBpm ? `${tempoBpm} bpm` : undefined, duration_seconds: durationS }),
    });
    if (!res.ok) throw new Error(`suno ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const d = await res.json();
    return { status: 'SUBMITTED', provider_job_id: d.data?.taskId ?? d.taskId ?? null, storage_key: null };
  },
};

// ---------- design: Canva (carousels C01, statics C02) ----------
export const canva = {
  async createDesign({ title, pages, designId }) {
    if (MOCK()) {
      const key = `designs/${designId}/design.json`;
      await storage.put(key, Buffer.from(JSON.stringify({ title, pages }, null, 2)));
      return { status: 'SUCCEEDED', storage_key: key, edit_url: `mock://canva/${designId}` };
    }
    // Canva Connect API: POST /v1/designs then autofill; requires OAuth.
    throw new Error('Canva production adapter requires CANVA_ACCESS_TOKEN (skeleton)');
  },
};

// ---------- publishing ----------
function mockPublish(platform, jobId) {
  return { platform_post_id: `mock-${platform.toLowerCase()}-${jobId.slice(0, 8)}`,
    platform_url: `https://mock.local/${platform.toLowerCase()}/${jobId.slice(0, 8)}` };
}
export const publishers = {
  async TELEGRAM({ job, videoUrl }) {
    const token = cred('TELEGRAM_BOT_TOKEN');
    if (MOCK() || !token) return mockPublish('TELEGRAM', job.id);
    const chat = cred('TELEGRAM_CHANNEL') || '@letena_ethiopia';
    const res = await fetch(`https://api.telegram.org/bot${token}/sendVideo`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, video: videoUrl, caption: job.caption ?? '' }),
    });
    const d = await res.json();
    if (!d.ok) throw new Error(`telegram: ${d.description}`);
    return { platform_post_id: String(d.result.message_id),
      platform_url: `https://t.me/${chat.replace('@', '')}/${d.result.message_id}` };
  },
  async INSTAGRAM({ job }) {
    if (MOCK() || !cred('META_IG_TOKEN')) return mockPublish('INSTAGRAM', job.id);
    throw new Error('Meta IG production adapter: media container + media_publish (skeleton)');
  },
  async FACEBOOK({ job }) {
    if (MOCK() || !cred('META_PAGE_TOKEN')) return mockPublish('FACEBOOK', job.id);
    throw new Error('Meta FB production adapter (skeleton)');
  },
  async YOUTUBE({ job }) {
    if (MOCK() || !cred('YOUTUBE_OAUTH')) return mockPublish('YOUTUBE', job.id);
    throw new Error('YouTube resumable upload adapter (skeleton)');
  },
  async TIKTOK({ job }) {
    // TikTok starts as upload-for-review even in production until the
    // Content Posting API is approved; the mock mirrors the inbox-draft path.
    return mockPublish('TIKTOK', job.id);
  },
  async WEBSITE({ job }) { return mockPublish('WEBSITE', job.id); },
};

// ---------- analytics collectors ----------
export const collectors = {
  async collect(platform, platformPostId) {
    if (MOCK()) {
      // Deterministic pseudo-metrics from the post id hash; TikTok omits
      // avg_watch_time to exercise honest-null handling.
      const h = parseInt(crypto.createHash('sha1').update(platformPostId).digest('hex').slice(0, 6), 16);
      const views = 800 + (h % 40000);
      const base = { views, reach: Math.round(views * 0.8), views_3s: Math.round(views * 0.62),
        completion_rate: Math.round(((h % 35) + 30)) / 100,
        likes: Math.round(views * 0.05), comments: Math.round(views * 0.004),
        shares: Math.round(views * 0.012), saves: Math.round(views * 0.02),
        link_clicks: Math.round(views * 0.006) };
      const available = Object.keys(base);
      if (platform !== 'TIKTOK') { base.avg_watch_time_s = 12 + (h % 14); available.push('avg_watch_time_s'); }
      return { metrics: base, metrics_available: available };
    }
    throw new Error(`production collector for ${platform} not configured`);
  },
};

function need(name) {
  const v = cred(name);
  if (!v) throw new Error(`${name} is required (set LCOS_ADAPTER_MODE=MOCK for demo mode)`);
  return v;
}
