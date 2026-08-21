// Letena Content OS admin UI. No build step: vanilla ES modules, hash routing,
// EMR design language. Served by the API process.
const API = '/api/v1';
let TOKEN = sessionStorage.getItem('lcos_token');
let ME = JSON.parse(sessionStorage.getItem('lcos_me') || 'null');

const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
// Auto-grow textareas so a long bilingual line (Amharic + English together,
// the normal shape of a script field) is fully visible without an internal
// scrollbar. Rudy flagged 18 Aug 2026 that she had to scroll inside the
// Hook/Spoken script/CTA boxes on the script editor to read both languages
// at once — a fixed-height textarea is the wrong control for text whose
// length is unpredictable and often doubles because of the bilingual
// convention. Grows on typing, and on every screen render, since screens
// are swapped wholesale via innerHTML rather than individual textareas
// being mounted/unmounted, so a plain one-time pass at load would miss
// every navigation after the first.
function autoGrowTextarea(el) {
  el.style.height = 'auto';
  el.style.height = (el.scrollHeight + 2) + 'px';
}
document.addEventListener('input', (e) => {
  if (e.target.tagName === 'TEXTAREA') autoGrowTextarea(e.target);
});
new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (node.tagName === 'TEXTAREA') autoGrowTextarea(node);
      node.querySelectorAll?.('textarea').forEach(autoGrowTextarea);
    }
  }
}).observe(app, { childList: true, subtree: true });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pill = (v) => v ? `<span class="pill p-${esc(v)}"><span class="d"></span>${esc(String(v).replace(/_/g, ' '))}</span>` : '';
const chan = (v) => v ? `<span class="ch ch-${esc(v)}">${esc(v.replace('_COMMENT',''))}</span>` : '';
// English-first bilingual text: prefer translation_en, keep the Amharic original
// one tap away behind a small chip. Never breaks when either field is missing.
const biText = (original, en) => {
  const o = String(original ?? '').trim();
  const e = String(en ?? '').trim();
  if (!o && !e) return '<span class="muted">No text captured</span>';
  if (!e || e === o) return esc(o || e);
  if (!o) return esc(e);
  return `<span class="bi" data-bi><span class="bi-en">${esc(e)}</span>` +
    `<span class="bi-am amharic" hidden>${esc(o)}</span>` +
    `<button type="button" class="amchip" data-amtoggle="1" aria-pressed="false" title="Show the original Amharic">አማ</button></span>`;
};
const empty = (cols, msg) => `<tr><td colspan="${cols}" class="empty">${msg}</td></tr>`;
const dt = (v) => v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
// The Produce action for an APPROVED script (19 Aug 2026): production.mjs's
// createProductionJob refuses any VIDEO-kind script outright now that
// HeyGen/Creatomate are retired, so a VIDEO-kind row here has to offer
// something that actually works instead of a button that just 422s. body_kind
// (added to GET /content/scripts and GET /distribution/queue's to_produce
// list, see content.mjs/distribution.mjs) is the same createProductionJob
// fallback (registry body_kind, else legacy video_family), computed once
// server-side so this stays a plain render, no client-side format lookup.
function produceButtonHtml(s) {
  if (s.body_kind === 'VIDEO') {
    return can('studio.write')
      ? `<a class="btn" href="#/studio-from-script/${esc(s.id)}">Start Video Studio project</a>` : '';
  }
  return can('production.request') ? `<button data-produce="${esc(s.id)}">Produce</button>` : '';
}
// Video Studio brief import (19 Aug 2026): a readable render of the draft
// POST /studio/projects/:id/import-brief returns -- the one presenter
// shot's voiceover, every overlay's kind/timing/colors, the caption draft,
// and any clarifying notes -- mirroring the "st-lock-draftnote" pattern the
// lock drafter already uses for its own clarifying_note. Kept in one place
// since it's rendered fresh every time Draft from this brief runs.
function renderBriefDraft(draft, projectId) {
  const s = draft.presenter_shot ?? {};
  const overlayRow = (o) => {
    const d = o.data ?? {};
    const colorBits = [d.text_color ? `text ${d.text_color}` : null, d.background_color ? `bg ${d.background_color}` : null]
      .filter(Boolean).join(' &middot; ');
    const lines = Array.isArray(d.lines)
      ? `<div class="muted" style="font-size:12px;margin-top:2px">${d.lines.map(l =>
          `${esc(l.text ?? '')} (${esc(String(l.font_size_px ?? ''))}px, ${esc(l.text_color ?? '')}, +${esc(String(l.delay_s ?? '0'))}s)`).join('<br>')}</div>`
      : '';
    return `<div class="claimrow" style="margin-top:8px">
      <div class="flex"><b>${esc(o.kind ?? '')}</b>
        <span class="mono muted">${esc(String(o.start_s ?? ''))}s&ndash;${esc(String(o.end_s ?? ''))}s</span>
        ${colorBits ? `<span class="muted" style="font-size:12px">${colorBits}</span>` : ''}</div>
      ${d.text ? `<div style="margin-top:4px">${esc(d.text)}</div>` : ''}
      ${lines}
      ${o.kind === 'ICON' && d.description ? `<div class="muted" style="font-size:12px;margin-top:2px">${esc(d.description)}</div>` : ''}
      ${o.note ? `<div class="claimrow" style="border-left-color:var(--risk-mod);margin-top:6px;font-size:12px">${esc(o.note)}</div>` : ''}
    </div>`;
  };
  return `
    <div class="claimrow"><div class="eyebrow" style="margin-bottom:4px">Presenter shot (one continuous take)</div>
      <div class="muted" style="font-size:12px">Duration target: ${esc(String(s.duration_target_s ?? '?'))}s</div>
      ${s.story?.beat ? `<div style="margin-top:6px">${esc(s.story.beat)}</div>` : ''}
      ${s.audio?.dialogue ? `<div class="amharic" style="margin-top:6px">${esc(s.audio.dialogue)}</div>` : ''}
      ${s.audio?.dialogue_en_gloss ? `<div class="muted" style="font-size:12px;margin-top:4px">${esc(s.audio.dialogue_en_gloss)}</div>` : ''}
      ${s.note ? `<div class="claimrow" style="border-left-color:var(--risk-mod);margin-top:8px;font-size:12px">${esc(s.note)}</div>` : ''}
    </div>
    <div class="eyebrow" style="margin-top:14px;margin-bottom:4px">Overlays (${(draft.overlays ?? []).length})</div>
    ${(draft.overlays ?? []).length ? (draft.overlays ?? []).map(overlayRow).join('') : '<div class="muted" style="font-size:12px">No overlays drafted.</div>'}
    ${draft.caption_draft ? `<div class="eyebrow" style="margin-top:14px;margin-bottom:4px">Caption draft</div>
      <div class="claimrow" style="white-space:pre-wrap">${esc(draft.caption_draft)}</div>` : ''}
    ${draft.clarifying_note ? `<div class="claimrow" id="st-brief-draftnote" style="border-left-color:var(--risk-mod);margin-top:12px;font-size:12px">${esc(draft.clarifying_note)}</div>` : ''}
    <label style="margin-top:12px;display:block">Draft (JSON) -- edit anything before applying</label>
    <textarea id="st-brief-draftjson" rows="10">${esc(JSON.stringify(draft, null, 2))}</textarea>
    <div style="margin-top:10px"><button class="primary" data-stbriefapply="${esc(projectId)}">Apply draft</button></div>`;
}
// Video Studio script import (19 Aug 2026): a readable render of the draft
// POST /studio/projects/from-script/draft returns -- one or more shots
// (never forced to one, unlike renderBriefDraft's fixed single presenter
// shot above), their overlays, and for every continuity entity the draft
// names, a reuse-or-draft-new choice against whatever approved lock the
// draft endpoint's GLOBAL search already found. `payload` is the endpoint's
// full response: either { existing_project } (this script already has a
// project -- nothing left to draft) or { draft, reuse_candidates, script }.
function renderScriptImportDraft(payload, scriptId) {
  if (payload.existing_project) {
    const p = payload.existing_project;
    return `<div class="claimrow" style="margin-top:8px">This script already has a Video Studio project -- nothing new was drafted.</div>
      <div style="margin-top:10px"><a class="btn primary" href="#/studio-project/${esc(p.id)}">Open ${esc(p.code)} &rarr;</a></div>`;
  }
  const draft = payload.draft;
  const reuseCandidates = payload.reuse_candidates ?? [];
  const shotRow = (s, i) => `<div class="claimrow" style="margin-top:8px">
      <div class="flex"><b>Shot ${i + 1}${s.shot_code ? ` &middot; ${esc(s.shot_code)}` : ''}</b>
        <span class="mono muted">${esc(String(s.duration_target_s ?? '?'))}s</span></div>
      ${s.story?.beat ? `<div style="margin-top:4px">${esc(s.story.beat)}</div>` : ''}
      ${s.audio?.dialogue ? `<div class="amharic" style="margin-top:6px">${esc(s.audio.dialogue)}</div>` : ''}
      ${s.continuity?.characters?.length ? `<div class="muted" style="font-size:12px;margin-top:4px">Characters: ${s.continuity.characters.map(c => esc(c)).join(', ')}</div>` : ''}
      ${s.note ? `<div class="claimrow" style="border-left-color:var(--risk-mod);margin-top:6px;font-size:12px">${esc(s.note)}</div>` : ''}
    </div>`;
  const overlayRow = (o) => {
    const d = o.data ?? {};
    const colorBits = [d.text_color ? `text ${d.text_color}` : null, d.background_color ? `bg ${d.background_color}` : null]
      .filter(Boolean).join(' &middot; ');
    const lines = Array.isArray(d.lines)
      ? `<div class="muted" style="font-size:12px;margin-top:2px">${d.lines.map(l =>
          `${esc(l.text ?? '')} (${esc(String(l.font_size_px ?? ''))}px, ${esc(l.text_color ?? '')})`).join('<br>')}</div>`
      : '';
    return `<div class="claimrow" style="margin-top:8px">
      <div class="flex"><b>${esc(o.kind ?? '')}</b>
        <span class="mono muted">${esc(String(o.start_s ?? ''))}s&ndash;${esc(String(o.end_s ?? ''))}s</span>
        ${colorBits ? `<span class="muted" style="font-size:12px">${colorBits}</span>` : ''}</div>
      ${d.text ? `<div style="margin-top:4px">${esc(d.text)}</div>` : ''}
      ${lines}
      ${o.note ? `<div class="claimrow" style="border-left-color:var(--risk-mod);margin-top:6px;font-size:12px">${esc(o.note)}</div>` : ''}
    </div>`;
  };
  // One row per entity_codes_needed: a reuse/draft-new radio pair when a
  // candidate was found, or a plain note when none was -- exactly the
  // human decision the apply endpoint's reuse_locks array records. The
  // hidden input carries the chosen candidate's source_lock_id so the
  // apply handler can read it straight off the DOM without re-fetching.
  const entityRows = (draft.entity_codes_needed ?? []).map(code => {
    const rc = reuseCandidates.find(r => r.entity_code === code)?.candidate;
    return `<div class="claimrow" style="margin-top:8px">
      <div class="mono"><b>${esc(code)}</b></div>
      ${rc
        ? `<label style="display:block;margin-top:4px;font-weight:400">
             <input type="radio" name="st-reuse-${esc(code)}" value="reuse" checked>
             Reuse ${esc(rc.project_code)}'s ${esc(rc.entity_type)} (v${esc(String(rc.version))})</label>
           <label style="display:block;font-weight:400">
             <input type="radio" name="st-reuse-${esc(code)}" value="new"> Draft new instead</label>
           <input type="hidden" class="st-reuse-lockid" data-entitycode="${esc(code)}" value="${esc(rc.source_lock_id)}">`
        : `<div class="muted" style="font-size:12px;margin-top:2px">No existing approved lock found for this entity -- create one from the new project's own Locks section once it exists.</div>`}
    </div>`;
  }).join('');
  return `
    <div class="eyebrow" style="margin-top:4px">Project</div>
    <div class="grid2">
      <div><label>Title</label><input id="st-script-title" value="${esc(draft.project?.title ?? '')}"></div>
      <div><label>Aspect ratio</label><input id="st-script-aspect" value="${esc(draft.project?.aspect_ratio ?? '9:16')}"></div>
    </div>
    <div class="eyebrow" style="margin-top:14px">Shots (${draft.shots.length})</div>
    ${draft.shots.map(shotRow).join('')}
    <div class="eyebrow" style="margin-top:14px">Overlays (${(draft.overlays ?? []).length})</div>
    ${(draft.overlays ?? []).length ? draft.overlays.map(overlayRow).join('') : '<div class="muted" style="font-size:12px">No overlays drafted.</div>'}
    ${entityRows ? `<div class="eyebrow" style="margin-top:14px">Continuity entities</div>${entityRows}` : ''}
    ${draft.caption_draft ? `<div class="eyebrow" style="margin-top:14px;margin-bottom:4px">Caption draft</div>
      <div class="claimrow" style="white-space:pre-wrap">${esc(draft.caption_draft)}</div>` : ''}
    ${draft.clarifying_note ? `<div class="claimrow" style="border-left-color:var(--risk-mod);margin-top:12px;font-size:12px">${esc(draft.clarifying_note)}</div>` : ''}
    <label style="margin-top:12px;display:block">Draft (JSON) -- edit anything before applying</label>
    <textarea id="st-script-draftjson" rows="14">${esc(JSON.stringify(draft, null, 2))}</textarea>
    <div style="margin-top:10px"><button class="primary" data-stscriptapply="${esc(scriptId)}">Apply draft</button></div>`;
}
// In-page image preview (owner request, 21 Aug 2026: "cant we have an
// inpage preview or does the image have to pop up as a new page (maybe
// that or download can be an option)"). Every reference thumbnail used to
// be wrapped in a target="_blank" link, which threw the reviewer out of
// the studio into a bare image tab and lost their scroll position. This
// opens the full-size image over the page instead, and offers BOTH of the
// old behaviours as explicit buttons: download, or open in a new tab.
//
// Built with inline styles and no markup in index.html on purpose, so the
// whole feature lives in this one function and nothing else has to change
// to adopt it. Esc closes, as does clicking the backdrop.
function imagePreview(url, caption) {
  if (!url) return;
  document.getElementById('img-lightbox')?.remove();
  const wrap = document.createElement('div');
  wrap.id = 'img-lightbox';
  wrap.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(12,12,16,.86);' +
    'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px';
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:8px;align-items:center;color:#fff;font-size:12px;max-width:92vw';
  const label = document.createElement('span');
  label.textContent = caption || '';
  label.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.85';
  const mkBtn = (text, fn) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.style.cssText = 'font-size:12px;padding:4px 10px;cursor:pointer';
    b.onclick = (ev) => { ev.stopPropagation(); fn(); };
    return b;
  };
  const dl = document.createElement('a');
  dl.href = url; dl.download = ''; dl.textContent = 'Download';
  dl.style.cssText = 'font-size:12px;padding:4px 10px;background:#fff;color:#111;border-radius:4px;text-decoration:none';
  dl.onclick = (ev) => ev.stopPropagation();
  bar.append(label, dl,
    mkBtn('Open in new tab', () => window.open(url, '_blank', 'noopener')),
    mkBtn('Close', () => wrap.remove()));
  const img = document.createElement('img');
  img.src = url;
  img.style.cssText = 'max-width:92vw;max-height:78vh;border-radius:8px;box-shadow:0 10px 40px rgba(0,0,0,.5);background:#fff';
  img.onclick = (ev) => ev.stopPropagation();
  wrap.append(bar, img);
  wrap.onclick = () => wrap.remove();
  const onKey = (ev) => { if (ev.key === 'Escape') { wrap.remove(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  document.body.appendChild(wrap);
}
window.imagePreview = imagePreview;

// kind: false/undefined = normal, true = error (red, 5s), 'warn' = informational
// flag (amber, 5s) -- used for non-blocking notices like platform-spec warnings.
const toast = (msg, kind = false) => {
  const t = $('#toast'); t.textContent = msg;
  t.className = 'show' + (kind === 'warn' ? ' warn' : kind ? ' err' : '');
  setTimeout(() => t.className = '', kind ? 5000 : 2600);
};

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method, headers: { 'Content-Type': 'application/json',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/auth')) { logout(); throw new Error('Session expired'); }
  if (!res.ok) throw Object.assign(new Error(data.detail || data.title || res.statusText), { data });
  return data;
}
const can = (p) => ME?.permissions?.includes(p);
const isAdmin = () => !!ME?.roles?.includes('admin');
function logout() { sessionStorage.clear(); TOKEN = null; ME = null; render(); }
// Style-lint findings on a script version (apps/api/src/ai/style_lint.mjs):
// mechanical house-style flags (em dash, hedge phrases, AI sign-offs). Never
// blocks; a reviewer just gets to see them before approving.
const styleWarnHtml = (warnings) => (Array.isArray(warnings) && warnings.length)
  ? `<div class="claimrow bad" style="border-left-color:var(--risk-mod)"><b>Style check flagged this draft</b><br>
      ${warnings.map(w => esc(w)).join('<br>')}</div>` : '';
// Cheap code->id lookup for screens whose list endpoints only carry a
// knowledge card's code (views built before drill-down existed), so rows can
// still link to the real card detail screen. Swallows a 403 quietly -- a
// user without knowledge.read simply sees non-clickable rows there.
// A piece is not always a video. Show the body it actually has: slides for a
// carousel, a headline and supporting line for a static graphic, post text
// for a Telegram post. Before 0018 every script carried a spoken_script and
// the page said "Spoken:" over it regardless of what was going to be made.
const FMT_LABEL = { VIDEO: 'Video script', CAROUSEL: 'Carousel slides',
  STATIC: 'Static graphic', POST: 'Post text' };
function fmtLabel(f) { return FMT_LABEL[f] ?? 'Script'; }

function scriptBody(v) {
  if (!v) return '';
  const f = v.format ?? 'VIDEO';
  if (f === 'CAROUSEL') {
    const slides = Array.isArray(v.carousel_slides) ? v.carousel_slides : [];
    if (!slides.length) return '<span class="muted">No slides.</span>';
    return slides.map((sl, i) => `<div class="slide"><div class="slide-n">${i + 1}</div>
      <div><b>${esc(sl.title ?? '')}</b><div>${esc(sl.body ?? '')}</div></div></div>`).join('');
  }
  if (f === 'STATIC') {
    const g = v.static_graphic;
    if (!g) return '<span class="muted">No graphic copy.</span>';
    return `<div class="statichead">${esc(g.headline ?? '')}</div>
      <div>${esc(g.body ?? '')}</div>
      ${g.footer ? `<div class="muted" style="margin-top:6px">${esc(g.footer)}</div>` : ''}`;
  }
  if (f === 'POST') {
    return v.post_text
      ? `<div class="posttext">${esc(v.post_text)}</div>`
      : '<span class="muted">No post text.</span>';
  }
  return `<b>Spoken:</b><br>${esc(v.spoken_script ?? '')}`;
}

// Sparkline: one series per topic, so no categorical palette and no legend
// (the row label carries identity). History sits in a de-emphasised hue and
// the current period takes the accent, which is the only thing colour is
// doing here. Bars get a rounded data-end and a square baseline, separated
// by 2px of surface rather than a stroke. An empty bucket draws a floor stub
// rather than nothing, so a quiet week reads as zero instead of a gap.
function sparkline(series, w = 132, h = 30) {
  if (!series?.length) return '<span class="muted">—</span>';
  const n = series.length;
  const gap = 2;
  const bw = Math.max(2, (w - gap * (n - 1)) / n);
  const max = Math.max(1, ...series.map(d => d.n));
  const bars = series.map((d, i) => {
    const x = i * (bw + gap);
    const bh = d.n > 0 ? Math.max(2, Math.round((d.n / max) * (h - 2))) : 1;
    const y = h - bh;
    const r = Math.min(4, bw / 2, bh);
    const path = `M${x},${h} L${x},${y + r} Q${x},${y} ${x + r},${y} `
      + `L${x + bw - r},${y} Q${x + bw},${y} ${x + bw},${y + r} L${x + bw},${h} Z`;
    const isNow = i === n - 1;
    const fill = d.n === 0 ? 'var(--line)' : isNow ? 'var(--plump-purple)' : '#C7C0DC';
    return `<path d="${path}" fill="${fill}"><title>${esc(String(d.bucket_start).slice(0, 10))}: `
      + `${d.n} question${d.n === 1 ? '' : 's'}</title></path>`;
  }).join('');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" class="spark">${bars}</svg>`;
}

async function cardCodeMap() {
  try { return new Map((await api('GET', '/knowledge/cards')).items.map(c => [c.code, c.id])); }
  catch { return new Map(); }
}

// ---------- Part 2 guided-flow helpers (14 Aug 2026) ----------
// Media previews: the storage adapter's file:// URLs cannot load in a
// browser, so previews stream through the authenticated media route. The
// token rides as a query parameter because <img>/<video> cannot send an
// Authorization header.
const mediaUrl = (key) => key ? `/api/v1/media/${key.split('/').map(encodeURIComponent).join('/')}?token=${encodeURIComponent(TOKEN)}` : null;

// A thumbnail for any asset kind: a still shows, a video plays on hover,
// audio gets a player, anything else gets a labelled tile. Nobody browses a
// reference library as a list of codes.
// A broken thumbnail URL used to fall through to the browser's bare
// broken-image glyph (Phase 1 finding, half the seeded library did this).
// This swaps it for the same quiet placeholder .ath.none already uses for
// assets with no media at all, so a bad URL degrades gracefully instead
// of looking like the app itself is broken.
window.assetImgError = function (img, kind) {
  const div = document.createElement('div');
  div.className = 'ath none';
  div.textContent = kind;
  img.replaceWith(div);
};
function assetThumb(a) {
  const u = mediaUrl(a.storage_key);
  const mt = a.mime_type ?? '';
  if (!u) return `<div class="ath none">${esc(a.kind)}</div>`;
  if (mt.startsWith('image/')) return `<img class="ath" style="cursor:zoom-in" src="${esc(u)}" alt="${esc(a.title)}" loading="lazy" title="Click to preview" onclick="imagePreview('${esc(u)}', ${JSON.stringify(a.title ?? '').replace(/"/g, '&quot;')})" onerror="assetImgError(this,'${esc(a.kind)}')">`;
  if (mt.startsWith('video/')) return `<video class="ath" src="${esc(u)}" muted loop playsinline preload="metadata"
    onmouseover="this.play().catch(()=>{})" onmouseout="this.pause()"></video>`;
  if (mt.startsWith('audio/')) return `<div class="ath audio">&#9835;<audio controls preload="none" src="${esc(u)}"></audio></div>`;
  return `<div class="ath none">${esc(a.kind)}</div>`;
}

// Who signs each gate, in words. Roles only, resolved at runtime server
// side; these are labels for roles, never people.
const GATE_ROLE_LABEL = {
  plan: 'the content lead', script: 'the content lead',
  medical_review: 'a Letena doctor', clinical_signoff: 'the medical director',
  produce: 'the producer', shoot: 'the producer', edit: 'the producer',
  approve: 'the content lead', publish: 'the social lead',
  repurpose: 'the content lead', measure: 'the content lead',
};

// The approval sequence, made visible (owner: walked through it, told what
// is about to happen, kept updated "like a delivery app"). Six steps from
// English to production; each resolves to done / current / todo from the
// script's own state so Girum never has to ask what happens next.
function flowStepper(s) {
  const gates = new Set((s.gates ?? []).map(g => g.gate));
  const t = s.translation;
  const langApproved = t && t.status === 'APPROVED';
  const medicalDone = gates.has('medical_review') && (!s.needs_clinical_signoff || gates.has('clinical_signoff'));
  const steps = [
    ['English written', !!s.version, 'The writer fills the body this format actually has.'],
    ['Content approval', gates.has('script') || s.status === 'APPROVED' || medicalDone,
      'The content lead reads the English: right piece, right hook, right CTA.'],
    [s.needs_clinical_signoff ? 'Medical review + clinical sign-off' : 'Medical review', medicalDone,
      s.needs_clinical_signoff
        ? 'A Letena doctor signs the English, AND the medical director signs the clinical sign-off: this piece is abortion-adjacent and cannot advance without both.'
        : 'A Letena doctor signs the English. Catches a wrong claim before any Amharic exists.'],
    ['Amharic written', !!t, 'Written from the approved English, then blind back-translated and drift scored.'],
    ['Language approval', langApproved,
      'The language editor reads the Amharic beside the English and the back-translation. This is where a meaning shift introduced in translation gets caught.'],
    ['Final approve, then production', s.status === 'APPROVED' && langApproved,
      'Then the production plan shows its steps and costs before anything is spent.'],
  ];
  let currentSeen = false;
  return `<div class="flowbar">${steps.map(([label, done, why]) => {
    const state = done ? 'done' : currentSeen ? 'todo' : (currentSeen = true, 'now');
    return `<div class="fstep ${state}" title="${esc(why)}"><span class="fdot"></span>${esc(label)}</div>`;
  }).join('<span class="farrow">&rarr;</span>')}</div>`;
}

// Everything in flight, by stage, showing what is waiting on whom. Blocked
// items surface first inside each stage. Every card names its next action;
// nothing here is a dead end. Extracted 15 Aug 2026 so the merged Today
// screen and the #/board alias render the identical thing from one place.
function boardHtml(b) {
  const blockedCount = Object.values(b.stages).flat().filter(x => !x.can_advance && x.advance_block !== 'This piece is at its final stage.').length;
  const cols = b.stage_order.map(stage => {
    const items = [...(b.stages[stage] ?? [])].sort((x, y) => Number(x.can_advance) - Number(y.can_advance));
    if (!items.length) return '';
    return `<div class="bcol"><div class="bhead">${esc(stage.replace(/_/g, ' '))} <span class="muted">${items.length}</span></div>
      ${items.map(x => `<div class="bitem ${!x.can_advance ? 'blocked' : ''}" data-nav="script/${esc(x.id)}" tabindex="0" role="link">
        <div class="flex"><span class="mono" style="font-size:11px">${esc(x.code)}</span>
          ${pill(x.risk_tier)}${x.needs_clinical_signoff ? '<span class="pill p-TIER_4"><span class="d"></span>clinical</span>' : ''}</div>
        <div style="font-size:12.5px;margin:3px 0">${esc((x.title ?? '').slice(0, 70))}</div>
        <div class="muted" style="font-size:11px">${esc(x.format_label ?? x.format_code ?? '')}</div>
        <div style="font-size:11.5px;margin-top:5px;${x.can_advance ? 'color:var(--risk-routine)' : 'color:var(--risk-mod)'}">
          ${x.can_advance
            ? `Ready: next is ${esc((x.next_stage ?? '').replace(/_/g, ' '))}`
            : esc(x.advance_block ?? '')}</div>
      </div>`).join('')}</div>`;
  }).join('');
  return `<div class="eyebrow" style="margin-top:6px">The board</div>
    <div class="sub" style="margin-top:-2px">Everything in flight. ${blockedCount ? `<b>${blockedCount} piece${blockedCount === 1 ? ' is' : 's are'} waiting on someone</b>, shown first in each column.` : 'Nothing is blocked right now.'} Click a card to open the piece.</div>
    <div class="board">${cols || '<div class="card empty">Nothing in flight. Start on the Make screen.</div>'}</div>`;
}

// Drift, in words rather than a bare number. Thresholds mirror the
// translation.drift_threshold setting (0.12 routes to a human).
function driftWords(score) {
  const d = Number(score);
  if (d <= 0.05) return ['very close', 'The back-translation almost restates the English. Meaning is intact.'];
  if (d <= 0.12) return ['acceptable', 'Small wording differences. Read the highlighted spots before approving.'];
  return ['high drift', 'The back-translation diverges from the English. A meaning shift may be hiding in the highlights. Do not approve without checking them.'];
}

// Word-level divergence between the English source and the blind
// back-translation: exactly where a meaning shift hides. Cheap set diff,
// deliberately: it OVER-marks (inflections read as differences), which errs
// toward the reviewer looking twice rather than a shifted phrase passing
// unmarked.
function diffMark(source, target) {
  const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const src = new Set(String(source ?? '').split(/\s+/).map(norm).filter(Boolean));
  return String(target ?? '').split(/(\s+)/).map(tok => {
    const n = norm(tok);
    if (!n || /^\s+$/.test(tok)) return esc(tok);
    return src.has(n) ? esc(tok) : `<mark>${esc(tok)}</mark>`;
  }).join('');
}

// One-shot notices that must survive a re-render: the edit classification
// sentence shown at the moment of saving, per script.
const FLASH = new Map();
function takeFlash(key) { const v = FLASH.get(key); FLASH.delete(key); return v; }

// The Make screen's selections survive re-renders within the session.
const MAKE = { cardId: null, formats: new Set(), audience: 'WOMEN', path: 'DIGITAL',
  transcriptId: null, running: false };

// The production progress poll: one timer, cleared on every route change.
let POLL = null;

// The English text of a version, assembled client-side for the Amharic
// side-by-side. Mirrors the server's bodyTextOf() closely enough to read
// against; the server remains the authority for validation.
function versionEnglishText(v) {
  if (!v) return '';
  const parts = [v.hook, v.spoken_script, v.post_text];
  for (const sl of v.carousel_slides ?? []) parts.push(sl?.title, sl?.body);
  const g = v.static_graphic; if (g) parts.push(g.headline, g.body, g.footer);
  const walk = (n) => { if (n == null) return;
    if (typeof n === 'string') parts.push(n);
    else if (Array.isArray(n)) n.forEach(walk);
    else if (typeof n === 'object') Object.values(n).forEach(walk); };
  walk(v.body);
  parts.push(v.cta);
  return parts.filter(x => typeof x === 'string' && x.trim()).join(' ');
}

// ---------- navigation ----------
// Restructured 14 Aug 2026 (Nate: "I think some of these menu nav items would
// serve better as tabs on one page. The menu has no flow or understanding").
// Was 22 flat links across 7 groups named after schema sections (Audience
// intelligence, Content factory, Distribution), which meant: everything
// looked equally important whether you opened it hourly or never; three
// levels of one object (family > concept > script) each held a top-level
// slot though you only ever reach a concept from a script; the three
// measurement screens were split across two groups; and two separate pairs
// of screens shared a name. "Coverage gaps" (topics with demand and no
// content) sat four items away from "Knowledge gaps" (facts a writer needed
// and could not get approved), and "Queue" (human review) sat one group
// above "Production queue" (renders in flight).
//
// Now 8 sections in pipeline order, each holding its screens as tabs.
// Owner decision on the ordering (Nate, 14 Aug): a flat list in pipeline
// order, NOT grouped by how often each is opened.
//
// Deliberately NOT a rewrite of any screen: every route id below is the
// same route that existed before, so screens.* are untouched, the router is
// untouched, and every existing link, bookmark and data-nav drill-down
// still resolves exactly as it did. This is grouping and labelling only.
// Today and Board merged into one command-center screen 15 Aug 2026, per the
// redesign's Phase 1 finding: they answer the same morning question ("what
// should I make, is it any good, is it out yet") and splitting them into two
// tabs made Girum check two screens for one answer. #/board keeps working
// (bookmarks, the Make screen's post-generation link) as an alias to the
// same merged render; see DETAIL_SECTION below for how it still lights the
// right sidebar item.
const SECTIONS = [
  ['today',      'Today',      [['dashboard', 'Today']]],
  ['plan',       'Plan',       [['demand', 'Demand'], ['make', 'Make content'], ['coverage', 'Gaps']]],
  ['questions',  'Questions',  [['questions', 'Inbox'], ['clusters', 'Clusters'],
                                ['quarantine', 'Quarantine']]],
  ['knowledge',  'Knowledge',  [['cards', 'Cards'], ['claims', 'Claims'],
                                ['sources', 'Sources'], ['terminology', 'Terminology'],
                                ['gaps', 'Missing facts']]],
  ['content',    'Content',    [['scripts', 'Scripts'], ['reviews', 'Review queue'],
                                ['transcripts', 'Transcripts'],
                                ['concepts', 'Concepts'], ['families', 'Families']]],
  ['production', 'Production', [['production', 'Progress'], ['assets', 'Assets']]],
  ['studio',     'Video Studio', [['studio', 'Projects']]],
  ['publishing', 'Publishing', [['calendar', 'Calendar'], ['published', 'Published']]],
  ['insights',   'Insights',   [['analytics', 'Performance'], ['experiments', 'Experiments'],
                                ['costs', 'Costs']]],
  ['admin',      'Admin',      [['users', 'Users & roles'], ['settings', 'Settings'],
                                ['audit', 'Audit log']]],
];

// Detail screens are not tabs, but still belong to a section so the sidebar
// keeps the right item lit while you are three clicks deep in a record.
const DETAIL_SECTION = {
  question: 'questions', card: 'knowledge', script: 'content', render: 'production',
  amharic: 'content', produce: 'production', transcript: 'content',
  board: 'today', 'studio-project': 'studio', 'studio-from-script': 'studio',
};

// route id -> [sectionId, sectionLabel, tabs]
const SECTION_OF = (() => {
  const m = new Map();
  for (const [id, label, tabs] of SECTIONS) {
    for (const [route] of tabs) m.set(route, [id, label, tabs]);
  }
  return m;
})();

function sectionFor(route) {
  if (SECTION_OF.has(route)) return SECTION_OF.get(route);
  const parent = DETAIL_SECTION[route];
  if (parent) return SECTIONS.filter(s => s[0] === parent).map(s => [s[0], s[1], s[2]])[0];
  return null;
}

// Tab strip for the active section, rendered above every screen. Hidden for
// single-screen sections (Today) and while inside a detail record, where the
// screen already carries its own back link and the tabs would be lying about
// where you are.
function tabsFor(route) {
  const sec = sectionFor(route);
  if (!sec) return '';
  const [, , tabs] = sec;
  if (tabs.length < 2 || !SECTION_OF.has(route)) return '';
  return `<div class="tabs">${tabs.map(([id, label]) =>
    `<a href="#/${id}" class="tab ${id === route ? 'on' : ''}">${label}</a>`).join('')}</div>`;
}

// Icon-and-label nav rows, grouped, per the Phase 1 finding that a flat
// list of eight text links reads as a placeholder next to the rest of the
// app. Minimal stroke icons (18x18, currentColor) so they inherit the
// on/hover color states for free. Grouping mirrors how Girum actually
// described his own workflow: what to make, the pipeline it moves through,
// the record behind it, then admin.
const NAV_ICON = {
  today: '<path d="M3 10.5 10 4l7 6.5"/><path d="M5 9v7h10V9"/>',
  plan: '<rect x="3" y="4" width="14" height="13" rx="2"/><path d="M3 8h14M7 2v4M13 2v4"/><path d="M6.5 11.5l1.7 1.7 3.3-3.6"/>',
  questions: '<path d="M3 4h14v9H8l-3.5 3V13H3z"/>',
  knowledge: '<path d="M4 3.5A1.5 1.5 0 0 1 5.5 2H15v14H5.5A1.5 1.5 0 0 0 4 17.5z"/><path d="M4 3.5v14"/>',
  content: '<rect x="2.5" y="3.5" width="15" height="13" rx="2"/><path d="M2.5 7h15M6.5 3.5v3.5"/>',
  production: '<path d="M2.5 6.5 10 2.5l7.5 4v7L10 17.5l-7.5-4z"/><path d="M2.5 6.5 10 10.5l7.5-4M10 10.5v7"/>',
  studio: '<path d="M2.5 6h11v8h-11z"/><path d="M13.5 8.5 17.5 6v8l-4-2.5z"/><path d="M2.5 6l1-2.5h2l-1 2.5M6.5 6l1-2.5h2l-1 2.5M10.5 6l1-2.5h2l-1 2.5"/>',
  publishing: '<path d="M17 3 2 9.5l6 2 2 6z"/><path d="M17 3 10 11.5"/>',
  insights: '<path d="M3 17V3M3 17h14"/><path d="M6 14V9M10 14V6M14 14v-3"/>',
  admin: '<circle cx="10" cy="10" r="2.5"/><path d="M10 3v2M10 15v2M17 10h-2M5 10H3M15.1 4.9l-1.4 1.4M6.3 13.7l-1.4 1.4M15.1 15.1l-1.4-1.4M6.3 6.3 4.9 4.9"/>',
};
const NAV_GROUPS = [
  ['Work', ['today', 'plan']],
  ['Pipeline', ['questions', 'knowledge', 'content', 'production', 'studio', 'publishing']],
  ['System', ['insights', 'admin']],
];
function shell(active, content) {
  const sec = sectionFor(active);
  const activeSection = sec ? sec[0] : null;
  const byId = new Map(SECTIONS.map(s => [s[0], s]));
  const navHtml = NAV_GROUPS.map(([grpLabel, ids]) => `
    <div class="navgrp">
      <div class="grp">${esc(grpLabel)}</div>
      ${ids.map(id => {
        const s = byId.get(id);
        if (!s) return '';
        const [sid, label, tabs] = s;
        return `<a href="#/${tabs[0][0]}" class="${sid === activeSection ? 'on' : ''}">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${NAV_ICON[sid] ?? ''}</svg>
          ${esc(label)}</a>`;
      }).join('')}
    </div>`).join('');
  return `<div id="shell">
    <div id="mtop"><button id="burger" aria-label="Open menu">&#9776;</button><span class="mark">letena<b>.</b>os</span></div>
    <div id="navveil"></div>
    <nav id="side">
      <div class="mark">letena<b>.</b>os</div>
      ${navHtml}
      <div class="navfoot">
        <div class="grp">${esc(ME?.full_name ?? '')}</div>
        <a href="#" id="logout">Sign out</a>
      </div>
    </nav>
    <main id="main">${tabsFor(active)}${content}</main>
  </div>`;
}

// Video Studio format catalog (18 Aug 2026). The backend's `format` column
// is free text with no enum/check constraint (studio.mjs just defaults it
// to 'ai_story' when omitted) -- there is no real vocabulary to validate
// against yet. This list exists purely so the New project form offers
// meaningful, labeled choices instead of a raw text box pre-filled with
// the DB's own internal default value. Slugs loosely follow the playbook's
// named format templates (section 23); 'ai_story' is kept as the default
// so it still reads clearly rather than as a stray underscored code.
const STUDIO_FORMATS = [
  { value: 'ai_story', label: 'General AI story', desc: 'A narrated or character-driven short with no fixed template -- the default for anything that does not fit a more specific format below.' },
  { value: 'ad', label: 'Ad', desc: 'A short performance or product ad built around a single message and a clear call to action.' },
  { value: 'psa', label: 'PSA', desc: 'A public service message: a health or safety fact delivered plainly, usually ending on the Letena door/CTA.' },
  { value: 'explainer', label: 'Explainer', desc: 'Walks through how something works or what to expect, step by step.' },
  { value: 'fable', label: 'Fable', desc: 'An animal or storybook tale with a moral, told through a character arc.' },
  { value: 'social_short', label: 'Social short', desc: 'A quick vertical clip built for one platform feed, hook-first.' },
  { value: 'interview', label: 'Interview', desc: 'A talking-head Q&A format, real or scripted.' },
  { value: 'promo', label: 'Promo', desc: 'Announces or launches something -- a service, an event, a new offering.' },
];

// Continuity lock catalog (18 Aug 2026). A "lock" is Video Studio's term
// for a reusable, versioned description of something that has to look the
// same across every shot it appears in -- a character's face and outfit, a
// location's colors, the overall visual style. Locks are read by
// compileStillPrompt() (apps/api/src/modules/studio.mjs) into the exact
// image-generation prompt, so the field names below are not just help
// text: they match what that function actually reads for each entity
// type. Getting them right in the JSON is what makes the generated
// reference image match.
const LOCK_LEVELS = [
  { value: 'L1_ENTITY', label: 'Entity (a character, place, or object)', desc: 'The one you’ll use almost every time: a specific character, environment, or prop that needs to look the same in every shot it’s in.' },
  { value: 'L0_PROJECT', label: 'Project-wide style', desc: 'Rules for the whole project at once: overall look, medium, palette. Usually just one of these per project (Entity type: STYLE).' },
  { value: 'L2_STATE', label: 'A state change mid-story', desc: 'Something that changes partway through, like a wardrobe change, an injury, or a shift from day to night.' },
  { value: 'L3_SEQUENCE', label: 'Sequence continuity', desc: 'Which way is screen-left/right, eyelines, geography across a run of shots. Rarely needed for a short piece.' },
];
const LOCK_ENTITY_TYPES = [
  { value: 'CHARACTER', label: 'Character',
    desc: 'A recurring person or character, so they look the same in every shot.',
    example: '{\n  "name": "Maya",\n  "apparent_age": "late 20s",\n  "silhouette": "tall, narrow shoulders",\n  "face": "oval face, dark eyes",\n  "hair": "chin-length black bob",\n  "wardrobe_variants": { "default": "ochre field jacket" },\n  "forbidden_drift": ["no earrings"]\n}' },
  { value: 'STYLE', label: 'Style',
    desc: 'The overall look of the project: illustration style, palette, how things move.',
    example: '{\n  "style_summary": "warm gouache illustration, soft edges",\n  "motion_grammar": "gentle, grounded"\n}' },
  { value: 'ENVIRONMENT', label: 'Environment',
    desc: 'A recurring location: its architecture, colors, time of day, weather.',
    example: '{\n  "architecture": "small clinic waiting room",\n  "palette": "warm neutrals",\n  "time": "late afternoon",\n  "weather": "clear"\n}' },
  { value: 'PROP', label: 'Prop',
    desc: 'A recurring object that needs to look consistent: its material, color, wear, scale.',
    example: '{\n  "material": "worn leather",\n  "color": "deep brown",\n  "wear": "scuffed edges",\n  "scale_reference": "fits in one hand"\n}' },
];

// ---------- screens ----------
const screens = {
  // Today and Board, merged (15 Aug 2026): tiles as a compact strip up top,
  // then the board as the main content, since both answer the same morning
  // question. #/board renders through this same function; see boardHtml().
  async dashboard() {
    const [d, b] = await Promise.all([
      api('GET', '/platform/dashboard'),
      api('GET', '/pipeline/board').catch(() => null),
    ]);
    const tiles = [
      ['questions_24h', 'Questions, 24h', '#/questions'],
      ['quarantine', 'In quarantine', '#/quarantine', d.quarantine > 0 ? 'warn' : ''],
      ['scripts_awaiting_review', 'Scripts in review', '#/reviews'],
      ['videos_rendering', 'Rendering', '#/production'],
      ['reviews_open', 'Open reviews', '#/reviews'],
      ['scheduled_posts', 'Scheduled posts', '#/published'],
      ['cards_due_review', 'Cards due review', '#/cards', d.cards_due_review > 0 ? 'warn' : ''],
      ['dead_letters', 'Dead letters', '#/audit', d.dead_letters > 0 ? 'bad' : ''],
    ];
    let gapsHtml = '';
    try {
      const gaps = await api('GET', '/demand/coverage-gaps');
      if (gaps.items.length) {
        const cardIds = await cardCodeMap();
        gapsHtml = `<div class="card"><div class="eyebrow">High demand, low coverage</div>
          <table><tr><th>Topic</th><th>Card</th><th>Questions 30d</th><th>Content 90d</th><th>State</th><th>Priority</th></tr>
          ${gaps.items.slice(0, 8).map(g => {
            const cardId = cardIds.get(g.card_code);
            return `<tr${cardId ? ` class="rowlink" data-nav="card/${cardId}" tabindex="0"` : ''}>
            <td>${esc(g.topic_name)}</td><td class="mono">${esc(g.card_code ?? '—')}</td>
            <td>${g.question_count_30d ?? 0}</td><td>${g.content_count_90d ?? 0}</td>
            <td>${pill(g.coverage_state)}</td><td><b>${Number(g.priority_score).toFixed(0)}</b></td></tr>`; }).join('')}
          </table></div>`;
      }
    } catch {}
    // Backlog/budget banners (15 Aug 2026): nothing here runs on its own.
    // These just tell someone it is time to act, replacing the automatic
    // classify sweep that used to spend money every 5 minutes unattended.
    let banners = '';
    if (d.pending_classification >= d.backlog_notify_threshold) {
      banners += `<div class="card warn"><b>${d.pending_classification}</b> questions are waiting to be classified
        (threshold: ${d.backlog_notify_threshold}). Nothing runs automatically.
        Go to <a href="#/clusters">Question clusters</a> and click "Classify pending questions" to pull a batch.</div>`;
    }
    if (d.ai_budget?.capped) {
      banners += `<div class="card bad"><b>AI budget cap reached today:</b> $${d.ai_budget.spent_usd} of $${d.ai_budget.cap} spent.
        All AI calls are refused until tomorrow (UTC) or until the cap is raised in <a href="#/settings">Settings</a>.</div>`;
    } else if (d.ai_budget?.cap != null) {
      banners += `<div class="card"><div class="eyebrow">AI spend today</div>$${d.ai_budget.spent_usd} of $${d.ai_budget.cap} daily cap.</div>`;
    }
    return `<h1>Today</h1><div class="sub">Operational picture across the whole pipeline</div>
      ${banners}
      <div class="tiles">${tiles.map(([k, l, href, cls]) =>
        `<div class="tile ${cls ?? ''}" role="link" tabindex="0" data-nav="${href.slice(2)}">
          <div class="n">${d[k]}</div><div class="l">${l}</div></div>`).join('')}</div>
      ${b ? boardHtml(b) : ''}
      ${gapsHtml}`;
  },

  async questions() {
    const r = await api('GET', '/questions?limit=50');
    return `<h1>Questions</h1><div class="sub">De-identified audience questions from every channel. English shown first; the chip swaps to the original Amharic. Click a row for the full conversation.</div>
      ${r.pending_count ? `<div class="sub" style="margin-top:-6px">
        <b>${r.pending_count}</b> question${r.pending_count === 1 ? '' : 's'} still waiting to be classified,
        not yet in a cluster or the coverage gap board.
        Go to <a href="#/clusters">Question clusters</a> and run "Classify pending questions".</div>` : ''}
      <div class="card"><table>
      <tr><th>Question</th><th>Channel</th><th>Topic</th><th>Matched card</th><th>Status</th><th>Received</th><th></th></tr>
      ${(r.items ?? []).map(i => `<tr class="rowlink" data-nav="question/${esc(i.id)}" tabindex="0">
        <td style="max-width:380px">${biText(i.sanitized_text, i.translation_en)}</td>
        <td>${chan(i.channel)}</td>
        <td>${esc(i.topic_code ?? '—')}</td>
        <td class="mono">${esc(i.card_code ?? '—')}${i.match_confidence ? ` <span class="muted">${Math.round(i.match_confidence * 100)}%</span>` : ''}</td>
        <td>${pill(i.status)}</td><td class="muted">${dt(i.captured_at)}</td>
        <td>${can('question.turn_into_content') && i.status !== 'PURGED'
          ? `<button data-tic="${esc(i.id)}">Turn into content</button>` : ''}</td>
      </tr>`).join('') || empty(7, 'No questions yet. They will appear here as soon as the channels start talking.')}</table></div>`;
  },

  async question(id) {
    let d;
    try { d = await api('GET', `/questions/${id}`); }
    catch (ex) {
      return `<a class="backlink" href="#/questions">&larr; All questions</a>
        <h1>Question not found</h1>
        <div class="sub">It may have been purged, or the link is stale.</div>
        <div class="card empty">Nothing to show here. Head back to the questions list.</div>`;
    }
    const q = d?.question ?? {};
    const cls = d?.classification ?? null;
    const thread = Array.isArray(q.thread) ? q.thread : [];
    const hints = Array.isArray(q.category_hints) ? q.category_hints : [];
    const urgency = cls?.urgency ?? q.urgency_hint;
    const roleLabel = { patient: 'Patient', doctor: 'Doctor', note: 'Clinical note' };
    const bubbles = thread.map(m => {
      const role = ['patient', 'doctor', 'note'].includes(m?.role) ? m.role : 'note';
      return `<div class="bubble ${role}">
        <div class="who">${roleLabel[role]}</div>
        <div>${biText(m?.text, m?.translation_en)}</div></div>`;
    }).join('');
    const none = '<span class="muted">none</span>';
    return `<a class="backlink" href="#/questions">&larr; All questions</a>
      <div class="eyebrow">Question detail</div>
      <h1>What they asked</h1>
      <div class="sub flex">${chan(q.channel)} ${pill(q.status)} ${urgency ? pill(urgency) : ''}
        ${q.consult_mode ? `<span class="muted">${esc(String(q.consult_mode).replace(/_/g, ' ').toLowerCase())} consult</span>` : ''}
        ${q.captured_at ? `<span class="muted">${dt(q.captured_at)}</span>` : ''}</div>
      <div class="card"><div class="eyebrow">Opening question</div>
        <div style="font-size:14px;line-height:1.7">${biText(q.sanitized_text, q.translation_en)}</div>
        ${hints.length ? `<div class="flex" style="margin-top:10px">${hints.map(h =>
          `<span class="pill p-DRAFT"><span class="d"></span>${esc(h)}</span>`).join('')}</div>` : ''}
        ${q.deid_confidence != null ? `<div class="muted" style="font-size:11.5px;margin-top:8px">De-identification confidence ${Number(q.deid_confidence).toFixed(2)}</div>` : ''}
      </div>
      ${thread.length ? `<div class="card"><div class="eyebrow">Conversation</div>
        <div class="thread">${bubbles}</div></div>` : ''}
      ${q.answer_text ? `<div class="card answer"><div class="eyebrow">Doctor's final answer</div>
        <div style="line-height:1.7">${biText(q.answer_text, q.answer_translation_en)}</div></div>` : ''}
      <div class="card"><div class="eyebrow">Classification</div>
        ${cls ? `<div class="kv">
          <b>Topic</b> ${esc(cls.topic_code ?? '') || none}<br>
          <b>Intent</b> ${esc(String(cls.intent ?? '').replace(/_/g, ' ').toLowerCase()) || none}<br>
          <b>Urgency</b> ${cls.urgency ? pill(cls.urgency) : none}<br>
          <b>Matched card</b> <span class="mono">${esc(cls.knowledge_card_code ?? '') || none}</span>
          ${cls.match_confidence != null ? `<span class="muted">${Math.round(Number(cls.match_confidence) * 100)}% match</span>` : ''}
        </div>` : '<div class="muted">Not classified yet. Classification runs shortly after intake.</div>'}
      </div>
      ${can('question.turn_into_content') && q.id && q.status !== 'PURGED'
        ? `<div class="flex"><button class="primary" data-tic="${esc(q.id)}">Turn into content</button></div>` : ''}`;
  },

  async quarantine() {
    const r = await api('GET', '/questions/quarantine');
    return `<h1>Quarantine</h1><div class="sub">De-identification was not confident. Redact what remains, then release. Reject purges the text.</div>
      ${r.items.length === 0 ? '<div class="card empty">Quarantine is empty. That is the expected state.</div>' : ''}
      ${r.items.map(i => `<div class="card">
        <div class="flex"><span class="muted mono">${dt(i.captured_at)}</span>${chan(i.channel)}
          <span class="muted">confidence ${Number(i.deid_confidence).toFixed(2)}</span></div>
        ${i.translation_en ? `<div class="kv" style="margin-top:8px"><b>English translation</b>
          <div style="line-height:1.65">${esc(i.translation_en)}</div></div>` : ''}
        <label>Edit the original to remove anything identifying</label>
        <textarea id="rq-${i.id}">${esc(i.sanitized_text)}</textarea>
        <div class="flex" style="margin-top:8px">
          <button class="approve" data-redact="${i.id}">Release</button>
          <button class="danger" data-purge="${i.id}">Reject and purge</button>
        </div></div>`).join('')}`;
  },

  async clusters() {
    const r = await api('GET', '/clusters');
    const cardIds = await cardCodeMap();
    return `<h1>Question clusters</h1><div class="sub">Semantically similar questions, kept apart when answers differ. Click a matched cluster to open its card.</div>
      <div class="flex" style="margin-bottom:10px">
        ${can('cluster.manage') ? `<button id="classify-pending">Classify pending questions</button>
        <select id="classify-limit" style="width:auto;min-width:140px">
          <option value="100">100 at a time</option>
          <option value="250">250 at a time</option>
          <option value="500">500 at a time</option>
        </select>` : ''}
        <span class="muted">Groups the newest batch of unclassified questions into clusters. Bigger batches take longer per click (each question is a real AI call); run it a few times to work through a large backlog.</span></div>
      ${can('settings.manage') ? `<div class="flex" style="margin-bottom:10px">
        <button id="cleanup-requeue">Clean up junk and reclassify with current AI provider</button>
        <span class="muted">One-time: quarantines greetings/placeholder text already sitting in clusters (like "Selam" or "[legacy phone consult notes]"), and sends everything else back through classification so it uses whatever AI provider is set in Settings now, not whatever it used when it was first ingested.</span></div>` : ''}
      ${r.pending_count ? `<div class="sub" style="margin-top:-6px;margin-bottom:10px">
        <b>${r.pending_count}</b> question${r.pending_count === 1 ? '' : 's'} still pending classification.
        At 500 per click (the largest batch size), that is about ${Math.ceil(r.pending_count / 500)} more run${Math.ceil(r.pending_count / 500) === 1 ? '' : 's'}; more at smaller batch sizes.</div>`
        : `<div class="sub" style="margin-top:-6px;margin-bottom:10px">Nothing pending. Every ingested question has been classified.</div>`}
      <div class="card"><table>
      <tr><th>Cluster</th><th>Representative question</th><th>Topic</th><th>Card</th><th>Members</th><th>Last seen</th></tr>
      ${r.items.map(i => {
        const cardId = cardIds.get(i.card_code);
        return `<tr${cardId ? ` class="rowlink" data-nav="card/${cardId}" tabindex="0"` : ''}><td class="mono">${esc(i.code)}</td>
        <td style="max-width:360px">${esc(i.representative_question)}</td>
        <td>${esc(i.topic_code ?? '—')}</td><td class="mono">${esc(i.card_code ?? '—')}</td>
        <td><b>${i.member_count}</b></td><td class="muted">${dt(i.last_seen_at)}</td></tr>`; }).join('')}
      </table></div>`;
  },

  async coverage() {
    let items = [];
    try { items = (await api('GET', '/demand/coverage-gaps')).items; } catch {}
    const cardIds = await cardCodeMap();
    return `<h1>Coverage gaps</h1>
      <div class="sub">What Ethiopia is asking against what Letena has published. This board sets the calendar. Rows with a matched card open it.</div>
      <div class="flex" style="margin-bottom:10px">
        ${can('settings.manage') ? '<button id="recompute">Recompute now</button>' : ''}
        ${can('question.turn_into_content') ? '<button id="bulk-commission">Generate content now</button>' : ''}</div>
      <div class="sub">Generate content now runs the top 10 gap-flagged topics through the full output spread, unapproved cards included as test content (requires admin test mode on in Settings). Nothing it makes can publish until a card is approved or a human clears it in review.</div>
      <div class="card"><table>
      <tr><th>Topic</th><th>Card</th><th>Question</th><th>Questions 30d</th><th>Content 90d</th><th>State</th><th>Priority</th></tr>
      ${items.map(g => {
        const cardId = cardIds.get(g.card_code);
        return `<tr${cardId ? ` class="rowlink" data-nav="card/${cardId}" tabindex="0"` : ''}><td>${esc(g.topic_name)}</td><td class="mono">${esc(g.card_code ?? '—')}</td>
        <td style="max-width:300px">${esc(g.canonical_question_en ?? '—')}</td>
        <td>${g.question_count_30d ?? 0}</td><td>${g.content_count_90d ?? 0}</td>
        <td>${pill(g.coverage_state)}</td><td><b>${Number(g.priority_score).toFixed(0)}</b></td></tr>`; }).join('')
      || '<tr><td colspan=7 class="empty">No gap rows yet. Ingest questions and recompute.</td></tr>'}
      </table></div>`;
  },

  // Plan: what people are asking about over time, and start the content that
  // answers it, in the same place. Nate, 14 Aug 2026: "analyze our past
  // questions maybe by week/by month etc... then we can decide what topic,
  // and you can generate a script based on a question from that topic" and,
  // on finding the platform picker buried on the card page, "who cares if
  // its on the knowledge library card, if its not going to help me generate
  // a script in the way the system has it. Put it in the right place before
  // i choose to generate a script."
  //
  // So the decision and the action are one screen: demand trend, the cards
  // that answer each topic, and the platform picker at the moment of
  // choosing, not two sections away.
  async demand() {
    const bucket = (location.hash.split('?')[1] || '').includes('month') ? 'month' : 'week';
    const [trend, cards] = await Promise.all([
      api('GET', `/demand/trend?bucket=${bucket}&periods=12`),
      api('GET', '/knowledge/cards').catch(() => ({ items: [] })),
    ]);
    let outputTypes = [];
    try { outputTypes = (await api('GET', '/content/output-types')).items; } catch {}

    const cardsByTopic = new Map();
    for (const c of cards.items ?? []) {
      if (!cardsByTopic.has(c.topic_code)) cardsByTopic.set(c.topic_code, []);
      cardsByTopic.get(c.topic_code).push(c);
    }

    const range = trend.buckets?.length
      ? `${String(trend.buckets[0]).slice(0, 10)} to ${String(trend.buckets[trend.buckets.length - 1]).slice(0, 10)}`
      : '';
    const hasAny = (trend.items ?? []).some(t => t.total > 0);

    const rows = (trend.items ?? []).map(t => {
      const tcards = cardsByTopic.get(t.topic_code) ?? [];
      const approved = tcards.filter(c => c.status === 'APPROVED');
      const dir = t.direction === 'UP' ? '<span class="trend-up">rising</span>'
        : t.direction === 'DOWN' ? '<span class="trend-down">falling</span>'
        : '<span class="muted">steady</span>';
      const gen = outputTypes.length && can('question.turn_into_content') && tcards.length
        ? `<details class="genbox"><summary>Make content</summary>
            <div class="genpanel">
              <div class="muted" style="font-size:12px;margin-bottom:8px">
                Pick the platforms you actually want. Only these get made.</div>
              ${tcards.map(c => `<div class="gencard">
                <div class="flex" style="margin-bottom:8px">
                  <b class="mono">${esc(c.code)}</b>
                  <span class="muted" style="font-size:12px">${esc(c.canonical_question_en ?? '')}</span>
                  <div class="spacer"></div>${pill(c.status)}</div>
                ${c.status !== 'APPROVED'
                  ? '<div class="muted" style="font-size:12px">Not approved yet, so this needs the admin test-mode override in Settings to generate.</div>' : ''}
                <div class="flex" style="flex-wrap:wrap;row-gap:8px">
                  ${outputTypes.map(ot => `<label class="otpick">
                    <input type="checkbox" class="gen-ot-${esc(c.id)}" value="${esc(ot.code)}">
                    ${esc(ot.label)}${ot.platform ? chan(ot.platform) : ''}</label>`).join('')}
                </div>
                <div style="margin-top:10px">
                  <button class="primary" data-plangenerate="${esc(c.id)}">Generate selected</button></div>
              </div>`).join('')}
            </div></details>`
        : tcards.length ? '' : '<span class="muted" style="font-size:12px">No card yet</span>';
      return `<tr>
        <td><b>${esc(t.topic_name)}</b><div class="muted mono" style="font-size:11px">${esc(t.topic_code)}</div></td>
        <td>${sparkline(t.series)}</td>
        <td class="num">${t.total}</td>
        <td class="num">${t.current}</td>
        <td>${dir}</td>
        <td>${approved.length ? `${approved.length} approved`
          : tcards.length ? `<span class="muted">${tcards.length} in review</span>`
          : '<span class="muted">none</span>'}</td>
        <td>${gen}</td></tr>`;
    }).join('');

    return `<h1>Plan</h1><div class="sub">What people are actually asking, and the content that answers it</div>
      <div class="filterrow">
        <div class="seg">
          <a href="#/demand?week" class="${bucket === 'week' ? 'on' : ''}">By week</a>
          <a href="#/demand?month" class="${bucket === 'month' ? 'on' : ''}">By month</a>
        </div>
        <span class="muted" style="font-size:12px">Last 12 ${bucket}s${range ? ` · ${esc(range)}` : ''}</span>
      </div>
      ${!hasAny ? `<div class="card"><b>No classified questions in this window yet.</b>
        <div class="muted" style="font-size:13px;margin-top:4px">Questions only count here once they have been
        classified to a topic. Run Classify pending on the Questions screen, then come back.</div></div>` : ''}
      <div class="card"><table class="plantable">
        <tr><th>Topic</th><th>Last 12 ${bucket}s</th><th class="num">Total</th><th class="num">This ${bucket}</th>
          <th>Direction</th><th>Knowledge</th><th></th></tr>
        ${rows || '<tr><td colspan="7" class="empty">No topics.</td></tr>'}
      </table></div>`;
  },

  async cards() {
    const r = await api('GET', '/knowledge/cards');
    const inReview = r.items.filter(c => c.status === 'IN_REVIEW');
    const canApprove = can('knowledge.approve');
    return `<h1>Knowledge library</h1><div class="sub">The medical facts content is built from. Doctors approve facts ONCE here; everything generated is claim-checked against them.</div>
      ${inReview.length && canApprove ? `<div class="card"><div class="flex">
        <div><b>${inReview.length} card${inReview.length > 1 ? 's' : ''} awaiting clinical approval.</b>
          <div class="muted" style="font-size:12px">Open each card to read its facts and sources, or approve the whole batch if the team has reviewed them.</div></div>
        <div class="spacer"></div>
        <button class="approve" data-cardapproveall="1">Approve all ${inReview.length} + their facts</button>
      </div></div>` : ''}
      <div class="card"><table>
      <tr><th>Code</th><th>Question</th><th>Topic</th><th>Tier</th><th>Claims</th><th>Status</th><th>Review due</th><th></th></tr>
      ${r.items.map(c => `<tr class="rowlink" data-nav="card/${c.id}" tabindex="0">
        <td class="mono"><b>${esc(c.code)}</b></td>
        <td style="max-width:340px">${esc(c.canonical_question_en)}</td>
        <td>${esc(c.topic_code)}</td><td>${pill(c.risk_tier)}</td>
        <td>${c.claim_count}</td><td>${pill(c.status)}</td>
        <td class="muted">${c.review_due_at ? esc(c.review_due_at.slice(0, 10)) : '—'}</td>
        <td>${c.status === 'IN_REVIEW' && canApprove
          ? `<button class="approve" data-cardfullapprove="${c.id}">Approve facts + card</button>` : ''}</td></tr>`).join('')}
      </table></div>`;
  },

  async card(id) {
    const c = await api('GET', `/knowledge/cards/${id}`);
    let genHtml = '';
    if (can('question.turn_into_content')) {
      let outputTypes = [];
      try { outputTypes = (await api('GET', '/content/output-types')).items; } catch {}
      genHtml = `<div class="card"><div class="eyebrow">Generate content from this card</div>
        <div class="sub" style="margin-bottom:10px">Pick exactly which output types to generate for this one topic, instead of the full four-output batch.${c.status !== 'APPROVED' ? ' This card is not yet APPROVED; generation will only work if an admin has turned on the test-mode override in Settings.' : ''}</div>
        <div class="flex" style="flex-wrap:wrap;row-gap:10px">
          ${outputTypes.map(t => `<label class="otpick">
            <input type="checkbox" value="${esc(t.code)}" class="gen-ot">
            ${esc(t.label)}${t.platform ? chan(t.platform) : ''}</label>`).join('')
            || '<span class="muted">No output types configured.</span>'}
        </div>
        <div style="margin-top:12px"><button class="primary" data-cardgenerate="${c.id}">Generate selected</button></div>
      </div>`;
    }
    const claimHtml = c.claims.map(cl => {
      const src = c.sources.filter(s => s.claim_id === cl.id);
      return `<div class="claimrow">
        <div class="flex"><span class="mono"><b>${esc(cl.code)}</b></span>${pill(cl.status)}
          ${cl.is_core ? '<span class="pill p-VALIDATED"><span class="d"></span>core</span>' : ''}</div>
        <div style="margin:4px 0">${esc(cl.claim_text_en)}</div>
        <div class="muted" style="font-size:11.5px">${src.map(s =>
          `${esc(s.organisation)} · ${s.url
            ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`
            : esc(s.title)}${s.locator ? ' · ' + esc(s.locator) : ''}`).join('<br>')}</div>
      </div>`;
    }).join('');
    const v = c.version;
    return `<a class="backlink" href="#/cards">&larr; Knowledge library</a>
      <div class="eyebrow">Knowledge card</div>
      <h1>${esc(c.code)} · ${esc(c.canonical_question_en)}</h1>
      <div class="sub flex">${pill(c.status)} ${pill(c.risk_tier)}
        <span class="muted">Topic ${esc(c.topic_code)} · review due ${c.review_due_at ? esc(String(c.review_due_at).slice(0, 10)) : '—'}</span></div>
      <div class="grid2">
        <div class="card"><div class="eyebrow">Approved answer (EN)</div>
          <div>${esc(v?.canonical_answer_en ?? 'No version written yet.')}</div>
          ${v?.canonical_answer_am ? `<div class="eyebrow" style="margin-top:12px">Approved answer (AM)</div>
            <div class="amharic">${esc(v.canonical_answer_am)}</div>` : ''}</div>
        <div class="card"><div class="eyebrow">Guardrails</div>
          <div class="kv"><b>Prohibited claims</b><br>${(v?.prohibited_claims ?? [])
            .map(p => (p && typeof p === 'object') ? esc(p.statement ?? JSON.stringify(p)) : esc(p)).join('<br>') || '<span class="muted">none recorded</span>'}
          <br><br><b>Approved CTAs</b><br>${(v?.approved_ctas ?? []).map(esc).join('<br>') || '<span class="muted">none recorded</span>'}</div></div>
      </div>
      <div class="card"><div class="eyebrow">Claims (${c.claims.length})</div>${claimHtml || '<span class="muted">No claims attached.</span>'}</div>
      ${genHtml}
      <div class="flex">
        ${c.status === 'DRAFT' && can('knowledge.submit') ? `<button class="primary" data-cardtx="${c.id}|IN_REVIEW">Submit for clinical review</button>` : ''}
        ${c.status === 'IN_REVIEW' && can('knowledge.approve') ? `<button class="approve" data-cardfullapprove="${c.id}">Approve facts + card (6 month review)</button>` : ''}
        ${c.status === 'APPROVED' && can('knowledge.retire') ? `<button class="danger" data-cardretire="${c.id}">Retire</button>` : ''}
      </div>`;
  },

  async claims() {
    const r = await api('GET', '/knowledge/claims');
    return `<h1>Medical claims</h1><div class="sub">The atomic units of approved medical truth</div>
      <div class="card">
      <div class="flex" style="flex-wrap:wrap;gap:10px;margin-bottom:10px">
        <input id="cl-filter" data-livefilter="cl-table" data-count-target="cl-count"
          placeholder="filter by code, claim text, or topic" style="max-width:320px">
        <span id="cl-count" class="muted">${r.items.length} of ${r.items.length} shown</span>
      </div>
      <table id="cl-table">
      <tr><th>Code</th><th>Claim</th><th>Topic</th><th>Type</th><th>Certainty</th><th>Status</th></tr>
      ${r.items.map(c => `<tr data-filter-item><td class="mono"><b>${esc(c.code)}</b></td>
        <td style="max-width:420px">${esc(c.claim_text_en)}</td>
        <td>${esc(c.topic_code)}</td><td class="muted">${esc(c.claim_type)}</td>
        <td class="muted">${esc(c.certainty)}</td><td>${pill(c.status)}</td></tr>`).join('')
      || '<tr><td colspan=6 class="empty">No claims yet.</td></tr>'}
      </table></div>`;
  },

  async sources() {
    const r = await api('GET', '/knowledge/sources');
    return `<h1>Medical sources</h1><div class="sub">Evidence hierarchy. Precedence 1 outranks everything; FMoH national guidance is 1.</div>
      <div class="card"><table>
      <tr><th>Prec.</th><th>Code</th><th>Organisation</th><th>Title</th><th>Type</th><th>Status</th></tr>
      ${r.items.map(s => `<tr><td><b>${s.precedence}</b></td><td class="mono">${esc(s.code)}</td>
        <td>${esc(s.organisation)}</td><td style="max-width:300px">${s.url
          ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`
          : esc(s.title)}</td>
        <td class="muted" style="font-size:11px">${esc(s.source_type)}</td><td>${pill(s.status)}</td></tr>`).join('')}
      </table></div>`;
  },

  async gaps() {
    const r = await api('GET', '/knowledge/needs-knowledge');
    // needs_knowledge_note is a structured object ({blocking_reason,
    // missing_facts:[{fact_needed,why}]}), but arrives from the API as a
    // JSON string on at least this table; the old code called
    // JSON.stringify on it regardless, which on a string just re-escapes
    // it, producing a raw \"like\" \"this\" dump instead of readable text.
    // Parse defensively and render the actual fields.
    const noteText = (note) => {
      let n = note;
      if (typeof n === 'string') { try { n = JSON.parse(n); } catch { return n; } }
      if (!n || typeof n !== 'object') return '';
      const facts = (n.missing_facts ?? []).map(f => f.fact_needed || f.why).filter(Boolean).join('; ');
      return [n.blocking_reason, facts].filter(Boolean).join(' — ');
    };
    return `<h1>Knowledge gaps</h1>
      <div class="sub">Scripts stopped because a required fact has no approved claim. Each row is real demand the clinical team can answer.</div>
      <div class="card"><table><tr><th>Script</th><th>Card</th><th>Missing knowledge</th><th>When</th></tr>
      ${r.items.map(i => `<tr class="rowlink" data-nav="script/${esc(i.id)}" tabindex="0">
        <td class="mono">${esc(i.code)}</td><td class="mono">${esc(i.card_code)}</td>
        <td style="max-width:420px">${esc(noteText(i.needs_knowledge_note))}</td>
        <td class="muted">${dt(i.created_at)}</td></tr>`).join('')
      || '<tr><td colspan=4 class="empty">No open knowledge gaps.</td></tr>'}</table></div>`;
  },

  // arg (family id) filters the concepts list below: dashboard-style
  // drill-down from a family row into what it actually produced.
  async families() {
    const r = await api('GET', '/content/families');
    return `<h1>Content families</h1><div class="sub">One educational idea, all its derivatives. Click a row to see its concepts.</div>
      <div class="card"><table><tr><th>Code</th><th>Title</th><th>Card</th><th>Segment</th><th>Tier</th><th>Origin</th><th>Created</th><th></th></tr>
      ${r.items.map(f => `<tr class="rowlink" data-nav="concepts/${f.id}" tabindex="0">
        <td class="mono">${esc(f.code)}</td><td style="max-width:280px">${esc(f.title)}</td>
        <td class="mono">${esc(f.card_code)}</td><td class="muted">${esc(f.segment_slug)}</td>
        <td>${pill(f.risk_tier)}</td><td class="muted">${esc(f.origin)}</td><td class="muted">${dt(f.created_at)}</td>
        <td></td></tr>`).join('')
      || '<tr><td colspan=8 class="empty">No content families yet.</td></tr>'}</table></div>`;
  },

  // arg (optional): a family id to filter to (see families() row links above).
  async concepts(familyId) {
    const r = await api('GET', '/content/concepts' + (familyId ? `?family_id=${encodeURIComponent(familyId)}` : ''));
    let family = null;
    // Concepts repeat the same handful of titles across many families (the
    // redesign audit's Tier 2 finding: an unfiltered flat list makes this
    // very hard to scan). Group by family so duplicates sit together, and
    // add the same live-filter pattern used on the Claims screen. Families
    // are only fetched once, for the id -> code/title lookup, not per row.
    let familiesById = new Map();
    if (familyId) {
      try { family = (await api('GET', '/content/families')).items.find(f => f.id === familyId); } catch {}
    } else {
      try { (await api('GET', '/content/families')).items.forEach(f => familiesById.set(f.id, f)); } catch {}
    }
    const card = c => `<div class="card" data-filter-item>
        <div class="flex"><b>${esc(c.title)}</b>${pill(c.status)}<span class="muted">${esc(c.video_family)}</span>
          <span class="spacer"></span>
          ${c.status === 'PROPOSED' && can('concept.select') ? `<button class="approve" data-select="${c.id}">Select</button>` : ''}</div>
        <div style="margin:6px 0"><b>Hook:</b> ${esc(c.hook_line)}</div>
        <div class="muted">${esc(c.premise)}</div>
        <div class="muted" style="font-size:12px;margin-top:6px">Why it works: ${esc(c.why_this_works ?? '')}</div>
      </div>`;
    let body;
    if (!r.items.length) {
      body = `<div class="card empty">${familyId ? 'No concepts recorded for this family.' : 'No concepts yet. Use Turn into content from the Questions screen to start one.'}</div>`;
    } else if (familyId) {
      body = r.items.map(card).join('');
    } else {
      // Group by family_id, family with the most recent concept first.
      const groups = new Map();
      for (const c of r.items) {
        if (!groups.has(c.family_id)) groups.set(c.family_id, []);
        groups.get(c.family_id).push(c);
      }
      body = [...groups.entries()].map(([fid, items]) => {
        const f = familiesById.get(fid);
        const label = f ? `${esc(f.code)} · ${esc(f.title)}` : 'Ungrouped';
        return `<div class="eyebrow" style="margin-top:14px">${label} (${items.length})</div>
          ${items.map(card).join('')}`;
      }).join('');
    }
    return `${familyId ? '<a class="backlink" href="#/families">&larr; Content families</a>' : ''}
      <h1>Creative concepts</h1>
      <div class="sub">${family ? `Filtered to ${esc(family.code)} · ${esc(family.title)}` : 'Distinct treatments of approved knowledge, grouped by family. Selection is the cheap place for editorial judgement.'}</div>
      ${!familyId && r.items.length ? `<div class="flex" style="flex-wrap:wrap;gap:10px;margin-bottom:10px">
        <input id="cc-filter" data-livefilter="cc-list" data-count-target="cc-count"
          placeholder="filter by title, hook, or premise" style="max-width:320px">
        <span id="cc-count" class="muted">${r.items.length} of ${r.items.length} shown</span>
      </div>` : ''}
      <div id="cc-list">${body}</div>`;
  },

  async scripts() {
    const r = await api('GET', '/content/scripts');
    return `<h1>Scripts</h1><div class="sub">Every medical sentence maps to an approved claim, or the script does not move</div>
      <div class="card"><table><tr><th>Code</th><th>Family</th><th>Card</th><th>Lang</th><th>Tier</th><th>Validation</th><th>Status</th><th></th><th></th></tr>
      ${r.items.map(s => `<tr class="rowlink" data-nav="script/${s.id}" tabindex="0">
        <td class="mono">${esc(s.code)}</td><td class="mono muted">${esc(s.family_code)}</td>
        <td class="mono">${esc(s.card_code)}</td><td>${esc(s.language)}</td>
        <td>${pill(s.risk_tier)}</td><td>${pill(s.validation_result === 'PASS' ? 'PASS' : s.validation_result === 'FAIL' ? 'FAIL' : null) || '<span class="muted">—</span>'}</td>
        <td>${pill(s.status)}</td><td></td>
        <td>${s.status === 'APPROVED' ? produceButtonHtml(s) : ''}</td>
      </tr>`).join('')}</table></div>`;
  },

  // Step 3 of the guided flow, the step Girum hits every single time.
  // Rebuilt for Part 2 (14 Aug 2026): the approval sequence on screen, the
  // body the format actually has editable in place, single-piece steerable
  // regeneration, the claim map beside the copy, style lint inline, and a
  // plain sentence at the moment of saving about what the edit just did.
  async script(id) {
    const s = await api('GET', `/content/scripts/${id}`);
    const v = s.version;
    let gateInfo = { mine: [], admin_override: false };
    try { gateInfo = await api('GET', '/pipeline/gate-signers'); } catch {}
    const gates = new Set((s.gates ?? []).map(g => g.gate));
    const flash = takeFlash(id);
    const fmtLabelTxt = s.format_info?.label ?? fmtLabel(v?.format);

    // ---- the editor: every text field of the body this format actually has ----
    const inp = (idAttr, val, label, textarea = false, maxlen = '') => `
      <label>${esc(label)}</label>` + (textarea
      ? `<textarea id="${idAttr}" ${maxlen ? `maxlength="${maxlen}"` : ''}>${esc(val ?? '')}</textarea>`
      : `<input id="${idAttr}" value="${esc(val ?? '')}" ${maxlen ? `maxlength="${maxlen}"` : ''}>`);
    const fmt = v?.format ?? 'VIDEO';
    let bodyEditor = '';
    if (fmt === 'CAROUSEL') {
      bodyEditor = (v.carousel_slides ?? []).map((sl, i) => `
        <div class="slide"><div class="slide-n">${i + 1}</div><div style="flex:1">
          ${inp(`ed-sl-${i}-title`, sl.title, `Slide ${i + 1} title`)}
          ${inp(`ed-sl-${i}-body`, sl.body, `Slide ${i + 1} body`, true)}
        </div></div>`).join('');
    } else if (fmt === 'STATIC') {
      const g = v.static_graphic ?? {};
      bodyEditor = inp('ed-g-headline', g.headline, 'Headline (it does the whole job alone)')
        + inp('ed-g-body', g.body, 'Body, one or two sentences', true)
        + inp('ed-g-footer', g.footer, 'Footer');
    } else if (fmt === 'POST') {
      bodyEditor = inp('ed-post', v.post_text, 'Post text', true);
    } else if (fmt === 'ARTICLE') {
      const b = v.body ?? {};
      bodyEditor = inp('ed-b-intro', b.intro, 'Intro (one or two sentences)', true)
        + (b.sections ?? []).map((sec, i) => `
          ${inp(`ed-sec-${i}-heading`, sec.heading, `Section ${i + 1} heading`)}
          ${inp(`ed-sec-${i}-body`, sec.body, `Section ${i + 1} body`, true)}`).join('');
    } else if (fmt === 'MICROCOPY') {
      bodyEditor = ((v.body?.items) ?? []).map((it, i) => `
        <div class="claimrow">${it.key ? `<span class="mono muted">${esc(it.key)}</span>` : ''}
          ${inp(`ed-it-${i}-en`, it.text_en, 'English', true)}
          <label>Amharic</label><textarea id="ed-it-${i}-am" class="amharic">${esc(it.text_am ?? '')}</textarea>
        </div>`).join('');
    } else if (fmt === 'PUSH') {
      const pnote = v.body?.push ?? {};
      bodyEditor = inp('ed-p-title', pnote.title, 'Title (40 chars max, no emoji)', false, 40)
        + inp('ed-p-body', pnote.body, 'Body (100 chars max, one sentence, might/may)', false, 100)
        + inp('ed-p-link', pnote.deep_link, 'Deep link (abeba://...)');
    } else if (fmt === 'LIVE') {
      const b = v.body ?? {};
      bodyEditor = (b.segments ?? []).map((seg, i) => `
        ${inp(`ed-seg-${i}-title`, seg.title, `Segment ${seg.index ?? i + 1} title (${seg.minutes ?? '?'} min)`)}
        ${inp(`ed-seg-${i}-desc`, seg.description, 'What happens in it', true)}`).join('')
        + inp('ed-pinned', b.pinned_message, 'Pinned message', true)
        + (b.cutdown_briefs ?? []).map((c, i) => inp(`ed-cut-${i}`, c, `Cutdown brief ${i + 1}`)).join('');
    } else { // VIDEO and AUDIO
      bodyEditor = inp('ed-spoken', v?.spoken_script, 'Spoken script', true);
    }
    // Structured extras a few formats carry (a quoted question, a quiz, a
    // giveaway). Edited as JSON rather than silently uneditable.
    const KNOWN = ['intro', 'sections', 'items', 'push', 'segments', 'pinned_message', 'cutdown_briefs'];
    const extras = Object.fromEntries(Object.entries(v?.body ?? {}).filter(([k]) => !KNOWN.includes(k)));
    const extrasEditor = Object.keys(extras).length
      ? `<label>Structured fields (${esc(Object.keys(extras).join(', '))}) as JSON. Regenerating is usually better than hand-editing these.</label>
         <textarea id="ed-body-extra" class="mono" style="min-height:120px">${esc(JSON.stringify(extras, null, 2))}</textarea>`
      : '';

    const editorHtml = can('script.write') && v ? `
      <div class="card"><div class="eyebrow">${esc(fmtLabelTxt)} · edit in place</div>
        ${inp('ed-hook', v.hook, 'Hook', true)}
        ${bodyEditor}
        ${extrasEditor}
        ${inp('ed-cta', v.cta, 'CTA (ends at the door; the phone number comes from the canonical block, never retyped)', true)}
        <div class="flex" style="margin-top:10px">
          <button class="primary" data-scriptedit="${s.id}">Save changes</button>
          <span class="muted" style="font-size:12px">A change to a medical statement, number, time window or term sends this back to medical review. A hook or caption change does not. You are told which, the moment you save.</span>
        </div>
      </div>
      <div class="card"><div class="eyebrow">Not right? Regenerate this one piece</div>
        <div class="flex">
          <input id="rg-direction" placeholder="steer it: shorter · different angle · less clinical · more direct · warmer" style="flex:1">
          <button data-regen="${s.id}">Regenerate</button>
        </div>
        <div class="muted" style="font-size:12px;margin-top:6px">Only this piece is rewritten, as a new version. The rest of the run is untouched. A regenerated body goes back through validation and medical review.</div>
      </div>` : `<div class="card"><div class="eyebrow">${esc(fmtLabelTxt)}</div>
        <div class="kv"><b>Hook:</b> ${esc(v?.hook)}<br><br>${scriptBody(v)}<br><br><b>CTA:</b> ${esc(v?.cta)}</div></div>`;

    // ---- what happens next, computed from the same rules the server enforces ----
    const eff = (s.format_info?.stages_applicable ?? ['plan','script','medical_review','produce','shoot','edit','approve','publish','repurpose','measure'])
      .filter(st => s.production_path === 'DIGITAL' ? !['shoot','edit'].includes(st)
        : s.production_path === 'NONE' ? !['produce','shoot','edit'].includes(st)
        : st !== 'produce');
    const stageIdx = eff.indexOf(s.stage);
    const nextStage = stageIdx >= 0 ? eff[stageIdx + 1] : null;
    let nextText, canTryAdvance = false;
    if (!nextStage) nextText = 'This piece is at its final stage.';
    else if (s.stage === 'medical_review' && s.validation_result !== 'PASS') {
      nextText = `Claim validation is ${s.validation_result ?? 'NOT_RUN'} and must PASS before a doctor can sign. Re-run validation below.`;
    } else if (s.stage === 'medical_review' && s.needs_clinical_signoff && !gates.has('clinical_signoff')) {
      nextText = 'Abortion-adjacent: the clinical sign-off (the medical director) must be signed before this can leave medical review.';
      canTryAdvance = gateInfo.mine.includes('clinical_signoff') || gateInfo.admin_override;
    } else if (!gates.has(s.stage)) {
      const mine = gateInfo.mine.includes(s.stage);
      nextText = mine
        ? `The ${s.stage.replace(/_/g, ' ')} gate is yours to sign: advancing signs it.`
        : `Waiting on ${GATE_ROLE_LABEL[s.stage] ?? 'the right role'} to sign the ${s.stage.replace(/_/g, ' ')} gate.${gateInfo.admin_override ? ' You can advance as an admin override; it is recorded as one.' : ''}`;
      canTryAdvance = mine || gateInfo.admin_override;
    } else { nextText = `Ready to move to ${nextStage.replace(/_/g, ' ')}.`; canTryAdvance = true; }

    const gatesHtml = `<div class="card"><div class="eyebrow">Where this piece is</div>
      <div class="flex" style="margin-bottom:8px">${eff.map(st => {
        const signed = gates.has(st);
        const here = st === s.stage;
        return `<span class="pill ${signed ? 'p-APPROVED' : here ? 'p-IN_REVIEW' : 'p-DRAFT'}"
          title="${esc(signed ? 'gate signed' : `signed by ${GATE_ROLE_LABEL[st] ?? ''}`)}"><span class="d"></span>${esc(st.replace(/_/g, ' '))}</span>`;
      }).join('')}
      ${s.needs_clinical_signoff ? `<span class="pill ${gates.has('clinical_signoff') ? 'p-APPROVED' : 'p-TIER_4'}"><span class="d"></span>clinical sign-off</span>` : ''}</div>
      ${(s.gates ?? []).length ? `<div class="muted" style="font-size:12px;margin-bottom:6px">Signed: ${(s.gates ?? []).map(g =>
        `${esc(g.gate.replace(/_/g, ' '))} by ${esc(g.signed_role === 'admin_override' ? 'admin (override)' : GATE_ROLE_LABEL[g.gate] ?? g.signed_role ?? '')} ${dt(g.signed_at)}`).join(' · ')}</div>` : ''}
      <div style="font-size:13px;margin-bottom:8px"><b>Next:</b> ${esc(nextText)}</div>
      ${canTryAdvance && nextStage && can('script.write') ? `<button class="primary" data-advance="${s.id}">Advance to ${esc(nextStage.replace(/_/g, ' '))}${gateInfo.mine.includes(s.stage) || gates.has(s.stage) ? '' : ' (admin override)'}</button>` : ''}
      ${s.production_path !== 'NONE' && ['produce', 'shoot'].includes(nextStage ?? '') || s.status === 'APPROVED' && s.production_path !== 'NONE'
        ? ` <a class="btn" href="#/produce/${esc(s.id)}">See the production plan and cost</a>` : ''}
    </div>`;

    const amBox = s.translation ? `
      <div class="card"><div class="eyebrow">Amharic · drift ${Number(s.translation.drift_score).toFixed(3)} (${esc(driftWords(s.translation.drift_score)[0])})</div>
        <div class="amharic" style="max-height:130px;overflow:hidden">${esc(s.translation.translated_text.slice(0, 260))}${s.translation.translated_text.length > 260 ? '…' : ''}</div>
        <div style="margin-top:10px"><a class="btn" href="#/amharic/${esc(s.id)}">Open the side-by-side Amharic review</a></div>
      </div>` : `
      <div class="card"><div class="eyebrow">Amharic</div>
        <span class="muted">Not written yet. Amharic is written from the approved English${s.language === 'EN' && can('script.write')
          ? ', or run it now:' : '.'}</span>
        ${s.language === 'EN' && can('script.write') ? `<div style="margin-top:8px"><button data-scriptlocalize="${s.id}">Write Amharic version</button></div>` : ''}
      </div>`;

    return `<a class="backlink" href="#/scripts">&larr; All scripts</a>
      <div class="eyebrow">Piece</div>
      <h1 class="mono">${esc(s.code)} <span style="font-weight:400;font-size:14px">· ${esc(fmtLabelTxt)}</span></h1>
      <div class="sub flex">${pill(s.status)} ${pill(s.risk_tier)}
        ${pill(s.validation_result === 'PASS' ? 'PASS' : s.validation_result === 'FAIL' ? 'FAIL' : null)}
        ${s.is_test_content ? '<span class="pill p-TIER_4"><span class="d"></span>TEST CONTENT</span>' : ''}
        <span class="muted">${esc(s.language)} · v${s.current_version} · ${esc(String(s.production_path ?? 'LIVE').toLowerCase())} production</span></div>
      ${flash ? `<div class="card" style="border-left:4px solid ${flash.kind === 'medical' ? 'var(--risk-mod)' : 'var(--risk-routine)'}"><b>${esc(flash.title)}</b><div style="font-size:13px;margin-top:4px">${esc(flash.text)}</div></div>` : ''}
      ${flowStepper(s)}
      ${styleWarnHtml(v?.style_warnings)}
      <div class="grid2">
        <div>${editorHtml}</div>
        <div>
          <div class="card"><div class="eyebrow">Claim map: which sentence rests on which approved claim</div>
            ${s.claim_map.map(m => `<div class="claimrow ${['UNSUPPORTED','CONTRADICTED','AMBIGUOUS'].includes(m.verdict) ? 'bad' : ''}">
              <div>${esc(m.statement)}</div>
              <div class="flex" style="margin-top:4px"><span class="mono muted">${esc(m.claim_code)}</span>
                ${m.verdict ? pill(m.verdict === 'SUPPORTED' ? 'PASS' : m.verdict === 'PARTIALLY_SUPPORTED' ? 'IN_REVIEW' : 'FAIL') : ''}
                <span class="muted" style="font-size:11.5px">${esc(m.claim_text_en)}</span></div>
            </div>`).join('') || '<span class="muted">No claim map. This is the safety story of the system; a piece with medical content and no map should not advance.</span>'}</div>
          ${amBox}
          ${gatesHtml}
        </div>
      </div>
      ${s.findings.length ? `<div class="card"><div class="eyebrow">Findings</div>
        ${s.findings.map(f => `<div class="claimrow bad"><b>${esc(f.code)}</b> · ${esc(f.severity)}<br>
          ${esc(f.explanation)}${f.suggested_fix ? `<br><span class="muted">Fix: ${esc(f.suggested_fix)}</span>` : ''}</div>`).join('')}</div>` : ''}
      ${s.status === 'NEEDS_KNOWLEDGE' ? `<div class="card" style="border-left:4px solid var(--risk-mod)">
        <b>The writer stopped because a fact it needed is not an approved claim.</b>
        <div style="font-size:13px;margin:6px 0">That is the system working: it refused to invent. The missing fact:</div>
        <div class="mono" style="font-size:12px">${esc(JSON.stringify(s.needs_knowledge_note ?? {}).slice(0, 400))}</div>
        <div style="margin-top:8px"><a class="btn" href="#/gaps">Open the knowledge gap</a></div></div>` : ''}
      <div class="flex">
        ${s.status === 'CLINICAL_REVIEW' && (can('script.approve_clinical')) ?
          `<button class="approve" data-scripttx="${s.id}|APPROVED">Approve clinically</button>
           <button data-scripttx-reason="${s.id}|DRAFT">Request changes</button>
           <button class="danger" data-scripttx-reason="${s.id}|REJECTED">Reject</button>` : ''}
        ${s.status === 'LANGUAGE_REVIEW' && can('script.approve_language') ?
          `<button data-scripttx="${s.id}|${['TIER_3','TIER_4'].includes(s.risk_tier) ? 'CLINICAL_REVIEW' : 'APPROVED'}">Advance state</button>` : ''}
        ${['DRAFT','VALIDATION_FAILED'].includes(s.status) && can('script.write') ?
          `<button data-scriptvalidate="${s.id}">Re-run validation</button>` : ''}
        ${['VALIDATION_FAILED','NEEDS_KNOWLEDGE'].includes(s.status) && can('script.write') ?
          `<button data-scripttx="${s.id}|DRAFT">Back to draft</button>` : ''}
        ${s.status === 'REJECTED' && can('script.write') ?
          `<button class="danger" data-scriptdelete="${s.id}">Delete permanently</button>
           <span class="muted" style="font-size:12px;align-self:center">Removes it for good, not just from view. Only possible because it is already rejected.</span>` : ''}
        ${!['REJECTED','SUPERSEDED','CLINICAL_REVIEW'].includes(s.status) && can('script.write') ?
          `<button class="danger" data-scripttx-reason="${s.id}|REJECTED">Reject</button>` : ''}
        ${s.status === 'APPROVED' && can('production.request') && s.production_path !== 'NONE' ?
          `<a class="btn" href="#/produce/${esc(s.id)}">Plan production (see the cost first)</a>` : ''}
      </div>`;
  },

  // Minimal render detail (GET /production/renders/:id): the drill-down
  // target for the Queue's "ready to publish" rows, which otherwise showed
  // only a caption and a download link with nothing to click into.
  async render(id) {
    let r;
    try { r = await api('GET', `/production/renders/${id}`); }
    catch {
      return `<a class="backlink" href="#/reviews">&larr; Queue</a>
        <h1>Render not found</h1><div class="card empty">It may have been removed or superseded.</div>`;
    }
    return `<a class="backlink" href="#/reviews">&larr; Queue</a>
      <div class="eyebrow">Render detail</div>
      <h1 class="mono">${esc(r.code ?? r.id)}</h1>
      <div class="sub flex">${pill(r.status)} <span class="muted">${esc(r.engine)}</span>
        ${r.duration_s != null ? `<span class="muted">${esc(String(r.duration_s))}s</span>` : ''}
        ${r.aspect_ratio ? `<span class="muted">${esc(r.aspect_ratio)}</span>` : ''}</div>
      <div class="card"><div class="eyebrow">Details</div>
        <div class="kv">
          <b>Template</b> ${esc(r.template_code ?? '—')}${r.template_version ? ' v' + esc(String(r.template_version)) : ''}<br>
          <b>Variant</b> ${esc(r.variant_label ?? '—')}<br>
          <b>Cost</b> ${r.cost_usd != null ? '$' + esc(String(r.cost_usd)) : '—'}<br>
          <b>Created</b> ${dt(r.created_at)}
        </div>
        ${r.preview_url ? `<div style="margin-top:12px"><a class="btn" href="${esc(r.preview_url)}" target="_blank" rel="noopener" download>Download / preview</a></div>` : ''}
        ${r.last_error ? `<div class="claimrow bad" style="margin-top:10px"><b>Last error</b><br>${esc(r.last_error)}</div>` : ''}
      </div>
      <a class="backlink" href="#/script/${esc(r.script_id)}">Open its script &rarr;</a>`;
  },

  async reviews() {
    const qd = await api('GET', '/distribution/queue');
    const A = qd.awaiting_approval, P = qd.to_produce, R = qd.to_publish;
    const canApprove = can('script.approve_editorial') || can('script.approve_clinical');
    return `<h1>Queue</h1><div class="sub">Draft to published in one place: approve the batch, produce, then publish or copy for manual posting</div>

      <div class="card"><div class="flex"><div class="eyebrow" style="margin:0">1 · Awaiting approval (${A.length})</div>
        <div class="spacer"></div>
        ${A.length && canApprove ? `<button class="approve" data-batchapprove="1">Approve all ${A.length}</button>` : ''}</div>
      <table><tr><th>Script</th><th>Lang</th><th>Tier</th><th>Hook</th><th>Status</th></tr>
      ${A.map(s => `<tr class="rowlink" data-nav="script/${s.id}" tabindex="0">
        <td class="mono">${esc(s.code)}</td><td>${esc(s.language)}</td><td>${pill(s.risk_tier)}</td>
        <td class="muted" style="max-width:340px">${esc(s.hook ?? '')}</td><td>${pill(s.status)}</td></tr>`).join('')
      || '<tr><td colspan=5 class="empty">Nothing waiting. Generate content from the Questions or Demand screens.</td></tr>'}</table></div>

      <div class="card"><div class="flex"><div class="eyebrow" style="margin:0">2 · Approved, ready to produce (${P.length})</div>
        <div class="spacer"></div>
        ${(() => {
          // Produce all only ever batches the regular render pipeline
          // (production.mjs). A VIDEO-kind script is refused there now
          // that HeyGen/Creatomate are retired -- see produceButtonHtml
          // above -- so it is left out of both the count and the batch
          // loop below; it needs the per-script Video Studio review
          // screen (draft, then a human choice per shot/overlay/lock),
          // not a one-click bulk action.
          const producible = P.filter(s => s.body_kind !== 'VIDEO').length;
          const videoCount = P.length - producible;
          return `${producible && can('production.request') ? `<button class="primary" data-produceall="1">Produce all ${producible}</button>` : ''}` +
            (videoCount ? `<span class="muted" style="font-size:12px;margin-left:10px">${videoCount} video script${videoCount === 1 ? '' : 's'} need Video Studio, one at a time</span>` : '');
        })()}</div>
      <table><tr><th>Script</th><th>Lang</th><th>Tier</th><th>Family</th><th></th></tr>
      ${P.map(s => `<tr class="rowlink" data-nav="script/${s.id}" tabindex="0"><td class="mono">${esc(s.code)}</td><td>${esc(s.language)}</td>
        <td>${pill(s.risk_tier)}</td><td class="mono muted">${esc(s.family_code)}</td>
        <td>${produceButtonHtml(s)}</td></tr>`).join('')
      || '<tr><td colspan=5 class="empty">Nothing to produce. Approved scripts queue up here.</td></tr>'}</table></div>

      <div class="card"><div class="eyebrow">3 · Ready to publish (${R.length})</div>
      <div class="sub" style="margin:-6px 0 10px">Click a row to open the render's own detail (duration, engine, preview).</div>
      <table><tr><th>Script</th><th>Caption</th><th>Video</th><th>Publish</th></tr>
      ${R.map(r => {
        const cap = (r.caption ?? '') + (r.hashtags?.length ? '\n' + r.hashtags.join(' ') : '');
        return `<tr class="rowlink" data-nav="render/${esc(r.render_id)}" tabindex="0"><td class="mono">${esc(r.script_code)}<div class="muted">${esc(r.language)} · ${pill(r.risk_tier)}</div></td>
        <td style="max-width:320px"><div class="muted" style="font-size:12px;white-space:pre-wrap">${esc(cap.slice(0, 180))}${cap.length > 180 ? '…' : ''}</div>
          <button data-copycap="${esc(r.render_id)}" data-cap="${esc(cap)}">Copy caption</button></td>
        <td>${r.download_url ? `<a class="btn" href="${esc(r.download_url)}" download>Download</a>` : '<span class="muted">no file</span>'}</td>
        <td>${can('publish.execute') ? `<div class="flex">
            <select id="plat-${esc(r.render_id)}" style="width:130px">
              <option value="TELEGRAM">Telegram</option><option value="FACEBOOK">Facebook</option>
              <option value="INSTAGRAM">Instagram</option><option value="TIKTOK">TikTok</option>
              <option value="YOUTUBE">YouTube</option></select>
            <button class="primary" data-pubnow="${esc(r.render_id)}" ${r.final_approved ? '' : 'disabled title="Approve the batch first"'}>Publish</button>
          </div>` : ''}</td></tr>`; }).join('')
      || '<tr><td colspan=4 class="empty">Nothing rendered yet. Produced videos arrive here ready to publish.</td></tr>'}</table></div>

      <div class="card"><div class="eyebrow">Recently published</div>
      <table>${qd.recent.map(p => `<tr><td class="mono">${esc(p.family_code)}</td>
        <td><span class="ch ch-${esc(p.platform)}">${esc(p.platform)}</span></td>
        <td class="muted">${dt(p.published_at)}</td>
        <td>${p.permalink ? `<a href="${esc(p.permalink)}" target="_blank">open ↗</a>` : ''}</td></tr>`).join('')
      || '<tr><td class="empty">Nothing published yet.</td></tr>'}</table></div>`;
  },

  // Step 7: watch it happen, like a delivery app. Per job: what finished,
  // what is running, what is queued, what failed and why, and what to do
  // about it. Polls every 5 seconds while the screen is open; no held
  // requests, no websockets (Part 2, 14 Aug 2026).
  async production() {
    const r = await api('GET', '/production/progress');
    if (!POLL) {
      POLL = setInterval(() => {
        if (location.hash.replace(/^#\//, '').split('?')[0] === 'production') render();
        else { clearInterval(POLL); POLL = null; }
      }, 5000);
    }
    const sp = r.spend_today;
    const meter = (m, label) => {
      const pct = Math.min(100, Math.round((m.spent_usd / (m.cap_usd || 1)) * 100));
      return `<div style="flex:1;min-width:180px"><div class="flex" style="justify-content:space-between">
        <span style="font-size:12px">${label}</span>
        <span class="mono" style="font-size:12px">$${m.spent_usd.toFixed(2)} of $${m.cap_usd}</span></div>
        <div class="meter"><div class="meter-fill ${pct >= 100 ? 'full' : pct >= 75 ? 'warn' : ''}" style="width:${pct}%"></div></div></div>`;
    };
    const statusWord = { QUEUED: 'queued', ASSETS_PENDING: 'waiting on assets', VOICE_PENDING: 'waiting on the Amharic',
      RENDERING: 'running', RENDERED: 'finished', FAILED: 'failed', CANCELLED: 'cancelled' };
    return `<h1>Production progress</h1><div class="sub">Live, refreshed every few seconds. Every state says what it means and what to do next.</div>
      <div class="card"><div class="eyebrow">Today's spend against the caps</div>
        <div class="flex" style="gap:20px">${meter(sp.render, 'Renders')}${meter(sp.ai, 'AI')}</div>
        ${sp.render.spent_usd >= sp.render.cap_usd ? '<div class="claimrow bad" style="margin-top:10px">The daily render cap is reached. Jobs stay queued, nothing fails, and the queue picks up tomorrow. An admin can raise the cap in Settings.</div>' : ''}
      </div>
      ${r.items.map(j => `<div class="card">
        <div class="flex"><b class="mono">${esc(j.code)}</b>
          <a href="#/script/${esc(j.script_id)}" class="mono">${esc(j.script_code)}</a>
          <span class="muted">${esc(j.format_label ?? '')}</span>
          ${pill(j.status)} <span class="muted">${esc(statusWord[j.status] ?? '')}</span>
          <span class="spacer"></span>
          <span class="muted" style="font-size:12px">voice: ${esc(j.voice_source === 'HUMAN' ? 'live recording' : j.voice_source === 'AI_TTS' ? 'AI (Azure)' : 'none')}
            ${j.video_engine ? ` · engine: ${esc(j.video_engine)}` : ''}${j.subtitle_preset ? ` · subs: ${esc(j.subtitle_preset.toLowerCase().replace(/_/g, ' '))}` : ''}</span></div>
        <div style="font-size:13px;margin-top:6px">${esc(j.text)}</div>
        <div class="muted" style="font-size:12px;margin-top:2px">${esc(j.action)}</div>
        ${(j.renders ?? []).map(rr => `<div class="claimrow ${rr.status === 'FAILED' ? 'bad' : ''}" style="margin-top:8px">
          <div class="flex">${pill(rr.status)}
            ${rr.cost_usd != null ? `<span class="muted">$${esc(String(rr.cost_usd))}</span>` : ''}
            ${rr.storage_key ? `<a class="btn" href="${esc(mediaUrl(rr.storage_key))}" target="_blank" rel="noopener">Preview</a>` : ''}</div>
          ${rr.error_detail ? `<div class="muted" style="font-size:12px;margin-top:4px">${esc(rr.error_detail)}</div>` : ''}
        </div>`).join('')}
        <div class="flex" style="margin-top:8px">
          ${['QUEUED', 'VOICE_PENDING', 'FAILED', 'ASSETS_PENDING'].includes(j.status) && can('production.request')
            ? `<button class="primary" data-run="${esc(j.id)}">${j.status === 'FAILED' ? 'Run again' : 'Run'}</button>
               <a class="btn" href="#/produce/${esc(j.script_id)}">Change the plan first</a>` : ''}
        </div>
      </div>`).join('') || '<div class="card empty">Nothing in production. Approve a piece, open its production plan, and start it from there.</div>'}`;
  },

  // The asset library, browsable and reusable (Part 2, 14 Aug 2026: owner:
  // "will we make the asset library easily accessible and searchable...
  // even have an option to pull from them when generating new stuff?").
  // Thumbnails and previews, filters a person would use, one-click save for
  // generated assets waiting on review, and honesty about the semantic
  // search being coarse while embeddings are a deterministic mock.
  async assets() {
    const qp = new URLSearchParams((location.hash.split('?')[1] ?? ''));
    const kind = qp.get('kind') ?? '', text = qp.get('text') ?? '';
    const ai = qp.get('ai') ?? '', pending = qp.get('pending') ?? '';
    const query = new URLSearchParams();
    if (kind) query.set('kind', kind);
    if (text) query.set('text', text);
    if (ai) query.set('ai', ai);
    if (pending) query.set('include_pending', '1');
    const r = await api('GET', '/production/assets' + (query.toString() ? `?${query}` : ''));
    const KINDS = ['VIDEO', 'IMAGE_PHOTO', 'ILLUSTRATION', 'MEDICAL_ILLUSTRATION', 'BACKGROUND', 'TEXTURE',
      'CHARACTER_REFERENCE', 'BRAND_ELEMENT', 'LOGO', 'AUDIO_VOICEOVER', 'AUDIO_MUSIC', 'AUDIO_SFX',
      'SOURCE_RECORDING', 'ICON'];
    const filterLink = (label, params) => {
      const u = new URLSearchParams(params);
      return `<a class="tab" href="#/assets?${u}">${esc(label)}</a>`;
    };
    return `<h1>Asset library</h1>
      <div class="sub">Everything a production reuses: b-roll, backgrounds, locked character references, brand elements, audio, the source recordings behind AUA recaps. Binding one of these in a production plan is free; generating a new one is not.</div>
      <div class="flex" style="margin-bottom:8px">
        ${filterLink('All', {})}
        ${filterLink('Character references', { kind: 'CHARACTER_REFERENCE' })}
        ${filterLink('Backgrounds', { kind: 'BACKGROUND' })}
        ${filterLink('Awaiting review', { pending: '1', ai: 'true' })}
      </div>
      <div class="card"><div class="flex" style="flex-wrap:wrap;gap:10px">
        <input id="af-text" placeholder="search titles and codes" value="${esc(text)}" style="max-width:220px">
        <select id="af-kind" style="max-width:200px"><option value="">Any kind</option>
          ${KINDS.map(k => `<option value="${k}" ${k === kind ? 'selected' : ''}>${k.toLowerCase().replace(/_/g, ' ')}</option>`).join('')}</select>
        <select id="af-ai" style="max-width:160px"><option value="">AI or human</option>
          <option value="true" ${ai === 'true' ? 'selected' : ''}>AI generated</option>
          <option value="false" ${ai === 'false' ? 'selected' : ''}>Not AI</option></select>
        <label class="otpick"><input type="checkbox" id="af-pending" ${pending ? 'checked' : ''}> include awaiting review</label>
        <button id="af-go">Filter</button>
        <span class="spacer"></span>
        <input id="a-search" placeholder="semantic: addis evening street calm" style="max-width:240px">
        <button id="a-go">Semantic search</button>
      </div>
      <div class="muted" style="font-size:12px;margin-top:6px">Semantic search is coarse right now: embeddings fall back to a deterministic stand-in until a real embedding provider is configured. The text filter is exact and reliable.</div>
      <div id="a-results"></div></div>
      ${can('asset.manage') ? `<div class="card"><div class="eyebrow">Add to the library</div>
        <div class="flex" style="flex-wrap:wrap;gap:10px">
          <input type="file" id="au-file" style="max-width:230px">
          <input id="au-title" placeholder="title" style="max-width:200px">
          <select id="au-kind" style="max-width:200px">${KINDS.filter(k => k !== 'MEDICAL_ILLUSTRATION').map(k => `<option value="${k}">${k.toLowerCase().replace(/_/g, ' ')}</option>`).join('')}</select>
          <input id="au-tags" placeholder="tags, comma separated" style="max-width:200px">
          <button class="primary" id="au-upload">Upload</button>
        </div>
        <div class="flex" style="margin-top:10px;gap:10px">
          <input id="a-brief" placeholder="or generate: young woman reading her phone in a shared taxi, dusk" style="flex:1">
          <select id="a-kind" style="max-width:170px"><option value="IMAGE_PHOTO">Image (Gemini)</option>
            <option value="VIDEO">Video (Kling/Veo)</option></select>
          <button id="a-gen">Generate &rarr; review</button>
        </div>
        <div class="muted" style="font-size:12px;margin-top:6px">Generated assets stay out of the library until a producer reviews and saves them. Medical illustrations are never generated; they enter through clinical review only.</div>
      </div>` : ''}
      <div class="agrid">
        ${r.items.map(a => `<div class="acard ${!a.is_active ? 'pending' : ''}">
          ${assetThumb(a)}
          <div class="ainfo">
            <div class="flex"><b style="font-size:12.5px">${esc(a.title)}</b><span class="spacer"></span>
              ${a.clinically_approved ? '<span class="pill p-APPROVED"><span class="d"></span>clinical</span>' : ''}</div>
            <div class="muted" style="font-size:11px">${esc(a.kind.toLowerCase().replace(/_/g, ' '))} · ${esc(a.origin.toLowerCase().replace(/_/g, ' '))}${a.is_ai_generated ? ' · AI' : ''} · <span class="mono">${esc(a.code)}</span></div>
            ${(a.tags ?? []).length ? `<div class="muted" style="font-size:10.5px">${a.tags.map(esc).join(' · ')}</div>` : ''}
            ${!a.is_active && can('asset.manage') ? `
              <input id="as-title-${esc(a.id)}" placeholder="title for the library" value="${esc(a.title)}" style="margin-top:6px">
              <input id="as-tags-${esc(a.id)}" placeholder="tags, comma separated" style="margin-top:4px">
              <button class="approve" data-assetsave="${esc(a.id)}" style="margin-top:6px">Save to library</button>` : ''}
          </div>
        </div>`).join('') || '<div class="card empty" style="grid-column:1/-1">Nothing matches. Clear the filters, or add the first asset above.</div>'}
      </div>`;
  },

  // ---------- Video Studio (18 Aug 2026) ----------
  // Standalone AI video production pipeline (Postgres schema `studio`,
  // apps/api/src/modules/studio.mjs), deliberately separate from the
  // quick send_it/save_it Kling render path already covered by the
  // Production section above. Continuity locks, shot-by-shot generation
  // with automated QC, then assembly into a rough cut. Two other engineers
  // are extending the backend concurrently (budget guardrails, retry,
  // assembly) tonight, so every field read off the project/shot/asset
  // payloads here is optional-chained: a field that does not exist yet
  // just does not render, rather than throwing.
  async studio() {
    const qp = new URLSearchParams((location.hash.split('?')[1] ?? ''));
    const showArchived = qp.get('archived') === '1';
    const r = await api('GET', `/studio/projects${showArchived ? '?include_archived=1' : ''}`);
    const items = (r.items ?? []).filter(p => showArchived || !p.archived_at);
    return `<h1>Video Studio</h1><div class="sub">The standalone AI video pipeline: continuity-locked characters and environments, shot-by-shot generation with automated QC, then assembly. Separate from the quick renders under Production.</div>
      <div class="card"><table>
      <tr><th>Code</th><th>Title</th><th>Format</th><th>State</th><th>Aspect</th><th>Created</th></tr>
      ${items.map(p => `<tr class="rowlink" data-nav="studio-project/${esc(p.id)}" tabindex="0">
        <td class="mono"><b>${esc(p.code)}</b></td>
        <td>${esc(p.title)}${p.archived_at ? ' <span class="pill p-QC_BLOCKED"><span class="d"></span>archived</span>' : ''}</td>
        <td>${esc(p.format)}</td>
        <td>${pill(p.state)}</td>
        <td class="mono">${esc(p.aspect_ratio)}</td>
        <td class="muted">${dt(p.created_at)}</td></tr>`).join('') || empty(6, showArchived ? 'No archived projects.' : 'No Video Studio projects yet. Start one below.')}
      </table>
      <div style="margin-top:10px"><a href="#/studio${showArchived ? '' : '?archived=1'}" class="muted" style="font-size:12px">${showArchived ? 'Hide archived projects' : 'Show archived projects'}</a></div>
      </div>
      ${can('studio.write') ? `<div class="card"><div class="eyebrow">New project</div>
        <div class="grid2">
          <div>
            <label>Title</label><input id="st-title" placeholder="e.g. Maya's first visit">
            <label>Format</label><select id="st-format">
              ${STUDIO_FORMATS.map(f => `<option value="${esc(f.value)}"${f.value === 'ai_story' ? ' selected' : ''}>${esc(f.label)}</option>`).join('')}
            </select>
            <div class="muted" id="st-format-desc" style="font-size:12px;margin-top:4px">${esc(STUDIO_FORMATS.find(f => f.value === 'ai_story').desc)}</div>
          </div>
          <div>
            <label>Aspect ratio</label><select id="st-aspect">
              <option value="9:16" selected>9:16 (vertical)</option>
              <option value="16:9">16:9 (widescreen)</option>
              <option value="1:1">1:1 (square)</option></select>
            <label>Language</label><select id="st-lang">
              <option value="am" selected>Amharic</option>
              <option value="en">English</option></select>
            <label>Budget cap (USD, optional)</label>
            <input id="st-budget" type="number" min="0" step="0.01" placeholder="leave blank for no cap">
          </div>
        </div>
        <div style="margin-top:12px"><button class="primary" id="st-newproj-go">Create project</button></div>
      </div>` : ''}`;
  },

  async 'studio-project'(id) {
    let p;
    try { p = await api('GET', `/studio/projects/${id}`); }
    catch (ex) {
      return `<a class="backlink" href="#/studio">&larr; All Video Studio projects</a>
        <h1>Project not found</h1>
        <div class="sub">${esc(ex.message)}</div>
        <div class="card empty">Nothing to show here. Head back to the project list.</div>`;
    }
    const locks = Array.isArray(p.locks) ? p.locks : [];
    const shots = Array.isArray(p.shots) ? p.shots : [];
    const events = Array.isArray(p.events) ? p.events : [];
    // Overlays (19 Aug 2026): not embedded in GET /studio/projects/:id like
    // locks/shots/events are, so fetched separately -- same pattern the
    // Assets & QC panel already uses for its own per-shot fetch below.
    let overlays = [];
    try { overlays = (await api('GET', `/studio/projects/${id}/overlays`)).items ?? []; } catch { overlays = []; }

    // Budget: only shown when a cap was actually set. budget_pct/budget_warning
    // are speculative fields another engineer's concurrent guardrail work may
    // add tonight; shown only if present, never assumed.
    let budgetHtml = '';
    if (p.budget_cap_usd != null) {
      const spent = Number(p.spent_usd ?? 0);
      const cap = Number(p.budget_cap_usd);
      const pct = Math.min(100, Math.round((spent / (cap || 1)) * 100));
      budgetHtml = `<div style="max-width:380px;margin-top:10px">
        <div class="flex" style="justify-content:space-between">
          <span style="font-size:12px">Budget</span>
          <span class="mono" style="font-size:12px">$${spent.toFixed(2)} of $${cap.toFixed(2)} spent</span></div>
        <div class="meter"><div class="meter-fill ${pct >= 100 ? 'full' : pct >= 75 ? 'warn' : ''}" style="width:${pct}%"></div></div>
        ${p.budget_pct != null ? `<div class="muted" style="font-size:11px;margin-top:4px">${esc(String(p.budget_pct))}% of cap</div>` : ''}
        ${p.budget_warning ? `<div class="claimrow" style="border-left-color:var(--risk-mod);margin-top:6px;font-size:12px">${esc(p.budget_warning)}</div>` : ''}
      </div>`;
    }

    // Brief import (19 Aug 2026): turns a free-text production brief (the
    // real trigger being "Spotting on the Pill", a 25s Send-It format
    // clip) into a draft covering one presenter shot, its overlays, and a
    // caption, so Rudy/Girum never have to retype a brief field by field.
    // Same review-before-anything-saves discipline as the lock drafter
    // above -- Draft calls /import-brief and saves nothing; the human
    // reviews (and can edit the JSON below) before Apply draft actually
    // creates the shot and overlay rows via /import-brief/apply.
    const importBriefHtml = can('studio.write') ? `<div class="card"><div class="eyebrow">Import a brief</div>
      <div class="sub" style="margin-top:-4px;margin-bottom:10px">Paste a production brief (timed script moments, overlay colors/fonts/positions, icon mentions, a caption). AI drafts ONE presenter shot spanning the whole runtime plus the overlays it describes -- a brief like this is one continuous take with timing beats layered on top, never several separate shots. Nothing is saved until you review the draft below and click Apply draft.</div>
      <label>Brief text</label>
      <textarea id="st-brief-freetext" rows="6" placeholder="e.g. DURATION: 25 seconds / ASPECT: 9:16 / timed script moments, overlay colors and positions, icon mentions, a caption..."></textarea>
      <button style="margin-top:6px" data-stbriefdraft="${esc(id)}">Draft from this brief</button>
      <div id="st-brief-draftbox" hidden style="margin-top:12px"></div>
    </div>` : '';

    // Reference thumbnails + remix/library/upload (21 Aug 2026): before this,
    // a lock's generated reference image was invisible anywhere in the UI --
    // the only signal was the text "has reference image". This renders the
    // newest version (reference_assets is already ordered oldest-first by
    // the API, so .at(-1) is the current one) as an actual thumbnail, links
    // it to the full-size file for a real preview, and adds the three ways
    // to get a new reference version onto this lock without necessarily
    // paying for a from-scratch Gemini generation: remix the current image
    // through Gemini with a new instruction, pick an existing image from the
    // library, or upload one of your own.
    const locksHtml = locks.length ? locks.map(l => {
      const refs = l.reference_assets ?? [];
      const latestRef = refs.length ? refs[refs.length - 1] : null;
      const libKind = l.entity_type === 'CHARACTER' ? 'CHARACTER_REFERENCE' : l.entity_type === 'ENVIRONMENT' ? 'BACKGROUND' : null;
      return `<div class="card" style="margin-bottom:8px">
        <div class="flex">
          <span class="mono">${esc(l.entity_type)} &middot; ${esc(l.entity_code)}</span>
          <span class="muted">v${esc(String(l.version ?? 1))}</span>
          ${l.approved_at ? `<span class="pill p-APPROVED"><span class="d"></span>approved</span>`
            : `<span class="pill p-PENDING"><span class="d"></span>pending approval</span>`}
          <span class="spacer"></span>
          ${can('studio.approve') && !l.approved_at ? `<button class="approve" data-stlockapprove="${esc(l.id)}">Approve</button>` : ''}
          ${can('studio.generate') ? `<button data-stlockref="${esc(l.id)}">Generate reference image</button>` : ''}
          ${can('studio.generate') ? `<button data-stlockreftoggle="${esc(l.id)}">Reference tools</button>` : ''}
        </div>
        ${latestRef ? `<div style="margin-top:8px">
          <img class="ath" style="max-width:160px;max-height:160px;border-radius:6px;display:block;cursor:zoom-in" src="${esc(mediaUrl(latestRef.storage_key))}" alt="${esc(l.entity_code)} reference" loading="lazy" title="Click to preview" onclick="imagePreview('${esc(mediaUrl(latestRef.storage_key))}','${esc(l.entity_code)} current reference')" onerror="assetImgError(this,'REFERENCE_IMAGE')">
          <div style="font-size:11px;margin-top:2px"><span class="pill p-APPROVED" style="font-size:10px"><span class="d"></span>current</span> <span class="muted">&middot; this is the version used for generation &middot; click it to preview</span></div>
          ${refs.length > 1 ? `<div class="muted" style="font-size:11px;margin-top:8px;font-weight:600">Earlier versions -- click one to preview, or make it current again:</div>
          <div class="flex" style="flex-wrap:wrap;gap:6px;margin-top:4px">
            ${[...new Map(refs.slice(0, -1).filter(r2 => r2.storage_key !== latestRef.storage_key).map(r2 => [r2.storage_key, r2])).values()].reverse().map(r2 => `
              <div style="text-align:center">
                <img class="ath" style="max-width:72px;max-height:72px;border-radius:4px;display:block;cursor:zoom-in" src="${esc(mediaUrl(r2.storage_key))}" alt="earlier version" loading="lazy" title="Click to preview" onclick="imagePreview('${esc(mediaUrl(r2.storage_key))}','${esc(l.entity_code)} earlier version')" onerror="assetImgError(this,'REFERENCE_IMAGE')">
                <button style="font-size:10px;padding:2px 6px;margin-top:2px" data-strefselect="${esc(l.id)}|${esc(r2.id)}">Make current</button>
              </div>`).join('')}
          </div>` : ''}
        </div>` : `<div class="muted" style="font-size:12px;margin-top:8px">No reference image yet.</div>`}
        ${can('studio.generate') ? `<div style="margin-top:10px">
          <button data-stpacktoggle="${esc(l.id)}">Reference pack (sheets)</button>
          <span class="muted" style="font-size:11px;margin-left:6px">Turnaround, expressions, poses, costume, palette, location angles</span>
          <div id="stpackbox-${esc(l.id)}" hidden style="margin-top:8px"></div>
        </div>` : ''}
        ${can('studio.generate') ? `<div id="stlockrefpanel-${esc(l.id)}" hidden style="margin-top:10px;border-top:1px solid #e5e5e5;padding-top:10px">
          <div style="font-size:12px;font-weight:600;margin-bottom:6px">Remix with Gemini</div>
          <div class="muted" style="font-size:11px;margin-bottom:4px">Sends the current reference image back to Gemini with a new instruction (e.g. "add glasses", "same doctor, evening lighting") instead of generating from scratch. Becomes the new current version; the old one stays in history.</div>
          <div class="flex" style="gap:6px">
            <input id="stremixprompt-${esc(l.id)}" placeholder="e.g. same doctor, add glasses" style="flex:1" ${latestRef ? '' : 'disabled'}>
            <button data-stlockremix="${esc(l.id)}" data-stlockremixasset="${latestRef ? esc(latestRef.id) : ''}" ${latestRef ? '' : 'disabled title="Generate a reference image first"'}>Remix</button>
          </div>
          ${libKind ? `<div style="font-size:12px;font-weight:600;margin:12px 0 4px">Pick from the library</div>
            <button data-stlocklibopen="${esc(l.id)}|${esc(l.entity_type)}">Browse ${libKind === 'CHARACTER_REFERENCE' ? 'character references' : 'backgrounds'}</button>
            <div id="stlocklibbox-${esc(l.id)}" hidden style="margin-top:8px"></div>` : ''}
          <div style="font-size:12px;font-weight:600;margin:12px 0 4px">Upload your own</div>
          <div class="flex" style="gap:6px">
            <input type="file" id="stlockuploadfile-${esc(l.id)}" accept="image/*">
            <button data-stlockuploadgo="${esc(l.id)}">Upload as reference</button>
          </div>
        </div>` : ''}
      </div>`;
    }).join('') : '<div class="card empty">No locks yet.</div>';

    const newLockHtml = can('studio.write') ? `<div class="card"><div class="eyebrow">New lock</div>
      <div class="sub" style="margin-top:-4px;margin-bottom:10px">A lock is a reusable description of something that has to look the same in every shot -- a character, a place, an object, or the project's overall style. Create one for each recurring element before generating shots that use it.</div>
      <div class="grid2">
        <div>
          <label>What kind of lock</label><select id="st-lock-level">
            ${LOCK_LEVELS.map(v => `<option value="${esc(v.value)}"${v.value === 'L1_ENTITY' ? ' selected' : ''}>${esc(v.label)}</option>`).join('')}
          </select>
          <div class="muted" id="st-lock-level-desc" style="font-size:12px;margin-top:2px;margin-bottom:8px">${esc(LOCK_LEVELS.find(v => v.value === 'L1_ENTITY').desc)}</div>
          <label>Entity type</label><select id="st-lock-entitytype">
            ${LOCK_ENTITY_TYPES.map(v => `<option value="${esc(v.value)}"${v.value === 'CHARACTER' ? ' selected' : ''}>${esc(v.label)}</option>`).join('')}
          </select>
          <div class="muted" id="st-lock-entitytype-desc" style="font-size:12px;margin-top:2px;margin-bottom:8px">${esc(LOCK_ENTITY_TYPES.find(v => v.value === 'CHARACTER').desc)}</div>
          <label>Entity code</label><input id="st-lock-entitycode" placeholder="e.g. CHR-MAYA">
          <div class="muted" style="font-size:12px;margin-top:2px">A short ID you make up, so shots can reference this lock. Reuse the same code every time this same character/place/object needs a shot.</div>
        </div>
        <div>
          <label>Describe it in your own words</label>
          <div class="muted" style="font-size:12px;margin-bottom:4px">Write what you'd tell someone on the phone -- who or what it is, what it looks like, anything it should never have. AI drafts the fields below from this; you review and fix anything before creating the lock.</div>
          <textarea id="st-lock-freetext" placeholder="e.g. Maya is a woman in her late 20s, chin-length black bob, wearing an ochre field jacket. No earrings."></textarea>
          <button style="margin-top:6px" data-stlockdraft="1">Draft with AI</button>
          <div class="claimrow" id="st-lock-draftnote" hidden style="margin-top:8px;font-size:12px"></div>
          <label style="margin-top:12px;display:block">Lock data (JSON)</label>
          <div class="muted" style="font-size:12px;margin-bottom:4px">Filled in automatically by Draft with AI, or write it yourself. These are the exact fields read when building the generation prompt -- edit anything that isn't right before creating the lock.</div>
          <textarea id="st-lock-data" placeholder="${esc(LOCK_ENTITY_TYPES.find(v => v.value === 'CHARACTER').example)}"></textarea>
        </div>
      </div>
      <div style="margin-top:12px"><button class="primary" data-stlockcreate="${esc(id)}">Create lock</button></div>
    </div>` : '';

    const acceptedMark = (s) => s.accepted_asset_id
      ? '<span style="color:var(--risk-routine);font-weight:600">&check; accepted</span>'
      : '<span class="muted">&mdash;</span>';

    // Step-by-step first frame (19 Aug 2026): Letena's real Instagram
    // doctor-presenter content is the same doctor (CHARACTER lock) across
    // different backdrops (ENVIRONMENT lock) -- so before the single
    // opaque "Generate" call, a shot can compose its first frame from
    // those two locks explicitly. This block sits ABOVE Generate and never
    // replaces it: a text_to_video shot with no locks attached renders
    // "not attached" for both steps and Generate below still works exactly
    // as before.
    const lockById = new Map(locks.map(l => [l.id, l]));
    const lockReady = (l) => !!(l && l.approved_at && (l.reference_asset_ids ?? []).length);
    const stepLine = (num, label, lock) => {
      if (!lock) return `<div style="font-size:11px;margin-top:2px">Step ${num} &middot; ${esc(label)}: <span class="muted">not attached</span> &mdash; <button type="button" data-stscrolltolocks="1" style="font-size:11px;padding:2px 8px">Attach or create one</button></div>`;
      const approved = lock.approved_at
        ? '<span style="color:var(--risk-routine)">approved</span>'
        : '<span style="color:var(--risk-mod)">not approved</span>';
      const hasRef = (lock.reference_asset_ids ?? []).length
        ? '<span style="color:var(--risk-routine)">has reference image</span>'
        : '<span style="color:var(--risk-mod)">no reference image yet</span>';
      return `<div style="font-size:11px;margin-top:2px">Step ${num} &middot; ${esc(label)}: <span class="mono">${esc(lock.entity_code)}</span> &middot; ${approved} &middot; ${hasRef}</div>`;
    };
    const composeStepHtml = (s) => {
      if (!can('studio.generate')) return '';
      const attached = (s.locked_lock_ids ?? []).map(lid => lockById.get(lid)).filter(Boolean);
      const charLock = attached.find(l => l.entity_type === 'CHARACTER');
      const envLock = attached.find(l => l.entity_type === 'ENVIRONMENT');
      const ready = lockReady(charLock) && lockReady(envLock);
      const alreadySet = s.generation?.first_frame_asset_id && s.generation?.mode_preference === 'image_to_video';
      return `<div class="claimrow" style="margin-bottom:8px">
        <div style="font-size:11px;font-weight:600;margin-bottom:2px">Step-by-step first frame (optional)</div>
        ${stepLine(1, 'Character', charLock)}
        ${stepLine(2, 'Background', envLock)}
        <button style="margin-top:6px" ${ready ? '' : 'disabled'} title="${ready
          ? 'Compose the locked character into the locked background as this shot&#39;s first frame'
          : 'Attach an approved CHARACTER lock and an approved ENVIRONMENT lock, each with a reference image, before composing'}"
          data-stshotcompose="${esc(s.id)}">Step 3 &middot; Compose first frame</button>
        ${alreadySet ? `<div class="muted" style="font-size:11px;margin-top:4px">&check; first frame set -- Generate below will run image_to_video using it.</div>` : ''}
        <div id="stcomposebox-${esc(s.id)}"></div>
      </div>`;
    };

    // Continue from the shot before this one (owner request, 21 Aug 2026:
    // reproduce Kling's "last frame becomes the next first frame" so
    // shots visually flow together, provider-agnostically -- works the
    // same whether the accepted video came from Kling, Runway, or VEO).
    // Sibling of composeStepHtml above, same "sits above Generate, never
    // replaces it" discipline. prevShotFor looks at THIS render's own
    // shots list rather than a fresh request, since order_index is always
    // already loaded here.
    const prevShotFor = (s) => {
      const earlier = shots.filter(o => Number(o.order_index ?? 0) < Number(s.order_index ?? 0));
      if (!earlier.length) return null;
      return earlier.reduce((a, b) => (Number(b.order_index) > Number(a.order_index) ? b : a));
    };
    const continueStepHtml = (s) => {
      if (!can('studio.generate')) return '';
      const prev = prevShotFor(s);
      const ready = !!(prev && prev.accepted_asset_id);
      const already = s.generation?.continued_from_shot_id;
      return `<div class="claimrow" style="margin-bottom:8px">
        <div style="font-size:11px;font-weight:600;margin-bottom:2px">Continue from previous shot (optional)</div>
        <div style="font-size:11px;margin-top:2px">${prev
          ? `Previous shot: <span class="mono">${esc(prev.shot_code)}</span> &middot; ${prev.accepted_asset_id
              ? '<span style="color:var(--risk-routine)">has an accepted video</span>'
              : '<span style="color:var(--risk-mod)">no accepted video yet</span>'}`
          : '<span class="muted">this is the first shot &mdash; nothing before it to continue from</span>'}</div>
        <button style="margin-top:6px" ${ready ? '' : 'disabled'} title="${ready
          ? `Pull ${esc(prev.shot_code)}&#39;s accepted video&#39;s last frame as this shot&#39;s first frame, so the two shots flow together`
          : (prev ? `Accept ${esc(prev.shot_code)}&#39;s generated video first` : 'No earlier shot in this project')}"
          data-stshotcontinue="${esc(s.id)}">Continue from previous shot</button>
        ${already ? `<div class="muted" style="font-size:11px;margin-top:4px">&check; continuing from a prior shot's last frame -- Generate below will use it.</div>` : ''}
        <div id="stcontinuebox-${esc(s.id)}"></div>
      </div>`;
    };

    const shotsHtml = shots.length ? `<div class="card"><table>
      <tr><th>Shot</th><th>Beat</th><th>Status</th><th>Duration (s)</th><th>Asset</th><th></th></tr>
      ${shots.map(s => {
        const beat = s.story?.beat ?? '';
        const editable = ['DRAFT', 'STALE'].includes(s.status);
        return `<tr>
          <td class="mono"><b>${esc(s.shot_code)}</b><div class="muted" style="font-size:11px">#${esc(String(s.order_index ?? ''))}</div></td>
          <td style="max-width:240px">${esc(beat)}</td>
          <td>${pill(s.status)}</td>
          <td class="mono">${esc(String(s.duration_target_s ?? ''))}</td>
          <td>${acceptedMark(s)}</td>
          <td style="min-width:220px">
            ${composeStepHtml(s)}
            ${continueStepHtml(s)}
            <div class="flex" style="flex-wrap:wrap">
              ${can('studio.generate') ? `<button data-stshotgenerate="${esc(s.id)}">Generate</button>` : ''}
              ${can('studio.generate') ? `<button data-stshotvoiceshow="${esc(s.id)}">Add voice</button>` : ''}
              <button data-stassets="${esc(s.id)}">Assets &amp; QC</button>
            </div>
            ${editable && can('studio.write') ? `<div class="claimrow" style="margin-top:8px">
              <label>Duration target (s)</label>
              <input id="stedit-dur-${esc(s.id)}" type="number" min="1" value="${esc(String(s.duration_target_s ?? 5))}">
              <label>Story beat</label><textarea id="stedit-beat-${esc(s.id)}">${esc(beat)}</textarea>
              <button style="margin-top:6px" data-stshotedit="${esc(s.id)}">Save changes</button>
            </div>` : ''}
            <div id="stvoice-${esc(s.id)}" hidden style="margin-top:8px">
              <label>Voice line</label>
              <textarea id="stvoicetext-${esc(s.id)}" placeholder="The spoken line for this shot"></textarea>
              <button style="margin-top:6px" data-stshotvoice="${esc(s.id)}">Send voice</button>
            </div>
            <div id="stassetsbox-${esc(s.id)}" hidden></div>
          </td>
        </tr>`;
      }).join('')}
      </table></div>` : '<div class="card empty">No shots yet. Add the first one below.</div>';

    const newShotHtml = can('studio.write') ? `<div class="card"><div class="eyebrow">New shot</div>
      <div class="grid2">
        <div>
          <label>Shot code</label><input id="st-shot-code" placeholder="e.g. SH-010">
          <label>Order index</label><input id="st-shot-order" type="number" min="0" value="${shots.length}">
          <label>Duration target (s)</label><input id="st-shot-dur" type="number" min="1" value="5">
        </div>
        <div>
          <label>Story beat</label><textarea id="st-shot-beat" placeholder="What happens in this shot"></textarea>
          <label>Continuity characters (comma separated entity codes)</label>
          <input id="st-shot-chars" placeholder="e.g. CHR-MAYA, CHR-SAM">
          <label>Camera movement (optional)</label><input id="st-shot-camera" placeholder="e.g. slow push in">
          <label>Action subject (optional)</label><input id="st-shot-action" placeholder="e.g. Maya opens the door">
        </div>
      </div>
      <div style="margin-top:12px"><button class="primary" data-stshotcreate="${esc(id)}">Add shot</button></div>
    </div>` : '';

    const musicHtml = can('studio.generate') ? `<div class="card"><div class="eyebrow">Project music</div>
      <label>Brief (required)</label>
      <textarea id="st-music-prompt" placeholder="e.g. gentle, hopeful, acoustic guitar underscore"></textarea>
      <div class="grid2">
        <div><label>Tempo (BPM, optional)</label><input id="st-music-tempo" type="number" min="1"></div>
        <div><label>Duration (s, optional)</label><input id="st-music-duration" type="number" min="1"></div>
      </div>
      <div style="margin-top:12px"><button class="primary" data-stmusic="${esc(id)}">Generate music</button></div>
    </div>` : '';

    const assembleHtml = can('studio.approve') ? `<div class="card"><div class="eyebrow">Assemble</div>
      <div class="sub" style="margin-bottom:8px">Stitches every accepted shot asset (plus music, if given) into the rough cut, then burns in every approved overlay as a final pass. Every shot needs an accepted asset, and every overlay on this project needs to be approved (or removed), before this will run.</div>
      <div class="grid2">
        <div><label>Transition (optional)</label><select id="st-assemble-transition">
          <option value="cut" selected>Cut</option>
          <option value="crossfade">Crossfade</option></select></div>
        <div><label>Music asset ID (optional)</label>
          <input id="st-assemble-music" placeholder="paste a MUSIC asset id, if any"></div>
      </div>
      <div style="margin-top:12px"><button class="primary" data-stassemble="${esc(id)}">Assemble rough cut</button></div>
    </div>` : '';

    // Overlays (19 Aug 2026): burned-in title cards, on-screen labels, the
    // closing door card, and icon moments. v1 form is deliberately a kind
    // selector plus one JSON textarea for `data` -- the pre-AI-assist shape
    // the lock form used before tonight's lock-drafter feature -- since an
    // AI-drafting UI for overlays is separate follow-up work, not this pass.
    const overlaysHtml = overlays.length ? `<div class="card"><table>
      <tr><th>Kind</th><th>Time range</th><th>Status</th><th></th></tr>
      ${overlays.map(o => `<tr>
        <td class="mono">${esc(o.kind)}</td>
        <td class="mono">${esc(String(o.start_s))}s &ndash; ${esc(String(o.end_s))}s</td>
        <td>${o.approved_at
          ? `<span class="pill p-APPROVED"><span class="d"></span>approved</span>`
          : `<span class="pill p-PENDING"><span class="d"></span>pending approval</span>`}</td>
        <td class="flex" style="flex-wrap:wrap">
          ${can('studio.approve') && !o.approved_at ? `<button class="approve" data-stoverlayapprove="${esc(o.id)}">Approve</button>` : ''}
          ${can('studio.write') ? `<button data-stoverlaydelete="${esc(o.id)}" style="color:var(--risk-high)">Delete</button>` : ''}
        </td>
      </tr>`).join('')}
      </table></div>` : '<div class="card empty">No overlays yet. Nothing extra burns into the rough cut until one is added and approved below.</div>';

    const newOverlayHtml = can('studio.write') ? `<div class="card"><div class="eyebrow">New overlay</div>
      <div class="sub" style="margin-top:-4px;margin-bottom:10px">A burned-in graphic over the footage -- a title card, an on-screen label, the closing door/CTA card, or an icon. Must be approved before it burns into assembly.</div>
      <div class="grid2">
        <div>
          <label>Kind</label><select id="st-overlay-kind">
            <option value="TITLE_CARD">Title card</option>
            <option value="LABEL">Label</option>
            <option value="DOOR_CARD">Door / CTA card</option>
            <option value="ICON">Icon</option>
          </select>
          <label>Start (s)</label><input id="st-overlay-start" type="number" min="0" step="0.1" placeholder="e.g. 0">
          <label>End (s)</label><input id="st-overlay-end" type="number" min="0" step="0.1" placeholder="e.g. 2">
          <label>Order index</label><input id="st-overlay-order" type="number" min="0" value="0">
        </div>
        <div>
          <label>What it says and how it looks</label>
          <div class="muted" style="font-size:12px;margin-bottom:6px">Fill these in and the JSON underneath writes itself. Colours use Letena's palette by default.</div>

          <div id="st-ov-text-fields">
            <label style="font-size:11px">Text</label>
            <textarea id="st-ov-text" rows="2" placeholder="e.g. የሆርሞን እንክብል ስትወስጂ ደም መፍሰስ?"></textarea>
          </div>

          <div id="st-ov-door-fields" hidden>
            <label style="font-size:11px">Door card lines (one per line, biggest first)</label>
            <textarea id="st-ov-doorlines" rows="4" placeholder="DM አርጊን&#10;በነፃ ነው&#10;Link in bio&#10;ለጓደኛሽም ላኪላት"></textarea>
            <div class="muted" style="font-size:11px">Each line fades in half a second after the one above it.</div>
          </div>

          <div id="st-ov-icon-fields" hidden>
            <label style="font-size:11px">Icon asset id</label>
            <input id="st-ov-assetid" placeholder="paste an ICON asset id from the library">
            <div class="muted" style="font-size:11px">Upload the icon to the asset library first, as kind ICON.</div>
          </div>

          <div class="flex" style="gap:10px;flex-wrap:wrap;margin-top:8px" id="st-ov-style-fields">
            <div><label style="font-size:11px">Text colour</label><br>
              <input type="color" id="st-ov-textcolor" value="#EBAB20" style="width:56px;height:30px;padding:2px"></div>
            <div><label style="font-size:11px">Background</label><br>
              <input type="color" id="st-ov-bgcolor" value="#16103F" style="width:56px;height:30px;padding:2px"></div>
            <div><label style="font-size:11px">Background opacity</label><br>
              <input type="range" id="st-ov-bgopacity" min="0" max="1" step="0.05" value="0.9" style="width:110px"></div>
            <div><label style="font-size:11px">Text size (px)</label><br>
              <input type="number" id="st-ov-fontsize" value="56" min="12" max="140" style="width:80px"></div>
            <div><label style="font-size:11px">Weight</label><br>
              <select id="st-ov-fontfamily" style="width:100px"><option value="bold">bold</option><option value="regular">regular</option></select></div>
          </div>

          <div class="flex" style="gap:10px;flex-wrap:wrap;margin-top:8px" id="st-ov-place-fields">
            <div><label style="font-size:11px">Where on screen</label><br>
              <select id="st-ov-anchor" style="width:140px">
                <option value="upper-third">upper third</option><option value="top">top</option>
                <option value="top-right">top right</option><option value="right-center">right centre</option>
                <option value="center">centre</option></select></div>
            <div><label style="font-size:11px">Fade in</label><br>
              <select id="st-ov-animin" style="width:120px">
                <option value="fade">fade</option><option value="slide-left">slide from left</option>
                <option value="slide-right">slide from right</option><option value="none">none</option></select></div>
            <div><label style="font-size:11px">Fade out</label><br>
              <select id="st-ov-animout" style="width:100px"><option value="fade">fade</option><option value="none">none</option></select></div>
          </div>

          <details style="margin-top:10px">
            <summary style="font-size:12px;cursor:pointer">Advanced: edit the raw JSON instead</summary>
            <div class="muted" style="font-size:11px;margin:4px 0">Anything typed here wins over the fields above. Leave it empty to use the fields.</div>
            <textarea id="st-overlay-data" rows="4" placeholder="leave empty unless you need a field the form does not cover"></textarea>
          </details>
        </div>
      </div>
      <div style="margin-top:12px"><button class="primary" data-stoverlaycreate="${esc(id)}">Create overlay</button></div>
    </div>` : '';

    const eventsHtml = events.length ? `<div class="card"><div class="eyebrow">Recent events</div>
      <div class="kv">${events.slice(0, 50).map(ev =>
        `<div>${dt(ev.at)} &mdash; ${esc(ev.note ?? ev.event ?? ev.type ?? '')}${ev.actor_id ? ` <span class="muted">(${esc(ev.actor_id)})</span>` : ''}</div>`).join('')}</div>
    </div>` : '';

    return `<a class="backlink" href="#/studio">&larr; All Video Studio projects</a>
      <div class="eyebrow">Video Studio project</div>
      <h1>${esc(p.code)} &middot; ${esc(p.title)}</h1>
      <div class="sub flex">${pill(p.state)}
        ${p.archived_at ? `<span class="pill p-QC_BLOCKED"><span class="d"></span>archived</span>` : ''}
        <span class="muted">${esc(p.aspect_ratio ?? '')} &middot; ${esc(String(p.fps ?? ''))} fps &middot; ${esc(p.language ?? '')}</span>
        <span class="spacer"></span>
        ${can('studio.approve') ? (p.archived_at
          ? `<button data-stunarchive="${esc(p.id)}">Unarchive project</button>`
          : `<button data-starchive="${esc(p.id)}" style="color:var(--risk-high)">Archive project</button>`) : ''}
      </div>
      ${p.archived_at ? `<div class="claimrow" style="border-left-color:var(--risk-mod);margin-top:6px;font-size:12px">This project is archived and hidden from the Video Studio list. Nothing about its locks, shots, or generated assets was deleted -- unarchive to bring it back into view.</div>` : ''}
      ${budgetHtml}
      ${importBriefHtml}
      <div class="eyebrow" style="margin-top:20px" id="st-locks-anchor">Locks</div>
      ${locksHtml}
      ${newLockHtml}
      <div class="eyebrow" style="margin-top:20px">Shots</div>
      ${shotsHtml}
      ${newShotHtml}
      <div class="eyebrow" style="margin-top:20px">Overlays</div>
      ${overlaysHtml}
      ${newOverlayHtml}
      ${musicHtml}
      ${assembleHtml}
      ${eventsHtml}`;
  },

  // Script-to-project bridge (19 Aug 2026): the review screen a VIDEO-kind
  // APPROVED script's "Start Video Studio project" button (scripts/reviews
  // lists) lands on, sibling of the "Import a brief" section on the
  // project screen above but for a structured, already-approved script
  // instead of a pasted free-text brief. Same discipline as everywhere
  // else in Video Studio: nothing is saved by loading this screen or by
  // Draft from this script -- POST /studio/projects/from-script/draft only
  // ever returns a draft (or, if this script already has a linked
  // project, existing_project). Drafting is a deliberate click here, same
  // as "Draft from this brief" and "Draft with AI" on locks, rather than
  // an automatic call on page load/refresh -- a real (non-MOCK) call costs
  // real AI spend, and this screen can be reloaded or navigated back to.
  async 'studio-from-script'(scriptId) {
    let s;
    try { s = await api('GET', `/content/scripts/${scriptId}`); }
    catch (ex) {
      return `<a class="backlink" href="#/scripts">&larr; Scripts</a>
        <h1>Script not found</h1><div class="sub">${esc(ex.message)}</div>`;
    }
    return `<a class="backlink" href="#/script/${esc(scriptId)}">&larr; Back to script</a>
      <h1>Start a Video Studio project</h1>
      <div class="sub">From script ${esc(s.code ?? '')}${s.version?.hook ? ` &middot; ${esc(String(s.version.hook).slice(0, 90))}` : ''}. AI drafts the project, its shot(s), and its overlays from this approved script -- one shot per distinct scene when the script's scene plan names more than one, otherwise one continuous shot for the whole runtime. Nothing is saved until you review the draft below and click Apply draft.</div>
      <div class="card">
        <button class="primary" data-stscriptdraft="${esc(scriptId)}">Draft from this script</button>
        <div id="st-script-draftbox" hidden style="margin-top:12px"></div>
      </div>`;
  },

  async published() {
    const r = await api('GET', '/distribution/published');
    return `<h1>Published content</h1><div class="sub">Everything live, traceable to its card, claims and reviewer. Click a row for the underlying card; the link opens the live post.</div>
      <div class="card"><table><tr><th>Platform</th><th>Family</th><th>Card</th><th>Lang</th><th>Format</th><th>Published</th><th>Link</th></tr>
      ${r.items.map(p => `<tr class="rowlink" data-nav="card/${esc(p.knowledge_card_id)}" tabindex="0"><td>${chan(p.platform)}</td><td class="mono">${esc(p.family_code)}</td>
        <td class="mono">${esc(p.card_code)}</td><td>${esc(p.language)}</td>
        <td class="muted" style="font-size:11px">${esc(p.video_family)}</td>
        <td class="muted">${dt(p.published_at)}</td>
        <td>${p.platform_url ? `<a href="${esc(p.platform_url)}" target="_blank" rel="noopener">open ↗</a>` : '<span class="muted">—</span>'}</td></tr>`).join('')
      || '<tr><td colspan=7 class="empty">Nothing published yet.</td></tr>'}</table></div>`;
  },

  async analytics() {
    const r = await api('GET', '/analytics/content');
    return `<h1>Analytics</h1><div class="sub">Reach is a fourth of the story. Education 0.40, service 0.35, reach 0.25.</div>
      <div class="card"><table>
      <tr><th>Platform</th><th>Card</th><th>Views</th><th>Completion</th><th>Shares</th><th>Reach</th><th>Education</th><th>Service</th><th>Composite</th></tr>
      ${r.items.map(a => `<tr><td>${chan(a.platform)}</td><td class="mono">${esc(a.card_code)}</td>
        <td>${a.views ?? '<span class="muted">n/a</span>'}</td>
        <td>${a.completion_rate ? Math.round(a.completion_rate * 100) + '%' : '<span class="muted">n/a</span>'}</td>
        <td>${a.shares ?? '<span class="muted">n/a</span>'}</td>
        <td>${a.reach_score ?? '—'}</td><td>${a.education_score ?? '—'}</td>
        <td>${a.service_score ?? '—'}</td><td><b>${a.composite_score ?? '—'}</b></td></tr>`).join('')
      || '<tr><td colspan=9 class="empty">No published content with metrics yet.</td></tr>'}</table></div>`;
  },

  async terminology() {
    const r = await api('GET', '/language/terminology');
    return `<h1>Terminology</h1><div class="sub">Approved Amharic wording. The localizer must use these; the avoid list blocks.</div>
      ${can('terminology.manage') ? `<div class="card"><div class="eyebrow">Add or update a term</div>
        <div class="grid2">
          <div><label>English term</label><input id="t-en">
            <label>Preferred Amharic</label><input id="t-am" class="amharic"></div>
          <div><label>Avoid (comma separated)</label><input id="t-avoid">
            <label>Register</label><select id="t-reg"><option>GENERAL</option><option>CLINICAL</option>
              <option>YOUTH</option><option>ELDER</option><option>MIXED</option></select></div>
        </div>
        <div style="margin-top:10px"><button class="primary" id="t-save">Save term</button></div></div>` : ''}
      <div class="card"><table>
      <tr><th>English</th><th>Preferred Amharic</th><th>Avoid</th><th>Register</th><th>Status</th><th></th></tr>
      ${r.items.map(t => `<tr><td>${esc(t.term_en)}</td><td class="amharic">${esc(t.preferred_am)}</td>
        <td class="muted amharic">${(t.avoid_am ?? []).map(esc).join(', ')}</td>
        <td class="muted">${esc(t.register)}</td><td>${pill(t.status)}</td>
        <td>${t.status !== 'APPROVED' && can('terminology.approve')
          ? `<button class="approve" data-termapprove="${t.id}">Approve</button>` : ''}</td></tr>`).join('')
      || '<tr><td colspan=6 class="empty">No terms yet. Seed from the last year of scripts.</td></tr>'}
      </table></div>`;
  },

  async calendar() {
    const r = await api('GET', '/distribution/calendar');
    const cardIds = await cardCodeMap();
    const rowNav = (code) => { const id = cardIds.get(code); return id ? ` class="rowlink" data-nav="card/${id}" tabindex="0"` : ''; };
    return `<h1>Publishing calendar</h1><div class="sub">Scheduled next three weeks, published last seven days. Rows with a matched card open it.</div>
      <div class="card"><div class="eyebrow">Scheduled</div><table>
      <tr><th>When</th><th>Platform</th><th>Family</th><th>Card</th><th>Lang</th><th>Tier</th><th>Status</th></tr>
      ${r.scheduled.map(j => `<tr${rowNav(j.card_code)}><td>${dt(j.scheduled_for)}</td><td>${chan(j.platform)}</td>
        <td class="mono">${esc(j.family_code)}</td><td class="mono">${esc(j.card_code)}</td>
        <td>${esc(j.language)}</td><td>${pill(j.risk_tier)}</td><td>${pill(j.status)}</td></tr>`).join('')
      || '<tr><td colspan=7 class="empty">Nothing scheduled yet. Approved and rendered content lands here.</td></tr>'}</table></div>
      <div class="card"><div class="eyebrow">Recently published</div><table>
      <tr><th>When</th><th>Platform</th><th>Family</th><th>Card</th><th>Link</th></tr>
      ${r.published.map(p => `<tr${rowNav(p.card_code)}><td>${dt(p.published_at)}</td><td>${chan(p.platform)}</td>
        <td class="mono">${esc(p.family_code)}</td><td class="mono">${esc(p.card_code)}</td>
        <td>${p.platform_url ? `<a href="${esc(p.platform_url)}" target="_blank" rel="noopener">open ↗</a>` : '<span class="muted">—</span>'}</td></tr>`).join('')
      || '<tr><td colspan=5 class="empty">Nothing published in the last seven days.</td></tr>'}</table></div>`;
  },

  async experiments() {
    const r = await api('GET', '/experiments');
    let report = '';
    try {
      const w = await api('GET', '/analytics/weekly-report');
      report = `<div class="card"><div class="eyebrow">Weekly editorial intelligence</div>
        <div style="margin-bottom:8px"><b>${esc(w.report.headline)}</b></div>
        ${w.report.recommendations.map(x => `<div class="claimrow">
          <div class="flex"><b>${esc(x.action)}</b>${pill(x.priority === 'HIGH' ? 'TIER_3' : 'DRAFT')}
            ${x.blocked_by !== 'NOTHING' ? `<span class="pill p-NEEDS_KNOWLEDGE"><span class="d"></span>blocked: ${esc(x.blocked_by)}</span>` : ''}</div>
          <div class="muted">${esc(x.rationale)}</div></div>`).join('')}</div>`;
    } catch {}
    return `<h1>Experiments</h1><div class="sub">One variable at a time. Under 10 comparable pieces is not a pattern.</div>
      ${report}
      <div class="card"><table>
      <tr><th>Code</th><th>Title</th><th>Variable</th><th>Metric</th><th>Variants</th><th>Status</th></tr>
      ${r.items.map(e => `<tr><td class="mono">${esc(e.code)}</td><td>${esc(e.title)}</td>
        <td class="muted">${esc(e.variable_tested)}</td><td class="muted">${esc(e.primary_metric)}</td>
        <td>${e.variant_count}</td><td>${pill(e.status === 'RUNNING' ? 'IN_REVIEW' : e.status === 'CONCLUDED' ? 'APPROVED' : 'DRAFT')}</td></tr>`).join('')
      || '<tr><td colspan=6 class="empty">No experiments yet. The pilot plan names four.</td></tr>'}
      </table></div>`;
  },

  async costs() {
    const r = await api('GET', '/analytics/costs');
    return `<h1>Costs</h1><div class="sub">What the machine spends, attributable to what it made</div>
      <div class="grid2">
        <div class="card"><div class="eyebrow">AI by month</div><table>
          <tr><th>Month</th><th>Calls</th><th>Tokens in/out</th><th>Cost USD</th></tr>
          ${r.by_month.map(m => `<tr><td>${esc(m.month)}</td><td>${m.calls}</td>
            <td class="muted">${m.input_tokens}/${m.output_tokens}</td><td><b>$${m.ai_cost_usd}</b></td></tr>`).join('')}
        </table></div>
        <div class="card"><div class="eyebrow">Renders by month</div><table>
          <tr><th>Month</th><th>Renders</th><th>Cost USD</th></tr>
          ${r.renders_by_month.map(m => `<tr><td>${esc(m.month)}</td><td>${m.renders}</td>
            <td><b>$${m.render_cost_usd}</b></td></tr>`).join('')}
        </table></div>
      </div>
      <div class="card"><div class="eyebrow">By agent</div><table>
        <tr><th>Agent</th><th>Calls</th><th>Failures</th><th>Cost USD</th></tr>
        ${r.by_agent.map(a => `<tr><td class="mono">${esc(a.agent_name)}</td><td>${a.calls}</td>
          <td>${a.failures ? `<span class="pill risk-mod"><span class="d"></span>${a.failures}</span>` : '0'}</td>
          <td>$${a.cost_usd}</td></tr>`).join('')}</table></div>
      <div class="card"><div class="eyebrow">Per content family</div><table>
        <tr><th>Family</th><th>Card</th><th>Published</th><th>AI cost</th><th>Render cost</th><th>Views</th></tr>
        ${r.per_piece.map(p => `<tr><td class="mono">${esc(p.family_code)}</td><td class="mono">${esc(p.card_code)}</td>
          <td>${p.published_pieces}</td><td>$${p.ai_cost_usd}</td><td>$${p.render_cost_usd}</td>
          <td>${p.total_views}</td></tr>`).join('')
        || '<tr><td colspan=6 class="empty">Nothing published yet.</td></tr>'}</table></div>`;
  },

  async users() {
    const [r, rolesRes] = await Promise.all([
      api('GET', '/platform/users'), api('GET', '/platform/roles').catch(() => ({ items: [] })) ]);
    const roles = rolesRes.items.length ? rolesRes.items.map(x => x.slug)
      : ['medical_director','consulting_doctor','content_lead','language_editor',
         'intake_coordinator','social_lead','producer','developer','viewer','admin'];
    return `<h1>Users & roles</h1><div class="sub">One account per person, real emails, no shared logins. Approval rights follow roles. Click a row to edit name, roles, and individual permissions.</div>
      <div class="card"><div class="eyebrow">Add user</div>
        <div class="grid2">
          <div><label>Email</label><input id="u-email">
            <label>Full name</label><input id="u-name"></div>
          <div><label>Temporary password (12+ chars)</label><input id="u-pw">
            <label>Role</label><select id="u-role">${roles.map(x => `<option>${esc(x)}</option>`).join('')}</select></div>
        </div>
        <div style="margin-top:10px"><button class="primary" id="u-create">Create user</button></div></div>
      <div class="card"><table>
        <tr><th>Name</th><th>Email</th><th>Roles</th><th>2FA</th><th>Last login</th><th>Status</th><th></th></tr>
        ${r.items.map(u => `<tr class="rowlink" data-nav="user/${u.id}" tabindex="0">
          <td>${esc(u.full_name)}</td><td class="mono">${esc(u.email)}</td>
          <td>${(u.roles ?? []).map(x => `<span class="pill p-DRAFT"><span class="d"></span>${esc(x)}</span>`).join(' ')}</td>
          <td>${u.totp_enabled ? pill('APPROVED') : '<span class="muted">off</span>'}</td>
          <td class="muted">${dt(u.last_login_at)}</td>
          <td>${u.is_active ? pill('ACTIVE') : pill('RETIRED')}</td>
          <td>${u.is_active ? `<button class="danger" data-deactivate="${u.id}">Deactivate</button>`
            : `<button data-ureactivate="${u.id}">Reactivate</button>`}</td>
        </tr>`).join('')}</table></div>`;
  },

  // Per-user editor: profile, roles (grant/revoke), and the permission
  // override layer on top of roles (0027_user_permission_overrides.sql).
  // Nate, 15 Aug 2026: the list screen only ever supported creating a user
  // and deactivating one; this is where the rest of it lives.
  async user(id) {
    const [u, rolesRes, permsRes] = await Promise.all([
      api('GET', `/platform/users/${id}`),
      api('GET', '/platform/roles'),
      api('GET', '/platform/permissions'),
    ]);
    const heldRoles = new Set(u.roles ?? []);
    const overrideBySlug = new Map((u.overrides ?? []).map(o => [o.slug, o.effect]));
    const effectiveSet = new Set(u.effective_permissions ?? []);
    const groups = new Map();
    for (const p of permsRes.items) {
      if (!groups.has(p.domain)) groups.set(p.domain, []);
      groups.get(p.domain).push(p);
    }
    const permRows = [...groups.entries()].map(([domain, items]) => `
      <div class="eyebrow" style="margin-top:12px;text-transform:capitalize">${esc(domain)}</div>
      ${items.map(p => {
        const override = overrideBySlug.get(p.slug) ?? '';
        const isOn = effectiveSet.has(p.slug);
        return `<div class="claimrow" style="align-items:center">
          <div style="flex:1">
            <div class="mono" style="font-size:12.5px">${esc(p.slug)}</div>
            <div class="muted" style="font-size:11.5px">${esc(p.description)}</div>
          </div>
          ${isOn ? '<span class="pill p-APPROVED"><span class="d"></span>granted</span>'
            : '<span class="pill p-DRAFT"><span class="d"></span>not granted</span>'}
          <select data-upermset="${u.id}|${esc(p.slug)}" style="width:auto;min-width:170px">
            <option value="" ${override === '' ? 'selected' : ''}>Default (from role)</option>
            <option value="GRANT" ${override === 'GRANT' ? 'selected' : ''}>Override: granted</option>
            <option value="REVOKE" ${override === 'REVOKE' ? 'selected' : ''}>Override: revoked</option>
          </select>
        </div>`;
      }).join('')}`).join('');
    return `<a class="backlink" href="#/users">&larr; Users & roles</a>
      <h1 class="mono">${esc(u.full_name)}</h1>
      <div class="sub flex">${esc(u.email)} ${u.is_active ? pill('ACTIVE') : pill('RETIRED')}
        ${u.totp_enabled ? '<span class="muted">2FA on</span>' : '<span class="muted">2FA off</span>'}
        ${u.last_login_at ? `<span class="muted">last login ${dt(u.last_login_at)}</span>` : ''}</div>
      <div class="grid2">
        <div>
          <div class="card"><div class="eyebrow">Profile</div>
            <label>Full name</label><input id="u-edit-name" value="${esc(u.full_name)}">
            <label>Email</label><input id="u-edit-email" value="${esc(u.email)}">
            <div class="flex" style="margin-top:10px">
              <button class="primary" data-usave="${u.id}">Save changes</button>
              ${u.is_active ? `<button class="danger" data-deactivate="${u.id}">Deactivate</button>`
                : `<button data-ureactivate="${u.id}">Reactivate</button>`}
            </div>
          </div>
          <div class="card"><div class="eyebrow">Password</div>
            <div class="muted" style="font-size:12px;margin-bottom:8px">Generate a new password to hand to this person, or type one directly. Either way the new password shows once, right here, and is never stored in plain text or shown again.</div>
            <div class="flex" style="margin-bottom:8px">
              <button data-pwgenerate="${u.id}">Generate new password</button>
            </div>
            <div class="flex">
              <input type="text" id="u-pw-manual" placeholder="type a password (12+ characters)" autocomplete="off" style="max-width:260px">
              <button data-pwset="${u.id}">Set password</button>
            </div>
            <div id="u-pw-result"></div>
          </div>
          <div class="card"><div class="eyebrow">Roles</div>
            <div class="flex" style="flex-wrap:wrap;gap:8px">
              ${rolesRes.items.map(r => heldRoles.has(r.slug)
                ? `<span class="pill p-APPROVED"><span class="d"></span>${esc(r.slug)}
                     <button class="danger" style="margin-left:6px;padding:2px 8px;font-size:11px" data-urolerem="${u.id}|${esc(r.slug)}">remove</button></span>`
                : `<button style="font-size:12px" data-uroleadd="${u.id}|${esc(r.slug)}">+ ${esc(r.slug)}</button>`).join('')}
            </div>
            <div class="muted" style="font-size:12px;margin-top:8px">A user must hold at least one role. Removing someone's only role is blocked until another is added.</div>
          </div>
        </div>
        <div class="card"><div class="eyebrow">Individual permissions</div>
          <div class="muted" style="font-size:12px;margin-bottom:4px">These are exceptions on top of the roles above. Leave on Default unless this person specifically needs more or less than their role normally grants.</div>
          ${permRows}
        </div>
      </div>`;
  },

  async settings() {
    const r = await api('GET', '/platform/settings');
    let credsHtml = '';
    try {
      const c = await api('GET', '/platform/credentials');
      const groups = [...new Set(c.items.map(i => i.group))];
      const badge = (st) => st === 'saved'
        ? '<span class="pill p-APPROVED"><span class="d"></span>saved</span>'
        : st === 'env'
          ? '<span class="pill p-DRAFT"><span class="d"></span>from server env</span>'
          : '<span class="pill p-CLOSED"><span class="d"></span>not set</span>';
      // Groups collapse behind <details>, per the Phase 1 finding that this
      // page's length was the actual problem: ~20 always-open credential
      // rows before you reach anything you came here to change. The status
      // badges move into the summary line so the collapsed state still
      // answers "is this set" without opening it. A group with anything
      // unset opens by default (that's the actionable state); a fully-saved
      // group starts closed.
      credsHtml = `<h1 style="margin-top:26px">API keys and providers</h1>
        <div class="sub">Enter and save credentials here, exactly like the EMR integration credentials page. Values are never shown again once saved; leave a field blank to keep what is stored. Saving an empty value clears the saved entry and falls back to the server environment.</div>
        ${groups.map(g => {
          const items = c.items.filter(i => i.group === g);
          const unsetCount = items.filter(i => i.status === 'unset').length;
          return `<details class="card credgrp" ${unsetCount ? 'open' : ''}>
          <summary><span class="eyebrow" style="display:inline;margin:0">${esc(g)}</span>
            <span class="muted" style="font-size:12px">${items.length} key${items.length === 1 ? '' : 's'}${unsetCount ? `, ${unsetCount} not set` : ', all set'}</span></summary>
          <table>
          ${items.map(i => `<tr>
            <td style="width:220px"><b>${esc(i.label)}</b><div class="muted" style="font-size:11px">${esc(i.hint ?? '')}</div></td>
            <td style="width:130px">${badge(i.status)}</td>
            <td><input type="${i.secret ? 'password' : 'text'}" id="cred-${esc(i.key)}"
              placeholder="${i.status === 'unset' ? 'enter value' : 'enter new value to replace'}" autocomplete="off"></td>
            <td style="width:90px"><button class="primary" data-credsave="${esc(i.key)}">Save</button></td>
          </tr>`).join('')}</table></details>`;
        }).join('')}`;
    } catch { /* not settings.manage; hide the credentials section */ }
    const pm = String(r.items.find(s => s.key === 'publishing.mode')?.value ?? 'DRAFT_BATCH');
    const pmHtml = can('settings.manage') ? `<div class="card"><div class="eyebrow">Publishing mode</div>
      <div class="sub" style="margin-bottom:10px">How content moves once it is generated and claim-checked against an approved knowledge card.</div>
      <div class="flex">
        <select id="pubmode" style="max-width:320px">
          <option value="DRAFT_BATCH" ${pm === 'DRAFT_BATCH' ? 'selected' : ''}>Draft + one-click batch approve (current start mode)</option>
          <option value="AUTO_EXCEPT_SENSITIVE" ${pm === 'AUTO_EXCEPT_SENSITIVE' ? 'selected' : ''}>Automatic, except sensitive topics (Tier 4)</option>
          <option value="FULL_AUTO" ${pm === 'FULL_AUTO' ? 'selected' : ''}>Fully automatic</option>
        </select>
        <button class="primary" id="pm-save">Save</button>
      </div></div>` : '';
    // Admin test-mode override (Nate, Aug 2026): lets an admin generate from
    // a not-yet-approved card for testing. Admin-role gated client-side to
    // match the backend's adminOnlySetting guard; made deliberately alarming
    // when on so nobody forgets it is a live safety-relevant switch.
    const override = String(r.items.find(s => s.key === 'approval.override')?.value ?? 'OFF');
    const overrideOn = override === 'ADMIN_TEST_MODE';
    const overrideHtml = isAdmin() ? `<div class="card" style="border:1px solid ${overrideOn ? 'var(--risk-high)' : 'var(--line)'};${overrideOn ? 'background:var(--risk-high-bg)' : ''}">
      <div class="eyebrow" style="color:${overrideOn ? 'var(--risk-high)' : 'var(--plump-purple)'}">Admin test mode override</div>
      <div class="sub" style="margin-bottom:10px">Lets an admin generate content from a knowledge card that a doctor has not approved yet, for testing. Every use is audit-logged, every piece it makes is marked TEST CONTENT, and none of it can publish while its card stays unapproved.</div>
      ${overrideOn ? `<div class="flex" style="margin-bottom:10px"><span class="pill" style="color:#fff;background:var(--risk-high)"><span class="d"></span>ADMIN TEST MODE IS ON &mdash; unapproved cards can generate content</span></div>` : ''}
      <div class="flex">
        <select id="override-select" style="max-width:360px">
          <option value="OFF" ${!overrideOn ? 'selected' : ''}>Off (default: only approved cards can generate)</option>
          <option value="ADMIN_TEST_MODE" ${overrideOn ? 'selected' : ''}>Admin test mode (unapproved cards allowed, admin only)</option>
        </select>
        <button class="${overrideOn ? '' : 'danger'}" id="override-save">Save</button>
      </div></div>` : '';
    // Clinical review kill switch (Nate, 14 Aug 2026: "we dont want to have
    // clinical review anymore... allow this to just run... add an admin
    // toggle... have it off for now"). Modeled directly on the admin test
    // mode override above: admin-role gated client-side to match the
    // backend's adminOnlySetting guard, and made deliberately alarming when
    // OFF (the unsafe-by-omission state here, opposite of override) so
    // nobody mistakes a quiet toggle for a minor preference.
    const clinicalOn = Boolean(r.items.find(s => s.key === 'review.clinical_review_enabled')?.value ?? false);
    const clinicalHtml = isAdmin() ? `<div class="card" style="border:1px solid ${clinicalOn ? 'var(--line)' : 'var(--risk-high)'};${clinicalOn ? '' : 'background:var(--risk-high-bg)'}">
      <div class="eyebrow" style="color:${clinicalOn ? 'var(--plump-purple)' : 'var(--risk-high)'}">Clinical review gate</div>
      <div class="sub" style="margin-bottom:10px">Whether a TIER 3/TIER 4 script that passes claim validation stops for a doctor's clinical sign-off during the pipeline, or runs straight through so the pipeline can be tested. Either way, NOTHING publishes without a signed medical review gate: publish requires it for every format, with no exception, regardless of this toggle.</div>
      ${clinicalOn ? '' : `<div class="flex" style="margin-bottom:10px"><span class="pill" style="color:#fff;background:var(--risk-high)"><span class="d"></span>CLINICAL REVIEW IS OFF (testing) &mdash; Tier 3/4 scripts do not stop for a doctor during the pipeline. Publish still requires a signed medical review gate. Turn this back ON before real publishing.</span></div>`}
      <div class="flex">
        <select id="clinical-select" style="max-width:360px">
          <option value="false" ${clinicalOn ? '' : 'selected'}>Off (testing: scripts do not stop for a doctor; publish still needs the signed medical gate)</option>
          <option value="true" ${clinicalOn ? 'selected' : ''}>On (Tier 3/4 scripts stop for a doctor's sign-off before advancing)</option>
        </select>
        <button class="${clinicalOn ? 'primary' : 'danger'}" id="clinical-save">Save</button>
      </div></div>` : '';
    // Writing style / tone preset (content.tone_preset default; per-request
    // overrides are also available on Turn into content and card generation).
    let toneHtml = '';
    try {
      const tp = await api('GET', '/content/tone-presets');
      const current = tp.items.find(t => t.key === tp.default);
      toneHtml = `<div class="card"><div class="eyebrow">Writing style and tone</div>
        <div class="sub" style="margin-bottom:10px">The default voice for AI-generated copy across every output type.</div>
        <div class="flex">
          <select id="tonepreset" style="max-width:320px">
            ${tp.items.map(t => `<option value="${esc(t.key)}" ${t.key === tp.default ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}
          </select>
          ${can('settings.manage') ? '<button class="primary" id="tone-save">Save</button>' : ''}
        </div>
        ${current?.description ? `<div class="muted" style="font-size:12px;margin-top:8px">${esc(current.description)}</div>` : ''}
      </div>`;
    } catch { /* concept.read missing; hide */ }
    // Read-only platform specs reference (GET /platform/specs): so producers
    // can check target sizing without digging through code. Renders are
    // flagged against these at schedule time, never blocked. Deliberately
    // NOT an editable table here -- these values are what OTHER things get
    // validated against, so an in-place edit with no review step could
    // silently change what "passes" scheduling. Same reference-only status
    // as the raw settings dump below, so it lives in that same spot on the
    // page (13 Aug 2026: was sitting above the editable rows, which
    // contradicted the page's own stated rule of acted-on stuff first,
    // reference stuff last -- moved down here to actually follow it).
    let specsHtml = '';
    try {
      const sp = await api('GET', '/platform/specs');
      specsHtml = `<div class="card"><div class="eyebrow">Platform export specs</div>
        <div class="sub" style="margin-bottom:10px">Target sizing per platform. A render that misses these is flagged when scheduled, never blocked.</div>
        <table><tr><th>Platform</th><th>Aspect</th><th>Dimensions</th><th>Recommended</th><th>Max</th><th>Notes</th></tr>
        ${sp.items.map(p => `<tr><td>${chan(p.platform)}</td><td class="mono">${esc(p.aspect_ratio)}</td>
          <td class="mono">${esc(String(p.width))}&times;${esc(String(p.height))}</td>
          <td class="muted">${p.recommended_duration_seconds != null ? esc(String(p.recommended_duration_seconds)) + 's' : '—'}</td>
          <td class="muted">${p.max_duration_seconds != null ? esc(String(p.max_duration_seconds)) + 's' : '—'}</td>
          <td class="muted" style="font-size:11.5px">${esc(p.format_notes ?? '')}</td></tr>`).join('')
        || '<tr><td colspan=6 class="empty">No specs seeded yet.</td></tr>'}</table></div>`;
    } catch { /* publish.read missing; hide */ }
    // AI spend cap and backlog notify threshold (15-16 Aug 2026). The cap
    // setting (ai.daily_spend_cap_usd) already existed and was already
    // labeled "hard stop," but nothing actually enforced it against real
    // AI calls -- found live 16 Aug 2026. It is wired up for real now, in
    // ai/gateway.mjs. The old always-on background classify sweep is also
    // gone: nothing calls the AI on its own timer anymore, so this cap is
    // the backstop for a manual batch pull, and the threshold controls
    // when the dashboard banner speaks up.
    const budgetHtml = can('settings.manage') ? (() => {
      const capRaw = r.items.find(s => s.key === 'ai.daily_spend_cap_usd')?.value;
      const capVal = (capRaw === null || capRaw === undefined) ? '' : capRaw;
      const threshold = Number(r.items.find(s => s.key === 'demand.backlog_notify_threshold')?.value ?? 50);
      return `<div class="card"><div class="eyebrow">AI spend and backlog alerts</div>
        <div class="sub" style="margin-bottom:10px">This cap now actually stops AI calls once today's real spend reaches it; before 16 Aug it was shown on the production plan screen but never enforced. There is no automatic AI calling anymore either, classification only runs when someone clicks "Classify pending questions," so this cap is really the backstop for that click. The threshold below controls when the dashboard tells you it is time to click it.</div>
        <div class="flex" style="flex-wrap:wrap;gap:18px">
          <div>
            <label class="muted" style="font-size:12px;display:block;margin-bottom:4px">Daily AI spend cap (USD, blank = no cap)</label>
            <div class="flex"><input type="number" min="0" step="0.01" id="budget-cap" style="max-width:140px" value="${esc(String(capVal))}" placeholder="no cap">
              <button class="primary" id="budget-save">Save</button></div>
          </div>
          <div>
            <label class="muted" style="font-size:12px;display:block;margin-bottom:4px">Notify when pending questions reach</label>
            <div class="flex"><input type="number" min="1" step="1" id="backlog-threshold" style="max-width:100px" value="${threshold}">
              <button class="primary" id="threshold-save">Save</button></div>
          </div>
        </div>
      </div>`;
    })() : '';
    // Raw settings dump is reference-only, nothing on this table is clicked
    // or edited day to day, so it sits last, after every screen someone
    // actually acts on (override, publishing mode, tone, API keys).
    // Object/array values render as multi-line, scroll-capped pre blocks
    // instead of one unreadable escaped-JSON line, per the Phase 1 finding
    // on this table; scalars stay inline, unchanged.
    const rawVal = (v) => (v !== null && typeof v === 'object')
      ? `<pre class="mono" style="max-height:90px;overflow:auto;white-space:pre-wrap;margin:0">${esc(JSON.stringify(v, null, 2))}</pre>`
      : esc(JSON.stringify(v));
    const rawTableHtml = `<h1 style="margin-top:26px">All settings (raw)</h1>
      <div class="sub">Every key/value this instance holds, for reference. Thresholds and weights the team can argue with, without a deploy.</div>
      <div class="card"><table><tr><th>Key</th><th style="width:320px">Value</th><th>Description</th></tr>
      ${r.items.map(s => `<tr><td class="mono">${esc(s.key)}</td>
        <td class="mono" style="max-width:320px;overflow-wrap:anywhere">${rawVal(s.value)}</td>
        <td class="muted">${esc(s.description ?? '')}</td></tr>`).join('')}</table></div>`;
    return `<h1>Settings</h1><div class="sub">What the team can actually change, without a deploy</div>
      ${overrideHtml}
      ${clinicalHtml}
      ${pmHtml}
      ${budgetHtml}
      ${toneHtml}
      ${credsHtml}
      ${specsHtml}
      ${rawTableHtml}`;
  },

  // Capped at 60 rows by default, not paginated server side (the API
  // returns everything in one call). Nothing is hidden permanently: the
  // full count is always stated and "Show all" is one click, one hash
  // query param, no data loss, per the Phase 1 finding that a 239-row
  // unbroken table was the real problem on this screen.
  async audit() {
    const qp = new URLSearchParams((location.hash.split('?')[1] ?? ''));
    const showAll = qp.get('all') === '1';
    const r = await api('GET', '/platform/audit');
    const CAP = 60;
    const rows = showAll ? r.items : r.items.slice(0, CAP);
    const toggle = r.items.length > CAP
      ? (showAll ? ` Showing all ${r.items.length}. <a href="#/audit">Show the most recent ${CAP}</a>.`
                 : ` Showing the most recent ${CAP} of ${r.items.length}. <a href="#/audit?all=1">Show all</a>.`)
      : '';
    return `<h1>Audit log</h1><div class="sub">Append-only. Every state change, forever.${toggle}</div>
      <div class="card"><table><tr><th>When</th><th>Actor</th><th>Action</th><th>Object</th><th>Transition</th><th>Reason</th></tr>
      ${rows.map(a => `<tr><td class="muted">${dt(a.occurred_at)}</td>
        <td class="muted">${esc(a.actor_label ?? a.actor_type)}</td>
        <td class="mono">${esc(a.action)}</td>
        <td class="mono">${esc(a.object_code ?? (a.object_type ?? ''))}</td>
        <td class="muted">${a.from_state ? esc(a.from_state) + ' → ' + esc(a.to_state) : ''}</td>
        <td class="muted" style="max-width:220px">${esc(a.reason ?? '')}</td></tr>`).join('')}</table></div>`;
  },

  // ---------- Part 2: the board, Girum's morning screen ----------
  // Everything in flight, by stage, showing what is waiting on whom.
  // Blocked items surface first inside each stage. Every card names its
  // next action; nothing here is a dead end.
  // #/board is now an alias of the merged Today/Board screen; kept as its
  // own route so the Make screen's post-generation link and anyone's
  // existing bookmark still resolve exactly as before.
  async board() {
    return screens.dashboard();
  },

  // ---------- Part 2 step 1: what should I make ----------
  // Demand, the knowledge that answers it, the formats, the audience and
  // the production path, and what is about to happen BEFORE it happens.
  async make() {
    const [trend, cards, formats] = await Promise.all([
      api('GET', '/demand/trend?bucket=week&periods=12').catch(() => ({ items: [] })),
      api('GET', '/knowledge/cards').catch(() => ({ items: [] })),
      api('GET', '/content/formats').catch(() => ({ items: [] })),
    ]);
    let transcripts = { items: [] };
    try { transcripts = await api('GET', '/content/transcripts'); } catch {}
    const confirmed = transcripts.items.filter(t => t.status === 'CONFIRMED');
    const demandByTopic = new Map((trend.items ?? []).map(t => [t.topic_code, t]));
    if (!MAKE.cardId && cards.items?.length) MAKE.cardId = cards.items.find(c => c.status === 'APPROVED')?.id ?? cards.items[0].id;
    const selCard = cards.items.find(c => c.id === MAKE.cardId);
    const selDemand = selCard ? demandByTopic.get(selCard.topic_code) : null;
    const SURFACE_LABEL = { SOCIAL_VIDEO: 'Short-form video', SOCIAL_STATIC: 'Static and cards',
      TEXT_LONGFORM: 'Text and long form', ABEBA_APP: 'Abeba app', PROGRAMME: 'Programme and institutional' };
    const surfaces = [...new Set(formats.items.map(f => f.surface))];
    const fmtBoxes = surfaces.map(sf => `<div class="card">
      <div class="eyebrow">${esc(SURFACE_LABEL[sf] ?? sf)}</div>
      <div class="flex" style="flex-wrap:wrap;row-gap:8px">
        ${formats.items.filter(f => f.surface === sf && !f.is_internal).map(f => `
          <label class="otpick" title="${esc(f.description ?? '')}">
            <input type="checkbox" data-mkfmt="${esc(f.code)}" ${MAKE.formats.has(f.code) ? 'checked' : ''}>
            ${esc(f.label)} ${(f.platforms ?? []).map(chan).join('')}</label>`).join('')}
      </div></div>`).join('');
    const picked = formats.items.filter(f => MAKE.formats.has(f.code));
    const needsTranscript = picked.some(f => f.code === 'aua_recap');
    const estMin = Math.max(1, Math.round(picked.length * 0.75));
    const preview = !picked.length
      ? 'Pick at least one format above, and this panel will say exactly what is about to happen.'
      : `<b>${picked.length} piece${picked.length === 1 ? '' : 's'}</b> will be written for
         <b>${esc(selCard?.code ?? '?')}</b> (${esc(selCard?.canonical_question_en ?? '')}), one per format:
         ${picked.map(f => esc(f.label)).join(', ')}.
         Audience ${esc(MAKE.audience.toLowerCase())}, ${esc(MAKE.path.toLowerCase())} production.
         Expect roughly ${estMin} minute${estMin === 1 ? '' : 's'}; each piece appears below as it finishes.
         <br><br><b>Cost:</b> writing is the cheap part, a few cents of AI per piece.
         Nothing is produced or rendered in this step, so no production money is spent.
         Production costs are shown on each piece's production plan, before anything runs.
         ${picked.some(f => f.body_kind === 'VIDEO') ? '<br>A piece that comes back needing a missing fact is the writer refusing to invent; that is a success and it says which fact.' : ''}`;
    return `<h1>Make content</h1>
      <div class="sub">One topic becomes every format you tick, each written correctly for what it is.</div>
      <div class="card"><div class="eyebrow">1 · The topic</div>
        <select id="mk-card" style="max-width:640px">
          ${cards.items.map(c => `<option value="${esc(c.id)}" ${c.id === MAKE.cardId ? 'selected' : ''}>
            ${esc(c.code)} · ${esc(c.canonical_question_en.slice(0, 80))} · ${esc(c.status)}</option>`).join('')}
        </select>
        <div class="muted" style="font-size:12px;margin-top:6px">
          ${selDemand ? `${selDemand.total} question${selDemand.total === 1 ? '' : 's'} on this topic in the last 12 weeks, ${esc(selDemand.direction === 'UP' ? 'rising' : selDemand.direction === 'DOWN' ? 'falling' : 'steady')}.` : 'No demand data for this topic yet.'}
          ${selCard && selCard.status !== 'APPROVED' ? ' This card is NOT approved: generation needs the admin test-mode override, and nothing made from it can publish.' : ''}
        </div></div>
      <div class="eyebrow" style="margin:14px 0 6px">2 · The formats</div>
      ${fmtBoxes}
      <div class="grid2">
        <div class="card"><div class="eyebrow">3 · Who it speaks to</div>
          ${['WOMEN', 'MEN', 'COUPLES', 'GENERAL'].map(a => `<label class="otpick">
            <input type="radio" name="mk-aud" value="${a}" ${MAKE.audience === a ? 'checked' : ''}> ${a === 'WOMEN' ? 'Women (default)' : a[0] + a.slice(1).toLowerCase()}</label>`).join(' ')}
          <div class="muted" style="font-size:12px;margin-top:6px">A men's piece is a different question with different fears, never a women's piece with pronouns swapped.</div></div>
        <div class="card"><div class="eyebrow">4 · How it gets produced</div>
          ${['DIGITAL', 'LIVE'].map(pp => `<label class="otpick">
            <input type="radio" name="mk-path" value="${pp}" ${MAKE.path === pp ? 'checked' : ''}> ${pp === 'DIGITAL' ? 'Digital (default): the adapter pipeline' : 'Live: a real shoot, or the AUA live'}</label>`).join(' ')}
          <div class="muted" style="font-size:12px;margin-top:6px">Changeable per piece until production starts. Formats that only support one path keep it.</div></div>
      </div>
      ${needsTranscript ? `<div class="card" style="border-left:4px solid var(--risk-mod)">
        <div class="eyebrow">AUA recap needs its confirmed transcript</div>
        ${confirmed.length ? `<select id="mk-transcript" style="max-width:520px">
            ${confirmed.map(t => `<option value="${esc(t.id)}" ${t.id === MAKE.transcriptId ? 'selected' : ''}>${esc(t.code)} · ${esc(t.title)}</option>`).join('')}
          </select>` : `<div style="font-size:13px">No confirmed transcript yet. <a href="#/transcripts">Create and confirm one first</a>; the recap generates from what the doctor actually said, never from imagination.</div>`}
      </div>` : ''}
      <div class="card"><div class="eyebrow">What is about to happen</div>
        <div id="mk-preview" style="font-size:13px;line-height:1.7">${preview}</div>
        <div style="margin-top:12px" class="flex">
          <button class="primary" id="mk-go" ${!picked.length || (needsTranscript && !confirmed.length) ? 'disabled' : ''}>Write ${picked.length || ''} piece${picked.length === 1 ? '' : 's'}</button>
          <span class="muted" style="font-size:12px">${!picked.length ? 'Pick at least one format above to continue.'
            : (needsTranscript && !confirmed.length) ? 'The AUA recap format needs a confirmed transcript first.'
            : 'Each piece is claim-checked as it lands. Nothing publishes from here.'}</span>
        </div>
        <div id="mk-run"></div>
      </div>`;
  },

  // ---------- Part 2 step 6b: transcripts for AUA recaps ----------
  async transcripts() {
    const r = await api('GET', '/content/transcripts');
    return `<h1>Live transcripts</h1>
      <div class="sub">An AUA recap generates from the transcript of the live. Amharic machine transcription is unreliable in every engine, and a doctor's medical statements ride on it, so a human confirms every transcript on its own screen before anything generates from it.</div>
      ${can('script.write') ? `<div class="grid2">
        <div class="card"><div class="eyebrow">Paste a transcript (from VEED or anywhere)</div>
          <label>Title</label><input id="tr-title" placeholder="AUA live, 14 Aug">
          <label>Transcript. Timecodes like [00:12] or 02:10 at line starts are picked up; untimed lines are kept.</label>
          <textarea id="tr-text" class="amharic" style="min-height:120px"></textarea>
          <div style="margin-top:8px"><button class="primary" id="tr-paste">Save as draft</button></div></div>
        <div class="card"><div class="eyebrow">Or upload the recording for Gemini to transcribe</div>
          <label>Title</label><input id="tr-title-2" placeholder="AUA live, 14 Aug">
          <label>Audio preferred. A video upload works, but its audio is stripped server side first; the audio file is a hundred times smaller.</label>
          <input type="file" id="tr-file" accept="audio/*,video/*">
          <div style="margin-top:8px"><button class="primary" id="tr-upload">Upload and transcribe</button></div>
          <div class="muted" style="font-size:12px;margin-top:6px">The result is machine transcription of Amharic and needs checking. It is not ground truth.</div></div>
      </div>` : ''}
      <div class="card"><table>
        <tr><th>Code</th><th>Title</th><th>How it arrived</th><th>Lines</th><th>Status</th><th>Confirmed</th></tr>
        ${r.items.map(t => `<tr class="rowlink" data-nav="transcript/${esc(t.id)}" tabindex="0">
          <td class="mono">${esc(t.code)}</td><td>${esc(t.title)}</td>
          <td class="muted" style="font-size:12px">${esc(t.source.toLowerCase().replace(/_/g, ' '))}${t.transcription_engine ? ` (${esc(t.transcription_engine)})` : ''}</td>
          <td>${t.segment_count}</td>
          <td>${pill(t.status === 'CONFIRMED' ? 'APPROVED' : 'DRAFT')}</td>
          <td class="muted">${t.confirmed_at ? dt(t.confirmed_at) : '—'}</td></tr>`).join('')
        || empty(6, 'No transcripts yet. Paste or upload the first one above.')}</table></div>`;
  },

  async transcript(id) {
    const t = await api('GET', `/content/transcripts/${id}`);
    const canEdit = can('script.write');
    const fmtT = (x) => x == null ? '' : String(x);
    return `<a class="backlink" href="#/transcripts">&larr; All transcripts</a>
      <div class="eyebrow">Live transcript</div>
      <h1>${esc(t.title)} <span class="mono" style="font-size:13px;font-weight:400">${esc(t.code)}</span></h1>
      <div class="sub flex">${pill(t.status === 'CONFIRMED' ? 'APPROVED' : 'DRAFT')}
        <span class="muted">${esc(t.source.toLowerCase().replace(/_/g, ' '))}${t.transcription_engine ? ` · transcribed by ${esc(t.transcription_engine)}` : ''}</span></div>
      ${t.transcription_engine ? `<div class="card" style="border-left:4px solid var(--risk-mod)">
        <b>This is machine transcription of Amharic and needs checking.</b>
        <div style="font-size:13px;margin-top:4px">Read every line against the recording before confirming. A wrong word here becomes a wrong medical statement in a recap.</div></div>` : ''}
      ${t.status === 'CONFIRMED' ? `<div class="card" style="border-left:4px solid var(--risk-routine)">
        Confirmed${t.confirmed_by_name ? ` by ${esc(t.confirmed_by_name)}` : ''} ${dt(t.confirmed_at)}. Editing any line returns it to draft and it must be confirmed again.</div>` : ''}
      <div class="card"><div class="eyebrow">The transcript, editable in place</div>
        <table style="min-width:0"><tr><th style="width:80px">Start s</th><th style="width:80px">End s</th><th>What was said</th></tr>
          ${(t.segments ?? []).map((seg, i) => `<tr>
            <td><input id="ts-${i}-start" value="${esc(fmtT(seg.start_s))}" ${canEdit ? '' : 'disabled'}></td>
            <td><input id="ts-${i}-end" value="${esc(fmtT(seg.end_s))}" ${canEdit ? '' : 'disabled'}></td>
            <td><textarea id="ts-${i}-text" class="amharic" style="min-height:44px" ${canEdit ? '' : 'disabled'}>${esc(seg.text)}</textarea></td>
          </tr>`).join('')}
        </table>
        ${canEdit ? `<div class="flex" style="margin-top:10px">
          <button data-trsave="${esc(t.id)}" data-count="${(t.segments ?? []).length}">Save edits</button>
          <button data-traddrow="${esc(t.id)}">Add a line</button>
          ${t.status !== 'CONFIRMED' ? `<button class="approve" data-trconfirm="${esc(t.id)}">Confirm: this is what was said</button>` : ''}
        </div>` : ''}
      </div>`;
  },

  // ---------- Part 2 steps 4 and 5: the Amharic, side by side ----------
  async amharic(id) {
    const s = await api('GET', `/content/scripts/${id}`);
    const t = s.translation;
    const v = s.version;
    if (!t) {
      return `<a class="backlink" href="#/script/${esc(id)}">&larr; Back to the piece</a>
        <h1>No Amharic yet</h1>
        <div class="card">Amharic is written from the approved English.
        ${can('script.write') ? `<div style="margin-top:8px"><button data-scriptlocalize="${esc(id)}">Write it now</button></div>` : ''}</div>`;
    }
    const [driftWord, driftText] = driftWords(t.drift_score);
    const english = versionEnglishText(v);
    return `<a class="backlink" href="#/script/${esc(id)}">&larr; Back to the piece</a>
      <div class="eyebrow">Language review</div>
      <h1 class="mono">${esc(s.code)} <span style="font-weight:400;font-size:14px">· Amharic against the English</span></h1>
      <div class="sub flex">${pill(t.status)} <span class="muted">drift ${Number(t.drift_score).toFixed(3)}</span></div>
      <div class="card" style="border-left:4px solid ${driftWord === 'high drift' ? 'var(--risk-high)' : driftWord === 'acceptable' ? 'var(--risk-mod)' : 'var(--risk-routine)'}">
        <b>Drift: ${esc(driftWord)}.</b> <span style="font-size:13px">${esc(driftText)}</span>
        <div class="muted" style="font-size:12px;margin-top:4px">The back-translation was written blind, by an agent that never saw the English. Words marked below appear in it but not in the English source: that is exactly where a meaning shift hides.</div>
      </div>
      <div class="grid3">
        <div class="card"><div class="eyebrow">English source</div>
          <div style="line-height:1.8;font-size:13.5px">${esc(english)}</div></div>
        <div class="card"><div class="eyebrow">Amharic${can('script.approve_language') ? ' · edit directly if needed' : ''}</div>
          <textarea id="am-text" class="amharic" style="min-height:220px" ${can('script.approve_language') || can('script.write') ? '' : 'disabled'}>${esc(t.translated_text)}</textarea></div>
        <div class="card"><div class="eyebrow">Blind back-translation, divergence marked</div>
          <div style="line-height:1.8;font-size:13.5px">${diffMark(english, t.back_translation)}</div></div>
      </div>
      <div class="flex">
        ${can('script.approve_language') ? `
          <button class="approve" data-amapprove="${esc(s.id)}">Approve the Amharic</button>
          <button data-amapprove-edits="${esc(s.id)}">Approve with my edits above</button>
          <button data-amchanges="${esc(s.id)}">Request changes</button>` : ''}
        ${can('script.write') ? `<button data-scriptlocalize="${esc(s.id)}">Rewrite from the English</button>` : ''}
      </div>
      ${!can('script.approve_language') ? '<div class="muted" style="font-size:12px;margin-top:8px">Approval here is the language editor\'s gate. You can read and comment; the sign-off is theirs.</div>' : ''}`;
  },

  // ---------- Part 2 step 6: the production plan and the cost, before spending ----------
  async produce(scriptId) {
    const [plan, script] = await Promise.all([
      api('GET', `/production/plan/${scriptId}`),
      api('GET', `/content/scripts/${scriptId}`),
    ]);
    const sp = plan.spend_today;
    const approved = script.status === 'APPROVED';
    const langOk = !script.translation || script.translation.status === 'APPROVED';
    const AMHARIC_SAMPLE = 'በሚስጥር በቀጥታ ጻፊልን። ማንም አያይም። ነፃ።';
    const subSample = (code) => ({
      WORD_HIGHLIGHT: `<span class="ss wordhl">${AMHARIC_SAMPLE.split(' ').map((w, i) => `<span class="${i === 2 ? 'hl' : ''}">${esc(w)}</span>`).join(' ')}</span>`,
      POP_ON: `<span class="ss popon">${esc(AMHARIC_SAMPLE)}</span>`,
      BOXED: `<span class="ss boxed">${esc(AMHARIC_SAMPLE)}</span>`,
      CLEAN: `<span class="ss clean">${esc(AMHARIC_SAMPLE)}</span>`,
    }[code] ?? '');
    const stepRow = (st) => `<tr>
      <td><b>${esc(st.label)}</b><div class="muted" style="font-size:11.5px">${esc(st.detail)}</div></td>
      <td class="muted" style="font-size:12px">${esc(st.engine)}</td>
      <td style="text-align:right;white-space:nowrap">${st.included
        ? '<span class="pill p-APPROVED"><span class="d"></span>included</span>'
        : `<span class="mono">~$${(st.est_cost_usd ?? 0).toFixed(2)}</span>`}</td></tr>`;
    const meter = (m, label) => {
      const pct = Math.min(100, Math.round((m.spent_usd / (m.cap_usd || 1)) * 100));
      return `<div style="flex:1;min-width:160px"><div class="flex" style="justify-content:space-between">
        <span style="font-size:12px">${label}</span><span class="mono" style="font-size:12px">$${m.spent_usd.toFixed(2)} / $${m.cap_usd}</span></div>
        <div class="meter"><div class="meter-fill ${pct >= 100 ? 'full' : pct >= 75 ? 'warn' : ''}" style="width:${pct}%"></div></div></div>`;
    };
    return `<a class="backlink" href="#/script/${esc(scriptId)}">&larr; Back to the piece</a>
      <div class="eyebrow">Production plan</div>
      <h1 class="mono">${esc(plan.script_code)} <span style="font-weight:400;font-size:14px">· ${esc(plan.format?.label ?? plan.body_kind)}</span></h1>
      <div class="sub">The whole plan, and where the money actually goes, before anything runs.</div>
      ${!approved ? `<div class="card" style="border-left:4px solid var(--risk-mod)"><b>This piece is not approved yet.</b>
        <div style="font-size:13px;margin-top:4px">The plan below is a preview. Production can only start after content, medical and language approval; the sequence is on the piece's own screen.</div></div>` : ''}
      ${plan.cap_message ? `<div class="card" style="border-left:4px solid var(--risk-high)"><b>${esc(plan.cap_message)}</b></div>` : ''}
      <div class="card"><div class="eyebrow">The steps, in plain language</div>
        <table><tr><th>Step</th><th>Runs on</th><th style="text-align:right">Cost</th></tr>
          ${plan.steps.map(stepRow).join('')}
          <tr><td><b>Total, before library reuse</b></td><td></td>
            <td style="text-align:right"><b class="mono" id="pp-total">~$${plan.total_est_usd.toFixed(2)}</b></td></tr>
        </table>
        <div class="muted" style="font-size:12px;margin-top:6px">${esc(plan.cost_note)}</div>
      </div>
      ${plan.body_kind === 'VIDEO' ? `
      <div class="grid2">
        <div class="card"><div class="eyebrow">Video engine</div>
          ${plan.video_engine.options.map(o => `<label class="otpick">
            <input type="radio" name="pp-engine" value="${o}" ${o === plan.video_engine.default ? 'checked' : ''}> ${o === 'KLING' ? 'Kling' : 'Veo (same Gemini key)'}</label>`).join(' ')}
          <div class="muted" style="font-size:12px;margin-top:6px">${esc(plan.video_engine.note)}</div></div>
        <div class="card"><div class="eyebrow">Voice</div>
          ${plan.voice.options.map(o => `<label class="otpick" style="display:flex;margin-bottom:4px">
            <input type="radio" name="pp-voice" value="${o.code}" ${o.code === (plan.voice.ai_allowed_at_tier ? 'AI_TTS' : 'HUMAN') ? 'checked' : ''}>
            ${esc(o.label)}${o.metered ? ' <span class="muted">(metered)</span>' : ''}</label>${o.note ? `<div class="muted" style="font-size:11.5px;margin:-2px 0 6px 22px">${esc(o.note)}</div>` : ''}`).join('')}
          ${!plan.voice.ai_allowed_at_tier ? '<div class="claimrow" style="font-size:12px">At this risk tier the AI voice is not permitted; the live recording is the path.</div>' : ''}</div>
      </div>
      <div class="card"><div class="eyebrow">Subtitles, in Amharic because that is where rendering is at risk</div>
        <div class="subgrid">
          ${plan.subtitle.presets.map(pr => `<label class="subopt">
            <input type="radio" name="pp-subs" value="${pr.code}" ${pr.code === plan.subtitle.default ? 'checked' : ''}>
            <div><b style="font-size:12.5px">${esc(pr.label)}</b>${pr.code === plan.subtitle.default ? ' <span class="muted">(this format\'s default)</span>' : ''}
              <div style="margin:6px 0">${subSample(pr.code)}</div>
              <div class="muted" style="font-size:11px">${esc(pr.description)}</div></div>
          </label>`).join('')}
        </div>
        <div class="muted" style="font-size:12px;margin-top:6px">Rendered by FFmpeg on Letena's own server: no cost either way.</div>
      </div>` : ''}
      ${plan.scene_suggestions.length ? `<div class="card"><div class="eyebrow">The library already has some of this</div>
        <div class="muted" style="font-size:12px;margin-bottom:10px">Binding an approved asset is free and instant. Generating costs money and time. Generate only where the library has nothing right.</div>
        ${plan.scene_suggestions.map(sc => `<div class="claimrow">
          <div style="font-size:12.5px"><b>Scene ${sc.scene}:</b> ${esc(sc.visual_brief || '(no brief)')}</div>
          <div class="flex" style="margin-top:6px;align-items:flex-start">
            ${sc.matches.map((m, mi) => `<label class="sceneopt">
              <input type="radio" name="pp-scene-${sc.scene}" value="${esc(m.id)}" ${mi === 0 && m.similarity >= 0.25 ? 'checked' : ''}>
              ${assetThumb(m)}
              <div style="font-size:11px"><b>${esc(m.title.slice(0, 40))}</b><br>
                <span class="muted">${Math.round(m.similarity * 100)}% match${m.clinically_approved ? ' · clinical' : ''}</span></div>
            </label>`).join('')}
            <label class="sceneopt"><input type="radio" name="pp-scene-${sc.scene}" value=""
              ${!(sc.matches[0]?.similarity >= 0.25) ? 'checked' : ''}>
              <div class="ath none">NEW</div>
              <div style="font-size:11px"><b>Generate fresh</b><br><span class="muted">metered</span></div></label>
          </div></div>`).join('')}
      </div>` : ''}
      <div class="card"><div class="eyebrow">Today's spend, against the caps</div>
        <div class="flex" style="gap:20px">${meter(sp.render, 'Renders')}${meter(sp.ai, 'AI')}</div></div>
      <div class="flex">
        ${can('production.request') ? `<button class="primary" data-startprod="${esc(scriptId)}"
          ${!approved || plan.at_render_cap || !langOk ? 'disabled' : ''}>Approve the plan and start</button>` : ''}
        ${!langOk ? '<span class="muted" style="font-size:12px">The Amharic is not language-approved yet; the AI voice would be voicing unreviewed Amharic, so start is held.</span>' : ''}
        ${plan.at_render_cap ? '<span class="muted" style="font-size:12px">Held at the daily cap.</span>' : ''}
      </div>`;
  },
};

// ---------- actions ----------
// Mobile drawer: the burger toggles the sidebar, the veil or any nav link closes it.
document.addEventListener('click', (e) => {
  if (e.target.closest('#burger')) { document.body.classList.toggle('nav-open'); return; }
  if (e.target.closest('#navveil') || e.target.closest('#side a')) {
    document.body.classList.remove('nav-open');
  }
});
// Keyboard: dashboard tiles act as links; Escape closes the mobile drawer.
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('tile')) {
    e.preventDefault(); e.target.click();
  }
  // Drill-down rows (tr[data-nav], tabindex="0"): Enter/Space activates the
  // row itself, same as a tile. Only when focus is on the row, not on a
  // button/link/input inside it -- those already have their own Enter/Space
  // behaviour and must not also trigger the row's navigation.
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('tr[data-nav],.bitem[data-nav],.tile[data-nav]')) {
    e.preventDefault(); location.hash = '#/' + e.target.dataset.nav;
  }
  if (e.key === 'Escape') document.body.classList.remove('nav-open');
});
// Generic client-side filter: any input with data-livefilter="<container id>"
// hides non-matching items inside that container as you type and updates
// the element named by data-count-target with "N of M shown". Items are
// anything marked data-filter-item (a <tr> in a table, a <div class="card">
// in a list), so the same input works for both the Claims table and the
// Concepts card list. No server round trip, built for endpoints the API
// returns whole rather than paginating, per the redesign audit's Tier 1/
// Tier 2 fixes. Family headings in the Concepts list are left alone by the
// filter (they aren't data-filter-item), so a match still shows which
// family it belongs to.
document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-livefilter]');
  if (!el) return;
  const container = document.getElementById(el.dataset.livefilter);
  if (!container) return;
  const needle = el.value.trim().toLowerCase();
  const rows = container.querySelectorAll('[data-filter-item]');
  let shown = 0;
  rows.forEach(row => {
    const match = !needle || row.textContent.toLowerCase().includes(needle);
    row.style.display = match ? '' : 'none';
    if (match) shown++;
  });
  const countEl = document.getElementById(el.dataset.countTarget);
  if (countEl) countEl.textContent = `${shown} of ${rows.length} shown`;
});
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-amtoggle],[data-tic],[data-redact],[data-purge],[data-select],[data-produce],[data-run],[data-cardtx],[data-cardapprove],[data-cardretire],[data-scripttx],[data-scripttx-reason],[data-scriptvalidate],[data-scriptlocalize],[data-scriptdelete],[data-termapprove],[data-langreview],[data-langreview-edit],[data-langreview-reason],#t-save,#a-go,#a-gen,#u-create,[data-deactivate],[data-ureactivate],[data-usave],[data-uroleadd],[data-urolerem],#recompute,#logout,[data-credsave],[data-batchapprove],[data-produceall],[data-copycap],[data-pubnow],#pm-save,[data-cardfullapprove],[data-cardapproveall],[data-cardgenerate],[data-plangenerate],#override-save,#clinical-save,#tone-save,#classify-pending,#bulk-commission,#cleanup-requeue,#budget-save,#threshold-save,[data-pwgenerate],[data-pwset]');
  if (!b) {
    // A real link (external platform URL, download, backlink) inside a
    // drill-down row must keep its native navigation; only fall through to
    // the row's own data-nav when the click was not on an <a>.
    if (e.target.closest('a[href],select,input,textarea,label')) return;
    // Board cards are .bitem divs, not table rows (Part 2, 15 Aug 2026
    // browser check found this: keyboard Enter already handled both
    // tr[data-nav] and .bitem[data-nav] via the keydown listener above,
    // but a mouse click on a board card matched neither selector here,
    // so the board, Girum's morning screen, was unclickable with a mouse.
    const row = e.target.closest('tr[data-nav],.bitem[data-nav],.tile[data-nav]');
    if (row) location.hash = '#/' + row.dataset.nav;
    return;
  }
  e.preventDefault();
  try {
    if (b.dataset.amtoggle) {
      // Swap between the English translation and the original Amharic in place.
      const wrap = b.closest('[data-bi]');
      const en = wrap?.querySelector('.bi-en'), am = wrap?.querySelector('.bi-am');
      if (en && am) {
        const showAm = am.hidden;
        am.hidden = !showAm; en.hidden = showAm;
        b.setAttribute('aria-pressed', String(showAm));
        b.textContent = showAm ? 'EN' : 'አማ';
        b.title = showAm ? 'Show the English translation' : 'Show the original Amharic';
      }
      return;
    }
    if (b.id === 'logout') return logout();
    if (b.dataset.credsave) {
      const input = document.getElementById('cred-' + b.dataset.credsave);
      const value = (input?.value ?? '').trim();
      b.disabled = true;
      const r = await api('PUT', '/platform/credentials', { key: b.dataset.credsave, value });
      toast(value ? 'Saved. Status: ' + r.status : 'Cleared. Status: ' + r.status);
      return render();
    }
    if (b.id === 'recompute') { await api('POST', '/demand/recompute'); toast('Demand board recomputed'); return render(); }
    if (b.id === 'classify-pending') {
      // Matches the server's own clamp (packages/api's classify-pending route
      // limits 1-500 regardless of what's sent), so a stray/tampered value
      // here can't request more than the backend will ever actually run in
      // one request.
      const limit = Math.min(Math.max(Number($('#classify-limit')?.value) || 100, 1), 500);
      b.disabled = true; toast(`Classifying the newest ${limit} pending questions...`);
      try {
        const r = await api('POST', '/questions/classify-pending', { limit });
        toast(`Classified ${r.classified}/${r.attempted}` +
          `${r.quarantined_not_genuine ? `, ${r.quarantined_not_genuine} not real questions (quarantined)` : ''}` +
          `${r.failed ? `, ${r.failed} failed` : ''}. ` +
          (r.remaining_pending ? `${r.remaining_pending} still pending, run it again.` : 'Nothing left pending.'));
      } catch (e) { toast(e.message ?? 'Classification sweep failed', 'warn'); }
      return render();
    }
    if (b.id === 'cleanup-requeue') {
      if (!confirm('Quarantine already-ingested greetings/placeholder junk and send every other classified question back through classification with the current AI provider? This clears their existing topic and cluster and cannot be undone in one click.')) return;
      b.disabled = true; toast('Cleaning up and requeuing...');
      try {
        const r = await api('POST', '/questions/cleanup-and-requeue', {});
        toast(`Quarantined ${r.quarantined} junk question${r.quarantined === 1 ? '' : 's'}, requeued ${r.requeued} for reclassification, retired ${r.clusters_deactivated} empty cluster${r.clusters_deactivated === 1 ? '' : 's'}. ${r.note}`);
      } catch (e) { toast(e.message ?? 'Cleanup failed', 'warn'); }
      return render();
    }
    if (b.id === 'bulk-commission') {
      b.disabled = true; toast('Generating content for the top gap-flagged topics...');
      try {
        const r = await api('POST', '/content/bulk-commission', { limit: 10 });
        toast(`Commissioned ${r.commissioned}/${r.candidates_considered} topics, ${r.total_pieces} pieces. Check Scripts for review.`);
      } catch (e) { toast(e.message ?? 'Bulk commission failed', 'warn'); }
      return render();
    }
    if (b.id === 'pm-save') {
      const value = $('#pubmode').value;
      await api('PUT', '/platform/settings', { key: 'publishing.mode', value });
      toast('Publishing mode saved: ' + value); return render();
    }
    if (b.id === 'override-save') {
      const value = $('#override-select').value;
      await api('PUT', '/platform/settings', { key: 'approval.override', value });
      toast(value === 'ADMIN_TEST_MODE' ? 'Admin test mode is ON. Every generation from an unapproved card now needs this switched back off.' : 'Admin test mode is off.',
        value === 'ADMIN_TEST_MODE' ? 'warn' : false);
      return render();
    }
    if (b.id === 'clinical-save') {
      const value = $('#clinical-select').value === 'true';
      await api('PUT', '/platform/settings', { key: 'review.clinical_review_enabled', value });
      toast(value ? 'Clinical review is back on. Tier 3/4 scripts will require a doctor\'s sign-off again.' : 'Clinical review is OFF for testing. Scripts will not stop for a doctor, and publish still requires a signed medical review gate. Turn it back on before real publishing.',
        value ? false : 'warn');
      return render();
    }
    if (b.id === 'tone-save') {
      const value = $('#tonepreset').value;
      await api('PUT', '/platform/settings', { key: 'content.tone_preset', value });
      toast('Tone preset saved: ' + value); return render();
    }
    if (b.id === 'budget-save') {
      const raw = $('#budget-cap').value.trim();
      const value = raw === '' ? null : Number(raw);
      await api('PUT', '/platform/settings', { key: 'ai.daily_spend_cap_usd', value });
      toast(value === null ? 'No daily AI spend cap. AI calls will never be refused for budget.' : `Daily AI spend cap saved: $${value}. This is now enforced, not just displayed.`, value === null ? 'warn' : false);
      return render();
    }
    if (b.id === 'threshold-save') {
      const value = Number($('#backlog-threshold').value);
      await api('PUT', '/platform/settings', { key: 'demand.backlog_notify_threshold', value });
      toast(`Backlog notify threshold saved: ${value}`); return render();
    }
    if (b.dataset.batchapprove) {
      b.disabled = true; b.textContent = 'Approving…';
      const r = await api('POST', '/reviews/batch-approve', {});
      toast(`Approved ${r.approved} scripts and ${r.renders_approved} renders` +
        (r.skipped.length ? `; ${r.skipped.length} need another role` : ''));
      return render();
    }
    if (b.dataset.produceall) {
      b.disabled = true;
      const qd = await api('GET', '/distribution/queue');
      // VIDEO-kind scripts are excluded here too, same reasoning as the
      // button's own count above: production.mjs refuses them outright now.
      const toProduce = qd.to_produce.filter(s => s.body_kind !== 'VIDEO');
      let done = 0, failed = 0;
      for (const s of toProduce) {
        b.textContent = `Producing ${done + failed + 1}/${toProduce.length}…`;
        try {
          const job = await api('POST', '/production/jobs', { script_id: s.id });
          await api('POST', `/production/jobs/${job.id}/run`);
          done++;
        } catch { failed++; }
      }
      toast(`Produced ${done}` + (failed ? `, ${failed} failed` : ''));
      return render();
    }
    if (b.dataset.cardfullapprove) {
      b.disabled = true; b.textContent = 'Approving…';
      const r = await api('POST', `/knowledge/cards/${b.dataset.cardfullapprove}/approve-with-claims`, {});
      toast(`Approved ${r.claims_approved} facts; card ${r.card}`); return render();
    }
    if (b.dataset.cardapproveall) {
      b.disabled = true;
      const r = await api('GET', '/knowledge/cards');
      const list = r.items.filter(c => c.status === 'IN_REVIEW');
      let ok = 0, blocked = 0;
      for (const c of list) {
        b.textContent = `Approving ${ok + blocked + 1}/${list.length}…`;
        try { await api('POST', `/knowledge/cards/${c.id}/approve-with-claims`, {}); ok++; }
        catch { blocked++; }
      }
      toast(`Approved ${ok} cards with their facts` + (blocked ? `; ${blocked} blocked (open them to see why)` : ''));
      return render();
    }
    if (b.dataset.copycap) {
      await navigator.clipboard.writeText(b.dataset.cap ?? '');
      toast('Caption copied'); return;
    }
    if (b.dataset.pubnow) {
      b.disabled = true; b.textContent = 'Publishing…';
      const platform = $(`#plat-${b.dataset.pubnow}`).value;
      const job = await api('POST', '/distribution/jobs', { render_id: b.dataset.pubnow, platform });
      await api('POST', `/distribution/jobs/${job.id}/publish-now`);
      // Platform-spec warnings (duration/aspect ratio) ride along on the
      // schedule response. Flag, never gate: the publish above already ran.
      if (job.warnings?.length) {
        toast(`Published to ${platform}. Note: ${job.warnings.map(w => w.message).join(' ')}`, 'warn');
      } else {
        toast('Published to ' + platform);
      }
      return render();
    }
    if (b.dataset.plangenerate) {
      const id = b.dataset.plangenerate;
      const picked = Array.from(document.querySelectorAll('.gen-ot-' + CSS.escape(id) + ':checked'))
        .map(x => x.value);
      if (!picked.length) return toast('Tick at least one platform first.', 'warn');
      b.disabled = true; b.textContent = `Generating ${picked.length}…`;
      try {
        const r = await api('POST', '/content/generate', { card_id: id, output_types: picked });
        toast(`Made ${r.scripts?.length ?? 0} script${r.scripts?.length === 1 ? '' : 's'} for `
          + `${picked.length} platform${picked.length === 1 ? '' : 's'}. Open Content to review.`);
      } catch (e) { toast(e.message ?? 'Generation failed', 'warn'); }
      return render();
    }
    if (b.dataset.cardgenerate) {
      const outputTypes = [...document.querySelectorAll('.gen-ot:checked')].map(x => x.value);
      if (!outputTypes.length) { toast('Pick at least one output type first', true); return; }
      b.disabled = true; b.textContent = 'Generating…';
      const r = await api('POST', '/content/generate', { card_id: b.dataset.cardgenerate, output_types: outputTypes });
      toast(`Created ${r.concepts.length} concept${r.concepts.length === 1 ? '' : 's'}, ${r.scripts.length} script${r.scripts.length === 1 ? '' : 's'} (${r.risk_tier})`
        + (r.is_test_content ? '. Test content, will not publish while this card is unapproved.' : ''),
        r.is_test_content ? 'warn' : false);
      location.hash = '#/scripts'; return;
    }
    if (b.dataset.tic) {
      b.disabled = true; b.textContent = 'Working…';
      const r = await api('POST', '/content/turn-into-content', { question_id: b.dataset.tic });
      if (r.knowledge_gap) toast('No approved knowledge yet. The clinical team has been asked.', true);
      else toast(`Created ${r.concepts.length} concepts, ${r.scripts.length} scripts (${r.risk_tier}). Now in review.`);
      location.hash = '#/scripts'; return;
    }
    if (b.dataset.redact) {
      await api('POST', `/questions/${b.dataset.redact}/redact`,
        { sanitized_text: $(`#rq-${b.dataset.redact}`).value });
      toast('Released to classification'); return render();
    }
    if (b.dataset.purge) { await api('POST', `/questions/${b.dataset.purge}/reject`); toast('Purged'); return render(); }
    if (b.dataset.select) { await api('POST', `/content/concepts/${b.dataset.select}/select`); toast('Concept selected'); return render(); }
    if (b.dataset.produce) {
      const job = await api('POST', '/production/jobs', { script_id: b.dataset.produce });
      const run = await api('POST', `/production/jobs/${job.id}/run`);
      toast(`Rendered via ${job.engine}. Preview ready for approval.`);
      location.hash = '#/production'; return;
    }
    if (b.dataset.run) { await api('POST', `/production/jobs/${b.dataset.run}/run`); toast('Render complete'); return render(); }
    if (b.dataset.cardtx) {
      const [id, to] = b.dataset.cardtx.split('|');
      await api('POST', `/knowledge/cards/${id}/transition`, { to }); toast(`Card → ${to}`); return render();
    }
    if (b.dataset.cardapprove) {
      await api('POST', `/knowledge/cards/${b.dataset.cardapprove}/transition`,
        { to: 'APPROVED', review_due_months: 6, reason: 'Clinically approved in UI' });
      toast('Card approved'); return render();
    }
    if (b.dataset.cardretire) {
      const reason = prompt('Retirement reason (required):'); if (!reason) return;
      await api('POST', `/knowledge/cards/${b.dataset.cardretire}/transition`, { to: 'RETIRED', reason });
      toast('Card retired; in-flight content frozen'); return render();
    }
    if (b.dataset.scripttx) {
      const [id, to] = b.dataset.scripttx.split('|');
      await api('POST', `/content/scripts/${id}/transition`, { to }); toast(`Script → ${to}`); return render();
    }
    if (b.dataset.scriptdelete) {
      if (!confirm('Delete this rejected script permanently? This cannot be undone.')) return;
      await api('DELETE', `/content/scripts/${b.dataset.scriptdelete}`);
      toast('Script deleted'); location.hash = '#/scripts'; return render();
    }
    if (b.dataset.scriptlocalize) {
      // Amharic is normally written inside the generation pipeline
      // (processGeneratedScript -> localizeScript, when AM is among the
      // requested languages). A script generated English-only had no way to
      // get one afterwards, even though the endpoint existed. Nate, 14 Aug
      // 2026: "why does the script say no amharic version yet? Do you do
      // that after? If so, when/where?"
      b.disabled = true; b.textContent = 'Writing Amharic…';
      try {
        const r = await api('POST', `/content/scripts/${b.dataset.scriptlocalize}/localize`, {});
        toast(r.result === 'HUMAN_LANGUAGE_REVIEW'
          ? `Sent to the language editor: ${r.reason ?? 'the localizer was not confident enough to pass it through'}`
          : `Amharic written. Drift ${r.drift_score}, QA ${r.qa_verdict}${r.routed_to_human ? ', routed to the language editor' : ''}.`,
          r.result === 'HUMAN_LANGUAGE_REVIEW' ? 'warn' : false);
      } catch (e) { toast(e.message ?? 'Localization failed', 'warn'); }
      return render();
    }
    if (b.dataset.scriptvalidate) {
      b.disabled = true; b.textContent = 'Validating…';
      const r = await api('POST', `/content/scripts/${b.dataset.scriptvalidate}/validate`, {});
      toast(r.overall_result === 'PASS' ? 'Validation passed.' : `Validation failed: ${r.findings?.[0]?.explanation ?? 'see findings below'}`,
        r.overall_result === 'PASS' ? false : 'warn');
      return render();
    }
    if (b.id === 'u-create') {
      await api('POST', '/platform/users', { email: $('#u-email').value, full_name: $('#u-name').value,
        password: $('#u-pw').value, role_slug: $('#u-role').value });
      toast('User created'); return render();
    }
    if (b.dataset.deactivate) {
      if (!confirm('Deactivate this account?')) return;
      await api('POST', `/platform/users/${b.dataset.deactivate}/deactivate`);
      toast('Deactivated'); return render();
    }
    if (b.dataset.ureactivate) {
      await api('POST', `/platform/users/${b.dataset.ureactivate}/reactivate`);
      toast('Reactivated'); return render();
    }
    if (b.dataset.usave) {
      const full_name = elv('u-edit-name'), email = elv('u-edit-email');
      await api('PATCH', `/platform/users/${b.dataset.usave}`, { full_name, email });
      toast('Profile saved'); return render();
    }
    if (b.dataset.pwgenerate) {
      const r = await api('POST', `/platform/users/${b.dataset.pwgenerate}/password`, { generate: true });
      $('#u-pw-result').innerHTML = `<div class="card" style="margin-top:10px;border:1px solid var(--risk-mod);background:var(--risk-mod-bg)">
        <div class="muted" style="font-size:12px;margin-bottom:4px">New password, shown once. Copy it now and hand it to this person; it will not be shown again.</div>
        <div class="mono" style="font-size:16px;font-weight:600;user-select:all">${esc(r.password)}</div></div>`;
      toast('Password generated'); return;
    }
    if (b.dataset.pwset) {
      const password = elv('u-pw-manual');
      if (!password) { toast('Type a password first', true); return; }
      await api('POST', `/platform/users/${b.dataset.pwset}/password`, { password });
      $('#u-pw-manual').value = '';
      $('#u-pw-result').innerHTML = `<div class="card" style="margin-top:10px"><div class="muted" style="font-size:12px">Password set.</div></div>`;
      toast('Password set'); return;
    }
    if (b.dataset.uroleadd) {
      const [id, slug] = b.dataset.uroleadd.split('|');
      await api('POST', `/platform/users/${id}/roles`, { role_slug: slug });
      toast(`Role added: ${slug}`); return render();
    }
    if (b.dataset.urolerem) {
      const [id, slug] = b.dataset.urolerem.split('|');
      await api('DELETE', `/platform/users/${id}/roles/${slug}`);
      toast(`Role removed: ${slug}`); return render();
    }
    if (b.id === 'a-go') {
      const r = await api('GET', '/production/assets/search?semantic=' + encodeURIComponent($('#a-search').value));
      $('#a-results').innerHTML = `<div class="agrid" style="margin-top:10px">` + (r.items.map(a =>
        `<div class="acard">${assetThumb(a)}<div class="ainfo">
           <b style="font-size:12px">${esc(a.title)}</b>
           <div class="muted" style="font-size:11px"><span class="mono">${esc(a.code)}</span> · ${Math.round((a.similarity ?? 0) * 100)}% match</div>
         </div></div>`).join('')
        || '<div class="muted">No matches. Semantic search is coarse until real embeddings exist; try the text filter.</div>') + '</div>';
      return;
    }
    if (b.id === 'a-gen') {
      b.disabled = true; b.textContent = 'Generating…';
      await api('POST', '/production/assets/generate',
        { brief: $('#a-brief').value, kind: $('#a-kind').value });
      toast('Generated. Inactive until the producer approves it.'); return render();
    }
    if (b.id === 't-save') {
      await api('POST', '/language/terminology', {
        term_en: $('#t-en').value, preferred_am: $('#t-am').value,
        avoid_am: $('#t-avoid').value.split(',').map(x => x.trim()).filter(Boolean),
        register: $('#t-reg').value });
      toast('Term saved as draft'); return render();
    }
    if (b.dataset.termapprove) {
      await api('POST', `/language/terminology/${b.dataset.termapprove}/approve`);
      toast('Term approved'); return render();
    }
    if (b.dataset.langreview) {
      const [id, decision] = b.dataset.langreview.split('|');
      const r = await api('POST', `/content/scripts/${id}/language-review`,
        { decision, naturalness_score: 4, meaning_preserved: true });
      toast(`Language ${decision}. ${r.next}`); return render();
    }
    if (b.dataset.langreviewEdit) {
      const id = b.dataset.langreviewEdit;
      const corrected = prompt('Corrected Amharic (full text):'); if (!corrected) return;
      const r = await api('POST', `/content/scripts/${id}/language-review`,
        { decision: 'APPROVED_WITH_EDITS', corrected_amharic: corrected,
          naturalness_score: 4, meaning_preserved: true });
      toast(`Language approved with edits. ${r.next}`); return render();
    }
    if (b.dataset.langreviewReason) {
      const [id, decision] = b.dataset.langreviewReason.split('|');
      const comment = prompt('What needs to change:'); if (!comment) return;
      await api('POST', `/content/scripts/${id}/language-review`, { decision, comment });
      toast('Sent back to the writer'); return render();
    }
    if (b.dataset.scripttxReason) {
      const [id, to] = b.dataset.scripttxReason.split('|');
      const reason = prompt('Comment (required):'); if (!reason) return;
      await api('POST', `/content/scripts/${id}/transition`, { to, reason }); toast(`Script → ${to}`); return render();
    }
  } catch (ex) { toast(ex.message, true); render(); }
});

// ---------- Part 2 guided-flow actions (14 Aug 2026) ----------
// A second delegated listener for the new screens, kept separate from the
// original one so neither selector string becomes unreadable. No overlap:
// every id/attribute here is new.
const fileB64 = (file) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1]);
  r.onerror = rej; r.readAsDataURL(file);
});
const elv = (id) => document.getElementById(id)?.value;
const has = (id) => !!document.getElementById(id);

// The Make screen's selections live in MAKE so a re-render keeps them.
document.addEventListener('change', (e) => {
  const t = e.target;
  // Video Studio's format description updates in place, deliberately NOT
  // via render() -- a full re-render would wipe whatever the user already
  // typed into Title/Budget on the same form.
  if (t.id === 'st-format') {
    const desc = document.getElementById('st-format-desc');
    if (desc) desc.textContent = STUDIO_FORMATS.find(f => f.value === t.value)?.desc ?? '';
    return;
  }
  // Overlay form: show only the fields the chosen kind actually has, so a
  // door card never asks for a single "text" and an icon never asks for a
  // text colour. Same in-place discipline as the two blocks around it --
  // re-rendering here would wipe what the user already typed.
  if (t.id === 'st-overlay-kind') {
    const show = (id, on) => { const el = document.getElementById(id); if (el) el.hidden = !on; };
    const isDoor = t.value === 'DOOR_CARD', isIcon = t.value === 'ICON';
    show('st-ov-text-fields', !isDoor && !isIcon);
    show('st-ov-door-fields', isDoor);
    show('st-ov-icon-fields', isIcon);
    show('st-ov-style-fields', !isIcon);
    // A door card is always full-screen (0035's schema comment), so it has
    // no position or animation of its own -- its lines carry their own
    // timing via delay_s instead.
    show('st-ov-place-fields', !isDoor);
    const size = document.getElementById('st-ov-fontsize');
    if (size) size.value = isDoor ? 64 : t.value === 'LABEL' ? 44 : 56;
    return;
  }
  // Same in-place update for the New lock form's two explainer lines, plus
  // the JSON textarea's placeholder example, which changes per entity type
  // since compileStillPrompt() reads different fields for a CHARACTER vs
  // an ENVIRONMENT vs a PROP vs the project-wide STYLE lock. Placeholder
  // only, never the textarea's actual value, so nothing already typed is
  // ever overwritten.
  if (t.id === 'st-lock-level') {
    const desc = document.getElementById('st-lock-level-desc');
    if (desc) desc.textContent = LOCK_LEVELS.find(v => v.value === t.value)?.desc ?? '';
    return;
  }
  if (t.id === 'st-lock-entitytype') {
    const desc = document.getElementById('st-lock-entitytype-desc');
    const entry = LOCK_ENTITY_TYPES.find(v => v.value === t.value);
    if (desc) desc.textContent = entry?.desc ?? '';
    const data = document.getElementById('st-lock-data');
    if (data && entry) data.placeholder = entry.example;
    return;
  }
  if (t.id === 'mk-card') { MAKE.cardId = t.value; return render(); }
  if (t.name === 'mk-aud') { MAKE.audience = t.value; return render(); }
  if (t.name === 'mk-path') { MAKE.path = t.value; return render(); }
  if (t.dataset?.mkfmt) {
    if (t.checked) MAKE.formats.add(t.dataset.mkfmt); else MAKE.formats.delete(t.dataset.mkfmt);
    return render();
  }
  if (t.id === 'mk-transcript') { MAKE.transcriptId = t.value; }
});

// Individual permission overrides (0027_user_permission_overrides.sql): the
// select commits on change, no separate save button, since a matrix of ~40
// rows each needing its own Save click would be worse than acting
// immediately the way the role add/remove buttons already do.
document.addEventListener('change', async (e) => {
  const t = e.target;
  if (!t.dataset?.upermset) return;
  const [id, slug] = t.dataset.upermset.split('|');
  try {
    await api('POST', `/platform/users/${id}/permissions`, { permission_slug: slug, effect: t.value || null });
    toast(`${slug}: ${t.value || 'default'}`); render();
  } catch (ex) { toast(ex.message, true); render(); }
});

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-scriptedit],[data-regen],[data-advance],#mk-go,#tr-paste,#tr-upload,[data-trsave],[data-traddrow],[data-trconfirm],[data-amapprove],[data-amapprove-edits],[data-amchanges],[data-startprod],#af-go,#au-upload,[data-assetsave]');
  if (!b) {
    const bi = e.target.closest('.bitem[data-nav]');
    if (bi && !e.target.closest('a[href],button')) location.hash = '#/' + bi.dataset.nav;
    return;
  }
  e.preventDefault();
  try {
    // ---- step 3: save inline edits, and say plainly what the edit did ----
    if (b.dataset.scriptedit) {
      const id = b.dataset.scriptedit;
      b.disabled = true; b.textContent = 'Saving…';
      const cur = await api('GET', `/content/scripts/${id}`);
      const v = cur.version ?? {};
      const payload = { hook: elv('ed-hook'), cta: elv('ed-cta') };
      const body = JSON.parse(JSON.stringify(v.body ?? {}));
      if (has('ed-spoken')) payload.spoken_script = elv('ed-spoken');
      if (has('ed-post')) payload.post_text = elv('ed-post');
      if (has('ed-g-headline')) payload.static_graphic = { headline: elv('ed-g-headline'),
        body: elv('ed-g-body'), footer: elv('ed-g-footer') || null };
      if (has('ed-sl-0-title')) {
        const slides = [];
        for (let i = 0; has(`ed-sl-${i}-title`); i++) {
          slides.push({ ...(v.carousel_slides?.[i] ?? {}), title: elv(`ed-sl-${i}-title`), body: elv(`ed-sl-${i}-body`) });
        }
        payload.carousel_slides = slides;
      }
      if (has('ed-b-intro')) {
        body.intro = elv('ed-b-intro');
        for (let i = 0; has(`ed-sec-${i}-heading`); i++) {
          body.sections[i] = { ...(body.sections?.[i] ?? {}), heading: elv(`ed-sec-${i}-heading`), body: elv(`ed-sec-${i}-body`) };
        }
      }
      for (let i = 0; has(`ed-it-${i}-en`); i++) {
        body.items[i] = { ...(body.items?.[i] ?? {}), text_en: elv(`ed-it-${i}-en`), text_am: elv(`ed-it-${i}-am`) };
      }
      if (has('ed-p-title')) body.push = { title: elv('ed-p-title'), body: elv('ed-p-body'), deep_link: elv('ed-p-link') };
      for (let i = 0; has(`ed-seg-${i}-title`); i++) {
        body.segments[i] = { ...(body.segments?.[i] ?? {}), title: elv(`ed-seg-${i}-title`), description: elv(`ed-seg-${i}-desc`) };
      }
      if (has('ed-pinned')) body.pinned_message = elv('ed-pinned');
      for (let i = 0; has(`ed-cut-${i}`); i++) body.cutdown_briefs[i] = elv(`ed-cut-${i}`);
      if (has('ed-body-extra')) {
        try { Object.assign(body, JSON.parse(elv('ed-body-extra'))); }
        catch { toast('The structured-fields JSON does not parse; fix it or leave it as it was.', true); return render(); }
      }
      payload.body = body;
      const r = await api('POST', `/content/scripts/${id}/edit`, payload);
      if (!r.content_changed) {
        FLASH.set(id, { kind: 'ok', title: 'Saved, but nothing actually changed.',
          text: 'The text is identical to the last version, so every sign-off stands.' });
      } else if (r.edit_class === 'MEDICAL') {
        FLASH.set(id, { kind: 'medical', title: 'Saved. This edit touched medical content, so it goes back to medical review.',
          text: `What tripped it: ${(r.edit_reasons ?? []).join('; ')}. The medical sign-off was withdrawn because it no longer describes this text. Re-run validation, then a doctor signs again. That is the rule working, not a problem.` });
      } else {
        FLASH.set(id, { kind: 'ok', title: 'Saved. Style-only edit, the medical sign-off stands.',
          text: 'No claim-mapped statement, number, time window, negation or term changed. Any corrected Amharic phrasing was kept as an approved example the localizer learns from.' });
      }
      return render();
    }
    // ---- step 3: regenerate one piece, steered ----
    if (b.dataset.regen) {
      const id = b.dataset.regen;
      const direction = elv('rg-direction')?.trim() || null;
      b.disabled = true; b.textContent = 'Rewriting…';
      const r = await api('POST', `/content/scripts/${id}/regenerate`, { direction });
      if (r.status === 'NEEDS_KNOWLEDGE') {
        FLASH.set(id, { kind: 'medical', title: 'The writer stopped: a fact it needed is not an approved claim.',
          text: 'That is a success, not a failure. The missing fact is on this page; the clinical team can approve it from the knowledge gaps board.' });
      } else {
        FLASH.set(id, { kind: 'ok', title: `Rewritten as version ${r.version}${direction ? `, steered: "${direction}"` : ''}.`,
          text: `Claim validation ${r.validation_result === 'PASS' ? 'passed' : `came back ${r.validation_result}`}. ${r.note}` });
      }
      return render();
    }
    // ---- advance a piece along its stages ----
    if (b.dataset.advance) {
      b.disabled = true;
      const r = await api('POST', `/pipeline/scripts/${b.dataset.advance}/advance`, {});
      toast(`Moved to ${String(r.stage).replace(/_/g, ' ')}.`);
      return render();
    }
    // ---- step 2: generate, per piece, progress as it happens ----
    if (b.id === 'mk-go') {
      const formats = [...MAKE.formats];
      if (!formats.length || MAKE.running) return;
      MAKE.running = true; b.disabled = true; b.textContent = 'Writing…';
      const run = $('#mk-run');
      run.innerHTML = '<div class="eyebrow" style="margin-top:12px">Writing, piece by piece</div>'
        + formats.map(f => `<div class="claimrow" id="mkr-${esc(f)}"><b>${esc(f)}</b> · queued</div>`).join('');
      const tid = elv('mk-transcript') ?? MAKE.transcriptId;
      let made = 0, stopped = 0, failed = 0;
      for (const f of formats) {
        const row = document.getElementById(`mkr-${f}`);
        row.innerHTML = `<b>${esc(f)}</b> · writing now…`;
        try {
          const payload = { card_id: MAKE.cardId, formats: [f], audience: MAKE.audience };
          if (f === 'aua_recap') payload.transcript_id = tid;
          const r = await api('POST', '/content/generate', payload);
          const sc = r.scripts[0] ?? {};
          const sid = sc.script_id ?? sc.id;
          if (sc.status === 'NEEDS_KNOWLEDGE') {
            stopped++;
            let note = '';
            try { const d = await api('GET', `/content/scripts/${sid}`);
              note = JSON.stringify(d.needs_knowledge_note ?? {}).slice(0, 180); } catch {}
            row.style.borderLeftColor = 'var(--risk-mod)';
            row.innerHTML = `<b>${esc(f)}</b> · <b>stopped honestly:</b> a fact it needed is not an approved claim, so it refused to invent one.
              <div class="mono muted" style="font-size:11px;margin:4px 0">${esc(note)}</div>
              <a href="#/gaps">Open the knowledge gap</a> · <a href="#/script/${esc(sid)}">open the piece</a>`;
          } else {
            made++;
            if (MAKE.path === 'LIVE') {
              try { await api('POST', `/pipeline/scripts/${sid}/production-path`, { path: 'LIVE' }); } catch {}
            }
            row.innerHTML = `<b>${esc(f)}</b> · written and claim-checked${sc.status === 'VALIDATION_FAILED' ? ' (validation failed; the findings say why)' : ''}
              · <a href="#/script/${esc(sid)}">read it</a>`;
          }
        } catch (ex) {
          failed++;
          row.className = 'claimrow bad';
          row.innerHTML = `<b>${esc(f)}</b> · ${esc(ex.message)}`;
        }
      }
      MAKE.running = false;
      b.textContent = `Done: ${made} written${stopped ? `, ${stopped} waiting on a missing fact` : ''}${failed ? `, ${failed} failed` : ''}`;
      run.insertAdjacentHTML('beforeend',
        `<div style="margin-top:10px;font-size:13px">Next: read each piece, edit or steer it, then it moves to medical review. <a href="#/board">The board</a> tracks all of them.</div>`);
      return;
    }
    // ---- transcripts ----
    if (b.id === 'tr-paste') {
      const title = elv('tr-title')?.trim();
      if (!title || !elv('tr-text')?.trim()) return toast('A title and the pasted transcript are both needed.', 'warn');
      b.disabled = true;
      const r = await api('POST', '/content/transcripts', { title, transcript_text: elv('tr-text') });
      toast(`Saved as draft with ${r.segments.length} lines. ${r.warning}`);
      return render();
    }
    if (b.id === 'tr-upload') {
      const title = elv('tr-title-2')?.trim();
      const file = document.getElementById('tr-file')?.files?.[0];
      if (!title || !file) return toast('A title and a file are both needed.', 'warn');
      if (file.size > 17 * 1024 * 1024) return toast('That file is too big. Upload the audio, not the video: transcription needs only the audio and the file is a hundred times smaller.', 'warn');
      b.disabled = true; b.textContent = 'Transcribing…';
      const r = await api('POST', '/content/transcripts',
        { title, media_base64: await fileB64(file), media_mime_type: file.type || 'audio/mpeg' });
      toast(`${r.note ? r.note + ' ' : ''}${r.warning}`, 'warn');
      return render();
    }
    if (b.dataset.trsave) {
      const segs = [];
      for (let i = 0; has(`ts-${i}-text`); i++) {
        const text = elv(`ts-${i}-text`)?.trim();
        if (!text) continue;
        const num = (x) => { const n = Number(x); return Number.isFinite(n) && x !== '' ? n : null; };
        segs.push({ start_s: num(elv(`ts-${i}-start`)), end_s: num(elv(`ts-${i}-end`)), speaker: 'doctor', text });
      }
      const r = await api('PUT', `/content/transcripts/${b.dataset.trsave}`, { segments: segs });
      toast(r.reconfirm_needed
        ? 'Saved. This transcript was confirmed before the edit, so it is back to draft and must be confirmed again.'
        : 'Saved as draft.', r.reconfirm_needed ? 'warn' : false);
      return render();
    }
    if (b.dataset.traddrow) {
      let i = 0; while (has(`ts-${i}-text`)) i++;
      const table = b.closest('.card').querySelector('table');
      table.insertAdjacentHTML('beforeend', `<tr>
        <td><input id="ts-${i}-start" value=""></td><td><input id="ts-${i}-end" value=""></td>
        <td><textarea id="ts-${i}-text" class="amharic" style="min-height:44px"></textarea></td></tr>`);
      return;
    }
    if (b.dataset.trconfirm) {
      const r = await api('POST', `/content/transcripts/${b.dataset.trconfirm}/confirm`, {});
      toast(r.message);
      return render();
    }
    // ---- steps 4-5: the Amharic ----
    if (b.dataset.amapprove) {
      b.disabled = true;
      const r = await api('POST', `/content/scripts/${b.dataset.amapprove}/language-review`,
        { decision: 'APPROVED', naturalness_score: 4, meaning_preserved: true });
      toast(`Amharic approved. ${r.next ?? ''}`);
      location.hash = '#/script/' + b.dataset.amapprove; return;
    }
    if (b.dataset.amapproveEdits) {
      const corrected = elv('am-text')?.trim();
      if (!corrected) return toast('The Amharic text is empty.', 'warn');
      b.disabled = true;
      const r = await api('POST', `/content/scripts/${b.dataset.amapproveEdits}/language-review`,
        { decision: 'APPROVED_WITH_EDITS', corrected_amharic: corrected,
          naturalness_score: 4, meaning_preserved: true });
      toast(`Amharic approved with your edits; the corrected phrasing feeds the localizer. ${r.next ?? ''}`);
      location.hash = '#/script/' + b.dataset.amapproveEdits; return;
    }
    if (b.dataset.amchanges) {
      const comment = prompt('What needs to change in the Amharic:'); if (!comment) return;
      await api('POST', `/content/scripts/${b.dataset.amchanges}/language-review`,
        { decision: 'CHANGES_REQUESTED', comment });
      toast('Sent back with your note. The piece does not advance until the Amharic is approved.');
      return render();
    }
    // ---- step 6: approve the plan and start ----
    if (b.dataset.startprod) {
      const sid = b.dataset.startprod;
      b.disabled = true; b.textContent = 'Starting…';
      const job = await api('POST', '/production/jobs', { script_id: sid });
      const pick = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value ?? null;
      const bindings = [...document.querySelectorAll('input[name^="pp-scene-"]:checked')]
        .filter(x => x.value)
        .map(x => ({ scene: Number(x.name.replace('pp-scene-', '')), asset_id: x.value }));
      const saved = await api('POST', `/production/jobs/${job.id}/plan`,
        { video_engine: pick('pp-engine'), subtitle_preset: pick('pp-subs'),
          voice_source: pick('pp-voice'), asset_bindings: bindings });
      const run = await api('POST', `/production/jobs/${job.id}/run`);
      if (run.status === 'CAP_REACHED') toast(run.reason, 'warn');
      else toast(`Started. ${saved.summary}`);
      location.hash = '#/production'; return;
    }
    // ---- the asset library ----
    if (b.id === 'af-go') {
      const params = new URLSearchParams();
      if (elv('af-text')) params.set('text', elv('af-text'));
      if (elv('af-kind')) params.set('kind', elv('af-kind'));
      if (elv('af-ai')) params.set('ai', elv('af-ai'));
      if (document.getElementById('af-pending')?.checked) params.set('pending', '1');
      location.hash = '#/assets' + (params.toString() ? `?${params}` : '');
      return;
    }
    if (b.id === 'au-upload') {
      const file = document.getElementById('au-file')?.files?.[0];
      const title = elv('au-title')?.trim();
      if (!file || !title) return toast('Pick a file and give it a title.', 'warn');
      if (file.size > 6 * 1024 * 1024) return toast('Uploads are capped at 6MB here. For big source recordings, use the transcripts screen or ask the developer to bulk-load.', 'warn');
      b.disabled = true; b.textContent = 'Uploading…';
      await api('POST', '/production/assets', {
        title, kind: elv('au-kind'), origin: 'SHOT_IN_HOUSE', mime_type: file.type || 'application/octet-stream',
        content_base64: await fileB64(file),
        tags: (elv('au-tags') ?? '').split(',').map(x => x.trim()).filter(Boolean) });
      toast(`Saved "${title}" to the library.`);
      return render();
    }
    if (b.dataset.assetsave) {
      const id = b.dataset.assetsave;
      b.disabled = true;
      const r = await api('POST', `/production/assets/${id}/activate`,
        { title: elv(`as-title-${id}`) ?? '', tags: (elv(`as-tags-${id}`) ?? '').split(',').map(x => x.trim()).filter(Boolean) });
      toast(r.message ?? 'Saved to the library.');
      return render();
    }
  } catch (ex) { toast(ex.message, true); render(); }
});

// ---------- Video Studio actions (18 Aug 2026) ----------
// A third delegated listener, kept separate for the same reason as the
// Part 2 one above: Video Studio (apps/api/src/modules/studio.mjs) is a new,
// independent backend module and folding its ids into either existing
// selector string would only make those harder to read. No overlap: every
// id/attribute here is new.
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-stlockdraft],[data-stlockapprove],[data-stlockref],[data-stlockreftoggle],[data-stlockremix],[data-stlocklibopen],[data-stlockattach],[data-stlockuploadgo],[data-strefselect],[data-stpacktoggle],[data-stpackupload],[data-stlockcreate],[data-stshotcreate],[data-stshotedit],[data-stshotcompose],[data-stshotcontinue],[data-stcontinueremix],[data-stscrolltolocks],[data-stshotgenerate],[data-stshotvoiceshow],[data-stshotvoice],[data-stassets],[data-stassetaccept],[data-stmusic],[data-stassemble],[data-starchive],[data-stunarchive],[data-stoverlaycreate],[data-stoverlayapprove],[data-stoverlaydelete],[data-stbriefdraft],[data-stbriefapply],[data-stscriptdraft],[data-stscriptapply],#st-newproj-go');
  if (!b) return;
  e.preventDefault();
  try {
    if (b.dataset.stlockdraft) {
      const freeText = elv('st-lock-freetext')?.trim();
      if (!freeText) return toast('Describe it first, then Draft with AI.', 'warn');
      const entityType = elv('st-lock-entitytype');
      const note = document.getElementById('st-lock-draftnote');
      b.disabled = true; b.textContent = 'Drafting…';
      try {
        const r = await api('POST', '/studio/locks/draft', { entity_type: entityType, free_text: freeText });
        const dataBox = document.getElementById('st-lock-data');
        if (dataBox) dataBox.value = JSON.stringify(r.data, null, 2);
        if (note) {
          if (r.clarifying_note) {
            note.hidden = false; note.textContent = r.clarifying_note;
          } else {
            note.hidden = true; note.textContent = '';
          }
        }
        const hasFields = Object.keys(r.data ?? {}).length > 0;
        if (hasFields) toast('Draft filled in below -- review before creating the lock.');
        else toast('Not enough in that description to draft anything -- try adding more detail.', 'warn');
      } finally {
        b.disabled = false; b.textContent = 'Draft with AI';
      }
      return;
    }
    if (b.id === 'st-newproj-go') {
      const title = elv('st-title')?.trim();
      if (!title) return toast('Give the project a title first.', 'warn');
      const budgetRaw = elv('st-budget')?.trim();
      b.disabled = true; b.textContent = 'Creating…';
      const p = await api('POST', '/studio/projects', {
        title,
        format: elv('st-format')?.trim() || 'ai_story',
        aspect_ratio: elv('st-aspect') || '9:16',
        language: elv('st-lang') || 'am',
        budget_cap_usd: budgetRaw ? Number(budgetRaw) : null,
      });
      toast('Project created');
      location.hash = '#/studio-project/' + p.id;
      return;
    }
    if (b.dataset.stlockcreate) {
      const projectId = b.dataset.stlockcreate;
      const entityCode = elv('st-lock-entitycode')?.trim();
      if (!entityCode) return toast('Give the lock an entity code first.', 'warn');
      let data;
      try { data = JSON.parse(elv('st-lock-data') || '{}'); }
      catch { return toast('Invalid JSON in lock data', true); }
      b.disabled = true; b.textContent = 'Creating…';
      await api('POST', `/studio/projects/${projectId}/locks`,
        { level: elv('st-lock-level'), entity_type: elv('st-lock-entitytype'), entity_code: entityCode, data });
      toast('Lock created'); return render();
    }
    if (b.dataset.stlockapprove) {
      b.disabled = true; b.textContent = 'Approving…';
      await api('POST', `/studio/locks/${b.dataset.stlockapprove}/approve`, {});
      toast('Lock approved'); return render();
    }
    if (b.dataset.stlockref) {
      b.disabled = true; b.textContent = 'Generating…';
      await api('POST', `/studio/locks/${b.dataset.stlockref}/reference`, {});
      toast('Reference image generated'); return render();
    }
    if (b.dataset.stlockreftoggle) {
      const panel = document.getElementById(`stlockrefpanel-${b.dataset.stlockreftoggle}`);
      if (panel) panel.hidden = !panel.hidden;
      return;
    }
    if (b.dataset.stlockremix) {
      const lockId = b.dataset.stlockremix;
      const prompt = elv(`stremixprompt-${lockId}`)?.trim();
      if (!prompt) return toast('Describe the change first.', 'warn');
      // The button only knows the LOCK id; the newest reference asset id
      // for that lock is read back off the current render's own lock data
      // via the panel's data, set below when the lock list was built.
      const assetId = b.dataset.stlockremixasset;
      if (!assetId) return toast('No reference image to remix yet.', 'warn');
      b.disabled = true; b.textContent = 'Remixing…';
      await api('POST', `/studio/assets/${assetId}/remix`, { prompt });
      toast('Remixed. This is now the current reference.'); return render();
    }
    if (b.dataset.stlocklibopen) {
      const [lockId, entityType] = b.dataset.stlocklibopen.split('|');
      const box = document.getElementById(`stlocklibbox-${lockId}`);
      if (!box) return;
      if (box.dataset.loaded) { box.hidden = !box.hidden; return; }
      box.hidden = false;
      box.innerHTML = '<div class="muted" style="font-size:12px">Loading…</div>';
      try {
        const r = await api('GET', `/studio/locks/library-candidates?entity_type=${encodeURIComponent(entityType)}`);
        const items = r.items ?? [];
        box.innerHTML = items.length
          ? `<div class="flex" style="flex-wrap:wrap;gap:8px">${items.map(a => `
            <div style="text-align:center">
              <img class="ath" style="max-width:90px;max-height:90px;border-radius:4px;cursor:pointer" src="${esc(mediaUrl(a.storage_key))}" alt="${esc(a.title)}" loading="lazy" onerror="assetImgError(this,'CHARACTER_REFERENCE')" data-stlockattach="${esc(lockId)}|${esc(a.id)}">
              <div class="muted" style="font-size:10px;max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.title)}</div>
            </div>`).join('')}</div>`
          : '<div class="muted" style="font-size:12px">Nothing in the library yet for this kind.</div>';
        box.dataset.loaded = '1';
      } catch (ex) {
        box.innerHTML = `<div class="muted" style="font-size:12px">${esc(ex.message)}</div>`;
      }
      return;
    }
    if (b.dataset.stlockattach) {
      const [lockId, libAssetId] = b.dataset.stlockattach.split('|');
      await api('POST', `/studio/locks/${lockId}/reference/attach`, { library_asset_id: libAssetId });
      toast('Attached from the library. This is now the current reference.'); return render();
    }
    if (b.dataset.stpacktoggle) {
      const lockId = b.dataset.stpacktoggle;
      const box = document.getElementById(`stpackbox-${lockId}`);
      if (!box) return;
      if (!box.hidden) { box.hidden = true; return; }
      box.hidden = false;
      box.innerHTML = '<div class="muted" style="font-size:12px">Loading…</div>';
      const KINDS = ['MASTER', 'TURNAROUND', 'EXPRESSIONS', 'POSES', 'COSTUME_DETAIL', 'COLOR_PALETTE',
        'LOCATION_ANGLES', 'LOCATION_LAYOUT', 'PROPS', 'OTHER'];
      const pretty = (k) => k.toLowerCase().replace(/_/g, ' ');
      try {
        const r = await api('GET', `/studio/locks/${lockId}/reference-pack`);
        const items = r.items ?? [];
        box.innerHTML = `
          <div class="claimrow">
            <div class="muted" style="font-size:11px;margin-bottom:6px">Make these anywhere you like (ChatGPT, Midjourney, a real photoshoot) and drop them here. They stay attached to this lock, show up in the asset library, and the composer feeds the most useful one to Gemini as extra identity conditioning. A sheet does <b>not</b> become the composable reference unless you tick the box.</div>
            <div class="flex" style="gap:6px;flex-wrap:wrap;align-items:flex-end">
              <div><label style="font-size:11px">Sheet kind</label>
                <select id="stpackkind-${esc(lockId)}" style="max-width:180px">${KINDS.map(k => `<option value="${k}">${esc(pretty(k))}</option>`).join('')}</select></div>
              <div><label style="font-size:11px">Image files (up to 12)</label>
                <input type="file" id="stpackfiles-${esc(lockId)}" accept="image/*" multiple></div>
              <label class="otpick" style="font-size:11px"><input type="checkbox" id="stpackcurrent-${esc(lockId)}"> also make the first one the current reference</label>
              <button data-stpackupload="${esc(lockId)}">Upload sheets</button>
            </div>
            <div class="muted" style="font-size:11px;margin-top:4px">Every file in one upload is filed under the chosen sheet kind. Upload each kind separately to label them properly.</div>
          </div>
          ${items.length ? `<div style="margin-top:10px">${KINDS.filter(k => items.some(i => i.sheet_kind === k)).map(k => `
            <div style="margin-bottom:8px">
              <div style="font-size:11px;font-weight:600">${esc(pretty(k))}</div>
              <div class="flex" style="flex-wrap:wrap;gap:6px;margin-top:3px">
                ${items.filter(i => i.sheet_kind === k).map(i => `
                  <img class="ath" style="max-width:88px;max-height:88px;border-radius:4px;cursor:zoom-in" src="${esc(mediaUrl(i.storage_key))}" alt="${esc(pretty(k))}" loading="lazy" title="Click to preview" onclick="imagePreview('${esc(mediaUrl(i.storage_key))}','${esc(pretty(k))}')" onerror="assetImgError(this,'REFERENCE_IMAGE')">`).join('')}
              </div>
            </div>`).join('')}</div>`
            : '<div class="muted" style="font-size:12px;margin-top:8px">No sheets uploaded for this lock yet.</div>'}`;
      } catch (ex) {
        box.innerHTML = `<div class="muted" style="font-size:12px">${esc(ex.message)}</div>`;
      }
      return;
    }
    if (b.dataset.stpackupload) {
      const lockId = b.dataset.stpackupload;
      const files = [...(document.getElementById(`stpackfiles-${lockId}`)?.files ?? [])];
      if (!files.length) return toast('Choose at least one image file.', 'warn');
      if (files.length > 12) return toast('At most 12 sheets per upload.', 'warn');
      const oversize = files.find(f => f.size > 8 * 1024 * 1024);
      if (oversize) return toast(`${oversize.name} is over the 8MB per-sheet cap.`, 'warn');
      const kind = document.getElementById(`stpackkind-${lockId}`)?.value ?? 'OTHER';
      const makeCurrent = document.getElementById(`stpackcurrent-${lockId}`)?.checked === true;
      b.disabled = true; b.textContent = 'Uploading…';
      try {
        const sheets = [];
        for (const [i, f] of files.entries()) {
          sheets.push({ sheet_kind: kind, image_base64: await fileB64(f),
            mime_type: f.type || 'image/png', note: f.name,
            make_current: makeCurrent && i === 0 });
        }
        const r = await api('POST', `/studio/locks/${lockId}/reference-pack`, { sheets });
        toast(`${r.saved.length} sheet(s) added${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}.`);
      } finally {
        b.disabled = false; b.textContent = 'Upload sheets';
      }
      return render();
    }
    if (b.dataset.strefselect) {
      const [lockId, assetId] = b.dataset.strefselect.split('|');
      b.disabled = true; b.textContent = 'Switching…';
      await api('POST', `/studio/locks/${lockId}/reference/select`, { asset_id: assetId });
      toast('Switched. That version is current again.'); return render();
    }
    if (b.dataset.stlockuploadgo) {
      const lockId = b.dataset.stlockuploadgo;
      const file = document.getElementById(`stlockuploadfile-${lockId}`)?.files?.[0];
      if (!file) return toast('Choose an image file first.', 'warn');
      if (file.size > 8 * 1024 * 1024) return toast('Uploads are capped at 8MB.', 'warn');
      b.disabled = true; b.textContent = 'Uploading…';
      await api('POST', `/studio/locks/${lockId}/reference/upload`,
        { image_base64: await fileB64(file), mime_type: file.type || 'image/png' });
      toast('Uploaded. This is now the current reference.'); return render();
    }
    if (b.dataset.stshotcreate) {
      const projectId = b.dataset.stshotcreate;
      const shotCode = elv('st-shot-code')?.trim();
      if (!shotCode) return toast('Give the shot a code first.', 'warn');
      const chars = (elv('st-shot-chars') ?? '').split(',').map(x => x.trim()).filter(Boolean);
      const camera = elv('st-shot-camera')?.trim();
      const action = elv('st-shot-action')?.trim();
      b.disabled = true; b.textContent = 'Adding…';
      await api('POST', `/studio/projects/${projectId}/shots`, {
        shot_code: shotCode,
        order_index: Number(elv('st-shot-order')) || 0,
        duration_target_s: Number(elv('st-shot-dur')) || 5,
        continuity: { characters: chars },
        story: { beat: elv('st-shot-beat') ?? '' },
        ...(camera ? { camera: { movement: camera } } : {}),
        ...(action ? { action: { subject: action } } : {}),
      });
      toast('Shot added'); return render();
    }
    if (b.dataset.stshotedit) {
      const id = b.dataset.stshotedit;
      const durRaw = elv(`stedit-dur-${id}`);
      b.disabled = true; b.textContent = 'Saving…';
      await api('PATCH', `/studio/shots/${id}`, {
        ...(durRaw !== '' && durRaw != null ? { duration_target_s: Number(durRaw) } : {}),
        story: { beat: elv(`stedit-beat-${id}`) ?? '' },
      });
      toast('Shot updated'); return render();
    }
    if (b.dataset.stscrolltolocks) {
      document.getElementById('st-locks-anchor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (b.dataset.stshotcompose) {
      const id = b.dataset.stshotcompose;
      const box = document.getElementById(`stcomposebox-${id}`);
      b.disabled = true; b.textContent = 'Composing…';
      try {
        const r = await api('POST', `/studio/shots/${id}/compose-first-frame`, {});
        if (box) {
          box.innerHTML = `<div class="claimrow" style="margin-top:8px">
            <div style="font-size:12px"><b>&check; First frame composed</b> from
              ${esc(r.character_lock?.entity_code ?? '')} + ${esc(r.environment_lock?.entity_code ?? '')}.
              This shot is now set to image_to_video mode using this frame -- click Generate below to render the video from it.</div>
            <img class="ath" style="margin-top:6px;max-width:200px" src="${esc(mediaUrl(r.asset?.storage_key))}"
              alt="composed first frame" loading="lazy" onerror="assetImgError(this,'KEYFRAME')">
          </div>`;
        }
        toast('First frame composed. This shot now uses image_to_video mode.');
      } finally {
        b.disabled = false; b.textContent = 'Step 3 · Compose first frame';
      }
      return;
    }
    if (b.dataset.stshotcontinue) {
      const id = b.dataset.stshotcontinue;
      const box = document.getElementById(`stcontinuebox-${id}`);
      b.disabled = true; b.textContent = 'Pulling last frame…';
      try {
        const r = await api('POST', `/studio/shots/${id}/continue-from-previous`, {});
        if (box) {
          box.innerHTML = `<div class="claimrow" style="margin-top:8px">
            <div style="font-size:12px"><b>&check; Continuing from ${esc(r.continued_from?.shot_code ?? '')}</b>.
              This shot is now set to image_to_video mode using that shot's last frame -- click Generate below to render the video from it.</div>
            <img class="ath" style="margin-top:6px;max-width:200px" src="${esc(mediaUrl(r.asset?.storage_key))}"
              alt="continuity frame" loading="lazy" onerror="assetImgError(this,'KEYFRAME')">
            <div style="margin-top:6px">
              <label style="font-size:11px">Remix this frame before generating (optional)</label>
              <textarea id="stcontinueremixprompt-${esc(r.asset.id)}" style="font-size:12px;width:100%" placeholder="e.g. same room, slightly warmer light"></textarea>
              <button style="margin-top:4px" data-stcontinueremix="${esc(r.asset.id)}">Remix</button>
            </div>
          </div>`;
        }
        toast(`Continuing from ${r.continued_from?.shot_code ?? 'the previous shot'}.`);
      } finally {
        b.disabled = false; b.textContent = 'Continue from previous shot';
      }
      return;
    }
    if (b.dataset.stcontinueremix) {
      const assetId = b.dataset.stcontinueremix;
      const prompt = elv(`stcontinueremixprompt-${assetId}`)?.trim();
      if (!prompt) return toast('Describe the change first.', 'warn');
      b.disabled = true; b.textContent = 'Remixing…';
      await api('POST', `/studio/assets/${assetId}/remix`, { prompt });
      toast('Remixed. The shot now uses the remixed frame.'); return render();
    }
    if (b.dataset.stshotgenerate) {
      const id = b.dataset.stshotgenerate;
      b.disabled = true; b.textContent = 'Generating…';
      const r = await api('POST', `/studio/shots/${id}/generate`, {});
      toast(`QC: ${r.qc_report?.disposition ?? 'done'}`);
      return render();
    }
    if (b.dataset.stshotvoiceshow) {
      const box = document.getElementById('stvoice-' + b.dataset.stshotvoiceshow);
      if (box) box.hidden = !box.hidden;
      return;
    }
    if (b.dataset.stshotvoice) {
      const id = b.dataset.stshotvoice;
      const text = elv(`stvoicetext-${id}`)?.trim();
      if (!text) return toast('Write the voice line first.', 'warn');
      b.disabled = true; b.textContent = 'Sending…';
      await api('POST', `/studio/shots/${id}/voice`, { text });
      toast('Voice line sent'); return render();
    }
    if (b.dataset.stassets) {
      const id = b.dataset.stassets;
      const box = document.getElementById('stassetsbox-' + id);
      if (!box) return;
      if (box.dataset.loaded) { box.hidden = !box.hidden; return; }
      box.hidden = false;
      box.innerHTML = '<div class="muted" style="font-size:12px;margin-top:6px">Loading…</div>';
      try {
        const r = await api('GET', `/studio/shots/${id}/assets`);
        const items = r.items ?? [];
        box.innerHTML = items.length ? items.map(a => `<div class="claimrow" style="margin-top:8px">
          <div class="flex"><b>${esc(a.kind ?? '')}</b>${pill(a.status)}
            <span class="muted">${esc(a.generator?.provider ?? '')}</span>
            <span class="spacer"></span>
            ${can('studio.approve') && a.status !== 'ACCEPTED'
              ? (a.status === 'QC_BLOCKED'
                ? `<button disabled title="QC blocked this asset. It cannot be accepted until it is regenerated and passes QC.">Accept</button>`
                : `<button class="approve" data-stassetaccept="${esc(a.id)}">Accept</button>`)
              : ''}</div>
          ${(a.qc_reports ?? []).map(q => `<div style="margin-top:6px">
            ${pill(q.disposition)}
            ${(q.technical?.issues ?? []).length ? `<div class="muted" style="font-size:12px;margin-top:4px">Issues: ${q.technical.issues.map(x => esc(x)).join('; ')}</div>` : ''}
            ${q.continuity?.notes ? `<div class="muted" style="font-size:12px;margin-top:2px">Continuity: ${esc(q.continuity.notes)}</div>` : ''}
          </div>`).join('')}
        </div>`).join('') : '<div class="muted" style="font-size:12px;margin-top:6px">No assets generated for this shot yet.</div>';
        box.dataset.loaded = '1';
      } catch (ex) {
        box.innerHTML = `<div class="muted" style="font-size:12px;margin-top:6px">${esc(ex.message)}</div>`;
      }
      return;
    }
    if (b.dataset.stassetaccept) {
      b.disabled = true; b.textContent = 'Accepting…';
      await api('POST', `/studio/assets/${b.dataset.stassetaccept}/accept`, {});
      toast('Asset accepted'); return render();
    }
    if (b.dataset.stmusic) {
      const projectId = b.dataset.stmusic;
      const promptText = elv('st-music-prompt')?.trim();
      if (!promptText) return toast('Write a brief for the music first.', 'warn');
      const brief = { prompt: promptText };
      const tempo = elv('st-music-tempo'); if (tempo) brief.tempo_bpm = Number(tempo);
      const dur = elv('st-music-duration'); if (dur) brief.duration_s = Number(dur);
      b.disabled = true; b.textContent = 'Generating…';
      await api('POST', `/studio/projects/${projectId}/music`, { brief });
      toast('Music generated'); return render();
    }
    if (b.dataset.stassemble) {
      const projectId = b.dataset.stassemble;
      const body = {};
      const transition = document.getElementById('st-assemble-transition')?.value;
      if (transition && transition !== 'cut') body.transition = transition;
      const musicId = elv('st-assemble-music')?.trim();
      if (musicId) body.music_asset_id = musicId;
      b.disabled = true; b.textContent = 'Assembling…';
      await api('POST', `/studio/projects/${projectId}/assemble`, body);
      toast('Rough cut assembled'); return render();
    }
    if (b.dataset.starchive) {
      const projectId = b.dataset.starchive;
      if (!confirm('Archive this project? It will be hidden from the Video Studio list. Nothing is deleted, and you can unarchive it any time from the project page.')) return;
      b.disabled = true; b.textContent = 'Archiving…';
      await api('POST', `/studio/projects/${projectId}/archive`);
      toast('Project archived'); return render();
    }
    if (b.dataset.stunarchive) {
      const projectId = b.dataset.stunarchive;
      b.disabled = true; b.textContent = 'Unarchiving…';
      await api('POST', `/studio/projects/${projectId}/unarchive`);
      toast('Project unarchived'); return render();
    }
    if (b.dataset.stoverlaycreate) {
      const projectId = b.dataset.stoverlaycreate;
      const startRaw = elv('st-overlay-start'), endRaw = elv('st-overlay-end');
      if (startRaw === '' || endRaw === '') return toast('Give the overlay a start and end time first.', 'warn');
      const kind = elv('st-overlay-kind');
      // The form is the normal path (owner, 21 Aug 2026: "can the editor be
      // something much simpler which then writes in to the json, its hard to
      // comprehend all that"). Raw JSON still wins when someone types it, so
      // nothing that was possible before this form existed became impossible.
      let data;
      const rawJson = (elv('st-overlay-data') || '').trim();
      if (rawJson) {
        try { data = JSON.parse(rawJson); }
        catch { return toast('Invalid JSON in the advanced box', true); }
      } else {
        const num = (id, fallback) => { const v = Number(elv(id)); return Number.isFinite(v) ? v : fallback; };
        if (kind === 'DOOR_CARD') {
          const lines = (elv('st-ov-doorlines') || '').split('\n').map(s => s.trim()).filter(Boolean);
          if (!lines.length) return toast('Write at least one door card line.', 'warn');
          const base = num('st-ov-fontsize', 56);
          data = {
            background_color: elv('st-ov-bgcolor') || '#16103F',
            // Each line a step smaller and half a second later than the one
            // above, which is the shape every real Letena door card uses.
            lines: lines.map((text, i) => ({
              text,
              font_family: i === 0 ? 'bold' : 'regular',
              font_size_px: Math.max(22, Math.round(base * [1, 0.62, 0.52, 0.46][i] ?? base * 0.46)),
              text_color: i === 0 ? (elv('st-ov-textcolor') || '#EBAB20') : '#FFFFFF',
              delay_s: i * 0.5,
            })),
          };
        } else if (kind === 'ICON') {
          const assetId = (elv('st-ov-assetid') || '').trim();
          if (!assetId) return toast('Paste the ICON asset id first.', 'warn');
          data = {
            asset_id: assetId,
            width_px: 120,
            position: { anchor: elv('st-ov-anchor') || 'top', inset_px: 40 },
            animation_in: { type: elv('st-ov-animin') || 'fade', duration_s: 0.3 },
            animation_out: { type: elv('st-ov-animout') || 'fade', duration_s: 0.2 },
          };
        } else {
          const text = (elv('st-ov-text') || '').trim();
          if (!text) return toast('Write the overlay text first.', 'warn');
          data = {
            text,
            font_family: elv('st-ov-fontfamily') || 'bold',
            font_size_px: num('st-ov-fontsize', 56),
            text_color: elv('st-ov-textcolor') || '#EBAB20',
            background_color: elv('st-ov-bgcolor') || '#16103F',
            background_opacity: num('st-ov-bgopacity', 0.9),
            corner_radius_px: 16,
            position: { anchor: elv('st-ov-anchor') || 'upper-third', inset_px: 40 },
            animation_in: { type: elv('st-ov-animin') || 'fade', duration_s: 0.3 },
            animation_out: { type: elv('st-ov-animout') || 'fade', duration_s: 0.2 },
          };
        }
      }
      b.disabled = true; b.textContent = 'Creating…';
      await api('POST', `/studio/projects/${projectId}/overlays`, {
        kind,
        start_s: Number(startRaw),
        end_s: Number(endRaw),
        order_index: Number(elv('st-overlay-order')) || 0,
        data,
      });
      toast('Overlay created'); return render();
    }
    if (b.dataset.stoverlayapprove) {
      b.disabled = true; b.textContent = 'Approving…';
      await api('POST', `/studio/overlays/${b.dataset.stoverlayapprove}/approve`, {});
      toast('Overlay approved'); return render();
    }
    if (b.dataset.stoverlaydelete) {
      if (!confirm('Delete this overlay? This only removes the burn-in instruction; nothing else is affected.')) return;
      b.disabled = true; b.textContent = 'Deleting…';
      await api('DELETE', `/studio/overlays/${b.dataset.stoverlaydelete}`);
      toast('Overlay deleted'); return render();
    }
    if (b.dataset.stbriefdraft) {
      const projectId = b.dataset.stbriefdraft;
      const freeText = elv('st-brief-freetext')?.trim();
      if (!freeText) return toast('Paste the brief text first, then Draft from this brief.', 'warn');
      const box = document.getElementById('st-brief-draftbox');
      b.disabled = true; b.textContent = 'Drafting…';
      try {
        const draft = await api('POST', `/studio/projects/${projectId}/import-brief`, { free_text: freeText });
        if (box) { box.hidden = false; box.innerHTML = renderBriefDraft(draft, projectId); }
        toast('Draft ready below -- review before applying it.');
      } finally {
        b.disabled = false; b.textContent = 'Draft from this brief';
      }
      return;
    }
    if (b.dataset.stbriefapply) {
      const projectId = b.dataset.stbriefapply;
      let draft;
      try { draft = JSON.parse(elv('st-brief-draftjson') || '{}'); }
      catch { return toast('Invalid JSON in the draft box', true); }
      b.disabled = true; b.textContent = 'Applying…';
      try {
        const r = await api('POST', `/studio/projects/${projectId}/import-brief/apply`, draft);
        const skipped = r.overlays_skipped?.length ?? 0;
        toast(`Applied: shot ${r.shot?.shot_code ?? ''} created, ${r.overlays_created?.length ?? 0} overlay${r.overlays_created?.length === 1 ? '' : 's'} created` +
          (skipped ? `, ${skipped} overlay${skipped === 1 ? '' : 's'} skipped (see events for why)` : '') +
          (r.caption_draft ? '. Caption draft still needs placing manually.' : ''),
          skipped ? 'warn' : false);
      } finally {
        b.disabled = false; b.textContent = 'Apply draft';
      }
      return render();
    }
    if (b.dataset.stscriptdraft) {
      const scriptId = b.dataset.stscriptdraft;
      const box = document.getElementById('st-script-draftbox');
      b.disabled = true; b.textContent = 'Drafting…';
      try {
        const r = await api('POST', '/studio/projects/from-script/draft', { script_id: scriptId });
        if (box) { box.hidden = false; box.innerHTML = renderScriptImportDraft(r, scriptId); }
        toast(r.existing_project ? 'This script already has a Video Studio project.'
          : 'Draft ready below -- review before applying it.');
      } finally {
        b.disabled = false; b.textContent = 'Draft from this script';
      }
      return;
    }
    if (b.dataset.stscriptapply) {
      const scriptId = b.dataset.stscriptapply;
      let draft;
      try { draft = JSON.parse(elv('st-script-draftjson') || '{}'); }
      catch { return toast('Invalid JSON in the draft box', true); }
      // The Title/Aspect ratio inputs are the one part of the draft this
      // screen offers a plain field for (see renderScriptImportDraft); any
      // other project/shot/overlay edit goes through the JSON box itself,
      // same convention as the brief importer's own review screen.
      const titleField = elv('st-script-title')?.trim();
      const aspectField = elv('st-script-aspect')?.trim();
      draft.project = { ...(draft.project ?? {}), ...(titleField ? { title: titleField } : {}),
        ...(aspectField ? { aspect_ratio: aspectField } : {}) };
      // reuse_locks: one entry per entity_codes_needed row whose radio is
      // still on "reuse" (the default, when a candidate existed) -- an
      // entity switched to "Draft new instead", or with no candidate at
      // all, is simply absent, exactly as the apply endpoint expects.
      const reuseLocks = [...document.querySelectorAll('.st-reuse-lockid')].map((inp) => {
        const code = inp.dataset.entitycode;
        const radio = document.querySelector(`input[name="st-reuse-${CSS.escape(code)}"]:checked`);
        return radio?.value === 'reuse' ? { entity_code: code, source_lock_id: inp.value } : null;
      }).filter(Boolean);
      b.disabled = true; b.textContent = 'Applying…';
      try {
        const r = await api('POST', '/studio/projects/from-script/apply',
          { script_id: scriptId, draft, reuse_locks: reuseLocks });
        const skipped = r.overlays_skipped?.length ?? 0;
        toast(`Applied: ${r.shots_created?.length ?? 0} shot${r.shots_created?.length === 1 ? '' : 's'}, ` +
          `${r.overlays_created?.length ?? 0} overlay${r.overlays_created?.length === 1 ? '' : 's'} created` +
          (r.locks_reused?.length ? `, ${r.locks_reused.length} lock${r.locks_reused.length === 1 ? '' : 's'} reused` : '') +
          (skipped ? `, ${skipped} overlay${skipped === 1 ? '' : 's'} skipped (see events for why)` : ''),
          skipped ? 'warn' : false);
        location.hash = '#/studio-project/' + r.project.id;
      } finally {
        b.disabled = false; b.textContent = 'Apply draft';
      }
      return;
    }
  } catch (ex) { toast(ex.message, true); render(); }
});

// ---------- router ----------
async function render() {
  if (POLL) { clearInterval(POLL); POLL = null; }
  if (!TOKEN) {
    app.innerHTML = `<div id="login">
      <div class="mark">letena<b>.</b>os</div>
      <div class="am-tagline">የይዘት ፋብሪካ</div>
      <div class="sub" style="text-align:center">Content OS · internal team sign-in</div>
      <div class="card">
        <label>Email</label><input id="em" value="content@letena.local">
        <label>Password</label><input id="pw" type="password" value="letena-dev-2026">
        <div style="margin-top:14px"><button class="primary" id="go" style="width:100%">Sign in</button></div>
      </div></div>`;
    $('#go').onclick = async () => {
      try {
        const r = await api('POST', '/auth/login', { email: $('#em').value, password: $('#pw').value });
        TOKEN = r.token; ME = r.user;
        sessionStorage.setItem('lcos_token', TOKEN);
        sessionStorage.setItem('lcos_me', JSON.stringify(ME));
        location.hash = '#/dashboard'; render();
      } catch (ex) { toast(ex.message, true); }
    };
    return;
  }
  // Strip any ?query before routing. The Plan screen carries its week/month
  // choice in the hash (#/demand?month) so the view is linkable and survives
  // a refresh; without this split the route would read as "demand?month",
  // match no screen, and silently fall back to the dashboard.
  const [path] = (location.hash.replace(/^#\//, '') || 'dashboard').split('?');
  const [route, arg] = path.split('/');
  const fn = screens[route] ?? screens.dashboard;
  // A skeleton, not bare "Loading..." text: the skill's own loading-state
  // rule (progressive-loading) puts the threshold at 300ms, and every
  // screen here fetches on navigation, so silent pop-in was the norm.
  app.innerHTML = shell(route, `<div class="skelwrap">
    <div class="skel sk-h1"></div><div class="skel sk-sub"></div>
    <div class="tiles">${Array.from({ length: 4 }).map(() => '<div class="skel sk-tile"></div>').join('')}</div>
    <div class="card"><div class="skel sk-line" style="width:70%"></div><div class="skel sk-line" style="width:92%"></div><div class="skel sk-line" style="width:55%"></div></div>
  </div>`);
  try {
    const html = await fn(arg);
    app.innerHTML = shell(route, html);
  } catch (ex) {
    // role="alert" so screen readers announce the failure (ui-ux-pro-max,
    // Accessibility > Error Messages), a Retry action so there is a
    // recovery path (Feedback > Error Recovery), and a destructive-tinted
    // card so it reads as an error, not just another panel, matching the
    // "Error Empty State" / "AI Error Handler" shape from Magic MCP's
    // get_inspiration benchmarking. This is the one place every screen's
    // fetch failure lands, fixing it here fixes every screen at once.
    app.innerHTML = shell(route, `<div class="card errcard" role="alert">
      <div class="et">Something went wrong loading this screen</div>
      <div class="muted">${esc(ex.message)}</div>
      <button class="primary" data-retry="1">Retry</button>
    </div>`);
    $('[data-retry]')?.addEventListener('click', () => render());
  }
}
window.addEventListener('hashchange', render);

// SSO landing: the EMR hands over a session as #sso=<token>. Store it exactly
// the way login() does, swap the hash for the dashboard, load /auth/me, render.
async function boot() {
  if (location.hash.startsWith('#sso=')) {
    const value = location.hash.slice('#sso='.length);
    sessionStorage.setItem('lcos_token', value);
    TOKEN = value;
    location.hash = '#/dashboard';
    try {
      const r = await api('GET', '/auth/me');
      ME = r.user ?? r;
      sessionStorage.setItem('lcos_me', JSON.stringify(ME));
    } catch { /* bad token: the next API call routes back to sign-in */ }
  }
  render();
}
boot();
