// Voice module: pronunciation lexicon, Amharic TTS text normalization, and
// script voice previews. The lexicon maps written terms to how the TTS voice
// should say them (brand names, abbreviations); normalizeForTts expands the
// digits and simple numeric patterns common in our content into Amharic
// number words so the neural voice does not spell digits out.
import crypto from 'node:crypto';
import { q, one, audit, requirePerm, err } from '../core.mjs';
import { storage, previewTts } from '../adapters/index.mjs';

const ETHIOPIC_RE = /[ሀ-፿]/;

// ---------- pure text functions (exported for tests and the pipeline) ----------

// Amharic number words 0-100. Deliberately simple and well-tested rather than
// exhaustive: standalone integers only, plus the "N%" percentage pattern.
const AM_ONES = ['ዜሮ', 'አንድ', 'ሁለት', 'ሶስት', 'አራት', 'አምስት', 'ስድስት', 'ሰባት', 'ስምንት', 'ዘጠኝ'];
const AM_TENS = [null, 'አስር', 'ሃያ', 'ሰላሳ', 'አርባ', 'ሃምሳ', 'ስልሳ', 'ሰባ', 'ሰማንያ', 'ዘጠና'];

export function amharicNumber(n) {
  if (!Number.isInteger(n) || n < 0 || n > 100) return null;
  if (n < 10) return AM_ONES[n];
  if (n === 100) return 'መቶ';
  const tens = Math.floor(n / 10), ones = n % 10;
  if (n < 20) return ones ? `አስራ ${AM_ONES[ones]}` : AM_TENS[1];
  return ones ? `${AM_TENS[tens]} ${AM_ONES[ones]}` : AM_TENS[tens];
}

// Expand "95%" -> "ዘጠና አምስት በመቶ" and standalone digits 0-100 (counts like
// "3 ቀናት") into Amharic number words. Numbers outside 0-100, decimals and
// digit runs inside longer numbers are left alone.
export function normalizeForTts(text) {
  let out = String(text ?? '');
  out = out.replace(/(?<![\d.,])(\d{1,3})\s*%/g, (m, d) => {
    const w = amharicNumber(Number(d));
    return w ? `${w} በመቶ` : m;
  });
  out = out.replace(/(?<![\d.,])(\d{1,3})(?![\d.,%])/g, (m, d) => amharicNumber(Number(d)) ?? m);
  return out;
}

// Apply pronunciation overrides. Longest term first so "Postpill 2" wins over
// "Postpill". Latin terms replace whole words (case-insensitive); Ethiopic
// terms replace as plain substrings (word boundaries do not exist in Ethiopic
// script the way \b understands them).
export function applyVoiceLexicon(text, entries) {
  let out = String(text ?? '');
  const sorted = [...(entries ?? [])]
    .filter((e) => e?.term && e?.say_as)
    .sort((a, b) => b.term.length - a.term.length);
  for (const e of sorted) {
    if (ETHIOPIC_RE.test(e.term)) {
      out = out.split(e.term).join(e.say_as);
    } else {
      const esc = e.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`, 'gi'), e.say_as);
    }
  }
  return out;
}

// ---------- routes ----------

const anyPerm = (...perms) => async (req, reply) => {
  if (!perms.some((p) => req.actor?.permissions?.includes(p))) {
    return reply.code(403).send(err(403, 'FORBIDDEN', `requires ${perms.join(' or ')}`));
  }
};

export default async function routes(app) {
  app.get('/platform/voice-lexicon', { preHandler: requirePerm('script.read') }, async () => {
    const r = await q(
      `SELECT id, term, say_as, language, notes, updated_by, updated_at
       FROM lcos.voice_lexicon ORDER BY term`);
    return { items: r.rows };
  });

  // Upsert by term; an empty say_as deletes the entry.
  app.put('/platform/voice-lexicon',
    { preHandler: anyPerm('script.approve_language', 'settings.manage') },
    async (req, reply) => {
      const term = String(req.body?.term ?? '').trim();
      const sayAs = String(req.body?.say_as ?? '').trim();
      const notes = req.body?.notes ?? null;
      if (!term) return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'term required'));
      if (!sayAs) {
        const gone = await one(`DELETE FROM lcos.voice_lexicon WHERE term=$1 RETURNING id`, [term]);
        await audit(null, { actor: req.actor, action: 'voice_lexicon.delete',
          objectType: 'VOICE_LEXICON', objectId: gone?.id ?? null, objectCode: term });
        return { ok: true, deleted: !!gone };
      }
      const row = await one(
        `INSERT INTO lcos.voice_lexicon (term, say_as, notes, updated_by)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (term) DO UPDATE SET say_as=EXCLUDED.say_as, notes=EXCLUDED.notes,
           updated_by=EXCLUDED.updated_by, updated_at=now()
         RETURNING *`,
        [term, sayAs, notes, req.actor?.id ?? null]);
      await audit(null, { actor: req.actor, action: 'voice_lexicon.upsert',
        objectType: 'VOICE_LEXICON', objectId: row.id, objectCode: term });
      return row;
    });

  // Hear how the current script text will sound: normalization + lexicon, then
  // the preview TTS adapter (mock placeholder offline; Azure am-ET voices when
  // configured for production).
  app.post('/production/voice-preview', { preHandler: requirePerm('production.request') },
    async (req, reply) => {
      const { script_id, voice } = req.body ?? {};
      if (!script_id) return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'script_id required'));
      const script = await one(`SELECT * FROM lcos.scripts WHERE id=$1`, [script_id]);
      if (!script) return reply.code(404).send(err(404, 'NOT_FOUND', 'script'));
      const v = await one(
        `SELECT spoken_script FROM lcos.script_versions WHERE script_id=$1 AND version=$2`,
        [script.id, script.current_version]);
      if (!v) return reply.code(404).send(err(404, 'NOT_FOUND', 'script version'));
      let text = v.spoken_script;
      if (script.language === 'AM') {
        const trans = await one(
          `SELECT translated_text FROM lcos.translations
           WHERE object_type='SCRIPT' AND object_id=$1 AND language='AM'`, [script.id]);
        if (trans?.translated_text) text = trans.translated_text;
      }
      const entries = (await q(`SELECT term, say_as FROM lcos.voice_lexicon`)).rows;
      const prepared = applyVoiceLexicon(normalizeForTts(text), entries);
      const voiceName = voice === 'AMEHA' ? 'am-ET-AmehaNeural' : 'am-ET-MekdesNeural';
      const result = await previewTts({ text: prepared, voice: voiceName,
        previewId: crypto.randomUUID() });
      await audit(null, { actor: req.actor, action: 'voice.preview', objectType: 'SCRIPT',
        objectId: script.id, objectCode: script.code, reason: voiceName });
      return { url: storage.url(result.storage_key), text_used: prepared };
    });
}
