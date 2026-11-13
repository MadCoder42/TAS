/* TAS - content script (isolated world, every frame).
 * Responsibilities
 *   1. receive captions captured by inject.js and turn them into cues (lib/captions.js)
 *   2. mirror the cached / live translation job from the background
 *   3. draw translated subtitles over the <video> (Shadow DOM, survives fullscreen)
 *   4. answer the popup
 */
(() => {
  'use strict';
  if (window.__gstContent) return;
  window.__gstContent = true;

  const { ext } = GST;
  const isYT = /(^|\.)youtube(?:-nocookie)?\.com$/i.test(location.hostname) || location.hostname === 'youtu.be';
  const COLS = 64;

  let settings = GST.mergeSettings(null);
  let overlayVisible = false;
  let lastPlaying = null;
  // Position set by dragging the subtitle on this page: { x, y } in % of the video, or null.
  // Memory only: never written to settings, so it applies to this page view and nothing else.
  let posOverride = null;

  /* ============================================================ identity */
  function ytId() {
    try {
      const u = new URL(location.href);
      if (location.hostname === 'youtu.be') return u.pathname.slice(1) || null;
      if (u.pathname === '/watch') return u.searchParams.get('v');
      const m = /^\/(?:shorts|embed|live|v)\/([\w-]{6,})/.exec(u.pathname);
      return m ? m[1] : null;
    } catch (e) { return null; }
  }
  function identity() {
    if (isYT) { const id = ytId(); return id ? { kind: 'yt', id, videoKey: 'yt:' + id } : null; }
    return { kind: 'web', videoKey: 'web:' + GST.hash(location.origin + location.pathname + location.search) };
  }
  function pageTitle() {
    if (isYT) {
      const h = document.querySelector('h1.ytd-watch-metadata, ytd-watch-metadata h1, .ytp-title-link');
      const t = h && h.textContent && h.textContent.trim();
      if (t) return t;
    }
    return document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*[-–|]\s*YouTube$/i, '').trim() || location.hostname;
  }

  /* ============================================================ video discovery */
  const area = (v) => { const r = v.getBoundingClientRect(); return r.width * r.height; };
  function pickVideo() {
    const vids = Array.from(document.querySelectorAll('video')).filter((v) => {
      const r = v.getBoundingClientRect();
      return r.width > 120 && r.height > 80;
    });
    if (!vids.length) return null;
    if (lastPlaying && vids.includes(lastPlaying)) return lastPlaying;
    return vids.sort((a, b) => area(b) - area(a))[0];
  }

  /* ============================================================ captured sources */
  const sources = new Map(); // id -> { id, label, kind, tlang, cues, srcHash }
  let activeSourceId = null;
  const activeSource = () => sources.get(activeSourceId) || null;

  function onCaption(d) {
    checkNav();
    const parsed = GST.parseCaptions(d.body);
    if (!parsed) return;
    let id, label, kind = '', lang = '', tlang = '';
    try {
      const u = new URL(d.url, location.href);
      if (isYT) {
        const cur = identity();
        const v = u.searchParams.get('v');
        if (cur && v && v !== cur.id) return; // late response of the previous video
        lang = u.searchParams.get('lang') || ''; kind = u.searchParams.get('kind') || '';
        tlang = u.searchParams.get('tlang') || '';
        id = `${lang}|${kind}|${tlang}`;
        label = (lang ? GST.langName(lang) : 'Captions') + (kind === 'asr' ? ' (auto-generated)' : '')
          + (tlang ? ` into ${GST.langName(tlang)} by YouTube` : '');
      } else {
        id = 'u:' + GST.hash(u.origin + u.pathname);
        lang = u.searchParams.get('lang') || d.lang || '';
        label = d.label || decodeURIComponent((u.pathname.split('/').pop() || '').slice(0, 40)) || 'Subtitles';
      }
    } catch (e) { id = 'x:' + GST.hash(String(d.url)); label = d.label || 'Subtitles'; }
    const cues = parsed.cues;
    const srcHash = GST.hash(cues.length + '|' + cues.slice(0, 3).map((c) => c.s + c.t).join('|'));
    const prev = sources.get(id);
    if (prev && prev.srcHash === srcHash) return;
    sources.set(id, { id, label, kind, lang, tlang, cues, srcHash, format: parsed.format, at: Date.now() });
    const cur = activeSource();
    if (!cur || !tlang || cur.tlang) activeSourceId = id; // keep a non-translated track as the default
    refreshLink();
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__gst !== 'caption' || typeof d.body !== 'string') return;
    onCaption(d);
  });

  /* ---- <track> elements and TextTracks (generic sites) */
  const fetchedTracks = new Set();
  async function scanTracks(force) {
    const v = pickVideo();
    if (!v) return;
    for (const el of v.querySelectorAll('track[src]')) {
      const kindAttr = (el.kind || 'subtitles');
      if (!/subtitles|captions/.test(kindAttr)) continue;
      const u = el.src;
      if (!u || (fetchedTracks.has(u) && !force)) continue;
      fetchedTracks.add(u);
      try {
        const r = await fetch(u, { credentials: 'include' });
        onCaption({ url: u, body: await r.text(), label: el.label || el.srclang || undefined, lang: el.srclang || '' });
      } catch (e) { /* cross-origin without CORS: the network hook may still catch it */ }
    }
    const list = Array.from(v.textTracks || []);
    for (let i = 0; i < list.length; i++) {
      const tt = list[i];
      if (!/subtitles|captions/.test(tt.kind)) continue;
      let restore = null;
      if (tt.mode === 'disabled' && force) { tt.mode = 'hidden'; restore = 'disabled'; await GST.sleep(700); }
      if (tt.cues && tt.cues.length) {
        const cues = Array.from(tt.cues).map((c) => ({
          s: Math.round(c.startTime * 1000), e: Math.round(c.endTime * 1000),
          t: String(c.text || '').replace(/<[^>]+>/g, '').replace(/[ \t]+/g, ' ').trim(),
        })).filter((c) => c.t);
        if (cues.length) {
          const id = 'tt:' + i + ':' + (tt.language || '');
          const srcHash = GST.hash(cues.length + '|' + cues.slice(0, 3).map((c) => c.s + c.t).join('|'));
          const prev = sources.get(id);
          if (!prev || prev.srcHash !== srcHash) {
            sources.set(id, { id, label: tt.label || tt.language || 'Subtitles', kind: '', lang: tt.language || '', tlang: '', cues, srcHash, format: 'texttrack', at: Date.now() });
            if (!activeSource()) activeSourceId = id;
          }
        }
      }
      if (restore) tt.mode = restore;
    }
    refreshLink();
  }

  /* ---- YouTube: switch captions on once so the player requests (and we observe) the track */
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await GST.sleep(150); } return !!fn(); };
  async function ensureYtCaptions() {
    if (activeSource()) return true;
    const btn = document.querySelector('.ytp-subtitles-button');
    if (!btn || btn.style.display === 'none' || btn.getAttribute('aria-disabled') === 'true') return false;
    const wasOn = btn.getAttribute('aria-pressed') === 'true';
    if (wasOn) { btn.click(); await GST.sleep(300); btn.click(); } else btn.click();
    const ok = await waitFor(() => !!activeSource(), 9000);
    if (ok && !wasOn) setTimeout(() => { if (btn.getAttribute('aria-pressed') === 'true') btn.click(); }, 700);
    return ok;
  }

  /* ============================================================ navigation (YouTube is an SPA) */
  let lastVK = (identity() || {}).videoKey || null;
  function checkNav() {
    const vk = (identity() || {}).videoKey || null;
    if (vk === lastVK) return;
    lastVK = vk;
    sources.clear(); activeSourceId = null; fetchedTracks.clear();
    job = null; jobKey = null; overlayVisible = false; lastKey = null; posOverride = null;
    if (port && subKey) { try { port.postMessage({ type: 'sub', key: null }); } catch (e) { /* ignore */ } }
    subKey = null;
    render();
    refreshLink();
  }
  setInterval(checkNav, 900);
  document.addEventListener('yt-navigate-finish', checkNav, true);

  /* ============================================================ job mirror */
  let job = null; // { cues: [[s,e,t]], tr: [..], summary }
  let starts = [];
  let jobKey = null;
  let subKey = null;
  let port = null;
  const alive = () => { try { return !!ext.runtime.id; } catch (e) { return false; } };

  function ensurePort() {
    if (port || !alive()) return;
    try { port = ext.runtime.connect({ name: 'gst-content' }); } catch (e) { port = null; return; }
    port.onMessage.addListener(onBg);
    port.onDisconnect.addListener(() => {
      port = null;
      if (subKey && alive()) setTimeout(() => { ensurePort(); if (port && subKey) { port.postMessage({ type: 'sub', key: subKey }); reloadJob(); } }, 800);
    });
  }

  async function refreshLink(force) {
    const id = identity();
    if (!id || (!pickVideo() && !sources.size)) return;
    const key = GST.hash(id.videoKey + '|' + GST.targetInfo(settings).code);
    if (key === jobKey && !force) return;
    jobKey = key; job = null; lastKey = null;
    render();
    ensurePort();
    subKey = key;
    if (port) port.postMessage({ type: 'sub', key });
    await reloadJob();
  }
  let reloading = false;
  async function reloadJob() {
    if (!jobKey || reloading) return;
    reloading = true;
    const key = jobKey;
    const r = await GST.rpc({ type: 'bg:job:get', key, full: true });
    reloading = false;
    if (key !== jobKey) return;
    if (r && r.ok && r.cues) {
      job = { cues: GST.fixOverlaps(r.cues), tr: r.tr, summary: r.summary }; // also repairs jobs cached before the fix
      starts = r.cues.map((c) => c[0]);
      if (settings.display.autoShowCached && r.tr.some((x) => x)) overlayVisible = true;
    } else job = null;
    lastKey = null;
    render();
  }
  function onBg(m) {
    if (!m || m.key !== jobKey) return;
    if (m.type === 'job:block' || m.type === 'job:lines') {
      if (!job) { reloadJob(); return; }
      for (const [i, t] of m.lines) job.tr[i] = t;
      if (m.summary) job.summary = m.summary;
      lastKey = null;
    } else if (m.type === 'job:status') {
      if (!job) reloadJob(); else job.summary = m.summary;
    } else if (m.type === 'job:deleted') {
      job = null; overlayVisible = false; lastKey = null;
    }
    render();
  }

  /* ============================================================ overlay */
  let overlay = null; // { host, box }
  let raf = 0, lastTick = 0, lastKey = null, styleSig = '';
  let hideStyle = null;

  function ensureOverlay() {
    if (overlay) return overlay;
    const host = document.createElement('div');
    host.setAttribute('data-TAS', '');
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;pointer-events:none;z-index:2147483647;contain:layout style;display:none;';
    const sh = host.attachShadow({ mode: 'closed' });
    sh.innerHTML = `<style>
      /* width:max-content matters: an absolutely positioned box otherwise shrink-wraps to the space left of its
         left offset, which made lines wrap at ~50% of the video (or far less off-centre) whatever max-width said. */
      .box{position:absolute;display:flex;flex-direction:column;align-items:center;width:max-content;max-width:var(--mw,92%);pointer-events:none;transition:translate .18s ease}
      .box.drag{transition:none}
      .ln{pointer-events:auto;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;width:fit-content;max-width:100%;margin:2px 0;padding:.12em .55em .2em;border-radius:.3em;text-align:center;white-space:pre-wrap;overflow-wrap:anywhere;
        line-height:1.5;unicode-bidi:isolate;color:var(--fg);background:var(--bg);font-size:var(--fs);font-weight:var(--fw);text-shadow:var(--ts);
        font-family:"Vazirmatn","Segoe UI",Tahoma,system-ui,-apple-system,"Noto Sans Arabic","Noto Sans Hebrew",sans-serif}
      .ln:hover,.box.drag .ln{outline:1.5px dashed rgba(255,255,255,.7);outline-offset:2px}
      .box.drag .ln{cursor:grabbing}
    </style><div class="box"></div>`;
    overlay = { host, box: sh.querySelector('.box') };
    bindDrag(host, overlay.box);
    return overlay;
  }

  /* ---- drag the subtitle on the page.
   * Same anchor model as the settings (left/top = x/y %, translate -x/-y %), so the maths is the one the
   * preview in the settings page uses. Result goes to posOverride only. Double-tapping the subtitle clears it. */
  let dragging = false, swallowClick = false;
  const clampPct = (n) => Math.min(100, Math.max(0, n));
  const solvePct = (c, size, boxSize) => (size - boxSize > 1 ? clampPct((c - boxSize / 2) / ((size - boxSize) / 100)) : 50);
  function bindDrag(host, box) {
    let drag = null, lastTap = null;
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    const finish = (e) => {
      if (!drag || (e && e.pointerId !== drag.id)) return;
      const moved = drag.moved;
      try { box.releasePointerCapture(drag.id); } catch (err) { /* ignore */ }
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', finish, true);
      window.removeEventListener('pointercancel', finish, true);
      drag = null; dragging = false; box.classList.remove('drag');
      if (moved) { if (e) stop(e); swallowClick = true; setTimeout(() => { swallowClick = false; }, 80); lastTap = null; }
      else if (e && e.type === 'pointerup') {
        // Double-tap resets to the saved position. Detected here because cancelling pointerdown (needed to keep
        // the player from seeing the press) also stops the browser from generating click / dblclick.
        const now = performance.now();
        if (lastTap && now - lastTap.t < 400 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 12) { lastTap = null; posOverride = null; }
        else lastTap = { t: now, x: e.clientX, y: e.clientY };
      }
      lastKey = null; paint(); // lets the control-bar lift apply again
    };
    function onMove(e) {
      if (!drag || e.pointerId !== drag.id) return;
      if (!drag.moved) {
        if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) return; // still a click
        drag.moved = true; dragging = true;
        box.classList.add('drag'); box.style.translate = ''; // no control-bar lift while dragging
      }
      stop(e);
      const hr = host.getBoundingClientRect();
      posOverride = {
        x: +solvePct(e.clientX - drag.dx - hr.left, hr.width, drag.w).toFixed(2),
        y: +solvePct(e.clientY - drag.dy - hr.top, hr.height, drag.h).toFixed(2),
      };
      applyPos();
    }
    box.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || drag || !e.target.closest || !e.target.closest('.ln')) return;
      const br = box.getBoundingClientRect(); // where the box visibly is right now (includes any lift)
      drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false, w: br.width, h: br.height,
        dx: e.clientX - (br.left + br.width / 2), dy: e.clientY - (br.top + br.height / 2) };
      try { box.setPointerCapture(e.pointerId); } catch (err) { /* window listeners still cover us */ }
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', finish, true);
      window.addEventListener('pointercancel', finish, true);
      stop(e); // keep the player from seeing the press (e.g. YouTube's press-and-hold speed-up)
    });
    // Browsers that still fire click / dblclick after a cancelled pointerdown must not pass them to the player
    // (a click would pause the video, a double-click would toggle fullscreen).
    for (const t of ['click', 'dblclick']) box.addEventListener(t, (e) => { if (e.target.closest && e.target.closest('.ln')) stop(e); });
    // a drag must never end as a click on the player (that would pause the video)
    window.addEventListener('click', (e) => { if (swallowClick) stop(e); }, true);
  }

  function updateHideOriginal(on) {
    if (on && !hideStyle) {
      hideStyle = document.createElement('style');
      hideStyle.textContent = '.ytp-caption-window-container{visibility:hidden!important}video::cue{color:transparent!important;background:transparent!important;text-shadow:none!important}';
      (document.head || document.documentElement).appendChild(hideStyle);
    } else if (!on && hideStyle) { hideStyle.remove(); hideStyle = null; }
  }

  const activeIdx = (t) => {
    let lo = 0, hi = starts.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (starts[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  };
  // One sentence at a time: only the latest cue that has started can be on screen, so a scrolling
  // caption track can never leave the previous sentence behind.
  function currentLines(t) {
    const i = activeIdx(t);
    return (i >= 0 && job.cues[i][1] > t && job.tr[i]) ? [job.tr[i]] : [];
  }

  // Effective anchor: this page's drag override if there is one, otherwise the saved default.
  const curPos = () => posOverride || { x: settings.display.x, y: settings.display.y };
  let posSig = '';
  function applyPos() {
    if (!overlay) return;
    const p = curPos(), { box } = overlay;
    posSig = p.x + ',' + p.y;
    box.style.left = p.x + '%'; box.style.top = p.y + '%';
    box.style.transform = `translate(-${p.x}%,-${p.y}%)`;
  }

  function paint() {
    const v = pickVideo();
    if (!v || !job) { if (overlay) overlay.host.style.display = 'none'; return; }
    const { host, box } = ensureOverlay();
    const d = settings.display;

    // keep the overlay inside the fullscreen element, otherwise it would be invisible
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    const parent = (fs && fs !== v) ? fs : (document.body || document.documentElement);
    if (host.parentNode !== parent) parent.appendChild(host);

    const r = v.getBoundingClientRect();
    host.style.display = 'block';
    host.style.left = r.left + 'px'; host.style.top = r.top + 'px';
    host.style.width = r.width + 'px'; host.style.height = r.height + 'px';

    const fsPx = Math.max(10, d.fontSize * r.height / 100);
    const mw = GST.maxWidthPct(d);
    const sig = [d.color, d.bg, d.bgOpacity, d.dir, d.bold, d.outline, fsPx.toFixed(1), mw].join('|');
    if (sig !== styleSig) {
      styleSig = sig; lastKey = null;
      box.style.setProperty('--fg', d.color);
      box.style.setProperty('--bg', GST.hexToRgba(d.bg, d.bgOpacity));
      box.style.setProperty('--fs', fsPx.toFixed(1) + 'px');
      box.style.setProperty('--mw', mw + '%');
      box.style.setProperty('--fw', d.bold ? '700' : '500');
      box.style.setProperty('--ts', d.outline ? '0 0 3px #000,0 0 3px #000,1px 1px 2px #000' : 'none');
    }
    const p = curPos();
    if (p.x + ',' + p.y !== posSig) applyPos();
    const lines = currentLines(v.currentTime * 1000);
    const key = lines.join('\n');
    if (key !== lastKey && !dragging) { // content stays put while the user holds it
      lastKey = key;
      box.replaceChildren(...lines.map((l) => {
        const el = document.createElement('div');
        el.className = 'ln';
        el.dir = d.dir; // base direction is forced, so a sentence starting with an English word stays RTL
        el.textContent = l;
        return el;
      }));
    }
    // YouTube: keep subtitles above the control bar while it is visible
    let over = 0;
    if (isYT && lines.length && !dragging) {
      const pl = document.querySelector('#movie_player');
      if (pl && !pl.classList.contains('ytp-autohide')) {
        const bar = pl.querySelector('.ytp-chrome-bottom');
        const lift = (bar ? bar.offsetHeight : 0) + 6;
        const baseBottom = r.height * p.y / 100 + (1 - p.y / 100) * box.offsetHeight;
        over = Math.max(0, baseBottom - (r.height - lift));
      }
    }
    if (!dragging) box.style.translate = over ? `0 ${-over}px` : '';
  }

  function tick(ts) {
    raf = 0;
    if (!shouldShow()) { if (overlay) overlay.host.style.display = 'none'; return; }
    if (ts - lastTick > 60) { lastTick = ts; paint(); }
    raf = requestAnimationFrame(tick);
  }
  const shouldShow = () => overlayVisible && !!job && !!pickVideo();
  function render() {
    updateHideOriginal(shouldShow() && settings.display.hideOriginal);
    if (shouldShow()) { if (!raf) raf = requestAnimationFrame(tick); paint(); }
    else if (overlay) overlay.host.style.display = 'none';
  }
  document.addEventListener('fullscreenchange', () => paint());
  document.addEventListener('webkitfullscreenchange', () => paint());

  /* ============================================================ settings */
  let lastTarget = null, lastXY = null;
  function onSettings() {
    const code = GST.targetInfo(settings).code;
    styleSig = ''; posSig = ''; lastKey = null;
    // moving the default in the settings page wins over an earlier drag on this page
    const xy = settings.display.x + ',' + settings.display.y;
    if (lastXY !== null && xy !== lastXY) posOverride = null;
    lastXY = xy;
    if (lastTarget !== null && code !== lastTarget) refreshLink(true); // new target language = other cached job
    lastTarget = code;
    render();
  }
  GST.getSettings().then((s) => { settings = s; onSettings(); });
  try {
    ext.storage.onChanged.addListener((ch, area) => {
      if (area === 'local' && ch.settings) { settings = GST.mergeSettings(ch.settings.newValue); onSettings(); }
    });
  } catch (e) { /* ignore */ }

  /* ============================================================ video events (generic sites) */
  let scanTimer = 0;
  function onVideoEvent(e) {
    if (!(e.target instanceof HTMLVideoElement)) return;
    if (e.type === 'play') lastPlaying = e.target;
    refreshLink();
    if (!isYT) { clearTimeout(scanTimer); scanTimer = setTimeout(() => scanTracks(false), 800); }
    if (shouldShow()) render();
  }
  ['loadedmetadata', 'play', 'seeked'].forEach((n) => document.addEventListener(n, onVideoEvent, true));
  document.addEventListener('DOMContentLoaded', () => { refreshLink(); if (!isYT) setTimeout(() => scanTracks(false), 1200); });

  /* ============================================================ popup API */
  function densityOf(cues) {
    if (!cues || !cues.length) return null;
    const dur = Math.max(...cues.map((c) => c.e)) || 1;
    const cols = new Array(COLS).fill(0);
    for (const c of cues) cols[Math.min(COLS - 1, Math.floor(c.s / dur * COLS))] += c.t.length;
    const max = Math.max(...cols) || 1;
    return { dur, cols: cols.map((x) => x / max) };
  }
  function pageState() {
    const id = identity();
    const v = pickVideo();
    const src = activeSource();
    return {
      ok: true, isYT, hasVideo: !!v, title: pageTitle(), videoKey: id ? id.videoKey : null, jobKey,
      overlayVisible, target: GST.targetInfo(settings), activeSourceId,
      sources: Array.from(sources.values()).map((s) => ({ id: s.id, label: s.label, count: s.cues.length, asr: s.kind === 'asr', yt: !!s.tlang })),
      srcHash: src ? src.srcHash : null, density: (!job && src) ? densityOf(src.cues) : null,
      t: v ? v.currentTime * 1000 : 0, ccButton: isYT && !!document.querySelector('.ytp-subtitles-button'),
    };
  }

  async function startTranslation(m) {
    let src = activeSource();
    if (!src && isYT) { await ensureYtCaptions(); src = activeSource(); }
    if (!src) { await scanTracks(true); src = activeSource(); }
    if (!src) return { ok: false, error: 'no-source' };
    await refreshLink();
    if (!jobKey) return { ok: false, error: 'no-video' };
    const meta = {
      videoKey: (identity() || {}).videoKey, title: pageTitle(), pageUrl: location.href,
      srcLabel: src.label, srcLang: src.lang || '', srcKind: src.kind || '', srcHash: src.srcHash,
    };
    const r = await GST.rpc({
      type: 'bg:job:start', key: jobKey, restart: !!m.restart, run: m.run !== false, meta,
      cues: src.cues.map((c) => [c.s, c.e, c.t]),
    });
    if (!r || !r.ok) return r || { ok: false, error: 'No answer from the extension.' };
    if (m.run !== false) overlayVisible = true;
    await reloadJob();
    return r;
  }

  async function handle(m) {
    switch (m.type) {
      case 'gst:state': return pageState();
      case 'gst:tick': { const v = pickVideo(); return { ok: true, t: v ? v.currentTime * 1000 : 0, vis: overlayVisible }; }
      case 'gst:setOverlay': overlayVisible = !!m.visible; lastKey = null; render(); return { ok: true, vis: overlayVisible };
      case 'gst:selectSource': if (sources.has(m.id)) activeSourceId = m.id; return pageState();
      case 'gst:start': return startTranslation(m);
      case 'gst:enableCaptions': { const ok = await ensureYtCaptions(); await refreshLink(); const s = pageState(); s.captured = ok; return s; }
      case 'gst:rescan': await scanTracks(true); return pageState();
      case 'gst:seek': { const v = pickVideo(); if (v) v.currentTime = Math.max(0, m.ms / 1000); return { ok: true }; }
      default: return { ok: false, error: 'unknown' };
    }
  }
  try {
    ext.runtime.onMessage.addListener((m, sender, sendResponse) => {
      if (!m || typeof m.type !== 'string' || !m.type.startsWith('gst:')) return false;
      // Only frames that actually hold a video / captions answer, so the right frame wins.
      if (!pickVideo() && !sources.size && !(isYT && identity())) return false;
      handle(m).then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;
    });
  } catch (e) { /* ignore */ }
})();
