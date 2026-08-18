-- 0029: consolidate the AI spend cap onto the setting that already existed.
--
-- Migration 0028 (15 Aug 2026) added a new key, ai.daily_budget_cap_usd, to
-- back the real enforcement wired into invokeAgent(). That was a mistake:
-- ai.daily_spend_cap_usd already existed, default 40, already labeled "Hard
-- stop for AI spend per day." Found live 16 Aug 2026, while confirming the
-- background classify sweep had actually stopped, that this pre-existing
-- setting had never been enforced anywhere. production.mjs's spendToday()
-- read it and showed it on the production plan screen; nothing ever
-- compared it against a real invokeAgent() call and refused. So there were
-- briefly two similarly-named settings doing two different things: one that
-- looked like a hard stop and wasn't, and a new one that actually was.
--
-- This migration removes the new, redundant key and leaves exactly one:
-- ai.daily_spend_cap_usd, now genuinely enforced (see ai/gateway.mjs), still
-- at its existing value so nothing about today's behavior changes from an
-- operator's point of view except that the number now means what its label
-- always claimed it meant.

DELETE FROM lcos.settings WHERE key = 'ai.daily_budget_cap_usd';

UPDATE lcos.settings SET description =
  'Real-dollar ceiling on AI spend per UTC day, checked before every AI call (apps/api/src/ai/gateway.mjs invokeAgent()). Blank/null means no cap. Once today''s real spend (lcos.ai_invocations.cost_usd) reaches this, every further AI call is refused with BUDGET_CAPPED until the next UTC day or until this is raised. Before 16 Aug 2026 this value was read and shown on the production plan screen only; it did not actually stop anything.'
WHERE key = 'ai.daily_spend_cap_usd';
