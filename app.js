// Token helper
const storage = {
  get token() { return localStorage.getItem("token") || ""; },
  set token(v) { if (!v) localStorage.removeItem("token"); else localStorage.setItem("token", v); }
};

function authHeader() {
  return storage.token ? { "Authorization": `Bearer ${storage.token}` } : {};
}

function show(id, on = true) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle("hidden", !on);
}

// ------------------------------
// Auth handlers
// ------------------------------
async function doLogin() {
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  const msg = document.getElementById("authMsg");
  msg.textContent = "Accesso in corso...";
  try {
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader(), "Cache-Control": "no-cache" },
      cache: "no-store",
      body: JSON.stringify({ email, password })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Login fallito");
    storage.token = data.token;
    await refreshMe();
    msg.textContent = "";
  } catch (e) {
    console.error(e);
    msg.textContent = e.message;
  }
}

async function doRegister() {
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  const msg = document.getElementById("authMsg");
  msg.textContent = "Registrazione in corso...";
  try {
    const r = await fetch("/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
      cache: "no-store",
      body: JSON.stringify({ email, password })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Registrazione fallita");
    storage.token = data.token;
    await refreshMe();
    msg.textContent = "";
  } catch (e) {
    console.error(e);
    msg.textContent = e.message;
  }
}

async function refreshMe() {
  if (!storage.token) {
    show("authCard", true);
    show("meCard", false);
    show("bookingCard", false);
    show("myBookingsCard", false);
    show("adminArea", false);
    return;
  }
  const r = await fetch("/api/me", { headers: { ...authHeader(), "Cache-Control": "no-cache" }, cache: "no-store" });
  if (!r.ok) {
    storage.token = "";
    await refreshMe();
    return;
  }
  const me = await r.json();
  document.getElementById("meEmail").textContent = me?.email || "";
  document.getElementById("meRole").textContent = me?.role || "";

  show("authCard", false);
  show("meCard", true);
  show("bookingCard", true);
  show("myBookingsCard", true);
  show("adminArea", me?.role === "admin");

  await Promise.all([refreshNotebooks(), loadNotebookList(), loadMyBookings()]);
}

function logout() {
  storage.token = "";
  document.getElementById("authMsg").textContent = "Disconnesso.";
  refreshMe();
}

// ------------------------------
// Prenotazioni (utente)
// ------------------------------
async function refreshNotebooks() {
  // riempie il <select> per creare prenotazioni
  const sel = document.getElementById("nbSelect");
  sel.innerHTML = `<option value="">Carico...</option>`;
  const r = await fetch("/api/notebooks", { headers: { "Accept": "application/json", "Cache-Control": "no-cache" }, cache: "no-store" });
  const list = await r.json();
  sel.innerHTML = `<option value="">Seleziona notebook...</option>` + list.map(n => `<option value="${n.id}">${n.name}</option>`).join("");
}

async function loadMyBookings() {
  const tbody = document.getElementById("bookingsBody");
  const r = await fetch("/api/bookings", { headers: { ...authHeader(), "Accept":"application/json", "Cache-Control":"no-cache" }, cache: "no-store" });
  if (!r.ok) {
    tbody.innerHTML = `<tr><td colspan="8" class="danger">Errore caricamento prenotazioni</td></tr>`;
    return;
  }
  const rows = await r.json();
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="muted">Nessuna prenotazione</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((b, i) => `
    <tr>
      <td>${i+1}</td>
      <td>${b.notebook}</td>
      <td>${b.date}</td>
      <td>${b.time}</td>
      <td>${b.docente || ""}</td>
      <td>${b.classe || ""}</td>
      <td>${b.aula || ""}</td>
      <td><button class="btn-danger" data-cancel="${b.id}">Annulla</button></td>
    </tr>
  `).join("");
}

async function createBooking() {
  const notebookId = Number(document.getElementById("nbSelect").value);
  const date = document.getElementById("date").value;
  const time = document.getElementById("time").value;
  const docente = document.getElementById("docente").value.trim();
  const classe = document.getElementById("classe").value.trim();
  const aula = document.getElementById("aula").value.trim();
  const msg = document.getElementById("bookMsg");
  msg.textContent = "Invio prenotazione...";
  try {
    const r = await fetch("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader(), "Cache-Control":"no-cache" },
      cache: "no-store",
      body: JSON.stringify({ notebookId, date, time, docente, classe, aula })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Errore prenotazione");
    msg.textContent = "Prenotazione salvata ✅";
    // pulizia campi descrittivi lasciando data/ora
    document.getElementById("docente").value = "";
    document.getElementById("classe").value = "";
    document.getElementById("aula").value = "";
    await loadMyBookings();
  } catch (e) {
    msg.textContent = e.message;
  }
}

async function cancelBooking(id) {
  const r = await fetch(`/api/bookings/${id}`, {
    method: "DELETE",
    headers: { ...authHeader(), "Cache-Control":"no-cache" },
    cache: "no-store"
  });
  if (!r.ok) {
    alert("Errore annullamento");
    return;
  }
  await loadMyBookings();
}

// ------------------------------
// Notebook disponibili (pubblico)
// ------------------------------
async function loadNotebookList() {
  const btn = document.getElementById("btnRefreshNb");
  const tbody = document.getElementById("nbList");
  const counter = document.getElementById("nbCount");

  try {
    if (btn) { btn.disabled = true; btn.textContent = "Aggiorno..."; }

    const r = await fetch("/api/notebooks", {
      headers: { "Accept": "application/json", "Cache-Control": "no-cache" },
      cache: "no-store"
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status} ${r.statusText} ${txt}`);
    }

    const list = await r.json();
    counter.textContent = `Totale attivi: ${list.length}`;
    tbody.innerHTML = list.map((n, i) =>
      `<tr><td>${i + 1}</td><td>${n.name}</td></tr>`
    ).join("");

    if (list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="2" class="muted">Nessun notebook attivo</td></tr>`;
    }
  } catch (err) {
    console.error("loadNotebookList error:", err);
    counter.textContent = "";
    tbody.innerHTML = `<tr><td colspan="2" class="danger">Errore nel caricamento elenco. Vedi console (F12).</td></tr>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Aggiorna elenco"; }
  }
}

// ------------------------------
// Admin area
// ------------------------------
async function adminLoadNotebooks() {
  const body = document.getElementById("adminNbBody");
  const r = await fetch("/api/admin/notebooks", { headers: { ...authHeader(), "Accept":"application/json", "Cache-Control":"no-cache" }, cache: "no-store" });
  if (!r.ok) {
    body.innerHTML = `<tr><td colspan="4" class="danger">Errore caricamento</td></tr>`;
    return;
  }
  const list = await r.json();
  if (!list.length) {
    body.innerHTML = `<tr><td colspan="4" class="muted">Nessun notebook</td></tr>`;
    return;
  }
  body.innerHTML = list.map((n, i) => `
    <tr>
      <td>${i+1}</td>
      <td>${n.name}</td>
      <td>${n.active ? "✅" : "⛔️"}</td>
      <td>
        <button class="btn-ghost" data-toggle="${n.id}">${n.active ? "Disattiva" : "Attiva"}</button>
        <button class="btn-danger" data-del="${n.id}">Elimina</button>
      </td>
    </tr>
  `).join("");
}

async function adminAddNotebook() {
  const nameEl = document.getElementById("nbNewName");
  const activeEl = document.getElementById("nbNewActive");
  const name = (nameEl.value || "").trim();
  const active = !!activeEl.checked;
  if (!name) return;
  const r = await fetch("/api/admin/notebooks", {
    method: "POST",
    headers: { "Content-Type":"application/json", ...authHeader(), "Cache-Control":"no-cache" },
    cache: "no-store",
    body: JSON.stringify({ name, active })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    alert(data.error || "Errore creazione notebook");
    return;
  }
  nameEl.value = "";
  await adminLoadNotebooks();
  await loadNotebookList();
  await refreshNotebooks();
}

async function adminToggleNotebook(id) {
  // leggo stato attuale
  const r0 = await fetch("/api/admin/notebooks", { headers:{...authHeader()}, cache:"no-store" });
  const arr = await r0.json();
  const n = arr.find(x => x.id === id);
  if (!n) return;

  const r = await fetch(`/api/admin/notebooks/${id}`, {
    method: "PUT",
    headers: { "Content-Type":"application/json", ...authHeader(), "Cache-Control":"no-cache" },
    cache: "no-store",
    body: JSON.stringify({ active: !n.active })
  });
  if (!r.ok) { alert("Errore aggiornamento"); return; }
  await adminLoadNotebooks();
  await loadNotebookList();
  await refreshNotebooks();
}

async function adminDeleteNotebook(id) {
  if (!confirm("Eliminare questo notebook?")) return;
  const r = await fetch(`/api/admin/notebooks/${id}`, {
    method: "DELETE",
    headers: { ...authHeader(), "Cache-Control":"no-cache" },
    cache: "no-store"
  });
  if (!r.ok) { alert("Errore eliminazione"); return; }
  await adminLoadNotebooks();
  await loadNotebookList();
  await refreshNotebooks();
}

// ------------------------------
// Init
// ------------------------------
function initDefaults() {
  // Default data/ora → mezz’ora successiva
  const now = new Date();
  now.setMinutes(now.getMinutes() + (30 - (now.getMinutes() % 30)) % 30, 0, 0);
  const y = now.getFullYear(), m = String(now.getMonth()+1).padStart(2,"0"), d = String(now.getDate()).padStart(2,"0");
  document.getElementById("date").value = `${y}-${m}-${d}`;
  document.getElementById("time").value = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
}

function wireEvents() {
  document.getElementById("btnLogin").addEventListener("click", doLogin);
  document.getElementById("btnRegister").addEventListener("click", doRegister);
  document.getElementById("btnLogout").addEventListener("click", logout);
  document.getElementById("btnBook").addEventListener("click", createBooking);
  document.getElementById("btnRefreshNb").addEventListener("click", loadNotebookList);

  // delega click su annulla prenotazione e azioni admin
  document.body.addEventListener("click", (ev) => {
    const c = ev.target.closest("[data-cancel]");
    if (c) { cancelBooking(Number(c.dataset.cancel)); return; }

    const t = ev.target.closest("[data-toggle]");
    if (t) { adminToggleNotebook(Number(t.dataset.toggle)); return; }

    const d = ev.target.closest("[data-del]");
    if (d) { adminDeleteNotebook(Number(d.dataset.del)); return; }
  });

  const addBtn = document.getElementById("btnNbAdd");
  if (addBtn) addBtn.addEventListener("click", adminAddNotebook);
}

async function init() {
  wireEvents();
  initDefaults();
  await loadNotebookList();
  await refreshMe();
}

window.addEventListener("DOMContentLoaded", init);
