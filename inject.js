/* TAS - page-world network observer (runs in the page's MAIN world at document_start).
 *
 * YouTube signs its timedtext URLs (the `pot` token), so re-requesting them from the extension
 * fails. Instead we watch the player's own fetch()/XHR calls and forward the response body that
 * already arrived. The same trick finds .vtt / .srt / .ttml files on other video sites.
 * Nothing leaves the page here: data goes to the extension's content script via postMessage.
 */
(() => {
  'use strict';
  if (window.__gstHooked) return;
  window.__gstHooked = true;

  const URL_RE = /timedtext|\.(?:vtt|srt|ttml|dfxp|webvtt|sbv|xml|json)(?:[?#]|$)|subtitle|caption|transcript|texttrack/i;
  const SKIP_CT = /^(?:video|audio|image|font)\//i;
  const MAX_LEN = 8 * 1024 * 1024;

  const looksLikeCaptions = (t) => {
    const h = t.slice(0, 2000).replace(/^\uFEFF/, '').trimStart();
    if (/^WEBVTT/.test(h)) return true;
    if (h[0] === '{' || h[0] === '[') return /"(?:events|wireMagic|segs|tStartMs|cues|captions|subtitles|start|startTime|begin)"/.test(h);
    if (h[0] === '<') return /<(?:timedtext|transcript|tt)[\s>]/i.test(h);
    return h.includes('-->');
  };
  const send = (url, body, ct) => {
    try {
      if (typeof body !== 'string' || body.length < 20 || body.length > MAX_LEN) return;
      if (!looksLikeCaptions(body)) return;
      window.postMessage({ __gst: 'caption', url: String(url), body, ct: ct || '' }, '*');
    } catch (e) { /* ignore */ }
  };

  // ---- fetch
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (...args) {
      const p = origFetch.apply(this, args);
      try {
        const a0 = args[0];
        const url = typeof a0 === 'string' ? a0 : (a0 && a0.url) || String(a0);
        if (URL_RE.test(url)) {
          p.then((res) => {
            try {
              const ct = res.headers.get('content-type') || '';
              if (SKIP_CT.test(ct)) return;
              const len = parseInt(res.headers.get('content-length') || '0', 10);
              if (len > MAX_LEN) return;
              res.clone().text().then((t) => send(res.url || url, t, ct)).catch(() => {});
            } catch (e) { /* ignore */ }
          }).catch(() => {});
        }
      } catch (e) { /* ignore */ }
      return p;
    };
  }

  // ---- XMLHttpRequest
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url, ...rest) {
      try { this.__gstUrl = String(url); } catch (e) { /* ignore */ }
      return origOpen.call(this, method, url, ...rest);
    };
    XHR.prototype.send = function (...args) {
      try {
        if (this.__gstUrl && URL_RE.test(this.__gstUrl)) {
          this.addEventListener('load', () => {
            try {
              const ct = this.getResponseHeader('content-type') || '';
              if (SKIP_CT.test(ct)) return;
              const rt = this.responseType;
              if (rt === '' || rt === 'text') send(this.responseURL || this.__gstUrl, this.responseText, ct);
              else if (rt === 'json' && this.response) send(this.responseURL || this.__gstUrl, JSON.stringify(this.response), ct);
              else if (rt === 'arraybuffer' && this.response && this.response.byteLength < MAX_LEN) {
                send(this.responseURL || this.__gstUrl, new TextDecoder('utf-8').decode(this.response), ct);
              }
            } catch (e) { /* ignore */ }
          });
        }
      } catch (e) { /* ignore */ }
      return origSend.apply(this, args);
    };
  }
})();
