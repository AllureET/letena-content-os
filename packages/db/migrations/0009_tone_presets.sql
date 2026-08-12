-- 0009: tone/voice presets for AI-generated copy.
--
-- Owner ask (Nate, 12 Aug 2026): "I should have options if I want to change
-- the tone and voice." This table holds named, structured tone/voice
-- presets that get injected into AI prompt assembly (apps/api/src/ai/
-- gateway.mjs). content.tone_preset (below) selects the default globally;
-- callers of invokeAgent() can override it per generation request.
--
-- The hard house-style bans (no em dashes, no hedging, no AI sign-offs, no
-- rhetorical antithesis/tricolon, etc.) are DELIBERATELY NOT stored here.
-- They live as a constant (HOUSE_STYLE_RULES) in gateway.mjs and are sent on
-- every agent call regardless of preset, so a tone change can never
-- accidentally turn off a house rule.
SET search_path = lcos, public;

CREATE TABLE IF NOT EXISTS tone_presets (
  key                 text        PRIMARY KEY,
  label               text        NOT NULL,
  description         text        NOT NULL,
  prompt_instructions text        NOT NULL,
  is_active           boolean     NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE tone_presets IS
  'Named tone/voice presets injected into AI prompt assembly. Selected '
  'globally by the content.tone_preset setting, overridable per generation '
  'request via invokeAgent(..., { tone_preset }). House style bans are '
  'separate (gateway.mjs HOUSE_STYLE_RULES) and always apply regardless.';

INSERT INTO tone_presets (key, label, description, prompt_instructions) VALUES
  ('LETENA_DEFAULT', 'Letena default',
   'Warm, culturally sensitive, compassionate, direct. The house voice for a '
   'digital-first SRH org serving young Ethiopians on sensitive topics.',
   'Write in Letena''s voice: warm, culturally sensitive, compassionate, and direct. '
   'The reader is a young Ethiopian, often anxious or ashamed, asking a private question '
   'about their body or sex life. Speak to them like a caring, non-judgmental clinician who '
   'respects their privacy and intelligence. Be direct about the medical facts; never '
   'clinical-cold, never preachy. Never shame, lecture, or moralize. Warmth shows in word '
   'choice and pacing, not in extra words.'),
  ('CLINICAL_DIRECT', 'Clinical, direct',
   'More clipped and factual, less warmth. For contexts where brevity matters '
   '(captions, quick-reference cards, high-volume feeds).',
   'Write clipped and factual, prioritizing brevity over warmth. State the medical fact, '
   'the one action, and stop. Keep sentences short. Skip reassurance framing and emotional '
   'scene-setting; trust the reader to want the answer, not comfort. Stay respectful and '
   'never cold or dismissive, but every sentence should earn its place.'),
  ('FRIENDLY_CASUAL', 'Friendly, casual',
   'Lighter, more conversational. For younger-skewing social captions and '
   'chat-style formats.',
   'Write light and conversational, like a knowledgeable older sibling texting back, not a '
   'clinic pamphlet. Short sentences, everyday words, a little warmth and personality. Stay '
   'medically precise and never flippant about the facts, but keep the register relaxed, '
   'not formal.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value, description, is_secret) VALUES
  ('content.tone_preset', to_jsonb('LETENA_DEFAULT'::text),
   'Tone preset key (lcos.tone_presets) applied to AI-generated copy by default. '
   'Overridable per generation request.', false)
ON CONFLICT (key) DO NOTHING;

-- Record what tone shipped and what the mechanical style lint found on the
-- script version that carries the generated English copy.
ALTER TABLE script_versions
  ADD COLUMN IF NOT EXISTS tone_preset    text,
  ADD COLUMN IF NOT EXISTS style_warnings jsonb NOT NULL DEFAULT '[]'::jsonb;
COMMENT ON COLUMN script_versions.tone_preset IS
  'Tone preset key resolved when this version was generated (request override or '
  'the content.tone_preset setting at the time).';
COMMENT ON COLUMN script_versions.style_warnings IS
  'Mechanical house-style lint findings from apps/api/src/ai/style_lint.mjs (em '
  'dash character, hedge phrases, AI sign-off phrases). Not exhaustive: antithesis '
  'and tricolon are not reliably machine-detectable in free text and are left to '
  'human review, not checked here.';
