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

  function getAllTickets() {
    return withStore(STORE_TICKETS, "readonly", (store) => {
      return new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }).then((p) => p);
  }

  function putTicket(ticket) {
    return withStore(STORE_TICKETS, "readwrite", (store) => store.put(ticket));
  }

  function deleteTicket(id) {
    return withStore(STORE_TICKETS, "readwrite", (store) => store.delete(id));
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
    // the date: the line before everything is the name, the line right
    // after is the venue.
    const dateLineIndex = rawLines.findIndex((l) => dateRe.test(l));

    if (!result.eventName && dateLineIndex > 0) {
      const candidate = rawLines[0];
      const looksLikeBoilerplate = /^(dear|hi|hello)\b/i.test(candidate) || /[{}]/.test(candidate);
      if (candidate.length <= 80 && !looksLikeFilename(candidate) && !looksLikeBoilerplate) {
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
  let workingFiles = []; // [{ blob, name, type }] — the modal's current attachment list while open
  let modalSnapshot = ""; // form state as of when the modal opened, to detect unsaved changes on close
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

  // ---- Rendering ----

  const listUpcomingEl = document.getElementById("list-upcoming");
  const listPlannedEl = document.getElementById("list-planned");
  const listPastEl = document.getElementById("list-past");
  const emptyUpcomingEl = document.getElementById("empty-upcoming");
  const emptyPlannedEl = document.getElementById("empty-planned");
  const emptyPastEl = document.getElementById("empty-past");

  // A ticket is "planned" purely by not having any attached file yet — no
  // separate flag to keep in sync. Attach a photo/PDF (the actual ticket)
  // and it moves itself into Upcoming/Past based on its date.
  function isPlanned(t) {
    return getTicketFiles(t).length === 0;
  }

  function render() {
    const planned = tickets.filter(isPlanned).sort((a, b) => ticketDateTime(a) - ticketDateTime(b));
    const upcoming = tickets.filter((t) => !isPlanned(t) && isUpcoming(t)).sort((a, b) => ticketDateTime(a) - ticketDateTime(b));
    const past = tickets.filter((t) => !isPlanned(t) && !isUpcoming(t)).sort((a, b) => ticketDateTime(b) - ticketDateTime(a));

    renderList(listUpcomingEl, upcoming, true);
    renderList(listPlannedEl, planned, false);
    renderList(listPastEl, past, false);

    emptyUpcomingEl.hidden = upcoming.length > 0;
    emptyPlannedEl.hidden = planned.length > 0;
    emptyPastEl.hidden = past.length > 0;
  }

  function renderList(el, items, isUpcomingList) {
    el.innerHTML = "";
    for (const t of items) {
      el.appendChild(renderCard(t, isUpcomingList));
    }
  }

  function renderCard(t, isUpcomingList) {
    const li = document.createElement("li");
    li.className = "ticket-row-wrap";

    const deleteBg = document.createElement("div");
    deleteBg.className = "ticket-row-delete-bg";
    deleteBg.textContent = "Delete";
    deleteBg.setAttribute("aria-hidden", "true");
    li.appendChild(deleteBg);

    const files = getTicketFiles(t);
    const planned = files.length === 0;
    const tier = planned ? reminderTier(t) : null;

    const card = document.createElement("div");
    const soon = (isUpcomingList && daysUntil(t) <= 7) || !!tier;
    card.className = "ticket-card" + (soon ? " is-soon" : "");
    card.tabIndex = 0;
    wireCardGestures(card, t);

    const thumbWrap = document.createElement("div");
    thumbWrap.className = "ticket-thumb-wrap";
    const ph = document.createElement("div");
    ph.className = "ticket-thumb-placeholder";
    // Purple = a ticket is in hand; white silhouette = still just planned,
    // no ticket secured yet — same emoji artwork either way, just recolored.
    ph.innerHTML = files.length === 0
      ? '<span class="ticket-thumb-emoji ticket-thumb-emoji-planned">🎟️</span>'
      : '<span class="ticket-thumb-emoji">🎟️</span>';
    thumbWrap.appendChild(ph);
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
  // ticket file; a right swipe past 40% of the card's width deletes it
  // (with undo). All three share one pointer-gesture state machine so they
  // can't fire on top of each other.
  const LONG_PRESS_MS = 500;
  const GESTURE_MOVE_THRESHOLD = 10;

  function wireCardGestures(card, t) {
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

      currentDx = Math.max(0, Math.min(dx, card.offsetWidth));
      card.style.transform = `translateX(${currentDx}px)`;
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
      } else {
        card.style.transform = "translateX(0)";
        // Snapped back rather than deleting — don't let a stale "this was a
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

  // ---- Swipe-to-delete with undo ----

  const undoBar = document.getElementById("undo-bar");
  const undoLabel = document.getElementById("undo-label");
  const undoBtn = document.getElementById("undo-btn");
  const UNDO_WINDOW_MS = 3000;

  let pendingDelete = null; // { ticket, timer }

  function showUndoBar(name) {
    undoLabel.textContent = `Deleted "${name}"`;
    undoBar.hidden = false;
  }

  function hideUndoBar() {
    undoBar.hidden = true;
  }

  async function finalizePendingDelete() {
    if (!pendingDelete) return;
    const { ticket, timer } = pendingDelete;
    clearTimeout(timer);
    pendingDelete = null;
    hideUndoBar();
    await deleteTicket(ticket.id);
  }

  function swipeDeleteTicket(ticket) {
    finalizePendingDelete();
    tickets = tickets.filter((t) => t.id !== ticket.id);
    render();
    showUndoBar(ticket.eventName);
    pendingDelete = { ticket, timer: setTimeout(finalizePendingDelete, UNDO_WINDOW_MS) };
  }

  function undoDelete() {
    if (!pendingDelete) return;
    clearTimeout(pendingDelete.timer);
    const { ticket } = pendingDelete;
    pendingDelete = null;
    tickets.push(ticket);
    render();
    hideUndoBar();
  }

  undoBtn.addEventListener("click", undoDelete);

  function openAttachmentForTicket(t) {
    const files = getTicketFiles(t);
    if (!files.length) return;
    openAttachmentCarousel(files, 0);
  }

  // ---- Tabs ----

  const tabs = document.querySelectorAll(".tab");
  const views = {
    upcoming: document.getElementById("view-upcoming"),
    planned: document.getElementById("view-planned"),
    past: document.getElementById("view-past"),
  };

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      currentView = tab.dataset.view;
      tabs.forEach((t) => {
        t.classList.toggle("is-active", t === tab);
        t.setAttribute("aria-current", t === tab ? "page" : "false");
      });
      Object.entries(views).forEach(([key, el]) => (el.hidden = key !== currentView));
    });
  });

  // ---- Ticket modal ----

  const ticketModal = document.getElementById("ticket-modal");
  const ticketModalTitle = document.getElementById("ticket-modal-title");
  const ticketForm = document.getElementById("ticket-form");
  const fileInput = document.getElementById("file-input");
  const fileListEl = document.getElementById("file-list");
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
      files: workingFiles.map((f) => `${f.name}|${f.type}|${f.blob ? f.blob.size : ""}`),
    });
  }

  function isTicketFormDirty() {
    return snapshotFormState() !== modalSnapshot;
  }

  function openAddModal(prefill) {
    editingId = null;
    workingFiles = [];
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
        thumb.src = trackUrl(URL.createObjectURL(f.blob));
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
        workingFiles.splice(i, 1);
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

  ticketForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    syncHiddenTime();
    const fd = new FormData(ticketForm);

    const ticket = {
      id: editingId || crypto.randomUUID(),
      eventName: fd.get("eventName").trim(),
      venue: fd.get("venue").trim(),
      date: fd.get("date"),
      time: fd.get("time"),
      price: fd.get("price") ? Number(fd.get("price")) : "",
      seat: fd.get("seat").trim(),
      source: fd.get("source").trim(),
      confirmation: fd.get("confirmation").trim(),
      files: workingFiles.map((f) => ({ blob: f.blob, type: f.type, name: f.name })),
    };

    await putTicket(ticket);
    await reload();
    closeTicketModal();
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

  async function renderPdfInto(container, blob) {
    container.innerHTML = '<p class="attachment-pdf-status">Loading…</p>';
    try {
      const pdfjsLib = await loadPdfJs();
      const pdf = await pdfjsLib.getDocument({ data: await blob.arrayBuffer() }).promise;
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
        img.src = trackUrl(URL.createObjectURL(f.blob));
        slide.appendChild(img);
      } else {
        const pdfContainer = document.createElement("div");
        pdfContainer.className = "attachment-pdf";
        slide.appendChild(pdfContainer);
        renderPdfInto(pdfContainer, f.blob);
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

  // ---- Load ----

  async function reload() {
    revokeTrackedUrls();
    tickets = await getAllTickets();
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

  reload().then(consumeSharedContentIfAny);

  // ---- Service worker (offline support) ----

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }
})();
