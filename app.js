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
  let pendingFile = null; // { blob, name, type } | null | undefined (undefined = unchanged)
  const objectUrls = [];

  function trackUrl(url) {
    objectUrls.push(url);
    return url;
  }

  function revokeTrackedUrls() {
    while (objectUrls.length) URL.revokeObjectURL(objectUrls.pop());
  }

  // ---- Rendering ----

  const listUpcomingEl = document.getElementById("list-upcoming");
  const listPastEl = document.getElementById("list-past");
  const emptyUpcomingEl = document.getElementById("empty-upcoming");
  const emptyPastEl = document.getElementById("empty-past");

  function render() {
    const upcoming = tickets.filter(isUpcoming).sort((a, b) => ticketDateTime(a) - ticketDateTime(b));
    const past = tickets.filter((t) => !isUpcoming(t)).sort((a, b) => ticketDateTime(b) - ticketDateTime(a));

    renderList(listUpcomingEl, upcoming, true);
    renderList(listPastEl, past, false);

    emptyUpcomingEl.hidden = upcoming.length > 0;
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
    const card = document.createElement("div");
    const soon = isUpcomingList && daysUntil(t) <= 7;
    card.className = "ticket-card" + (soon ? " is-soon" : "");
    card.tabIndex = 0;
    wireCardPress(card, t);

    if (t.fileBlob && t.fileType && t.fileType.startsWith("image/")) {
      const img = document.createElement("img");
      img.className = "ticket-thumb";
      img.alt = "";
      img.src = trackUrl(URL.createObjectURL(t.fileBlob));
      card.appendChild(img);
    } else {
      const ph = document.createElement("div");
      ph.className = "ticket-thumb-placeholder";
      ph.textContent = t.fileBlob ? "📄" : "🎫";
      card.appendChild(ph);
    }

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

    card.appendChild(info);

    const badge = document.createElement("span");
    badge.className = "ticket-badge";
    badge.textContent = countdownLabel(t);
    card.appendChild(badge);

    li.appendChild(card);
    return li;
  }

  // Short tap opens Edit; press-and-hold jumps straight to the attached
  // ticket file, skipping the edit form entirely.
  const LONG_PRESS_MS = 500;
  const LONG_PRESS_MOVE_TOLERANCE = 10;

  function wireCardPress(card, t) {
    let pressTimer = null;
    let longPressFired = false;
    let startX = 0;
    let startY = 0;

    const cancelTimer = () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    };

    card.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      longPressFired = false;
      startX = e.clientX;
      startY = e.clientY;
      pressTimer = setTimeout(() => {
        longPressFired = true;
        openAttachmentForTicket(t);
      }, LONG_PRESS_MS);
    });

    card.addEventListener("pointermove", (e) => {
      if (Math.abs(e.clientX - startX) > LONG_PRESS_MOVE_TOLERANCE || Math.abs(e.clientY - startY) > LONG_PRESS_MOVE_TOLERANCE) {
        cancelTimer();
      }
    });

    card.addEventListener("pointerup", cancelTimer);
    card.addEventListener("pointerleave", cancelTimer);
    card.addEventListener("pointercancel", cancelTimer);

    card.addEventListener("click", () => {
      if (longPressFired) {
        longPressFired = false;
        return;
      }
      openEditModal(t.id);
    });
  }

  function openAttachmentForTicket(t) {
    if (!t.fileBlob) return;
    const kind = t.fileType && t.fileType.startsWith("image/") ? "image" : "pdf";
    openAttachment(trackUrl(URL.createObjectURL(t.fileBlob)), kind);
  }

  // ---- Tabs ----

  const tabs = document.querySelectorAll(".tab");
  const views = { upcoming: document.getElementById("view-upcoming"), past: document.getElementById("view-past") };

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
  const deleteBtn = document.getElementById("ticket-delete-btn");
  const fileInput = document.getElementById("file-input");
  const filePreview = document.getElementById("file-preview");
  const filePreviewImg = document.getElementById("file-preview-img");
  const filePreviewName = document.getElementById("file-preview-name");
  const fileRemoveBtn = document.getElementById("file-remove-btn");

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

  function openAddModal(prefill) {
    editingId = null;
    pendingFile = undefined;
    ticketModalTitle.textContent = "Add ticket";
    deleteBtn.hidden = true;
    ticketForm.reset();
    clearFilePreview();
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
        pendingFile = { blob: prefill.fileBlob, name: prefill.fileName, type: prefill.fileType };
        showFilePreview(prefill.fileBlob, prefill.fileType, prefill.fileName);
      }
    }

    ticketModal.hidden = false;
    document.getElementById("event-input").focus();
  }

  function openEditModal(id) {
    const t = tickets.find((x) => x.id === id);
    if (!t) return;
    editingId = id;
    pendingFile = undefined;
    ticketModalTitle.textContent = "Edit ticket";
    deleteBtn.hidden = false;
    ticketForm.reset();
    ticketForm.eventName.value = t.eventName || "";
    ticketForm.venue.value = t.venue || "";
    ticketForm.date.value = t.date || "";
    setTimeSelects(t.time || "");
    ticketForm.price.value = t.price ?? "";
    ticketForm.seat.value = t.seat || "";
    ticketForm.source.value = t.source || "";
    ticketForm.confirmation.value = t.confirmation || "";
    if (t.fileBlob) {
      showFilePreview(t.fileBlob, t.fileType, t.fileName);
    } else {
      clearFilePreview();
    }
    ticketModal.hidden = false;
  }

  function closeTicketModal() {
    ticketModal.hidden = true;
    editingId = null;
    pendingFile = undefined;
  }

  function clearFilePreview() {
    filePreview.hidden = true;
    filePreviewImg.hidden = true;
    filePreviewImg.src = "";
    filePreviewName.textContent = "";
  }

  function showFilePreview(blob, type, name) {
    filePreview.hidden = false;
    if (type && type.startsWith("image/")) {
      filePreviewImg.hidden = false;
      filePreviewImg.src = trackUrl(URL.createObjectURL(blob));
    } else {
      filePreviewImg.hidden = true;
      filePreviewImg.src = "";
    }
    filePreviewName.textContent = name || "Attachment";
  }

  fileInput.addEventListener("change", () => {
    const f = fileInput.files[0];
    if (!f) return;
    pendingFile = { blob: f, name: f.name, type: f.type };
    showFilePreview(f, f.type, f.name);
  });

  fileRemoveBtn.addEventListener("click", () => {
    pendingFile = null;
    fileInput.value = "";
    clearFilePreview();
  });

  document.getElementById("header-add-btn").addEventListener("click", openAddModal);

  ticketModal.querySelectorAll("[data-close]").forEach((el) => el.addEventListener("click", closeTicketModal));

  ticketForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    syncHiddenTime();
    const fd = new FormData(ticketForm);
    const existing = editingId ? tickets.find((x) => x.id === editingId) : null;

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
      fileBlob: existing ? existing.fileBlob : null,
      fileType: existing ? existing.fileType : null,
      fileName: existing ? existing.fileName : null,
    };

    if (pendingFile === null) {
      ticket.fileBlob = null;
      ticket.fileType = null;
      ticket.fileName = null;
    } else if (pendingFile) {
      ticket.fileBlob = pendingFile.blob;
      ticket.fileType = pendingFile.type;
      ticket.fileName = pendingFile.name;
    }

    await putTicket(ticket);
    await reload();
    closeTicketModal();
  });

  deleteBtn.addEventListener("click", async () => {
    if (!editingId) return;
    if (!confirm("Delete this ticket?")) return;
    await deleteTicket(editingId);
    await reload();
    closeTicketModal();
  });

  // ---- Attachment viewer (tap thumbnail from edit modal preview) ----

  const attachmentModal = document.getElementById("attachment-modal");
  const attachmentImg = document.getElementById("attachment-img");
  const attachmentLink = document.getElementById("attachment-link");

  filePreviewImg.addEventListener("click", () => {
    if (!filePreviewImg.src) return;
    openAttachment(filePreviewImg.src, "image");
  });
  filePreviewName.addEventListener("click", () => {
    const t = editingId ? tickets.find((x) => x.id === editingId) : null;
    if (t && t.fileBlob && t.fileType === "application/pdf") {
      openAttachment(trackUrl(URL.createObjectURL(t.fileBlob)), "pdf");
    }
  });

  function openAttachment(url, kind) {
    if (kind === "image") {
      attachmentImg.hidden = false;
      attachmentImg.src = url;
      attachmentLink.hidden = true;
    } else {
      attachmentImg.hidden = true;
      attachmentLink.hidden = false;
      attachmentLink.href = url;
    }
    attachmentModal.hidden = false;
  }

  attachmentModal.querySelectorAll("[data-attachment-close]").forEach((el) =>
    el.addEventListener("click", () => {
      attachmentModal.hidden = true;
    })
  );

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
    openAddModal({ ...parsed, fileBlob: share.fileBlob, fileType: share.fileType, fileName: share.fileName });
  }

  reload().then(consumeSharedContentIfAny);

  // ---- Service worker (offline support) ----

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }
})();
