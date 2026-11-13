(() => {
  'use strict';
  const { ext } = GST;
  const $ = (s, el = document) => el.querySelector(s);
  let S = GST.mergeSettings(null);
  let models = { at: 0, list: [] };
  let keysState = {};

  /* ================================================================ autosave */
  let saveT = 0, popT = 0;
  const savedEl = $('#saved'), savedText = $('#savedText');
  function touch() {
    savedEl.classList.add('busy'); savedEl.classList.remove('pop'); savedText.textContent = 'Saving…';
    clearTimeout(saveT);
    saveT = setTimeout(async () => {
      await ext.storage.local.set({ settings: S });
      savedEl.classList.remove('busy'); void savedEl.offsetWidth; savedEl.classList.add('pop');
      savedText.textContent = 'All changes saved';
      clearTimeout(popT); popT = setTimeout(() => savedEl.classList.remove('pop'), 600);
    }, 250);
  }

  /* ================================================================ tabs */
  function showTab(name) {
    document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    ['translation', 'display', 'cache'].forEach((t) => { $('#tab-' + t).hidden = t !== name; });
    if (name === 'display') renderPreview();
    if (name === 'cache') loadCache();
    try { history.replaceState(null, '', '#' + name); } catch (e) { /* ignore */ }
  }
  $('#nav').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); });

  /* ================================================================ binding helpers */
  function bindPair(rangeSel, numSel, get, set, fmt) {
    const r = $(rangeSel), n = $(numSel);
    const apply = (v) => { set(v); r.value = Math.min(+r.max, Math.max(+r.min, v)); n.value = v; touch(); };
    r.value = n.value = get();
    r.addEventListener('input', () => apply(parseFloat(r.value)));
    n.addEventListener('input', () => { const v = parseFloat(n.value); if (!Number.isNaN(v)) { set(v); r.value = Math.min(+r.max, Math.max(+r.min, v)); touch(); } });
    n.addEventListener('blur', () => { n.value = get(); });
  }
  function bindCheck(sel, get, set, after) {
    const el = $(sel); el.checked = !!get();
    el.addEventListener('change', () => { set(el.checked); touch(); if (after) after(); });
  }

  /* ================================================================ API keys
   * The page never sees a stored key: the background keeps them encrypted and hands back only
   * { id, label, last 4 characters, enabled }. */
  let keys = [];
  const mask = (k) => 'AIza••••••••' + (k.tail || '');
  const setKeys = (list) => { if (Array.isArray(list)) { keys = list; renderKeys(); } };
  function renderKeys() {
    const ol = $('#keys');
    ol.innerHTML = '';
    keys.forEach((k, i) => {
      const li = document.createElement('li');
      li.className = 'key' + (k.enabled === false ? ' off' : '');
      li.dataset.id = k.id;
      li.innerHTML = `
        <span class="prio num" title="Priority ${i + 1}">${i + 1}</span>
        <div class="kmain"><input class="klabel" type="text" aria-label="Key name" maxlength="40"><code class="kval"></code></div>
        <span class="chip kst"></span>
        <label class="switch" title="Use this key"><input type="checkbox" class="ken" aria-label="Use this key"><span></span></label>
        <button class="btn icon sm ktest" title="Test key" aria-label="Test key">${GST.icon('bolt')}</button>
        <button class="btn icon sm kup" title="Use earlier" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>${GST.icon('up')}</button>
        <button class="btn icon sm kdn" title="Use later" aria-label="Move down" ${i === keys.length - 1 ? 'disabled' : ''}>${GST.icon('down')}</button>
        <button class="btn icon sm kdel" title="Remove key" aria-label="Remove key">${GST.icon('trash')}</button>`;
      li.querySelector('.klabel').value = k.label || `Key ${i + 1}`;
      li.querySelector('.kval').textContent = mask(k);
      li.querySelector('.ken').checked = k.enabled !== false;
      ol.appendChild(li);
    });
    paintKeyStates();
    renderModelButton();
  }
  function paintKeyStates() {
    document.querySelectorAll('.key').forEach((li) => {
      const k = keys.find((x) => x.id === li.dataset.id);
      const st = keysState[li.dataset.id];
      const c = li.querySelector('.kst');
      if (!k) return;
      if (k.enabled === false) { c.className = 'chip kst'; c.textContent = 'Off'; c.title = ''; }
      else if (st && st.status === 'unreadable') { c.className = 'chip bad kst'; c.textContent = 'Re-enter key'; c.title = st.reason || ''; }
      else if (st && st.status === 'invalid') { c.className = 'chip bad kst'; c.textContent = 'Rejected'; c.title = st.reason || ''; }
      else if (st && st.status === 'cooldown') { c.className = 'chip warn kst'; c.textContent = `Cooling ${Math.max(1, Math.ceil((st.until - Date.now()) / 1000))} s`; c.title = st.reason || ''; }
      else { c.className = 'chip ok kst'; c.innerHTML = '<span class="dot"></span>Ready'; c.title = ''; }
    });
  }
  const labelTimers = {};
  $('#keys').addEventListener('input', (e) => {
    if (!e.target.classList.contains('klabel')) return;
    const id = e.target.closest('.key').dataset.id, label = e.target.value;
    const k = keys.find((x) => x.id === id); if (k) k.label = label;
    savedEl.classList.add('busy'); savedText.textContent = 'Saving…';
    clearTimeout(labelTimers[id]);
    labelTimers[id] = setTimeout(async () => { await GST.rpc({ type: 'bg:keys:update', id, label }); savedEl.classList.remove('busy'); savedText.textContent = 'All changes saved'; }, 350);
  });
  $('#keys').addEventListener('change', async (e) => {
    if (!e.target.classList.contains('ken')) return;
    const r = await GST.rpc({ type: 'bg:keys:update', id: e.target.closest('.key').dataset.id, enabled: e.target.checked });
    if (r && r.ok) setKeys(r.keys);
  });
  $('#keys').addEventListener('click', async (e) => {
    const li = e.target.closest('.key');
    if (!li) return;
    const id = li.dataset.id;
    if (e.target.closest('.kdel')) { const r = await GST.rpc({ type: 'bg:keys:remove', id }); if (r && r.ok) setKeys(r.keys); }
    else if (e.target.closest('.kup')) { const r = await GST.rpc({ type: 'bg:keys:move', id, dir: -1 }); if (r && r.ok) setKeys(r.keys); }
    else if (e.target.closest('.kdn')) { const r = await GST.rpc({ type: 'bg:keys:move', id, dir: 1 }); if (r && r.ok) setKeys(r.keys); }
    else if (e.target.closest('.ktest')) {
      const c = li.querySelector('.kst');
      c.className = 'chip kst'; c.textContent = 'Testing…';
      const r = await GST.rpc({ type: 'bg:keys:test', id });
      await pollKeys();
      if (r && r.ok) { c.className = 'chip ok kst'; c.innerHTML = '<span class="dot"></span>Works'; }
      else { c.className = 'chip bad kst'; c.textContent = 'Failed'; c.title = (r && r.error) || ''; alert('This key did not work:\n\n' + ((r && r.error) || 'No answer')); }
    }
  });
  $('#addKeys').addEventListener('click', async () => {
    const parts = $('#newKeys').value.split(/[\s,;]+/).map((x) => x.trim()).filter((x) => x.length >= 16);
    if (!parts.length) { $('#newKeys').focus(); return; }
    $('#newKeys').value = ''; // the plaintext leaves this page immediately
    const r = await GST.rpc({ type: 'bg:keys:add', keys: parts });
    if (r && r.ok) {
      setKeys(r.keys);
      if (r.duplicates) { savedText.textContent = `${r.duplicates} duplicate ${r.duplicates === 1 ? 'key was' : 'keys were'} skipped`; }
      if (r.added) fetchModels(true);
    }
  });
  async function pollKeys() {
    const r = await GST.rpc({ type: 'bg:keys:state' });
    if (r && r.ok) {
      keysState = r.state;
      const sig = (l) => l.map((k) => k.id + k.enabled).join();
      if (r.keys && sig(r.keys) !== sig(keys)) setKeys(r.keys); else paintKeyStates();
    }
  }

  /* ================================================================ models */
  const curModel = () => models.list.find((m) => m.id === S.model);
  function renderModelButton() {
    const m = curModel();
    $('#modelName').textContent = m ? m.name : S.model;
    $('#modelId').textContent = S.model;
    const st = $('#modelStatus');
    if (models.list.length) st.textContent = `${models.list.length} models available, fetched ${rel(models.at)}.`;
    else st.textContent = keys.length ? 'Press “Fetch models” to load the list from the endpoint.' : 'Add an API key to load the model list.';
  }
  function renderModelList() {
    const q = $('#modelSearch').value.trim().toLowerCase();
    const ul = $('#modelList');
    ul.innerHTML = '';
    const list = models.list.filter((m) => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
    for (const m of list) {
      const li = document.createElement('li');
      li.setAttribute('role', 'option'); li.dataset.id = m.id;
      li.className = m.id === S.model ? 'cur' : '';
      li.setAttribute('aria-selected', m.id === S.model);
      const tok = m.inTok >= 1e6 ? `${Math.round(m.inTok / 1e6)}M context` : m.inTok ? `${Math.round(m.inTok / 1000)}k context` : '';
      li.innerHTML = '<b></b><small></small>';
      li.querySelector('b').textContent = m.name;
      li.querySelector('small').textContent = m.id + (tok ? ', ' + tok : '');
      ul.appendChild(li);
    }
    if (q && !models.list.some((m) => m.id === q)) {
      const li = document.createElement('li');
      li.dataset.id = q.replace(/^models\//, ''); li.innerHTML = '<b></b><small>Use this id as typed</small>';
      li.querySelector('b').textContent = `Use “${li.dataset.id}”`;
      ul.appendChild(li);
    }
    if (!ul.children.length) ul.innerHTML = '<li class="none">No models loaded yet. Press “Fetch models”.</li>';
  }
  function togglePanel(open) {
    $('#modelPanel').hidden = !open;
    $('#modelBtn').setAttribute('aria-expanded', open);
    if (open) { $('#modelSearch').value = ''; renderModelList(); $('#modelSearch').focus(); }
  }
  $('#modelBtn').addEventListener('click', () => togglePanel($('#modelPanel').hidden));
  $('#modelSearch').addEventListener('input', renderModelList);
  $('#modelSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') togglePanel(false);
    if (e.key === 'Enter') { const f = $('#modelList li[data-id]'); if (f) f.click(); }
  });
  $('#modelList').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    S.model = li.dataset.id; touch(); renderModelButton(); togglePanel(false);
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.combo')) togglePanel(false); });
  async function fetchModels(silent) {
    const btn = $('#fetchModels');
    btn.disabled = true; btn.firstElementChild && btn.firstElementChild.classList.add('spin');
    $('#modelStatus').textContent = 'Fetching models…';
    const r = await GST.rpc({ type: 'bg:models:fetch' });
    btn.disabled = false; btn.firstElementChild && btn.firstElementChild.classList.remove('spin');
    if (r && r.ok) { models = { at: r.at, list: r.list }; renderModelButton(); }
    else { renderModelButton(); if (!silent) $('#modelStatus').textContent = 'Could not load models: ' + ((r && r.error) || 'no answer'); }
  }
  $('#fetchModels').addEventListener('click', () => fetchModels(false));

  /* ================================================================ language, tone */
  function buildLanguage() {
    const sel = $('#targetLang');
    sel.innerHTML = '';
    for (const l of GST.LANGS) {
      const o = document.createElement('option');
      o.value = l.code; o.textContent = l.native === l.name ? l.name : `${l.name}  (${l.native})`;
      sel.appendChild(o);
    }
    const o = document.createElement('option'); o.value = 'custom'; o.textContent = 'Other language…'; sel.appendChild(o);
    sel.value = S.targetLang;
    $('#customLang').value = S.customLang; $('#customLang').hidden = S.targetLang !== 'custom';
    sel.addEventListener('change', () => {
      S.targetLang = sel.value;
      $('#customLang').hidden = sel.value !== 'custom';
      const t = GST.targetInfo(S);
      const dir = t.rtl ? 'rtl' : 'ltr';
      if (S.display.dir !== dir) { S.display.dir = dir; syncDisplayControls(); renderPreview(); flashDirNote(t); }
      touch();
    });
    $('#customLang').addEventListener('input', (e) => { S.customLang = e.target.value; touch(); });
  }
  function flashDirNote(t) {
    const n = $('#dirNote'); const orig = n.dataset.o || n.textContent; n.dataset.o = orig;
    n.textContent = `Switched to ${S.display.dir.toUpperCase()} automatically for ${t.name}.`;
    setTimeout(() => { n.textContent = orig; }, 4500);
  }
  function buildTones() {
    const box = $('#tones');
    box.innerHTML = '';
    for (const t of GST.TONES) {
      const b = document.createElement('button');
      b.className = 'tone'; b.type = 'button'; b.textContent = t.label; b.dataset.id = t.id;
      b.setAttribute('aria-pressed', S.tone === t.id);
      if (t.prompt) b.title = t.prompt;
      box.appendChild(b);
    }
    $('#customTone').hidden = S.tone !== 'custom';
    $('#customTone').value = S.customTone;
    box.addEventListener('click', (e) => {
      const b = e.target.closest('.tone'); if (!b) return;
      S.tone = b.dataset.id; touch();
      box.querySelectorAll('.tone').forEach((x) => x.setAttribute('aria-pressed', x === b));
      $('#customTone').hidden = S.tone !== 'custom';
      if (S.tone === 'custom') $('#customTone').focus();
    });
    $('#customTone').addEventListener('input', (e) => { S.customTone = e.target.value; touch(); });
  }

  /* ================================================================ display */
  const SAMPLE = {
    rtl: ['Gemini می‌تواند زیرنویس را در چند ثانیه ترجمه کند.', 'یک خط دوم بلندتر برای نشان دادن شکستن متن در بیشترین عرضی که تعیین کرده‌اید.'],
    ltr: ['This is how your subtitles will look.', 'A longer second line, to show where text wraps at the maximum width you set.'],
  };
  function renderPreview() {
    const d = S.display, stage = $('#stage'), box = $('#pvbox');
    const H = stage.clientHeight || 300;
    const mw = GST.maxWidthPct(d);
    box.style.setProperty('--mw', mw + '%');
    box.style.left = d.x + '%'; box.style.top = d.y + '%';
    box.style.transform = `translate(-${d.x}%,-${d.y}%)`;
    const lines = SAMPLE[d.dir] || SAMPLE.ltr;
    box.innerHTML = '';
    for (const t of lines) {
      const p = document.createElement('div');
      p.className = 'pl'; p.dir = d.dir; p.textContent = t;
      p.style.color = d.color; p.style.background = GST.hexToRgba(d.bg, d.bgOpacity);
      p.style.fontSize = (d.fontSize * H / 100).toFixed(1) + 'px';
      p.style.fontWeight = d.bold ? 700 : 500;
      p.style.textShadow = d.outline ? '0 0 3px #000,0 0 3px #000,1px 1px 2px #000' : 'none';
      box.appendChild(p);
    }
    box.setAttribute('aria-valuetext', `${d.x}% across, ${d.y}% down`);
    $('#pxO').textContent = d.x; $('#pyO').textContent = d.y;
    $('#bgOpacityO').textContent = Math.round(d.bgOpacity * 100) + '%';
    $('#fontSizeO').textContent = d.fontSize.toFixed(1);
    $('#maxWidthO').textContent = mw + '%';
  }
  function syncDisplayControls() {
    const d = S.display;
    $('#color').value = d.color; $('#bg').value = d.bg;
    $('#bgOpacity').value = Math.round(d.bgOpacity * 100);
    $('#px').value = d.x; $('#py').value = d.y; $('#fontSize').value = Math.round(d.fontSize * 10);
    $('#maxWidth').value = GST.maxWidthPct(d);
    document.querySelectorAll('#dir input').forEach((r) => { r.checked = r.value === d.dir; });
  }
  function bindDisplay() {
    const d = S.display;
    syncDisplayControls();
    const on = (sel, fn) => $(sel).addEventListener('input', (e) => { fn(e.target); touch(); renderPreview(); });
    on('#color', (t) => { d.color = t.value; });
    on('#bg', (t) => { d.bg = t.value; });
    on('#bgOpacity', (t) => { d.bgOpacity = +t.value / 100; });
    on('#px', (t) => { d.x = +t.value; });
    on('#py', (t) => { d.y = +t.value; });
    on('#fontSize', (t) => { d.fontSize = +t.value / 10; });
    on('#maxWidth', (t) => { d.maxWidth = +t.value; });
    document.querySelectorAll('#dir input').forEach((r) => r.addEventListener('change', () => { d.dir = r.value; touch(); renderPreview(); }));
    ['bold', 'outline', 'hideOriginal', 'autoShowCached'].forEach((k) => bindCheck('#' + k, () => d[k], (v) => { d[k] = v; }, renderPreview));

    // drag the subtitle inside the preview
    const stage = $('#stage'), box = $('#pvbox');
    let drag = null;
    const solve = (c, size, boxSize) => (size - boxSize > 1 ? Math.min(100, Math.max(0, (c - boxSize / 2) / ((size - boxSize) / 100))) : 50);
    box.addEventListener('pointerdown', (e) => {
      const sr = stage.getBoundingClientRect(), br = box.getBoundingClientRect();
      drag = { dx: e.clientX - (br.left + br.width / 2), dy: e.clientY - (br.top + br.height / 2), sr, w: br.width, h: br.height };
      box.setPointerCapture(e.pointerId); e.preventDefault();
    });
    box.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const cx = e.clientX - drag.dx - drag.sr.left, cy = e.clientY - drag.dy - drag.sr.top;
      d.x = Math.round(solve(cx, drag.sr.width, drag.w)); d.y = Math.round(solve(cy, drag.sr.height, drag.h));
      syncDisplayControls(); renderPreview(); touch();
    });
    const end = () => { drag = null; };
    box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
    box.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 5 : 1;
      const m = { ArrowLeft: ['x', -step], ArrowRight: ['x', step], ArrowUp: ['y', -step], ArrowDown: ['y', step] }[e.key];
      if (!m) return;
      e.preventDefault(); d[m[0]] = Math.min(100, Math.max(0, d[m[0]] + m[1]));
      syncDisplayControls(); renderPreview(); touch();
    });
    new ResizeObserver(() => renderPreview()).observe(stage);
  }

  /* ================================================================ cache */
  const rel = (t) => {
    if (!t) return 'never';
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  };
  /** Where to send the user for a saved job: a clean watch URL for YouTube, else the page it was captured on.
   *  Only http(s) is ever linked, so a stored value can never become a javascript: or data: link. */
  const jobUrl = (j) => {
    const yt = /^yt:([\w-]{6,})$/.exec(j.videoKey || '');
    if (yt) return 'https://www.youtube.com/watch?v=' + yt[1];
    try { const u = new URL(j.pageUrl); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : ''; } catch (e) { return ''; }
  };
  const kb = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  async function loadCache() {
    const r = await GST.rpc({ type: 'bg:jobs:list' });
    const jobs = (r && r.jobs) || [];
    const ul = $('#jobs');
    ul.innerHTML = '';
    const total = jobs.reduce((n, j) => n + j.size, 0);
    $('#cacheSummary').textContent = jobs.length ? `${jobs.length} saved ${jobs.length === 1 ? 'translation' : 'translations'}, about ${kb(total)}.` : 'Nothing saved yet.';
    $('#clearAll').disabled = !jobs.length;
    if (!jobs.length) { ul.innerHTML = '<li class="nojobs">Translations you start appear here, so you can reopen them on the same video later.</li>'; return; }
    const label = { done: 'Translated', running: 'Translating', paused: 'Paused', partial: 'Has failed blocks', idle: 'Not started' };
    for (const j of jobs) {
      const li = document.createElement('li');
      li.className = 'job';
      const pct = j.total ? Math.round(j.done / j.total * 100) : 0;
      li.innerHTML = `<div><div class="t"></div><small></small></div>
        <div><div class="bar"><i style="width:${pct}%"></i></div><small>${pct}% of ${j.total.toLocaleString()} lines</small></div>
        <span class="chip ${j.status === 'done' ? 'ok' : j.status === 'partial' ? 'bad' : ''}">${label[j.status] || j.status}</span>
        <button class="btn icon sm danger" title="Delete" aria-label="Delete this translation">${GST.icon('trash')}</button>`;
      const tEl = li.querySelector('.t');
      const url = jobUrl(j);
      if (url) {
        const a = document.createElement('a');
        a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.textContent = j.title || j.videoKey; a.title = 'Open this video: ' + url;
        tEl.appendChild(a);
      } else tEl.textContent = j.title || j.videoKey;
      li.querySelector('small').textContent = `${j.target.name}, ${kb(j.size)}, ${rel(j.updatedAt)}`;
      li.querySelector('button').onclick = async () => { await GST.rpc({ type: 'bg:job:cancel', key: j.key }); loadCache(); };
      ul.appendChild(li);
    }
  }
  let armed = 0;
  $('#clearAll').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    if (!armed) { armed = setTimeout(() => { armed = 0; b.lastChild.textContent = ' Clear cache'; b.classList.remove('solid'); }, 3500); b.lastChild.textContent = ' Click again to confirm'; b.classList.add('solid'); return; }
    clearTimeout(armed); armed = 0; b.classList.remove('solid'); b.lastChild.textContent = ' Clear cache';
    await GST.rpc({ type: 'bg:cache:clear' });
    loadCache();
  });

  /* ================================================================ init */
  async function init() {
    GST.mountIcons();
    S = await GST.getSettings();
    const o = await ext.storage.local.get('models');
    if (o.models) models = o.models;

    const kl = await GST.rpc({ type: 'bg:keys:list' });
    if (kl && kl.ok) keys = kl.keys;
    renderKeys(); buildLanguage(); buildTones(); bindDisplay(); renderModelButton();
    bindPair('#blockSizeR', '#blockSize', () => S.blockSize, (v) => { S.blockSize = Math.max(1, Math.min(300, Math.round(v))); });
    bindPair('#cooldownR', '#cooldown', () => S.cooldownMs / 1000, (v) => { S.cooldownMs = Math.max(0, Math.round(v * 1000)); });
    bindPair('#retriesR', '#retries', () => S.retries, (v) => { S.retries = Math.max(0, Math.min(20, Math.round(v))); });
    bindCheck('#explicit', () => S.explicit, (v) => { S.explicit = v; });
    bindCheck('#overlap', () => S.overlap, (v) => { S.overlap = v; });
    $('#extra').value = S.extra;
    $('#extra').addEventListener('input', (e) => { S.extra = e.target.value; touch(); });

    const tab = location.hash.slice(1);
    showTab(['translation', 'display', 'cache'].includes(tab) ? tab : 'translation');
    pollKeys(); setInterval(pollKeys, 2000);
    if (keys.some((k) => k.enabled !== false) && (!models.list.length || Date.now() - models.at > 6 * 3600 * 1000)) fetchModels(true);
  }
  init();
})();
