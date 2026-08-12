-- 0005: publishing mode. Owner decision (Nate, Aug 2026): collapse the
-- per-piece multi-role review chain. Doctors approve facts (knowledge cards)
-- once; generated content is claim-checked against the approved card and then
-- flows by this mode:
--   DRAFT_BATCH          everything queues; one click approves the batch,
--                        each item gets a publish button (starting mode)
--   AUTO_EXCEPT_SENSITIVE tiers 1-3 publish automatically, TIER_4
--                        (abortion, GBV) still gets one human look
--   FULL_AUTO            everything generated from an approved card publishes
-- The mode is a setting so the switch is a click, not a deploy.
SET search_path = lcos, public;

INSERT INTO settings (key, value, description, is_secret) VALUES
  ('publishing.mode', to_jsonb('DRAFT_BATCH'::text),
   'DRAFT_BATCH | AUTO_EXCEPT_SENSITIVE | FULL_AUTO. How content moves after generation.',
   false)
ON CONFLICT (key) DO NOTHING;
