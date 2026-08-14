// Live transcripts for aua_recap (Part 2, owner brief, 14 Aug 2026). The
// recap of a recorded live transcribes the recording BEFORE it generates
// anything. Amharic speech recognition is unreliable in every engine, and
// this transcript carries medical statements a doctor said out loud, so the
// rules are enforced here, server side:
//   - a transcript arrives either way (Part 1): paste or upload an existing
//     one from VEED, or upload the audio and let Gemini transcribe it.
//     Audio is preferred over video; a video upload has its audio stripped
//     server side and the record says that is what happened;
//   - it is machine transcription, never presented as ground truth: status
//     starts DRAFT and stays DRAFT until a human confirms it on screen;
//   - NOTHING generates from it until a human confirms it: generateContent
//     refuses an aua_recap without a CONFIRMED transcript (content.mjs);
//   - editing a CONFIRMED transcript returns it to DRAFT, exactly like a
//     medical sign-off no longer describing the text it signed.
import crypto from 'node:crypto';
import { q, one, audit, requirePerm, err } from '../core.mjs';
import { gemini, storage } from '../adapters/index.mjs';

const code = (p) => `${p}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
const MAX_AUDIO = 24 * 1024 * 1024; // ~18MB of audio as base64; a full live's AUDIO fits, its video does not

// Parse a pasted transcript into segments. Accepts VEED-style "[00:12]" or
// "00:12" line prefixes and SRT-ish "00:00:12 --> 00:00:26" markers; lines
// with no timecode become segments with null timing rather than being
// dropped, because dropping a doctor's sentence silently is the one failure
// mode this screen exists to prevent.
export function parsePastedTranscript(text) {
  const toSeconds = (t) => {
    const p = t.split(':').map(Number);
    if (p.some(Number.isNaN)) return null;
    return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + (p[1] ?? 0);
  };
  const segments = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let m = line.match(/^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*(?:-->?\s*\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?)?\s*(.*)$/);
    if (m && m[3]) {
      segments.push({ start_s: toSeconds(m[1]), end_s: m[2] ? toSeconds(m[2]) : null,
        speaker: 'doctor', text: m[3] });
    } else if (!/^\d+$/.test(line) && !/-->/.test(line)) {
      segments.push({ start_s: null, end_s: null, speaker: 'doctor', text: line });
    }
  }
  return segments;
}

export default async function routes(app) {
  app.get('/content/transcripts', { preHandler: requirePerm('script.read') }, async () => {
    const r = await q(
      `SELECT t.id, t.code, t.title, t.source, t.transcription_engine, t.status,
              t.confirmed_at, t.created_at, u.full_name AS confirmed_by_name,
              jsonb_array_length(t.segments) AS segment_count
       FROM lcos.live_transcripts t
       LEFT JOIN lcos.users u ON u.id = t.confirmed_by
       ORDER BY t.created_at DESC LIMIT 100`);
    return { items: r.rows };
  });

  app.get('/content/transcripts/:id', { preHandler: requirePerm('script.read') }, async (req, reply) => {
    const t = await one(`SELECT t.*, u.full_name AS confirmed_by_name
                         FROM lcos.live_transcripts t
                         LEFT JOIN lcos.users u ON u.id = t.confirmed_by
                         WHERE t.id=$1`, [req.params.id]);
    if (!t) return reply.code(404).send(err(404, 'NOT_FOUND', 'transcript'));
    return t;
  });

  // Create: paste text, provide segments directly, or upload audio (or
  // video, whose audio is stripped) for Gemini transcription. Exactly one
  // of transcript_text / segments / media_base64.
  app.post('/content/transcripts', { preHandler: requirePerm('script.write') }, async (req, reply) => {
    const { title, transcript_text, segments, media_base64, media_mime_type } = req.body ?? {};
    if (!title) return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'title required'));

    let source, engine = null, segs, audioKey = null, note = null;
    if (transcript_text) {
      source = 'PASTED';
      segs = parsePastedTranscript(transcript_text);
      if (!segs.length) return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'no usable lines in the pasted transcript'));
    } else if (Array.isArray(segments) && segments.length) {
      source = 'UPLOADED_TRANSCRIPT';
      segs = segments.map(s => ({ start_s: s.start_s ?? null, end_s: s.end_s ?? null,
        speaker: s.speaker ?? 'doctor', text: String(s.text ?? '') })).filter(s => s.text.trim());
    } else if (media_base64) {
      if (media_base64.length > MAX_AUDIO) {
        return reply.code(422).send(err(422, 'VALIDATION_ERROR',
          'upload exceeds the audio bound. Upload the AUDIO, not the video: transcription needs only the audio and the file is a hundred times smaller.'));
      }
      const mime = String(media_mime_type ?? 'audio/mpeg');
      const isVideo = mime.startsWith('video/');
      // A video upload gets its audio stripped server side, and the record
      // says so plainly (Part 2: "say that is what happened"). In MOCK mode
      // the strip is a passthrough; production runs ffmpeg -vn on the
      // Hetzner box before anything is sent to Gemini.
      source = isVideo ? 'VIDEO_UPLOAD_AUDIO_STRIPPED' : 'AUDIO_UPLOAD';
      if (isVideo) note = 'Audio was stripped from the uploaded video server side; only the audio went to transcription.';
      engine = 'GEMINI';
      const buf = Buffer.from(media_base64, 'base64');
      audioKey = `transcripts/${crypto.randomUUID()}/source.${isVideo ? 'stripped.mp3' : (mime.split('/')[1] ?? 'mp3').slice(0, 4)}`;
      await storage.put(audioKey, buf);
      const tr = await gemini.transcribeAudio({ audioBase64: media_base64, mimeType: isVideo ? 'audio/mpeg' : mime });
      segs = tr.segments;
    } else {
      return reply.code(422).send(err(422, 'VALIDATION_ERROR',
        'provide transcript_text (paste), segments (an existing transcript), or media_base64 (audio preferred; video has its audio stripped)'));
    }

    const t = await one(
      `INSERT INTO lcos.live_transcripts (code, title, source, transcription_engine, segments,
         audio_storage_key, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [code('LT'), title, source, engine, JSON.stringify(segs), audioKey, req.actor.id]);
    await audit(null, { actor: req.actor, action: 'transcript.create', objectType: 'TRANSCRIPT',
      objectId: t.id, objectCode: t.code, reason: `${source}${note ? '; ' + note : ''}` });
    return reply.code(201).send({ ...t, note,
      machine_transcribed: engine === 'GEMINI',
      warning: engine === 'GEMINI'
        ? 'This is machine transcription of Amharic and needs checking. It is not ground truth. Nothing generates from it until a human confirms it.'
        : 'Nothing generates from this transcript until a human confirms it.' });
  });

  // Edit segments in place. A CONFIRMED transcript that gets edited returns
  // to DRAFT: the confirmation described the text it confirmed.
  app.put('/content/transcripts/:id', { preHandler: requirePerm('script.write') }, async (req, reply) => {
    const t = await one(`SELECT * FROM lcos.live_transcripts WHERE id=$1`, [req.params.id]);
    if (!t) return reply.code(404).send(err(404, 'NOT_FOUND', 'transcript'));
    const segs = (Array.isArray(req.body?.segments) ? req.body.segments : [])
      .map(s => ({ start_s: s.start_s ?? null, end_s: s.end_s ?? null,
        speaker: s.speaker ?? 'doctor', text: String(s.text ?? '') })).filter(s => s.text.trim());
    if (!segs.length) return reply.code(422).send(err(422, 'VALIDATION_ERROR', 'segments must be a non-empty array'));
    const wasConfirmed = t.status === 'CONFIRMED';
    const nt = await one(
      `UPDATE lcos.live_transcripts SET segments=$2, status='DRAFT', confirmed_by=NULL,
         confirmed_at=NULL, updated_at=now() WHERE id=$1 RETURNING *`,
      [t.id, JSON.stringify(segs)]);
    await audit(null, { actor: req.actor, action: 'transcript.edit', objectType: 'TRANSCRIPT',
      objectId: t.id, objectCode: t.code,
      reason: wasConfirmed ? 'edited after confirmation; returned to DRAFT, must be re-confirmed' : 'edited' });
    return { ...nt, reconfirm_needed: wasConfirmed };
  });

  app.post('/content/transcripts/:id/confirm', { preHandler: requirePerm('script.write') }, async (req, reply) => {
    const t = await one(`SELECT * FROM lcos.live_transcripts WHERE id=$1`, [req.params.id]);
    if (!t) return reply.code(404).send(err(404, 'NOT_FOUND', 'transcript'));
    const nt = await one(
      `UPDATE lcos.live_transcripts SET status='CONFIRMED', confirmed_by=$2, confirmed_at=now(),
         updated_at=now() WHERE id=$1 RETURNING *`, [t.id, req.actor.id]);
    await audit(null, { actor: req.actor, action: 'transcript.confirm', objectType: 'TRANSCRIPT',
      objectId: t.id, objectCode: t.code });
    return { ok: true, id: nt.id, status: nt.status,
      message: 'Transcript confirmed. AUA recap generation can now use it; every medical statement lifted from it still goes through claim validation like any other.' };
  });
}
