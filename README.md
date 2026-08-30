# 🎟️ Showtime

A mobile-friendly PWA to keep track of tickets you've bought and see what's coming up. No build step — plain HTML/CSS/JavaScript, deployable to GitHub Pages, installable to your home screen, and works offline.

Three tabs, switched via the bottom bar:

- **Upcoming** — has-a-ticket events, sorted soonest first, with a countdown badge (Today! / Tomorrow / In N days). Shows within 7 days get a highlighted orange card as an in-app reminder.
- **Planned** — want to attend, no ticket bought yet. Sorted the same way as Upcoming; its ticket icon renders as a white silhouette instead of filled purple, so it's visually obvious at a glance which shows still need a ticket. This is automatic, not a checkbox: an event lands here as long as it has no photo/PDF attached, and moves itself into Upcoming/Past (based on its date) the moment you attach one. Gets its own orange highlight + 🔔 reminder label as the date approaches — see "Reminders" below. For tickets that can *never* have a file — some vendors only show a live/rotating barcode inside their own app, nothing screenshot-able or downloadable — a left swipe in Planned moves it to Upcoming manually (with the same 3-second Undo as delete), setting an internal `ticketConfirmed` flag that short-circuits the file check.
- **Past** — sorted most recent first.

Tap **+** to add an event: show/event name, venue, date & time (24-hour, quarter-hour increments), price paid, seat/section, where you bought it, confirmation number, a link to view the ticket elsewhere (for the live-barcode case above — e.g. a link that opens the vendor's app), and any number of photos/PDFs of the actual tickets (useful when an order has multiple physical tickets, each with its own QR code — attach them all to the one event). The Add/Edit form has an **×** in the top-right corner to close it; if you've changed anything since opening the form, it asks first (**Save** / **Discard changes** / **Keep editing**) instead of silently dropping your edits — the same prompt appears for the backdrop and **Cancel** too, not just the ×. Every ticket card shows a consistent ticket icon (not a preview of the attached file — kept deliberately uniform rather than a per-file thumbnail), plus a small count badge when more than one file is attached, or a 🔗 badge instead when there's a ticket link but no file. It's the same 🎟️ used in the tab bar: recolored purple (`filter: hue-rotate(265deg) saturate(2.5) brightness(0.8)`, tuned against the app's actual purple) for a ticket in hand, or crushed to a solid white silhouette (`filter: brightness(0) invert(1)` — a clean way to recolor any fixed-color glyph, since there's no `fill`/`color` to override directly) for a planned-but-ticketless event — same artwork, different filter, same idea as the purple recolor. On a ticket card: a short tap opens **Edit**; press and hold opens the attached file(s) in a full-size viewer (or the ticket link in a new tab, if there's no file to show) — swipeable left/right between files with page dots when there's more than one, native horizontal scroll-snap rather than custom gesture code — without going through Edit first; a right swipe past ~40% of the card's width deletes it, with a 3-second **Undo** bar before the deletion is actually committed. The same swipeable viewer opens from tapping a thumbnail in the Edit form's file list too, starting on whichever file was tapped.

By default, all data — including attached photos/PDFs — is stored locally on-device in IndexedDB, nothing leaves the device. Optionally, a device can instead join a **shared family list** synced live across everyone who has the code — see "Family sharing" below.

PDF attachments render fully inside the app's own viewer modal via a vendored copy of [pdf.js](https://mozilla.github.io/pdf.js/) (`vendor/pdfjs/`, Mozilla, Apache 2.0) — each page is drawn onto a `<canvas>`, no navigation and no native browser/OS PDF viewer involved. Two lighter approaches were tried first and both hit real platform limitations: embedding via `<iframe>` doesn't render inline on Android Chrome (it falls back to a confusing "open externally" prompt), and a real navigation to the PDF's `blob:` URL renders correctly but takes over the whole installed-PWA window with no reliable way back to the app short of the OS back gesture. Rendering the PDF ourselves sidesteps both — the same close button always works, nothing ever leaves the app. `pdf.min.mjs` is lazy-loaded (dynamic `import()`) only when a PDF is actually viewed, so it doesn't add to the initial page weight; the service worker's normal runtime caching picks it up for offline use after that first view, rather than it being precached upfront for everyone. Images inside the carousel viewer are `pointer-events: none`, so a long-press routes entirely to the card underneath (opening our own viewer) instead of also triggering Android Chrome's native "Copy/Download/Share image" menu on the `<img>` itself.

## Reminders

Reminders are in-app only — there's no backend, so nothing can alert you while the app is closed. Instead:

- **Upcoming** surfaces the soonest shows first and highlights anything within a week.
- **Planned** events (no ticket bought yet) get a ticket-purchase reminder that escalates as the date approaches: 1 month out, 2 weeks out, 1 week out, and 2 days out (or "show already happened" if the date's passed and you never got a ticket). Once inside the 1-month window the card gets the same orange highlight as an imminent Upcoming show, plus a 🔔 label naming the current tier — visible whenever you open the app. There's nothing to "cancel": the moment you attach a file the event moves to Upcoming and the reminder logic no longer applies to it (see `reminderTier` in `app.js`).

Real push notifications (alerts even when the app isn't open) would need a backend to store your planned events and a service-worker push subscription to send them on schedule — a real architecture change from the current fully-local design, not built.

## Family sharing

Showtime is a public static site with no login wall, so it starts every device with a choice (⚙️ in the header re-opens this later): **create a family**, **join a family** with a code someone shared, or **use it on this device only** (the original, fully local behavior — nothing below applies).

- **How it works:** Firebase (Firestore + Storage + Anonymous Auth), loaded from Google's CDN via plain `<script>` tags — no build step, no server code to run or maintain. Creating a family generates a short code (e.g. `CYGP44V5`) and signs the device in anonymously (a quiet per-device identity, no visible login); joining does the same against an existing code. From then on this device's tickets live in Firestore under `families/{code}/tickets` instead of IndexedDB, synced live via `onSnapshot` — add, edit, attach a file, or delete on one device and it shows up on every other device on the same code within moments, no manual refresh. Everyone on a code can add/edit/delete freely, like a shared Google Doc.
- **Why a code, not accounts:** since the site has no login wall, pointing every install at one fixed collection would let a stranger who found the URL see someone else's private list. The code scopes each family to its own Firestore path — knowing the code *is* the access control, same trust model as an unlisted Google Doc link. There's no way to list or guess valid codes from the client.
- **Photos/PDFs:** uploaded to Firebase Storage under the same family code rather than stored inline; the ticket document keeps a download URL + storage path instead of a raw blob. Removing a file (or the whole ticket) cleans up its Storage object too.
- **Inviting people:** the ⚙️ panel's **Invite** button uses `navigator.share()` (lets you pick Mail/Messages/WhatsApp/whatever) with a `mailto:` fallback — it just pre-fills a message with the code, you still hit send yourself. No backend email-sending, which would need Cloud Functions and a paid plan.
- **Migrating existing local tickets:** creating a family (not joining) offers to copy any tickets already on that device into the new shared list, uploading their files to Storage in the process, then clears them from local IndexedDB.
- **Offline:** Firestore's local persistence cache means the app still opens with the last-synced data when offline; writes made offline queue and sync once back online.
- **`sw.js` deliberately ignores every non-same-origin request** (`if (url.origin !== self.location.origin) return;`) — Firestore's live-sync connections must never be intercepted by the offline cache-first handler built for this app's own static assets, or the sync stream can hang/break.
- **Firebase console setup** (one-time, in the project this points at): Firestore Database + Storage both created (Storage requires the pay-as-you-go **Blaze** plan as of late 2024 — still free at this usage level, but needs a card on file), **Anonymous** enabled under Authentication → Sign-in method, and matching security rules published for both Firestore and Storage scoping access to `families/{code}/...` for any authenticated (anonymous is fine) request.

## Share to Showtime

Once installed to the home screen (Android/Chrome), Showtime registers as an OS **share target**. Forwarding a ticket confirmation email or sharing a screenshot from Photos will offer "Showtime" in the share sheet. Sharing:

1. Sends the shared title/text/URL and any attached image or PDF to `share-target/`.
2. A service worker fetch handler intercepts that request (no backend involved — GitHub Pages is static), stashes the payload in IndexedDB, and redirects to `index.html?shared=1`.
3. On load, the app reads the stash and runs it through a best-effort regex parser (`parseSharedText` in `app.js`) to guess event name, venue, date, time, price, seat/section, purchase source, and confirmation number.
4. If there's at least one existing ticket, it always asks first: create a new ticket, or add this to one you already saved (a picker lists them) — regardless of whether the share included a file, text, or both. With no tickets yet, it skips straight to a new, pre-filled **Add event** form.
5. Choosing an existing ticket opens it in Edit with the shared content layered on: any file is appended (existing attachments are never replaced), and parsed text only fills fields that are still blank — so a second, less-detailed share can't overwrite details a more complete first share already got right.

This is heuristic, not OCR/AI — it looks for patterns like `$123.45`, `September 12, 2026`, `7:30 PM`, an explicit `Event` label line, phrases like "confirmation for <event>", known vendor names (Ticketmaster, StubHub, SeatGeek, Eventbrite, etc.), an order/confirmation number, a `City, ST ZIP` line (to infer venue), and `Section X, Row Y, Seat Z` lines. When none of that ticketing-email phrasing is present — e.g. plain text copied from a venue page or listing, formatted as just event name / optional details / date & time / venue, one per line — it falls back to reading the line right before the date as the event name and the line right after it as the venue. It's been tuned against real Ticketmaster and Eventbrite emails but won't be perfect for every vendor's format — everything is still editable/skippable before saving. Some sites (single-page apps whose ticket screen loads its content via JavaScript after the page opens) won't offer any real text or image to share at all — sharing just sends the page URL, which parses to nothing useful. The "new or existing" prompt still helps there: create the ticket from the confirmation email as usual, then route a plain OS screenshot of the ticket screen to the same entry instead of ending up with an empty duplicate.

**Attaching a ticket's QR code separately:** many apps' native ticket screens (e.g. the Eventbrite app) aren't regular web text, so sharing from there carries the image but little to no usable text. The email, by contrast, has selectable text but no image. To get both on one ticket: share the confirmation email first (creates the ticket with full details), then take a plain OS screenshot of each QR code screen and share those to Showtime — since a ticket already exists, you'll be offered "Add to existing ticket" instead of creating a duplicate. This also covers orders with multiple physical tickets (e.g. Eventbrite only lets you share one at a time): attach each one to the same ticket in turn, rather than ending up with a separate Showtime entry per ticket.

**Caveats:**
- Share targets are an Android/Chrome (and Chromium browsers) feature — iOS Safari doesn't support the Web Share Target API, so this won't appear in iOS's share sheet.
- The app must have been opened at least once (so the service worker installs) before Android will offer it as a share target.
- After any change to `sw.js`/`app.js`, reinstalling or waiting for the service worker to update is needed for the share target to reflect it — see "Bumping the cache version" below.

## Run locally

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Deploy to GitHub Pages

1. Create a new GitHub repo and push this folder to it.
2. In the repo's **Settings → Pages**, set the source to the `main` branch, root folder.
3. The `.nojekyll` file is already included so GitHub Pages serves the files as-is.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Header, Upcoming/Planned/Past views, bottom tab bar, add/edit modal, attachment viewer |
| `styles.css` | Purple theme, mobile-first styling |
| `app.js` | Storage (IndexedDB locally, or Firestore/Storage when a family is joined), rendering, countdown logic, shared-content parsing |
| `sw.js` | Service worker for offline app-shell caching and handling incoming shares |
| `share-target/index.html` | Static fallback if a share reaches the app before the service worker is active |
| `manifest.webmanifest`, `icon.svg`, `apple-touch-icon.png`, `icon-maskable.svg`/`.png` | Home-screen install support, share target registration |

## Bumping the cache version

`sw.js` caches `styles.css`, `app.js`, etc. by their `?v=N` query string. When you change either file, bump the `?v=` in both `index.html` and the `ASSETS` list in `sw.js`, and bump `CACHE` in `sw.js` — otherwise installed/offline users may keep seeing the old version.

## The Android home-screen icon specifically

Two things had to be true before the icon looked right on a real device, neither obvious from a desktop browser:

1. **No self-rounding.** `icon.svg`'s background used to be a rounded rect (`rx="14"`). Android applies its own adaptive-icon mask (a circle, on most launchers) regardless of what shape you hand it — a pre-rounded icon leaves a gap between its own corners and the mask's, which renders as white. The background is a full-bleed square now; let the OS do the only actual rounding.
2. **A `purpose: "maskable"` icon.** Without one, Chrome doesn't trust that an icon is safe to bleed to the mask's edges, so it insets it and pads the remainder with white — exactly the "purple square inside a white circle" look. `icon-maskable.svg`/`.png` is a separate, simpler variant (background + star, no marquee bulbs — there wasn't safe-zone room for them at a star worth keeping) with everything kept inside Android's ~61%-of-half-width safe-zone circle, so it can bleed fully without clipping under any mask shape. `icon.svg` itself is unchanged for its other uses (header logo, favicon) where none of this applies.

Installed-app icons don't refresh from a reload or even a service-worker update — Android caches the generated icon separately. Removing the app from the home screen and re-adding it is the reliable way to see an icon change take effect.
