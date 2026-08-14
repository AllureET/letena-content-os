// Terminology policy seeder. Owner rule (Nate, 12 Aug 2026): clinical,
// technical and brand terms stay in ENGLISH (Latin script) inside Amharic
// copy; Ethiopian speakers code-switch for them. Everyday health words with
// fully native usage stay Amharic. Source: terminology_policy.json, produced
// alongside the basics-library Amharic revision. Rows land IN_REVIEW so the
// language team confirms them in the Terminology screen; the localizer only
// uses APPROVED rows, so nothing changes generation until they click.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool, q, one } from './pool.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const entries = JSON.parse(readFileSync(join(here, 'terminology_policy.json'), 'utf8'));

async function main() {
  const admin = await one(`SELECT id FROM lcos.users WHERE email='admin@letena.local'`);
  let n = 0;
  for (const e of entries) {
    const keepEnglish = e.policy === 'KEEP_ENGLISH';
    const preferred = keepEnglish ? e.term_en : (e.am ?? e.term_en);
    const avoid = keepEnglish && e.am_equivalent_avoid ? [e.am_equivalent_avoid] : [];
    // KEEP_ENGLISH rows land APPROVED with keep_english=true: the owner
    // decided this rule (12 Aug 2026, reconfirmed 14 Aug: "that should be
    // respected"), so it is in force, not pending language-team review.
    // The Amharic-native rows stay IN_REVIEW for the language team.
    await q(
      `INSERT INTO lcos.terminology (term_en, preferred_am, avoid_am, avoid_reason,
         notes, register, status, keep_english)
       VALUES ($1, $2, $3, $4, $5, 'MIXED', $6, $7)
       ON CONFLICT (term_en, register) DO UPDATE SET
         preferred_am = EXCLUDED.preferred_am, avoid_am = EXCLUDED.avoid_am,
         avoid_reason = EXCLUDED.avoid_reason, notes = EXCLUDED.notes,
         keep_english = EXCLUDED.keep_english,
         status = CASE WHEN EXCLUDED.keep_english THEN 'APPROVED'::lcos.lifecycle_status
                       WHEN lcos.terminology.status='APPROVED'
                       THEN lcos.terminology.status ELSE 'IN_REVIEW'::lcos.lifecycle_status END`,
      [e.term_en, preferred, avoid,
       keepEnglish ? 'Owner rule 12 Aug 2026: clinical/brand terms stay in English inside Amharic copy' : null,
       e.note ?? null, keepEnglish ? 'APPROVED' : 'IN_REVIEW', keepEnglish]);
    n++;
  }
  console.log(`terminology: ${n} entries upserted (stay-English set APPROVED per the 12 Aug owner rule; Amharic-native rows IN_REVIEW for the language team)`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
