(() => {
  'use strict';
  const { ext } = GST;
  const $ = (s, el = document) => el.querySelector(s);
  const COLS = 64;

  const S = {
    tabId: null, page: null, settings: GST.mergeSettings(null), hasKey: false, keysList: [],
    job: null, cues: null, tr: null, jobKey: null, port: null,
    strip: null, open: new Set(), filter: 'all', busyAction: false, keysState: {}, tab: 'home',
    plateText: '', playMs: 0, confirmRestart: 0,
  };
  const qs = new URLSearchParams(location.search);
  const FULL = qs.get('full') === '1';

  /* ================================================================ helpers */
  const nBlocks = () => (S.job ? Math.ceil(S.job.total / S.job.blockSize) : 0);
  const blockRange = (b) => [b * S.job.blockSize, Math.min(S.job.total, (b + 1) * S.job.blockSize)];
  async function sendTab(type, data) {
    if (S.tabId == null) return null;
    try { return await ext.tabs.sendMessage(S.tabId, Object.assign({ type }, data || {})); } catch (e) { return null; }
  }
  let toastT = 0;
  function toast(msg, ms = 2200) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms);
  }
  const pctOf = () => (S.job && S.job.total ? Math.round(S.job.doneLines / S.job.total * 100) : 0);
  const failedCount = () => (S.job ? S.job.blocks.split('').filter((c) => c === 'e').length : 0);
  const rtl = () => !!(S.job ? S.job.target.rtl : S.page && S.page.target && S.page.target.rtl);

  /* ================================================================ state -> view */
  function deriveKind() {
    const p = S.page, j = S.job;
    if (!p) return 'novideo';
    if (j) {
      const st = j.status;
      if (j.waiting && st === 'running') return 'waiting';
      if (st === 'running') return 'running';
      if (st === 'paused') return j.error ? 'stopped' : 'paused';
      if (st === 'partial') return 'partial';
      if (st === 'done') return 'done';
      return S.hasKey ? 'ready' : 'nokey';
    }
    if (!p.sources.length) return p.hasVideo ? 'nocaptions' : 'novideo';
    return S.hasKey ? 'ready' : 'nokey';
  }

  function copyFor(kind) {
    const p = S.page, j = S.job;
    const src = p && p.sources.find((s) => s.id === p.activeSourceId);
    const n = (x) => x.toLocaleString();
    switch (kind) {
      case 'loading': return ['One moment', ''];
      case 'novideo': return ['No video here', 'Open a page with a video, then click the TAS icon again.'];
      case 'nocaptions': return p.isYT
        ? ['Turn on captions', 'TAS reads the captions YouTube loads for the player. It can switch them on for you.']
        : ['Waiting for subtitles', 'Play the video with subtitles on. TAS picks up whatever the page loads, or scan the page now.'];
      case 'nokey': return ['Add a Gemini key', 'One API key from Google AI Studio is all TAS needs to translate.'];
      case 'ready': return ['Ready to translate', j ? `${n(j.total)} lines, ${nBlocks()} blocks of ${j.blockSize}.` : (src ? `${n(src.count)} lines from ${src.label}.` : '')];
      case 'running': return [`Translating ${pctOf()}%`, `Block ${Math.min(nBlocks(), j.blocks.split('').filter((c) => c === 'd').length + 1)} of ${nBlocks()} into ${j.target.name}.`];
      case 'waiting': return ['Waiting for a free key', `Every key is rate limited. TAS continues in ${Math.max(0, Math.ceil((j.waiting.until - Date.now()) / 1000))} s.`];
      case 'paused': return [`Paused at ${pctOf()}%`, 'Finished blocks are saved. Resume whenever you like.'];
      case 'stopped': return ['Stopped', j.error];
      case 'partial': return [`${failedCount()} ${failedCount() === 1 ? 'block' : 'blocks'} failed`, 'Retry them from the block list, or all at once.'];
      case 'done': return ['Translated', `${j.target.name}, ${n(j.total)} lines. Saved in this browser, ready next visit.`];
      default: return ['', ''];
    }
  }

  function render() {
    const kind = deriveKind();
    const app = $('#app');
    app.dataset.kind = kind;
    const [h, sub] = copyFor(kind);
    $('#headline').textContent = h;
    $('#subline').textContent = sub || '';
    $('#pct').textContent = S.job && S.job.total ? `${pctOf()}%` : '';
    $('#lines').textContent = S.job && S.job.total ? `${S.job.doneLines.toLocaleString()} of ${S.job.total.toLocaleString()} lines` : '';
    renderNotice(kind);
    renderActions(kind);
    renderToggle(kind);
    renderPlate();
    renderSource();
    renderKeyline();
    paintStrip();
    $('#blkCount').textContent = S.job ? String(nBlocks()) : '';
    renderBlocks();
  }

  function renderNotice(kind) {
    const n = $('#notice');
    n.hidden = true; n.className = 'notice'; n.innerHTML = '';
    let msg = '', cls = '', btn = null;
    if (kind === 'stopped') { msg = 'Fix the problem below, then resume. Nothing was lost.'; btn = null; }
    else if (kind === 'nokey' && S.job) { msg = 'Add a Gemini API key to continue.'; btn = ['Open settings', () => ext.runtime.openOptionsPage()]; cls = 'info'; }
    else if (kind === 'nocaptions' && S.page && S.page.isYT && !S.page.ccButton) { msg = 'This video seems to have no captions, or the player is still loading.'; cls = 'info'; }
    else if (S.job && S.job.status !== 'running' && Object.keys(S.job.errs || {}).length && kind !== 'stopped') {
      const first = Object.values(S.job.errs)[0];
      msg = first; cls = '';
    }
    if (!msg) return;
    n.className = 'notice ' + cls;
    n.innerHTML = GST.icon(cls === 'info' ? 'cc' : 'alert') + '<span></span>';
    n.querySelector('span').textContent = msg;
    if (btn) { const b = document.createElement('button'); b.className = 'btn sm primary'; b.textContent = btn[0]; b.onclick = btn[1]; n.appendChild(b); }
    n.hidden = false;
  }

  function renderActions(kind) {
    const box = $('#actions');
    box.innerHTML = '';
    const add = (label, cls, icon, fn, title) => {
      const b = document.createElement('button');
      b.className = 'btn ' + cls;
      b.innerHTML = (icon ? GST.icon(icon) : '') + (label ? `<span>${label}</span>` : '');
      if (title) { b.title = title; b.setAttribute('aria-label', title); }
      b.disabled = S.busyAction && !['pause', 'cancel'].includes(cls);
      b.onclick = fn;
      box.appendChild(b);
      return b;
    };
    switch (kind) {
      case 'nokey': add('Open settings', 'primary', 'key', () => ext.runtime.openOptionsPage()); break;
      case 'nocaptions':
        if (S.page.isYT) add(S.busyAction ? 'Capturing…' : 'Capture captions', 'primary', 'cc', enableCaptions);
        else add(S.busyAction ? 'Scanning…' : 'Scan this page', 'primary', 'search', rescan);
        break;
      case 'ready': add('Translate', 'hi', 'play', () => start(false)); break;
      case 'running': case 'waiting':
        add('Pause', 'primary', 'pause', () => cmd('bg:job:pause'));
        add('Cancel', 'danger', 'x', cancelJob);
        break;
      case 'paused': case 'stopped':
        add('Resume', 'hi', 'play', () => cmd('bg:job:resume'));
        add('Cancel', 'danger', 'x', cancelJob);
        break;
      case 'partial':
        add('Retry failed blocks', 'hi', 'redo', () => cmd('bg:job:resume'));
        add('', 'danger icon', 'trash', cancelJob, 'Delete this translation');
        break;
      case 'done': {
        const sure = Date.now() < S.confirmRestart;
        add(sure ? 'Click again to restart' : 'Translate again', 'ghost', 'redo', () => {
          if (Date.now() < S.confirmRestart) { S.confirmRestart = 0; start(true); } else { S.confirmRestart = Date.now() + 3500; render(); setTimeout(render, 3600); }
        });
        add('', 'danger icon', 'trash', cancelJob, 'Delete this translation');
        break;
      }
      default: break;
    }
  }

  function renderToggle(kind) {
    const t = $('#showToggle');
    const has = !!(S.job && S.job.doneLines > 0);
    t.disabled = !has || !S.page;
    t.checked = has && !!(S.page && S.page.overlayVisible);
    $('#showHint').textContent = !has ? 'Translate first, then show the result here.'
      : (kind === 'running' || kind === 'waiting') ? 'New lines appear the moment each block finishes.'
        : 'Loaded from this browser. No new request needed.';
  }

  function lastLine() {
    if (!S.tr) return '';
    for (let i = S.tr.length - 1; i >= 0; i--) if (S.tr[i]) return S.tr[i];
    return '';
  }
  function renderPlate() {
    const txt = lastLine();
    const wrap = $('#plateWrap');
    wrap.hidden = !txt;
    if (!txt) return;
    const d = S.settings.display;
    const p = $('#plate');
    p.style.color = d.color;
    p.dir = d.dir;
    if (txt !== S.plateText) {
      S.plateText = txt; p.textContent = txt;
      p.classList.remove('swap'); void p.offsetWidth; p.classList.add('swap');
    }
  }

  function renderSource() {
    const row = $('#sourceRow');
    const p = S.page;
    const multi = !!(p && p.sources.length > 1);
    row.hidden = !multi;
    if (!multi) return;
    const sel = $('#source');
    sel.innerHTML = '';
    for (const s of p.sources) {
      const o = document.createElement('option');
      o.value = s.id; o.textContent = `${s.label} (${s.count} lines)`;
      if (s.id === p.activeSourceId) o.selected = true;
      sel.appendChild(o);
    }
    sel.disabled = !!(S.job && ['running', 'waiting'].includes(deriveKind()));
  }

  function renderKeyline() {
    const keys = S.keysList.filter((k) => k.enabled !== false);
    const el = $('#keyline');
    if (!keys.length) { el.textContent = 'No API key yet.'; return; }
    const cooling = keys.filter((k) => S.keysState[k.id] && S.keysState[k.id].status === 'cooldown');
    const bad = keys.filter((k) => S.keysState[k.id] && ['invalid', 'unreadable'].includes(S.keysState[k.id].status));
    let t = `${keys.length} ${keys.length === 1 ? 'key' : 'keys'}`;
    if (bad.length) t += `, ${bad.length} rejected`;
    if (cooling.length) t += `, ${cooling.length} cooling down`;
    el.textContent = `${t}. Model: ${S.settings.model}.`;
  }

  /* ================================================================ strip */
  function buildStrip() {
    const cols = $('#cols');
    cols.innerHTML = '';
    for (let i = 0; i < COLS; i++) cols.appendChild(document.createElement('i')).className = 'col';
    S.strip = null;
    let dur = 0, dens = null, colCues = null;
    if (S.cues && S.cues.length) {
      dur = Math.max(...S.cues.map((c) => c[1])) || 1;
      const w = new Array(COLS).fill(0);
      colCues = Array.from({ length: COLS }, () => []);
      S.cues.forEach((c, i) => { const k = Math.min(COLS - 1, Math.floor(c[0] / dur * COLS)); w[k] += c[2].length; colCues[k].push(i); });
      const m = Math.max(...w) || 1;
      dens = w.map((x) => x / m);
    } else if (S.page && S.page.density) { dens = S.page.density.cols; dur = S.page.density.dur; }
    else dens = new Array(COLS).fill(0.1);
    S.strip = { dur, dens, colCues };
    Array.from(cols.children).forEach((c, i) => { c.style.setProperty('--h', Math.max(0.1, dens[i] || 0)); c.title = dur ? GST.fmtClock(i / COLS * dur) : ''; });
  }
  function paintStrip() {
    if (!S.strip) buildStrip();
    const { colCues } = S.strip;
    const kids = $('#cols').children;
    $('#playhead').hidden = !(S.strip.dur && S.page);
    if (!colCues || !S.job) { for (const c of kids) { c.style.setProperty('--p', 0); c.className = 'col'; } return; }
    const bs = S.job.blockSize;
    for (let i = 0; i < COLS; i++) {
      const idx = colCues[i];
      let done = 0, err = false, run = false;
      for (const k of idx) {
        if (S.tr[k]) done++;
        const st = S.job.blocks[Math.floor(k / bs)];
        if (st === 'e') err = true; else if (st === 'r') run = true;
      }
      const c = kids[i];
      c.style.setProperty('--p', idx.length ? (done / idx.length).toFixed(3) : (i > 0 && kids[i - 1].style.getPropertyValue('--p') === '1' ? 1 : 0));
      c.className = 'col' + (err ? ' err' : run ? ' run' : '');
    }
  }
  function movePlayhead() {
    if (!S.strip || !S.strip.dur) return;
    $('#playhead').style.left = Math.min(100, Math.max(0, S.playMs / S.strip.dur * 100)) + '%';
  }
  $('#strip').addEventListener('click', (e) => {
    if (!S.strip || !S.strip.dur) return;
    const r = e.currentTarget.getBoundingClientRect();
    const ms = Math.max(0, (e.clientX - r.left) / r.width * S.strip.dur);
    sendTab('gst:seek', { ms });
    S.playMs = ms; movePlayhead();
  });

  /* ================================================================ commands */
  async function cmd(type, extra) {
    if (!S.jobKey) return null;
    const r = await GST.rpc(Object.assign({ type, key: S.jobKey }, extra || {}));
    if (r && r.ok === false && r.error === 'no-keys') { toast('Add a Gemini API key first.'); ext.runtime.openOptionsPage(); }
    else if (r && r.ok === false && r.error) toast(r.error, 4000);
    if (r && r.summary) { S.job = r.summary; render(); }
    return r;
  }
  async function start(restart) {
    S.busyAction = true; render();
    const r = await sendTab('gst:start', { restart });
    S.busyAction = false;
    if (!r) toast('Could not reach the page. Reload the tab and try again.', 4000);
    else if (r.ok === false) {
      if (r.error === 'no-keys') { toast('Add a Gemini API key first.'); ext.runtime.openOptionsPage(); }
      else if (r.error === 'no-source') toast('No subtitles found yet. Turn on captions in the player first.', 4000);
      else toast(String(r.error), 4000);
    }
    await refreshPage();
  }
  async function enableCaptions() {
    S.busyAction = true; render();
    const r = await sendTab('gst:enableCaptions');
    S.busyAction = false;
    if (r && r.captured === false) toast('No captions arrived. Reload the video page once, then try again.', 4500);
    await refreshPage();
  }
  async function rescan() {
    S.busyAction = true; render();
    await sendTab('gst:rescan');
    S.busyAction = false;
    await refreshPage();
    if (S.page && !S.page.sources.length) toast('No subtitle track found. Switch subtitles on in the player and press play.', 4500);
  }
  async function cancelJob() {
    const r = await GST.rpc({ type: 'bg:job:cancel', key: S.jobKey });
    if (r && r.ok) { S.job = null; S.cues = null; S.tr = null; S.strip = null; S.plateText = ''; await sendTab('gst:setOverlay', { visible: false }); await refreshPage(); toast('Translation removed from this browser.'); }
  }
  $('#showToggle').addEventListener('change', async (e) => {
    const r = await sendTab('gst:setOverlay', { visible: e.target.checked });
    if (r && S.page) S.page.overlayVisible = r.vis;
  });
  $('#source').addEventListener('change', async (e) => { await sendTab('gst:selectSource', { id: e.target.value }); await refreshPage(); });
  $('#btnSettings').onclick = () => { ext.runtime.openOptionsPage(); if (!FULL) window.close(); };
  $('#btnExpand').onclick = () => { ext.tabs.create({ url: ext.runtime.getURL(`popup/popup.html?full=1&tab=${S.tabId}`) }); window.close(); };
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    S.tab = b.dataset.tab;
    document.querySelectorAll('#tabs button').forEach((x) => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-selected', on); });
    $('#home').hidden = S.tab !== 'home'; $('#blocks').hidden = S.tab !== 'blocks';
  });

  /* ================================================================ block manager */
  const blockState = (b) => (S.job ? S.job.blocks[b] : 'p');
  function fmtRange(b) {
    const [f, t] = blockRange(b);
    return `${GST.fmtClock(S.cues[f][0])} to ${GST.fmtClock(S.cues[t - 1][1])}, lines ${f + 1} to ${t}`;
  }
  function visible(b) {
    const s = blockState(b);
    if (S.filter === 'all') return true;
    if (S.filter === 'p') return s === 'p' || s === 'r';
    return s === S.filter;
  }
  function buildBlock(b) {
    const s = blockState(b);
    const el = document.createElement('div');
    el.className = 'blk' + (S.open.has(b) ? ' open' : '');
    el.dataset.b = b; el.dataset.s = s;
    const translated = s === 'd';
    el.innerHTML = `
      <div class="bh" role="button" tabindex="0" aria-expanded="${S.open.has(b)}">
        <span class="mark"></span>
        <div class="bt"><b>Block ${b + 1}</b><small class="num">${fmtRange(b)}</small></div>
        <button class="btn icon sm jump" title="Jump to this point in the video" aria-label="Jump to this point in the video">${GST.icon('jump')}</button>
        <button class="btn icon sm tr" title="${translated ? 'Retranslate this block' : 'Translate this block'}" aria-label="${translated ? 'Retranslate this block' : 'Translate this block'}">${GST.icon('redo')}</button>
        ${GST.icon('chevron', 'chev')}
      </div>
      <div class="bl"></div>`;
    if (S.open.has(b)) fillLines(el, b);
    return el;
  }
  function fillLines(el, b) {
    const bl = el.querySelector('.bl');
    bl.innerHTML = '';
    const err = S.job.errs && S.job.errs[b];
    if (err && blockState(b) === 'e') { const d = document.createElement('div'); d.className = 'berr'; d.textContent = err; bl.appendChild(d); }
    const [f, t] = blockRange(b);
    const dir = rtl() ? 'rtl' : 'ltr';
    for (let i = f; i < t; i++) {
      const row = document.createElement('div');
      row.className = 'ln';
      const tb = document.createElement('button');
      tb.className = 't num'; tb.textContent = GST.fmtClock(S.cues[i][0]); tb.title = 'Jump to this line';
      tb.onclick = () => sendTab('gst:seek', { ms: S.cues[i][0] });
      const o = document.createElement('div'); o.className = 'o'; o.dir = 'auto'; o.textContent = S.cues[i][2];
      const ta = document.createElement('textarea');
      ta.rows = 1; ta.dir = dir; ta.value = S.tr[i] || ''; ta.placeholder = 'Not translated yet';
      ta.dataset.i = i;
      const grow = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 2 + 'px'; };
      let timer = 0;
      ta.addEventListener('input', () => {
        grow();
        clearTimeout(timer);
        timer = setTimeout(async () => {
          S.tr[i] = ta.value;
          await GST.rpc({ type: 'bg:job:edit', key: S.jobKey, idx: i, text: ta.value });
          toast('Saved', 900); paintStrip();
        }, 500);
      });
      row.append(tb, o, ta);
      bl.appendChild(row);
      requestAnimationFrame(grow);
    }
  }
  function renderBlocks() {
    const list = $('#blockList');
    const empty = $('#blocksEmpty');
    $('#rlmWrap').hidden = !rtl();
    if (!S.job || !S.cues) {
      list.innerHTML = '';
      empty.hidden = false;
      const can = S.page && S.page.sources.length;
      empty.innerHTML = `<b>No blocks yet</b><span>${can ? 'Split the captured subtitles into blocks to translate or edit them one at a time, without running the whole video.' : 'Capture subtitles on the video page first, then come back here.'}</span>`;
      if (can) {
        const b = document.createElement('button');
        b.className = 'btn primary'; b.textContent = 'Split into blocks';
        b.onclick = async () => { S.busyAction = true; const r = await sendTab('gst:start', { run: false }); S.busyAction = false; if (r && r.ok === false) toast(String(r.error)); await refreshPage(); };
        empty.appendChild(b);
      }
      $('#btnDownload').disabled = true;
      return;
    }
    empty.hidden = true;
    $('#btnDownload').disabled = false;
    // Rebuild only what changed so open editors keep focus while blocks stream in.
    const n = nBlocks();
    const existing = new Map(Array.from(list.children).map((c) => [+c.dataset.b, c]));
    const frag = [];
    for (let b = 0; b < n; b++) {
      const cur = existing.get(b);
      if (!visible(b)) { if (cur) cur.remove(); continue; }
      const state = blockState(b);
      if (cur && cur.dataset.s === state && !cur.dataset.dirty) { frag.push(cur); continue; }
      if (cur && cur.contains(document.activeElement) && cur.classList.contains('open')) { cur.dataset.s = state; frag.push(cur); continue; }
      frag.push(buildBlock(b));
    }
    list.replaceChildren(...frag);
  }
  $('#blockList').addEventListener('click', async (e) => {
    const el = e.target.closest('.blk');
    if (!el) return;
    const b = +el.dataset.b;
    if (e.target.closest('.jump')) { sendTab('gst:seek', { ms: S.cues[blockRange(b)[0]][0] }); return; }
    if (e.target.closest('.tr')) {
      el.dataset.s = 'r'; if (S.job) S.job.blocks = S.job.blocks.slice(0, b) + 'r' + S.job.blocks.slice(b + 1);
      paintStrip();
      const r = await GST.rpc({ type: 'bg:job:block', key: S.jobKey, block: b });
      if (r && r.ok === false) {
        if (r.error === 'no-keys') { toast('Add a Gemini API key first.'); ext.runtime.openOptionsPage(); }
        else toast(r.error || 'Translation failed.', 4500);
      }
      if (r && r.summary) S.job = r.summary;
      const cur = $(`.blk[data-b="${b}"]`);
      if (cur) cur.replaceWith(buildBlock(b));
      render();
      return;
    }
    if (e.target.closest('.bh')) {
      if (S.open.has(b)) S.open.delete(b); else S.open.add(b);
      el.classList.toggle('open', S.open.has(b));
      el.querySelector('.bh').setAttribute('aria-expanded', S.open.has(b));
      if (S.open.has(b)) fillLines(el, b);
    }
  });
  $('#blockList').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('bh')) { e.preventDefault(); e.target.click(); }
  });
  $('#filter').addEventListener('change', (e) => { S.filter = e.target.value; $('#blockList').innerHTML = ''; renderBlocks(); });

  /* ---- download */
  $('#btnDownload').addEventListener('click', () => {
    if (!S.job || !S.cues) return;
    const mode = $('#dlMode').value;
    const srt = GST.buildSrt(S.cues, S.tr, { mode, rlm: rtl() && $('#rlm').checked && mode !== 'original' });
    const base = (S.job.title || 'subtitles').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'subtitles';
    const code = String(S.job.target.code).replace(/^custom:/, '').replace(/[^\w-]+/g, '') || 'tr';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\uFEFF' + srt], { type: 'application/x-subrip;charset=utf-8' }));
    a.download = `${base}.${mode === 'original' ? 'orig' : code}.srt`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    const missing = S.tr.filter((x) => !x).length;
    toast(mode !== 'original' && missing ? `Saved. ${missing} untranslated lines keep their original text.` : 'Subtitle file saved.', 3200);
  });

  /* ================================================================ live events */
  function connectPort(key) {
    if (S.port) { try { S.port.disconnect(); } catch (e) { /* ignore */ } S.port = null; }
    if (!key) return;
    try { S.port = ext.runtime.connect({ name: 'gst-popup' }); } catch (e) { return; }
    S.port.postMessage({ type: 'sub', key });
    S.port.onMessage.addListener(onEvent);
    S.port.onDisconnect.addListener(() => { S.port = null; });
  }
  function onEvent(m) {
    if (!m || m.key !== S.jobKey) return;
    if (m.type === 'job:status') { S.job = m.summary; if (S.job && !S.cues) loadJob(); else { render(); } }
    else if (m.type === 'job:block' || m.type === 'job:lines') {
      if (!S.tr) { loadJob(); return; }
      for (const [i, t] of m.lines) {
        S.tr[i] = t;
        const ta = $(`textarea[data-i="${i}"]`);
        if (ta && document.activeElement !== ta) { ta.value = t || ''; ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 2 + 'px'; }
      }
      if (m.summary) S.job = m.summary;
      if (m.type === 'job:block') { const cur = $(`.blk[data-b="${m.block}"]`); if (cur && !cur.contains(document.activeElement)) { cur.dataset.dirty = '1'; } }
      render();
      document.querySelectorAll('.blk[data-dirty]').forEach((x) => delete x.dataset.dirty);
    } else if (m.type === 'job:deleted') { S.job = null; S.cues = null; S.tr = null; S.strip = null; render(); }
  }

  /* ================================================================ loading */
  async function loadJob() {
    if (!S.jobKey) { S.job = null; S.cues = null; S.tr = null; S.strip = null; render(); return; }
    const r = await GST.rpc({ type: 'bg:job:get', key: S.jobKey, full: true });
    if (r && r.ok && r.cues) { S.job = r.summary; S.cues = GST.fixOverlaps(r.cues); S.tr = r.tr; } else { S.job = null; S.cues = null; S.tr = null; }
    S.strip = null; S.plateText = '';
    render();
  }
  async function refreshPage() {
    const p = await sendTab('gst:state');
    S.page = p && p.ok ? p : null;
    const key = S.page ? S.page.jobKey : null;
    if (key !== S.jobKey) { S.jobKey = key; connectPort(key); await loadJob(); }
    else { if (!S.strip || (S.page && S.page.density && !S.job)) S.strip = null; render(); }
    if (S.page) { S.playMs = S.page.t; movePlayhead(); }
  }

  async function pollKeys() {
    const r = await GST.rpc({ type: 'bg:keys:state' });
    if (r && r.ok) {
      const had = S.hasKey;
      S.keysState = r.state; S.keysList = r.keys || [];
      S.hasKey = S.keysList.some((k) => k.enabled !== false);
      if (had !== S.hasKey) render(); else renderKeyline();
    }
  }

  async function init() {
    if (FULL) document.body.classList.add('full');
    GST.mountIcons();
    S.settings = await GST.getSettings();
    await pollKeys();
    if (qs.get('tab')) S.tabId = +qs.get('tab');
    else { const [t] = await ext.tabs.query({ active: true, currentWindow: true }); S.tabId = t ? t.id : null; }
    ext.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local' || !ch.settings) return;
      S.settings = GST.mergeSettings(ch.settings.newValue);
      S.plateText = ''; refreshPage();
    });
    await refreshPage();
    let n = 0;
    setInterval(async () => {
      n++;
      if (n % 4 === 0) { await refreshPage(); pollKeys(); return; }
      const r = await sendTab('gst:tick');
      if (r) { S.playMs = r.t; movePlayhead(); if (S.page) S.page.overlayVisible = r.vis; $('#showToggle').checked = !$('#showToggle').disabled && r.vis; }
      if (S.job && S.job.waiting) render();
    }, 700);
  }
  init();
})();
