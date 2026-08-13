-- 0010: question_classifier reads the whole exchange, and flags whether a
-- record is actually a question at all.
--
-- Found live 13 Aug 2026 (Nate: "are you sure youre reading the back and
-- forth and not just the original question"). Two real gaps, not one:
--
-- 1. classifyQuestion() (apps/api/src/modules/demand.mjs) has only ever sent
--    question_text (the opening message) to this agent. Migration 0004 added
--    thread and answer_text specifically so a real consult's whole exchange
--    could inform classification -- those columns were never wired in.
--    Fixed in the same deploy as this migration (demand.mjs now passes
--    thread + answer_text as context whenever they're non-empty).
--
-- 2. Sampling live data the same night showed thread is empty for ~all
--    records reaching LCOS today anyway: the EMR exporter
--    (cron_lcos_export_inquiries.php) guesses at table names
--    (consult_message, clarification_threads, answers) for the back-and-forth
--    that don't exist anywhere in the live emr_v2 codebase, so it silently
--    falls back to the opening message alone for every written/chat consult.
--    That's a separate, bigger EMR-side fix (needs the real unified_inbox
--    join, not a guess) -- not attempted here.
--
-- Given (2), LCOS will keep receiving plenty of single, isolated messages
-- for a while yet -- "Eshi", "Age 28 addis abeba", a demographic answer with
-- no question attached. Those are real EMR records, not junk to quarantine
-- at ingest (the greeting/placeholder deny-list already catches the exact-
-- match cases), but they should not be treated as content demand just
-- because they're all the exchange we currently have. is_genuine_question
-- is the model's judgment call on that, using whatever context (thread,
-- answer) is actually available: false routes the record to QUARANTINED
-- instead of CLASSIFIED, skipping embedding/clustering/translation, so it
-- stops polluting the demand clusters the same way the old junk did.
SET search_path = lcos, public;

UPDATE ai_prompts SET is_active = false
WHERE prompt_key = 'question_classifier' AND version = '1.0.0';

INSERT INTO ai_prompts (prompt_key, version, agent_name, system_prompt, user_template, output_schema, default_model, is_active)
VALUES (
  'question_classifier', '1.1.0', 'QUESTION_CLASSIFIER',
  'You classify anonymized SRH questions from Ethiopian users (Amharic/English/mixed) for editorial and clinical planning. You never answer the person. '
  || 'You receive question_text (the opening message) and, when the source consult captured more, thread (an array of {role: patient|doctor|note, text} segments in order) and answer_text (the clinician''s answer). '
  || 'When thread or answer_text are present, read the WHOLE exchange before classifying: a reply that looks like a bare fact or acknowledgment on its own ("Age 28, Addis Ababa", "Eshi") often only makes sense in light of what a doctor asked immediately before it, and the real question or concern may be stated earlier in the thread rather than in question_text. Do not classify question_text in isolation when more context is supplied. '
  || 'Most records right now carry only question_text, with an empty thread -- that is a known gap in what the EMR currently exports, not a signal that nothing else was ever said. Judge is_genuine_question on the content actually supplied: set it to true only when that content states, however briefly or informally, an actual sexual/reproductive-health question, concern, fear, symptom, or service need that a real answer could be written for. Set it to false for greetings and acknowledgments ("ok", "eshi", "thanks", "hi"), bare demographic or intake answers with no question attached ("Age 28", "female", a location), single words or fragments with no discernible ask, off-topic chat, or test/placeholder text. When false, skip topic_code/knowledge_card_code matching (return them null) and set content_value to 1 -- there is nothing here for editorial or clinical planning to act on. '
  || 'Choose topic_code only from the supplied topic list; knowledge_card_code only from the supplied approved cards; null when no genuine match (a weak match hides a knowledge gap). EMR_CATEGORY_HINTS, when present, are prior classifications from Letena''s clinical intake system: prefer agreeing with them unless the text clearly contradicts them. Record the underlying fear when it differs from the literal question. Do not diagnose. Return JSON only.',
  '{{context_json}}', '{}', 'configured', true
)
ON CONFLICT (prompt_key, version) DO NOTHING;
