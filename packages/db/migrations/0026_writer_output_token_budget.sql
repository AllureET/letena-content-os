-- 0026: raise script_writer's output token budget.
--
-- Found live 15 Aug 2026, browser-testing Part 2 the first time it actually
-- ran against real credentials: generating send_it for CON-001 failed twice
-- (the gateway's own one-retry loop) with "provider error: Unexpected end
-- of JSON input", surfaced to Girum's screen exactly like that, a raw parse
-- error where the UI is supposed to say something a human can use.
--
-- Root cause, not the JSON-parsing code: script_writer has never had
-- max_output_tokens set in any of its three versions (0001 init, 0021 v1.3.0,
-- 0023 v1.4.0), so every version silently ran on the table's DEFAULT 4000.
-- That was plausibly enough for the original handful of simple formats. It
-- is not enough now: Part 1 grew the writer's own required output to include
-- a scene-by-scene body for video formats, a claim_map entry per sentence,
-- captions keyed per platform (up to 7), and a cta_spec, all in one JSON
-- object. Anthropic's provider.mjs takes the model at its word up to
-- max_tokens and does not detect truncation; a cut-off response leaves the
-- naive first-brace/last-brace slice holding an unterminated object, which
-- is exactly "Unexpected end of JSON input". This migration does not touch
-- that slicing (a separate, real hardening item, noted but not done here)
-- because raising the budget is the actual fix: nothing this format asks
-- for should have been running that close to the ceiling.
--
-- amharic_localizer produces a comparable shape (Amharic body, English
-- source, blind back-translation, drift notes) for every approved English
-- piece, so it is raised the same way rather than waiting to reproduce the
-- identical failure there.

SET search_path = lcos, public;

UPDATE ai_prompts SET max_output_tokens = 8000
WHERE prompt_key = 'script_writer' AND is_active;

UPDATE ai_prompts SET max_output_tokens = 8000
WHERE prompt_key = 'amharic_localizer' AND is_active;
