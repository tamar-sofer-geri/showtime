(() => {
  "use strict";

  const DB_NAME = "showtime-db";
  const DB_VERSION = 1;
  const STORE = "tickets";

  /** @returns {Promise<IDBDatabase>} */
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function withStore(mode, fn) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      const result = fn(store);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
    });
  }

  function getAllTickets() {
    return withStore("readonly", (store) => {
      return new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }).then((p) => p);
  }

  function putTicket(ticket) {
    return withStore("readwrite", (store) => store.put(ticket));
  }

  function deleteTicket(id) {
    return withStore("readwrite", (store) => store.delete(id));
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
    if (!timeStr) return "";
    const [h, m] = timeStr.split(":").map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  function formatPrice(price) {
    if (price === null || price === undefined || price === "") return "";
    const n = Number(price);
    if (Number.isNaN(n)) return "";
    return `$${n.toFixed(2)}`;
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
    card.addEventListener("click", () => openEditModal(t.id));

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

  function openAddModal() {
    editingId = null;
    pendingFile = undefined;
    ticketModalTitle.textContent = "Add ticket";
    deleteBtn.hidden = true;
    ticketForm.reset();
    clearFilePreview();
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
    ticketForm.time.value = t.time || "";
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

  reload();

  // ---- Service worker (offline support) ----

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }
})();
