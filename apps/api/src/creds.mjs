// Runtime provider credentials: DB-backed with environment fallback.
// The operator enters API keys on the Settings screen (like the EMR's
// integration credentials page) instead of editing .env on the server.
// Values live in lcos.settings under keys prefixed 'cred.' with
// is_secret = true, so the plain /platform/settings listing never returns
// them. Reads go through cred(): DB value first, process.env fallback, so
// a fresh install with only .env keeps working and a saved value wins
// without a restart. Secrets are never sent back to the browser; the UI
// only ever sees set / from-env / not-set.
import { q } from './core.mjs';

export const CRED_REGISTRY = [
  { key: 'LCOS_AI_PROVIDER', label: 'AI provider', group: 'AI generation', secret: false,
    hint: 'MOCK or ANTHROPIC. MOCK runs the whole pipeline with fake outputs at zero cost. OpenAI support was removed 14 Aug 2026, the org has no OpenAI key.' },
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', group: 'AI generation', secret: true,
    hint: 'Used when the AI provider is ANTHROPIC.' },
  { key: 'ANTHROPIC_MODEL', label: 'Anthropic model', group: 'AI generation', secret: false,
    hint: 'Leave blank for the default.' },
  { key: 'LCOS_ADAPTER_MODE', label: 'Production adapters mode', group: 'Production services', secret: false,
    hint: 'MOCK or PRODUCTION. PRODUCTION calls the real render, voice and image services below.' },
  { key: 'CREATOMATE_API_KEY', label: 'Creatomate API key', group: 'Production services', secret: true,
    hint: 'Template video rendering.' },
  { key: 'HEYGEN_API_KEY', label: 'HeyGen API key', group: 'Production services', secret: true,
    hint: 'Presenter avatar video. Requires consent on file for any real presenter likeness.' },
  { key: 'HEYGEN_AVATAR_ID', label: 'HeyGen avatar id', group: 'Production services', secret: false,
    hint: 'Default avatar used when a scene does not name one.' },
  { key: 'ELEVENLABS_API_KEY', label: 'ElevenLabs API key', group: 'Production services', secret: true,
    hint: 'Voice generation. AI voice ships on tiers 1 and 2 only.' },
  { key: 'ELEVENLABS_VOICE_ID', label: 'ElevenLabs voice id', group: 'Production services', secret: false,
    hint: 'Default voice used when a script does not name one.' },
  { key: 'LCOS_TTS_PROVIDER', label: 'TTS routing', group: 'Production services', secret: false,
    hint: 'AZURE or ELEVENLABS. Blank routes Amharic to Azure and English to ElevenLabs.' },
  { key: 'AZURE_SPEECH_KEY', label: 'Azure Speech key', group: 'Production services', secret: true,
    hint: 'Microsoft Azure Speech for Amharic voice (am-ET voices).' },
  { key: 'AZURE_SPEECH_REGION', label: 'Azure Speech region', group: 'Production services', secret: false,
    hint: 'For example westeurope or eastus.' },
  { key: 'KLING_ACCESS_KEY', label: 'Kling access key', group: 'Production services', secret: true,
    hint: 'Generative b-roll. Never anatomy.' },
  { key: 'KLING_SECRET_KEY', label: 'Kling secret key', group: 'Production services', secret: true,
    hint: 'Pairs with the access key.' },
  { key: 'GEMINI_API_KEY', label: 'Gemini API key', group: 'Production services', secret: true,
    hint: 'Image generation.' },
  { key: 'CANVA_ACCESS_TOKEN', label: 'Canva access token', group: 'Production services', secret: true,
    hint: 'Carousels and statics.' },
  { key: 'SUNO_API_KEY', label: 'Suno API key', group: 'Production services', secret: true,
    hint: 'Music and score generation for Video Studio projects.' },
  { key: 'TELEGRAM_BOT_TOKEN', label: 'Telegram bot token', group: 'Publishing', secret: true,
    hint: 'Publishes approved videos to the channel.' },
  { key: 'TELEGRAM_CHANNEL', label: 'Telegram channel', group: 'Publishing', secret: false,
    hint: 'Channel handle, for example @letena_ethiopia.' },
  { key: 'META_PAGE_TOKEN', label: 'Meta Page token', group: 'Publishing', secret: true,
    hint: 'Facebook publishing. Gated on Meta App Review.' },
  { key: 'META_IG_TOKEN', label: 'Meta Instagram token', group: 'Publishing', secret: true,
    hint: 'Instagram publishing. Gated on Meta App Review.' },
  { key: 'YOUTUBE_OAUTH', label: 'YouTube OAuth', group: 'Publishing', secret: true,
    hint: 'YouTube uploads.' },
  { key: 'TIKTOK_ACCESS_TOKEN', label: 'TikTok access token', group: 'Publishing', secret: true,
    hint: 'TikTok Content Posting API. Until set, TikTok content lands in the queue for manual upload.' },
  { key: 'TIKTOK_OPEN_ID', label: 'TikTok open id', group: 'Publishing', secret: false,
    hint: 'The account open_id the access token belongs to.' },
];

const cache = new Map();

export async function loadCreds() {
  const r = await q(`SELECT key, value FROM lcos.settings WHERE key LIKE 'cred.%'`);
  cache.clear();
  for (const row of r.rows) {
    const v = typeof row.value === 'string' ? row.value : String(row.value ?? '');
    if (v) cache.set(row.key.slice(5), v);
  }
}

export function cred(name) {
  return cache.get(name) ?? process.env[name] ?? null;
}

export function credStatus(name) {
  if (cache.has(name)) return 'saved';
  if (process.env[name]) return 'env';
  return 'unset';
}

export async function setCred(name, value, userId = null) {
  const reg = CRED_REGISTRY.find((r) => r.key === name);
  if (!reg) {
    const e = new Error(`unknown credential key: ${name}`);
    e.statusCode = 422;
    throw e;
  }
  if (value) {
    await q(
      `INSERT INTO lcos.settings (key, value, description, is_secret, updated_by)
       VALUES ($1, to_jsonb($2::text), $3, true, $4)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [`cred.${name}`, value, reg.label, userId]);
  } else {
    await q(`DELETE FROM lcos.settings WHERE key = $1`, [`cred.${name}`]);
  }
  await loadCreds();
}
