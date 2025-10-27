// app.js — frontend minimal per login admin + export CSV docenti

const API = ""; // vuoto = stesso host del server.cjs

const $ = (q) => document.querySelector(q);
const $$ = (q) => Array.from(document.querySelectorAll(q));

const state = {
  token: localStorage.getItem("token") || "",
  me: null,
};

function setToken(t) {
  state.token = t || "";
  if (t) localStorage.setItem("token", t);
  else localStorage.removeItem("token");
}

function authHeaders() {
  return state.token ? { Authorization: "Bearer " + state.token } : {};
}

function show(id, on) {
  const el = $(id);
  if (!el) return;
  el.classList.toggle("hide", !on);
}

async function apiGet(path) {
  const r = await fetch(API + path, { headers: { ...authHeaders() } });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function apiPost(path, body) {
  const r = await fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function updateUI() {
  const isAuth = !!state.token;
  const isAdmin = isAuth && state.me && state.me.role === "admin";

  $("#userInfo").textContent = isAuth
    ? `${state.me?.email || "utente"} (${state.me?.role || "-"})`
    : "Non autenticato";

  show("#btnLogout", isAuth);
  show("#secLogin", !isAuth);
  show("#secAdmin", !!isAdmin);
  show("#secUser", isAuth && !isAdmin);
}

async function hydrateMe() {
  if (!state.token) {
    state.me = null;
    updateUI();
    return;
  }
  try {
    state.me = await apiGet("/api/me");
  } catch {
    setToken("");
    state.me = null;
  }
  updateUI();
}

// ===== Login admin (email/password)
$("#formLogin")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#email").value.trim();
  const password = $("#password").value;
  try {
    const { token } = await apiPost("/api/login", { email, password });
    setToken(token);
    await hydrateMe();
    await loadTeachersPreview();
    alert("Login eseguito.");
  } catch (err) {
    console.error(err);
    alert("Login fallito");
  }
});

// ===== Logout
$("#btnLogout")?.addEventListener("click", () => {
  setToken("");
  state.me = null;
  updateUI();
});

// ===== Export CSV (admin)
$("#btnExportCsv")?.addEventListener("click", async () => {
  try {
    if (!state.token) throw new Error("Non autenticato");
    const params = new URLSearchParams();
    const active = $("#fActive").value;
    const role = $("#fRole").value;
    if (active) params.set("active", active);
    if (role) params.set("role", role);

    const url = API + "/api/admin/teachers/export" + (params.toString() ? "?" + params.toString() : "");
    const r = await fetch(url, { headers: { ...authHeaders() } });
    if (!r.ok) throw new Error("Errore export: " + r.status);

    const blob = await r.blob();
    const a = document.createElement("a");
    const ymd = new Date().toISOString().slice(0,10).replace(/-/g,"");
    a.href = URL.createObjectURL(blob);
    a.download = `docenti-${ymd}.csv`;
    document.body.appendChild(a);
    a.click();
    URL.revokeObjectURL(a.href);
    a.remove();
  } catch (e) {
    console.error(e);
    alert("Impossibile esportare. Verifica di essere loggato come admin.");
  }
});

// ===== Preview tabellare docenti (admin)
async function loadTeachersPreview() {
  if (!state.token) return;
  try {
    const rows = await apiGet("/api/admin/teachers");
    const tbody = $("#tblTeachers tbody");
    tbody.innerHTML = "";
    for (const r of rows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${r.first_name || ""}</td>
        <td>${r.last_name || ""}</td>
        <td><span class="pill">${r.teacher_code || ""}</span></td>
        <td>${r.email || ""}</td>
        <td>${r.role || ""}</td>
        <td>${r.active === 1 ? "1" : "0"}</td>
      `;
      tbody.appendChild(tr);
    }
  } catch (e) {
    console.warn("Preview docenti non disponibile:", e);
  }
}

$("#btnReloadTeachers")?.addEventListener("click", loadTeachersPreview);

// ===== Avvio
(async function boot() {
  await hydrateMe();
  if (state.me?.role === "admin") {
    await loadTeachersPreview();
  }
})();
