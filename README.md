# 🎟️ Showtime

A mobile-friendly PWA to keep track of tickets you've bought and see what's coming up. No build step — plain HTML/CSS/JavaScript, deployable to GitHub Pages, installable to your home screen, and works offline.

Two tabs, switched via the bottom bar:

- **Upcoming** — sorted soonest first, with a countdown badge (Today! / Tomorrow / In N days). Shows within 7 days get a highlighted orange card as an in-app reminder.
- **Past** — sorted most recent first.

Tap **+** to add a ticket: show/event name, venue, date & time, price paid, seat/section, where you bought it, confirmation number, and an optional photo/PDF of the actual ticket (which typically has the barcode on it already). Tap any ticket card to view/edit it or delete it.

All data — including the attached ticket photo/PDF — is stored locally on-device in IndexedDB. Nothing leaves the device; there's no backend or sync (yet).

## Reminders

Reminders are in-app only for now: the Upcoming tab surfaces the soonest shows first and highlights anything within a week. Real push notifications (alerts even when the app isn't open) would need a backend and service-worker push subscription — a possible future addition, not built yet.

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
| `app.js` | IndexedDB storage (tickets + attachments), rendering, countdown logic |
| `sw.js` | Service worker for offline app-shell caching |
| `manifest.webmanifest`, `icon.svg`, `apple-touch-icon.png` | Home-screen install support |

## Bumping the cache version

`sw.js` caches `styles.css`, `app.js`, etc. by their `?v=N` query string. When you change either file, bump the `?v=` in both `index.html` and the `ASSETS` list in `sw.js`, and bump `CACHE` in `sw.js` — otherwise installed/offline users may keep seeing the old version.
