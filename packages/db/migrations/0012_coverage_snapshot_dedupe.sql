-- 0012: fix coverage_snapshots accumulating duplicate rows, same root cause
-- as 0011 (topic_priority_scores) but on the sibling table computeDemand()
-- also writes every pass.
--
-- Found live 14 Aug 2026, right after verifying 0011 had actually applied
-- (it had, cleanly, topic_priority_scores had zero duplicate groups).
-- v_coverage_gaps (0001_init.sql) LEFT JOINs coverage_snapshots on
-- (computed_for, topic_id, knowledge_card_id IS NOT DISTINCT). With
-- topic_priority_scores now correctly deduped to one row per topic, the
-- view still fanned out to dozens of identical rows because
-- coverage_snapshots itself was never touched by 0011: its constraint is
-- UNIQUE (computed_for, topic_id, knowledge_card_id) with no
-- NULLS NOT DISTINCT, so every classify-triggered recompute today inserted
-- a fresh row instead of updating (knowledge_card_id is NULL for almost
-- every topic, no card matched yet). Confirmed live via psql: up to 39
-- duplicate rows for a single topic, all computed_for 2026-08-14, all
-- knowledge_card_id NULL.
--
-- Same fix as 0011: dedupe existing rows first (keep the most recently
-- computed one per key, NULLs treated as equal), then replace the
-- constraint with a NULLS NOT DISTINCT version so the application's
-- existing ON CONFLICT (computed_for, topic_id, knowledge_card_id)
-- DO UPDATE actually matches going forward. No application code change is
-- needed, only the constraint; the INSERT in computeDemand() already
-- targets the right columns.

DELETE FROM coverage_snapshots a
USING coverage_snapshots b
WHERE a.computed_for = b.computed_for
  AND a.topic_id = b.topic_id
  AND a.knowledge_card_id IS NOT DISTINCT FROM b.knowledge_card_id
  AND a.computed_at < b.computed_at;

ALTER TABLE coverage_snapshots DROP CONSTRAINT IF EXISTS coverage_snapshot_uk;

ALTER TABLE coverage_snapshots
  ADD CONSTRAINT coverage_snapshot_uk
  UNIQUE NULLS NOT DISTINCT (computed_for, topic_id, knowledge_card_id);
