-- 0011: fix topic_priority_scores accumulating duplicate rows per day.
--
-- Found live 14 Aug 2026 (Nate: "why is Pregnancy there so many times with
-- different priorities"). Root cause: the table's unique constraint is
-- UNIQUE (computed_for, topic_id, knowledge_card_id, audience_segment_id).
-- Standard SQL treats every NULL as distinct from every other NULL for
-- uniqueness purposes, and BOTH knowledge_card_id and audience_segment_id
-- are NULL for most rows today (no card matched yet; audience segmentation
-- isn't wired into computeDemand() at all yet) -- so the "unique" constraint
-- never actually matched on ON CONFLICT for exactly the rows that needed it
-- most. Every call to computeDemand() (auto-triggered after any
-- classify-pending batch that classified something) silently INSERTed a
-- fresh row instead of updating today's. Confirmed live: Pregnancy alone
-- had 4 rows all dated 2026-08-13, computed_at 08:30/11:01/12:36/15:07 UTC,
-- one per classify-pending click that day, both knowledge_card_id and
-- audience_segment_id NULL on every one.
--
-- Fix: PG16 (this project's version, see infra/docker-compose.yml) supports
-- UNIQUE ... NULLS NOT DISTINCT, which treats NULL = NULL for uniqueness
-- purposes -- exactly what's needed here since NULL card / NULL segment are
-- real, common, meaningful values (no card matched / not segmented), not
-- absent data that should stay non-comparable.

-- Dedupe existing rows first: keep only the most recently computed row per
-- (computed_for, topic_id, knowledge_card_id, audience_segment_id), treating
-- NULLs as equal, so the new constraint below can actually be created.
DELETE FROM topic_priority_scores a
USING topic_priority_scores b
WHERE a.computed_for = b.computed_for
  AND a.topic_id = b.topic_id
  AND a.knowledge_card_id IS NOT DISTINCT FROM b.knowledge_card_id
  AND a.audience_segment_id IS NOT DISTINCT FROM b.audience_segment_id
  AND a.computed_at < b.computed_at;

-- The original constraint never actually enforced anything when either
-- nullable column was NULL (see above), so drop it and replace with one
-- that treats NULLs as equal.
ALTER TABLE topic_priority_scores DROP CONSTRAINT IF EXISTS topic_priority_uk;

ALTER TABLE topic_priority_scores
  ADD CONSTRAINT topic_priority_uk
  UNIQUE NULLS NOT DISTINCT (computed_for, topic_id, knowledge_card_id, audience_segment_id);
