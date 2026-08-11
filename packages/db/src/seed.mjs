// Seed. Two layers, cleanly separated:
//   base   — roles/permissions/topics/segments already ship in migration 0001.
//            This file adds: users, video templates, platform accounts (mock),
//            ai_prompts, and the 20 pilot knowledge cards as DRAFT shells with
//            no claims. Nothing medical is marked approved.
//   demo   — LCOS_DEMO=1 additionally creates a DEMO medical source, DEMO
//            claims and approves two pilot cards UNDER A DEMO CLINICIAN so the
//            end-to-end flow can run. Every demo medical row carries the
//            literal marker "DEMO DATA — not clinically approved for
//            production" in its notes, and the demo source org is
//            "Letena DEMO fixtures (not a medical authority)".
import bcrypt from 'bcryptjs';
import { pool, q, one } from './pool.mjs';

const DEMO = process.env.LCOS_DEMO === '1';
const DEMO_MARK = 'DEMO DATA — not clinically approved for production';

const USERS = [
  ['admin@letena.local', 'Admin (Nate)', 'admin'],
  ['meddir@letena.local', 'Demo Medical Director', 'medical_director'],
  ['doctor@letena.local', 'Demo Consulting Doctor', 'consulting_doctor'],
  ['content@letena.local', 'Demo Content Lead', 'content_lead'],
  ['language@letena.local', 'Demo Language Editor', 'language_editor'],
  ['intake@letena.local', 'Demo Intake Coordinator', 'intake_coordinator'],
  ['social@letena.local', 'Demo Social Lead', 'social_lead'],
  ['producer@letena.local', 'Demo Producer', 'producer'],
  ['dev@letena.local', 'Demo Developer', 'developer'],
];
const DEFAULT_PASSWORD = 'letena-dev-2026';

const PILOT_CARDS = [
  ['EC-001', 'EC', 'What is emergency contraception?', 'TIER_3'],
  ['EC-002', 'EC', 'How soon should emergency contraception be taken?', 'TIER_3'],
  ['EC-003', 'EC', 'Does emergency contraception cause abortion?', 'TIER_3'],
  ['EC-004', 'EC', 'Can emergency contraception cause infertility?', 'TIER_3'],
  ['EC-005', 'EC', 'Can emergency contraception be used more than once?', 'TIER_3'],
  ['CON-001', 'CON', 'How do condoms prevent pregnancy?', 'TIER_2'],
  ['CON-004', 'CON', 'What should someone do if a condom breaks?', 'TIER_3'],
  ['CON-008', 'CON', 'Does the pill cause infertility?', 'TIER_2'],
  ['CON-011', 'CON', 'Can the implant change bleeding patterns?', 'TIER_3'],
  ['CON-012', 'CON', 'Does an implant cause infertility?', 'TIER_2'],
  ['PREG-002', 'PREG', 'How soon can a pregnancy test work?', 'TIER_3'],
  ['PREG-003', 'PREG', 'Why can a pregnancy test be negative when a period is late?', 'TIER_3'],
  ['PREG-006', 'PREG', 'Can pregnancy happen during menstruation?', 'TIER_2'],
  ['PREG-008', 'PREG', 'Can withdrawal reliably prevent pregnancy?', 'TIER_2'],
  ['MEN-002', 'MEN', 'Why can a period be late?', 'TIER_2'],
  ['MEN-005', 'MEN', 'When can pregnancy occur during the menstrual cycle?', 'TIER_2'],
  ['STI-002', 'STI', 'Can someone have an STI without symptoms?', 'TIER_3'],
  ['STI-004', 'STI', 'How can STI risk be reduced?', 'TIER_3'],
  ['HIV-002', 'HIV', 'How is HIV not transmitted?', 'TIER_3'],
  ['HIV-006', 'HIV', 'What is the HIV testing window period?', 'TIER_3'],
];

const TEMPLATES = [
  ['LETENA_QA_30S_V1', 'Question explainer 30s', 'CREATOMATE', 'V01_QUESTION_EXPLAINER', 15, 45, 3],
  ['LETENA_CHAT_35S_V1', 'Chat story 35s', 'CREATOMATE', 'V02_CHAT_STORY', 20, 50, 4],
  ['LETENA_STORY_40S_V1', 'Illustrated scenario 40s', 'CREATOMATE', 'V03_ILLUSTRATED_SCENARIO', 25, 55, 5],
  ['LETENA_MEDVIS_45S_V1', 'Medical visual explainer 45s', 'CREATOMATE', 'V04_MEDICAL_VISUAL_EXPLAINER', 30, 60, 4],
  ['LETENA_PRESENTER_V1', 'Digital presenter', 'HEYGEN', 'V05_DIGITAL_PRESENTER', 20, 90, 1],
  ['LETENA_BROLL_30S_V1', 'Real Ethiopia hybrid 30s', 'CREATOMATE', 'V06_REAL_ETHIOPIA_HYBRID', 20, 45, 4],
];
const TEMPLATE_VARS = [
  ['Question_Text', 'TEXT', true, 90, 'script.hook'],
  ['Answer_Text', 'TEXT', true, 120, 'script.onscreen_text[0]'],
  ['Voiceover', 'AUDIO', false, null, 'voice.asset'],
  ['Subtitle_Track', 'TEXT', false, null, 'script.srt'],
  ['CTA_Text', 'TEXT', true, 200, 'script.cta'],
  ['Scene_1', 'ASSET', false, null, 'asset_plan[0]'],
  ['Scene_2', 'ASSET', false, null, 'asset_plan[1]'],
  ['Scene_3', 'ASSET', false, null, 'asset_plan[2]'],
];

// Production stack note (Ethiopian tooling the team already uses):
//   CREATOMATE  template video render          HEYGEN     presenter avatar
//   KLING       generative b-roll (img/txt→video, never anatomy)
//   ELEVENLABS  AI voice (Amharic, tiers 1-2 only, post listening test)
//   GEMINI      image generation for scenario stills
//   CANVA       carousels and static graphics (C01/C02)
const PLATFORM_ACCOUNTS = [
  ['TELEGRAM', 'letena_ethiopia', 'env:TELEGRAM_BOT_TOKEN', true],
  ['TIKTOK', 'letena.ethiopia', 'env:TIKTOK_ACCESS_TOKEN', false],
  ['INSTAGRAM', 'letena.ethiopia', 'env:META_IG_TOKEN', true],
  ['FACEBOOK', 'LetenaEthiopia', 'env:META_PAGE_TOKEN', true],
  ['YOUTUBE', 'LetenaEthiopia', 'env:YOUTUBE_OAUTH', true],
];

const PROMPTS = [
  ['question_classifier', 'QUESTION_CLASSIFIER',
   `You classify anonymized SRH questions from Ethiopian users (Amharic/English/mixed) for editorial and clinical planning. You never answer the person. Choose topic_code only from the supplied topic list; knowledge_card_code only from the supplied approved cards; null when no genuine match (a weak match hides a knowledge gap). EMR_CATEGORY_HINTS, when present, are prior classifications from Letena's clinical intake system: prefer agreeing with them unless the text clearly contradicts them. Record the underlying fear when it differs from the literal question. Do not diagnose. Return JSON only.`],
  ['creative_director', 'CREATIVE_DIRECTOR',
   `You are the Creative Director for Letena, an Ethiopian SRH education platform. From the APPROVED_KNOWLEDGE_CARD, APPROVED_CLAIMS, AUDIENCE_PROFILE and REAL_QUESTION_PATTERNS, generate distinct short-form concepts. Every implied medical fact must trace to a claim id in APPROVED_CLAIMS; list them per concept. Never use prohibited_claims in any wording, never invent statistics or testimonials, never imply a presenter is a doctor, never shame. If a concept needs a fact not in APPROVED_CLAIMS, set needs_knowledge instead of making it. Hooks must work spoken in Amharic in 2 seconds. Return JSON only.`],
  ['script_writer', 'SCRIPT_WRITER',
   `You write short-form SRH scripts for Ethiopian audiences. APPROVED_CLAIMS is the complete universe of medical fact available: do not add, extend, soften, strengthen or generalise a claim; no numbers, timeframes, doses, brands, side effects or warning signs absent from claims. Map every medically meaningful statement to exactly one claim id in claim_map. If the concept requires a missing fact, return result NEEDS_KNOWLEDGE naming it precisely; that is correct behaviour. Answer the question in the first 5 seconds; short spoken sentences that survive Amharic; use only supplied approved CTAs; end on one action. Return JSON only.`],
  ['claim_validator', 'CLAIM_VALIDATOR',
   `You validate whether each medically meaningful statement in a script is supported by a closed set of APPROVED_CLAIMS. You must not use outside medical knowledge: a true statement unsupported by the supplied claims is UNSUPPORTED. Verdicts: SUPPORTED, PARTIALLY_SUPPORTED, UNSUPPORTED, CONTRADICTED, AMBIGUOUS. Check specifically: missing safety context, missing referral (blocker at tier 4), overstatement, certainty inflation, causal overreach, numbers or time windows altered, negation errors, meaning lost in simplification, CTA contradiction, fabricated statistics/testimonials, implied credentials, prohibited claims (always blocker). FAIL when any statement is UNSUPPORTED/CONTRADICTED/AMBIGUOUS or any finding is BLOCKER. Be strict: a false PASS misinforms a young person; a false FAIL costs a rewrite. Return JSON only.`],
  ['amharic_localizer', 'AMHARIC_LOCALIZER',
   `You write natural spoken Amharic for Letena SRH videos: writing, not word-by-word translation. Preserve exactly: certainty and hedges, negation, time periods in the same unit, quantities, risk levels, complete referral conditions. Use APPROVED_TERMINOLOGY; never use avoid-listed wording; record new terms with is_new=true. Spoken register, short sentences, never shaming. Return HUMAN_LANGUAGE_REVIEW when a medical meaning cannot be expressed unambiguously or a term is uncertain. Return JSON only.`],
  ['back_translator', 'BACK_TRANSLATOR',
   `Translate the Amharic into plain English. You do not have the original and must not guess it: render exactly what the Amharic says including vagueness, absoluteness or awkwardness. Flag ambiguities with both readings. A smoothed, improved English defeats the purpose. Return JSON only.`],
  ['language_qa', 'LANGUAGE_QA',
   `Assess Amharic SRH copy for young Ethiopians: naturalness 1-5 (spoken register), register fit, meaning preservation (compare back-translation to English for every claim-mapped statement: certainty, negation, quantities, time periods, severity, referral conditions), terminology compliance, comprehension for a 19-year-old, ambiguity where one reading is medically wrong. Targeted corrections only. Return JSON only.`],
  ['deid_sweep', 'QUESTION_DEIDENTIFIER',
   `Locate text spans that could identify a real person in Amharic/English text: PERSON, PHONE, HANDLE, EMAIL, ADDRESS, PLACE_FINE (not city names), ID, DATE_FINE, RELATION, OTHER. Return spans by character offset only; never rewrite text; over-report when uncertain. Age, gender, marital status, city are not identifying. Return JSON only.`],
  ['cluster_labeller', 'QUESTION_CLUSTER_ASSISTANT',
   `Name a cluster of semantically similar SRH questions. Return a short English label, an Amharic label, and pick the most representative question verbatim from the supplied list. Return JSON only.`],
  ['editorial_analyst', 'PERFORMANCE_ANALYST',
   `You write Letena's weekly editorial recommendation from performance data, the coverage board and open knowledge gaps. Under 10 comparable pieces is not a pattern; say so. Reach without education or service value is not success. Every recommendation must be executable with currently approved cards or must name the missing card. Never invent metrics not supplied. Return JSON only.`],
  ['asset_prompt_writer', 'ASSET_PROMPT_WRITER',
   `Write image/video generation prompts for Ethiopian SRH education b-roll. Hard limits: no anatomy, no medical illustration, no recognisable real people, no minors in sexual-health contexts, no readable text in image, no clinical procedures, no distress. Specific ordinary Ethiopian settings: Addis streets, shared taxis, campus corridors, cafés, phones in hands. Refuse with a reason when the brief asks for prohibited content. Return JSON only.`],
  ['content_recommender', 'CONTENT_RECOMMENDER',
   `Given coverage gaps and demand clusters, propose the next content commissions: knowledge card, segment, format, rationale. Only reference approved cards; name missing knowledge explicitly as blocked_by KNOWLEDGE_CARD. Return JSON only.`],
];

async function main() {
  const hash = bcrypt.hashSync(DEFAULT_PASSWORD, 10);
  const roleRows = (await q('SELECT id, slug FROM lcos.roles')).rows;
  const roleId = Object.fromEntries(roleRows.map(r => [r.slug, r.id]));

  for (const [email, name, role] of USERS) {
    const u = await one(
      `INSERT INTO lcos.users (email, full_name, password_hash)
       VALUES ($1,$2,$3) ON CONFLICT ((lower(email))) DO UPDATE SET full_name=EXCLUDED.full_name
       RETURNING id`, [email, name, hash]);
    await q(`INSERT INTO lcos.user_roles (user_id, role_id) VALUES ($1,$2)
             ON CONFLICT DO NOTHING`, [u.id, roleId[role]]);
  }
  const admin = await one(`SELECT id FROM lcos.users WHERE email='admin@letena.local'`);

  for (const [code, topic, question, tier] of PILOT_CARDS) {
    await q(`INSERT INTO lcos.knowledge_cards (code, topic_id, canonical_question_en, status, risk_tier, created_by)
             SELECT $1, t.id, $2, 'DRAFT', $3::lcos.risk_tier, $4 FROM lcos.topics t WHERE t.code=$5
             ON CONFLICT (code) DO NOTHING`, [code, question, tier, admin.id, topic]);
  }

  for (const [code, name, engine, family, minD, maxD, scenes] of TEMPLATES) {
    const t = await one(
      `INSERT INTO lcos.video_templates (code, name, engine, video_family, min_duration_s, max_duration_s, scene_count, status)
       VALUES ($1,$2,$3::lcos.render_engine,$4::lcos.video_family,$5,$6,$7,'APPROVED')
       ON CONFLICT (code, version) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
      [code, name, engine, family, minD, maxD, scenes]);
    for (let i = 0; i < TEMPLATE_VARS.length; i++) {
      const [vn, dt, req, maxLen, maps] = TEMPLATE_VARS[i];
      await q(`INSERT INTO lcos.template_variables (template_id, name, data_type, is_required, max_length, maps_to, sort_order)
               VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (template_id, name) DO NOTHING`,
        [t.id, vn, dt, req, maxLen, maps, (i + 1) * 10]);
    }
  }

  for (const [platform, handle, credRef, direct] of PLATFORM_ACCOUNTS) {
    await q(`INSERT INTO lcos.platform_accounts (platform, handle, credential_ref, supports_direct_publish, is_primary)
             VALUES ($1::lcos.publish_platform,$2,$3,$4,true) ON CONFLICT (platform, handle) DO NOTHING`,
      [platform, handle, credRef, direct]);
  }

  for (const [key, agent, system] of PROMPTS) {
    await q(`INSERT INTO lcos.ai_prompts (prompt_key, version, agent_name, system_prompt, user_template, output_schema, default_model, is_active)
             VALUES ($1,'1.0.0',$2,$3,'{{context_json}}','{}','configured', true)
             ON CONFLICT (prompt_key, version) DO NOTHING`, [key, agent, system]);
  }

  if (DEMO) await seedDemo(admin.id);
  console.log(`seed complete${DEMO ? ' (with DEMO medical fixtures)' : ''}`);
  await pool.end();
}

async function seedDemo(adminId) {
  const demoClin = await one(
    `INSERT INTO lcos.users (email, full_name, password_hash)
     VALUES ('demo-clinician@letena.local','DEMO Clinician (fixture, not a real approval)',
             '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva')
     ON CONFLICT ((lower(email))) DO UPDATE SET full_name=EXCLUDED.full_name RETURNING id`);
  await q(`INSERT INTO lcos.user_roles (user_id, role_id)
           SELECT $1, id FROM lcos.roles WHERE slug='medical_director' ON CONFLICT DO NOTHING`, [demoClin.id]);

  const src = await one(
    `INSERT INTO lcos.medical_sources (code, organisation, title, source_type, precedence, version, status, notes, added_by)
     VALUES ('DEMO-SRC-001','Letena DEMO fixtures (not a medical authority)','Demo source for development',
             'INTERNAL_PROTOCOL', 10, 'demo', 'ACTIVE', $1, $2)
     ON CONFLICT (code) DO UPDATE SET notes=EXCLUDED.notes RETURNING id`, [DEMO_MARK, adminId]);

  const CLAIMS = [
    ['DEMO-EC-CLAIM-0041', 'EC', 'Emergency contraceptive pills work mainly by delaying or preventing ovulation.', 'FACT'],
    ['DEMO-EC-CLAIM-0042', 'EC', 'Emergency contraceptive pills do not terminate an established pregnancy.', 'MYTH_CORRECTION'],
    ['DEMO-EC-CLAIM-0047', 'EC', 'Using emergency contraceptive pills, including more than once, does not cause long-term infertility.', 'MYTH_CORRECTION'],
    ['DEMO-EC-CLAIM-0048', 'EC', 'Emergency contraceptive pills are less effective than regular contraceptive methods used consistently.', 'FACT'],
    ['DEMO-EC-CLAIM-0049', 'EC', 'A person who repeatedly needs emergency contraception should talk with a health provider about starting a regular method.', 'REFERRAL_TRIGGER'],
  ];
  const claimIds = {};
  for (const [code, topic, text, type] of CLAIMS) {
    const c = await one(
      `INSERT INTO lcos.medical_claims (code, topic_id, claim_text_en, claim_type, certainty, risk_tier, status,
                                        reviewed_by, reviewed_at, review_due_at, notes, created_by)
       SELECT $1, t.id, $2, $3, 'ESTABLISHED', 'TIER_3', 'APPROVED', $4, now(), CURRENT_DATE + 365, $5, $4
       FROM lcos.topics t WHERE t.code=$6
       ON CONFLICT (code) DO UPDATE SET notes=EXCLUDED.notes RETURNING id`,
      [code, text, type, demoClin.id, DEMO_MARK, topic]);
    claimIds[code] = c.id;
    await q(`INSERT INTO lcos.claim_sources (claim_id, source_id, locator, is_primary)
             VALUES ($1,$2,'demo fixture',true) ON CONFLICT DO NOTHING`, [c.id, src.id]);
  }

  // Approve EC-004 and EC-005 under the demo clinician so the e2e flow runs.
  for (const [cardCode, answer] of [
    ['EC-004', 'No. Emergency contraceptive pills do not cause long-term infertility, even when used more than once. They work mainly by delaying ovulation. Someone who needs them often should talk with a health provider about a regular method.'],
    ['EC-005', 'Yes, emergency contraceptive pills can be used more than once, and doing so does not cause long-term harm to fertility. They are less effective than regular methods used consistently, so repeated need is a good reason to talk with a provider about a regular method.'],
  ]) {
    const card = await one(`SELECT id FROM lcos.knowledge_cards WHERE code=$1`, [cardCode]);
    const v = await one(
      `INSERT INTO lcos.knowledge_card_versions (card_id, version, canonical_answer_en, prohibited_claims, approved_ctas, content_sha256, created_by)
       VALUES ($1, 1, $2,
         '["Any statement giving a dose, brand instruction or number of tablets","Any statement that EC ends or harms a pregnancy","Any statement that repeated EC use damages fertility"]'::jsonb,
         '["Message Letena on Telegram to talk to a doctor privately. It is free.","Save this so you have it when you need it."]'::jsonb,
         md5($2), $3)
       ON CONFLICT (card_id, version) DO UPDATE SET canonical_answer_en=EXCLUDED.canonical_answer_en RETURNING id`,
      [card.id, `[${DEMO_MARK}] ${answer}`, demoClin.id]);
    for (const code of Object.keys(claimIds)) {
      await q(`INSERT INTO lcos.knowledge_card_claims (card_id, claim_id, is_core)
               VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [card.id, claimIds[code], code !== 'DEMO-EC-CLAIM-0048']);
    }
    await q(`UPDATE lcos.knowledge_cards
             SET current_version_id=$2, approved_version_id=$2, status='APPROVED',
                 reviewed_by=$3, reviewed_at=now(), review_due_at=CURRENT_DATE+180
             WHERE id=$1`, [card.id, v.id, demoClin.id]);
  }
  console.log('demo medical fixtures seeded (EC-004, EC-005 approved by DEMO clinician)');
}

main().catch(e => { console.error(e); process.exit(1); });
