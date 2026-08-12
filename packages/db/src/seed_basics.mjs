// Basics knowledge library seeder. Loads the researched, source-cited fact
// base (basics_facts.json, compiled 12 Aug 2026 from WHO / Ethiopian FMOH /
// NHS / CDC pages actually fetched and read) plus Amharic canonical answers
// (basics_amharic.json, drafted for language-team review) into:
//   medical_sources (ACTIVE) -> medical_claims (IN_REVIEW) -> claim_sources
//   -> knowledge_card_versions (EN+AM) -> knowledge_card_claims
// and moves each card to IN_REVIEW so the clinical team can approve facts
// on the Cards screen. NOTHING here is marked APPROVED: approval is the
// doctors' click, by design. Idempotent: re-running updates in place and
// never touches cards already APPROVED.
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool, q, one } from './pool.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const facts = JSON.parse(readFileSync(join(here, 'basics_facts.json'), 'utf8'));
const amharic = JSON.parse(readFileSync(join(here, 'basics_amharic.json'), 'utf8'));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function main() {
  const admin = await one(`SELECT id FROM lcos.users WHERE email='admin@letena.local'`);
  if (!admin) throw new Error('run the base seed first');

  const srcId = {};
  for (const s of facts.sources) {
    const row = await one(
      `INSERT INTO lcos.medical_sources (code, organisation, title, source_type, jurisdiction,
         precedence, publication_date, url, status, added_by)
       VALUES ($1,$2,$3,$4::lcos.source_type,$5,$6,$7,$8,'ACTIVE',$9)
       ON CONFLICT (code) DO UPDATE SET title=EXCLUDED.title, url=EXCLUDED.url,
         publication_date=EXCLUDED.publication_date, status='ACTIVE'
       RETURNING id`,
      [s.code, s.organisation, s.title, s.source_type, s.jurisdiction,
       s.precedence, s.publication_date ?? null, s.url, admin.id]);
    srcId[s.code] = row.id;
  }
  console.log(`sources: ${facts.sources.length}`);

  let claimCount = 0, cardCount = 0;
  for (const c of facts.cards) {
    const card = await one(
      `SELECT kc.*, t.id AS tid FROM lcos.knowledge_cards kc JOIN lcos.topics t ON t.id=kc.topic_id
       WHERE kc.code=$1`, [c.card]);
    if (!card) { console.warn(`SKIP ${c.card}: card shell not found`); continue; }

    for (const cl of c.claims) {
      const claim = await one(
        `INSERT INTO lcos.medical_claims (code, topic_id, claim_text_en, claim_type, certainty,
           risk_tier, status, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'IN_REVIEW',$7,$8)
         ON CONFLICT (code) DO UPDATE SET claim_text_en=EXCLUDED.claim_text_en,
           claim_type=EXCLUDED.claim_type, certainty=EXCLUDED.certainty,
           status=CASE WHEN lcos.medical_claims.status='APPROVED'
                       THEN lcos.medical_claims.status ELSE 'IN_REVIEW'::lcos.lifecycle_status END
         RETURNING id`,
        [cl.code, card.topic_id, cl.text_en, cl.claim_type, cl.certainty,
         card.risk_tier, `Locator: ${cl.locator ?? ''}`, admin.id]);
      await q(`INSERT INTO lcos.claim_sources (claim_id, source_id, locator, is_primary)
               VALUES ($1,$2,$3,true) ON CONFLICT DO NOTHING`,
        [claim.id, srcId[cl.source_code], cl.locator ?? null]);
      await q(`INSERT INTO lcos.knowledge_card_claims (card_id, claim_id, is_core)
               VALUES ($1,$2,true) ON CONFLICT DO NOTHING`, [card.id, claim.id]);
      claimCount++;
    }

    const am = amharic[c.card] ?? {};
    const body = c.answer_en + (am.answer_am ?? '');
    const existing = await one(
      `SELECT id, version, content_sha256 FROM lcos.knowledge_card_versions
       WHERE card_id=$1 ORDER BY version DESC LIMIT 1`, [card.id]);
    let versionId = existing?.id;
    if (!existing || existing.content_sha256 !== sha(body)) {
      const v = (existing?.version ?? 0) + 1;
      const row = await one(
        `INSERT INTO lcos.knowledge_card_versions (card_id, version, canonical_answer_en,
           canonical_answer_am, key_points_en, key_points_am, prohibited_claims,
           referral_conditions, approved_ctas, change_summary, content_sha256, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [card.id, v, c.answer_en, am.answer_am ?? null,
         JSON.stringify(c.key_points_en ?? []), JSON.stringify(am.key_points_am ?? []),
         JSON.stringify((c.prohibited_claims ?? []).map(p => ({ statement: p, reason: 'basics library' }))),
         JSON.stringify(c.referral_conditions ?? []),
         JSON.stringify(['Visit a Letena partner clinic', 'Message Letena on Telegram for a free private consultation']),
         'Basics library, WHO/FMOH/NHS/CDC sourced, 12 Aug 2026', sha(body), admin.id]);
      versionId = row.id;
    }
    await q(
      `UPDATE lcos.knowledge_cards SET current_version_id=$2,
         status=CASE WHEN status='APPROVED' THEN status ELSE 'IN_REVIEW'::lcos.lifecycle_status END,
         updated_at=now()
       WHERE id=$1`, [card.id, versionId]);
    cardCount++;
  }
  console.log(`cards: ${cardCount}, claims: ${claimCount}. All IN_REVIEW awaiting clinical approval.`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
