-- Video Studio, free-text lock drafting (18 Aug 2026). Nate's question after
-- seeing the New lock form's raw JSON box: "Can't the json box be instead
-- like a way to rewrite the prompt properly through Claude... I doubt I can
-- write it to the level of a Google Veo prompt that's excellent."
--
-- The fix keeps the architecture that already exists rather than replacing
-- it: continuity locks stay structured, versioned data, and
-- compileStillPrompt()/compileMotionPrompt() (studio.mjs) still compile the
-- actual generation prompt DETERMINISTICALLY from that data -- the same
-- "code assembles load-bearing content, the model never freehands it"
-- discipline this session already applied to the CTA fix earlier tonight,
-- and for the same reason: a prompt an LLM writes fresh each time is not
-- reproducible, not reviewable word-for-word before a paid generation call,
-- and drifts silently between shots.
--
-- What changes is INTAKE, not compilation. POST /studio/locks/draft (new,
-- studio.mjs) takes a free-text description a non-technical person can
-- actually write, and calls this new agent (studio_lock_drafter, see
-- apps/api/src/ai/gateway.mjs) to turn it into the SAME structured fields
-- compileStillPrompt() already reads. The result is returned, not saved --
-- the human still sees the drafted JSON in the form and can edit or reject
-- it before Create lock is ever pressed. Same pattern already used
-- elsewhere in this codebase for AI-assisted structured content
-- (asset_prompt_writer, creative_director, etc.): a model drafts, a human
-- approves, and only the approved, structured result ever becomes
-- canonical data.
SET search_path = lcos, public;

INSERT INTO ai_prompts (prompt_key, version, agent_name, system_prompt, user_template,
                        output_schema, default_model, is_active)
VALUES (
  'studio_lock_drafter', '1.0.0', 'STUDIO_LOCK_DRAFTER',
  'You draft structured continuity data for Allure''s AI video production system (Video Studio). You are given entity_type (one of CHARACTER, STYLE, ENVIRONMENT, or PROP) and free_text: a description written by a non-technical production coordinator, in her own words, of a character, the project''s overall visual style, a location, or an object that has to look the same across every shot it appears in.

Extract only what free_text actually states or clearly implies into the matching structured fields. Never invent a specific detail (an exact age, a specific hair color, a specific material, a name) that free_text does not support just to fill a field -- leave that field null instead. A thin description should produce a thin, honest result, not a fabricated complete one.

Only fill fields that apply to the given entity_type. CHARACTER: name, apparent_age, silhouette, face, hair, wardrobe_default. STYLE: style_summary, motion_grammar. ENVIRONMENT: architecture, palette, time, weather. PROP: material, color, wear, scale_reference. style_summary may also be filled for any entity_type if free_text describes a visual style alongside the subject.

Describe observable design properties -- shapes, colors, materials, proportions, lighting -- not vague artist-name shorthand. If free_text says something like "Pixar style" or "in the style of X", translate that into concrete observable properties instead of repeating the name; you may still reference it briefly for tone if useful, but the field content itself must be a real description, not a name.

If free_text says something should NOT appear (no earrings, no glasses, never smiling, whatever it is), that goes in forbidden_drift as a short phrase, never into a positive field.

If free_text is too thin to responsibly fill anything meaningful, say so plainly in clarifying_note (e.g. "no physical description given beyond a name; consider adding age, build, or clothing") rather than fabricating detail to look complete. Leave clarifying_note null when nothing needs flagging.',
  '{{context_json}}', '{}', 'configured', true)
ON CONFLICT (prompt_key, version) DO NOTHING;
