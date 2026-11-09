/* TAS - caption parsing and SRT conversion (classic script; attaches to globalThis.GST).
 *
 * parseCaptions(text) -> { format, cues: [{ s, e, t }] } | null      (times in milliseconds)
 *
 * Supported inputs
 *   - YouTube "timedtext" JSON (wireMagic "pb3", also fmt=json3), including auto-generated
 *     (ASR) rolling captions with `aAppend` newline events and overlapping durations
 *   - YouTube srv1 / srv3 XML, TTML / DFXP
 *   - WebVTT and SRT
 *   - Generic JSON arrays such as [{ start, end, text }]
 */
(function (root) {
  'use strict';
  const GST = root.GST || (root.GST = {});

  /* ------------------------------------------------------------------ text helpers */
  const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', lrm: '\u200e', rlm: '\u200f' };
  const decode = (s) => s.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (m, g) => {
    if (g[0] === '#') {
      const n = (g[1] === 'x' || g[1] === 'X') ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      try { return String.fromCodePoint(n); } catch (e) { return m; }
    }
    const v = NAMED[g.toLowerCase()];
    return v === undefined ? m : v;
  });
  // Collapse whitespace per line, drop empty lines.
  const tidy = (t) => t.replace(/\r/g, '').split('\n')
    .map((l) => l.replace(/[ \t\u00a0\u200b]+/g, ' ').trim()).filter(Boolean).join('\n');

  const parseClock = (str) => {
    str = String(str).trim();
    let m;
    const frac = (f) => (f ? Math.round(parseFloat('0.' + f) * 1000) : 0);
    if ((m = /^(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d+))?$/.exec(str))) return ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + frac(m[4]);
    if ((m = /^(\d+):(\d{1,2})(?:[.,](\d+))?$/.exec(str))) return (+m[1] * 60 + +m[2]) * 1000 + frac(m[3]);
    if ((m = /^([\d.]+)(ms|s|m|h)?$/.exec(str))) {
      const v = parseFloat(m[1]);
      return Math.round(v * ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2] || 's']));
    }
    return NaN;
  };

  /* ------------------------------------------------------------------ YouTube json3 / pb3 */
  function fromJson3(o) {
    const events = Array.isArray(o.events) ? o.events : [];
    // Auto-generated captions are "rolling": every event is one on-screen line, newline events
    // (aAppend = 1, text "\n") mark where the next line starts and durations overlap.
    const isAsr = events.some((e) => e.aAppend === 1 || (e.segs && e.segs.some((g) => 'acAsrConf' in g)));
    const items = [];
    for (const e of events) {
      if (!Array.isArray(e.segs)) continue; // window definition events carry no text
      const start = e.tStartMs | 0;
      const raw = e.segs.map((g) => g.utf8 || '').join('');
      if (!raw.trim()) { items.push({ s: start, marker: true }); continue; }
      items.push({ s: start, e: start + (e.dDurationMs | 0), t: tidy(raw) });
    }
    return rolling(items, isAsr);
  }

  /** Turns raw timed items into cues. For rolling captions a line ends when the next event begins. */
  function rolling(items, isAsr) {
    items.sort((a, b) => a.s - b.s);
    const cues = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.marker) continue;
      let end = it.e;
      if (isAsr) {
        const nxt = items[i + 1];
        if (nxt && nxt.s > it.s && nxt.s < end) end = nxt.s;
      }
      cues.push({ s: it.s, e: end, t: it.t });
    }
    if (isAsr) {
      // Close tiny gaps so lines do not flicker between each other.
      for (let i = 0; i < cues.length - 1; i++) {
        const gap = cues[i + 1].s - cues[i].e;
        if (gap > 0 && gap < 450) cues[i].e = cues[i + 1].s;
      }
    }
    return cues;
  }

  /* ------------------------------------------------------------------ XML (srv1, srv3, TTML) */
  const attr = (src, name) => {
    const m = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'i').exec(src);
    return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
  };
  const xmlText = (inner, twice) => {
    let t = inner.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
    t = decode(t);
    if (twice) t = decode(t);
    return tidy(t);
  };
  function fromXml(text) {
    const items = [];
    let isAsr = false;
    let m;
    if (/<transcript[\s>]/i.test(text) || /<text\b[^>]*\sstart\s*=/i.test(text)) { // srv1
      const re = /<text\b([^>]*?)>([\s\S]*?)<\/text>/gi;
      while ((m = re.exec(text))) {
        const s = Math.round(parseFloat(attr(m[1], 'start')) * 1000);
        const d = Math.round(parseFloat(attr(m[1], 'dur') || '2') * 1000);
        const t = xmlText(m[2], true);
        if (!Number.isNaN(s) && t) items.push({ s, e: s + d, t });
      }
      return rolling(items, false);
    }
    const re = /<p\b([^>]*?)(?:\/>|>([\s\S]*?)<\/p>)/gi; // srv3 + TTML
    while ((m = re.exec(text))) {
      let s, e;
      const t0 = attr(m[1], 't');
      if (t0 !== null) { // srv3: t / d in milliseconds
        s = parseInt(t0, 10); e = s + parseInt(attr(m[1], 'd') || '2000', 10);
        if (attr(m[1], 'a') === '1') isAsr = true;
      } else { // TTML: begin / end / dur
        s = parseClock(attr(m[1], 'begin') || ''); e = parseClock(attr(m[1], 'end') || '');
        if (Number.isNaN(e) && !Number.isNaN(s)) e = s + parseClock(attr(m[1], 'dur') || '2s');
      }
      const t = xmlText(m[2] || '', true); // YouTube sometimes double-encodes (&amp;#39;)
      if (Number.isNaN(s) || Number.isNaN(e)) continue;
      items.push(t ? { s, e, t } : { s, marker: true });
    }
    if (/<s\b[^>]*\sac=/i.test(text)) isAsr = true;
    return rolling(items, isAsr);
  }

  /* ------------------------------------------------------------------ WebVTT / SRT */
  function fromTimed(text) {
    text = text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
    const TIME = /((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;
    const cues = [];
    for (const block of text.split(/\n{2,}/)) {
      const lines = block.split('\n');
      const i = lines.findIndex((l) => TIME.test(l));
      if (i < 0) continue;
      const m = TIME.exec(lines[i]);
      const body = lines.slice(i + 1).join('\n')
        .replace(/<\d{1,2}:\d{2}(?::\d{2})?[.,]\d+>/g, '') // karaoke timestamps
        .replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '');
      const t = tidy(decode(body));
      const s = parseClock(m[1]), e = parseClock(m[2]);
      if (t && !Number.isNaN(s) && !Number.isNaN(e)) cues.push({ s, e, t });
    }
    return cues;
  }

  /* ------------------------------------------------------------------ generic JSON */
  function fromGenericJson(o) {
    let arr = Array.isArray(o) ? o : null;
    if (!arr && o && typeof o === 'object') {
      for (const k of ['subtitles', 'captions', 'cues', 'segments', 'transcript', 'lines', 'items', 'body', 'data']) {
        if (Array.isArray(o[k])) { arr = o[k]; break; }
      }
    }
    if (!arr || !arr.length || typeof arr[0] !== 'object' || !arr[0]) return null;
    const find = (x, keys) => keys.find((k) => x[k] !== undefined && x[k] !== null);
    const K = {
      s: ['start', 'startTime', 'start_time', 'from', 'begin', 'offset', 'tStartMs', 'startMs'],
      e: ['end', 'endTime', 'end_time', 'to', 'stop', 'endMs'],
      d: ['dur', 'duration', 'dDurationMs'],
      t: ['text', 'content', 'caption', 'line', 'utf8', 'value', 'sentence'],
    };
    const ks = find(arr[0], K.s), kt = find(arr[0], K.t);
    if (!ks || !kt) return null;
    const ke = find(arr[0], K.e), kd = find(arr[0], K.d);
    const num = (v) => (typeof v === 'string' && v.includes(':') ? parseClock(v) : parseFloat(v));
    const starts = arr.map((x) => num(x[ks]));
    const looksMs = /ms$/i.test(ks) || (starts.every((v) => Number.isInteger(v)) && Math.max(...starts) > 20000);
    const f = (v) => (looksMs ? v : v * 1000);
    const cues = [];
    arr.forEach((x, i) => {
      const s = starts[i];
      let e = ke ? num(x[ke]) : (kd ? s + num(x[kd]) : NaN);
      if (Number.isNaN(s)) return;
      const t = tidy(String(x[kt] || ''));
      if (!t) return;
      const sMs = typeof x[ks] === 'string' && x[ks].includes(':') ? s : f(s);
      if (Number.isNaN(e)) e = (arr[i + 1] ? num(arr[i + 1][ks]) : s + 2);
      const eMs = (ke && typeof x[ke] === 'string' && x[ke].includes(':')) ? e : f(e);
      cues.push({ s: Math.round(sMs), e: Math.round(eMs), t });
    });
    return cues;
  }

  /* ------------------------------------------------------------------ entry point */
  /**
   * Rolling ("scrolling") captions show a 2-line window that moves up: every new window repeats the
   * previous line. Shown as-is, the old sentence stays on screen when the next one appears. If most
   * multi-line cues start with the previous cue's last line, keep only the lines that are new.
   */
  function dedupeRolling(cues) {
    const lines = cues.map((c) => c.t.split('\n'));
    let multi = 0, hits = 0;
    for (let i = 1; i < cues.length; i++) {
      if (lines[i].length < 2) continue;
      multi++;
      const pl = lines[i - 1];
      if (lines[i][0] === pl[pl.length - 1]) hits++;
    }
    if (multi < 3 || hits / multi < 0.4) return cues;
    const out = [];
    for (let i = 0; i < cues.length; i++) {
      let l = lines[i];
      if (i > 0) {
        const pl = lines[i - 1];
        let k = Math.min(pl.length, l.length);
        while (k > 0 && pl.slice(pl.length - k).join('\n') !== l.slice(0, k).join('\n')) k--;
        if (k > 0) l = l.slice(k);
      }
      if (!l.length) { if (out.length) out[out.length - 1].e = Math.max(out[out.length - 1].e, cues[i].e); continue; }
      out.push({ s: cues[i].s, e: cues[i].e, t: l.join('\n') });
    }
    return out;
  }

  function finalize(cues) {
    cues = cues.filter((c) => c && c.t && Number.isFinite(c.s) && Number.isFinite(c.e));
    cues.sort((a, b) => a.s - b.s);
    // cues that start at the same moment are one on-screen block (e.g. two speakers)
    const merged = [];
    for (const c of cues) {
      if (c.e <= c.s) c.e = c.s + 2000;
      const p = merged[merged.length - 1];
      if (p && p.s === c.s) { if (!p.t.split('\n').includes(c.t)) p.t += '\n' + c.t; p.e = Math.max(p.e, c.e); }
      else merged.push({ s: c.s, e: c.e, t: c.t });
    }
    const out = [];
    for (const c of dedupeRolling(merged)) {
      const p = out[out.length - 1];
      if (p && p.t === c.t && c.s <= p.e + 50) { p.e = Math.max(p.e, c.e); continue; } // exact repeats
      out.push(c);
    }
    // One sentence at a time: a cue never stays on screen once the next one starts.
    for (let i = 0; i < out.length - 1; i++) if (out[i].e > out[i + 1].s) out[i].e = out[i + 1].s;
    return out;
  }

  /** Same guarantee for cues that are already stored ([[s, e, t]]), e.g. translations cached earlier. */
  GST.fixOverlaps = (cues) => {
    for (let i = 0; i < cues.length - 1; i++) if (cues[i][1] > cues[i + 1][0]) cues[i][1] = cues[i + 1][0];
    return cues;
  };

  GST.parseCaptions = (text) => {
    if (typeof text !== 'string' || text.length < 10) return null;
    const head = text.slice(0, 4000).replace(/^\uFEFF/, '').trimStart();
    let cues = null, format = '';
    try {
      if (head[0] === '{' || head[0] === '[') {
        const o = JSON.parse(text);
        if (o && Array.isArray(o.events)) { format = o.wireMagic ? 'pb3' : 'json3'; cues = fromJson3(o); }
        else { format = 'json'; cues = fromGenericJson(o); }
      } else if (head[0] === '<') { format = 'xml'; cues = fromXml(text); }
      else if (head.includes('-->')) { format = /^WEBVTT/.test(head) ? 'vtt' : 'srt'; cues = fromTimed(text); }
    } catch (e) { return null; }
    if (!cues) return null;
    cues = finalize(cues);
    return cues.length ? { format, cues } : null;
  };

  /* ------------------------------------------------------------------ SRT building */
  /** Full SRT for downloading. cues: [[start, end, text]], tr: array of translations (or null). */
  GST.buildSrt = (cues, tr, opts = {}) => {
    const mode = opts.mode || 'translated'; // translated | bilingual | original
    const rlm = opts.rlm ? '\u200f' : '';
    const mark = (t) => (rlm ? t.split('\n').map((l) => rlm + l).join('\n') : t);
    const out = [];
    cues = GST.fixOverlaps(cues.map((c) => c.slice()));
    cues.forEach(([s, e, t], i) => {
      const x = tr && tr[i];
      let body;
      if (mode === 'original' || !x) body = t;
      else if (mode === 'bilingual') body = mark(x) + '\n<i>' + t.replace(/\n/g, ' ') + '</i>';
      else body = mark(x);
      out.push(`${out.length + 1}\n${GST.fmtSrtTime(s)} --> ${GST.fmtSrtTime(e)}\n${body}`);
    });
    return out.join('\n\n') + '\n';
  };

  /** SRT chunk sent to the model. Entry numbers are the global cue index + 1. */
  GST.cuesToSrtBlock = (cues, idxs) => idxs.map((i) =>
    `${i + 1}\n${GST.fmtSrtTime(cues[i][0])} --> ${GST.fmtSrtTime(cues[i][1])}\n${cues[i][2]}`).join('\n\n');

  /** Lenient parser for the SRT the model sends back. Returns [{ id, text }]. */
  GST.parseModelSrt = (text) => {
    text = String(text || '').replace(/\r\n?/g, '\n').replace(/```[a-zA-Z]*\n?/g, '');
    const lines = text.split('\n');
    const run = (needTime) => {
      const out = [];
      let cur = null;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        const isIdx = /^\s*\d+\s*$/.test(l) && (!needTime || (i + 1 < lines.length && /-->/.test(lines[i + 1])));
        if (isIdx) {
          if (cur) out.push(cur);
          cur = { id: parseInt(l, 10), lines: [] };
          if (needTime) i++;
        } else if (cur && !/^=+\s*(END|BEGIN)/i.test(l)) cur.lines.push(l);
      }
      if (cur) out.push(cur);
      return out.map((c) => ({ id: c.id, text: c.lines.join('\n').replace(/\n{2,}/g, '\n').trim() }));
    };
    let r = run(true);
    if (!r.length) r = run(false);
    return r;
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
