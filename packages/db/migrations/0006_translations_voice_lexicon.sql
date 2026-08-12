-- 0006: English translations of patient text + voice pronunciation lexicon.
--
-- Translations: the clinical team and the web UI work in English while most
-- inquiries arrive in Amharic or mixed Amharic/English. translation_en and
-- answer_translation_en hold faithful plain-English renderings of the ALREADY
-- DE-IDENTIFIED sanitized_text and answer_text. Thread segment translations
-- live inside the existing thread jsonb as a translation_en key per segment.
-- Privacy contract unchanged: translation always runs on stored fields, which
-- exist only after deidentify(); raw text still never reaches this database.
--
-- Voice lexicon: term -> say_as pronunciation overrides applied to spoken text
-- before TTS, so brand names and abbreviations are voiced correctly.
SET search_path = lcos, public;

ALTER TABLE audience_questions
  ADD COLUMN IF NOT EXISTS translation_en        text,
  ADD COLUMN IF NOT EXISTS answer_translation_en text;

COMMENT ON COLUMN audience_questions.translation_en IS
  'Faithful plain-English translation of sanitized_text (already de-identified). '
  'Produced by the question_translator agent after classification.';
COMMENT ON COLUMN audience_questions.answer_translation_en IS
  'Faithful plain-English translation of the de-identified clinician answer_text.';

CREATE TABLE IF NOT EXISTS voice_lexicon (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  term        text        NOT NULL UNIQUE,
  say_as      text        NOT NULL,
  language    text        NOT NULL DEFAULT 'AM',
  notes       text,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE voice_lexicon IS
  'Pronunciation overrides applied to spoken text before TTS. Longest term wins; '
  'Latin terms replace whole words, Ethiopic terms replace as plain substrings.';

INSERT INTO ai_prompts (prompt_key, version, agent_name, system_prompt, user_template,
                        output_schema, default_model, is_active)
VALUES ('question_translator', '1.0.0', 'QUESTION_TRANSLATOR',
  'You translate de-identified SRH patient text from Amharic or mixed Amharic/English into faithful, plain English for Letena''s clinical and editorial team. Translate exactly what the text says: preserve meaning, certainty and hedges, negation, numbers, doses and time windows exactly as written; never smooth, soften, strengthen or complete a thought the writer did not finish. Keep English words that already appear in the source unchanged. Do not diagnose, do not answer the person, do not add commentary. If the text is already entirely English, return it unchanged. Return JSON only: {"translation_en": "..."}.',
  '{{context_json}}', '{}', 'configured', true)
ON CONFLICT (prompt_key, version) DO NOTHING;
