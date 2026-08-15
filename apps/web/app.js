// Letena Content OS admin UI. No build step: vanilla ES modules, hash routing,
// EMR design language. Served by the API process.
const API = '/api/v1';
let TOKEN = sessionStorage.getItem('lcos_token');
let ME = JSON.parse(sessionStorage.getItem('lcos_me') || 'null');

const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
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
  if (mt.startsWith('image/')) return `<img class="ath" src="${esc(u)}" alt="${esc(a.title)}" loading="lazy" onerror="assetImgError(this,'${esc(a.kind)}')">`;
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
const SECTIONS = [
  ['today',      'Today',      [['dashboard', 'Today'], ['board', 'Board']]],
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
  publishing: '<path d="M17 3 2 9.5l6 2 2 6z"/><path d="M17 3 10 11.5"/>',
  insights: '<path d="M3 17V3M3 17h14"/><path d="M6 14V9M10 14V6M14 14v-3"/>',
  admin: '<circle cx="10" cy="10" r="2.5"/><path d="M10 3v2M10 15v2M17 10h-2M5 10H3M15.1 4.9l-1.4 1.4M6.3 13.7l-1.4 1.4M15.1 15.1l-1.4-1.4M6.3 6.3 4.9 4.9"/>',
};
const NAV_GROUPS = [
  ['Work', ['today', 'plan']],
  ['Pipeline', ['questions', 'knowledge', 'content', 'production', 'publishing']],
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

// ---------- screens ----------
const screens = {
  async dashboard() {
    const d = await api('GET', '/platform/dashboard');
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
    return `<h1>Today</h1><div class="sub">Operational picture across the whole pipeline</div>
      <div class="tiles">${tiles.map(([k, l, href, cls]) =>
        `<div class="tile ${cls ?? ''}" role="link" tabindex="0" onclick="location.hash='${href.slice(1)}'">
          <div class="n">${d[k]}</div><div class="l">${l}</div></div>`).join('')}</div>
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
        <select id="classify-limit" style="width:110px">
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
                    ${esc(ot.label)} <span class="muted">${esc(ot.platform ?? '')}</span></label>`).join('')}
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
          ${outputTypes.map(t => `<label style="display:flex;align-items:center;gap:6px;font-weight:400;margin:0;width:auto">
            <input type="checkbox" value="${esc(t.code)}" class="gen-ot" style="width:auto">
            ${esc(t.label)}${t.platform ? ` <span class="muted">(${esc(t.platform)})</span>` : ''}</label>`).join('')
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
          <div class="kv"><b>Prohibited claims</b><br>${(v?.prohibited_claims ?? []).map(esc).join('<br>') || '<span class="muted">none recorded</span>'}
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
      <div class="card"><table>
      <tr><th>Code</th><th>Claim</th><th>Topic</th><th>Type</th><th>Certainty</th><th>Status</th></tr>
      ${r.items.map(c => `<tr><td class="mono"><b>${esc(c.code)}</b></td>
        <td style="max-width:420px">${esc(c.claim_text_en)}</td>
        <td>${esc(c.topic_code)}</td><td class="muted">${esc(c.claim_type)}</td>
        <td class="muted">${esc(c.certainty)}</td><td>${pill(c.status)}</td></tr>`).join('')}
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
    return `<h1>Knowledge gaps</h1>
      <div class="sub">Scripts stopped because a required fact has no approved claim. Each row is real demand the clinical team can answer.</div>
      <div class="card"><table><tr><th>Script</th><th>Card</th><th>Missing knowledge</th><th>When</th></tr>
      ${r.items.map(i => `<tr class="rowlink" data-nav="script/${esc(i.id)}" tabindex="0">
        <td class="mono">${esc(i.code)}</td><td class="mono">${esc(i.card_code)}</td>
        <td style="max-width:420px" class="mono">${esc(JSON.stringify(i.needs_knowledge_note)?.slice(0, 220) ?? '')}</td>
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
    if (familyId) {
      try { family = (await api('GET', '/content/families')).items.find(f => f.id === familyId); } catch {}
    }
    return `${familyId ? '<a class="backlink" href="#/families">&larr; Content families</a>' : ''}
      <h1>Creative concepts</h1>
      <div class="sub">${family ? `Filtered to ${esc(family.code)} · ${esc(family.title)}` : 'Distinct treatments of approved knowledge. Selection is the cheap place for editorial judgement.'}</div>
      ${r.items.map(c => `<div class="card">
        <div class="flex"><b>${esc(c.title)}</b>${pill(c.status)}<span class="muted">${esc(c.video_family)}</span>
          <span class="spacer"></span>
          ${c.status === 'PROPOSED' && can('concept.select') ? `<button class="approve" data-select="${c.id}">Select</button>` : ''}</div>
        <div style="margin:6px 0"><b>Hook:</b> ${esc(c.hook_line)}</div>
        <div class="muted">${esc(c.premise)}</div>
        <div class="muted" style="font-size:12px;margin-top:6px">Why it works: ${esc(c.why_this_works ?? '')}</div>
      </div>`).join('') || `<div class="card empty">${familyId ? 'No concepts recorded for this family.' : 'No concepts yet. Use Turn into content from the Questions screen to start one.'}</div>`}`;
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
        <td>${s.status === 'APPROVED' && can('production.request') ? `<button data-produce="${s.id}">Produce</button>` : ''}</td>
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
        ${inp('ed-hook', v.hook, 'Hook')}
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
        ${s.status === 'VALIDATION_FAILED' && can('script.write') ?
          `<button data-scripttx="${s.id}|DRAFT">Back to draft</button>` : ''}
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
        ${P.length && can('production.request') ? `<button class="primary" data-produceall="1">Produce all ${P.length}</button>` : ''}</div>
      <table><tr><th>Script</th><th>Lang</th><th>Tier</th><th>Family</th><th></th></tr>
      ${P.map(s => `<tr class="rowlink" data-nav="script/${s.id}" tabindex="0"><td class="mono">${esc(s.code)}</td><td>${esc(s.language)}</td>
        <td>${pill(s.risk_tier)}</td><td class="mono muted">${esc(s.family_code)}</td>
        <td>${can('production.request') ? `<button data-produce="${s.id}">Produce</button>` : ''}</td></tr>`).join('')
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
    const r = await api('GET', '/platform/users');
    const roles = ['medical_director','consulting_doctor','content_lead','language_editor',
      'intake_coordinator','social_lead','producer','developer','viewer','admin'];
    return `<h1>Users & roles</h1><div class="sub">One account per person, real emails, no shared logins. Approval rights follow roles.</div>
      <div class="card"><div class="eyebrow">Add user</div>
        <div class="grid2">
          <div><label>Email</label><input id="u-email">
            <label>Full name</label><input id="u-name"></div>
          <div><label>Temporary password (12+ chars)</label><input id="u-pw">
            <label>Role</label><select id="u-role">${roles.map(x => `<option>${x}</option>`).join('')}</select></div>
        </div>
        <div style="margin-top:10px"><button class="primary" id="u-create">Create user</button></div></div>
      <div class="card"><table>
        <tr><th>Name</th><th>Email</th><th>Roles</th><th>2FA</th><th>Last login</th><th>Status</th><th></th></tr>
        ${r.items.map(u => `<tr><td>${esc(u.full_name)}</td><td class="mono">${esc(u.email)}</td>
          <td>${(u.roles ?? []).map(x => `<span class="pill p-DRAFT"><span class="d"></span>${esc(x)}</span>`).join(' ')}</td>
          <td>${u.totp_enabled ? pill('APPROVED') : '<span class="muted">off</span>'}</td>
          <td class="muted">${dt(u.last_login_at)}</td>
          <td>${u.is_active ? pill('ACTIVE') : pill('RETIRED')}</td>
          <td>${u.is_active ? `<button class="danger" data-deactivate="${u.id}">Deactivate</button>` : ''}</td>
        </tr>`).join('')}</table></div>`;
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
      credsHtml = `<h1 style="margin-top:26px">API keys and providers</h1>
        <div class="sub">Enter and save credentials here, exactly like the EMR integration credentials page. Values are never shown again once saved; leave a field blank to keep what is stored. Saving an empty value clears the saved entry and falls back to the server environment.</div>
        ${groups.map(g => `<div class="card"><div class="eyebrow">${esc(g)}</div><table>
          ${c.items.filter(i => i.group === g).map(i => `<tr>
            <td style="width:220px"><b>${esc(i.label)}</b><div class="muted" style="font-size:11px">${esc(i.hint ?? '')}</div></td>
            <td style="width:130px">${badge(i.status)}</td>
            <td><input type="${i.secret ? 'password' : 'text'}" id="cred-${esc(i.key)}"
              placeholder="${i.status === 'unset' ? 'enter value' : 'enter new value to replace'}" autocomplete="off"></td>
            <td style="width:90px"><button class="primary" data-credsave="${esc(i.key)}">Save</button></td>
          </tr>`).join('')}</table></div>`).join('')}`;
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
    // Raw settings dump is reference-only, nothing on this table is clicked
    // or edited day to day, so it sits last, after every screen someone
    // actually acts on (override, publishing mode, tone, API keys).
    const rawTableHtml = `<h1 style="margin-top:26px">All settings (raw)</h1>
      <div class="sub">Every key/value this instance holds, for reference. Thresholds and weights the team can argue with, without a deploy.</div>
      <div class="card"><table><tr><th>Key</th><th>Value</th><th>Description</th></tr>
      ${r.items.map(s => `<tr><td class="mono">${esc(s.key)}</td>
        <td class="mono" style="max-width:260px;overflow-wrap:anywhere">${esc(JSON.stringify(s.value))}</td>
        <td class="muted">${esc(s.description ?? '')}</td></tr>`).join('')}</table></div>`;
    return `<h1>Settings</h1><div class="sub">What the team can actually change, without a deploy</div>
      ${overrideHtml}
      ${clinicalHtml}
      ${pmHtml}
      ${toneHtml}
      ${credsHtml}
      ${specsHtml}
      ${rawTableHtml}`;
  },

  async audit() {
    const r = await api('GET', '/platform/audit');
    return `<h1>Audit log</h1><div class="sub">Append-only. Every state change, forever.</div>
      <div class="card"><table><tr><th>When</th><th>Actor</th><th>Action</th><th>Object</th><th>Transition</th><th>Reason</th></tr>
      ${r.items.map(a => `<tr><td class="muted">${dt(a.occurred_at)}</td>
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
  async board() {
    const b = await api('GET', '/pipeline/board');
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
    return `<h1>Board</h1>
      <div class="sub">Everything in flight. ${blockedCount ? `<b>${blockedCount} piece${blockedCount === 1 ? ' is' : 's are'} waiting on someone</b>, shown first in each column.` : 'Nothing is blocked right now.'} Click a card to open the piece.</div>
      <div class="board">${cols || '<div class="card empty">Nothing in flight. Start on the Make screen.</div>'}</div>`;
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
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('tr[data-nav],.bitem[data-nav]')) {
    e.preventDefault(); location.hash = '#/' + e.target.dataset.nav;
  }
  if (e.key === 'Escape') document.body.classList.remove('nav-open');
});
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-amtoggle],[data-tic],[data-redact],[data-purge],[data-select],[data-produce],[data-run],[data-cardtx],[data-cardapprove],[data-cardretire],[data-scripttx],[data-scripttx-reason],[data-scriptvalidate],[data-scriptlocalize],[data-termapprove],[data-langreview],[data-langreview-edit],[data-langreview-reason],#t-save,#a-go,#a-gen,#u-create,[data-deactivate],#recompute,#logout,[data-credsave],[data-batchapprove],[data-produceall],[data-copycap],[data-pubnow],#pm-save,[data-cardfullapprove],[data-cardapproveall],[data-cardgenerate],[data-plangenerate],#override-save,#clinical-save,#tone-save,#classify-pending,#bulk-commission,#cleanup-requeue');
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
    const row = e.target.closest('tr[data-nav],.bitem[data-nav]');
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
      let done = 0, failed = 0;
      for (const s of qd.to_produce) {
        b.textContent = `Producing ${done + failed + 1}/${qd.to_produce.length}…`;
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
  if (t.id === 'mk-card') { MAKE.cardId = t.value; return render(); }
  if (t.name === 'mk-aud') { MAKE.audience = t.value; return render(); }
  if (t.name === 'mk-path') { MAKE.path = t.value; return render(); }
  if (t.dataset?.mkfmt) {
    if (t.checked) MAKE.formats.add(t.dataset.mkfmt); else MAKE.formats.delete(t.dataset.mkfmt);
    return render();
  }
  if (t.id === 'mk-transcript') { MAKE.transcriptId = t.value; }
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
    app.innerHTML = shell(route, `<div class="card">${esc(ex.message)}</div>`);
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
