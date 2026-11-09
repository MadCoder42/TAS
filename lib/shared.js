/* TAS - shared helpers (classic script; attaches to globalThis.GST).
 * Loaded by: background, content script, popup and options page. */
(function (root) {
  'use strict';
  const GST = root.GST || (root.GST = {});

  // WebExtension namespace: Firefox exposes `browser`, Chrome exposes `chrome` (promise based in MV3).
  GST.ext = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;

  /* ------------------------------------------------------------------ languages */
  // [code, English name, native name, rtl]
  const L = [
    ['fa', 'Persian (Farsi)', 'فارسی', 1], ['ar', 'Arabic', 'العربية', 1], ['he', 'Hebrew', 'עברית', 1],
    ['ur', 'Urdu', 'اردو', 1], ['ps', 'Pashto', 'پښتو', 1], ['sd', 'Sindhi', 'سنڌي', 1],
    ['ckb', 'Kurdish (Sorani)', 'کوردی', 1], ['ug', 'Uyghur', 'ئۇيغۇرچە', 1], ['yi', 'Yiddish', 'ייִדיש', 1],
    ['dv', 'Dhivehi', 'ދިވެހި', 1],
    ['en', 'English', 'English'], ['es', 'Spanish', 'Español'], ['fr', 'French', 'Français'],
    ['de', 'German', 'Deutsch'], ['it', 'Italian', 'Italiano'], ['pt', 'Portuguese', 'Português'],
    ['pt-BR', 'Portuguese (Brazil)', 'Português (Brasil)'], ['ru', 'Russian', 'Русский'],
    ['uk', 'Ukrainian', 'Українська'], ['pl', 'Polish', 'Polski'], ['nl', 'Dutch', 'Nederlands'],
    ['sv', 'Swedish', 'Svenska'], ['no', 'Norwegian', 'Norsk'], ['da', 'Danish', 'Dansk'],
    ['fi', 'Finnish', 'Suomi'], ['cs', 'Czech', 'Čeština'], ['sk', 'Slovak', 'Slovenčina'],
    ['hu', 'Hungarian', 'Magyar'], ['ro', 'Romanian', 'Română'], ['bg', 'Bulgarian', 'Български'],
    ['el', 'Greek', 'Ελληνικά'], ['hr', 'Croatian', 'Hrvatski'], ['sr', 'Serbian', 'Српски'],
    ['sl', 'Slovenian', 'Slovenščina'], ['lt', 'Lithuanian', 'Lietuvių'], ['lv', 'Latvian', 'Latviešu'],
    ['et', 'Estonian', 'Eesti'], ['is', 'Icelandic', 'Íslenska'], ['ca', 'Catalan', 'Català'],
    ['tr', 'Turkish', 'Türkçe'], ['az', 'Azerbaijani', 'Azərbaycanca'], ['ka', 'Georgian', 'ქართული'],
    ['hy', 'Armenian', 'Հայերեն'], ['kk', 'Kazakh', 'Қазақша'], ['uz', 'Uzbek', 'Oʻzbekcha'],
    ['hi', 'Hindi', 'हिन्दी'], ['bn', 'Bengali', 'বাংলা'], ['ta', 'Tamil', 'தமிழ்'], ['te', 'Telugu', 'తెలుగు'],
    ['mr', 'Marathi', 'मराठी'], ['gu', 'Gujarati', 'ગુજરાતી'], ['pa', 'Punjabi', 'ਪੰਜਾਬੀ'],
    ['ne', 'Nepali', 'नेपाली'], ['si', 'Sinhala', 'සිංහල'], ['th', 'Thai', 'ไทย'],
    ['vi', 'Vietnamese', 'Tiếng Việt'], ['id', 'Indonesian', 'Bahasa Indonesia'], ['ms', 'Malay', 'Bahasa Melayu'],
    ['fil', 'Filipino', 'Filipino'], ['zh-CN', 'Chinese (Simplified)', '简体中文'],
    ['zh-TW', 'Chinese (Traditional)', '繁體中文'], ['ja', 'Japanese', '日本語'], ['ko', 'Korean', '한국어'],
    ['sw', 'Swahili', 'Kiswahili'], ['af', 'Afrikaans', 'Afrikaans'],
  ];
  GST.LANGS = L.map(([code, name, native, rtl]) => ({ code, name, native, rtl: !!rtl }));
  GST.isRtl = (code) => { const l = GST.LANGS.find((x) => x.code === code); return !!(l && l.rtl); };

  /** Resolves the target language described by the settings. */
  GST.targetInfo = (s) => {
    if (s.targetLang === 'custom') {
      const name = (s.customLang || '').trim() || 'English';
      return { code: 'custom:' + name.toLowerCase(), name, rtl: false, custom: true };
    }
    const l = GST.LANGS.find((x) => x.code === s.targetLang) || GST.LANGS[0];
    return { code: l.code, name: l.name, rtl: l.rtl, custom: false };
  };

  /* ------------------------------------------------------------------ tones */
  GST.TONES = [
    { id: 'casual', label: 'Casual', prompt: 'Casual and conversational, like everyday speech.' },
    { id: 'natural', label: 'Natural', prompt: 'Natural and fluent, the way a native speaker would say it.' },
    { id: 'faithful', label: 'Faithful', prompt: 'Faithful and close to the source wording, without sounding stiff.' },
    { id: 'formal', label: 'Formal', prompt: 'Formal and polished; avoid slang and contractions.' },
    { id: 'slang', label: 'Street', prompt: 'Informal, with natural slang and idioms wherever the source is informal.' },
    { id: 'humor', label: 'Playful', prompt: 'Playful and witty; keep jokes and wordplay working in the target language.' },
    { id: 'academic', label: 'Technical', prompt: 'Precise and technical; use standard terminology of the field.' },
    { id: 'literary', label: 'Cinematic', prompt: 'Expressive and cinematic, with emotional register preserved.' },
    { id: 'custom', label: 'Custom', prompt: '' },
  ];

  /* ------------------------------------------------------------------ settings */
  GST.DEFAULTS = {
    model: 'gemini-flash-latest',
    targetLang: 'fa',
    customLang: '',
    tone: 'casual',
    customTone: '',
    extra: '',
    cooldownMs: 5000,
    blockSize: 30,
    retries: 3,
    explicit: false,
    overlap: true, // send the previous block's last 3 lines as context (on by default)
    display: {
      color: '#ffffff',
      bg: '#000000',
      bgOpacity: 0.7,
      x: 50, // % of video width the box is anchored at (0 = left edge, 100 = right edge)
      y: 92, // % of video height the box is anchored at (0 = top edge, 100 = bottom edge)
      dir: 'rtl', // 'rtl' | 'ltr'
      fontSize: 4.4, // % of the video height
      bold: false,
      outline: true,
      hideOriginal: true,
      autoShowCached: false,
    },
  };
  GST.mergeSettings = (s) => {
    const stored = !!(s && Object.keys(s).length);
    const out = Object.assign({}, GST.DEFAULTS, s || {}, { display: Object.assign({}, GST.DEFAULTS.display, (s && s.display) || {}) });
    // v2: "Overlapping context" became on by default. Settings saved before that get it switched on once;
    // as soon as the settings page saves again (v: 2 is stored) the user's own choice is respected.
    if (stored && s.v !== 2) out.overlap = true;
    out.v = 2;
    delete out.keys; // API keys live in the background-only encrypted vault, never in settings
    return out;
  };
  GST.getSettings = async () => {
    const o = await GST.ext.storage.local.get('settings');
    return GST.mergeSettings(o.settings);
  };

  /* ------------------------------------------------------------------ small utils */
  GST.hash = (str, seed = 0) => { // cyrb53
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
      ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  };
  GST.uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  GST.pad = (n, w = 2) => String(n).padStart(w, '0');
  GST.fmtSrtTime = (ms) => {
    ms = Math.max(0, Math.round(ms));
    const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
    return `${GST.pad(h)}:${GST.pad(m)}:${GST.pad(s)},${GST.pad(ms % 1000, 3)}`;
  };
  GST.fmtClock = (ms) => {
    const t = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
    return h ? `${h}:${GST.pad(m)}:${GST.pad(s)}` : `${m}:${GST.pad(s)}`;
  };
  GST.sleep = (ms, signal) => new Promise((res, rej) => {
    if (signal && signal.aborted) return rej(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    const t = setTimeout(done, ms);
    function done() { if (signal) signal.removeEventListener('abort', onAbort); res(); }
    function onAbort() { clearTimeout(t); rej(Object.assign(new Error('Aborted'), { name: 'AbortError' })); }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
  GST.rpc = async (msg) => {
    try { return await GST.ext.runtime.sendMessage(msg); }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  };
  GST.hexToRgba = (hex, a) => {
    const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
    const [r, g, b] = m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0];
    return `rgba(${r},${g},${b},${a})`;
  };
  GST.langName = (code) => {
    try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; } catch (e) { return code; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
