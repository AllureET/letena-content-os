-- 0004: full inquiries. A real consult is rarely one message: written consults
-- run through clarification threads before the doctor's answer, and phone
-- consults produce clinical notes rather than a single question. The owner
-- (Nate, Aug 2026) approved exporting the full de-identified inquiry, doctor
-- answers and clinical notes included, so LCOS can generate content grounded
-- in what was actually asked AND how the clinicians actually answered.
--
-- Privacy contract is unchanged: everything in these columns has already been
-- through deidentify() in memory at the ingest boundary. There is still no
-- raw text anywhere in this database, and the exporters still never send
-- names, phones, ids, or any patient identifier.
SET search_path = lcos, public;

ALTER TABLE audience_questions
  ADD COLUMN IF NOT EXISTS answer_text  text
    CHECK (answer_text IS NULL OR char_length(answer_text) BETWEEN 3 AND 8000),
  ADD COLUMN IF NOT EXISTS answered_at  timestamptz,
  ADD COLUMN IF NOT EXISTS thread       jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS consult_mode text
    CHECK (consult_mode IS NULL OR consult_mode IN ('WRITTEN','PHONE'));

COMMENT ON COLUMN audience_questions.answer_text IS
  'De-identified clinician answer to this question, when the source consult has one. '
  'Seeds knowledge cards and verifies generated content against real clinical practice.';
COMMENT ON COLUMN audience_questions.thread IS
  'De-identified conversation segments beyond the opening question: array of '
  '{role: patient|doctor|note, text}. "note" segments are clinical notes, owner-approved '
  'as content material. Every segment passed deidentify() before storage.';
COMMENT ON COLUMN audience_questions.consult_mode IS
  'How the source consult started in the EMR: WRITTEN or PHONE. NULL for single-message ingest.';

-- Answered questions are the seed corpus for knowledge cards; make them cheap to list.
CREATE INDEX IF NOT EXISTS questions_answered_idx
  ON audience_questions (captured_at DESC) WHERE answer_text IS NOT NULL;
