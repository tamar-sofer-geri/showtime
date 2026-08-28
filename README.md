# 🎟️ Showtime

A mobile-friendly PWA to keep track of tickets you've bought and see what's coming up. No build step — plain HTML/CSS/JavaScript, deployable to GitHub Pages, installable to your home screen, and works offline.

Two tabs, switched via the bottom bar:

- **Upcoming** — sorted soonest first, with a countdown badge (Today! / Tomorrow / In N days). Shows within 7 days get a highlighted orange card as an in-app reminder.
- **Past** — sorted most recent first.

Tap **+** to add a ticket: show/event name, venue, date & time (24-hour, quarter-hour increments), price paid, seat/section, where you bought it, confirmation number, and an optional photo/PDF of the actual ticket (which typically has the barcode on it already). On a ticket card: a short tap opens **Edit**; press and hold opens the attached ticket photo/PDF directly, without going through Edit first.

All data — including the attached ticket photo/PDF — is stored locally on-device in IndexedDB. Nothing leaves the device; there's no backend or sync (yet).

## Reminders

Reminders are in-app only for now: the Upcoming tab surfaces the soonest shows first and highlights anything within a week. Real push notifications (alerts even when the app isn't open) would need a backend and service-worker push subscription — a possible future addition, not built yet.

## Share to Showtime

Once installed to the home screen (Android/Chrome), Showtime registers as an OS **share target**. Forwarding a ticket confirmation email or sharing a screenshot from Photos will offer "Showtime" in the share sheet. Sharing:

1. Sends the shared title/text/URL and any attached image or PDF to `share-target/`.
2. A service worker fetch handler intercepts that request (no backend involved — GitHub Pages is static), stashes the payload in IndexedDB, and redirects to `index.html?shared=1`.
3. On load, the app reads the stash, runs it through a best-effort regex parser (`parseSharedText` in `app.js`) to guess date, time, price, purchase source, and confirmation number, and opens the **Add ticket** form pre-filled with whatever it found plus the attachment already attached.

This is heuristic, not OCR/AI — it looks for patterns like `$123.45`, `September 12, 2026`, `7:30 PM`, known vendor names (Ticketmaster, StubHub, SeatGeek, etc.), and an order/confirmation number near those words. The **event name** is taken from the share's title (usually the email subject), which is often not the show name — that field in particular usually needs a quick manual fix. Venue isn't guessed at all. Everything is still editable/skippable before saving.

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
