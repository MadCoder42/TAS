# TAS: Translate Any Subtitle (Chrome + Firefox, Manifest V3)

Finds the subtitles a video loads (YouTube `timedtext` and any other site that fetches
VTT / SRT / TTML / JSON captions or uses `<track>`), converts them to SRT, translates them
block by block with Gemini, and draws the result over the `<video>`.

## Install

**Chrome / Edge / Brave:** unzip, open `chrome://extensions`, enable *Developer mode*,
*Load unpacked*, choose this folder.

**Firefox (128+):** `about:debugging#/runtime/this-firefox` -> *Load Temporary Add-on* -> pick `manifest.json`.
If nothing happens on a page, open `about:addons` -> TAS -> *Permissions* and allow access to all sites.
(Permanent install needs the add-on signed through AMO; the `gecko.id` in the manifest is a placeholder.)

Then open the settings (they open on first install), paste a Gemini API key from
https://aistudio.google.com/apikey and press *Fetch models*.

## Use

1. Open a video. On YouTube press **Capture captions** in the popup (it switches CC on for a moment so the
   player requests the track) or just turn CC on yourself.
2. Press **Translate**. Each block appears on the video the moment it is translated.
3. **Pause / Resume / Cancel** are in the popup. Cancel also deletes the saved data for that video.
4. The **Blocks** tab (or the expand button for a full-tab view) lets you edit any line, translate or
   retranslate one block, and download an `.srt` (translated, bilingual or original).
5. **Move the subtitle on the page:** press and drag the subtitle text on the video to place it where you want.
   This only affects the page you are on: it is kept in memory, not saved to settings, and it is dropped when you
   open another video, reload the page, change the saved position in settings, or double-click the subtitle.
   The position in *Settings > Subtitle display* is the saved default for every page.
6. **Maximum width:** *Settings > Subtitle display > Maximum width* sets how much of the video's width a subtitle line may use
   (30 to 100 %, default 92). Raise it to keep words on one line instead of wrapping; lower it for narrower, taller blocks.
   The preview shows the result live. The limit is measured from the video, so it behaves the same wherever you drag the subtitle.
7. Visit the same video later: the popup says *Translated*; flip *Show subtitles* to load it from storage.
   An unfinished job continues from the first unfinished block.

## How it works

| File | Role |
|---|---|
| `inject.js` | MAIN-world hook of `fetch` / `XMLHttpRequest`. Sees the signed timedtext response the player already received and forwards it. |
| `lib/captions.js` | **Timedtext to SRT.** Parses YouTube `pb3`/`json3` (incl. ASR rolling captions with `aAppend` newline events and overlapping durations), srv1/srv3 XML, TTML, VTT, SRT, generic JSON; builds SRT. |
| `content.js` | Ingests captures, mirrors the cached/live job, draws the overlay in a Shadow DOM (fullscreen aware, subtitle draggable per page), answers the popup. |
| `background.js` | Translation engine: prompt, chunking, key fallback on 429, retries, cool-down, per-block persistence, pause/resume/cancel, encrypted key store. |
| `lib/vault.js` | AES-GCM encryption with the non-extractable device key (loaded by the background only). |
| `popup/` | Overview, subtitle-density strip, block manager, download. |
| `options/` | Translation settings, display settings (live, draggable preview), cache. |

Notes

* Scrolling captions are flattened: a rolling line is closed when the next one starts, repeated lines from
  2-line windows are dropped, and no cue is ever on screen once the next one begins. The overlay shows one
  sentence at a time (your sample converts to 30 clean cues). Translations cached before this fix are repaired on load.
* *Overlapping context* is on by default (settings saved before this default existed are switched on once).
* Block boundaries are fixed when a job is created, so changing *Lines per block* later does not
  corrupt an unfinished job; it applies to the next new translation.
* Direction is forced with `dir="rtl"` + `unicode-bidi: isolate`, so a sentence that starts with an
  English word stays right-to-left. RTL target languages switch the direction automatically.
* *Explicit translation* adds a faithful-translation instruction and sets the adjustable Gemini safety
  categories to `BLOCK_NONE`. Google's non-adjustable protections still apply.
* Subtitle text is sent to Gemini; nothing else leaves the browser. API keys are only ever sent to
  `generativelanguage.googleapis.com` (via the `x-goog-api-key` header).

## API key security

* Keys are encrypted with **AES-256-GCM** (WebCrypto) before they are written to storage, each with a fresh random IV,
  and bound to their record id so ciphertexts cannot be swapped. Tampering is detected.
* The AES key is created once as a **non-extractable** `CryptoKey` kept in IndexedDB: no code, including this
  extension's own, can read its raw bytes; it can only ask the browser to encrypt or decrypt.
* A key is **decrypted only inside the background script, right before a request**, used for that one call and not
  kept. The popup, settings page and content scripts never receive a key or ciphertext, only `{label, last 4 characters}`.
  Key management messages are refused from content scripts.
* Keys live in their own `vault` record, not in `settings`, so content scripts (which read settings) never see them.

What this does and does not protect against: it keeps keys out of storage exports, backups, sync and any
copy of the extension's storage files, and it makes a stored key useless without the browser's IndexedDB key.
It does **not** stop someone who has your whole unlocked browser profile or can run code inside the extension,
because the device key has to be usable without asking you for anything. If you clear the browser's site/extension data,
the device key is lost; affected keys then show *Re-enter key*. Keys are tied to this browser profile and do not sync.
If an older version stored a key in plaintext, remnants can linger in the browser's internal database files until
they are compacted; rotate that key in Google AI Studio if that matters to you.

Limitations: video fullscreen on sites that fullscreen the bare `<video>` element cannot show page
overlays; HLS subtitle playlists (segmented VTT) and DRM players that do not expose text tracks are not captured.

Fonts: Bricolage Grotesque and Vazirmatn (SIL OFL 1.1), bundled in `ui/fonts`.
