// app.js – frontend semplice per docenti

const API = ""; // vuoto = stesso host

const $ = (s) => document.querySelector(s);

let token = localStorage.getItem("token") || "";

function authHeaders() {
  return token ? { Authorization: "Bearer " + token } : {};
}

async function apiGet(path) {
  const r = await fetch(API + path, { headers: { ...authHeaders() } });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function apiPost(path, data) {
  const r = await fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(data || {}),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function apiDelete(path) {
  const r = await fetch(API + path, {
    method: "DELETE",
    headers: { ...authHeaders() },
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ===== LOGIN
$("#btnLoginCode").addEventListener("click", async () => {
  const code = $("#teacherCode").value.trim();
  if (!code) return alert("Inserisci il codice docente");
  try {
    const res = await apiPost("/api/login-code-only", { code });
    token = res.token;
    localStorage.setItem("token", token);
    $("#login").style.display = "none";
    $("#dashboard").style.display = "";
    $("#welcome").textContent = `${res.first_name || ""} ${res.last_name || ""}`;
    await loadBookings();
    await loadPeriods();
    await loadNotebooks();
  } catch (e) {
    console.error(e);
    alert("Errore di accesso");
  }
});

// ===== LOGOUT
$("#btnLogout").addEventListener("click", () => {
  token = "";
  localStorage.removeItem("token");
  $("#dashboard").style.display = "none";
  $("#login").style.display = "";
});

// ===== CARICA PERIODI E NOTEBOOKS
async function loadPeriods() {
  const data = await apiGet("/api/periods");
  const sel = $("#period");
  sel.innerHTML = '<option value="">Seleziona periodo</option>';
  data.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = `${p.name} (${p.start}-${p.end})`;
    sel.appendChild(opt);
  });
}

async function loadNotebooks() {
  const data = await apiGet("/api/notebooks");
  const sel = $("#notebook");
  sel.innerHTML = '<option value="">Seleziona notebook</option>';
  data.forEach((n) => {
    const opt = document.createElement("option");
    opt.value = n.id;
    opt.textContent = n.name;
    sel.appendChild(opt);
  });
}

// ===== CARICA PRENOTAZIONI
async function loadBookings() {
  const data = await apiGet("/api/bookings");
  const tbody = $("#tblBookings tbody");
  tbody.innerHTML = "";
  data.forEach((b) => {
    const tr = document.createElement("tr");
    const ora = b.period_name
      ? `${b.period_name} (${b.period_start}-${b.period_end})`
      : b.time || "";
    tr.innerHTML = `
      <td>${b.date}</td>
      <td>${b.notebook_name}</td>
      <td>${ora}</td>
      <td>${b.class_name || ""}</td>
      <td>${b.room || ""}</td>
      <td><button data-id="${b.id}" class="btnDel secondary">🗑</button></td>
    `;
    tbody.appendChild(tr);
  });
  $$(".btnDel").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      const id = e.target.dataset.id;
      if (!confirm("Cancellare la prenotazione?")) return;
      await apiDelete(`/api/bookings/${id}`);
      await loadBookings();
    })
  );
}

// ===== NUOVA PRENOTAZIONE
$("#btnBook").addEventListener("click", async () => {
  const notebookId = Number($("#notebook").value);
  const date = $("#date").value;
  const periodId = Number($("#period").value);
  const className = $("#class").value;
  const room = $("#room").value;
  if (!notebookId || !date || !periodId) {
    alert("Compila tutti i campi obbligatori.");
    return;
  }
  try {
    await apiPost("/api/bookings", {
      notebookId,
      date,
      periodId,
      class_name: className,
      room,
    });
    alert("Prenotazione registrata.");
    await loadBookings();
  } catch (e) {
    alert("Errore: " + (e.message || e));
  }
});

// ===== AUTOLOGIN SE TOKEN
(async function init() {
  if (token) {
    try {
      const me = await apiGet("/api/me");
      $("#login").style.display = "none";
      $("#dashboard").style.display = "";
      $("#welcome").textContent = `${me.first_name || ""} ${me.last_name || ""}`;
      await loadBookings();
      await loadPeriods();
      await loadNotebooks();
    } catch {
      localStorage.removeItem("token");
    }
  }
})();
