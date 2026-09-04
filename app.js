(() => {
  "use strict";

  // Keep in sync with sw.js — both scripts open the same database.
  const DB_NAME = "showtime-db";
  const DB_VERSION = 2;
  const STORE_TICKETS = "tickets";
  const STORE_SHARE = "pending-share";

  /** @returns {Promise<IDBDatabase>} */
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_TICKETS)) {
          db.createObjectStore(STORE_TICKETS, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORE_SHARE)) {
          db.createObjectStore(STORE_SHARE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function withStore(storeName, mode, fn) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const result = fn(store);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
    });
  }

  function getAllLocalTickets() {
    return withStore(STORE_TICKETS, "readonly", (store) => {
      return new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }).then((p) => p);
  }

  function putLocalTicket(ticket) {
    return withStore(STORE_TICKETS, "readwrite", (store) => store.put(ticket));
  }

  function deleteLocalTicket(id) {
    return withStore(STORE_TICKETS, "readwrite", (store) => store.delete(id));
  }

  // ---- Family sharing (Firebase) ----
  //
  // Showtime is a public static site with no login wall, so a device has to
  // pick a mode before it touches any data:
  //   "local" — original behavior, everything in this device's IndexedDB,
  //             Firebase never contacts the network.
  //   "cloud" — this device's tickets live in Firestore under
  //             families/{code}/tickets, shared live with anyone else who
  //             has the same code (a "shared secret" like a Google Doc
  //             link — there's no per-person login).
  // Mode + code are device config, not app data, so they live in
  // localStorage rather than IndexedDB.

  const LS_MODE_KEY = "showtime-mode";
  const LS_FAMILY_CODE_KEY = "showtime-family-code";

  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyC-nCkVIGR5T2Hn6wYkm3sdqeNQFKXS1-c",
    authDomain: "showtime-family.firebaseapp.com",
    projectId: "showtime-family",
    storageBucket: "showtime-family.firebasestorage.app",
    messagingSenderId: "256408852477",
    appId: "1:256408852477:web:de112bb28da5fcf5fd6b94",
  };

  function getMode() {
    return localStorage.getItem(LS_MODE_KEY);
  }

  function getFamilyCode() {
    return localStorage.getItem(LS_FAMILY_CODE_KEY);
  }

  function setFamily(mode, code) {
    localStorage.setItem(LS_MODE_KEY, mode);
    if (code) localStorage.setItem(LS_FAMILY_CODE_KEY, code);
    else localStorage.removeItem(LS_FAMILY_CODE_KEY);
  }

  // Excludes visually-ambiguous characters (0/O, 1/I/L) since this gets
  // typed by hand on a phone keyboard.
  const FAMILY_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  function generateFamilyCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return [...bytes].map((b) => FAMILY_CODE_ALPHABET[b % FAMILY_CODE_ALPHABET.length]).join("");
  }

  let firestoreDb = null;
  let firebaseStorage = null;
  let authReadyPromise = null;

  function ensureFirebase() {
    if (!firestoreDb) {
      firebase.initializeApp(FIREBASE_CONFIG);
      firestoreDb = firebase.firestore();
      firestoreDb.enablePersistence({ synchronizeTabs: true }).catch(() => {
        // Multiple tabs or an unsupported browser — app still works, just
        // without the offline cache surviving a full restart.
      });
      firebaseStorage = firebase.storage();
    }
    if (!authReadyPromise) {
      authReadyPromise = new Promise((resolve, reject) => {
        firebase.auth().onAuthStateChanged((user) => {
          if (user) resolve(user);
        });
        firebase.auth().signInAnonymously().catch(reject);
      });
    }
    return authReadyPromise;
  }

  function familyDoc(code) {
    return firestoreDb.collection("families").doc(code);
  }

  function familyTicketsCollection() {
    return familyDoc(getFamilyCode()).collection("tickets");
  }

  // Resolves true/false rather than throwing, so a mistyped join code reads
  // as "not found" instead of a raw permission error.
  async function familyExists(code) {
    await ensureFirebase();
    const snap = await familyDoc(code).get();
    return snap.exists;
  }

  async function createFamily() {
    await ensureFirebase();
    const code = generateFamilyCode();
    await familyDoc(code).set({ createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    setFamily("cloud", code);
    return code;
  }

  async function joinFamily(code) {
    const exists = await familyExists(code);
    if (!exists) return false;
    setFamily("cloud", code);
    return true;
  }

  function useLocalOnly() {
    setFamily("local", null);
  }

  async function putTicket(ticket) {
    if (getMode() === "cloud") {
      await ensureFirebase();
      await familyTicketsCollection().doc(ticket.id).set(ticket);
      return;
    }
    return putLocalTicket(ticket);
  }

  async function deleteTicket(id) {
    if (getMode() === "cloud") {
      await ensureFirebase();
      await familyTicketsCollection().doc(id).delete();
      return;
    }
    return deleteLocalTicket(id);
  }

  // Uploads any not-yet-uploaded working files (fresh picks/shares, which
  // only ever have a .blob) to Storage under this ticket, leaving
  // already-uploaded files (.url/.path, no .blob — loaded back from a
  // previous save) untouched. Local mode never calls this.
  async function uploadWorkingFilesForCloud(ticketId, files) {
    await ensureFirebase();
    const result = [];
    for (const f of files) {
      if (!f.blob) {
        result.push({ url: f.url, path: f.path, name: f.name, type: f.type });
        continue;
      }
      const path = `families/${getFamilyCode()}/attachments/${ticketId}/${crypto.randomUUID()}-${f.name || "file"}`;
      const ref = firebaseStorage.ref(path);
      await ref.put(f.blob, f.type ? { contentType: f.type } : undefined);
      const url = await ref.getDownloadURL();
      result.push({ url, path, name: f.name, type: f.type });
    }
    return result;
  }

  async function deleteStoragePaths(paths) {
    if (!paths.length) return;
    await ensureFirebase();
    await Promise.all(
      paths.map((path) => firebaseStorage.ref(path).delete().catch(() => {}))
    );
  }

  let unsubscribeTicketsListener = null;

  // Cloud mode keeps one live listener running for the whole session rather
  // than re-fetching on every reload() call — that's what makes another
  // family member's change show up here without a manual refresh. Resolves
  // once the first snapshot (local cache or server) has arrived, so startup
  // can wait for `tickets` to be populated before deciding what to render.
  function startTicketsSync() {
    if (unsubscribeTicketsListener) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const settle = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      unsubscribeTicketsListener = familyTicketsCollection().onSnapshot(
        (snap) => {
          tickets = snap.docs.map((d) => d.data());
          render();
          settle();
        },
        (err) => {
          console.error("Family sync error", err);
          settle();
        }
      );
    });
  }

  function takePendingShare() {
    return withStore(STORE_SHARE, "readwrite", (store) => {
      return new Promise((resolve, reject) => {
        const req = store.get("current");
        req.onsuccess = () => {
          if (req.result) store.delete("current");
          resolve(req.result || null);
        };
        req.onerror = () => reject(req.error);
      });
    }).then((p) => p);
  }

  // ---- Date / status helpers ----

  function ticketDateTime(t) {
    const time = t.time && t.time.length ? t.time : "00:00";
    return new Date(`${t.date}T${time}`);
  }

  function startOfToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function isUpcoming(t) {
    const eventDay = new Date(`${t.date}T00:00`);
    return eventDay >= startOfToday();
  }

  function daysUntil(t) {
    const eventDay = new Date(`${t.date}T00:00`);
    const today = startOfToday();
    return Math.round((eventDay - today) / 86400000);
  }

  function countdownLabel(t) {
    const n = daysUntil(t);
    if (n === 0) return "Today!";
    if (n === 1) return "Tomorrow";
    if (n > 1) return `In ${n} days`;
    if (n === -1) return "Yesterday";
    return `${-n} days ago`;
  }

  // Ticket-purchase reminder tiers for Planned events (no file attached yet).
  // Purely in-app: there's no backend to push a notification while the app
  // is closed, so this surfaces as a highlighted card + label whenever the
  // app is next opened. Once a file is attached the ticket leaves Planned
  // entirely, so the reminder is implicitly "cancelled" — nothing to track.
  function reminderTier(t) {
    const n = daysUntil(t);
    if (n < 0) return "overdue";
    if (n <= 2) return "2-days";
    if (n <= 7) return "1-week";
    if (n <= 14) return "2-weeks";
    if (n <= 30) return "1-month";
    return null;
  }

  function reminderLabel(tier) {
    switch (tier) {
      case "1-month": return "🔔 1 month out — get tickets";
      case "2-weeks": return "🔔 2 weeks out — get tickets";
      case "1-week": return "🔔 1 week out — get tickets";
      case "2-days": return "🔔 2 days out — get tickets!";
      case "overdue": return "⚠️ Show already happened";
      default: return "";
    }
  }

  function formatDate(dateStr) {
    const d = new Date(`${dateStr}T00:00`);
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  }

  function formatTime(timeStr) {
    return timeStr || "";
  }

  function formatPrice(price) {
    if (price === null || price === undefined || price === "") return "";
    const n = Number(price);
    if (Number.isNaN(n)) return "";
    return `$${n.toFixed(2)}`;
  }

  // ---- Shared-content parsing (best-effort, not exact) ----

  const KNOWN_VENDORS = [
    "Ticketmaster", "StubHub", "SeatGeek", "AXS", "Eventbrite",
    "Vivid Seats", "TodayTix", "DICE", "Songkick", "Fever", "See Tickets",
  ];

  function looksLikeFilename(s) {
    return /\.(jpe?g|png|gif|webp|heic|pdf)$/i.test(s) || /^(img|screenshot|photo)[\s_-]?\d*/i.test(s);
  }

  function parseSharedText(title, text) {
    const combined = [title, text].filter(Boolean).join("\n");
    const result = { eventName: "", venue: "", date: "", time: "", price: "", seat: "", source: "", confirmation: "" };
    const rawLines = combined.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    for (const vendor of KNOWN_VENDORS) {
      if (combined.toLowerCase().includes(vendor.toLowerCase())) {
        result.source = vendor;
        break;
      }
    }

    // Require a digit in the captured token so labels like "Order Confirmation"
    // (with no code after them) don't match themselves as the value.
    const confMatch = combined.match(/\b(?:confirmation|order)\s*(?:#|number|no\.?|num)?\s*[:#]?\s*((?=[a-z0-9-]*\d)[a-z0-9-]{4,})/i);
    if (confMatch) result.confirmation = confMatch[1];

    // Eventbrite writes totals as "Order total: 180.00 USD" — no $ sign.
    const totalMatch = combined.match(/total\s*:?\s*\$?\s*([\d,]+\.\d{2})/i);
    const anyPriceMatch = combined.match(/\$\s?([\d,]+\.\d{2})/);
    const priceMatch = totalMatch || anyPriceMatch;
    if (priceMatch) result.price = priceMatch[1].replace(/,/g, "");

    const monthNames = "January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec";
    const dateRe = new RegExp(`\\b(${monthNames})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(\\d{4})?`, "i");
    const dateMatch = combined.match(dateRe);
    if (dateMatch) {
      const year = dateMatch[3] || String(new Date().getFullYear());
      const parsed = new Date(`${dateMatch[1]} ${dateMatch[2]}, ${year}`);
      if (!Number.isNaN(parsed.getTime())) {
        if (!dateMatch[3]) {
          const today = startOfToday();
          if (parsed < today) parsed.setFullYear(parsed.getFullYear() + 1);
        }
        result.date = parsed.toISOString().slice(0, 10);
      }
    } else {
      const slashMatch = combined.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
      if (slashMatch) {
        let [, mm, dd, yy] = slashMatch;
        if (yy.length === 2) yy = "20" + yy;
        const parsed = new Date(`${yy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}T00:00`);
        if (!Number.isNaN(parsed.getTime())) result.date = parsed.toISOString().slice(0, 10);
      }
    }

    const timeMatch = combined.match(/\b(\d{1,2}):(\d{2})\s?(AM|PM|am|pm)\b/);
    if (timeMatch) {
      let h = parseInt(timeMatch[1], 10);
      const ampm = timeMatch[3].toLowerCase();
      if (ampm === "pm" && h !== 12) h += 12;
      if (ampm === "am" && h === 12) h = 0;
      result.time = `${String(h).padStart(2, "0")}:${timeMatch[2]}`;
    }

    // Ticket-detail blocks (Eventbrite among others) often print a literal
    // "Event" label with the name on the next line — the single most
    // reliable signal when it's there, so it wins over everything else.
    const eventLabelIndex = rawLines.findIndex((l) => /^event:?$/i.test(l));
    if (eventLabelIndex >= 0 && eventLabelIndex + 1 < rawLines.length) {
      const nameLine = rawLines[eventLabelIndex + 1];
      if (nameLine.length <= 80) result.eventName = nameLine;
    }

    // Otherwise look for it embedded in a sentence: "Your Tickets for
    // <event>", "Order confirmation for <event>", "registration for
    // <event> on <date>", etc. — stop at whichever comes first: a date
    // ("on November 9"), "has been", sentence punctuation, or line end.
    if (!result.eventName) {
      const eventForMatch = combined.match(
        /\b(?:your\s+)?(?:tickets|order confirmation|confirmation|registration) for\s+(?:the\s+)?([^\n\r]+?)(?=\s+on\s+[A-Z][a-z]+\s+\d|\s+has\s+been|[.,]\s|[\n\r]|$)/i
      );
      if (eventForMatch) result.eventName = eventForMatch[1].trim();
    }

    // Venue: Eventbrite prints "Venue Name" / street / "City, ST ZIP" /
    // "View on map" as consecutive lines — find the city/state/zip line and
    // walk back two lines to the venue name.
    const cityZipIndex = rawLines.findIndex((l) => /^[^,\n]+,\s*[A-Z]{2}\s+\d{5}/.test(l));
    if (cityZipIndex >= 2) {
      const streetLine = rawLines[cityZipIndex - 1];
      const venueLine = rawLines[cityZipIndex - 2];
      if (/^\d/.test(streetLine) && venueLine.length <= 60 && !/^(view|section|order|ticket)/i.test(venueLine)) {
        result.venue = venueLine;
      }
    }

    // Seats: Eventbrite lists "Section X, Row Y, Seat Z" once per physical
    // ticket. Group identical section/row together into one "Seats 10, 11".
    const seatMatches = [...combined.matchAll(/Section\s+([\w-]+),?\s*Row\s+([\w-]+),?\s*Seat\s+([\w-]+)/gi)];
    if (seatMatches.length) {
      const groups = new Map();
      for (const [, section, row, seat] of seatMatches) {
        const key = `${section}|${row}`;
        if (!groups.has(key)) groups.set(key, { section, row, seats: [] });
        groups.get(key).seats.push(seat);
      }
      result.seat = [...groups.values()]
        .map((g) => `Section ${g.section}, Row ${g.row}, Seat${g.seats.length > 1 ? "s" : ""} ${g.seats.join(", ")}`)
        .join("; ");
    }

    // "Clean listing" fallback: plain text copied from a venue page, poster,
    // or calendar entry often reads as just "Event name / optional details
    // / date & time / venue", one per line, with none of the ticketing-email
    // phrasing the heuristics above look for. Anchor on whichever line has
    // the date: the first non-junk line before it is the name, the line
    // right after it is the venue.
    const dateLineIndex = rawLines.findIndex((l) => dateRe.test(l));

    // Some share sources (e.g. Safari/Notes sharing selected text) prepend a
    // line like "Included Link:" or the raw URL ahead of the actual content —
    // skip lines like that rather than assuming line 0 is always the name.
    function looksLikeShareJunk(l) {
      return (
        /^https?:\/\//i.test(l) ||
        /^(including?|included)\s+link\b/i.test(l) ||
        /^sent from\b/i.test(l) ||
        /^shared (from|via)\b/i.test(l) ||
        /^(dear|hi|hello)\b/i.test(l) ||
        /[{}]/.test(l)
      );
    }

    if (!result.eventName && dateLineIndex > 0) {
      const candidate = rawLines.slice(0, dateLineIndex).find((l) => !looksLikeShareJunk(l));
      if (candidate && candidate.length <= 80 && !looksLikeFilename(candidate)) {
        result.eventName = candidate;
      }
    }

    if (!result.venue && dateLineIndex >= 0 && dateLineIndex + 1 < rawLines.length) {
      const candidate = rawLines[dateLineIndex + 1];
      const looksLikeNotVenue =
        /^(view|buy|get|register|rsvp|section|order|ticket)/i.test(candidate) ||
        /^https?:\/\//i.test(candidate) ||
        /^\$/.test(candidate) ||
        dateRe.test(candidate);
      if (candidate.length <= 60 && !looksLikeNotVenue) {
        result.venue = candidate;
      }
    }

    if (!result.eventName) {
      let candidate = (title || "").trim().replace(/^(fwd|fw|re)\s*:\s*/i, "");
      const looksLikeBoilerplate = /^(dear|hi|hello)\b/i.test(candidate) || /[{}]/.test(candidate);
      if (candidate && !looksLikeFilename(candidate) && !looksLikeBoilerplate && candidate.length <= 80) {
        result.eventName = candidate;
      }
    }

    return result;
  }

  // ---- App state ----

  let tickets = [];
  let currentView = "upcoming";
  let editingId = null;
  let workingFiles = []; // [{ blob, name, type }] (freshly picked) or [{ url, path, name, type }] (already in cloud Storage)
  let modalSnapshot = ""; // form state as of when the modal opened, to detect unsaved changes on close
  let filesPendingStorageDeletion = []; // Storage paths removed from workingFiles this edit, deleted on Save (cloud mode)
  const objectUrls = [];

  function trackUrl(url) {
    objectUrls.push(url);
    return url;
  }

  function revokeTrackedUrls() {
    while (objectUrls.length) URL.revokeObjectURL(objectUrls.pop());
  }

  // Older records stored a single fileBlob/fileType/fileName; newer ones
  // store a `files` array. Normalize so the rest of the app only deals
  // with arrays.
  function getTicketFiles(t) {
    if (t.files && t.files.length) return t.files;
    if (t.fileBlob) return [{ blob: t.fileBlob, type: t.fileType, name: t.fileName }];
    return [];
  }

  // A file entry is either a freshly-picked local blob (.blob) or an
  // already-uploaded cloud file (.url, no .blob) — this is the one place
  // that turns either into something an <img>/etc. can point at.
  function fileImageSrc(f) {
    return f.blob ? trackUrl(URL.createObjectURL(f.blob)) : f.url;
  }

  // ---- Rendering ----

  const listUpcomingEl = document.getElementById("list-upcoming");
  const listPlannedEl = document.getElementById("list-planned");
  const listPastEl = document.getElementById("list-past");
  const emptyUpcomingEl = document.getElementById("empty-upcoming");
  const emptyPlannedEl = document.getElementById("empty-planned");
  const emptyPastEl = document.getElementById("empty-past");

  // A ticket is "planned" by not having any attached file yet — attach a
  // photo/PDF (the actual ticket) and it moves itself into Upcoming/Past
  // based on its date. ticketConfirmed is the manual escape hatch for
  // tickets that can never have a file (e.g. a vendor's live rotating
  // barcode, only viewable in their app) — left-swipe in Planned sets it.
  function isPlanned(t) {
    return getTicketFiles(t).length === 0 && !t.ticketConfirmed;
  }

  function render() {
    const planned = tickets.filter(isPlanned).sort((a, b) => ticketDateTime(a) - ticketDateTime(b));
    const upcoming = tickets.filter((t) => !isPlanned(t) && isUpcoming(t)).sort((a, b) => ticketDateTime(a) - ticketDateTime(b));
    const past = tickets.filter((t) => !isPlanned(t) && !isUpcoming(t)).sort((a, b) => ticketDateTime(b) - ticketDateTime(a));

    renderList(listUpcomingEl, upcoming, "upcoming");
    renderList(listPlannedEl, planned, "planned");
    renderList(listPastEl, past, "past");

    emptyUpcomingEl.hidden = upcoming.length > 0;
    emptyPlannedEl.hidden = planned.length > 0;
    emptyPastEl.hidden = past.length > 0;
  }

  function renderList(el, items, listKind) {
    el.innerHTML = "";
    for (const t of items) {
      el.appendChild(renderCard(t, listKind));
    }
  }

  function renderCard(t, listKind) {
    const li = document.createElement("li");
    li.className = "ticket-row-wrap";

    const deleteBg = document.createElement("div");
    deleteBg.className = "ticket-row-delete-bg";
    deleteBg.textContent = "Delete";
    deleteBg.setAttribute("aria-hidden", "true");
    li.appendChild(deleteBg);

    const files = getTicketFiles(t);
    const planned = isPlanned(t);
    const tier = planned ? reminderTier(t) : null;

    // Left swipe: Planned -> Upcoming always (the ticketConfirmed escape
    // hatch); Upcoming -> Planned only undoes that same override — a ticket
    // with a real file attached can't be swiped back, since "un-planning"
    // it would mean discarding the attachment, too big a step for a swipe.
    const canMoveToUpcoming = listKind === "planned";
    const canMoveToPlanned = listKind === "upcoming" && !!t.ticketConfirmed && files.length === 0;
    const canSwipeLeft = canMoveToUpcoming || canMoveToPlanned;
    let moveBg = null;
    if (canSwipeLeft) {
      moveBg = document.createElement("div");
      moveBg.className = "ticket-row-move-bg";
      moveBg.textContent = canMoveToUpcoming ? "Move to Upcoming" : "Move to Planned";
      moveBg.setAttribute("aria-hidden", "true");
      li.appendChild(moveBg);
    }

    const card = document.createElement("div");
    const soon = (listKind === "upcoming" && daysUntil(t) <= 7) || !!tier;
    card.className = "ticket-card" + (soon ? " is-soon" : "");
    card.tabIndex = 0;
    wireCardGestures(card, t, canSwipeLeft, moveBg, canMoveToUpcoming ? swipeMoveToUpcoming : swipeMoveToPlanned);

    const thumbWrap = document.createElement("div");
    thumbWrap.className = "ticket-thumb-wrap";
    const ph = document.createElement("div");
    ph.className = "ticket-thumb-placeholder";
    // Purple = a ticket is in hand (a real file, or manually confirmed via
    // ticketConfirmed); white silhouette = still just planned — same emoji
    // artwork either way, just recolored.
    ph.innerHTML = planned
      ? '<span class="ticket-thumb-emoji ticket-thumb-emoji-planned">🎟️</span>'
      : '<span class="ticket-thumb-emoji">🎟️</span>';
    thumbWrap.appendChild(ph);
    if (!files.length && t.ticketLink) {
      const linkBadge = document.createElement("span");
      linkBadge.className = "ticket-thumb-count";
      linkBadge.textContent = "🔗";
      thumbWrap.appendChild(linkBadge);
    }
    if (files.length > 1) {
      const countBadge = document.createElement("span");
      countBadge.className = "ticket-thumb-count";
      countBadge.textContent = String(files.length);
      thumbWrap.appendChild(countBadge);
    }
    card.appendChild(thumbWrap);

    const info = document.createElement("div");
    info.className = "ticket-info";

    const name = document.createElement("div");
    name.className = "ticket-name";
    name.textContent = t.eventName;
    info.appendChild(name);

    const metaParts = [formatDate(t.date)];
    if (t.time) metaParts.push(formatTime(t.time));
    if (t.venue) metaParts.push(t.venue);
    const meta = document.createElement("div");
    meta.className = "ticket-meta";
    meta.textContent = metaParts.join(" · ");
    info.appendChild(meta);

    const subParts = [];
    if (t.seat) subParts.push(t.seat);
    if (t.price !== "" && t.price !== null && t.price !== undefined) subParts.push(formatPrice(t.price));
    if (subParts.length) {
      const sub = document.createElement("div");
      sub.className = "ticket-sub";
      sub.textContent = subParts.join(" · ");
      info.appendChild(sub);
    }

    if (tier) {
      const reminder = document.createElement("div");
      reminder.className = "ticket-reminder";
      reminder.textContent = reminderLabel(tier);
      info.appendChild(reminder);
    }

    card.appendChild(info);

    const badge = document.createElement("span");
    badge.className = "ticket-badge";
    badge.textContent = countdownLabel(t);
    card.appendChild(badge);

    li.appendChild(card);
    return li;
  }

  // Short tap opens Edit; press-and-hold jumps straight to the attached
  // ticket file (or opens ticketLink if there's no file); a right swipe
  // past 40% of the card's width deletes it (with undo); where applicable,
  // a left swipe past 40% fires onSwipeLeft (with undo) — Planned ->
  // Upcoming for a ticket that can never have a file, or the reverse for
  // one moved there that way. All of this shares one pointer-gesture state
  // machine so nothing fires on top of anything else.
  const LONG_PRESS_MS = 500;
  const GESTURE_MOVE_THRESHOLD = 10;

  function wireCardGestures(card, t, canSwipeLeft, moveBg, onSwipeLeft) {
    let pressTimer = null;
    let longPressFired = false;
    let wasSwipe = false;
    let dragging = false;
    let axis = null; // null | "x" (swipe) | "y" (vertical scroll)
    let startX = 0;
    let startY = 0;
    let currentDx = 0;

    const cancelTimer = () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    };

    card.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      startX = e.clientX;
      startY = e.clientY;
      axis = null;
      dragging = true;
      longPressFired = false;
      wasSwipe = false;
      currentDx = 0;
      card.style.transition = "none";
      pressTimer = setTimeout(() => {
        longPressFired = true;
        openAttachmentForTicket(t);
      }, LONG_PRESS_MS);
    });

    card.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      if (axis === null) {
        if (Math.abs(dx) <= GESTURE_MOVE_THRESHOLD && Math.abs(dy) <= GESTURE_MOVE_THRESHOLD) return;
        if (Math.abs(dx) > Math.abs(dy)) {
          axis = "x";
          wasSwipe = true;
          cancelTimer();
          try {
            card.setPointerCapture(e.pointerId);
          } catch {
            // Ignore — capture is a nice-to-have so the drag keeps tracking
            // outside the element's bounds, not required for it to work.
          }
        } else {
          axis = "y";
          dragging = false;
          cancelTimer();
          return;
        }
      }

      const minDx = canSwipeLeft ? -card.offsetWidth : 0;
      currentDx = Math.max(minDx, Math.min(dx, card.offsetWidth));
      card.style.transform = `translateX(${currentDx}px)`;
      // The two backgrounds fully overlap (both inset:0), so only the one
      // for the current drag direction should ever actually paint.
      if (moveBg) moveBg.style.visibility = currentDx < 0 ? "visible" : "hidden";
      e.preventDefault();
    });

    function finishDrag() {
      if (!dragging) return;
      dragging = false;
      cancelTimer();
      if (axis !== "x") return;
      axis = null;
      const threshold = card.offsetWidth * 0.4;
      card.style.transition = "transform 0.2s ease";
      if (currentDx > threshold) {
        card.style.transform = "translateX(100%)";
        setTimeout(() => swipeDeleteTicket(t), 150);
      } else if (canSwipeLeft && currentDx < -threshold) {
        card.style.transform = "translateX(-100%)";
        setTimeout(() => onSwipeLeft(t), 150);
      } else {
        card.style.transform = "translateX(0)";
        // Snapped back rather than acting — don't let a stale "this was a
        // swipe" flag block a later click that arrives with no pointerdown
        // of its own (e.g. keyboard Enter/Space activation).
        wasSwipe = false;
      }
    }

    card.addEventListener("pointerup", finishDrag);
    card.addEventListener("pointercancel", finishDrag);

    card.addEventListener("click", () => {
      if (longPressFired || wasSwipe) {
        longPressFired = false;
        wasSwipe = false;
        return;
      }
      openEditModal(t.id);
    });
  }

  // ---- Swipe-to-delete / swipe-to-move-to-upcoming, both with undo ----
  //
  // Both are the same shape (optimistic list mutation, 3-second undo bar,
  // real persistence deferred until the window elapses) so they share one
  // pending-action slot rather than two parallel copies of the same logic.

  const undoBar = document.getElementById("undo-bar");
  const undoLabel = document.getElementById("undo-label");
  const undoBtn = document.getElementById("undo-btn");
  const UNDO_WINDOW_MS = 3000;

  let pendingAction = null; // { type: "delete" | "moveUpcoming", ticket, timer }

  function showUndoBar(label) {
    undoLabel.textContent = label;
    undoBar.hidden = false;
  }

  function hideUndoBar() {
    undoBar.hidden = true;
  }

  async function finalizePendingAction() {
    if (!pendingAction) return;
    const { type, ticket, timer } = pendingAction;
    clearTimeout(timer);
    pendingAction = null;
    hideUndoBar();
    if (type === "delete") {
      if (getMode() === "cloud") {
        const paths = getTicketFiles(ticket).map((f) => f.path).filter(Boolean);
        await deleteStoragePaths(paths);
      }
      await deleteTicket(ticket.id);
    } else if (type === "moveUpcoming") {
      await putTicket({ ...ticket, ticketConfirmed: true });
    } else if (type === "movePlanned") {
      await putTicket({ ...ticket, ticketConfirmed: false });
    }
  }

  function swipeDeleteTicket(ticket) {
    finalizePendingAction();
    tickets = tickets.filter((t) => t.id !== ticket.id);
    render();
    showUndoBar(`Deleted "${ticket.eventName}"`);
    pendingAction = { type: "delete", ticket, timer: setTimeout(finalizePendingAction, UNDO_WINDOW_MS) };
  }

  // For a ticket whose "attachment" can only ever live in the vendor's own
  // app (e.g. a rotating live barcode) — there's genuinely no file to attach,
  // so it would otherwise sit in Planned forever. This is a manual override:
  // ticketConfirmed short-circuits isPlanned() the same way a real file does.
  function swipeMoveToUpcoming(ticket) {
    finalizePendingAction();
    const updated = { ...ticket, ticketConfirmed: true };
    tickets = tickets.map((t) => (t.id === ticket.id ? updated : t));
    render();
    showUndoBar(`Moved "${ticket.eventName}" to Upcoming`);
    pendingAction = { type: "moveUpcoming", ticket, timer: setTimeout(finalizePendingAction, UNDO_WINDOW_MS) };
  }

  // The reverse of swipeMoveToUpcoming — only reachable from a card that
  // got to Upcoming via ticketConfirmed with no file attached (renderCard
  // only wires this in for those), so there's never a real attachment to
  // reconcile: clearing the flag is the whole move.
  function swipeMoveToPlanned(ticket) {
    finalizePendingAction();
    const updated = { ...ticket, ticketConfirmed: false };
    tickets = tickets.map((t) => (t.id === ticket.id ? updated : t));
    render();
    showUndoBar(`Moved "${ticket.eventName}" to Planned`);
    pendingAction = { type: "movePlanned", ticket, timer: setTimeout(finalizePendingAction, UNDO_WINDOW_MS) };
  }

  function undoPendingAction() {
    if (!pendingAction) return;
    clearTimeout(pendingAction.timer);
    const { type, ticket } = pendingAction;
    pendingAction = null;
    if (type === "delete") {
      tickets.push(ticket);
    } else {
      tickets = tickets.map((t) => (t.id === ticket.id ? ticket : t));
    }
    render();
    hideUndoBar();
  }

  undoBtn.addEventListener("click", undoPendingAction);

  function openAttachmentForTicket(t) {
    const files = getTicketFiles(t);
    if (files.length) {
      openAttachmentCarousel(files, 0);
    } else if (t.ticketLink) {
      window.open(t.ticketLink, "_blank", "noopener");
    }
  }

  // ---- Tabs ----

  const tabs = document.querySelectorAll(".tab");
  const views = {
    upcoming: document.getElementById("view-upcoming"),
    planned: document.getElementById("view-planned"),
    past: document.getElementById("view-past"),
  };

  function switchView(view) {
    currentView = view;
    tabs.forEach((t) => {
      t.classList.toggle("is-active", t.dataset.view === view);
      t.setAttribute("aria-current", t.dataset.view === view ? "page" : "false");
    });
    Object.entries(views).forEach(([key, el]) => (el.hidden = key !== currentView));
  }

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => switchView(tab.dataset.view));
  });

  // ---- Ticket modal ----

  const ticketModal = document.getElementById("ticket-modal");
  const ticketModalTitle = document.getElementById("ticket-modal-title");
  const ticketForm = document.getElementById("ticket-form");
  const fileInput = document.getElementById("file-input");
  const fileListEl = document.getElementById("file-list");
  const unsavedModal = document.getElementById("unsaved-modal");
  const addToCalendarBtn = document.getElementById("add-to-calendar-btn");

  // ---- Time picker (custom hour/minute/AM-PM selects, not the native
  // <input type="time"> widget — some mobile browsers render that dialog
  // without a working confirm button, silently discarding the value) ----

  const timeInput = document.getElementById("time-input");
  const timeHourSelect = document.getElementById("time-hour");
  const timeMinuteSelect = document.getElementById("time-minute");
  const TIME_MINUTE_OPTIONS = ["00", "15", "30", "45"];

  {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "--";
    timeHourSelect.appendChild(placeholder);
  }
  for (let h = 0; h < 24; h++) {
    const opt = document.createElement("option");
    opt.value = String(h).padStart(2, "0");
    opt.textContent = opt.value;
    timeHourSelect.appendChild(opt);
  }

  {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "--";
    timeMinuteSelect.appendChild(placeholder);
  }
  for (const m of TIME_MINUTE_OPTIONS) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    timeMinuteSelect.appendChild(opt);
  }

  function syncHiddenTime() {
    const h = timeHourSelect.value;
    const m = timeMinuteSelect.value;
    timeInput.value = h && m ? `${h}:${m}` : "";
  }

  function setTimeSelects(value) {
    if (!value) {
      timeHourSelect.value = "";
      timeMinuteSelect.value = "";
      syncHiddenTime();
      return;
    }
    let [hh, mm] = value.split(":").map(Number);
    // Snap to the nearest quarter-hour option, rolling the hour over if needed.
    let roundedMin = Math.round(mm / 15) * 15;
    if (roundedMin === 60) {
      roundedMin = 0;
      hh = (hh + 1) % 24;
    }
    timeHourSelect.value = String(hh).padStart(2, "0");
    timeMinuteSelect.value = String(roundedMin).padStart(2, "0");
    syncHiddenTime();
  }

  [timeHourSelect, timeMinuteSelect].forEach((sel) => sel.addEventListener("change", syncHiddenTime));

  // A cheap, comparable fingerprint of the modal's current field + file
  // state, used to detect unsaved changes when the user tries to close it.
  function snapshotFormState() {
    return JSON.stringify({
      eventName: ticketForm.eventName.value,
      venue: ticketForm.venue.value,
      date: ticketForm.date.value,
      time: timeInput.value,
      price: ticketForm.price.value,
      seat: ticketForm.seat.value,
      source: ticketForm.source.value,
      confirmation: ticketForm.confirmation.value,
      ticketLink: ticketForm.ticketLink.value,
      files: workingFiles.map((f) => `${f.name}|${f.type}|${f.blob ? f.blob.size : f.path || ""}`),
    });
  }

  function isTicketFormDirty() {
    return snapshotFormState() !== modalSnapshot;
  }

  function openAddModal(prefill) {
    editingId = null;
    workingFiles = [];
    filesPendingStorageDeletion = [];
    ticketModalTitle.textContent = "Add event";
    addToCalendarBtn.hidden = true;
    ticketForm.reset();
    setTimeSelects("");

    if (prefill) {
      ticketForm.eventName.value = prefill.eventName || "";
      ticketForm.venue.value = prefill.venue || "";
      ticketForm.date.value = prefill.date || "";
      setTimeSelects(prefill.time || "");
      ticketForm.price.value = prefill.price || "";
      ticketForm.seat.value = prefill.seat || "";
      ticketForm.source.value = prefill.source || "";
      ticketForm.confirmation.value = prefill.confirmation || "";
      ticketForm.ticketLink.value = prefill.ticketLink || "";
      if (prefill.fileBlob) {
        workingFiles.push({ blob: prefill.fileBlob, name: prefill.fileName, type: prefill.fileType });
      }
    }

    modalSnapshot = snapshotFormState();
    renderFileList();
    ticketModal.hidden = false;
    document.getElementById("event-input").focus();
  }

  function openEditModal(id) {
    const t = tickets.find((x) => x.id === id);
    if (!t) return;
    editingId = id;
    workingFiles = getTicketFiles(t).slice();
    filesPendingStorageDeletion = [];
    ticketModalTitle.textContent = "Edit event";
    addToCalendarBtn.hidden = false;
    ticketForm.reset();
    ticketForm.eventName.value = t.eventName || "";
    ticketForm.venue.value = t.venue || "";
    ticketForm.date.value = t.date || "";
    setTimeSelects(t.time || "");
    ticketForm.price.value = t.price ?? "";
    ticketForm.seat.value = t.seat || "";
    ticketForm.source.value = t.source || "";
    ticketForm.confirmation.value = t.confirmation || "";
    ticketForm.ticketLink.value = t.ticketLink || "";
    modalSnapshot = snapshotFormState();
    renderFileList();
    ticketModal.hidden = false;
  }

  function attemptCloseTicketModal() {
    if (isTicketFormDirty()) {
      unsavedModal.hidden = false;
    } else {
      closeTicketModal();
    }
  }

  function closeTicketModal() {
    ticketModal.hidden = true;
    editingId = null;
    workingFiles = [];
    filesPendingStorageDeletion = [];
  }

  function renderFileList() {
    fileListEl.innerHTML = "";
    workingFiles.forEach((f, i) => {
      const row = document.createElement("li");
      row.className = "file-preview";

      let thumb;
      if (f.type && f.type.startsWith("image/")) {
        thumb = document.createElement("img");
        thumb.alt = "";
        thumb.src = fileImageSrc(f);
      } else {
        thumb = document.createElement("div");
        thumb.className = "file-list-icon";
        thumb.textContent = "📄";
      }
      thumb.addEventListener("click", () => openAttachmentCarousel(workingFiles, i));
      row.appendChild(thumb);

      const name = document.createElement("span");
      name.className = "file-preview-name file-list-name";
      name.textContent = f.name || "Attachment";
      name.addEventListener("click", () => openAttachmentCarousel(workingFiles, i));
      row.appendChild(name);

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "file-remove-btn";
      removeBtn.setAttribute("aria-label", "Remove attachment");
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", () => {
        const [removed] = workingFiles.splice(i, 1);
        if (removed.path) filesPendingStorageDeletion.push(removed.path);
        renderFileList();
      });
      row.appendChild(removeBtn);

      fileListEl.appendChild(row);
    });
  }

  fileInput.addEventListener("change", () => {
    for (const f of fileInput.files) {
      workingFiles.push({ blob: f, name: f.name, type: f.type });
    }
    fileInput.value = "";
    renderFileList();
  });

  document.getElementById("header-add-btn").addEventListener("click", openAddModal);

  ticketModal.querySelectorAll("[data-close]").forEach((el) => el.addEventListener("click", attemptCloseTicketModal));

  document.getElementById("unsaved-save-btn").addEventListener("click", () => {
    unsavedModal.hidden = true;
    ticketForm.requestSubmit();
  });
  document.getElementById("unsaved-discard-btn").addEventListener("click", () => {
    unsavedModal.hidden = true;
    closeTicketModal();
  });
  document.getElementById("unsaved-keep-editing-btn").addEventListener("click", () => {
    unsavedModal.hidden = true;
  });

  // ---- Add to calendar (.ics) ----
  //
  // Universal iCalendar file rather than a provider-specific deep link
  // (e.g. Google Calendar's quick-add URL) — every calendar app (Google,
  // Apple, Outlook) can import an .ics, so this isn't locked to one
  // provider. Dates/times are written as floating local time (no TZID/Z),
  // matching how the rest of the app already treats them: whatever the
  // user typed, with no timezone tracking or conversion anywhere.

  function icsEscape(s) {
    return String(s || "")
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\n/g, "\\n");
  }

  function icsDateStamp(d) {
    return d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  }

  function buildIcsContent(t) {
    const [y, m, d] = t.date.split("-").map(Number);
    const pad = (n) => String(n).padStart(2, "0");
    let dtStart, dtEnd;

    if (t.time) {
      const [hh, mm] = t.time.split(":").map(Number);
      const start = new Date(y, m - 1, d, hh, mm);
      const end = new Date(start.getTime() + 2 * 60 * 60 * 1000); // default 2-hour duration
      const fmt = (dt) => `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}T${pad(dt.getHours())}${pad(dt.getMinutes())}00`;
      dtStart = `DTSTART:${fmt(start)}`;
      dtEnd = `DTEND:${fmt(end)}`;
    } else {
      const start = new Date(y, m - 1, d);
      const end = new Date(y, m - 1, d + 1); // iCal all-day end date is exclusive
      const fmt = (dt) => `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}`;
      dtStart = `DTSTART;VALUE=DATE:${fmt(start)}`;
      dtEnd = `DTEND;VALUE=DATE:${fmt(end)}`;
    }

    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Showtime//EN",
      "BEGIN:VEVENT",
      `UID:${t.id}@showtime`,
      `DTSTAMP:${icsDateStamp(new Date())}`,
      dtStart,
      dtEnd,
      `SUMMARY:${icsEscape(t.eventName)}`,
    ];
    if (t.venue) lines.push(`LOCATION:${icsEscape(t.venue)}`);
    lines.push("END:VEVENT", "END:VCALENDAR");
    return lines.join("\r\n");
  }

  async function addTicketToCalendar(t) {
    try {
      const ics = buildIcsContent(t);
      const safeName = (t.eventName || "event").replace(/[^\w\- ]/g, "").trim().slice(0, 60) || "event";
      const file = new File([ics], `${safeName}.ics`, { type: "text/calendar" });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: t.eventName });
          return;
        } catch (err) {
          // AbortError = the user closed the share sheet without picking
          // anything — genuinely nothing to do. Anything else (no matching
          // app, a permissions quirk, etc.) falls through to the direct
          // download below instead of silently doing nothing.
          if (err && err.name === "AbortError") return;
        }
      }

      const url = URL.createObjectURL(file);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      console.error(err);
      alert("Couldn't create the calendar file. Try again in a moment.");
    }
  }

  addToCalendarBtn.addEventListener("click", () => {
    const t = tickets.find((x) => x.id === editingId);
    if (t) addTicketToCalendar(t);
  });

  const ticketSaveBtn = ticketForm.querySelector('button[type="submit"]');

  ticketForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    syncHiddenTime();
    const fd = new FormData(ticketForm);
    const ticketId = editingId || crypto.randomUUID();
    const existing = editingId ? tickets.find((x) => x.id === editingId) : null;

    ticketSaveBtn.disabled = true;
    ticketSaveBtn.textContent = "Saving…";
    try {
      const files =
        getMode() === "cloud"
          ? await uploadWorkingFilesForCloud(ticketId, workingFiles)
          : workingFiles.map((f) => ({ blob: f.blob, type: f.type, name: f.name }));

      const ticket = {
        id: ticketId,
        eventName: fd.get("eventName").trim(),
        venue: fd.get("venue").trim(),
        date: fd.get("date"),
        time: fd.get("time"),
        price: fd.get("price") ? Number(fd.get("price")) : "",
        seat: fd.get("seat").trim(),
        source: fd.get("source").trim(),
        confirmation: fd.get("confirmation").trim(),
        ticketLink: fd.get("ticketLink").trim(),
        // Not a form field — set only via the left-swipe-to-upcoming
        // gesture in Planned, so carry it forward rather than dropping it.
        ticketConfirmed: !!(existing && existing.ticketConfirmed),
        files,
      };

      await putTicket(ticket);
      if (getMode() === "cloud") await deleteStoragePaths(filesPendingStorageDeletion);
      await reload();
      closeTicketModal();
    } catch (err) {
      console.error(err);
      alert("Couldn't save — check your connection and try again.");
    } finally {
      ticketSaveBtn.disabled = false;
      ticketSaveBtn.textContent = "Save";
    }
  });

  // ---- Attachment viewer ----

  const attachmentModal = document.getElementById("attachment-modal");
  const attachmentCarousel = document.getElementById("attachment-carousel");
  const attachmentDots = document.getElementById("attachment-dots");

  // Renders every page of a PDF onto its own <canvas> inside the given
  // container — no navigation, no separate browser/native PDF viewer, no
  // "how do I get back to the app" confusion. Both the native <iframe>-embed
  // and the real-navigation approaches tried earlier ran into real platform
  // limitations (Android Chrome won't render a blob: PDF inline in an
  // iframe; a real navigation takes over the whole installed-PWA window
  // with no reliable way back). Rendering it ourselves with pdf.js
  // sidesteps both.
  let pdfjsLibPromise = null;
  function loadPdfJs() {
    if (!pdfjsLibPromise) {
      pdfjsLibPromise = import("./vendor/pdfjs/pdf.min.mjs").then((lib) => {
        lib.GlobalWorkerOptions.workerSrc = "vendor/pdfjs/pdf.worker.min.mjs";
        return lib;
      });
    }
    return pdfjsLibPromise;
  }

  async function renderPdfInto(container, f) {
    container.innerHTML = '<p class="attachment-pdf-status">Loading…</p>';
    try {
      const pdfjsLib = await loadPdfJs();
      const loadingTask = f.blob
        ? pdfjsLib.getDocument({ data: await f.blob.arrayBuffer() })
        : pdfjsLib.getDocument({ url: f.url });
      const pdf = await loadingTask.promise;
      if (attachmentModal.hidden) return; // closed while loading

      container.innerHTML = "";
      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        container.appendChild(canvas);
      }
    } catch (err) {
      container.innerHTML = '<p class="attachment-pdf-status">Couldn\'t display this PDF.</p>';
    }
  }

  // The full-size viewer for one or more of a ticket's attached files —
  // swipeable (native horizontal scroll-snap, no custom gesture code) when
  // there's more than one, with page dots to match. startIndex lets a tap
  // on a specific file (e.g. in the edit form's file list) open the
  // carousel already on that one.
  function openAttachmentCarousel(files, startIndex) {
    attachmentCarousel.innerHTML = "";
    attachmentDots.innerHTML = "";
    attachmentDots.hidden = files.length <= 1;

    files.forEach((f, i) => {
      const slide = document.createElement("div");
      slide.className = "attachment-slide";

      if (f.type && f.type.startsWith("image/")) {
        const img = document.createElement("img");
        img.alt = "";
        img.src = fileImageSrc(f);
        slide.appendChild(img);
      } else {
        const pdfContainer = document.createElement("div");
        pdfContainer.className = "attachment-pdf";
        slide.appendChild(pdfContainer);
        renderPdfInto(pdfContainer, f);
      }

      attachmentCarousel.appendChild(slide);

      if (files.length > 1) {
        const dot = document.createElement("span");
        dot.className = "attachment-dot" + (i === startIndex ? " is-active" : "");
        attachmentDots.appendChild(dot);
      }
    });

    attachmentModal.hidden = false;

    const slideEls = attachmentCarousel.children;
    if (slideEls[startIndex]) {
      attachmentCarousel.scrollLeft = slideEls[startIndex].offsetLeft;
    }
  }

  attachmentCarousel.addEventListener("scroll", () => {
    if (!attachmentCarousel.clientWidth) return;
    const idx = Math.round(attachmentCarousel.scrollLeft / attachmentCarousel.clientWidth);
    [...attachmentDots.children].forEach((dot, i) => dot.classList.toggle("is-active", i === idx));
  });

  attachmentModal.querySelectorAll("[data-attachment-close]").forEach((el) =>
    el.addEventListener("click", () => {
      attachmentModal.hidden = true;
      attachmentCarousel.innerHTML = "";
      attachmentDots.innerHTML = "";
    })
  );

  // ---- Share choice: new ticket, or attach the shared file to an existing one? ----

  const shareChoiceModal = document.getElementById("share-choice-modal");
  const shareChoicePreview = document.getElementById("share-choice-preview");
  const shareChoiceNewBtn = document.getElementById("share-choice-new-btn");
  const shareChoiceExistingBtn = document.getElementById("share-choice-existing-btn");
  const pickerModal = document.getElementById("picker-modal");
  const pickerList = document.getElementById("picker-list");

  let pendingShare = null; // { parsed, fileBlob, fileType, fileName } while the choice/picker modals are open

  function openShareChoiceModal(parsed, share) {
    pendingShare = { parsed, fileBlob: share.fileBlob, fileType: share.fileType, fileName: share.fileName };

    shareChoicePreview.innerHTML = "";
    if (share.fileBlob && share.fileType && share.fileType.startsWith("image/")) {
      const img = document.createElement("img");
      img.alt = "";
      img.src = trackUrl(URL.createObjectURL(share.fileBlob));
      shareChoicePreview.appendChild(img);
    } else if (share.fileBlob) {
      const icon = document.createElement("div");
      icon.className = "file-list-icon";
      icon.textContent = "📄";
      shareChoicePreview.appendChild(icon);
    }
    const name = document.createElement("span");
    name.className = "file-preview-name";
    name.textContent = share.fileName || parsed.eventName || "Shared info";
    shareChoicePreview.appendChild(name);

    shareChoiceModal.hidden = false;
  }

  function closeShareChoiceModal() {
    shareChoiceModal.hidden = true;
  }

  shareChoiceModal.querySelectorAll("[data-share-choice-close]").forEach((el) =>
    el.addEventListener("click", () => {
      pendingShare = null;
      closeShareChoiceModal();
    })
  );

  shareChoiceNewBtn.addEventListener("click", () => {
    const share = pendingShare;
    closeShareChoiceModal();
    if (!share) return;
    openAddModal({ ...share.parsed, fileBlob: share.fileBlob, fileType: share.fileType, fileName: share.fileName });
    pendingShare = null;
  });

  shareChoiceExistingBtn.addEventListener("click", () => {
    closeShareChoiceModal();
    openPickerModal();
  });

  // Generic tappable-list modal, reused for "which ticket?" and "which file?".
  function openListPicker(title, items) {
    document.getElementById("picker-title").textContent = title;
    pickerList.innerHTML = "";
    for (const item of items) {
      const li = document.createElement("li");
      const row = document.createElement("button");
      row.type = "button";
      row.className = "picker-row";
      row.addEventListener("click", () => {
        closePickerModal();
        item.onSelect();
      });

      const primary = document.createElement("span");
      primary.className = "picker-row-name";
      primary.textContent = item.primary;
      row.appendChild(primary);

      if (item.secondary) {
        const secondary = document.createElement("span");
        secondary.className = "picker-row-date";
        secondary.textContent = item.secondary;
        row.appendChild(secondary);
      }

      li.appendChild(row);
      pickerList.appendChild(li);
    }
    pickerModal.hidden = false;
  }

  function closePickerModal() {
    pickerModal.hidden = true;
  }

  pickerModal.querySelectorAll("[data-picker-close]").forEach((el) =>
    el.addEventListener("click", () => {
      pendingShare = null;
      closePickerModal();
    })
  );

  function openPickerModal() {
    const sorted = [...tickets].sort((a, b) => ticketDateTime(b) - ticketDateTime(a));
    openListPicker(
      "Add to which event?",
      sorted.map((t) => ({
        primary: t.eventName,
        secondary: formatDate(t.date),
        onSelect: () => applySharedContentToTicket(t.id),
      }))
    );
  }


  // Opens an existing ticket's Edit form, then layers the shared content on
  // top: any file gets appended (never replaces existing attachments), and
  // parsed text fields fill in only fields the ticket doesn't already have a
  // value for — so a second, less-detailed share can't clobber what a first
  // one already got right.
  function applySharedContentToTicket(ticketId) {
    const share = pendingShare;
    pendingShare = null;
    if (!share) return;
    openEditModal(ticketId);

    const parsed = share.parsed || {};
    const fillIfEmpty = (input, value) => {
      if (value && !input.value.trim()) input.value = value;
    };
    fillIfEmpty(ticketForm.venue, parsed.venue);
    if (parsed.date && !ticketForm.date.value) ticketForm.date.value = parsed.date;
    if (parsed.time && !timeInput.value) setTimeSelects(parsed.time);
    fillIfEmpty(ticketForm.price, parsed.price);
    fillIfEmpty(ticketForm.seat, parsed.seat);
    fillIfEmpty(ticketForm.source, parsed.source);
    fillIfEmpty(ticketForm.confirmation, parsed.confirmation);

    if (share.fileBlob) {
      workingFiles.push({ blob: share.fileBlob, name: share.fileName, type: share.fileType });
      renderFileList();
    }
  }

  // ---- Family setup (share with family vs. this device only) ----

  const familySetupModal = document.getElementById("family-setup-modal");
  const familySetupCloseBtn = document.getElementById("family-setup-close-x");
  const familySetupChoiceView = document.getElementById("family-setup-choice");
  const familySetupJoinView = document.getElementById("family-setup-join");
  const familySetupDoneView = document.getElementById("family-setup-done");
  const familyCreateBtn = document.getElementById("family-create-btn");
  const familyJoinOpenBtn = document.getElementById("family-join-open-btn");
  const familyLocalBtn = document.getElementById("family-local-btn");
  const familyJoinCodeInput = document.getElementById("family-join-code-input");
  const familyJoinConfirmBtn = document.getElementById("family-join-confirm-btn");
  const familyJoinBackBtn = document.getElementById("family-join-back-btn");
  const familyJoinError = document.getElementById("family-join-error");
  const familySetupCodeDisplay = document.getElementById("family-setup-code-display");
  const familyMigrateRow = document.getElementById("family-migrate-row");
  const familyMigrateCount = document.getElementById("family-migrate-count");
  const familyMigrateBtn = document.getElementById("family-migrate-btn");
  const familyMigrateSkipBtn = document.getElementById("family-migrate-skip-btn");
  const familySetupDoneCloseBtn = document.getElementById("family-setup-done-close-btn");
  const familyInviteBtn = document.getElementById("family-invite-btn");
  const familyCopyBtn = document.getElementById("family-copy-code-btn");
  const familyLeaveBtn = document.getElementById("family-leave-btn");
  const headerSettingsBtn = document.getElementById("header-settings-btn");

  function showFamilySetupView(view) {
    familySetupChoiceView.hidden = view !== "choice";
    familySetupJoinView.hidden = view !== "join";
    familySetupDoneView.hidden = view !== "done";
  }

  // The very first run (no mode chosen yet) is mandatory — no × to bail out
  // of without picking something. Opened later from the gear icon, it's a
  // normal dismissible modal.
  function openFamilySetupModal({ mandatory }) {
    familySetupCloseBtn.hidden = !!mandatory;
    familyJoinCodeInput.value = "";
    familyJoinError.hidden = true;
    if (getMode() === "cloud") {
      showFamilyDoneView(getFamilyCode(), { offerMigration: false });
    } else {
      showFamilySetupView("choice");
    }
    familySetupModal.hidden = false;
  }

  function closeFamilySetupModal() {
    familySetupModal.hidden = true;
  }

  async function showFamilyDoneView(code, { offerMigration }) {
    familySetupCodeDisplay.textContent = code;
    familyMigrateRow.hidden = true;
    showFamilySetupView("done");
    if (offerMigration) {
      const localTickets = await getAllLocalTickets();
      if (localTickets.length) {
        familyMigrateCount.textContent = String(localTickets.length);
        familyMigrateRow.hidden = false;
      }
    }
  }

  familyCreateBtn.addEventListener("click", async () => {
    familyCreateBtn.disabled = true;
    try {
      const code = await createFamily();
      await showFamilyDoneView(code, { offerMigration: true });
      await continueInit();
    } catch (err) {
      console.error(err);
      alert("Couldn't create a family right now — check your connection and try again.");
    } finally {
      familyCreateBtn.disabled = false;
    }
  });

  familyJoinOpenBtn.addEventListener("click", () => showFamilySetupView("join"));
  familyJoinBackBtn.addEventListener("click", () => showFamilySetupView("choice"));

  familyJoinConfirmBtn.addEventListener("click", async () => {
    const code = familyJoinCodeInput.value.trim().toUpperCase();
    if (!code) return;
    familyJoinConfirmBtn.disabled = true;
    familyJoinError.hidden = true;
    try {
      const joined = await joinFamily(code);
      if (!joined) {
        familyJoinError.textContent = "That code wasn't found — double-check it and try again.";
        familyJoinError.hidden = false;
        return;
      }
      await showFamilyDoneView(code, { offerMigration: false });
      await continueInit();
    } catch (err) {
      console.error(err);
      familyJoinError.textContent = "Couldn't check that code — check your connection and try again.";
      familyJoinError.hidden = false;
    } finally {
      familyJoinConfirmBtn.disabled = false;
    }
  });

  familyLocalBtn.addEventListener("click", async () => {
    useLocalOnly();
    closeFamilySetupModal();
    await continueInit();
  });

  familyMigrateBtn.addEventListener("click", async () => {
    familyMigrateBtn.disabled = true;
    try {
      const localTickets = await getAllLocalTickets();
      for (const t of localTickets) {
        const files = getTicketFiles(t);
        const uploadedFiles = files.length ? await uploadWorkingFilesForCloud(t.id, files) : [];
        const { fileBlob, fileType, fileName, ...rest } = t;
        await familyTicketsCollection().doc(t.id).set({ ...rest, files: uploadedFiles });
        await deleteLocalTicket(t.id);
      }
      familyMigrateRow.hidden = true;
    } catch (err) {
      console.error(err);
      alert("Some shows couldn't be moved over — you can try again from the gear icon later.");
    } finally {
      familyMigrateBtn.disabled = false;
    }
  });

  familyMigrateSkipBtn.addEventListener("click", () => {
    familyMigrateRow.hidden = true;
  });

  familySetupCloseBtn.addEventListener("click", closeFamilySetupModal);
  familySetupDoneCloseBtn.addEventListener("click", closeFamilySetupModal);

  familyCopyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(getFamilyCode());
      familyCopyBtn.textContent = "Copied!";
      setTimeout(() => (familyCopyBtn.textContent = "Copy code"), 1500);
    } catch {
      // Clipboard permission denied or unavailable — the code is already
      // visible on screen, so there's nothing more useful to do here.
    }
  });

  familyInviteBtn.addEventListener("click", async () => {
    const code = getFamilyCode();
    const text = `Join my Showtime family so we can see the same shows! Open ${location.origin}${location.pathname} and choose "Join a family" with this code: ${code}`;
    if (navigator.share) {
      try {
        await navigator.share({ text });
        return;
      } catch {
        return; // user cancelled the share sheet
      }
    }
    location.href = `mailto:?subject=${encodeURIComponent("Join my Showtime family")}&body=${encodeURIComponent(text)}`;
  });

  familyLeaveBtn.addEventListener("click", async () => {
    if (!confirm("Switch this device back to local-only? You'll stop seeing the shared family list here (nothing is deleted from it).")) return;
    if (unsubscribeTicketsListener) {
      unsubscribeTicketsListener();
      unsubscribeTicketsListener = null;
    }
    useLocalOnly();
    closeFamilySetupModal();
    await continueInit();
  });

  headerSettingsBtn.addEventListener("click", () => openFamilySetupModal({ mandatory: false }));

  // ---- Load ----

  async function reload() {
    if (getMode() === "cloud") {
      await ensureFirebase();
      await startTicketsSync();
      return;
    }
    revokeTrackedUrls();
    tickets = await getAllLocalTickets();
    render();
  }

  async function consumeSharedContentIfAny() {
    if (new URLSearchParams(location.search).get("shared") !== "1") return;
    history.replaceState(null, "", location.pathname);

    const share = await takePendingShare();
    if (!share) return;

    const parsed = parseSharedText(share.title, share.text || share.url);

    if (tickets.length > 0) {
      openShareChoiceModal(parsed, share);
    } else {
      openAddModal({ ...parsed, fileBlob: share.fileBlob, fileType: share.fileType, fileName: share.fileName });
    }
  }

  async function continueInit() {
    await reload();
    await consumeSharedContentIfAny();
  }

  if (!getMode()) {
    openFamilySetupModal({ mandatory: true });
  } else {
    continueInit();
  }

  // ---- Back-gesture guard (Android) ----
  // A page with no browser-history entries makes Android's back button/edge-swipe
  // close the app outright instead of doing anything in-page. Keep one extra
  // history entry armed so that gesture always lands on us as a popstate event
  // instead — closing the topmost open modal first (respecting the same
  // unsaved-changes and mandatory-setup guards their own close buttons use),
  // or returning to the Upcoming tab.

  const BACK_DEFAULT_VIEW = "upcoming";

  function closeAnyOpenOverlay() {
    if (!unsavedModal.hidden) { unsavedModal.hidden = true; return true; }
    if (!familySetupModal.hidden) {
      if (!familySetupCloseBtn.hidden) closeFamilySetupModal();
      return true; // mandatory setup stays open either way; gesture is still consumed
    }
    if (!attachmentModal.hidden) {
      attachmentModal.hidden = true;
      attachmentCarousel.innerHTML = "";
      attachmentDots.innerHTML = "";
      return true;
    }
    if (!shareChoiceModal.hidden) { pendingShare = null; closeShareChoiceModal(); return true; }
    if (!pickerModal.hidden) { pendingShare = null; closePickerModal(); return true; }
    if (!ticketModal.hidden) { attemptCloseTicketModal(); return true; }
    return false;
  }

  function armBackGuard() {
    try { history.pushState({ showtimeGuard: true }, ""); } catch (e) { /* ignore */ }
  }

  window.addEventListener("popstate", () => {
    if (!closeAnyOpenOverlay() && currentView !== BACK_DEFAULT_VIEW) switchView(BACK_DEFAULT_VIEW);
    armBackGuard();
  });

  armBackGuard();

  // ---- Service worker (offline support) ----

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }
})();
