-- 0019: the data-driven format registry for the unified content machine.
--
-- Owner decision (Nate, 14 Aug 2026): merge letenav2's content system and
-- LCOS into one machine, keep the best of each, extend to every surface
-- Letena publishes on. This migration is Run One's core: every format is a
-- ROW here, carrying its own headings, writing rules, body shape, stage
-- applicability, review ladder and target length. Adding a format is an
-- INSERT, never a code change. Nate on the format list: "these are all
-- genuinely different formats. Do not merge any of them."
--
-- What each column is for:
--   body_kind          the contract with the writer and with bodyTextOf()
--                      in apps/api/src/formats.mjs. Several formats share a
--                      body kind (save_it and carousel are both CAROUSEL
--                      bodies) but differ in headings, rules and length.
--   video_family       render-routing compatibility with the existing
--                      production ROUTE map and the content_concepts enum
--                      column. Text-like formats carry C03_TELEGRAM_POST,
--                      which routes MANUAL_UPLOAD and never generates a
--                      voiceover. This is a routing default, not identity.
--   headings/rules     ported VERBATIM from letenav2 letena_cs_schema_for()
--                      for the formats that had them (send_it, save_it,
--                      aua_clip, reply_video, blog); authored to the same
--                      pattern for the rest. Rules are injected into the
--                      writer prompt per format.
--   stages_applicable  which of the nine pipeline stages apply. A push
--                      notification is never shot or edited; that is marked
--                      here explicitly rather than the stage not existing.
--                      medical_review is REQUIRED in every row, enforced by
--                      the CHECK below: no format can opt out of medical
--                      review, ever.
--   review_ladder      the sign-offs the format needs, in order. Today every
--                      format climbs unreviewed -> content_ok -> medical_ok.
--   hedging_allowed    the one documented tension, preserved rather than
--                      resolved: hedging is banned in formal copy, but cycle
--                      predictions in the app MUST say might/may because
--                      there the uncertainty is factually true. Scoped per
--                      format, exactly as the owner brief specifies.
--   ends_at_door       whether the piece ends at the canonical private
--                      message door block. App-internal surfaces (the Ask
--                      tab IS the door in-app) and institutional documents
--                      do not.
--   is_internal        never published outside the organisation
--                      (doctor_reply_starter). Publish-facing stages are
--                      also absent from stages_applicable for these.
--
-- brand_tier, which letenav2 carried as a valid format value with no schema
-- (it silently fell back to the 15-second clip schema), is deliberately NOT
-- seeded. It was never a format: it was a protected share of production
-- hours, part of the weekly quota system the owner explicitly dropped
-- ("Do not port the weekly quota system"). Dropping it is the decision.
--
-- library_explainer, the other schema-less format (same silent clip
-- fallback), gets a real long-form ARTICLE schema below. That closes
-- defect 2 of the kickoff brief. animated_news, dead code in letenav2
-- ($isNews computed and never read), becomes a real row. That closes
-- defect 4.

SET search_path = lcos, public;

CREATE TABLE content_formats (
  code               text PRIMARY KEY,
  label              text NOT NULL,
  kind               text NOT NULL,
  surface            text NOT NULL CHECK (surface IN
                       ('SOCIAL_VIDEO','SOCIAL_STATIC','TEXT_LONGFORM','ABEBA_APP','PROGRAMME')),
  platforms          text[] NOT NULL DEFAULT '{}',
  language_mode      text NOT NULL DEFAULT 'AM_FIRST'
                       CHECK (language_mode IN ('AM_FIRST','PARALLEL','EN_FIRST')),
  body_kind          text NOT NULL CHECK (body_kind IN
                       ('VIDEO','CAROUSEL','STATIC','POST','ARTICLE','MICROCOPY','PUSH','AUDIO','LIVE')),
  video_family       video_family NOT NULL DEFAULT 'C03_TELEGRAM_POST',
  headings           jsonb NOT NULL DEFAULT '[]'::jsonb,
  rules              jsonb NOT NULL DEFAULT '[]'::jsonb,
  body_schema        jsonb NOT NULL DEFAULT '{}'::jsonb,
  stages_applicable  text[] NOT NULL,
  review_ladder      text[] NOT NULL DEFAULT '{content_ok,medical_ok}',
  target_length      jsonb NOT NULL DEFAULT '{}'::jsonb,
  hedging_allowed    boolean NOT NULL DEFAULT false,
  wants_captions     boolean NOT NULL DEFAULT false,
  ends_at_door       boolean NOT NULL DEFAULT true,
  is_internal        boolean NOT NULL DEFAULT false,
  is_active          boolean NOT NULL DEFAULT true,
  sort_order         integer NOT NULL DEFAULT 100,
  description        text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- No format ever opts out of medical review. This is structural, not
  -- advisory: a row that omits medical_review cannot be inserted at all.
  CONSTRAINT content_formats_medical_review_required
    CHECK (stages_applicable @> ARRAY['medical_review']::text[]),
  CONSTRAINT content_formats_stages_valid
    CHECK (stages_applicable <@ ARRAY['plan','script','medical_review','shoot','edit',
                                      'approve','publish','repurpose','measure']::text[])
);
COMMENT ON TABLE content_formats IS
  'The unified format registry. One row per format Letena publishes, across social video, static/card, text and long form, the Abeba app, and programme/institutional surfaces. Adding a format is a row, never a code change.';

-- ===========================================================================
-- Surface A: short-form social video
-- ===========================================================================
INSERT INTO content_formats
  (code, label, kind, surface, platforms, language_mode, body_kind, video_family,
   headings, rules, body_schema, stages_applicable, target_length,
   hedging_allowed, wants_captions, ends_at_door, is_internal, sort_order, description)
VALUES
('send_it', 'Send-It', 'clip', 'SOCIAL_VIDEO', '{TIKTOK,INSTAGRAM}', 'AM_FIRST', 'VIDEO', 'V01_QUESTION_EXPLAINER',
 '["Title","Theme","On-screen hook (Amharic, a question the viewer is scared to ask)","Spoken keyword (english / አማርኛ, spoken verbatim in the VO)","Beat 1, 0:00-0:03, hook restated aloud (visual / VO Amharic / VO English gloss / on-screen)","Beat 2, 0:03-0:10, the substance","Beat 3, 0:10-0:17, the turn toward the door","Door beat (canonical Amharic door)","VO close","Caption, short video","Caption, Facebook and Telegram","Caption, Twitter and X","Hashtags","CTA and tracking notes","Production notes","Clinical note"]'::jsonb,
 '["Exactly three beats. 0:00-0:03 restate the hook aloud, 0:03-0:10 the substance, 0:10-0:17 the turn toward the door.","Total runtime fifteen to twenty-five seconds.","The hook is a question the viewer is scared to ask, in Amharic, restated aloud in beat one.","The spoken keyword is said verbatim somewhere in the voiceover."]'::jsonb,
 '{"beats":3}'::jsonb,
 '{plan,script,medical_review,shoot,edit,approve,publish,repurpose,measure}',
 '{"unit":"seconds","min":15,"max":25}'::jsonb,
 false, true, true, false, 10,
 'The flagship 15-25 second clip: hook she is scared to ask, substance, turn to the door.'),

('question_explainer', 'Question explainer', 'clip', 'SOCIAL_VIDEO', '{TIKTOK}', 'AM_FIRST', 'VIDEO', 'V01_QUESTION_EXPLAINER',
 '["Title","Theme","On-screen hook (Amharic)","Spoken keyword (english / አማርኛ)","Hook question","Direct answer","Supporting beat","CTA end card","Door beat (canonical Amharic door)","VO close","Caption, short video","Caption, Facebook and Telegram","Caption, Twitter and X","Hashtags","Clinical note"]'::jsonb,
 '["Typography-led. The on-screen text carries the whole meaning with the sound off.","Hook question first, direct answer immediately after. No preamble.","CTA end card, then the canonical door."]'::jsonb,
 '{}'::jsonb,
 '{plan,script,medical_review,shoot,edit,approve,publish,repurpose,measure}',
 '{"unit":"seconds","min":15,"max":45}'::jsonb,
 false, true, true, false, 20,
 'Typography-led vertical explainer: hook question, direct answer, CTA end card.'),

('chat_story', 'Chat story', 'clip', 'SOCIAL_VIDEO', '{TIKTOK}', 'AM_FIRST', 'VIDEO', 'V02_CHAT_STORY',
 '["Title","Theme","On-screen hook (Amharic)","Spoken keyword (english / አማርኛ)","Opening worried messages (fictional peer)","The calm factual reply (Letena)","The turn toward the door","Door beat (canonical Amharic door)","Caption, short video","Caption, Facebook and Telegram","Caption, Twitter and X","Clinical note"]'::jsonb,
 '["A WhatsApp-style bubble chat between a fictional worried peer and Letena.","Every character is fictional and marked as fictional. Never present a chat as a real conversation.","The peer voice carries the fear; the Letena voice carries the fact. Never shame the peer for asking."]'::jsonb,
 '{"style":"chat_bubbles"}'::jsonb,
 '{plan,script,medical_review,shoot,edit,approve,publish,repurpose,measure}',
 '{"unit":"seconds","min":20,"max":50}'::jsonb,
 false, true, true, false, 30,
 'WhatsApp-style bubble chat between a fictional worried peer and Letena.'),

('illustrated_scenario', 'Illustrated scenario', 'clip', 'SOCIAL_VIDEO', '{INSTAGRAM}', 'AM_FIRST', 'VIDEO', 'V03_ILLUSTRATED_SCENARIO',
 '["Title","Theme","On-screen hook (Amharic)","Spoken keyword (english / አማርኛ)","Scenario setup","The moment of worry","The answer","The turn toward the door","Door beat (canonical Amharic door)","Caption, short video","Caption, Facebook and Telegram","Caption, Twitter and X","Clinical note"]'::jsonb,
 '["A short illustrated scenario built around the question. One ordinary named situation beats a whole category.","Illustration only, never photography of identifiable people.","The scenario resolves with the fact, then turns to the door."]'::jsonb,
 '{}'::jsonb,
 '{plan,script,medical_review,shoot,edit,approve,publish,repurpose,measure}',
 '{"unit":"seconds","min":25,"max":55}'::jsonb,
 false, true, true, false, 40,
 'Short illustrated scenario built around the question.'),

('medical_visual', 'Medical visual explainer', 'clip', 'SOCIAL_VIDEO', '{INSTAGRAM}', 'AM_FIRST', 'VIDEO', 'V04_MEDICAL_VISUAL_EXPLAINER',
 '["Title","Theme","On-screen hook (Amharic)","Spoken keyword (english / አማርኛ)","The mechanism, step by step","What this means for her","The turn toward the door","Door beat (canonical Amharic door)","Caption, short video","Caption, Facebook and Telegram","Caption, Twitter and X","Clinical note"]'::jsonb,
 '["Library-only clinically approved visuals. Never generate medical illustration.","Explains one mechanism, step by step, in plain words.","Every visual asset used must carry clinical approval in the asset library."]'::jsonb,
 '{"assets":"library_only_clinically_approved"}'::jsonb,
 '{plan,script,medical_review,shoot,edit,approve,publish,repurpose,measure}',
 '{"unit":"seconds","min":30,"max":60}'::jsonb,
 false, true, true, false, 50,
 'Library-only clinically approved visuals explaining a mechanism.'),

('digital_presenter', 'Digital presenter', 'clip', 'SOCIAL_VIDEO', '{YOUTUBE}', 'AM_FIRST', 'VIDEO', 'V05_DIGITAL_PRESENTER',
 '["Title","Theme","On-screen hook (Amharic)","Spoken keyword (english / አማርኛ)","Presenter opening","The answer, with visible structure","The turn toward the door","Door beat (canonical Amharic door)","Caption, short video","Caption, Facebook and Telegram","Caption, Twitter and X","Clinical note"]'::jsonb,
 '["HeyGen presenter to camera. Calm expert register with a visible beginning, middle and end.","Blocked at TIER_4: the highest-sensitivity topics never run through a synthetic presenter.","The presenter is a Letena presenter, never labelled or implied to be a doctor."]'::jsonb,
 '{"block_tier":"TIER_4"}'::jsonb,
 '{plan,script,medical_review,shoot,edit,approve,publish,repurpose,measure}',
 '{"unit":"seconds","min":20,"max":90}'::jsonb,
 false, true, true, false, 60,
 'HeyGen presenter to camera. Blocked at TIER_4.'),

('real_ethiopia', 'Real Ethiopia hybrid', 'clip', 'SOCIAL_VIDEO', '{TIKTOK}', 'AM_FIRST', 'VIDEO', 'V06_REAL_ETHIOPIA_HYBRID',
 '["Title","Theme","On-screen hook (Amharic)","Spoken keyword (english / አማርኛ)","B-roll plan (everyday Ethiopian settings)","The answer over the b-roll","The turn toward the door","Door beat (canonical Amharic door)","Caption, short video","Caption, Facebook and Telegram","Caption, Twitter and X","Clinical note"]'::jsonb,
 '["Generative b-roll of everyday Ethiopian settings behind the answer. Never anatomy, never clinics, never recognisable real people.","The b-roll is atmosphere; the on-screen text and VO carry the meaning."]'::jsonb,
 '{}'::jsonb,
 '{plan,script,medical_review,shoot,edit,approve,publish,repurpose,measure}',
 '{"unit":"seconds","min":20,"max":45}'::jsonb,
 false, true, true, false, 70,
 'Generative b-roll of everyday Ethiopian settings behind the answer.'),

('reply_video', 'Reply-Video', 'reply', 'SOCIAL_VIDEO', '{TIKTOK}', 'AM_FIRST', 'VIDEO', 'V01_QUESTION_EXPLAINER',
 '["Title","Theme","On-screen hook (Amharic)","Spoken keyword (english / አማርኛ)","The comment being answered","The reply (Amharic)","The reply (English gloss)","The turn toward the door","Caption, short video","Caption, Facebook and Telegram","Caption, Twitter and X","Clinical note"]'::jsonb,
 '["A fixed reply-video template: answer one comment, briefly, Amharic first.","Turn to the private-message door. Never invite a public comment."]'::jsonb,
 '{}'::jsonb,
 '{plan,script,medical_review,shoot,edit,approve,publish,repurpose,measure}',
 '{"unit":"seconds","min":15,"max":45}'::jsonb,
 false, true, true, false, 80,
 'Answer one comment briefly, Amharic first, turn to the private door. Never invite a public comment.'),

('animated_news', 'Animated news', 'clip', 'SOCIAL_VIDEO', '{TIKTOK,FACEBOOK}', 'AM_FIRST', 'VIDEO', 'V01_QUESTION_EXPLAINER',
 '["Title","Theme","On-screen hook (Amharic)","Spoken keyword (english / አማርኛ)","The one fact","Why it matters to her","The turn toward the door","Door beat (canonical Amharic door)","VO close","Caption, short video","Caption, Facebook and Telegram","Caption, Twitter and X","Clinical note"]'::jsonb,
 '["One fact only, never stacked. If a second fact wants in, it is a second piece.","A short-form send_it variant: same three-beat spine, carried by one animated fact.","The fact must map to an approved claim like any other statement."]'::jsonb,
 '{"facts_per_piece":1}'::jsonb,
 '{plan,script,medical_review,shoot,edit,approve,publish,repurpose,measure}',
 '{"unit":"seconds","min":15,"max":25}'::jsonb,
 false, true, true, false, 90,
 'One fact only, never stacked. Was dead code in letenav2; a real format here.')
ON CONFLICT (code) DO NOTHING;

-- ===========================================================================
-- Surface B: static and card
-- ===========================================================================
INSERT INTO content_formats
  (code, label, kind, surface, platforms, language_mode, body_kind, video_family,
   headings, rules, body_schema, stages_applicable, target_length,
   hedging_allowed, wants_captions, ends_at_door, is_internal, sort_order, description)
VALUES
('save_it', 'Save-It', 'card', 'SOCIAL_STATIC', '{INSTAGRAM,TELEGRAM}', 'AM_FIRST', 'CAROUSEL', 'C01_CAROUSEL',
 '["Title","Theme","On-screen hook (Amharic)","Spoken keyword (english / አማርኛ)","Slide 1, cover with a save prompt","Slide 2","Slide 3","Slide 4","Slide 5","Slide 6","Final slide, the door","Info caption (Amharic)","Info caption (English gloss)","Caption, short video","Caption, Facebook and Telegram","Caption, Twitter and X","Hashtags","Production notes","Clinical note"]'::jsonb,
 '["Six to nine slides. Slide 1 is the cover and carries a save prompt.","One idea per slide. Each slide is Amharic first, then an English gloss.","The final slide is always the private-message door.","A card that routes to services carries the cost-barrier line on its own slide."]'::jsonb,
 '{"slides":{"min":6,"max":9},"dimensions":"1080x1350","cover":"save_prompt","final_slide":"door","cost_barrier_line":"own slide when the card routes to services"}'::jsonb,
 '{plan,script,medical_review,edit,approve,publish,repurpose,measure}',
 '{"unit":"slides","min":6,"max":9}'::jsonb,
 false, true, true, false, 110,
 'The save-worthy reference card. 6-9 slides, cover save prompt, door on the final slide.'),

('carousel', 'Carousel', 'card', 'SOCIAL_STATIC', '{INSTAGRAM,LINKEDIN,TWITTER}', 'AM_FIRST', 'CAROUSEL', 'C01_CAROUSEL',
 '["Title","Theme","Slide 1, the hook","Middle slides, one idea each","Last slide, the CTA","Caption, short video","Caption, Facebook and Telegram","Caption, Twitter and X","Hashtags","Clinical note"]'::jsonb,
 '["Slide 1 is the hook and must make her stop and swipe.","One idea per slide. A slide that needs a paragraph is two slides.","The last slide carries the CTA.","Per-platform slide-count variants apply; see body_schema."]'::jsonb,
 '{"per_platform_slides":{"INSTAGRAM":{"min":5,"max":10},"LINKEDIN":{"min":5,"max":12},"TWITTER":{"min":3,"max":6}}}'::jsonb,
 '{plan,script,medical_review,edit,approve,publish,repurpose,measure}',
 '{"unit":"slides","min":3,"max":12}'::jsonb,
 false, true, true, false, 120,
 'General carousel: hook slide, one idea per slide, CTA last. Per-platform slide counts.'),

('static_graphic', 'Static graphic', 'card', 'SOCIAL_STATIC', '{FACEBOOK}', 'AM_FIRST', 'STATIC', 'C02_STATIC_GRAPHIC',
 '["Title","Theme","Headline (the entire hook)","Body, one or two sentences","Footer","Caption, short video","Caption, Facebook and Telegram","Caption, Twitter and X","Clinical note"]'::jsonb,
 '["One image. The headline is the entire hook and does the whole job alone.","Body is one or two sentences. If the idea cannot survive being that short, say the smaller true thing that can."]'::jsonb,
 '{}'::jsonb,
 '{plan,script,medical_review,edit,approve,publish,repurpose,measure}',
 '{"unit":"sentences","max":2}'::jsonb,
 false, true, true, false, 130,
 'One image; the headline does the whole job alone.'),

('myth_buster', 'Myth buster', 'card', 'SOCIAL_STATIC', '{INSTAGRAM,FACEBOOK}', 'AM_FIRST', 'CAROUSEL', 'C01_CAROUSEL',
 '["Title","Theme","Slide 1, the myth, named plainly","Slide 2, what is actually true","Slide 3, the approved claim it rests on","Final slide, the door","Caption, short video","Caption, Facebook and Telegram","Caption, Twitter and X","Clinical note"]'::jsonb,
 '["Names the myth, states what is actually true, cites the approved claim.","Draw the myth from real classified questions flagged is_myth, never from imagination.","Never repeat the myth as a bare headline without the correction on the same surface."]'::jsonb,
 '{"myth_source":"question_classifications.is_myth"}'::jsonb,
 '{plan,script,medical_review,edit,approve,publish,repurpose,measure}',
 '{"unit":"slides","min":3,"max":5}'::jsonb,
 false, true, true, false, 140,
 'Names a real myth from classified questions, corrects it, cites the claim.'),

('infographic', 'Infographic', 'card', 'SOCIAL_STATIC', '{INSTAGRAM,FACEBOOK}', 'AM_FIRST', 'STATIC', 'C02_STATIC_GRAPHIC',
 '["Title","Theme","Headline","The data or process, visualised","Source note","Caption, short video","Caption, Facebook and Telegram","Caption, Twitter and X","Clinical note"]'::jsonb,
 '["Data or a process, visualised.","Numbers only from approved claims. A number with no claim id does not exist.","Never invent a statistic or imply a source that was not supplied."]'::jsonb,
 '{}'::jsonb,
 '{plan,script,medical_review,edit,approve,publish,repurpose,measure}',
 '{"unit":"sentences","max":6}'::jsonb,
 false, true, true, false, 150,
 'Data or a process visualised; numbers only from approved claims.')
ON CONFLICT (code) DO NOTHING;

-- ===========================================================================
-- Surface C: text and long form
-- ===========================================================================
INSERT INTO content_formats
  (code, label, kind, surface, platforms, language_mode, body_kind, video_family,
   headings, rules, body_schema, stages_applicable, target_length,
   hedging_allowed, wants_captions, ends_at_door, is_internal, sort_order, description)
VALUES
('telegram_post', 'Telegram post', 'post', 'TEXT_LONGFORM', '{TELEGRAM}', 'AM_FIRST', 'POST', 'C03_TELEGRAM_POST',
 '["Title","Theme","First line, the hook","Short paragraphs","Closing line, the CTA and the door","Clinical note"]'::jsonb,
 '["Plain text to an audience that opted in. The first line is the hook.","Short paragraphs with line breaks, written to be read, not spoken.","CTA in the closing line, ending at the door."]'::jsonb,
 '{}'::jsonb,
 '{plan,script,medical_review,approve,publish,repurpose,measure}',
 '{"unit":"words","min":60,"max":250}'::jsonb,
 false, false, true, false, 210,
 'Plain text to the opted-in Telegram channel.'),

('blog', 'Blog', 'blog', 'TEXT_LONGFORM', '{WEBSITE}', 'AM_FIRST', 'ARTICLE', 'C03_TELEGRAM_POST',
 '["Title","Theme","Hook (Amharic)","Spoken keyword (english / አማርኛ)","Outline","Section 1","Section 2","Section 3","The door section","Teaser shot 1","Teaser shot 2","Caption, short video","Caption, Facebook and Telegram","Caption, Twitter and X","Clinical note"]'::jsonb,
 '["An outline, a hook, and two teaser shots. The door shot is appended.","Amharic first, English gloss second. Short declarative sentences."]'::jsonb,
 '{"teaser_shots":2}'::jsonb,
 '{plan,script,medical_review,edit,approve,publish,repurpose,measure}',
 '{"unit":"words","min":500,"max":1000}'::jsonb,
 false, true, true, false, 220,
 'Website blog: outline, hook, three sections, a door section, teaser shots, the caption set.'),

('library_explainer', 'Library explainer', 'blog', 'TEXT_LONGFORM', '{WEBSITE,APP}', 'AM_FIRST', 'ARTICLE', 'C03_TELEGRAM_POST',
 '["Title","Theme","Summary (Amharic first, two sentences)","Section: what it is","Section: how it works","Section: what is normal and what is not","Section: when to talk to a doctor","The door section","Related questions","Clinical note"]'::jsonb,
 '["The long-form reference piece. Complete enough that she does not need to search elsewhere, short enough to finish in five minutes.","Every section carries one job; the when-to-talk-to-a-doctor section is mandatory and concrete.","Amharic first, English gloss second. Short declarative sentences.","Ends at the door section with the canonical door."]'::jsonb,
 '{"required_sections":["when to talk to a doctor"]}'::jsonb,
 '{plan,script,medical_review,edit,approve,publish,repurpose,measure}',
 '{"unit":"words","min":600,"max":900}'::jsonb,
 false, false, true, false, 230,
 'Real long-form reference schema. Was schema-less in letenav2 and silently fell back to the 15-second clip schema; fixed here.'),

('x_thread', 'X thread', 'post', 'TEXT_LONGFORM', '{TWITTER}', 'AM_FIRST', 'POST', 'C03_TELEGRAM_POST',
 '["Title","Theme","Main post, the value","Self-reply, the door","Clinical note"]'::jsonb,
 '["Value in the main post, the door in a self-reply. Never put the door in the main post.","The main post must stand alone and teach on its own."]'::jsonb,
 '{"door_placement":"self_reply"}'::jsonb,
 '{plan,script,medical_review,approve,publish,repurpose,measure}',
 '{"unit":"characters","max":280}'::jsonb,
 false, false, true, false, 240,
 'Value in the main post, the door in a self-reply.'),

('linkedin_post', 'LinkedIn post', 'post', 'TEXT_LONGFORM', '{LINKEDIN}', 'EN_FIRST', 'POST', 'C03_TELEGRAM_POST',
 '["Title","Theme","Opening line","Body","Closing line","Clinical note"]'::jsonb,
 '["Professional and donor-facing register, not the patient voice.","Letena is a social enterprise. Never describe it as a nonprofit, NGO or charity.","No patient stories, no case details, ever."]'::jsonb,
 '{}'::jsonb,
 '{plan,script,medical_review,approve,publish,repurpose,measure}',
 '{"unit":"words","min":80,"max":300}'::jsonb,
 false, false, false, false, 250,
 'Professional and donor-facing register, not the patient voice.'),

('newsletter', 'Newsletter', 'email', 'TEXT_LONGFORM', '{EMAIL}', 'AM_FIRST', 'ARTICLE', 'C03_TELEGRAM_POST',
 '["Title","Theme","Subject line","The one story it leads with","Library links section","Closing and the door","Clinical note"]'::jsonb,
 '["Monthly. Leads with one story, links to library articles.","One story means one: the rest is links, not a second story.","Ends at the door."]'::jsonb,
 '{"cadence":"monthly"}'::jsonb,
 '{plan,script,medical_review,edit,approve,publish,repurpose,measure}',
 '{"unit":"words","min":150,"max":500}'::jsonb,
 false, false, true, false, 260,
 'Monthly email: one story, library links.')
ON CONFLICT (code) DO NOTHING;

-- ===========================================================================
-- Surface D: the Abeba app (content lands in Firestore document shapes)
-- ===========================================================================
INSERT INTO content_formats
  (code, label, kind, surface, platforms, language_mode, body_kind, video_family,
   headings, rules, body_schema, stages_applicable, target_length,
   hedging_allowed, wants_captions, ends_at_door, is_internal, sort_order, description)
VALUES
('library_article', 'Library article', 'article', 'ABEBA_APP', '{ABEBA}', 'PARALLEL', 'ARTICLE', 'C03_TELEGRAM_POST',
 '["Title (EN and AM, parallel originals)","Category","Intro, 1-2 sentences","Body sections","When to talk to a doctor","Related reads","Hero image concept (gradient illustration, never photography of real people)","Phase relevance"]'::jsonb,
 '["EN and AM are parallel originals, not translations. Write each as itself.","3 minute target, 5 minute cap.","Sections: intro (1-2 sentences), body, when to talk to a doctor, related reads.","Hero image is a gradient illustration concept, never photography of real people.","Categories: SRH 101, Your Cycle, Contraception, Fertility, Sex & Intimacy, Mental Health.","phase_relevance values come from menstrual, follicular, ovulation, luteal."]'::jsonb,
 '{"firestore":"blogs/{slug}","fields":["title_en","title_am","category","intro","sections","when_to_talk_to_a_doctor","related_reads","hero_concept","phase_relevance"],"categories":["SRH 101","Your Cycle","Contraception","Fertility","Sex & Intimacy","Mental Health"],"phase_relevance":["menstrual","follicular","ovulation","luteal"]}'::jsonb,
 '{plan,script,medical_review,edit,approve,publish,repurpose,measure}',
 '{"unit":"minutes","target":3,"max":5}'::jsonb,
 false, false, false, false, 310,
 'Abeba library article to blogs/{slug}. EN and AM parallel originals.'),

('faq', 'FAQ', 'faq', 'ABEBA_APP', '{ABEBA}', 'PARALLEL', 'MICROCOPY', 'C03_TELEGRAM_POST',
 '["Question (EN)","Question (AM)","Answer (EN)","Answer (AM)","Category","Emoji","Display order"]'::jsonb,
 '["question_en/am and answer_en/am are parallel originals, not translations.","Short, complete answers. One question per item.","The answer never diagnoses; it informs and points to Ask when care is the right next step."]'::jsonb,
 '{"firestore":"faqs/{id}","fields":["question_en","question_am","answer_en","answer_am","category","emoji","display_order","is_active"]}'::jsonb,
 '{plan,script,medical_review,approve,publish,measure}',
 '{"unit":"words","max":120}'::jsonb,
 false, false, false, false, 320,
 'Abeba FAQ entries to faqs/{id}.'),

('ask_sample_question', 'Ask sample question', 'micro', 'ABEBA_APP', '{ABEBA}', 'PARALLEL', 'MICROCOPY', 'C03_TELEGRAM_POST',
 '["Six tappable sample questions, first person"]'::jsonb,
 '["Six tappable cards. First person (My, I, me), casual not slangy, real worries.","Banned: clinical terms, textbook framing, anything that reads as judging her.","Derive these from real classified questions, never from imagination."]'::jsonb,
 '{"firestore":"ask_sample_questions/{id}","count":6,"person":"first"}'::jsonb,
 '{plan,script,medical_review,approve,publish,measure}',
 '{"unit":"characters","max":90}'::jsonb,
 false, false, false, false, 330,
 'Six first-person tappable sample questions for the Ask tab, from real classified questions.'),

('voices_seed_post', 'Voices seed post', 'micro', 'ABEBA_APP', '{ABEBA}', 'AM_FIRST', 'MICROCOPY', 'C03_TELEGRAM_POST',
 '["Post text (max 500 chars)","Tag","Avatar (flower emoji)"]'::jsonb,
 '["Max 500 characters, a tag, a flower emoji avatar.","Anonymous community feed seeds. Never a real story, never a testimonial, never implies a real user wrote it.","Warm, ordinary, and safe to sit beside real anonymous posts."]'::jsonb,
 '{"firestore":"voices_posts/{id}","max_chars":500}'::jsonb,
 '{plan,script,medical_review,approve,publish,measure}',
 '{"unit":"characters","max":500}'::jsonb,
 false, false, false, false, 340,
 'Anonymous community feed seed posts.'),

('daily_insight', 'Daily insight card', 'micro', 'ABEBA_APP', '{ABEBA}', 'PARALLEL', 'MICROCOPY', 'C03_TELEGRAM_POST',
 '["Four cards per cycle phase","Phase and tone note per card"]'::jsonb,
 '["Four cards per cycle phase.","Phase-matched tone: rose is nurturing, golden is energetic, lavender is restful.","Cycle statements use might and may: the uncertainty is factually true and stating it plainly would be false precision."]'::jsonb,
 '{"cards_per_phase":4,"phase_tones":{"rose":"nurturing","golden":"energetic","lavender":"restful"}}'::jsonb,
 '{plan,script,medical_review,approve,publish,measure}',
 '{"unit":"characters","max":220}'::jsonb,
 true, false, false, false, 350,
 'Today-scroll insight cards, four per cycle phase, phase-matched tone. Hedging allowed by design.'),

('push_notification', 'Push notification', 'push', 'ABEBA_APP', '{ABEBA}', 'PARALLEL', 'PUSH', 'C03_TELEGRAM_POST',
 '["Title (under 40 chars, no emoji)","Body (under 100 chars, one sentence)","Deep link (abeba://)"]'::jsonb,
 '["Title under 40 characters, no emoji in the title.","Body under 100 characters and one sentence. One abeba:// deep link.","Max 3 per user per week, max 1 per day, quiet hours 10pm-7am.","Use fertile window, not ovulation, for users avoiding pregnancy.","Might and may, never certainty: a prediction stated as fact is a lie some weeks.","Never guilt or scold."]'::jsonb,
 '{"title_max":40,"body_max":100,"deep_link_scheme":"abeba://","per_user":{"per_week":3,"per_day":1},"quiet_hours":"22:00-07:00"}'::jsonb,
 '{plan,script,medical_review,approve,publish,measure}',
 '{"unit":"characters","title_max":40,"body_max":100}'::jsonb,
 true, false, false, false, 360,
 'App push notification. Hedging required by design: cycle predictions are genuinely uncertain.'),

('app_copy', 'App copy string set', 'ui', 'ABEBA_APP', '{ABEBA}', 'PARALLEL', 'MICROCOPY', 'C03_TELEGRAM_POST',
 '["Key","EN string","AM string","Context","Tone","Length cap"]'::jsonb,
 '["Keys like onboarding.cycle_length.bubble_title.","Each string needs EN, AM, context, tone, and a length cap.","EN and AM are parallel originals, not translations.","UI copy never lectures and never assumes a goal (trying to conceive versus avoiding) unless the key context says so."]'::jsonb,
 '{"files":["en-US.json","am-ET.json"],"item_fields":["key","text_en","text_am","note"]}'::jsonb,
 '{plan,script,medical_review,approve,publish,measure}',
 '{"unit":"characters","max":120}'::jsonb,
 false, false, false, false, 370,
 'UI string sets for en-US.json / am-ET.json.'),

('while_you_wait', 'While you wait', 'micro', 'ABEBA_APP', '{ABEBA}', 'PARALLEL', 'MICROCOPY', 'C03_TELEGRAM_POST',
 '["Short reassuring filler cards for the Ask flow"]'::jsonb,
 '["Filler shown while a doctor reply is pending.","Reassures about the process (a doctor will reply, it is private), never pre-answers the medical question.","Never promises a reply time the service does not guarantee."]'::jsonb,
 '{"surface":"ask_pending"}'::jsonb,
 '{plan,script,medical_review,approve,publish,measure}',
 '{"unit":"characters","max":200}'::jsonb,
 false, false, false, false, 380,
 'Filler shown while a doctor reply is pending in Ask.'),

('doctor_reply_starter', 'Doctor reply starter', 'internal', 'ABEBA_APP', '{EMR}', 'PARALLEL', 'MICROCOPY', 'C03_TELEGRAM_POST',
 '["Opening phrases for doctor replies in the Ask flow"]'::jsonb,
 '["Internal, never published. Opening phrases Letena doctors use in the Ask flow.","Warm, private, and never diagnostic in the opening line. Doctors consult and refer.","Written by role: these are for whichever Letena doctor replies, never voiced as a named individual."]'::jsonb,
 '{"internal":true}'::jsonb,
 '{plan,script,medical_review,approve}',
 '{"unit":"characters","max":200}'::jsonb,
 false, false, false, true, 390,
 'Internal EMR reply starters. Never published; publish stages are not applicable.')
ON CONFLICT (code) DO NOTHING;

-- ===========================================================================
-- Surface E: programme and institutional
-- ===========================================================================
INSERT INTO content_formats
  (code, label, kind, surface, platforms, language_mode, body_kind, video_family,
   headings, rules, body_schema, stages_applicable, target_length,
   hedging_allowed, wants_captions, ends_at_door, is_internal, sort_order, description)
VALUES
('aua_clip', 'AUA clip', 'live', 'PROGRAMME', '{TIKTOK,FACEBOOK,YOUTUBE}', 'AM_FIRST', 'LIVE', 'C03_TELEGRAM_POST',
 '["Title","Theme","On-screen hook (Amharic)","Spoken keyword (english / አማርኛ)","Pre-live checklist","Segment 1","Segment 2","Segment 3","Segment 4","Segment 5","Segment 6","Pinned message (Amharic)","Pinned message (English gloss)","Cutdown brief 1","Cutdown brief 2","Cutdown brief 3","Cutdown brief 4","Caption, short video","Caption, Facebook and Telegram","Caption, Twitter and X","Clinical note"]'::jsonb,
 '["Run of show is six timed segments totaling about thirty minutes.","A pinned message and four cutdown briefs.","For the highest-sensitivity topics (abortion and options among them) use the anonymized format: eight to twelve reworded past questions, no ages, no neighborhoods, no workplaces, no identifying detail, clinically reviewed. A question that cannot be fully anonymized does not run."]'::jsonb,
 '{"segments":6,"cutdown_briefs":4,"anonymized_format":{"questions":{"min":8,"max":12},"strip":["ages","neighbourhoods","workplaces","identifying detail"]}}'::jsonb,
 '{plan,script,medical_review,shoot,edit,approve,publish,repurpose,measure}',
 '{"unit":"minutes","target":30}'::jsonb,
 false, true, true, false, 410,
 'Ask Us Anything live: run of show, pinned message, four cutdowns. Anonymized format for the highest-sensitivity topics.'),

('foundations_episode', 'Foundations episode', 'course', 'PROGRAMME', '{YOUTUBE,APP}', 'AM_FIRST', 'VIDEO', 'V01_QUESTION_EXPLAINER',
 '["Title","Theme","Episode number (of 15)","Learning goal","Episode script","Three short-form cut briefs","Facilitator guide outline","Clinical note"]'::jsonb,
 '["A 15-episode doctor-led course, Amharic and Afaan Oromo, 8-12 minutes per episode.","The on-camera doctor is a Letena doctor, written by role, never a named individual.","Each episode ships with three short-form cuts and a facilitator guide."]'::jsonb,
 '{"episodes":15,"languages":["AM","OM"],"per_episode":{"shortform_cuts":3,"facilitator_guide":true}}'::jsonb,
 '{plan,script,medical_review,shoot,edit,approve,publish,repurpose,measure}',
 '{"unit":"minutes","min":8,"max":12}'::jsonb,
 false, true, true, false, 420,
 'Doctor-led course episode, Amharic and Afaan Oromo, with cuts and a facilitator guide.'),

('cse_session', 'CSE session guide', 'guide', 'PROGRAMME', '{PRINT}', 'AM_FIRST', 'ARTICLE', 'C03_TELEGRAM_POST',
 '["Title","Audience (university or community)","Learning objectives","Session outline with timings","Activities","Facilitator notes","Materials list","Clinical note"]'::jsonb,
 '["University and community comprehensive sexuality education session: facilitator guide, activities, timings.","Written for the facilitator, not the participant: every activity carries its timing and its purpose.","Age-appropriate and setting-appropriate throughout."]'::jsonb,
 '{"components":["facilitator_guide","activities","timings"]}'::jsonb,
 '{plan,script,medical_review,edit,approve,publish,repurpose,measure}',
 '{"unit":"minutes","min":45,"max":120}'::jsonb,
 false, false, false, false, 430,
 'Facilitator guide for university and community CSE sessions.'),

('insight_brief', 'Behavioural insight brief', 'brief', 'PROGRAMME', '{EMAIL,PRINT}', 'EN_FIRST', 'ARTICLE', 'C03_TELEGRAM_POST',
 '["Title","Reporting quarter","Headline finding","What the data shows","What changed since last quarter","Implications","Method note","Clinical note"]'::jsonb,
 '["Quarterly MEL and donor deliverable, grounded in dashboard data and consultation patterns.","Evidence only, never estimated. A number with no source in the supplied data does not appear.","Patterns, never individuals: no case detail can ever be reconstructed from this document."]'::jsonb,
 '{"cadence":"quarterly","evidence":"dashboard data and consultation patterns only"}'::jsonb,
 '{plan,script,medical_review,edit,approve,publish,measure}',
 '{"unit":"words","min":400,"max":1200}'::jsonb,
 false, false, false, false, 440,
 'Quarterly MEL and donor brief. Evidence only, never estimated.'),

('radio_spot', 'Radio spot', 'audio', 'PROGRAMME', '{RADIO}', 'AM_FIRST', 'AUDIO', 'C03_TELEGRAM_POST',
 '["Title","Theme","Spot length (30 or 60 seconds)","Spoken script (Amharic)","Spoken script (English gloss)","VO close (canonical)","Clinical note"]'::jsonb,
 '["30 or 60 seconds, Amharic, audio only.","Written to be heard once with no visual: no lists, no numbers she has to hold in her head, the phone number spoken slowly and twice.","Ends at the spoken door (the VO close block)."]'::jsonb,
 '{"lengths_s":[30,60],"audio_only":true}'::jsonb,
 '{plan,script,medical_review,shoot,edit,approve,publish,repurpose,measure}',
 '{"unit":"seconds","options":[30,60]}'::jsonb,
 false, false, true, false, 450,
 'Radio spot, heard once, no visual. High reach in Ethiopia.'),

('poster', 'Poster', 'print', 'PROGRAMME', '{PRINT}', 'AM_FIRST', 'STATIC', 'C02_STATIC_GRAPHIC',
 '["Title","Theme","Headline (readable at distance)","Body, one or two lines","The door (WhatsApp number, large)","Clinical note"]'::jsonb,
 '["Clinic and campus print. Must work with no audio, no link, and at distance.","The headline is readable across a room; the door carries the number, not a QR-only path.","One message per poster."]'::jsonb,
 '{"placement":["clinic","campus"],"constraints":["no audio","no link","readable at distance"]}'::jsonb,
 '{plan,script,medical_review,edit,approve,publish,repurpose,measure}',
 '{"unit":"sentences","max":3}'::jsonb,
 false, false, true, false, 460,
 'Print poster for clinics and campuses. Works with no audio, no link, at distance.'),

('partner_onepager', 'Partner one-pager', 'doc', 'PROGRAMME', '{PRINT,EMAIL}', 'EN_FIRST', 'ARTICLE', 'C03_TELEGRAM_POST',
 '["Title","Who Letena is","What the service does","How referral works","What partners get","Contact","Clinical note"]'::jsonb,
 '["For partner clinics and universities. Institutional register.","Letena is a social enterprise. Never describe it as a nonprofit, NGO or charity.","Consultations inform and refer; never describe them as diagnostic."]'::jsonb,
 '{}'::jsonb,
 '{plan,script,medical_review,edit,approve,publish,measure}',
 '{"unit":"words","max":450}'::jsonb,
 false, false, false, false, 470,
 'Institutional one-pager for partner clinics and universities.')
ON CONFLICT (code) DO NOTHING;
