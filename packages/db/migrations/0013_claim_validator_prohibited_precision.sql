-- 0013: claim_validator agent was flagging PROHIBITED_CLAIM on content that
-- never actually stated the banned assertion, only discussed the same
-- general topic.
--
-- Found live 14 Aug 2026 (Nate: "its to blunt... we can't have it failing
-- for silliness like this"). Script SCR-35ACBC7C (card CON-001, condom
-- effectiveness) said "up to 98% effective" and "an effective barrier
-- against even the smallest STD pathogens" -- never 100%, never "all" --
-- and was blocked as PROHIBITED_CLAIM against "Never claim condoms are
-- 100% effective against pregnancy or all STIs".
--
-- Ran the deterministic overlay (packages/scoring/src/index.mjs,
-- validatorOverlay) directly against this exact script/card/claims: zero
-- findings. That code was already hardened for precisely this failure
-- mode on 12 Aug (anchor on the banned number/absolute, not general
-- topical similarity) and is working correctly. So the block came from
-- the OTHER validator: the claim_validator AI agent
-- (apps/api/src/modules/content.mjs invokes it, findings from both are
-- merged), which the seeded prompt only told to treat prohibited claims
-- as "always blocker" with no guidance on what counts as an actual match
-- versus the same general topic at a lower, hedged, accurate figure. The
-- prompt's own "a false PASS misinforms... a false FAIL costs a rewrite"
-- framing pushes the model toward over-flagging with nothing to anchor
-- it back, the same imprecision the deterministic code used to have
-- before it was given anchors.
--
-- Fix: give the model the same anchor discipline the deterministic code
-- already has, in its own instructions, rather than only in code the
-- model never sees. Same versioning pattern as 0010 (question_classifier):
-- deactivate 1.0.0, insert 1.1.0 active. No application code change.

SET search_path = lcos, public;

UPDATE ai_prompts SET is_active = false
WHERE prompt_key = 'claim_validator' AND version = '1.0.0';

INSERT INTO ai_prompts (prompt_key, version, agent_name, system_prompt, user_template, output_schema, default_model, is_active)
VALUES (
  'claim_validator', '1.1.0', 'CLAIM_VALIDATOR',
  'You validate whether each medically meaningful statement in a script is supported by a closed set of APPROVED_CLAIMS. You must not use outside medical knowledge: a true statement unsupported by the supplied claims is UNSUPPORTED. Verdicts: SUPPORTED, PARTIALLY_SUPPORTED, UNSUPPORTED, CONTRADICTED, AMBIGUOUS. Check specifically: missing safety context, missing referral (blocker at tier 4), overstatement, certainty inflation, causal overreach, numbers or time windows altered, negation errors, meaning lost in simplification, CTA contradiction, fabricated statistics/testimonials, implied credentials, prohibited claims (blocker only when the script states the exact banned number or absolute the claim names, such as the same 100% or the word always/guaranteed/impossible; a lower or hedged figure like 98% on the same general topic is not a near-miss of the ban and must be judged only against APPROVED_CLAIMS like any other statement, not flagged for topical closeness to a prohibited claim). FAIL when any statement is UNSUPPORTED/CONTRADICTED/AMBIGUOUS or any finding is BLOCKER. Be strict on statements that are actually unsupported or actually match a banned assertion precisely: a false PASS on those misinforms a young person. Do not be strict by association: a false FAIL on accurate, appropriately hedged content costs a rewrite and teaches editors to distrust the gate. Return JSON only.',
  '{{context_json}}', '{}', 'configured', true
)
ON CONFLICT (prompt_key, version) DO NOTHING;
