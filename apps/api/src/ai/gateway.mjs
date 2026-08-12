// Agent Gateway. Every model call in the system goes through invokeAgent():
// prompt from ai_prompts, PII assertion on the outbound payload, provider
// dispatch, zod validation with one repair retry, ai_invocations recording.
import { z } from 'zod';
import { q, one, setting } from '../core.mjs';
import { getProvider } from './provider.mjs';
import { cred } from '../creds.mjs';
import { containsForbidden } from '../../../../packages/deid/src/index.mjs';

// ---------- output schemas (zod, mirrors LCOS_06 JSON Schemas) ----------
const S = {
  question_classifier: z.object({
    topic_code: z.string().nullable(), subtopic: z.string().nullable().optional(),
    intent: z.enum(['FACT_SEEKING','REASSURANCE_SEEKING','MYTH_CHECK','SYMPTOM_CONCERN','METHOD_CHOICE','ACCESS_QUESTION','RELATIONSHIP_CONTEXT','URGENT_HELP','SERVICE_REQUEST','OTHER']),
    is_myth: z.boolean(), myth_text: z.string().nullable().optional(),
    fear_expressed: z.string().nullable().optional(),
    urgency: z.enum(['NONE','LOW','MODERATE','HIGH','EMERGENCY']),
    clinical_risk: z.enum(['NONE','LOW','MODERATE','HIGH','EMERGENCY']),
    audience_segment_slug: z.string().nullable().optional(),
    knowledge_card_code: z.string().nullable(),
    match_confidence: z.number().min(0).max(1),
    content_value: z.number().int().min(1).max(5),
    content_opportunity: z.string().nullable().optional(),
    referral_relevant: z.boolean().optional().default(false),
    language: z.enum(['EN','AM','OM','TI']),
    is_code_mixed: z.boolean().optional().default(false),
    sentiment: z.enum(['ANXIOUS','NEUTRAL','FRUSTRATED','ASHAMED','CURIOUS','DISTRESSED']).optional(),
  }),
  deid_sweep: z.object({
    spans: z.array(z.object({ start: z.number().int(), end: z.number().int(),
      type: z.enum(['PERSON','PHONE','HANDLE','EMAIL','ADDRESS','PLACE_FINE','ID','DATE_FINE','RELATION','OTHER']),
      confidence: z.number().min(0).max(1).optional(), reason: z.string().optional() })),
    residual_risk: z.enum(['NONE','LOW','MEDIUM','HIGH']),
    notes: z.string().optional(),
  }).strict(),   // strict: a rewritten_text field is a schema failure by design
  cluster_labeller: z.object({ label_en: z.string(), label_am: z.string().nullable(),
    representative_question: z.string() }),
  question_translator: z.object({ translation_en: z.string() }),
  creative_director: z.object({ concepts: z.array(z.object({
    title: z.string(), video_family: z.string(), hook_line: z.string(),
    premise: z.string(), treatment: z.string(), perspective: z.string().nullable().optional(),
    characters: z.array(z.object({ name: z.string(), age: z.number(), context: z.string(),
      is_fictional: z.literal(true) })).optional().default([]),
    claim_ids_referenced: z.array(z.string()),
    target_duration_s: z.number().int(), target_platforms: z.array(z.string()).optional().default([]),
    cta_intent: z.string(), why_this_works: z.string(),
    needs_knowledge: z.object({ missing_fact: z.string(), why_needed: z.string() }).nullable(),
  })).min(1).max(8) }),
  script_writer: z.discriminatedUnion('result', [
    z.object({ result: z.literal('OK'), script: z.object({
      hook: z.string().max(120), spoken_script: z.string().max(3000),
      onscreen_text: z.array(z.object({ at_second: z.number(), text: z.string().max(90),
        emphasis: z.enum(['NORMAL','STRONG','WARNING']).optional() })),
      scene_plan: z.array(z.object({ index: z.number().int(), start_s: z.number(), end_s: z.number(),
        visual_brief: z.string(), asset_requirement: z.object({ kind: z.string(),
          tags: z.array(z.string()), must_be_ethiopian: z.boolean().optional() }) })).min(1),
      cta: z.string(), caption: z.string().optional(), hashtags: z.array(z.string()).optional().default([]),
      platform_variants: z.record(z.any()).optional().default({}),
      estimated_duration_s: z.number(),
      claim_map: z.array(z.object({ statement: z.string(), claim_id: z.string(),
        claim_code: z.string().optional(), location: z.enum(['HOOK','SPOKEN','ONSCREEN','CTA','CAPTION']),
        paraphrase_note: z.string().nullable().optional() })).min(1),
    }) }),
    z.object({ result: z.literal('NEEDS_KNOWLEDGE'), needs_knowledge: z.object({
      missing_facts: z.array(z.object({ fact_needed: z.string(), why: z.string(),
        suggested_topic_code: z.string().nullable().optional() })).min(1),
      blocking_reason: z.string() }) }),
  ]),
  claim_validator: z.object({
    overall_result: z.enum(['PASS','FAIL']),
    statements: z.array(z.object({ statement: z.string(), location: z.string(),
      verdict: z.enum(['SUPPORTED','PARTIALLY_SUPPORTED','UNSUPPORTED','CONTRADICTED','AMBIGUOUS']),
      supporting_claim_ids: z.array(z.string()).optional().default([]),
      reason: z.string(), suggested_rewrite: z.string().nullable().optional() })).min(1),
    findings: z.array(z.object({ code: z.string(), severity: z.enum(['BLOCKER','MAJOR','MINOR','INFO']),
      statement: z.string().nullable().optional(), explanation: z.string(),
      suggested_fix: z.string().nullable().optional() })),
    unused_core_claims: z.array(z.string()).optional().default([]),
    summary: z.string(),
  }),
  amharic_localizer: z.object({
    result: z.enum(['OK','HUMAN_LANGUAGE_REVIEW']),
    spoken_amharic: z.string().nullable().optional(),
    onscreen_amharic: z.array(z.object({ at_second: z.number(), text: z.string() })).nullable().optional(),
    hook_amharic: z.string().nullable().optional(), cta_amharic: z.string().nullable().optional(),
    caption_amharic: z.string().nullable().optional(),
    terminology_used: z.array(z.object({ english: z.string(), amharic_used: z.string(),
      terminology_id: z.string().nullable().optional(), is_new: z.boolean(),
      confidence: z.number().optional() })).optional().default([]),
    uncertainties: z.array(z.any()).optional().default([]),
    register_used: z.enum(['CLINICAL','GENERAL','YOUTH','ELDER','MIXED']).optional(),
    escalation_reason: z.string().nullable().optional(),
  }).refine(v => v.result !== 'OK' || (v.spoken_amharic && v.hook_amharic),
    { message: 'OK requires spoken_amharic and hook_amharic' }),
  back_translator: z.object({ english: z.string(),
    ambiguities: z.array(z.object({ amharic_fragment: z.string(),
      readings: z.array(z.string()).min(2), note: z.string().optional() })).optional().default([]),
    unfamiliar_terms: z.array(z.string()).optional().default([]) }),
  language_qa: z.object({ naturalness_score: z.number().int().min(1).max(5),
    register_correct: z.boolean(), meaning_preserved: z.boolean(),
    verdict: z.enum(['PASS','PASS_WITH_EDITS','HUMAN_REQUIRED','FAIL']),
    findings: z.array(z.object({ code: z.string(), severity: z.enum(['BLOCKER','MAJOR','MINOR','INFO']),
      amharic_fragment: z.string().optional(), english_equivalent: z.string().nullable().optional(),
      explanation: z.string(), suggested_amharic: z.string().nullable().optional() })).optional().default([]),
    summary: z.string() }),
  asset_prompt_writer: z.object({ result: z.enum(['OK','REFUSED']),
    refusal_reason: z.string().nullable().optional(),
    prompts: z.array(z.object({ prompt: z.string(), negative_prompt: z.string(),
      aspect_ratio: z.enum(['9:16','1:1','16:9','4:5']), intended_scene_index: z.number().int(),
      style_note: z.string().nullable().optional() })).optional().default([]) }),
  editorial_analyst: z.object({ headline: z.string(),
    what_worked: z.array(z.any()), what_did_not: z.array(z.any()),
    recommendations: z.array(z.object({ action: z.string(), rationale: z.string(),
      knowledge_card_code: z.string().nullable().optional(),
      audience_segment_slug: z.string().nullable().optional(),
      video_family: z.string().nullable().optional(),
      priority: z.enum(['HIGH','MEDIUM','LOW']),
      blocked_by: z.enum(['NOTHING','KNOWLEDGE_CARD','CLINICAL_REVIEW','ASSET','BUDGET','LANGUAGE_REVIEW']) })).min(1),
    knowledge_blockers: z.array(z.any()).optional().default([]),
    experiments_to_run: z.array(z.any()).optional().default([]),
    caveats: z.array(z.string()).optional().default([]) }),
};
S.content_recommender = S.editorial_analyst;
export const agentSchemas = S;

export class AgentError extends Error {
  constructor(msg, outcome) { super(msg); this.outcome = outcome; }
}

// ---------- house style + tone (Nate, 12 Aug 2026) ----------
// "I should have options if I want to change the tone and voice" -> tone is
// a selectable preset (lcos.tone_presets, migration 0009). These hard bans
// are NOT part of any preset: they apply to every agent call regardless of
// which tone is selected, so a tone change can never turn a house rule off.
export const HOUSE_STYLE_RULES = `House writing rules. These apply to every piece of English or Amharic copy you write, regardless of the tone and voice instructions below. No exceptions.
- Never use an em dash (—).
- Never use a "not this, but that" contrastive construction.
- Never hedge with filler like "might", "could potentially", "it's possible that" when you mean something plainly. State what is true.
- Never use a parenthetical aside.
- Never sign off like an assistant: no "I hope this helps!", no "Let me know if you have questions", nothing like it. This is not a chat reply, it is finished copy.
- Never use antithesis ("it is not X, it is Y") as a rhetorical flourish. Only contrast two things when the contrast itself is the medically necessary clarification, and even then say it plainly rather than as a rhetorical pair.
- Never use a rule-of-three phrase pattern ("safe, simple, and effective") as a stylistic flourish.
- Write plain human prose that matches the audience and the document type. Amharic is the primary language for Amharic copy, not a translation exercise: write the way people actually speak, not a stiff word-for-word rendering.`;

// Resolves the effective tone preset's prompt instructions: an explicit
// per-call override key, else the content.tone_preset platform setting,
// else (unknown/inactive key) the LETENA_DEFAULT preset as a safe fallback.
export async function getTonePresetInstructions(toneKeyOverride) {
  const key = toneKeyOverride || String(await setting('content.tone_preset', 'LETENA_DEFAULT'));
  const preset = await one(
    `SELECT prompt_instructions FROM lcos.tone_presets WHERE key=$1 AND is_active`, [key]);
  if (preset) return preset.prompt_instructions;
  const fallback = await one(
    `SELECT prompt_instructions FROM lcos.tone_presets WHERE key='LETENA_DEFAULT' AND is_active`);
  return fallback?.prompt_instructions ?? '';
}

// Pure composition: house rules first (persona-setting context that must
// never be dropped), then the selected tone, then the agent's own task
// instructions (which include its output-format requirements) last.
export function buildAgentSystemPrompt(basePrompt, toneInstructions) {
  const toneBlock = toneInstructions ? `Tone and voice for this piece:\n${toneInstructions}` : '';
  return [HOUSE_STYLE_RULES, toneBlock, basePrompt].filter(Boolean).join('\n\n');
}

export async function invokeAgent(agentKey, context, { objectType = null, objectId = null,
  workflowCode = null, provider: providerName, tone_preset: tonePreset = null } = {}) {
  const schema = S[agentKey];
  if (!schema) throw new Error(`no schema for agent ${agentKey}`);
  const prompt = await one(
    `SELECT * FROM lcos.ai_prompts WHERE prompt_key=$1 AND is_active`, [agentKey]);
  const provider = getProvider(providerName);
  const started = Date.now();
  const toneInstructions = await getTonePresetInstructions(tonePreset);
  const system = buildAgentSystemPrompt(prompt?.system_prompt ?? '', toneInstructions);

  // PII assertion on the full outbound payload. BLOCKED_PII is terminal.
  const payloadText = JSON.stringify(context);
  if (containsForbidden(payloadText)) {
    await record({ agentKey, prompt, provider, objectType, objectId, workflowCode,
      started, outcome: 'BLOCKED_PII', error: 'forbidden pattern in outbound payload' });
    throw new AgentError('PII pattern detected in agent payload; call blocked.', 'BLOCKED_PII');
  }

  let lastErr = null;
  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      const { output, usage } = await provider.generateStructured({
        agent: agentKey, context,
        system,
        user: attempt === 0 ? payloadText
          : `${payloadText}\n\nYour previous response failed validation: ${lastErr}. Return corrected JSON only.`,
        schemaName: agentKey,
        temperature: prompt ? Number(prompt.temperature) : 0.2,
        maxTokens: prompt?.max_output_tokens ?? 4000,
      });
      const parsed = schema.safeParse(output);
      if (!parsed.success) {
        lastErr = JSON.stringify(parsed.error.issues.slice(0, 5));
        if (attempt === 1) {
          await record({ agentKey, prompt, provider, objectType, objectId, workflowCode,
            started, usage, outcome: 'SCHEMA_FAIL', error: lastErr, repair: attempt });
          throw new AgentError(`schema validation failed twice: ${lastErr}`, 'SCHEMA_FAIL');
        }
        continue;
      }
      await record({ agentKey, prompt, provider, objectType, objectId, workflowCode,
        started, usage, outcome: 'SUCCESS', repair: attempt });
      return parsed.data;
    } catch (e) {
      if (e instanceof AgentError) throw e;
      lastErr = e.message;
      if (attempt === 1) {
        await record({ agentKey, prompt, provider, objectType, objectId, workflowCode,
          started, outcome: 'PROVIDER_ERROR', error: e.message, repair: attempt });
        throw new AgentError(`provider error: ${e.message}`, 'PROVIDER_ERROR');
      }
    }
  }
}

async function record({ agentKey, prompt, provider, objectType, objectId, workflowCode,
  started, usage = {}, outcome, error = null, repair = 0 }) {
  await q(
    `INSERT INTO lcos.ai_invocations (agent_name, prompt_key, prompt_version, provider, model,
       object_type, object_id, workflow_code, input_tokens, output_tokens, latency_ms,
       cost_usd, schema_valid, repair_attempts, outcome, error_detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [prompt?.agent_name ?? agentKey, agentKey, prompt?.version ?? '0',
     provider.name === 'MOCK' ? 'LOCAL' : provider.name, provider.model ?? 'n/a',
     objectType, objectId, workflowCode,
     usage.input_tokens ?? null, usage.output_tokens ?? null, Date.now() - started,
     usage.cost_usd ?? null, outcome === 'SUCCESS', repair, outcome, error]);
}

export async function embed(text) {
  return getProvider(cred('LCOS_EMBED_PROVIDER') || cred('LCOS_AI_PROVIDER') || 'MOCK').embed(text);
}
export function toVectorLiteral(arr) { return `[${arr.join(',')}]`; }
