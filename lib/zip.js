/* TAS - minimal ZIP writer (classic script; attaches to globalThis.GST).
 *
 *   GST.zip([{ name: 'a.srt', data: 'text or Uint8Array' }, ...]) -> Promise<Blob>
 *
 * No dependencies. Entries are deflated when the browser has CompressionStream (Chrome 103+, Firefox 113+) and the
 * result is smaller; otherwise they are stored as they are. Names are written as UTF-8 (flag bit 11), so Persian or
 * Arabic titles survive. No ZIP64: the limits are 65,535 entries and 4 GB, far beyond a pile of subtitle files.
 */
(function (G) {
  'use strict';
  const GST = G.GST = G.GST || {};

  let table = null;
  function crc32(u8) {
    if (!table) {
      table = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
      }
    }
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = table[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /** Raw deflate of u8, or null when the browser cannot do it. */
  async function deflateRaw(u8) {
    try {
      if (typeof CompressionStream === 'undefined') return null;
      const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) { return null; }
  }

  function dosStamp(d) {
    const y = Math.max(1980, d.getFullYear());
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  GST.zip = async (entries) => {
    if (entries.length > 0xffff) throw new Error('Too many files for one zip');
    const enc = new TextEncoder();
    const { time, date } = dosStamp(new Date());
    const parts = [], central = [];
    let offset = 0;

    for (const e of entries) {
      const name = enc.encode(e.name);
      const raw = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
      const crc = crc32(raw);
      let body = raw, method = 0;
      const packed = raw.length ? await deflateRaw(raw) : null;
      if (packed && packed.length < raw.length) { body = packed; method = 8; }

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);          // version needed
      local.setUint16(6, 0x0800, true);      // UTF-8 names
      local.setUint16(8, method, true);
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, body.length, true);
      local.setUint32(22, raw.length, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);          // no extra field
      parts.push(new Uint8Array(local.buffer), name, body);

      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true);
      c.setUint16(4, 20, true);              // version made by
      c.setUint16(6, 20, true);              // version needed
      c.setUint16(8, 0x0800, true);
      c.setUint16(10, method, true);
      c.setUint16(12, time, true);
      c.setUint16(14, date, true);
      c.setUint32(16, crc, true);
      c.setUint32(20, body.length, true);
      c.setUint32(24, raw.length, true);
      c.setUint16(28, name.length, true);
      c.setUint32(42, offset, true);         // offset of the local header
      central.push(new Uint8Array(c.buffer), name);

      offset += 30 + name.length + body.length;
    }

    const cdSize = central.reduce((n, p) => n + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
