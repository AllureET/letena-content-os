// External service adapters. Interface + mock + production skeleton for each.
// The rest of the application never sees a vendor response shape.
// Production stack (what Letena actually uses):
//   CREATOMATE  template video render     HEYGEN      presenter avatar
//   KLING       generative b-roll video   ELEVENLABS  Amharic-capable TTS
//   GEMINI      image generation          CANVA       carousels + statics
//   TELEGRAM/META/YOUTUBE/TIKTOK          publishing
import { mkdirSync, writeFileSync } from 'node:fs';
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
};

// ---------- render: Creatomate ----------
export const creatomate = {
  async submit({ templateExternalId, modifications, renderId }) {
    if (MOCK()) {
      // Deterministic mock: immediately "renders" an mp4 placeholder.
      const key = `renders/${renderId}/output.mp4`;
      await storage.put(key, Buffer.from(`MOCK-MP4 ${renderId} ${JSON.stringify(modifications).slice(0, 500)}`));
      return { external_render_id: `mock-crea-${renderId.slice(0, 8)}`, status: 'SUCCEEDED',
        storage_key: key, duration_s: 30, cost_usd: 0 };
    }
    const res = await fetch('https://api.creatomate.com/v1/renders', {
      method: 'POST',
      headers: { Authorization: `Bearer ${need('CREATOMATE_API_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ template_id: templateExternalId, modifications }),
    });
    if (!res.ok) throw new Error(`creatomate ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const [r] = await res.json();
    return { external_render_id: r.id, status: 'SUBMITTED', storage_key: null, cost_usd: null };
  },
  async poll(externalId) {
    if (MOCK()) return { status: 'SUCCEEDED' };
    const res = await fetch(`https://api.creatomate.com/v1/renders/${externalId}`, {
      headers: { Authorization: `Bearer ${need('CREATOMATE_API_KEY')}` } });
    const r = await res.json();
    return { status: { succeeded: 'SUCCEEDED', failed: 'FAILED' }[r.status] ?? 'PROCESSING', url: r.url };
  },
};

// ---------- render: HeyGen presenter ----------
export const heygen = {
  async submit({ avatarId, audioUrl, script, renderId }) {
    if (MOCK()) {
      const key = `renders/${renderId}/presenter.mp4`;
      await storage.put(key, Buffer.from(`MOCK-HEYGEN ${renderId}`));
      return { external_render_id: `mock-hey-${renderId.slice(0, 8)}`, status: 'SUCCEEDED',
        storage_key: key, cost_usd: 0 };
    }
    const res = await fetch('https://api.heygen.com/v2/video/generate', {
      method: 'POST',
      headers: { 'X-Api-Key': need('HEYGEN_API_KEY'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_inputs: [{ character: { type: 'avatar', avatar_id: avatarId ?? need('HEYGEN_AVATAR_ID') },
          voice: audioUrl ? { type: 'audio', audio_url: audioUrl } : { type: 'text', input_text: script } }],
        dimension: { width: 1080, height: 1920 } }),
    });
    if (!res.ok) throw new Error(`heygen ${res.status}`);
    const d = await res.json();
    return { external_render_id: d.data.video_id, status: 'SUBMITTED' };
  },
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
  async generateImage({ prompt, assetId }) {
    if (MOCK()) {
      const key = `assets/generated/${assetId}/image.png`;
      await storage.put(key, Buffer.from(`MOCK-GEMINI-PNG ${prompt.slice(0, 120)}`));
      return { status: 'SUCCEEDED', storage_key: key, cost_usd: 0 };
    }
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${need('GEMINI_API_KEY')}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (!res.ok) throw new Error(`gemini ${res.status}`);
    const d = await res.json();
    const b64 = d.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData?.data;
    if (!b64) throw new Error('gemini returned no image');
    const key = `assets/generated/${assetId}/image.png`;
    await storage.put(key, Buffer.from(b64, 'base64'));
    return { status: 'SUCCEEDED', storage_key: key };
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
