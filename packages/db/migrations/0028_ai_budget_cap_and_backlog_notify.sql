-- 0028: real-dollar AI budget cap, and a settings-driven threshold for the
-- backlog notify banner. Added 15 Aug 2026 after the background classify
-- sweep (added 14 Aug, removed this same day) ran up real AI spend
-- automatically, every 5 minutes, with no cap and no notification anywhere
-- to catch it. Nate: "this needs to be done with... maybe only when we
-- reach X amount of new questions and it tells me and I request a batch
-- pull." This migration is the settings half of that; the code half is the
-- removed sweep in apps/api/src/modules/demand.mjs, the cap check in
-- apps/api/src/ai/gateway.mjs's invokeAgent(), and the banner in app.js.

ALTER TABLE lcos.ai_invocations DROP CONSTRAINT ai_invocations_outcome_check;
ALTER TABLE lcos.ai_invocations ADD CONSTRAINT ai_invocations_outcome_check
  CHECK (outcome IN ('SUCCESS','SCHEMA_FAIL','PROVIDER_ERROR','TIMEOUT','REFUSED',
                      'BLOCKED_PII','BUDGET_CAPPED'));

INSERT INTO lcos.settings (key, value, description) VALUES
  ('ai.daily_budget_cap_usd', 'null',
   'Real-dollar ceiling on AI spend per UTC day. Blank/null means no cap. Once today''s real spend (lcos.ai_invocations.cost_usd) reaches this, every further AI call is refused with BUDGET_CAPPED until the next UTC day or until this is raised.'),
  ('demand.backlog_notify_threshold', '50',
   'How many questions may sit unclassified before the dashboard shows a banner asking someone to run a batch. Nothing runs automatically; this only tells you it is time to click "Classify pending questions."')
ON CONFLICT (key) DO NOTHING;
