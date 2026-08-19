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

// The video engine slot. Everything that generates video asks this, so the
// vendor is one configuration read, never a hard-wired import.
export function videoEngine(name) {
  return String(name ?? '').toUpperCase() === 'VEO' ? veo : kling;
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
      body: JSON.stringify({ contents: [{ parts }] }),
    });
    if (!res.ok) throw new Error(`gemini ${res.status}`);
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
