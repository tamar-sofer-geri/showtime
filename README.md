# 🎟️ Showtime

A mobile-friendly PWA to keep track of tickets you've bought and see what's coming up. No build step — plain HTML/CSS/JavaScript, deployable to GitHub Pages, installable to your home screen, and works offline.

Two tabs, switched via the bottom bar:

- **Upcoming** — sorted soonest first, with a countdown badge (Today! / Tomorrow / In N days). Shows within 7 days get a highlighted orange card as an in-app reminder.
- **Past** — sorted most recent first.

Tap **+** to add a ticket: show/event name, venue, date & time (24-hour, quarter-hour increments), price paid, seat/section, where you bought it, confirmation number, and any number of photos/PDFs of the actual tickets (useful when an order has multiple physical tickets, each with its own QR code — attach them all to the one event). On a ticket card: a short tap opens **Edit**; press and hold opens the attached file directly (or, with more than one attached, a small picker to choose which), without going through Edit first; a right swipe past ~40% of the card's width deletes it, with a 3-second **Undo** bar before the deletion is actually committed.

All data — including attached photos/PDFs — is stored locally on-device in IndexedDB. Nothing leaves the device; there's no backend or sync (yet).

Long-pressing a PDF attachment tries to open it immediately (a real navigation to its `blob:` URL, not an embedded `<iframe>` — Android Chrome doesn't reliably render PDFs inline in an iframe, falling back to a confusing generic "open externally" prompt instead). Whether the automatic open actually goes through depends on the browser still considering the long-press's delayed callback part of the same user gesture; either way, the viewer modal underneath always shows a clearly labeled "Open <filename>" button as a guaranteed one-tap fallback. Ticket-card thumbnails are `pointer-events: none`, so a long-press routes entirely to the card (opening our own viewer) instead of also triggering Android Chrome's native "Copy/Download/Share image" menu on the `<img>` underneath.

## Reminders

Reminders are in-app only for now: the Upcoming tab surfaces the soonest shows first and highlights anything within a week. Real push notifications (alerts even when the app isn't open) would need a backend and service-worker push subscription — a possible future addition, not built yet.

## Share to Showtime

Once installed to the home screen (Android/Chrome), Showtime registers as an OS **share target**. Forwarding a ticket confirmation email or sharing a screenshot from Photos will offer "Showtime" in the share sheet. Sharing:

1. Sends the shared title/text/URL and any attached image or PDF to `share-target/`.
2. A service worker fetch handler intercepts that request (no backend involved — GitHub Pages is static), stashes the payload in IndexedDB, and redirects to `index.html?shared=1`.
3. On load, the app reads the stash and runs it through a best-effort regex parser (`parseSharedText` in `app.js`) to guess event name, venue, date, time, price, seat/section, purchase source, and confirmation number.
4. If there's at least one existing ticket, it always asks first: create a new ticket, or add this to one you already saved (a picker lists them) — regardless of whether the share included a file, text, or both. With no tickets yet, it skips straight to a new, pre-filled **Add ticket** form.
5. Choosing an existing ticket opens it in Edit with the shared content layered on: any file is appended (existing attachments are never replaced), and parsed text only fills fields that are still blank — so a second, less-detailed share can't overwrite details a more complete first share already got right.

This is heuristic, not OCR/AI — it looks for patterns like `$123.45`, `September 12, 2026`, `7:30 PM`, an explicit `Event` label line, phrases like "confirmation for <event>", known vendor names (Ticketmaster, StubHub, SeatGeek, Eventbrite, etc.), an order/confirmation number, a `City, ST ZIP` line (to infer venue), and `Section X, Row Y, Seat Z` lines. It's been tuned against real Ticketmaster and Eventbrite emails but won't be perfect for every vendor's format — everything is still editable/skippable before saving. Some sites (single-page apps whose ticket screen loads its content via JavaScript after the page opens) won't offer any real text or image to share at all — sharing just sends the page URL, which parses to nothing useful. The "new or existing" prompt still helps there: create the ticket from the confirmation email as usual, then route a plain OS screenshot of the ticket screen to the same entry instead of ending up with an empty duplicate.

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
| `index.html` | Header, Upcoming/Past views, bottom tab bar, add/edit modal, attachment viewer |
| `styles.css` | Purple theme, mobile-first styling |
| `app.js` | IndexedDB storage (tickets + attachments), rendering, countdown logic, shared-content parsing |
| `sw.js` | Service worker for offline app-shell caching and handling incoming shares |
| `share-target/index.html` | Static fallback if a share reaches the app before the service worker is active |
| `manifest.webmanifest`, `icon.svg`, `apple-touch-icon.png` | Home-screen install support, share target registration |

## Bumping the cache version

`sw.js` caches `styles.css`, `app.js`, etc. by their `?v=N` query string. When you change either file, bump the `?v=` in both `index.html` and the `ASSETS` list in `sw.js`, and bump `CACHE` in `sw.js` — otherwise installed/offline users may keep seeing the old version.
