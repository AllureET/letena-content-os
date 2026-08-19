// AI provider abstraction. generateStructured(), embed(). Providers: MOCK
// (deterministic, runs the whole system with no credentials) or ANTHROPIC.
// Selection: env LCOS_AI_PROVIDER or per-agent override. OpenAI support was
// removed 14 Aug 2026 (Nate: "I dont have openai at all") -- the org has no
// OpenAI key and never will; ANTHROPIC is the only real, paid provider now.
import { trigramContainment } from '../../../../packages/scoring/src/index.mjs';
import { cred } from '../creds.mjs';

export function getProvider(name = cred('LCOS_AI_PROVIDER') || 'MOCK') {
  const n = name.toUpperCase();
  if (n === 'ANTHROPIC') return new AnthropicProvider();
  return new MockAIProvider();
}

// ---------- embeddings ----------
// MOCK embedding: character-trigram feature hashing into 1536 dims, L2
// normalized. Similar texts get similar vectors, so pgvector search, dedup
// and clustering genuinely work in demo mode.
export function mockEmbed(text) {
  const dim = 1536;
  const v = new Float32Array(dim);
  const t = text.toLowerCase().replace(/\s+/g, ' ');
  for (let i = 0; i < t.length - 2; i++) {
    const g = t.slice(i, i + 3);
    let h = 2166136261;
    for (let j = 0; j < 3; j++) { h ^= g.charCodeAt(j); h = Math.imul(h, 16777619); }
    v[Math.abs(h) % dim] += 1;
  }
  let norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return Array.from(v, x => Math.round((x / norm) * 1e6) / 1e6);
}

class BaseProvider {
  async embed(text) { return mockEmbed(text); }
}

// ---------- MOCK ----------
// Deterministic per-agent behaviour good enough to exercise every guard.
// The mock claim validator does REAL containment checking, so governance
// tests are meaningful without a live model.
export class MockAIProvider extends BaseProvider {
  name = 'MOCK'; model = 'mock-1';

  async generateStructured({ agent, context }) {
    const fn = this[`agent_${agent}`];
    if (!fn) throw new Error(`MockAIProvider has no agent ${agent}`);
    const output = fn.call(this, context);
    return { output, usage: { input_tokens: 200, output_tokens: 300, cost_usd: 0 } };
  }

  agent_question_classifier(ctx) {
    const text = (ctx.question_text || '').toLowerCase();
    const topics = ctx.topics || [];
    const hints = ctx.emr_category_hints || [];
    const kw = [
      ['EC', /postpill|post pill|emergency|ፖስትፒል|morning after|72/],
      ['CON', /condom|implant|pill|iud|injection|ኮንዶም|መከላከያ/],
      ['PREG', /pregnan|test|late period|እርግዝና|ጽንስ/],
      ['MEN', /period|cycle|bleed|የወር አበባ/],
      ['HIV', /\bhiv\b|ኤች አይ ቪ|prep|pep/],
      ['STI', /sti|std|infection|discharge|በሽታ/],
    ];
    let topic = kw.find(([, re]) => re.test(text))?.[0] ?? null;
    if (!topic && hints.length && ctx.hint_topic_map) topic = ctx.hint_topic_map[hints[0]] ?? null;
    if (topic && !topics.some(t => t.code === topic)) topic = null;
    const fertilityFear = /children|infertil|fertil|womb|መውለድ|ማህፀን/.test(text);
    const repeatEC = /(twice|again|many times|repeat|ሁለት ጊዜ|ደጋግ)/.test(text) && topic === 'EC';
    let card = null, conf = 0;
    for (const c of ctx.cards || []) {
      const sim = trigramContainment(text.slice(0, 120), c.canonical_question_en.toLowerCase());
      let s = sim;
      if (repeatEC && fertilityFear && c.code === 'EC-004') s = 0.92;
      else if (repeatEC && c.code === 'EC-005') s = Math.max(s, 0.85);
      if (s > conf) { conf = s; card = c.code; }
    }
    if (conf < 0.35) { card = null; conf = 0; }
    return {
      // is_genuine_question became required in migration 0010, but this mock
      // was never taught about it, which broke every MOCK classification
      // (and everything downstream of one) the moment 0010 applied. Found
      // 14 Aug 2026 while re-running the suite against a fresh database for
      // the Run One build. The mock's fixtures are all real questions, so
      // true is the honest deterministic answer.
      is_genuine_question: true,
      topic_code: topic, subtopic: repeatEC ? 'repeat EC use' : null,
      intent: fertilityFear ? 'REASSURANCE_SEEKING' : 'FACT_SEEKING',
      is_myth: fertilityFear && topic === 'EC',
      myth_text: fertilityFear && topic === 'EC' ? 'Repeated EC use causes infertility' : null,
      fear_expressed: fertilityFear ? 'fear of infertility' : null,
      urgency: ctx.urgency_hint === 'urgent' ? 'HIGH' : 'LOW',
      clinical_risk: ctx.urgency_hint === 'urgent' ? 'HIGH' : 'LOW',
      audience_segment_slug: 'unmarried_urban_women_18_24',
      knowledge_card_code: card, match_confidence: Math.round(conf * 100) / 100,
      content_value: card ? 5 : 3,
      content_opportunity: card ? 'High-anxiety myth with an approved answer available' : null,
      referral_relevant: false,
      language: /[ሀ-፿]/.test(ctx.question_text || '') ? 'AM' : 'EN',
      is_code_mixed: /[ሀ-፿]/.test(ctx.question_text || '') && /[a-z]/i.test(ctx.question_text || ''),
      sentiment: fertilityFear ? 'ANXIOUS' : 'CURIOUS',
    };
  }

  agent_deid_sweep() { return { spans: [], residual_risk: 'NONE', notes: '' }; }

  // Deterministic translation stand-in so translation flows are testable
  // offline: prefix + first 120 chars of the source, verbatim.
  agent_question_translator(ctx) {
    return { translation_en: 'EN: ' + String(ctx.text ?? '').slice(0, 120) };
  }

  agent_cluster_labeller(ctx) {
    const first = ctx.questions?.[0] ?? 'Questions';
    return { label_en: (ctx.topic_name ? `${ctx.topic_name}: ` : '') + first.slice(0, 60),
      label_am: null, representative_question: first };
  }

  agent_creative_director(ctx) {
    const claimIds = (ctx.claims || []).map(c => c.id);
    const q = ctx.representative_question || ctx.card?.canonical_question_en || '';
    return { concepts: [
      { title: `Direct answer: ${ctx.card?.code}`, video_family: 'V01_QUESTION_EXPLAINER',
        hook_line: q.slice(0, 100) || 'The question everyone asks quietly',
        premise: 'Answer the exact question in the first two seconds, then the one action.',
        treatment: 'Typography-led vertical explainer. Hook question on screen, direct answer card, two supporting beats from core claims, CTA end card.',
        perspective: 'second person', characters: [],
        claim_ids_referenced: claimIds, target_duration_s: 30,
        target_platforms: ['TIKTOK', 'INSTAGRAM', 'TELEGRAM'],
        cta_intent: 'private telegram consult',
        why_this_works: 'The viewer is anxious and alone; speed and privacy beat production value.',
        needs_knowledge: null },
      { title: `Chat story: the worried friend`, video_family: 'V02_CHAT_STORY',
        hook_line: 'She texted at midnight: did I ruin my chances?',
        premise: 'A fictional chat between a worried user and Letena, resolving the fear.',
        treatment: 'WhatsApp-style bubbles animate in. Three worried messages, then the calm factual answer using core claims verbatim, CTA bubble.',
        perspective: 'fictional dialogue',
        characters: [{ name: 'Mimi', age: 22, context: 'university student, Addis Ababa', is_fictional: true }],
        claim_ids_referenced: claimIds, target_duration_s: 35,
        target_platforms: ['TIKTOK', 'INSTAGRAM'],
        cta_intent: 'private telegram consult',
        why_this_works: 'Fictional peer voice removes shame; the format signals privacy.',
        needs_knowledge: null },
    ] };
  }

  // Format-aware mock writer (Run One, 14 Aug 2026). The mock fills the body
  // the requested format actually needs, the same contract the real writer
  // prompt (script_writer 1.3.0) and the zod superRefine enforce, so tests
  // exercise every registry body kind with zero credentials. Claim
  // statements reuse the claim text so the mock claim_validator's real
  // containment check passes. __seed_unsupported plants an unsupported
  // statement INSIDE the format's own body (a slide, a section, a push
  // body), which is exactly the near-miss this system exists to catch: a
  // claim in a non-video body must be validated as hard as a spoken one.
  agent_script_writer(ctx) {
    const claims = ctx.claims || [];
    if (!claims.length) {
      return { result: 'NEEDS_KNOWLEDGE', needs_knowledge: {
        missing_facts: [{ fact_needed: 'Any approved claim on this topic', why: 'Claim set is empty' }],
        blocking_reason: 'No approved claims supplied' } };
    }
    const format = ctx.format ?? 'VIDEO';
    const cta = ctx.card?.approved_ctas?.[0] ?? 'Message Letena on Telegram.';
    const s1 = claims[0].claim_text_en;
    const s2 = claims[1]?.claim_text_en ?? s1;
    const hook = ctx.hook_line ?? 'You asked. Here is the answer.';
    const BAD = 'It is 99% effective for everyone.';
    const seeded = !!ctx.__seed_unsupported;
    const locations = { VIDEO: 'SPOKEN', AUDIO: 'SPOKEN', CAROUSEL: 'SLIDE', STATIC: 'ONSCREEN',
      POST: 'POST', ARTICLE: 'SECTION', MICROCOPY: 'ITEM', PUSH: 'FIELD', LIVE: 'SEGMENT' };
    const loc = locations[format] ?? 'SPOKEN';
    const claimMap = [
      ...(seeded ? [{ statement: BAD, claim_id: claims[0].id, location: loc }] : []),
      { statement: s1, claim_id: claims[0].id, location: loc },
      ...(claims[1] ? [{ statement: s2, claim_id: claims[1].id, location: loc }] : []),
    ];
    // Captions keyed by platform (14 Aug 2026 corrections): one caption per
    // platform in the format's platforms array, like the real writer.
    const capPlatforms = ctx.format_spec?.platforms?.length ? ctx.format_spec.platforms : ['TIKTOK'];
    const captions = ctx.format_spec?.wants_captions
      ? Object.fromEntries(capPlatforms.map((pl) => [pl,
          pl === 'TWITTER' ? hook.slice(0, 100) : `${hook.slice(0, 60)} | Letena ${cta}`.slice(0, 500)]))
      : null;
    // Format-specific extra body fields (14 Aug 2026 corrections), keyed on
    // the registry format code, mirroring what requireFormatBody() demands:
    // the quiz giveaway (digit-free so the NUMBER_ALTERED overlay stays
    // quiet), the Ask Dr Letena reworded question, the recap's four
    // cutdowns, and the whiteboard structure.
    const fcode = ctx.format_spec?.code ?? null;
    const extraBody = {};
    if (fcode === 'ask_dr_letena') {
      extraBody.question_quoted = 'A reworded question from real patient traffic, with every identifying detail removed.';
    }
    if (fcode === 'quiz_reel' || fcode === 'quiz_carousel') {
      extraBody.quiz = { question: hook.slice(0, 280), answer: s1.slice(0, 380), explanation: s2.slice(0, 580) };
      extraBody.giveaway = { how_to_enter: 'Follow Letena and answer the quiz in the comments.',
        deadline: 'Sunday evening', winner_selection: 'A random pick from the correct answers.' };
    }
    if (fcode === 'aua_recap') {
      extraBody.cutdown_briefs = ['The core answer, twenty seconds', 'The myth corrected',
        'The best reworded question', 'The door'];
    }
    if (fcode === 'whiteboard_explainer') {
      extraBody.whiteboard = {
        character_brief: 'Stylized animated presenter beside a whiteboard, pointer stick, warm approachable features, vertical composition.',
        board_style_brief: 'Colorized board style reference: same content and layout, rendered in the animation style.',
        board_map: [
          { element: 'The question', column: 'left', icon: 'question mark' },
          { element: 'The fact', column: 'left', icon: 'check mark' },
          { element: 'The door', column: 'left', icon: 'phone' },
        ],
        clips: [
          { index: 1, dialogue: hook.slice(0, 1100), last_frame_anchor: 'Board shows only the question, stick resting at its underline, rest blank.',
            beats: [{ at_s: 0, appears: 'the question', speech: hook.slice(0, 380) }] },
          { index: 2, dialogue: s1.slice(0, 1100), last_frame_anchor: 'Board shows the question and the fact, unchanged elsewhere, stick at the fact.',
            beats: [{ at_s: 1, appears: 'the fact', speech: s1.slice(0, 380) }] },
          { index: 3, dialogue: cta.slice(0, 1100), last_frame_anchor: 'Board complete: question, fact and the door line, stick resting near the door line.',
            beats: [{ at_s: 1, appears: 'the door', speech: cta.slice(0, 380) }] },
        ],
        pronunciation_notes: ['Every stay-English clinical term is spoken as written in English.'],
      };
    }
    const base = { format, hook, cta, hashtags: ['letena', 'health'],
      platform_variants: {}, estimated_duration_s: 0, claim_map: claimMap, captions,
      caption: `${hook.slice(0, 80)} | Letena` };

    if (format === 'CAROUSEL') {
      return { result: 'OK', script: { ...base, body: extraBody, carousel_slides: [
        { index: 1, title: hook.slice(0, 80), body: 'Save this for when you need it.' },
        { index: 2, title: 'The fact', body: seeded ? BAD : s1.slice(0, 280) },
        ...(claims[1] ? [{ index: 3, title: 'One more thing', body: s2.slice(0, 280) }] : []),
        { index: 4, title: 'Talk to us privately', body: cta.slice(0, 280) },
      ] } };
    }
    if (format === 'STATIC') {
      return { result: 'OK', script: { ...base,
        static_graphic: { headline: hook.slice(0, 88),
          body: (seeded ? BAD : s1).slice(0, 290), footer: cta.slice(0, 110) } } };
    }
    if (format === 'POST') {
      return { result: 'OK', script: { ...base,
        post_text: `${hook}\n\n${seeded ? BAD + ' ' : ''}${s1}\n\n${s2}\n\n${cta}` } };
    }
    if (format === 'ARTICLE') {
      return { result: 'OK', script: { ...base, body: {
        intro: hook.slice(0, 300),
        sections: [
          { heading: 'What it is', body: seeded ? BAD : s1 },
          ...(claims[1] ? [{ heading: 'How it works', body: s2 }] : []),
          { heading: 'When to talk to a doctor', body: cta },
        ] } } };
    }
    if (format === 'MICROCOPY') {
      // Keys stay digit-free on purpose: bodyTextOf() walks every string
      // leaf including keys, and the deterministic overlay flags any digit
      // that appears in no approved claim (NUMBER_ALTERED). A key like
      // item_1 would fail validation on its own "1".
      return { result: 'OK', script: { ...base, body: { items: [
        { key: 'item_a', text_en: seeded ? BAD : s1.slice(0, 900), text_am: 'የተረጋገጠ መልስ።', note: 'mock parallel original' },
        ...(claims[1] ? [{ key: 'item_b', text_en: s2.slice(0, 900), text_am: 'ሁለተኛ መልስ።', note: null }] : []),
      ] } } };
    }
    if (format === 'PUSH') {
      return { result: 'OK', script: { ...base, body: { push: {
        title: 'A note from Abeba', body: (seeded ? BAD : s1).slice(0, 97),
        deep_link: 'abeba://today' } } } };
    }
    if (format === 'AUDIO') {
      return { result: 'OK', script: { ...base, estimated_duration_s: 30,
        spoken_script: `${hook} ${seeded ? BAD + ' ' : ''}${s1} ${cta}` } };
    }
    if (format === 'LIVE') {
      return { result: 'OK', script: { ...base, body: {
        segments: [
          { index: 1, title: 'Welcome and ground rules', minutes: 3, description: 'Open the room, name the topic plainly.' },
          { index: 2, title: 'The core answer', minutes: 8, description: seeded ? BAD : s1 },
          { index: 3, title: 'Questions, anonymized', minutes: 12, description: s2 },
          { index: 4, title: 'The door', minutes: 4, description: cta },
        ],
        pinned_message: `${s1.slice(0, 200)} ${cta}`.slice(0, 900),
        // Digit-free for the same NUMBER_ALTERED reason as microcopy keys.
        cutdown_briefs: ['The core answer, twenty seconds', 'The myth corrected', 'The door', 'The best question'],
      } } };
    }
    // VIDEO, the default.
    const spoken = seeded
      ? `${s1} ${BAD} ${cta}`
      : `${hook} ${s1} ${s2} ${cta}`;
    return { result: 'OK', script: { ...base, body: extraBody,
      spoken_script: spoken,
      onscreen_text: [
        { at_second: 0, text: hook.slice(0, 88) || 'Your question, answered', emphasis: 'STRONG' },
        { at_second: 4, text: s1.slice(0, 88), emphasis: 'NORMAL' },
      ],
      scene_plan: [
        { index: 1, start_s: 0, end_s: 5, visual_brief: 'Hook typography over calm Addis evening b-roll',
          asset_requirement: { kind: 'VIDEO', tags: ['addis', 'evening', 'calm'], must_be_ethiopian: true } },
        { index: 2, start_s: 5, end_s: 22, visual_brief: 'Answer cards over soft gradient',
          asset_requirement: { kind: 'TYPOGRAPHY_ONLY', tags: [] } },
        { index: 3, start_s: 22, end_s: 30, visual_brief: 'CTA end card with Telegram handle',
          asset_requirement: { kind: 'TYPOGRAPHY_ONLY', tags: [] } },
      ],
      platform_variants: { TIKTOK: { hook_variant: hook.slice(0, 90) } },
      estimated_duration_s: 30,
    } };
  }

  // REAL containment checking: a statement is SUPPORTED only when its content
  // is actually contained in its mapped claim (or any claim).
  agent_claim_validator(ctx) {
    const claims = ctx.claims || [];
    const byId = new Map(claims.map(c => [c.id, c]));
    const statements = (ctx.claim_map || []).map(m => {
      const mapped = byId.get(m.claim_id);
      const best = Math.max(
        mapped ? trigramContainment(m.statement, mapped.claim_text_en) : 0,
        ...claims.map(c => trigramContainment(m.statement, c.claim_text_en) * 0.9));
      const verdict = best >= 0.55 ? 'SUPPORTED' : best >= 0.35 ? 'PARTIALLY_SUPPORTED' : 'UNSUPPORTED';
      return { statement: m.statement, location: m.location ?? 'SPOKEN', verdict,
        supporting_claim_ids: mapped ? [m.claim_id] : [],
        reason: verdict === 'SUPPORTED' ? 'Statement is contained in the mapped claim.'
          : verdict === 'PARTIALLY_SUPPORTED' ? 'Partial containment; the remainder is unsupported.'
          : 'No supplied claim supports this statement.',
        suggested_rewrite: verdict === 'UNSUPPORTED' && mapped ? mapped.claim_text_en : null };
    });
    const findings = statements.filter(s => s.verdict !== 'SUPPORTED' && s.verdict !== 'PARTIALLY_SUPPORTED')
      .map(s => ({ code: 'UNSUPPORTED_STATEMENT', severity: 'BLOCKER',
        statement: s.statement, explanation: s.reason, suggested_fix: s.suggested_rewrite }));
    const overall = statements.some(s => s.verdict === 'UNSUPPORTED') || findings.length
      ? 'FAIL' : 'PASS';
    return { overall_result: overall, statements, findings,
      unused_core_claims: [], summary: `${statements.length} statements checked, ${findings.length} blockers.` };
  }

  agent_amharic_localizer(ctx) {
    // Canned natural-register Amharic for the demo EC fertility answer.
    const am = ctx.canonical_answer_am
      || 'ፖስትፒል ደጋግሞ መውሰድ የመውለድ አቅምን አይጎዳም። በዋናነት እንቁላል መውጣትን በማዘግየት ነው የሚሰራው። ደጋግመው የሚያስፈልግዎ ከሆነ ስለ መደበኛ የመከላከያ ዘዴ ከሐኪም ጋር ይነጋገሩ። በቴሌግራም ለቴና ይጻፉ፣ ነጻ ነው።';
    return { result: 'OK', spoken_amharic: am,
      onscreen_amharic: [{ at_second: 0, text: am.split('።')[0] + '።' }],
      hook_amharic: 'ፖስትፒል ደጋግሜ ወስጃለሁ። ልጅ መውለድ እችላለሁ?',
      cta_amharic: 'በቴሌግራም ለቴና ይጻፉ፣ ነጻ ነው።',
      caption_amharic: 'ጥያቄዎ መልስ አለው። ለቴና',
      terminology_used: [{ english: 'emergency contraception', amharic_used: 'የአስቸኳይ ጊዜ መከላከያ', terminology_id: null, is_new: true, confidence: 0.8 }],
      uncertainties: [], register_used: 'GENERAL', escalation_reason: null };
  }

  agent_back_translator(ctx) {
    // Blind mock: renders the demo Amharic back to close-but-not-identical English.
    const am = ctx.amharic_text || '';
    const english = am.includes('ፖስትፒል')
      ? 'Taking Postpill repeatedly does not harm the ability to have children. It works mainly by delaying the egg from coming out. If you need it repeatedly, talk with a doctor about a regular prevention method. Write to Letena on Telegram, it is free.'
      : 'Back-translation of supplied Amharic text.';
    return { english, ambiguities: [], unfamiliar_terms: [] };
  }

  agent_language_qa() {
    return { naturalness_score: 4, register_correct: true, meaning_preserved: true,
      verdict: 'PASS', findings: [], summary: 'Natural spoken register; medical meaning preserved.' };
  }

  agent_asset_prompt_writer(ctx) {
    return { result: 'OK', refusal_reason: null, prompts: [
      { prompt: 'Addis Ababa street at dusk, warm lamplight, a young woman looking at her phone, modest framing, documentary feel, 9:16',
        negative_prompt: 'text, anatomy, clinic, distress, recognisable faces', aspect_ratio: '9:16',
        intended_scene_index: ctx.scene_index ?? 1, style_note: 'warm, calm' }] };
  }

  agent_editorial_analyst() {
    return { headline: 'Demo analytics window; volumes below pattern threshold.',
      what_worked: [], what_did_not: [],
      recommendations: [
        { action: 'Commission repeat-EC content for university women', rationale: 'Demo gap board shows high demand, low coverage', knowledge_card_code: 'EC-005', audience_segment_slug: 'university_women_18_24', video_family: 'V02_CHAT_STORY', priority: 'HIGH', blocked_by: 'NOTHING' },
        { action: 'Draft implant bleeding knowledge card', rationale: 'Demand with no approved knowledge', knowledge_card_code: null, audience_segment_slug: null, video_family: null, priority: 'HIGH', blocked_by: 'KNOWLEDGE_CARD' },
        { action: 'Test Amharic-first hooks on TikTok', rationale: 'Language experiment pending', knowledge_card_code: 'EC-004', audience_segment_slug: null, video_family: 'V01_QUESTION_EXPLAINER', priority: 'MEDIUM', blocked_by: 'NOTHING' },
      ],
      knowledge_blockers: [{ topic_code: 'CON', demand_evidence: 'implant bleeding cluster growing', what_is_needed: 'CON-011 approval' }],
      experiments_to_run: [], caveats: ['Demo data'] };
  }

  agent_content_recommender(ctx) { return this.agent_editorial_analyst(ctx); }

  // Deterministic stand-in for studio_lock_drafter (18 Aug 2026): simple
  // keyword/regex extraction, not real language understanding -- good
  // enough to prove the endpoint's validation/reshape/response plumbing
  // works offline, not a stand-in for real draft quality (that only a real
  // model call can demonstrate).
  agent_studio_lock_drafter(ctx) {
    const text = String(ctx.free_text ?? '');
    const type = ctx.entity_type;
    const grab = (re) => { const m = text.match(re); return m ? m[1].trim() : null; };
    const fields = {};
    if (type === 'CHARACTER') {
      fields.name = grab(/\b([A-Z][a-z]{1,20})\b/);
      fields.apparent_age = grab(/\b((?:late|early|mid)?\s?\d{1,2}0s|\d{1,2}\s?years?\s?old)\b/i);
      fields.hair = grab(/([a-z-]+ hair)\b/i);
      fields.wardrobe_default = grab(/(?:wearing|in) ([a-z ,.'-]+?)(?:\.|,| with|$)/i);
    } else if (type === 'STYLE') {
      fields.style_summary = text.trim() ? text.slice(0, 160) : null;
    } else if (type === 'ENVIRONMENT') {
      fields.architecture = text.trim() ? text.slice(0, 160) : null;
    } else if (type === 'PROP') {
      fields.material = grab(/\b(leather|wood|metal|plastic|glass|fabric|paper)\b/i);
      fields.color = grab(/\b(red|blue|green|yellow|black|white|brown|ochre|teal|grey|gray)\b/i);
    }
    const neg = grab(/\bno ([a-z ]+?)(?:\.|,|$)/i);
    fields.forbidden_drift = neg ? [`no ${neg}`] : [];
    const filled = Object.entries(fields).some(([k, v]) => k !== 'forbidden_drift' && v);
    return { fields, clarifying_note: filled ? null :
      'MOCK mode: free_text did not match anything the mock drafter recognizes; a real model call would do better than this keyword stand-in.' };
  }

  // Deterministic stand-in for studio_brief_importer (19 Aug 2026). Real
  // language understanding is what a live model call is for; this is
  // block/regex extraction tuned to the semi-structured brief shape Video
  // Studio briefs are written in (named script beats with AM:/EN: text,
  // `KIND (start-end): field | field | ...` overlay blocks, `- ICON: ...`
  // lines, a CAPTION: block) -- good enough to prove the endpoint's
  // validation/apply plumbing works offline, not a stand-in for how well a
  // real model would read genuinely free-form prose. Same honesty rule as
  // the real prompt: whatever this cannot confidently parse gets a `note`,
  // never a guessed value.
  agent_studio_brief_importer(ctx) {
    return mockImportBrief(String(ctx.free_text ?? ''));
  }
}

// ===========================================================================
// studio_brief_importer MOCK parsing helpers. Pulled out of the class body
// since these are pure functions with no `this`, easier to read and to unit
// test in isolation this way. See agent_studio_brief_importer above for how
// this is invoked, and 0036_studio_brief_importer.sql / the studio_brief_importer
// system prompt for the same rules described in prose for a real model.
// ===========================================================================

// Mirrors studio_overlays.mjs's ANCHORS on purpose (not imported from there:
// ai/ deliberately does not depend on modules/, matching this file's
// existing layering). If that list ever changes, this mock's "brief names a
// position we don't support" honesty check needs updating too.
const MOCK_OVERLAY_ANCHORS = ['top', 'upper-third', 'top-right', 'right-center', 'center'];

function mockParseTimeToSeconds(str) {
  const m = String(str ?? '').match(/(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// Extracts one labeled block of text: from `startMarker` up to (but not
// including) the next blank line, or end of text. Every overlay/section
// block in the brief format this mock understands is written as one
// paragraph per element, so this is enough to isolate each one before
// picking it apart with small, specific field regexes below -- far more
// robust than one giant regex trying to match a whole block at once.
function mockExtractBlock(text, startMarker) {
  const idx = text.indexOf(startMarker);
  if (idx === -1) return null;
  const rest = text.slice(idx);
  const end = rest.search(/\n\s*\n/);
  return end === -1 ? rest.trim() : rest.slice(0, end).trim();
}

function mockParseTimeRange(block) {
  const m = String(block ?? '').match(/\((\d+:\d+(?:\.\d+)?)\s*-\s*(\d+:\d+(?:\.\d+)?)\)/);
  if (!m) return { startS: null, endS: null };
  return { startS: mockParseTimeToSeconds(m[1]), endS: mockParseTimeToSeconds(m[2]) };
}

function mockParseQuotedText(block) {
  const m = String(block ?? '').match(/text\s*"([^"]*)"/i);
  return m ? m[1] : null;
}

// "70-80px" -> the midpoint (75); "64px" -> 64. A range is rounded to a
// single number because font_size_px is one number in the overlay schema --
// the mock picks the honest middle rather than guessing which end the brief
// meant.
function mockParseFontSizePx(block) {
  const m = String(block ?? '').match(/(\d+)\s*(?:-\s*(\d+))?\s*px/i);
  if (!m) return null;
  return m[2] ? Math.round((Number(m[1]) + Number(m[2])) / 2) : Number(m[1]);
}

function mockParseFontFamily(block) {
  if (/\bbold\b/i.test(block ?? '')) return 'bold';
  if (/\bregular\b/i.test(block ?? '')) return 'regular';
  return null;
}

function mockParseHexColor(block, label) {
  const re = new RegExp(`${label}\\s+(#[0-9a-fA-F]{6}|white|black)`, 'i');
  const m = String(block ?? '').match(re);
  if (!m) return null;
  if (/^white$/i.test(m[1])) return '#FFFFFF';
  if (/^black$/i.test(m[1])) return '#000000';
  return m[1].toUpperCase();
}

function mockParseBackgroundOpacity(block) {
  const m = String(block ?? '').match(/background\s+#[0-9a-fA-F]{6}\s+(\d+)%/i);
  return m ? Number(m[1]) / 100 : null;
}

// Returns { anchor, note }: anchor is null (never a guessed nearest match)
// and note explains the mismatch when the brief names a position this
// overlay system does not support -- the honesty rule the real prompt
// describes, applied mechanically here.
function mockParsePosition(block, kindLabel) {
  const m = String(block ?? '').match(/position\s+([a-z-]+)/i);
  if (!m) return { anchor: null, note: null };
  const named = m[1].toLowerCase();
  if (MOCK_OVERLAY_ANCHORS.includes(named)) return { anchor: named, note: null };
  return { anchor: null,
    note: `the brief places this ${kindLabel} at "${named}", which is not one of the positions Video Studio overlays support (${MOCK_OVERLAY_ANCHORS.join(', ')}); pick a supported anchor manually before approving this overlay.` };
}

function mockParseSlideIn(block) {
  const m = String(block ?? '').match(/slide-in from (left|right)\s+([\d.]+)s/i);
  if (!m) return null;
  return { type: m[1] === 'left' ? 'slide-left' : 'slide-right', duration_s: Number(m[2]) };
}

function mockParseFadeOut(block) {
  const m = String(block ?? '').match(/fade out\s+([\d.]+)s/i);
  return m ? { type: 'fade', duration_s: Number(m[1]) } : null;
}

// Parses one TITLE_CARD or LABEL-shaped overlay block. `header` is the
// literal marker the block starts with (e.g. "TITLE CARD", "SHARE LABEL").
function mockParseCardOrLabel(text, header, kind, kindLabel) {
  const block = mockExtractBlock(text, header);
  if (!block) return null;
  const { startS, endS } = mockParseTimeRange(block);
  const { anchor, note: posNote } = mockParsePosition(block, kindLabel);
  const notes = [posNote].filter(Boolean);
  const data = {
    text: mockParseQuotedText(block),
    font_family: mockParseFontFamily(block),
    font_size_px: mockParseFontSizePx(block),
    text_color: mockParseHexColor(block, 'text color'),
    background_color: mockParseHexColor(block, 'background'),
    background_opacity: mockParseBackgroundOpacity(block),
    position: { anchor },
    animation_in: mockParseSlideIn(block) ?? (block.includes('fade in') ? { type: 'fade' } : undefined),
    animation_out: mockParseFadeOut(block),
  };
  if (!data.text) notes.push(`could not find quoted text for this ${kindLabel} in the brief; check the block manually.`);
  return { kind, start_s: startS, end_s: endS, order_index: 0, data,
    note: notes.length ? notes.join(' ') : null };
}

// Parses the DOOR_CARD block, including each staggered "LINE N:" fade-in.
function mockParseDoorCard(text) {
  const block = mockExtractBlock(text, 'DOOR CARD');
  if (!block) return null;
  const { startS, endS } = mockParseTimeRange(block);
  const backgroundColor = mockParseHexColor(block, 'background');
  const lineRe = /LINE\s*\d+:\s*"([^"]*)"\s*(\d+)px\s*(#[0-9a-fA-F]{6}|white|black)(?:\s*(\d+)%\s*opacity)?\s*fade in at\s*(\d+:\d+(?:\.\d+)?)/gi;
  const lines = [];
  const notes = [];
  for (const m of block.matchAll(lineRe)) {
    const fadeInS = mockParseTimeToSeconds(m[5]);
    const color = /^white$/i.test(m[3]) ? '#FFFFFF' : /^black$/i.test(m[3]) ? '#000000' : m[3].toUpperCase();
    lines.push({
      text: m[1], font_size_px: Number(m[2]), text_color: color,
      delay_s: (startS != null && fadeInS != null) ? Math.round((fadeInS - startS) * 100) / 100 : null,
      ...(m[4] ? { opacity: Number(m[4]) / 100 } : {}),
    });
  }
  if (!lines.length) notes.push('could not find any "LINE N:" entries in the DOOR CARD block; check it manually.');
  return { kind: 'DOOR_CARD', start_s: startS, end_s: endS, order_index: 0,
    data: { background_color: backgroundColor, lines }, note: notes.length ? notes.join(' ') : null };
}

// Parses the "ICONS:" block, one `- ICON: description | position X | time
// S-E` line per icon. Every icon overlay always gets asset_id: null with a
// note -- this mock, like a real model, has no way to create an actual icon
// image asset from free text (see the studio_brief_importer system prompt's
// own rule on this, same honesty standard applied mechanically here).
function mockParseIcons(text) {
  const block = mockExtractBlock(text, 'ICONS:');
  if (!block) return [];
  const lineRe = /-\s*ICON:\s*([^|]+?)\s*\|\s*position\s+([a-z-]+)\s*\|\s*time\s*(\d+:\d+(?:\.\d+)?)\s*-\s*(\d+:\d+(?:\.\d+)?)/gi;
  const out = [];
  for (const m of block.matchAll(lineRe)) {
    const description = m[1].trim();
    const named = m[2].toLowerCase();
    const startS = mockParseTimeToSeconds(m[3]);
    const endS = mockParseTimeToSeconds(m[4]);
    const supportedAnchor = MOCK_OVERLAY_ANCHORS.includes(named) ? named : null;
    const notes = [`icon asset not yet uploaded: this overlay describes "${description}" from the brief, but no icon image exists in the asset library for it yet. Upload the icon PNG (the brief says Flaticon) to the asset library, then set data.asset_id to the uploaded asset's id before this overlay can be approved.`];
    if (!supportedAnchor) {
      notes.push(`the brief places this icon at "${named}", which is not one of the positions Video Studio overlays support (${MOCK_OVERLAY_ANCHORS.join(', ')}); pick a supported anchor manually.`);
    }
    out.push({ kind: 'ICON', start_s: startS, end_s: endS, order_index: 0,
      data: { asset_id: null, position: { anchor: supportedAnchor }, description },
      note: notes.join(' ') });
  }
  return out;
}

function mockParseCaption(text) {
  const block = mockExtractBlock(text, 'CAPTION:');
  if (!block) return null;
  const am = block.match(/AM:\s*"([^"]*)"/i)?.[1] ?? null;
  const en = block.match(/EN:\s*"([^"]*)"/i)?.[1] ?? null;
  const hashtags = block.match(/HASHTAGS:\s*(.+)/i)?.[1]?.trim() ?? null;
  if (!am && !en && !hashtags) return null;
  return [am ? `AM: ${am}` : null, en ? `EN: ${en}` : null, hashtags ? hashtags : null]
    .filter(Boolean).join('\n');
}

function mockImportBrief(text) {
  const notes = [];

  // ---- project-level facts ----
  const durationMatch = text.match(/DURATION:\s*(\d+(?:\.\d+)?)\s*seconds?/i);
  const aspectMatch = text.match(/ASPECT:\s*(9:16|16:9|1:1|4:5)/i);
  const durationS = durationMatch ? Number(durationMatch[1]) : null;

  // ---- script moments: ONE continuous take, so every AM/EN pair folds into
  // one dialogue string and one temporal_beats list, never separate shots.
  const momentRe = /^(HOOK|SHARE|REASSURE|EXPLAIN|CAVEAT|CTA)\s*\((\d+:\d+(?:\.\d+)?)\s*-\s*(\d+:\d+(?:\.\d+)?)\):\s*AM:\s*"([^"]*)"\s*EN:\s*"([^"]*)"/gim;
  const moments = [...text.matchAll(momentRe)].map(m => ({
    label: m[1], startS: mockParseTimeToSeconds(m[2]), endS: mockParseTimeToSeconds(m[3]),
    am: m[4], en: m[5],
  }));
  if (!moments.length) {
    notes.push('could not find any timed script moments (expected lines like "HOOK (0:00-0:02): AM: \\"...\\" EN: \\"...\\""); presenter_shot.audio was left empty.');
  }

  const presenterShot = {
    shot_code: null,
    duration_target_s: durationS,
    story: {
      beat: moments.length
        ? `One continuous presenter take covering: ${moments.map(m => m.label).join(', ')}.`
        : null,
      narration: moments.length ? moments.map(m => m.am).join(' ') : null,
    },
    continuity: { characters: [], environment: null, props: [] },
    camera: { movement: null, movement_intensity: null, framing_notes: null },
    action: {
      subject: 'Presenter speaks directly to camera for the entire take.',
      environment: null,
      temporal_beats: moments.map(m => `${m.label} (${m.startS}s-${m.endS}s): ${m.en}`),
      performance: null,
    },
    audio: {
      dialogue: moments.length ? moments.map(m => m.am).join(' ') : null,
      dialogue_en_gloss: moments.length ? moments.map(m => m.en).join(' ') : null,
    },
    generation: { mode_preference: 'image_to_video', first_frame_asset_id: null },
    note: 'This is ONE shot for the whole take, not one shot per script moment -- the moments above are timing beats within it. generation.first_frame_asset_id is null: generate a reference image from this project\'s presenter CHARACTER lock first (create that lock if it does not exist yet), then set first_frame_asset_id before generating this shot.',
  };

  // ---- overlays ----
  const overlays = [];
  const titleCard = mockParseCardOrLabel(text, 'TITLE CARD', 'TITLE_CARD', 'title card');
  if (titleCard) overlays.push(titleCard);
  const shareLabel = mockParseCardOrLabel(text, 'SHARE LABEL', 'LABEL', 'label');
  if (shareLabel) overlays.push(shareLabel);
  const keywordLabel = mockParseCardOrLabel(text, 'KEYWORD LABEL', 'LABEL', 'label');
  if (keywordLabel) overlays.push(keywordLabel);
  const doorCard = mockParseDoorCard(text);
  if (doorCard) overlays.push(doorCard);
  overlays.push(...mockParseIcons(text));
  overlays.forEach((o, i) => { o.order_index = i; });

  if (!overlays.length) {
    notes.push('could not find any recognizable overlay blocks (TITLE CARD / SHARE LABEL / KEYWORD LABEL / DOOR CARD / ICONS) in the brief.');
  }

  const captionDraft = mockParseCaption(text);
  if (!captionDraft) notes.push('no CAPTION: block found; caption_draft is null.');

  return {
    project: {
      title: null, format: null,
      aspect_ratio: aspectMatch ? aspectMatch[1] : null,
      language: moments.length ? 'am' : null,
    },
    presenter_shot: presenterShot,
    overlays,
    caption_draft: captionDraft,
    clarifying_note: notes.length
      ? `MOCK mode: ${notes.join(' ')} A real model call would parse genuinely free-form prose better than this keyword/block stand-in.`
      : null,
  };
}

// ---------- Anthropic ----------
export class AnthropicProvider extends BaseProvider {
  name = 'ANTHROPIC';
  model = cred('ANTHROPIC_MODEL') || 'claude-sonnet-5';
  async generateStructured({ agent, system, user, maxTokens = 4000, temperature = 0.2 }) {
    const key = cred('ANTHROPIC_API_KEY');
    if (!key) throw new Error('ANTHROPIC_API_KEY not set (use LCOS_AI_PROVIDER=MOCK for demo mode)');
    // temperature deliberately NOT sent: confirmed live 13 Aug 2026 that the
    // default model (claude-sonnet-5) rejects it outright with a 400
    // ("`temperature` is deprecated for this model"), which was silently
    // failing every single structured call -- 100% failure rate, $0 cost
    // recorded because the request never got past validation to bill
    // anything. This is why every classification/label/translation call
    // looked identical to MOCK output all night even after a real API key
    // and ANTHROPIC were both saved: nothing was ever actually reaching the
    // model. If a future model here DOES support/require temperature,
    // reintroduce it conditionally rather than unconditionally again.
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: this.model, max_tokens: maxTokens,
        system: `${system}\n\nRespond with a single valid JSON object and nothing else.`,
        messages: [{ role: 'user', content: user }] }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const text = data.content.map(b => b.text ?? '').join('');
    const jsonText = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    const u = data.usage || {};
    return { output: JSON.parse(jsonText),
      usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens,
        cost_usd: ((u.input_tokens ?? 0) * 3 + (u.output_tokens ?? 0) * 15) / 1e6 } };
  }
}
