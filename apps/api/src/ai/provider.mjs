// AI provider abstraction. generateStructured(), embed(). Providers: MOCK
// (deterministic, runs the whole system with no credentials), OPENAI,
// ANTHROPIC. Selection: env LCOS_AI_PROVIDER or per-agent override.
import { trigramContainment } from '../../../../packages/scoring/src/index.mjs';
import { cred } from '../creds.mjs';

export function getProvider(name = cred('LCOS_AI_PROVIDER') || 'MOCK') {
  const n = name.toUpperCase();
  if (n === 'OPENAI') return new OpenAIProvider();
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

  agent_script_writer(ctx) {
    const claims = ctx.claims || [];
    if (!claims.length) {
      return { result: 'NEEDS_KNOWLEDGE', needs_knowledge: {
        missing_facts: [{ fact_needed: 'Any approved claim on this topic', why: 'Claim set is empty' }],
        blocking_reason: 'No approved claims supplied' } };
    }
    const cta = ctx.card?.approved_ctas?.[0] ?? 'Message Letena on Telegram.';
    const s1 = claims[0].claim_text_en;
    const s2 = claims[1]?.claim_text_en ?? s1;
    // Optional seeded defect for governance tests: an unsupported statement.
    const spoken = ctx.__seed_unsupported
      ? `${s1} It is 99% effective for everyone. ${cta}`
      : `${ctx.hook_line ?? 'You asked. Here is the answer.'} ${s1} ${s2} ${cta}`;
    return { result: 'OK', script: {
      hook: ctx.hook_line ?? 'You asked. Here is the answer.',
      spoken_script: spoken,
      onscreen_text: [
        { at_second: 0, text: (ctx.hook_line ?? '').slice(0, 88) || 'Your question, answered', emphasis: 'STRONG' },
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
      cta, caption: `${(ctx.hook_line ?? '').slice(0, 80)} | Letena`,
      hashtags: ['letena', 'health'],
      platform_variants: { TIKTOK: { hook_variant: (ctx.hook_line ?? '').slice(0, 90) } },
      estimated_duration_s: 30,
      claim_map: [
        ...(ctx.__seed_unsupported ? [{ statement: 'It is 99% effective for everyone.',
          claim_id: claims[0].id, location: 'SPOKEN' }] : []),
        { statement: s1, claim_id: claims[0].id, location: 'SPOKEN' },
        ...(claims[1] ? [{ statement: s2, claim_id: claims[1].id, location: 'SPOKEN' }] : []),
      ],
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
}

// ---------- OpenAI ----------
export class OpenAIProvider extends BaseProvider {
  name = 'OPENAI';
  model = cred('OPENAI_MODEL') || 'gpt-4o';
  async generateStructured({ agent, system, user, schemaName, jsonSchema, temperature = 0.2, maxTokens = 4000 }) {
    const key = cred('OPENAI_API_KEY');
    if (!key) throw new Error('OPENAI_API_KEY not set (use LCOS_AI_PROVIDER=MOCK for demo mode)');
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: this.model, temperature, max_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        response_format: jsonSchema
          ? { type: 'json_schema', json_schema: { name: schemaName || agent, strict: false, schema: jsonSchema } }
          : { type: 'json_object' },
      }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const u = data.usage || {};
    return { output: JSON.parse(data.choices[0].message.content),
      usage: { input_tokens: u.prompt_tokens, output_tokens: u.completion_tokens,
        cost_usd: ((u.prompt_tokens ?? 0) * 2.5 + (u.completion_tokens ?? 0) * 10) / 1e6 } };
  }
  async embed(text) {
    const key = cred('OPENAI_API_KEY');
    if (!key) return mockEmbed(text);
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: text.slice(0, 8000) }),
    });
    if (!res.ok) throw new Error(`OpenAI embed ${res.status}`);
    return (await res.json()).data[0].embedding;
  }
}

// ---------- Anthropic ----------
export class AnthropicProvider extends BaseProvider {
  name = 'ANTHROPIC';
  model = cred('ANTHROPIC_MODEL') || 'claude-sonnet-4-5';
  async generateStructured({ agent, system, user, maxTokens = 4000, temperature = 0.2 }) {
    const key = cred('ANTHROPIC_API_KEY');
    if (!key) throw new Error('ANTHROPIC_API_KEY not set (use LCOS_AI_PROVIDER=MOCK for demo mode)');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: this.model, max_tokens: maxTokens, temperature,
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
