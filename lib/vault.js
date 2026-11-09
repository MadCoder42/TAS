/* TAS - vault. Loaded ONLY by the background script.
 *
 * API keys are encrypted with AES-256-GCM before they touch storage and are decrypted only at the
 * moment a request is sent.
 *
 *   - The AES key is generated once with extractable = false and kept in IndexedDB as a CryptoKey
 *     object. Nothing (including this extension's own code) can read its raw bytes; code can only ask
 *     the browser to encrypt/decrypt with it.
 *   - Every ciphertext uses a fresh random 96-bit IV and is bound to its record id as additional
 *     authenticated data, so a ciphertext cannot be swapped between records.
 *   - If the IndexedDB key is ever lost (the user cleared "site data"), old ciphertexts fail to
 *     decrypt. Callers treat that as "key unreadable, please re-enter it".
 */
(function (root) {
  'use strict';
  const GST = root.GST || (root.GST = {});
  const DB = 'TAS-vault', STORE = 'keys', REC = 'master';
  const te = new TextEncoder(), td = new TextDecoder();

  const b64 = (buf) => { let s = ''; new Uint8Array(buf).forEach((b) => { s += String.fromCharCode(b); }); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  const openDb = () => new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });

  let keyPromise = null;
  /** Loads the device key, creating it atomically on first use (two contexts racing converge on one key). */
  function masterKey() {
    if (!keyPromise) {
      keyPromise = (async () => {
        const db = await openDb();
        try {
          const fresh = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
          return await new Promise((res, rej) => {
            let result = null;
            const tx = db.transaction(STORE, 'readwrite');
            const st = tx.objectStore(STORE);
            const g = st.get(REC);
            g.onsuccess = () => { if (g.result) result = g.result; else { st.put(fresh, REC); result = fresh; } };
            tx.oncomplete = () => res(result);
            tx.onerror = () => rej(tx.error);
            tx.onabort = () => rej(tx.error || new Error('Vault transaction aborted'));
          });
        } finally { db.close(); }
      })().catch((e) => { keyPromise = null; throw e; });
    }
    return keyPromise;
  }

  GST.vault = {
    /** plain text -> "v1.<iv>.<ciphertext>" (base64). `aad` binds it to a record id. */
    async encrypt(plain, aad) {
      const key = await masterKey();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(String(aad)) }, key, te.encode(plain));
      return `v1.${b64(iv)}.${b64(ct)}`;
    },
    /** Throws when the token is damaged, was bound to another id, or the device key is gone. */
    async decrypt(token, aad) {
      const [v, iv, ct] = String(token).split('.');
      if (v !== 'v1' || !iv || !ct) throw new Error('Unsupported vault record');
      const key = await masterKey();
      const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: te.encode(String(aad)) }, key, unb64(ct));
      return td.decode(buf);
    },
    /** Short one-way fingerprint, only used to spot duplicates without decrypting anything. */
    async fingerprint(plain) {
      const h = await crypto.subtle.digest('SHA-256', te.encode(plain));
      return Array.from(new Uint8Array(h).slice(0, 8)).map((b) => b.toString(16).padStart(2, '0')).join('');
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
