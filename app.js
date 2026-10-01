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

  // Looks for a weekday name — English or Hebrew ("יום ב׳" style, plus
  // "שבת" for Saturday) — to disambiguate an otherwise-ambiguous slash date.
  // Returns a JS Date.getDay() index (0 = Sunday) or null if none found.
  const WEEKDAY_RE =
    /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b|יום\s*([א-ו])['׳]?|(שבת)/i;
  function parseWeekdayHint(s) {
    const m = s.match(WEEKDAY_RE);
    if (!m) return null;
    if (m[1]) return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(m[1].toLowerCase());
    if (m[3]) return 6; // שבת = Saturday
    return "אבגדהו".indexOf(m[2]); // א=Sun ... ו=Fri
  }

  // Some sharing apps put a bare URL the user shared into the share
  // target's "text" field rather than "url" (which field a share lands in
  // is up to the sharing app / OS, not something this app controls) — catch
  // that case too so a web-ticket link still gets saved either way.
  function bareUrlOrNull(s) {
    if (!s) return null;
    const trimmed = s.trim();
    return /^https?:\/\/\S+$/i.test(trimmed) ? trimmed : null;
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
    const SLASH_DATE_RE = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/;
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
      const slashMatch = combined.match(SLASH_DATE_RE);
      if (slashMatch) {
        let [, a, b, yy] = slashMatch;
        if (yy.length === 2) yy = "20" + yy;
        const an = Number(a);
        const bn = Number(b);
        // Slash dates are ambiguous (MM/DD, US style, vs DD/MM, most of the
        // rest of the world — including the Hebrew listings this app
        // increasingly sees shared in). Default to MM/DD, matching the US
        // ticketing emails this was originally tuned against, but override
        // it when: only one order is even a valid date (a month can't be >
        // 12), or a weekday name elsewhere in the text (English or Hebrew)
        // tells us which interpretation actually falls on that weekday.
        let mm = an,
          dd = bn;
        if (an > 12 && bn <= 12) {
          mm = bn;
          dd = an;
        } else if (an <= 12 && bn <= 12 && an !== bn) {
          const weekday = parseWeekdayHint(combined);
          if (weekday !== null) {
            const asMmDd = new Date(`${yy}-${String(an).padStart(2, "0")}-${String(bn).padStart(2, "0")}T00:00`);
            const asDdMm = new Date(`${yy}-${String(bn).padStart(2, "0")}-${String(an).padStart(2, "0")}T00:00`);
            if (!Number.isNaN(asDdMm.getTime()) && asDdMm.getDay() === weekday && asMmDd.getDay() !== weekday) {
              mm = bn;
              dd = an;
            }
          }
        }
        const parsed = new Date(`${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}T00:00`);
        if (!Number.isNaN(parsed.getTime())) result.date = parsed.toISOString().slice(0, 10);
      }
    }

    const ampmMatch = combined.match(/\b(\d{1,2}):(\d{2})\s?(AM|PM|am|pm)\b/);
    // Plain 24-hour time (e.g. "20:00") — common everywhere outside the US —
    // has no AM/PM marker to match above, so it needs its own pattern.
    const h24Match = !ampmMatch && combined.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    if (ampmMatch) {
      let h = parseInt(ampmMatch[1], 10);
      const ampm = ampmMatch[3].toLowerCase();
      if (ampm === "pm" && h !== 12) h += 12;
      if (ampm === "am" && h === 12) h = 0;
      result.time = `${String(h).padStart(2, "0")}:${ampmMatch[2]}`;
    } else if (h24Match) {
      result.time = `${h24Match[1].padStart(2, "0")}:${h24Match[2]}`;
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
    // Month-name dates were the only thing checked here before, so a listing
    // with only a numeric/slash date (common outside the US — the Hebrew
    // listings above included) never anchored this fallback at all, leaving
    // both eventName and venue blank even though the date itself parsed.
    const dateLineIndex = rawLines.findIndex((l) => dateRe.test(l) || SLASH_DATE_RE.test(l));

    // Some share sources (e.g. Safari/Notes sharing selected text) prepend a
    // line like "Included Link:" or the raw URL ahead of the actual content —
    // skip lines like that rather than assuming line 0 is always the name.
    // A bare "Label:" line (date/venue label text printed on its own line,
    // value on the next) counts too, in either language.
    function looksLikeShareJunk(l) {
      return (
        /^https?:\/\//i.test(l) ||
        /^(including?|included)\s+link\b/i.test(l) ||
        /^sent from\b/i.test(l) ||
        /^shared (from|via)\b/i.test(l) ||
        /^(dear|hi|hello)\b/i.test(l) ||
        /[{}]/.test(l) ||
        /^.{1,24}:\s*$/.test(l)
      );
    }

    if (!result.eventName && dateLineIndex > 0) {
      const candidate = rawLines.slice(0, dateLineIndex).find((l) => !looksLikeShareJunk(l));
      if (candidate && candidate.length <= 80 && !looksLikeFilename(candidate)) {
        result.eventName = candidate;
      }
    }

    if (!result.venue && dateLineIndex >= 0) {
      const candidate = rawLines.slice(dateLineIndex + 1).find((l) => {
        const looksLikeNotVenue =
          looksLikeShareJunk(l) ||
          /^(view|buy|get|register|rsvp|section|order|ticket)/i.test(l) ||
          /^\$/.test(l) ||
          dateRe.test(l) ||
          SLASH_DATE_RE.test(l);
        return !looksLikeNotVenue;
      });
      if (candidate && candidate.length <= 60) {
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
  let infoTicketId = null; // ticket currently shown in the read-only info modal
  let workingFiles = []; // [{ blob, name, type }] (freshly picked) or [{ url, path, name, type }] (already in cloud Storage)
  let workingLinks = []; // [url, ...]
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

  // ticketLinks is the current (list) shape; ticketLink is the older
  // single-string shape still present on records saved before multiple
  // links were supported.
  function getTicketLinks(t) {
    if (t.ticketLinks && t.ticketLinks.length) return t.ticketLinks;
    if (t.ticketLink) return [t.ticketLink];
    return [];
  }

  // Files and links together, in the single order the attachment carousel
  // swipes through: whichever "the ticket" actually is for this event,
  // whether that's a photo, a PDF, or a link to a live web e-ticket.
  function getTicketViewables(t) {
    const items = getTicketFiles(t).map((file) => ({ kind: "file", file }));
    getTicketLinks(t).forEach((url) => items.push({ kind: "link", url }));
    return items;
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
  // photo/PDF (the actual ticket) OR a saved ticket link (just as real —
  // e.g. an Eventim e-ticket page with a live QR code, just not a file) and
  // it moves itself into Upcoming/Past based on its date. ticketConfirmed is
  // the manual escape hatch for tickets that can never have a file or a
  // link either (e.g. a vendor's live rotating barcode only viewable in
  // their own app, no URL to save) — left-swipe in Planned sets it.
  function isPlanned(t) {
    return getTicketFiles(t).length === 0 && getTicketLinks(t).length === 0 && !t.ticketConfirmed;
  }

  function render() {
    const planned = tickets.filter(isPlanned).sort((a, b) => ticketDateTime(a) - ticketDateTime(b));
    const upcoming = tickets
      .filter((t) => !isPlanned(t) && isUpcoming(t) && !t.movedToPast)
      .sort((a, b) => ticketDateTime(a) - ticketDateTime(b));
    const past = tickets
      .filter((t) => !isPlanned(t) && (!isUpcoming(t) || t.movedToPast))
      .sort((a, b) => ticketDateTime(b) - ticketDateTime(a));

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
    // hatch). Within Upcoming it depends on why the ticket's there: a real
    // file or a saved link -> Past (done with it / archiving early, doesn't
    // need to wait for the date), otherwise -> Planned (undoes the
    // ticketConfirmed override — a ticket with a real file or link can't be
    // swiped back to Planned, since that would mean discarding it, too big
    // a step for a swipe, so it only ever goes to Past instead).
    const links = getTicketLinks(t);
    const canMoveToPast = listKind === "upcoming" && (files.length > 0 || links.length > 0);
    const canMoveToUpcoming = listKind === "planned";
    const canMoveToPlanned = listKind === "upcoming" && !canMoveToPast && !!t.ticketConfirmed;
    const canSwipeLeft = canMoveToUpcoming || canMoveToPast || canMoveToPlanned;
    let moveBg = null;
    if (canSwipeLeft) {
      moveBg = document.createElement("div");
      moveBg.className = "ticket-row-move-bg";
      moveBg.textContent = canMoveToUpcoming ? "Move to Upcoming" : canMoveToPast ? "Move to Past" : "Move to Planned";
      moveBg.setAttribute("aria-hidden", "true");
      li.appendChild(moveBg);
    }

    const card = document.createElement("div");
    const soon = (listKind === "upcoming" && daysUntil(t) <= 7) || !!tier;
    card.className = "ticket-card" + (soon ? " is-soon" : "");
    card.tabIndex = 0;
    const onSwipeLeft = canMoveToUpcoming ? swipeMoveToUpcoming : canMoveToPast ? swipeMoveToPast : swipeMoveToPlanned;
    wireCardGestures(card, t, canSwipeLeft, moveBg, onSwipeLeft);

    const thumbWrap = document.createElement("div");
    thumbWrap.className = "ticket-thumb-wrap";
    const ph = document.createElement("div");
    ph.className = "ticket-thumb-placeholder";
    // Purple ticket = a ticket is in hand (a real file, or manually
    // confirmed via ticketConfirmed); planned events swap it for a calendar.
    ph.innerHTML = '<span class="ticket-thumb-emoji">🎟️</span>';
    if (planned) {
      // Planned events get a calendar in place of the ticket. If anything
      // else lands on the same day, the same icon gets a small badge: a red
      // no-entry for a real overlap (start times under 3 hours apart),
      // an amber clock when the times are far enough apart to work.
      const conflicts = findConflicts(t.date, t.time, t.id);
      ph.innerHTML = PLANNED_ICON;
      if (conflicts.length) {
        const hard = conflicts.filter((c) => c.level === "hard");
        if (hard.length) {
          ph.title = hard.some((c) => !isPlanned(c.t))
            ? "Overlaps an event you already have tickets for"
            : "Overlaps another planned event";
          ph.insertAdjacentHTML("beforeend", NO_ENTRY_BADGE);
        } else {
          ph.title = "Same day as another event, but the times don't overlap";
          ph.insertAdjacentHTML("beforeend", CLOCK_BADGE);
        }
      }
    }
    thumbWrap.appendChild(ph);
    if (!files.length && links.length) {
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
      openInfoModal(t.id);
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

  // A plain auto-dismissing confirmation, reusing the undo bar's pill with
  // its Undo button hidden — for actions (like a calendar file download)
  // that need visible "this worked" feedback but have nothing to undo.
  // Skipped while a real pending action is showing, so it can't stomp on
  // an active delete/move Undo prompt.
  let toastTimer = null;
  function showToast(message, ms = 2500) {
    if (pendingAction) return;
    clearTimeout(toastTimer);
    undoBtn.hidden = true;
    showUndoBar(message);
    toastTimer = setTimeout(() => {
      hideUndoBar();
      undoBtn.hidden = false;
    }, ms);
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
    } else if (type === "movePast") {
      await putTicket({ ...ticket, movedToPast: true });
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

  // Upcoming/Past is otherwise purely date-driven (isUpcoming) — this is a
  // manual override for archiving a ticket early, without waiting for its
  // date to actually pass. Only offered on Upcoming cards with a real file
  // attached (see canMoveToPast above); a ticketConfirmed-no-file card
  // swipes to Planned instead.
  function swipeMoveToPast(ticket) {
    finalizePendingAction();
    const updated = { ...ticket, movedToPast: true };
    tickets = tickets.map((t) => (t.id === ticket.id ? updated : t));
    render();
    showUndoBar(`Moved "${ticket.eventName}" to Past`);
    pendingAction = { type: "movePast", ticket, timer: setTimeout(finalizePendingAction, UNDO_WINDOW_MS) };
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
    const items = getTicketViewables(t);
    if (!items.length) return;
    // A single link has nothing to swipe to, so skip the viewer and jump
    // straight to it — the common case stays one tap. Everything else
    // (any file, or more than one item of either kind) opens the carousel,
    // swiping across files and links together in one place.
    if (items.length === 1 && items[0].kind === "link") {
      window.open(items[0].url, "_blank", "noopener");
      return;
    }
    openAttachmentCarousel(items, 0);
  }

  // ---- Tabs ----

  const VIEW_KEY = "showtime-view";

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
    try {
      sessionStorage.setItem(VIEW_KEY, view);
    } catch {
      // Storage blocked — the tab just won't survive a refresh.
    }
  }

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => switchView(tab.dataset.view));
  });

  // Pull-to-refresh reloads the whole page, which would otherwise dump you
  // back on Upcoming. sessionStorage (not localStorage) survives a reload but
  // not closing the app, so a fresh launch still starts on Upcoming.
  try {
    const savedView = sessionStorage.getItem(VIEW_KEY);
    if (savedView && views[savedView]) switchView(savedView);
  } catch {
    // Storage blocked — start on the default tab.
  }

  // ---- Ticket modal ----

  const ticketModal = document.getElementById("ticket-modal");
  const ticketModalTitle = document.getElementById("ticket-modal-title");
  const ticketForm = document.getElementById("ticket-form");
  const fileInput = document.getElementById("file-input");
  const fileListEl = document.getElementById("file-list");
  const ticketLinkInput = document.getElementById("ticket-link-input");
  const ticketLinkAddBtn = document.getElementById("ticket-link-add-btn");
  const ticketLinkListEl = document.getElementById("ticket-link-list");
  const unsavedModal = document.getElementById("unsaved-modal");

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

  // Picking an hour with no minutes yet fills in :00 — most shows start on
  // the hour, so that's one fewer thing to tap. Registered before the
  // listeners below so the time is complete by the time they run.
  timeHourSelect.addEventListener("change", () => {
    if (timeHourSelect.value && !timeMinuteSelect.value) timeMinuteSelect.value = "00";
  });

  [timeHourSelect, timeMinuteSelect].forEach((sel) => sel.addEventListener("change", syncHiddenTime));

  // ---- Schedule-conflict warning ----
  //
  // Any other not-yet-past event on the same date is flagged, at one of two
  // levels: "hard" when the start times are under 3 hours apart (or either
  // has no time set, so overlap can't be ruled out) — a real double-booking
  // risk; "soft" when it's the same day but the times are far enough apart
  // that both are probably doable (an 11 AM and a 6:30 PM show). Listed
  // with times and labeled by whether tickets are in hand (Upcoming) or
  // still just Planned. Past events and the one being edited are ignored.
  // Warns only — never blocks saving.

  const CONFLICT_HARD_GAP_MIN = 180;

  const conflictWarningEl = document.getElementById("conflict-warning");
  const CONFLICT_ICON =
    '<svg class="conflict-icon" viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">' +
    '<rect x="3" y="5" width="18" height="16" rx="2.5" fill="#fff" stroke="#7d7d94" stroke-width="1.6"/>' +
    '<path d="M3 10h18" stroke="#7d7d94" stroke-width="1.6"/>' +
    '<path d="M8 3v4M16 3v4" stroke="#7d7d94" stroke-width="1.6" stroke-linecap="round"/>' +
    '<circle cx="16.5" cy="16.5" r="6" fill="#fff" stroke="#c0392b" stroke-width="2"/>' +
    '<path d="M12.96 20.04l7.08-7.08" stroke="#c0392b" stroke-width="2" stroke-linecap="round"/>' +
    "</svg>";
  // Plain white calendar for planned events that don't conflict with anything.
  const PLANNED_ICON =
    '<svg class="planned-icon" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round">' +
    '<rect x="3" y="5" width="18" height="16" rx="2.5"/>' +
    '<path d="M3 10h18M8 3v4M16 3v4"/>' +
    '<path d="M8 14h.01M12 14h.01M16 14h.01M8 17.5h.01M12 17.5h.01" stroke-width="2.4"/>' +
    "</svg>";

  // (Slash endpoints are kept inside the ring, not out at its outer edge —
  // round caps flush with the edge read as poking out at this size.)
  // Small red no-entry badge overlaid on a planned event's normal calendar box
  // when it conflicts with another event.
  const NO_ENTRY_BADGE =
    '<svg class="conflict-badge" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="10" fill="#fff" stroke="#c0392b" stroke-width="2.6"/>' +
    '<path d="M6.34 17.66l11.32-11.32" stroke="#c0392b" stroke-width="2.6" stroke-linecap="round"/>' +
    "</svg>";
  // Softer amber clock badge: same day, but the times don't overlap.
  const CLOCK_BADGE =
    '<svg class="conflict-badge" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="10" fill="#fff" stroke="#d97706" stroke-width="2.6"/>' +
    '<path d="M12 6.5V12l3.6 2.2" fill="none" stroke="#d97706" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>' +
    "</svg>";
  const SOFT_ICON =
    '<svg class="conflict-icon" viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">' +
    '<rect x="3" y="5" width="18" height="16" rx="2.5" fill="#fff" stroke="#7d7d94" stroke-width="1.6"/>' +
    '<path d="M3 10h18" stroke="#7d7d94" stroke-width="1.6"/>' +
    '<path d="M8 3v4M16 3v4" stroke="#7d7d94" stroke-width="1.6" stroke-linecap="round"/>' +
    '<circle cx="16.5" cy="16.5" r="6" fill="#fff" stroke="#d97706" stroke-width="2"/>' +
    '<path d="M16.5 13v3.6l2.3 1.4" fill="none" stroke="#d97706" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>' +
    "</svg>";

  function timeToMinutes(time) {
    const [h, m] = time.split(":").map(Number);
    return h * 60 + m;
  }

  // Returns [{ t, level }] for every other same-day, not-yet-past event.
  function findConflicts(date, time, excludeId) {
    if (!date) return [];
    return tickets
      .filter((t) => t.id !== excludeId && t.date === date && isUpcoming(t) && !t.movedToPast)
      .sort((a, b) => ticketDateTime(a) - ticketDateTime(b))
      .map((t) => {
        const close = !time || !t.time || Math.abs(timeToMinutes(time) - timeToMinutes(t.time)) < CONFLICT_HARD_GAP_MIN;
        return { t, level: close ? "hard" : "soft" };
      });
  }

  function renderConflictWarning() {
    const conflicts = findConflicts(ticketForm.date.value, timeInput.value, editingId);
    if (!conflicts.length) {
      conflictWarningEl.hidden = true;
      conflictWarningEl.innerHTML = "";
      return;
    }
    const hard = conflicts.filter((c) => c.level === "hard");
    const ticketed = hard.some((c) => !isPlanned(c.t));
    conflictWarningEl.className =
      "conflict-warning" + (!hard.length ? " is-soft" : ticketed ? " is-ticketed" : "");
    conflictWarningEl.innerHTML = "";

    const head = document.createElement("div");
    head.className = "conflict-head";
    head.innerHTML = hard.length ? CONFLICT_ICON : SOFT_ICON;
    const title = document.createElement("strong");
    title.textContent = !hard.length
      ? "Also that day — the times don't overlap"
      : ticketed
        ? "Double-booked — you already have tickets"
        : "Heads up — clashes with a planned event";
    head.appendChild(title);
    conflictWarningEl.appendChild(head);

    const list = document.createElement("ul");
    list.className = "conflict-list";
    for (const { t, level } of conflicts) {
      const li = document.createElement("li");
      const when = [formatDate(t.date), t.time ? formatTime(t.time) : "all day"].join(" · ");
      const status = isPlanned(t) ? "planned, no tickets yet" : "tickets in hand";
      li.textContent = `${t.eventName} — ${when} (${status}${hard.length && level === "soft" ? "; different time" : ""})`;
      list.appendChild(li);
    }
    conflictWarningEl.appendChild(list);
    conflictWarningEl.hidden = false;
  }

  ticketForm.date.addEventListener("input", renderConflictWarning);
  ticketForm.date.addEventListener("change", renderConflictWarning);
  [timeHourSelect, timeMinuteSelect].forEach((sel) => sel.addEventListener("change", renderConflictWarning));

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
      ticketLinks: workingLinks.slice(),
      files: workingFiles.map((f) => `${f.name}|${f.type}|${f.blob ? f.blob.size : f.path || ""}`),
    });
  }

  function isTicketFormDirty() {
    return snapshotFormState() !== modalSnapshot;
  }

  function openAddModal(prefill) {
    editingId = null;
    workingFiles = [];
    workingLinks = [];
    filesPendingStorageDeletion = [];
    ticketModalTitle.textContent = "Add event";
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
      if (prefill.ticketLink) workingLinks.push(prefill.ticketLink);
      if (prefill.fileBlob) {
        workingFiles.push({ blob: prefill.fileBlob, name: prefill.fileName, type: prefill.fileType });
      }
    }

    modalSnapshot = snapshotFormState();
    renderFileList();
    renderLinkList();
    renderConflictWarning();
    ticketModal.hidden = false;
    document.getElementById("event-input").focus();
  }

  function openEditModal(id) {
    const t = tickets.find((x) => x.id === id);
    if (!t) return;
    editingId = id;
    workingFiles = getTicketFiles(t).slice();
    workingLinks = getTicketLinks(t).slice();
    filesPendingStorageDeletion = [];
    ticketModalTitle.textContent = "Edit event";
    ticketForm.reset();
    ticketForm.eventName.value = t.eventName || "";
    ticketForm.venue.value = t.venue || "";
    ticketForm.date.value = t.date || "";
    setTimeSelects(t.time || "");
    ticketForm.price.value = t.price ?? "";
    ticketForm.seat.value = t.seat || "";
    ticketForm.source.value = t.source || "";
    ticketForm.confirmation.value = t.confirmation || "";
    modalSnapshot = snapshotFormState();
    renderFileList();
    renderLinkList();
    renderConflictWarning();
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
    workingLinks = [];
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
      thumb.addEventListener("click", () => openAttachmentCarousel(workingFiles.map((wf) => ({ kind: "file", file: wf })), i));
      row.appendChild(thumb);

      const name = document.createElement("span");
      name.className = "file-preview-name file-list-name";
      name.textContent = f.name || "Attachment";
      name.addEventListener("click", () => openAttachmentCarousel(workingFiles.map((wf) => ({ kind: "file", file: wf })), i));
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

  function renderLinkList() {
    ticketLinkListEl.innerHTML = "";
    workingLinks.forEach((url, i) => {
      const row = document.createElement("li");
      row.className = "file-preview";

      const icon = document.createElement("div");
      icon.className = "file-list-icon";
      icon.textContent = "🔗";
      icon.addEventListener("click", () => window.open(url, "_blank", "noopener"));
      row.appendChild(icon);

      const name = document.createElement("span");
      name.className = "file-preview-name file-list-name";
      name.textContent = url;
      name.addEventListener("click", () => window.open(url, "_blank", "noopener"));
      row.appendChild(name);

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "file-remove-btn";
      removeBtn.setAttribute("aria-label", "Remove link");
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", () => {
        workingLinks.splice(i, 1);
        renderLinkList();
      });
      row.appendChild(removeBtn);

      ticketLinkListEl.appendChild(row);
    });
  }

  function addWorkingLink() {
    const url = ticketLinkInput.value.trim();
    if (!url || workingLinks.includes(url)) {
      ticketLinkInput.value = "";
      return;
    }
    workingLinks.push(url);
    ticketLinkInput.value = "";
    renderLinkList();
  }

  ticketLinkAddBtn.addEventListener("click", addWorkingLink);
  ticketLinkInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addWorkingLink();
    }
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

  // ---- Ticket info modal (read-only) ----
  //
  // Tapping a card opens this rather than jumping straight into Edit — a
  // form full of editable fields is a lot to look at just to check a date
  // or venue. Edit is one explicit tap away from here instead.

  const ticketInfoModal = document.getElementById("ticket-info-modal");
  const ticketInfoTitle = document.getElementById("ticket-info-title");
  const ticketInfoRows = document.getElementById("ticket-info-rows");
  const ticketInfoViewBtn = document.getElementById("ticket-info-view-btn");
  const ticketInfoEditBtn = document.getElementById("ticket-info-edit-btn");
  const addToCalendarRow = document.getElementById("add-to-calendar-row");
  const addToCalendarBtn = document.getElementById("add-to-calendar-btn");
  const addToCalendarIcsBtn = document.getElementById("add-to-calendar-ics-btn");

  function addInfoRow(label, value) {
    if (!value) return;
    const row = document.createElement("div");
    row.className = "info-row";
    const l = document.createElement("span");
    l.className = "info-label";
    l.textContent = label;
    const v = document.createElement("span");
    v.className = "info-value";
    v.textContent = value;
    row.appendChild(l);
    row.appendChild(v);
    ticketInfoRows.appendChild(row);
  }

  function addLinkRow(label, url) {
    const row = document.createElement("div");
    row.className = "info-row";
    const l = document.createElement("span");
    l.className = "info-label";
    l.textContent = label;
    const v = document.createElement("a");
    v.className = "info-value info-link";
    v.href = url;
    v.target = "_blank";
    v.rel = "noopener";
    v.textContent = "Open ↗";
    row.appendChild(l);
    row.appendChild(v);
    ticketInfoRows.appendChild(row);
  }

  function openInfoModal(id) {
    const t = tickets.find((x) => x.id === id);
    if (!t) return;
    infoTicketId = id;

    ticketInfoTitle.textContent = t.eventName;
    ticketInfoRows.innerHTML = "";
    const dateParts = [formatDate(t.date)];
    if (t.time) dateParts.push(formatTime(t.time));
    addInfoRow("Date", dateParts.join(" · "));
    addInfoRow("Venue", t.venue);
    addInfoRow("Price paid", formatPrice(t.price));
    addInfoRow("Seat / section", t.seat);
    addInfoRow("Purchased from", t.source);
    addInfoRow("Confirmation #", t.confirmation);

    const links = getTicketLinks(t);
    links.forEach((url, i) => addLinkRow(links.length > 1 ? `Ticket link ${i + 1}` : "Ticket link", url));

    // Mixing files and links opens the same combined carousel as a
    // long-press on the card, so the button's label covers the full count
    // rather than just the file half of it.
    const files = getTicketFiles(t);
    const viewableCount = files.length + links.length;
    if (viewableCount > 1) {
      ticketInfoViewBtn.textContent = `🎟️ View all ${viewableCount}`;
      ticketInfoViewBtn.hidden = false;
    } else if (files.length === 1) {
      ticketInfoViewBtn.textContent = "🎟️ View attached ticket";
      ticketInfoViewBtn.hidden = false;
    } else {
      ticketInfoViewBtn.hidden = true;
    }

    addToCalendarRow.hidden = false;
    ticketInfoModal.hidden = false;
  }

  function closeInfoModal() {
    ticketInfoModal.hidden = true;
    infoTicketId = null;
  }

  ticketInfoModal.querySelectorAll("[data-info-close]").forEach((el) => el.addEventListener("click", closeInfoModal));

  ticketInfoViewBtn.addEventListener("click", () => {
    const t = tickets.find((x) => x.id === infoTicketId);
    if (t) openAttachmentForTicket(t);
  });

  ticketInfoEditBtn.addEventListener("click", () => {
    const id = infoTicketId;
    closeInfoModal();
    if (id) openEditModal(id);
  });

  // ---- Add to calendar ----
  //
  // Two options, since they trade off differently:
  //  - Google Calendar's quick-add URL opens straight to a pre-filled
  //    "save this event" screen — no file, no share sheet, just a normal
  //    link tap. The one-more-tap experience most people expect, but only
  //    works for Google Calendar. Primary action, since Showtime's install
  //    flow (Web Share Target) is Android/Chrome-only anyway, where Google
  //    Calendar is overwhelmingly the default.
  //  - A universal .ics file (secondary) for anyone on a different
  //    calendar app — shared via navigator.share() where supported, else a
  //    direct download.
  // Dates/times in both are floating local time (no timezone conversion
  // beyond what the browser does implicitly for the Google Calendar link's
  // UTC-format dates param) — matching how the rest of the app already
  // treats them: whatever the user typed, no timezone tracked anywhere.

  function buildGoogleCalendarUrl(t) {
    const [y, m, d] = t.date.split("-").map(Number);
    const pad = (n) => String(n).padStart(2, "0");
    let datesParam;

    if (t.time) {
      const [hh, mm] = t.time.split(":").map(Number);
      const start = new Date(y, m - 1, d, hh, mm);
      const end = new Date(start.getTime() + 2 * 60 * 60 * 1000); // default 2-hour duration
      const fmt = (dt) => dt.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
      datesParam = `${fmt(start)}/${fmt(end)}`;
    } else {
      const start = new Date(y, m - 1, d);
      const end = new Date(y, m - 1, d + 1); // exclusive end date, same as .ics all-day
      const fmt = (dt) => `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}`;
      datesParam = `${fmt(start)}/${fmt(end)}`;
    }

    const params = new URLSearchParams({ action: "TEMPLATE", text: t.eventName || "", dates: datesParam });
    if (t.venue) params.set("location", t.venue);
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  }

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
      showToast(`Downloaded "${file.name}" — open it to add to your calendar`, 4000);
    } catch (err) {
      console.error(err);
      alert("Couldn't create the calendar file. Try again in a moment.");
    }
  }

  addToCalendarBtn.addEventListener("click", () => {
    const t = tickets.find((x) => x.id === infoTicketId);
    if (t) window.open(buildGoogleCalendarUrl(t), "_blank", "noopener");
  });

  addToCalendarIcsBtn.addEventListener("click", () => {
    const t = tickets.find((x) => x.id === infoTicketId);
    if (t) addTicketToCalendar(t);
  });

  const ticketSaveBtn = ticketForm.querySelector('button[type="submit"]');

  ticketForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    syncHiddenTime();
    // A link typed/pasted but never explicitly added (forgot to tap "Add",
    // or just didn't realize it was a separate step) shouldn't be silently
    // lost — Save is the real commit action, so pull it in here too.
    addWorkingLink();
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
        ticketLinks: workingLinks.slice(),
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

  // PDFs open directly (new tab, native OS/browser PDF handling) rather
  // than rendering in-app. This used to render each page onto a <canvas>
  // via a vendored pdf.js — abandoned after real-world tickets kept
  // failing to parse there (both shared in and added via "Choose Files",
  // so not a share-pipeline bug) while opening the exact same file
  // directly always worked. Two earlier approaches were also ruled out for
  // unrelated reasons: an <iframe> embed doesn't render inline on Android
  // Chrome, and a real same-window navigation to the blob: URL takes over
  // the whole installed-PWA window with no reliable way back. A new tab
  // avoids that — closing it leaves the app exactly where it was.
  function renderPdfSlideInto(container, f) {
    container.innerHTML = "";
    const icon = document.createElement("div");
    icon.className = "attachment-pdf-icon";
    icon.textContent = "📄";
    container.appendChild(icon);
    if (f.name) {
      const name = document.createElement("p");
      name.className = "attachment-pdf-status";
      name.textContent = f.name;
      container.appendChild(name);
    }
    const openLink = document.createElement("a");
    openLink.className = "attachment-pdf-open-link";
    openLink.textContent = "Open PDF";
    openLink.target = "_blank";
    openLink.rel = "noopener";
    openLink.href = f.blob ? trackUrl(URL.createObjectURL(f.blob)) : f.url;
    container.appendChild(openLink);
  }

  // A link can't render inline any more than a PDF can, so it gets the same
  // treatment: an icon and an "Open" button rather than a live preview.
  // Reuses the PDF slide's classes — same card look, different icon/label.
  function renderLinkSlideInto(container, url) {
    container.innerHTML = "";
    const icon = document.createElement("div");
    icon.className = "attachment-pdf-icon";
    icon.textContent = "🔗";
    container.appendChild(icon);
    const openLink = document.createElement("a");
    openLink.className = "attachment-pdf-open-link";
    openLink.textContent = "Open ticket link";
    openLink.target = "_blank";
    openLink.rel = "noopener";
    openLink.href = url;
    container.appendChild(openLink);
  }

  // The full-size viewer for one or more of a ticket's files and/or saved
  // links together — swipeable (native horizontal scroll-snap, no custom
  // gesture code) when there's more than one, with page dots to match.
  // `items` is the shape getTicketViewables() returns: { kind: "file", file }
  // or { kind: "link", url }. startIndex lets a tap on a specific one (e.g.
  // in the edit form's file list) open the carousel already on that one.
  function openAttachmentCarousel(items, startIndex) {
    attachmentCarousel.innerHTML = "";
    attachmentDots.innerHTML = "";
    attachmentDots.hidden = items.length <= 1;

    items.forEach((item, i) => {
      const slide = document.createElement("div");
      slide.className = "attachment-slide";

      if (item.kind === "link") {
        const linkContainer = document.createElement("div");
        linkContainer.className = "attachment-pdf";
        slide.appendChild(linkContainer);
        renderLinkSlideInto(linkContainer, item.url);
      } else if (item.file.type && item.file.type.startsWith("image/")) {
        const img = document.createElement("img");
        img.alt = "";
        img.src = fileImageSrc(item.file);
        slide.appendChild(img);
      } else {
        const pdfContainer = document.createElement("div");
        pdfContainer.className = "attachment-pdf";
        slide.appendChild(pdfContainer);
        renderPdfSlideInto(pdfContainer, item.file);
      }

      attachmentCarousel.appendChild(slide);

      if (items.length > 1) {
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
    pendingShare = { parsed, fileBlob: share.fileBlob, fileType: share.fileType, fileName: share.fileName, url: share.url };

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
    const sorted = tickets.filter(isUpcoming).sort((a, b) => ticketDateTime(a) - ticketDateTime(b));
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
    // Some vendor tickets (web e-tickets, like Eventim's) only ever offer a
    // page link to share, never a downloadable file — the link itself is
    // the closest thing to "the ticket" in that case, so it's worth saving
    // even though it's not a file attachment. Append rather than overwrite:
    // an event can have tickets for more than one seat, each with its own
    // link, and sharing a second one shouldn't silently lose the first.
    if (share.url && !workingLinks.includes(share.url)) {
      workingLinks.push(share.url);
      renderLinkList();
    }

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

    // Some vendor apps' "share ticket" action and Google Drive's "share
    // link" (vs. "send a copy") can hand over an empty or near-empty file
    // via the OS share sheet — it still shows up as an attachment, but can
    // never actually render. Catch it here instead of leaving the file
    // silently attached only to fail later with a generic PDF error.
    if (share.fileBlob && share.fileBlob.size < 100) {
      console.warn("Shared file arrived empty or near-empty", share.fileName, share.fileBlob.size);
      alert(
        `"${share.fileName || "The shared file"}" arrived empty, so it won't display. This can happen with some apps' share option — try saving it to Photos/Files first, then sharing that saved copy instead.`
      );
      share.fileBlob = null;
      share.fileType = null;
      share.fileName = null;
    }

    // A bare link shared with nothing else (no email body text) can land in
    // either field depending on the sharing app, so treat a text-only share
    // that's just a URL the same as one that arrived in the url field.
    share.url = share.url || bareUrlOrNull(share.text);

    const parsed = parseSharedText(share.title, share.text || share.url);

    if (tickets.length > 0) {
      openShareChoiceModal(parsed, share);
    } else {
      openAddModal({ ...parsed, fileBlob: share.fileBlob, fileType: share.fileType, fileName: share.fileName, ticketLink: share.url });
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
