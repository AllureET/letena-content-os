-- 0014: OpenAI removed as an AI provider option entirely (Nate, 14 Aug 2026:
-- "I dont have openai at all... take all that out of settings").
--
-- Three things were confusingly labeled "provider" in this system and only
-- one of them ever did anything:
--   1. lcos.settings key 'ai.default_provider' -- a generic settings-page
--      row seeded '"OPENAI"' at install and never read by any application
--      code (confirmed: no match anywhere in apps/). Purely decorative, and
--      the thing Nate actually saw and reasonably assumed was live.
--   2. ai_prompts.default_provider -- a per-prompt-row ENUM column, also
--      seeded OPENAI, also never read by invokeAgent() (apps/api/src/ai/
--      gateway.mjs calls getProvider(providerName) where providerName is
--      never passed by any caller in this codebase). Also decorative.
--   3. The 'LCOS_AI_PROVIDER' credential (lcos.settings key
--      'cred.LCOS_AI_PROVIDER') -- this is the ONLY one getProvider() (apps/
--      api/src/ai/provider.mjs) actually reads, and the only one that has
--      ever controlled which model answers a request.
--
-- Real paid usage already exists on QUESTION_CLASSIFIER ($25.32 / 3929
-- calls per /api/v1/analytics/costs) while OPENAI_API_KEY has never been
-- set (status "unset"). OpenAIProvider throws immediately with no key, so
-- those real charges could not have been OpenAI -- LCOS_AI_PROVIDER was
-- already ANTHROPIC in practice. This migration makes that explicit and
-- certain instead of assumed, and deletes the decorative duplicate that was
-- the actual source of Nate's "why does Settings say OPENAI" confusion.
--
-- Removes OpenAI as a selectable value everywhere it could ever have been
-- chosen from. The application no longer contains an OpenAI code path at
-- all as of this same change (apps/api/src/ai/provider.mjs, apps/api/src/
-- creds.mjs) -- this migration is the data-side half of that.

SET search_path = lcos, public;

-- (1) Delete the decorative, unused, misleading setting.
DELETE FROM settings WHERE key = 'ai.default_provider';

-- (2) Make certain the one setting that actually matters is ANTHROPIC.
-- is_secret=true to match setCred()'s own convention (apps/api/src/creds.mjs
-- always writes cred.* rows as is_secret=true regardless of the registry's
-- secret flag), so this row stays out of the generic /platform/settings
-- listing exactly like every other credential does.
INSERT INTO settings (key, value, description, is_secret)
VALUES ('cred.LCOS_AI_PROVIDER', '"ANTHROPIC"', 'AI provider', true)
ON CONFLICT (key) DO UPDATE SET value = '"ANTHROPIC"', is_secret = true, updated_at = now();

-- (3) Clean up the other decorative column so nothing left in the system
-- still claims OpenAI is involved. Unused by app code; safe to update.
ALTER TABLE ai_prompts ALTER COLUMN default_provider SET DEFAULT 'ANTHROPIC';
UPDATE ai_prompts SET default_provider = 'ANTHROPIC' WHERE default_provider = 'OPENAI';

-- Note: the underlying `ai_provider` ENUM type (packages/db/migrations/
-- 0001_init.sql) still technically lists OPENAI as a legal stored value.
-- Dropping an enum value is an invasive, table-rewriting operation in
-- Postgres and nothing can select OPENAI through the app anymore after
-- this migration, so it is left in place rather than risk a destructive
-- schema change for a value that is now permanently unreachable.
