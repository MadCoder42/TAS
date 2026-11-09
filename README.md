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
5. Visit the same video later: the popup says *Translated*; flip *Show subtitles* to load it from storage.
   An unfinished job continues from the first unfinished block.

## How it works

| File | Role |
|---|---|
| `inject.js` | MAIN-world hook of `fetch` / `XMLHttpRequest`. Sees the signed timedtext response the player already received and forwards it. |
| `lib/captions.js` | **Timedtext to SRT.** Parses YouTube `pb3`/`json3` (incl. ASR rolling captions with `aAppend` newline events and overlapping durations), srv1/srv3 XML, TTML, VTT, SRT, generic JSON; builds SRT. |
| `content.js` | Ingests captures, mirrors the cached/live job, draws the overlay in a Shadow DOM (fullscreen aware), answers the popup. |
| `background.js` | Translation engine: prompt, chunking, key fallback on 429, retries, cool-down, per-block persistence, pause/resume/cancel. |
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
* API keys live in `storage.local` and are only ever sent to `generativelanguage.googleapis.com`
  (via the `x-goog-api-key` header). Subtitle text is sent to Gemini; nothing else leaves the browser.

Limitations: video fullscreen on sites that fullscreen the bare `<video>` element cannot show page
overlays; HLS subtitle playlists (segmented VTT) and DRM players that do not expose text tracks are not captured.

Fonts: Bricolage Grotesque and Vazirmatn (SIL OFL 1.1), bundled in `ui/fonts`.
