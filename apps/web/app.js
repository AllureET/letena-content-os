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
const dt = (v) => v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const toast = (msg, err = false) => {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  setTimeout(() => t.className = '', err ? 5000 : 2600);
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
function logout() { sessionStorage.clear(); TOKEN = null; ME = null; render(); }

// ---------- navigation ----------
const NAV = [
  ['Overview', [['dashboard', 'Dashboard']]],
  ['Audience intelligence', [
    ['questions', 'Questions'], ['quarantine', 'Quarantine'],
    ['clusters', 'Question clusters'], ['coverage', 'Coverage gaps']]],
  ['Knowledge', [
    ['cards', 'Knowledge library'], ['claims', 'Medical claims'],
    ['sources', 'Medical sources'], ['terminology', 'Terminology'],
    ['gaps', 'Knowledge gaps']]],
  ['Content factory', [
    ['families', 'Content families'], ['concepts', 'Creative concepts'],
    ['scripts', 'Scripts'], ['reviews', 'Review queue']]],
  ['Production', [
    ['production', 'Production queue'], ['assets', 'Asset library']]],
  ['Distribution', [
    ['calendar', 'Publishing calendar'], ['published', 'Published content'],
    ['analytics', 'Analytics'], ['experiments', 'Experiments']]],
  ['System', [
    ['costs', 'Costs'], ['users', 'Users & roles'],
    ['settings', 'Settings'], ['audit', 'Audit log']]],
];

function shell(active, content) {
  return `<div id="shell">
    <div id="mtop"><button id="burger" aria-label="Open menu">&#9776;</button><span class="mark">letena<b>.</b>os</span></div>
    <div id="navveil"></div>
    <nav id="side">
      <div class="mark">letena<b>.</b>os</div>
      ${NAV.map(([grp, items]) => `<div class="grp">${grp}</div>` +
        items.map(([id, label]) =>
          `<a href="#/${id}" class="${active === id ? 'on' : ''}">${label}</a>`).join('')).join('')}
      <div class="grp">${esc(ME?.full_name ?? '')}</div>
      <a href="#" id="logout">Sign out</a>
    </nav>
    <main id="main">${content}</main>
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
        gapsHtml = `<div class="card"><div class="eyebrow">High demand, low coverage</div>
          <table><tr><th>Topic</th><th>Card</th><th>Questions 30d</th><th>Content 90d</th><th>State</th><th>Priority</th></tr>
          ${gaps.items.slice(0, 8).map(g => `<tr>
            <td>${esc(g.topic_name)}</td><td class="mono">${esc(g.card_code ?? '—')}</td>
            <td>${g.question_count_30d ?? 0}</td><td>${g.content_count_90d ?? 0}</td>
            <td>${pill(g.coverage_state)}</td><td><b>${Number(g.priority_score).toFixed(0)}</b></td></tr>`).join('')}
          </table></div>`;
      }
    } catch {}
    return `<h1>Today</h1><div class="sub">Operational picture across the whole pipeline</div>
      <div class="tiles">${tiles.map(([k, l, href, cls]) =>
        `<div class="tile ${cls ?? ''}" onclick="location.hash='${href.slice(1)}'">
          <div class="n">${d[k]}</div><div class="l">${l}</div></div>`).join('')}</div>
      ${gapsHtml}`;
  },

  async questions() {
    const r = await api('GET', '/questions?limit=50');
    return `<h1>Questions</h1><div class="sub">De-identified audience questions from every channel</div>
      <div class="card"><table>
      <tr><th>Question</th><th>Channel</th><th>Topic</th><th>Matched card</th><th>Status</th><th>Received</th><th></th></tr>
      ${r.items.map(i => `<tr>
        <td style="max-width:380px">${esc(i.sanitized_text)}</td>
        <td>${chan(i.channel)}</td>
        <td>${esc(i.topic_code ?? '—')}</td>
        <td class="mono">${esc(i.card_code ?? '—')}${i.match_confidence ? ` <span class="muted">${Math.round(i.match_confidence * 100)}%</span>` : ''}</td>
        <td>${pill(i.status)}</td><td class="muted">${dt(i.captured_at)}</td>
        <td>${can('question.turn_into_content') && i.status !== 'PURGED'
          ? `<button class="primary" data-tic="${i.id}">Turn into content</button>` : ''}</td>
      </tr>`).join('')}</table></div>`;
  },

  async quarantine() {
    const r = await api('GET', '/questions/quarantine');
    return `<h1>Quarantine</h1><div class="sub">De-identification was not confident. Redact what remains, then release. Reject purges the text.</div>
      ${r.items.length === 0 ? '<div class="card muted">Quarantine is empty. That is the expected state.</div>' : ''}
      ${r.items.map(i => `<div class="card">
        <div class="flex"><span class="muted mono">${dt(i.captured_at)}</span>${chan(i.channel)}
          <span class="muted">confidence ${Number(i.deid_confidence).toFixed(2)}</span></div>
        <label>Edit to remove anything identifying</label>
        <textarea id="rq-${i.id}">${esc(i.sanitized_text)}</textarea>
        <div class="flex" style="margin-top:8px">
          <button class="approve" data-redact="${i.id}">Release</button>
          <button class="danger" data-purge="${i.id}">Reject and purge</button>
        </div></div>`).join('')}`;
  },

  async clusters() {
    const r = await api('GET', '/clusters');
    return `<h1>Question clusters</h1><div class="sub">Semantically similar questions, kept apart when answers differ</div>
      <div class="card"><table>
      <tr><th>Cluster</th><th>Representative question</th><th>Topic</th><th>Card</th><th>Members</th><th>Last seen</th></tr>
      ${r.items.map(i => `<tr><td class="mono">${esc(i.code)}</td>
        <td style="max-width:360px">${esc(i.representative_question)}</td>
        <td>${esc(i.topic_code ?? '—')}</td><td class="mono">${esc(i.card_code ?? '—')}</td>
        <td><b>${i.member_count}</b></td><td class="muted">${dt(i.last_seen_at)}</td></tr>`).join('')}
      </table></div>`;
  },

  async coverage() {
    let items = [];
    try { items = (await api('GET', '/demand/coverage-gaps')).items; } catch {}
    return `<h1>Coverage gaps</h1>
      <div class="sub">What Ethiopia is asking against what Letena has published. This board sets the calendar.</div>
      <div class="flex" style="margin-bottom:10px">
        ${can('settings.manage') ? '<button id="recompute">Recompute now</button>' : ''}</div>
      <div class="card"><table>
      <tr><th>Topic</th><th>Card</th><th>Question</th><th>Questions 30d</th><th>Content 90d</th><th>State</th><th>Priority</th></tr>
      ${items.map(g => `<tr><td>${esc(g.topic_name)}</td><td class="mono">${esc(g.card_code ?? '—')}</td>
        <td style="max-width:300px">${esc(g.canonical_question_en ?? '—')}</td>
        <td>${g.question_count_30d ?? 0}</td><td>${g.content_count_90d ?? 0}</td>
        <td>${pill(g.coverage_state)}</td><td><b>${Number(g.priority_score).toFixed(0)}</b></td></tr>`).join('')
      || '<tr><td colspan=7 class="muted">No gap rows yet. Ingest questions and recompute.</td></tr>'}
      </table></div>`;
  },

  async cards() {
    const r = await api('GET', '/knowledge/cards');
    return `<h1>Knowledge library</h1><div class="sub">Approved medical answers, versioned and expiring</div>
      <div class="card"><table>
      <tr><th>Code</th><th>Question</th><th>Topic</th><th>Tier</th><th>Claims</th><th>Status</th><th>Review due</th></tr>
      ${r.items.map(c => `<tr class="rowlink" data-nav="card/${c.id}">
        <td class="mono"><b>${esc(c.code)}</b></td>
        <td style="max-width:340px">${esc(c.canonical_question_en)}</td>
        <td>${esc(c.topic_code)}</td><td>${pill(c.risk_tier)}</td>
        <td>${c.claim_count}</td><td>${pill(c.status)}</td>
        <td class="muted">${c.review_due_at ? esc(c.review_due_at.slice(0, 10)) : '—'}</td></tr>`).join('')}
      </table></div>`;
  },

  async card(id) {
    const c = await api('GET', `/knowledge/cards/${id}`);
    const claimHtml = c.claims.map(cl => {
      const src = c.sources.filter(s => s.claim_id === cl.id);
      return `<div class="claimrow">
        <div class="flex"><span class="mono"><b>${esc(cl.code)}</b></span>${pill(cl.status)}
          ${cl.is_core ? '<span class="pill p-VALIDATED"><span class="d"></span>core</span>' : ''}</div>
        <div style="margin:4px 0">${esc(cl.claim_text_en)}</div>
        <div class="muted" style="font-size:11.5px">${src.map(s =>
          `${esc(s.organisation)} · ${esc(s.title)}${s.locator ? ' · ' + esc(s.locator) : ''}`).join('<br>')}</div>
      </div>`;
    }).join('');
    const v = c.version;
    return `<div class="eyebrow">Knowledge card</div>
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
      <div class="flex">
        ${c.status === 'DRAFT' && can('knowledge.submit') ? `<button class="primary" data-cardtx="${c.id}|IN_REVIEW">Submit for clinical review</button>` : ''}
        ${c.status === 'IN_REVIEW' && can('knowledge.approve') ? `<button class="approve" data-cardapprove="${c.id}">Approve (6 month review)</button>` : ''}
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
        <td>${esc(s.organisation)}</td><td style="max-width:300px">${esc(s.title)}</td>
        <td class="muted" style="font-size:11px">${esc(s.source_type)}</td><td>${pill(s.status)}</td></tr>`).join('')}
      </table></div>`;
  },

  async gaps() {
    const r = await api('GET', '/knowledge/needs-knowledge');
    return `<h1>Knowledge gaps</h1>
      <div class="sub">Scripts stopped because a required fact has no approved claim. Each row is real demand the clinical team can answer.</div>
      <div class="card"><table><tr><th>Script</th><th>Card</th><th>Missing knowledge</th><th>When</th></tr>
      ${r.items.map(i => `<tr><td class="mono">${esc(i.code)}</td><td class="mono">${esc(i.card_code)}</td>
        <td style="max-width:420px" class="mono">${esc(JSON.stringify(i.needs_knowledge_note)?.slice(0, 220) ?? '')}</td>
        <td class="muted">${dt(i.created_at)}</td></tr>`).join('')
      || '<tr><td colspan=4 class="muted">No open knowledge gaps.</td></tr>'}</table></div>`;
  },

  async families() {
    const r = await api('GET', '/content/families');
    return `<h1>Content families</h1><div class="sub">One educational idea, all its derivatives</div>
      <div class="card"><table><tr><th>Code</th><th>Title</th><th>Card</th><th>Segment</th><th>Tier</th><th>Origin</th><th>Created</th></tr>
      ${r.items.map(f => `<tr><td class="mono">${esc(f.code)}</td><td style="max-width:280px">${esc(f.title)}</td>
        <td class="mono">${esc(f.card_code)}</td><td class="muted">${esc(f.segment_slug)}</td>
        <td>${pill(f.risk_tier)}</td><td class="muted">${esc(f.origin)}</td><td class="muted">${dt(f.created_at)}</td></tr>`).join('')}
      </table></div>`;
  },

  async concepts() {
    const r = await api('GET', '/content/concepts');
    return `<h1>Creative concepts</h1><div class="sub">Distinct treatments of approved knowledge. Selection is the cheap place for editorial judgement.</div>
      ${r.items.map(c => `<div class="card">
        <div class="flex"><b>${esc(c.title)}</b>${pill(c.status)}<span class="muted">${esc(c.video_family)}</span>
          <span class="spacer"></span>
          ${c.status === 'PROPOSED' && can('concept.select') ? `<button class="approve" data-select="${c.id}">Select</button>` : ''}</div>
        <div style="margin:6px 0"><b>Hook:</b> ${esc(c.hook_line)}</div>
        <div class="muted">${esc(c.premise)}</div>
        <div class="muted" style="font-size:12px;margin-top:6px">Why it works: ${esc(c.why_this_works ?? '')}</div>
      </div>`).join('') || '<div class="card muted">No concepts yet. Use Turn Into Content from Questions.</div>'}`;
  },

  async scripts() {
    const r = await api('GET', '/content/scripts');
    return `<h1>Scripts</h1><div class="sub">Every medical sentence maps to an approved claim, or the script does not move</div>
      <div class="card"><table><tr><th>Code</th><th>Family</th><th>Card</th><th>Lang</th><th>Tier</th><th>Validation</th><th>Status</th><th></th></tr>
      ${r.items.map(s => `<tr class="rowlink" data-nav="script/${s.id}">
        <td class="mono">${esc(s.code)}</td><td class="mono muted">${esc(s.family_code)}</td>
        <td class="mono">${esc(s.card_code)}</td><td>${esc(s.language)}</td>
        <td>${pill(s.risk_tier)}</td><td>${pill(s.validation_result === 'PASS' ? 'PASS' : s.validation_result === 'FAIL' ? 'FAIL' : null) || '<span class="muted">—</span>'}</td>
        <td>${pill(s.status)}</td>
        <td>${s.status === 'APPROVED' && can('production.request') ? `<button data-produce="${s.id}">Produce</button>` : ''}</td>
      </tr>`).join('')}</table></div>`;
  },

  async script(id) {
    const s = await api('GET', `/content/scripts/${id}`);
    const v = s.version;
    return `<div class="eyebrow">Script review</div>
      <h1 class="mono">${esc(s.code)}</h1>
      <div class="sub flex">${pill(s.status)} ${pill(s.risk_tier)}
        ${pill(s.validation_result === 'PASS' ? 'PASS' : s.validation_result === 'FAIL' ? 'FAIL' : null)}
        <span class="muted">${esc(s.language)} · v${s.current_version}</span></div>
      <div class="grid2">
        <div class="card"><div class="eyebrow">Script</div>
          <div class="kv"><b>Hook:</b> ${esc(v?.hook)}<br><br><b>Spoken:</b><br>${esc(v?.spoken_script)}
          <br><br><b>CTA:</b> ${esc(v?.cta)}</div></div>
        <div class="card"><div class="eyebrow">Amharic ${s.translation ? `· drift ${Number(s.translation.drift_score).toFixed(3)}` : ''}</div>
          ${s.translation ? `<div class="amharic">${esc(s.translation.translated_text)}</div>
            <div class="eyebrow" style="margin-top:12px">Blind back-translation</div>
            <div class="muted">${esc(s.translation.back_translation)}</div>`
          : '<span class="muted">No Amharic version yet.</span>'}</div>
      </div>
      <div class="card"><div class="eyebrow">Claim map — every medical statement and its authority</div>
        ${s.claim_map.map(m => `<div class="claimrow ${['UNSUPPORTED','CONTRADICTED','AMBIGUOUS'].includes(m.verdict) ? 'bad' : ''}">
          <div>${esc(m.statement)}</div>
          <div class="flex" style="margin-top:4px"><span class="mono muted">${esc(m.claim_code)}</span>
            ${m.verdict ? pill(m.verdict === 'SUPPORTED' ? 'PASS' : m.verdict === 'PARTIALLY_SUPPORTED' ? 'IN_REVIEW' : 'FAIL') : ''}
            <span class="muted" style="font-size:11.5px">${esc(m.claim_text_en)}</span></div>
        </div>`).join('')}</div>
      ${s.findings.length ? `<div class="card"><div class="eyebrow">Findings</div>
        ${s.findings.map(f => `<div class="claimrow bad"><b>${esc(f.code)}</b> · ${esc(f.severity)}<br>
          ${esc(f.explanation)}${f.suggested_fix ? `<br><span class="muted">Fix: ${esc(f.suggested_fix)}</span>` : ''}</div>`).join('')}</div>` : ''}
      <div class="flex">
        ${s.status === 'CLINICAL_REVIEW' && (can('script.approve_clinical')) ?
          `<button class="approve" data-scripttx="${s.id}|APPROVED">Approve clinically</button>
           <button data-scripttx-reason="${s.id}|DRAFT">Request changes</button>
           <button class="danger" data-scripttx-reason="${s.id}|REJECTED">Reject</button>` : ''}
        ${s.translation && ['LANGUAGE_REVIEW','CLINICAL_REVIEW','VALIDATED'].includes(s.status) && can('script.approve_language') ?
          `<button class="approve" data-langreview="${s.id}|APPROVED">Language: approve</button>
           <button data-langreview-edit="${s.id}">Language: approve with edits</button>
           <button data-langreview-reason="${s.id}|CHANGES_REQUESTED">Language: request changes</button>` : ''}
        ${s.status === 'LANGUAGE_REVIEW' && can('script.approve_language') ?
          `<button data-scripttx="${s.id}|${['TIER_3','TIER_4'].includes(s.risk_tier) ? 'CLINICAL_REVIEW' : 'APPROVED'}">Advance state</button>` : ''}
        ${s.status === 'VALIDATION_FAILED' && can('script.write') ?
          `<button data-scripttx="${s.id}|DRAFT">Back to draft</button>` : ''}
        ${s.status === 'APPROVED' && can('production.request') ? `<button class="primary" data-produce="${s.id}">Send to production</button>` : ''}
      </div>`;
  },

  async reviews() {
    const r = await api('GET', '/reviews/queue');
    return `<h1>Review queue</h1><div class="sub">Everything waiting on a human, oldest and most urgent first</div>
      <div class="card"><table><tr><th>Type</th><th>Object</th><th>Tier</th><th>Due</th><th>Status</th><th></th></tr>
      ${r.items.map(t => `<tr>
        <td>${esc(t.review_type)}</td>
        <td class="mono">${t.object_type === 'SCRIPT' ? `<a href="#/script/${t.object_id}">${esc(t.object_type)} →</a>` : esc(t.object_type)}</td>
        <td>${pill(t.risk_tier)}</td><td class="muted">${dt(t.due_at)}</td><td>${pill(t.status)}</td>
        <td class="muted" style="font-size:11px">${esc(t.required_role ?? '')}</td></tr>`).join('')
      || '<tr><td colspan=6 class="muted">Queue is clear.</td></tr>'}</table></div>`;
  },

  async production() {
    const r = await api('GET', '/production/jobs');
    return `<h1>Production queue</h1><div class="sub">Approved scripts becoming finished media</div>
      <div class="card"><table><tr><th>Job</th><th>Script</th><th>Engine</th><th>Template</th><th>Voice</th><th>Status</th><th></th></tr>
      ${r.items.map(j => `<tr><td class="mono">${esc(j.code)}</td><td class="mono">${esc(j.script_code)}</td>
        <td>${esc(j.engine)}</td><td class="mono muted">${esc(j.template_code ?? '—')}</td>
        <td class="muted">${esc(j.voice_source)}</td><td>${pill(j.status)}</td>
        <td>${j.status === 'QUEUED' && can('production.request') ? `<button class="primary" data-run="${j.id}">Run</button>` : ''}</td>
      </tr>`).join('') || '<tr><td colspan=7 class="muted">Nothing in production.</td></tr>'}</table></div>`;
  },

  async assets() {
    const r = await api('GET', '/production/assets');
    return `<h1>Asset library</h1><div class="sub">Real Ethiopia first. Generated assets are flagged and inactive until reviewed; medical illustration is never generated.</div>
      ${can('asset.manage') ? `<div class="grid2">
        <div class="card"><div class="eyebrow">Semantic search</div>
          <input id="a-search" placeholder="e.g. addis evening street calm phone">
          <div style="margin-top:8px"><button id="a-go">Search</button></div>
          <div id="a-results"></div></div>
        <div class="card"><div class="eyebrow">Generate b-roll (Gemini image / Kling video)</div>
          <label>Brief</label><input id="a-brief" placeholder="young woman reading her phone in a shared taxi, dusk">
          <label>Kind</label><select id="a-kind"><option value="IMAGE_PHOTO">Image (Gemini)</option>
            <option value="VIDEO">Video (Kling)</option></select>
          <div style="margin-top:8px"><button class="primary" id="a-gen">Generate → producer review</button></div>
        </div></div>` : ''}
      <div class="card"><table><tr><th>Code</th><th>Title</th><th>Kind</th><th>Origin</th><th>AI</th><th>Clinical</th></tr>
      ${r.items.map(a => `<tr><td class="mono">${esc(a.code)}</td><td>${esc(a.title)}</td>
        <td class="muted">${esc(a.kind)}</td><td class="muted">${esc(a.origin)}</td>
        <td>${a.is_ai_generated ? pill('IN_REVIEW') : ''}</td>
        <td>${a.clinically_approved ? pill('APPROVED') : ''}</td></tr>`).join('')
      || '<tr><td colspan=6 class="muted">Library is empty. Shoot the first B-roll batch.</td></tr>'}</table></div>`;
  },

  async published() {
    const r = await api('GET', '/distribution/published');
    return `<h1>Published content</h1><div class="sub">Everything live, traceable to its card, claims and reviewer</div>
      <div class="card"><table><tr><th>Platform</th><th>Family</th><th>Card</th><th>Lang</th><th>Format</th><th>Published</th><th>Link</th></tr>
      ${r.items.map(p => `<tr><td>${chan(p.platform)}</td><td class="mono">${esc(p.family_code)}</td>
        <td class="mono">${esc(p.card_code)}</td><td>${esc(p.language)}</td>
        <td class="muted" style="font-size:11px">${esc(p.video_family)}</td>
        <td class="muted">${dt(p.published_at)}</td>
        <td><a href="${esc(p.platform_url)}" target="_blank">open</a></td></tr>`).join('')
      || '<tr><td colspan=7 class="muted">Nothing published yet.</td></tr>'}</table></div>`;
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
      || '<tr><td colspan=9 class="muted">No published content with metrics yet.</td></tr>'}</table></div>`;
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
      || '<tr><td colspan=6 class="muted">No terms yet. Seed from the last year of scripts.</td></tr>'}
      </table></div>`;
  },

  async calendar() {
    const r = await api('GET', '/distribution/calendar');
    return `<h1>Publishing calendar</h1><div class="sub">Scheduled next three weeks, published last seven days</div>
      <div class="card"><div class="eyebrow">Scheduled</div><table>
      <tr><th>When</th><th>Platform</th><th>Family</th><th>Card</th><th>Lang</th><th>Tier</th><th>Status</th></tr>
      ${r.scheduled.map(j => `<tr><td>${dt(j.scheduled_for)}</td><td>${chan(j.platform)}</td>
        <td class="mono">${esc(j.family_code)}</td><td class="mono">${esc(j.card_code)}</td>
        <td>${esc(j.language)}</td><td>${pill(j.risk_tier)}</td><td>${pill(j.status)}</td></tr>`).join('')
      || '<tr><td colspan=7 class="muted">Nothing scheduled.</td></tr>'}</table></div>
      <div class="card"><div class="eyebrow">Recently published</div><table>
      <tr><th>When</th><th>Platform</th><th>Family</th><th>Card</th><th>Link</th></tr>
      ${r.published.map(p => `<tr><td>${dt(p.published_at)}</td><td>${chan(p.platform)}</td>
        <td class="mono">${esc(p.family_code)}</td><td class="mono">${esc(p.card_code)}</td>
        <td><a href="${esc(p.platform_url)}" target="_blank">open</a></td></tr>`).join('')
      || '<tr><td colspan=5 class="muted">Nothing yet.</td></tr>'}</table></div>`;
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
      || '<tr><td colspan=6 class="muted">No experiments yet. The pilot plan names four.</td></tr>'}
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
        || '<tr><td colspan=6 class="muted">Nothing published yet.</td></tr>'}</table></div>`;
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
    return `<h1>Settings</h1><div class="sub">Thresholds and weights the team can argue with, without a deploy</div>
      <div class="card"><table><tr><th>Key</th><th>Value</th><th>Description</th></tr>
      ${r.items.map(s => `<tr><td class="mono">${esc(s.key)}</td>
        <td class="mono" style="max-width:260px">${esc(JSON.stringify(s.value))}</td>
        <td class="muted">${esc(s.description ?? '')}</td></tr>`).join('')}</table></div>`;
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
};

// ---------- actions ----------
// Mobile drawer: the burger toggles the sidebar, the veil or any nav link closes it.
document.addEventListener('click', (e) => {
  if (e.target.closest('#burger')) { document.body.classList.toggle('nav-open'); return; }
  if (e.target.closest('#navveil') || e.target.closest('#side a')) {
    document.body.classList.remove('nav-open');
  }
});
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-tic],[data-redact],[data-purge],[data-select],[data-produce],[data-run],[data-cardtx],[data-cardapprove],[data-cardretire],[data-scripttx],[data-scripttx-reason],[data-termapprove],[data-langreview],[data-langreview-edit],[data-langreview-reason],#t-save,#a-go,#a-gen,#u-create,[data-deactivate],#recompute,#logout');
  if (!b) {
    const row = e.target.closest('tr[data-nav]');
    if (row) location.hash = '#/' + row.dataset.nav;
    return;
  }
  e.preventDefault();
  try {
    if (b.id === 'logout') return logout();
    if (b.id === 'recompute') { await api('POST', '/demand/recompute'); toast('Demand board recomputed'); return render(); }
    if (b.dataset.tic) {
      b.disabled = true; b.textContent = 'Working…';
      const r = await api('POST', '/content/turn-into-content', { question_id: b.dataset.tic });
      if (r.knowledge_gap) toast('No approved knowledge yet — the clinical team has been asked.', true);
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
      $('#a-results').innerHTML = r.items.map(a =>
        `<div class="claimrow"><span class="mono">${esc(a.code)}</span> ${esc(a.title)}
         <span class="muted">${Math.round((a.similarity ?? 0) * 100)}%</span></div>`).join('')
        || '<div class="muted" style="margin-top:8px">No matches.</div>';
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

// ---------- router ----------
async function render() {
  if (!TOKEN) {
    app.innerHTML = `<div id="login">
      <div class="mark">letena<b>.</b>os</div>
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
  const [route, arg] = (location.hash.replace(/^#\//, '') || 'dashboard').split('/');
  const fn = screens[route] ?? screens.dashboard;
  app.innerHTML = shell(route, '<div class="muted">Loading…</div>');
  try {
    const html = await fn(arg);
    app.innerHTML = shell(route, html);
  } catch (ex) {
    app.innerHTML = shell(route, `<div class="card">${esc(ex.message)}</div>`);
  }
}
window.addEventListener('hashchange', render);
render();
