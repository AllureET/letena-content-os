-- 0024: the real Foundations episode schema, from the owner's own material.
--
-- Migration 0019 seeded foundations_episode as a best guess and Run Two left
-- it flagged provisional. On 14 August 2026 Nate supplied the actual series
-- material: the Season 1 Drama Companion (fifteen episode scenarios, the
-- recurring cast, production and governance notes, prepared by Nate, June
-- 2026), the Allure production brief (15 episodes, 8-week program with
-- certification, college students, Letena writes and storyboards, Allure
-- produces), the LeTena Foundation Universe character deck, and the full
-- scripts of Episodes 1 and 2. This migration replaces the guess with what
-- the series actually is.
--
-- What the real material changed against the guess:
--   * The episode is NOT a doctor lecture with cuts. It is drama first: a
--     short relatable scenario from a persistent fictional universe opens
--     the topic, THEN a Letena doctor explains warmly on camera, and the
--     episode closes with a skill and the private door. The drama is the
--     hook that earns the doctor the room.
--   * The pedagogy is the KAP framework, visible in both real scripts as
--     explicit phases: Knowledge (without sounding like school), Attitude
--     (normalize and reframe), Practice (a skill to use), then red flags
--     ("see a clinician if..."), with myth-vs-fact lower thirds and numbered
--     key-takeaway cards throughout.
--   * There is a persistent universe: one recurring cast of thirteen across
--     four standing locations (Hiwot's family home, the campus, the
--     dormitory, the clinic and cafe). Character consistency across fifteen
--     episodes is named in the companion as the top AI production risk.
--   * Production is split: drama scenarios are AI-generated (the companion
--     specifies locking a reference still per character first, then seeding
--     every clip from it), doctor segments are FILMED with real Letena
--     clinicians. So one episode is genuinely both DIGITAL and LIVE, which
--     no other format is. The stages_applicable already include produce,
--     shoot and edit from 0022; that turns out to be exactly right.
--   * A hard technique note from the companion: on-screen phone text,
--     searches, threats and calendars render poorly in AI video. Those beats
--     play through the actor's reaction, with any needed interface added as
--     a motion-graphic overlay in post.
--   * Per-episode governance is explicit in the companion and is now in the
--     rules: EC off screen (episode 9), PEP off screen (episode 7), abortion
--     support-and-next-step framing only (episode 8), consent and violence
--     episodes stop at recognising the situation and route every contact to
--     a private phone consult (episodes 4 and 10), pornography and media
--     literacy needs two cuts, general and age-gated (episode 11).
--   * The narrator is a distinct voice: a friendly, responsible big brother,
--     Amharic, present in both scripts. The tone line from the scripts is
--     kept verbatim in the rules: real, calm, not preachy, zero shame,
--     clinic-safe humor, emotionally intelligent.
--   * Deliverables per episode: the main episode (8 to 12 minutes), three
--     short-form cutdowns, and a facilitator guide, because the series is
--     built to be screened and discussed, week by week, like a course. An
--     8-week program with certification at completion.

SET search_path = lcos, public;

UPDATE content_formats SET
  label = 'Foundations episode',
  description = 'One episode of Letena Foundations, the fifteen-episode SRH drama-plus-doctor course for Ethiopian youth 15 to 24. A scenario from the LeTena universe opens the topic, a real Letena doctor explains it warmly, the episode closes with a skill and the private door. Watched and then discussed: SRH clubs, classrooms, or privately on a phone.',
  headings = '[
    "Episode number and topic",
    "Logline",
    "Cold open: universe scenario (which cast, which location, the situation)",
    "Narrator bridge (friendly responsible big brother, Amharic)",
    "Doctor segment: Knowledge (without sounding like school)",
    "Myth vs fact lower thirds",
    "Doctor segment: Attitude (normalize and reframe)",
    "Doctor segment: Practice (the skill to use)",
    "Red flags: see a clinician if",
    "Key takeaway cards (numbered)",
    "Return to the scenario: what changes",
    "Close: the skill restated and the private door",
    "Three cutdown briefs",
    "Facilitator guide: discussion questions and session plan",
    "AI production notes (reaction-not-screen-text beats, character references used)",
    "Governance note (episode-specific, from the companion)"
  ]'::jsonb,
  rules = '[
    "Tone, verbatim from the scripts: real, calm, not preachy, zero shame, clinic-safe humor, emotionally intelligent.",
    "Drama first. The scenario earns attention before the doctor speaks; the doctor never opens the episode.",
    "The scenario uses the persistent LeTena universe: the recurring cast and the four standing locations (family home, campus, dormitory, clinic and cafe). Never invent a new main character for one episode; supporting cast grows only by owner decision.",
    "Character consistency is the top AI risk across fifteen episodes: lock a reference still per character first, then seed every generated clip from it. Reference stills live in the asset library and are reused, never regenerated per episode.",
    "The doctor segment is written for a real Letena clinician on camera, filmed, not generated. The drama is generated. One episode carries both production paths.",
    "Structure the teaching as KAP: Knowledge, then Attitude, then Practice, then red flags. Each phase is labelled in the script so the facilitator guide can point at it.",
    "Myth vs fact lower thirds use the exact on-screen pattern from Episodes 1 and 2: the myth stated as people actually say it, the correction warm and plain, never mocking the person who believed it.",
    "On-screen phone text, searches, threats and calendars render poorly in AI video: play these beats through the actor''s reaction and add any interface as a motion-graphic overlay in post.",
    "Amharic is the language of the episode. Scene directions and camera notes may be English. The narrator is a friendly responsible big brother voice.",
    "Per-episode governance from the companion is binding: EC and PEP stay off screen and are raised only in a private consult; abortion content is support and next-step framing only; consent and violence episodes stop at recognising the situation and route to a private phone consult; the pornography and media literacy episode ships two cuts, general and age-gated.",
    "Every episode closes at the private door, spoken, after the skill. The viewer leaves knowing the next step.",
    "Each episode also ships three short-form cutdowns and a facilitator guide with discussion questions, because the series is built to be watched and then discussed."
  ]'::jsonb,
  body_schema = '{
    "episode_number": "int, 1 to 15",
    "topic": "string",
    "logline": "one line",
    "cold_open": {"cast": ["names from the recurring cast"], "location": "one of the four standing locations", "scenario_am": "the drama, Amharic, with scene directions", "ai_production_notes": "reaction-not-screen-text beats and reference stills used"},
    "narrator_bridge_am": "string",
    "kap": {"knowledge_am": "string", "attitude_am": "string", "practice_am": "string"},
    "myth_fact": [{"myth_am": "string", "fact_am": "string"}],
    "red_flags_am": ["see a clinician if..."],
    "takeaway_cards": [{"number": "int", "text_am": "string"}],
    "close_am": "skill restated, then the door",
    "cutdowns": [{"hook": "string", "beats": "string", "platform": "string"}],
    "facilitator_guide": {"discussion_questions_am": ["string"], "session_plan": "string"},
    "governance_note": "episode-specific, from the companion"
  }'::jsonb,
  target_length = '{"episode_minutes": [8, 12], "cutdowns": 3, "cutdown_seconds": [20, 45]}'::jsonb,
  updated_at = now()
WHERE code = 'foundations_episode';

-- The provisional flag, however Run Two recorded it, is cleared: this schema
-- comes from the owner's material, not a guess.
UPDATE content_formats SET body_schema = body_schema - 'schema_provisional'
WHERE code = 'foundations_episode' AND body_schema ? 'schema_provisional';
