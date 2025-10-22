// server.cjs
// Notebook Booking – Backend Express + PostgreSQL (Neon)
// API compatibili con il tuo index.html/app.js (periodi, disponibilità, login docente, admin, ecc.)

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
const { Pool } = require("pg");

// ---------- Config ----------
const {
  PORT = 3000,
  APP_BASE_URL = "http://localhost:3000",
  JWT_SECRET = "cambia_questa_chiave",
  JWT_EXPIRE_MIN = "60",
  ADMIN_EMAIL = "admin@bixio.local",
  ADMIN_PASSWORD = "123456",
  RESET_DB = "0",
  TZ = "Europe/Rome",
  DATABASE_URL,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  SMTP_SECURE = "false",
  SMTP_FROM = 'Prenotazioni <noreply@scuola.test>',
  SMTP_DEBUG = "0",
} = process.env;

process.env.TZ = TZ;

// ---------- DB ----------
if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL non definita nell’ambiente.");
  process.exit(1);
}
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function q(sql, params = []) {
  const r = await pool.query(sql, params);
  return r.rows;
}
async function qi(sql, params = []) {
  const r = await pool.query(sql, params);
  return r;
}

// ---------- App ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ---------- Mailer ----------
let mailer = null;
if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  mailer = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: SMTP_SECURE === "true",
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

// ---------- Schema & seed ----------
async function initDb() {
  // tabelle
  await qi(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user'
    );
  `);
  await qi(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);`);

  await qi(`
    CREATE TABLE IF NOT EXISTS notebooks (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE
    );
  `);

  await qi(`
    CREATE TABLE IF NOT EXISTS periods (
      id SERIAL PRIMARY KEY,
      ord INTEGER NOT NULL,
      name TEXT NOT NULL,
      start_time TEXT, -- "HH:MM"
      end_time TEXT    -- "HH:MM"
    );
  `);

  await qi(`
    CREATE TABLE IF NOT EXISTS teachers (
      id SERIAL PRIMARY KEY,
      first_name TEXT,
      last_name TEXT,
      teacher_code TEXT UNIQUE,
      email TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      active BOOLEAN NOT NULL DEFAULT TRUE
    );
  `);
  await qi(`CREATE UNIQUE INDEX IF NOT EXISTS idx_teachers_code ON teachers(teacher_code);`);

  await qi(`
    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      notebook_id INTEGER NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
      date TEXT NOT NULL,            -- YYYY-MM-DD
      time TEXT,                     -- HH:MM (opzionale se si usa period_id)
      period_id INTEGER REFERENCES periods(id) ON DELETE SET NULL,
      teacher_first TEXT,
      teacher_last TEXT,
      class_name TEXT,
      room TEXT
    );
  `);
  await qi(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_slot_period
    ON bookings (notebook_id, date, COALESCE(period_id, -1), COALESCE(time, ''));
  `);

  // reset opzionale
  if (RESET_DB === "1") {
    await qi(`TRUNCATE TABLE bookings RESTART IDENTITY CASCADE;`);
    await qi(`TRUNCATE TABLE notebooks RESTART IDENTITY CASCADE;`);
    await qi(`TRUNCATE TABLE teachers RESTART IDENTITY CASCADE;`);
    await qi(`TRUNCATE TABLE periods RESTART IDENTITY CASCADE;`);
    console.log("🧹 DB pulito (RESET_DB=1)");
  }

  // seed admin
  const u = await q(`SELECT id FROM users WHERE email=$1`, [ADMIN_EMAIL]);
  if (u.length === 0) {
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    await qi(
      `INSERT INTO users (email, password, role) VALUES ($1,$2,'admin')`,
      [ADMIN_EMAIL, hash]
    );
    console.log(`✅ Admin creato: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
  }

  // seed notebooks
  const nbCount = (await q(`SELECT COUNT(*)::int AS c FROM notebooks`))[0].c;
  if (nbCount === 0) {
    const seed = ["Carrello 1", "Carrello 2", "Carrello 3", "Carrello 4"];
    for (const name of seed) {
      await qi(`INSERT INTO notebooks(name, active) VALUES ($1, TRUE) ON CONFLICT DO NOTHING;`, [name]);
    }
    console.log("🌱 Seed notebooks inseriti");
  }

  // seed periods (se vuoto) – 6 ore tipiche
  const pCount = (await q(`SELECT COUNT(*)::int AS c FROM periods`))[0].c;
  if (pCount === 0) {
    const rows = [
      [1, "1ª ora", "08:00", "09:00"],
      [2, "2ª ora", "09:00", "10:00"],
      [3, "3ª ora", "10:00", "11:00"],
      [4, "4ª ora", "11:00", "12:00"],
      [5, "5ª ora", "12:00", "13:00"],
      [6, "6ª ora", "13:00", "14:00"],
    ];
    for (const [ord, name, s, e] of rows) {
      await qi(
        `INSERT INTO periods(ord, name, start_time, end_time) VALUES ($1,$2,$3,$4)`,
        [ord, name, s, e]
      );
    }
    console.log("🕘 Periodi inseriti");
  }
}

// ---------- Helpers ----------
function makeToken(payload, minutes = Number(JWT_EXPIRE_MIN || 60)) {
  return jwt.sign(
    { ...payload, exp: Math.floor(Date.now() / 1000) + minutes * 60 },
    JWT_SECRET
  );
}
async function auth(req, res, next) {
  const hdr = (req.headers.authorization || "").trim();
  if (!hdr.startsWith("Bearer ")) return res.status(401).json({ detail: "Token mancante" });
  const token = hdr.slice(7);
  try {
    const data = jwt.verify(token, JWT_SECRET);
    req.user = data;
    next();
  } catch {
    return res.status(401).json({ detail: "Token non valido" });
  }
}
function adminOnly(req, res, next) {
  if (req.user?.role === "admin") return next();
  return res.status(403).json({ detail: "Solo admin" });
}

// ---------- ROUTES ----------
app.get("/api/health", (req, res) => res.json({ ok: true }));

// --- Auth (email/password) ---
app.post("/api/register", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password || password.length < 6) {
      return res.status(400).json({ detail: "Parametri mancanti o password corta" });
    }
    const exist = await q(`SELECT id FROM users WHERE email=$1`, [email]);
    if (exist.length) return res.status(409).json({ detail: "Email già registrata" });
    const hash = await bcrypt.hash(password, 10);
    const r = await qi(
      `INSERT INTO users(email,password,role) VALUES ($1,$2,'user') RETURNING id, email, role`,
      [email, hash]
    );
    const u = r.rows[0];
    const token = makeToken({ id: u.id, email: u.email, role: u.role });
    res.json({ token, user: u });
  } catch (e) {
    console.error(e);
    res.status(500).json({ detail: "Errore registrazione" });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const r = await q(`SELECT id,email,password,role FROM users WHERE email=$1`, [email]);
    if (r.length === 0) return res.status(401).json({ detail: "Credenziali errate" });
    const ok = await bcrypt.compare(password || "", r[0].password);
    if (!ok) return res.status(401).json({ detail: "Credenziali errate" });
    const token = makeToken({ id: r[0].id, email: r[0].email, role: r[0].role });
    res.json({ token });
  } catch (e) {
    console.error(e);
    res.status(500).json({ detail: "Errore login" });
  }
});

app.get("/api/me", auth, async (req, res) => {
  // Se l'utente proviene da login docente, potremmo includere anche first/last
  res.json({ id: req.user.id, email: req.user.email, role: req.user.role, first_name: req.user.first_name, last_name: req.user.last_name });
});

// --- Login Docente con codice ---
app.post("/api/login-code", async (req, res) => {
  try {
    const { firstName, lastName, code } = req.body || {};
    if (!code) return res.status(400).json({ detail: "Codice mancante" });
    const r = await q(
      `SELECT id, first_name, last_name, email, role, active FROM teachers WHERE teacher_code=$1`,
      [code]
    );
    if (!r.length || r[0].active !== true) return res.status(401).json({ detail: "Docente non attivo o codice errato" });
    // opzionale: verifica match nome/cognome se forniti
    if (firstName && r[0].first_name && firstName.trim().toLowerCase() !== r[0].first_name.trim().toLowerCase()) {
      return res.status(401).json({ detail: "Nome non corrisponde" });
    }
    if (lastName && r[0].last_name && lastName.trim().toLowerCase() !== r[0].last_name.trim().toLowerCase()) {
      return res.status(401).json({ detail: "Cognome non corrisponde" });
    }
    const role = r[0].role === "admin" ? "admin" : "user";
    // creiamo (o riutilizziamo) un utente "ombra" con email del docente (se presente) oppure fittizia
    const email = r[0].email || `teacher_${r[0].id}@local`;
    let u = await q(`SELECT id,email,role FROM users WHERE email=$1`, [email]);
    if (!u.length) {
      const hash = await bcrypt.hash(Math.random().toString(36).slice(2), 10);
      await qi(`INSERT INTO users(email,password,role) VALUES ($1,$2,$3)`, [email, hash, role]);
      u = await q(`SELECT id,email,role FROM users WHERE email=$1`, [email]);
    } else {
      // aggiorna eventuale ruolo admin
      if (role !== u[0].role) await qi(`UPDATE users SET role=$2 WHERE id=$1`, [u[0].id, role]);
    }
    const token = makeToken({ id: u[0].id, email: u[0].email, role, first_name: r[0].first_name, last_name: r[0].last_name });
    res.json({ token, first_name: r[0].first_name, last_name: r[0].last_name });
  } catch (e) {
    console.error(e);
    res.status(500).json({ detail: "Errore login docente" });
  }
});

app.post("/api/login-code-only", async (req, res) => {
  // stessa logica ma senza validazione nome/cognome
  req.body.firstName = null; req.body.lastName = null;
  return app._router.handle({ ...req, url: "/api/login-code", method: "POST" }, res, () => {});
});

// --- Password reset ---
app.post("/api/password/request", async (req, res) => {
  try {
    const { email } = req.body || {};
    const r = await q(`SELECT id,email FROM users WHERE email=$1`, [email]);
    if (!r.length) return res.json({ ok: true }); // non rivelare
    const token = makeToken({ type: "pwreset", uid: r[0].id, email: r[0].email }, 30); // 30 minuti
    if (!mailer) return res.json({ ok: true, note: "Mailer non configurato" });
    const url = `${APP_BASE_URL.replace(/\/$/,'')}/reset-password.html?token=${encodeURIComponent(token)}`;
    await mailer.sendMail({
      from: SMTP_FROM,
      to: r[0].email,
      subject: "Reset password",
      text: `Per reimpostare la password apri: ${url}`,
      html: `Per reimpostare la password <a href="${url}">clicca qui</a>.`,
    });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ detail: "Errore richiesta reset" });
  }
});

app.post("/api/password/reset", async (req, res) => {
  try {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: "Token o password non validi" });
    }
    let data;
    try {
      data = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(400).json({ error: "Token non valido o scaduto" });
    }
    if (data.type !== "pwreset") return res.status(400).json({ error: "Token non valido" });
    const hash = await bcrypt.hash(newPassword, 10);
    await qi(`UPDATE users SET password=$2 WHERE id=$1`, [data.uid, hash]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Errore reset password" });
  }
});

// --- Notebooks (pubblico + admin) ---
app.get("/api/notebooks", async (req, res) => {
  try {
    const rows = await q(`SELECT id,name,active FROM notebooks WHERE active=TRUE ORDER BY name`);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ detail: "Errore elenco notebooks" });
  }
});

app.get("/api/admin/notebooks", auth, adminOnly, async (req, res) => {
  const rows = await q(`SELECT id,name,active FROM notebooks ORDER BY id`);
  res.json(rows);
});

app.post("/api/admin/notebooks", auth, adminOnly, async (req, res) => {
  try {
    const { name, active = true } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ detail: "Nome obbligatorio" });
    const r = await qi(
      `INSERT INTO notebooks(name,active) VALUES ($1,$2) RETURNING id,name,active`,
      [name.trim(), !!active]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (String(e.message).toLowerCase().includes("duplicate key")) {
      return res.status(409).json({ detail: "Nome già presente" });
    }
    console.error(e);
    res.status(500).json({ detail: "Errore creazione notebook" });
  }
});

app.put("/api/admin/notebooks/:id", auth, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, active } = req.body || {};
    const sets = [];
    const vals = [];
    if (name != null && String(name).trim()) { sets.push(`name=$${sets.length+1}`); vals.push(String(name).trim()); }
    if (active != null) { sets.push(`active=$${sets.length+1}`); vals.push(!!active); }
    if (!sets.length) return res.status(400).json({ detail: "Nessun campo da aggiornare" });
    vals.push(id);
    const r = await qi(`UPDATE notebooks SET ${sets.join(",")} WHERE id=$${vals.length} RETURNING id,name,active`, vals);
    if (!r.rowCount) return res.status(404).json({ detail: "Notebook non trovato" });
    res.json(r.rows[0]);
  } catch (e) {
    if (String(e.message).toLowerCase().includes("duplicate key")) {
      return res.status(409).json({ detail: "Nome già presente" });
    }
    console.error(e);
    res.status(500).json({ detail: "Errore aggiornamento" });
  }
});

app.delete("/api/admin/notebooks/:id", auth, adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  const r = await qi(`DELETE FROM notebooks WHERE id=$1`, [id]);
  if (!r.rowCount) return res.status(404).json({ detail: "Notebook non trovato" });
  res.json({ ok: true });
});

app.post("/api/admin/notebooks/bulk", auth, adminOnly, async (req, res) => {
  const { base = "Carrello", startFrom = 1, count = 1 } = req.body || {};
  let created = 0, skipped = 0;
  for (let i = 0; i < Number(count); i++) {
    const name = `${base} ${Number(startFrom) + i}`;
    try {
      await qi(`INSERT INTO notebooks(name,active) VALUES ($1,TRUE)`, [name]);
      created++;
    } catch (e) {
      skipped++;
    }
  }
  res.json({ created, skipped });
});

// --- Periodi & Disponibilità ---
app.get("/api/periods", async (req, res) => {
  const rows = await q(`SELECT id, ord, name, start_time AS start, end_time AS end FROM periods ORDER BY ord`);
  res.json(rows);
});

app.get("/api/availability", async (req, res) => {
  const { date, periodId } = req.query;
  if (!date || !periodId) return res.status(400).json({ detail: "Parametri mancanti" });
  const notebooks = await q(`SELECT id, name FROM notebooks WHERE active=TRUE ORDER BY id`);
  if (!notebooks.length) return res.json([]);
  const bookedRows = await q(
    `SELECT notebook_id FROM bookings WHERE date=$1 AND period_id=$2`,
    [date, Number(periodId)]
  );
  const bookedSet = new Set(bookedRows.map(r => r.notebook_id));
  const out = notebooks.map(n => ({ id: n.id, name: n.name, booked: bookedSet.has(n.id) }));
  res.json(out);
});

// --- Prenotazioni (utente & admin) ---
app.get("/api/bookings", auth, async (req, res) => {
  const rows = await q(`
    SELECT b.id, b.notebook_id AS "notebookId", n.name AS notebook_name,
           b.date, b.time, b.period_id,
           p.name AS period_name, p.start_time AS period_start, p.end_time AS period_end,
           b.teacher_first AS teacher_first, b.teacher_last AS teacher_last,
           b.class_name, b.room
    FROM bookings b
    JOIN notebooks n ON n.id=b.notebook_id
    LEFT JOIN periods p ON p.id=b.period_id
    WHERE b.user_id=$1
    ORDER BY b.date DESC, COALESCE(p.ord, 99) DESC, b.id DESC
  `, [req.user.id]);

  // campi "retrocompatibilità" per app.js legacy
  const mapped = rows.map(r => ({
    ...r,
    notebook: r.notebook_name || r.notebookId,
    docente: [r.teacher_first, r.teacher_last].filter(Boolean).join(" "),
    classe: r.class_name,
    aula: r.room
  }));

  res.json(mapped);
});

app.post("/api/bookings", auth, async (req, res) => {
  try {
    const body = req.body || {};
    const notebookId = Number(body.notebookId);
    const date = body.date;
    // supporto doppio schema: (periodId) oppure (time)
    const periodId = body.periodId != null ? Number(body.periodId) : null;
    const time = body.time || null;

    const teacherFirst = body.teacherFirst || body.docente?.split(" ")[0] || null;
    const teacherLast  = body.teacherLast  || body.docente?.split(" ").slice(1).join(" ") || null;
    const className = body.class_name || body.classe || null;
    const room = body.room || body.aula || null;

    if (!notebookId || !date || (!periodId && !time)) {
      return res.status(400).json({ detail: "Parametri mancanti" });
    }
    // notebook attivo?
    const nb = await q(`SELECT id, active FROM notebooks WHERE id=$1`, [notebookId]);
    if (!nb.length || nb[0].active !== true) {
      return res.status(400).json({ detail: "Notebook non attivo o inesistente" });
    }
    // inserimento con indice unico su (notebook_id,date,coalesce(period_id,-1),coalesce(time,''))
    try {
      const r = await qi(
        `INSERT INTO bookings(user_id, notebook_id, date, time, period_id, teacher_first, teacher_last, class_name, room)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id`,
        [req.user.id, notebookId, date, time, periodId, teacherFirst, teacherLast, className, room]
      );
      res.status(201).json({ ok: true, id: r.rows[0].id });
    } catch (e) {
      if (String(e.message).toLowerCase().includes("duplicate key")) {
        return res.status(409).json({ detail: "Slot già prenotato per questo notebook" });
      }
      throw e;
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ detail: "Errore creazione prenotazione" });
  }
});

app.delete("/api/bookings/:id", auth, async (req, res) => {
  const id = Number(req.params.id);
  const r = await q(`SELECT id,user_id FROM bookings WHERE id=$1`, [id]);
  if (!r.length) return res.status(404).json({ detail: "Prenotazione non trovata" });
  if (req.user.role !== "admin" && r[0].user_id !== req.user.id) {
    return res.status(403).json({ detail: "Non autorizzato" });
  }
  await qi(`DELETE FROM bookings WHERE id=$1`, [id]);
  res.json({ ok: true });
});

app.get("/api/admin/bookings", auth, adminOnly, async (req, res) => {
  const rows = await q(`
    SELECT b.id, b.date, b.time, b.period_id, 
           p.name AS period_name, p.start_time AS period_start, p.end_time AS period_end,
           b.class_name, b.room, b.teacher_first, b.teacher_last,
           u.email AS user_email, u.role AS user_role, u.id as user_id,
           n.id AS "notebookId", n.name AS notebook_name
    FROM bookings b
    JOIN notebooks n ON n.id=b.notebook_id
    LEFT JOIN users u ON u.id=b.user_id
    LEFT JOIN periods p ON p.id=b.period_id
    ORDER BY b.date DESC, COALESCE(p.ord, 99) DESC, b.id DESC
  `);
  // alias per UI
  const mapped = rows.map(x => ({
    ...x,
    u_first: null, u_last: null, // placeholder compatibilità
  }));
  res.json(mapped);
});

// --- Docenti (admin) ---
app.get("/api/admin/teachers", auth, adminOnly, async (req, res) => {
  const rows = await q(`SELECT id, first_name, last_name, teacher_code, email, role, active FROM teachers ORDER BY id`);
  res.json(rows);
});

app.post("/api/admin/teachers", auth, adminOnly, async (req, res) => {
  try {
    const { first_name, last_name, teacher_code, email = null, role = "user", active = true } = req.body || {};
    if (!teacher_code) return res.status(400).json({ detail: "Codice docente obbligatorio" });
    const r = await qi(
      `INSERT INTO teachers(first_name,last_name,teacher_code,email,role,active)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, first_name, last_name, teacher_code, email, role, active`,
      [first_name||null, last_name||null, teacher_code, email, role, !!active]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (String(e.message).toLowerCase().includes("duplicate key")) {
      return res.status(409).json({ detail: "Codice docente già esistente" });
    }
    console.error(e);
    res.status(500).json({ detail: "Errore creazione docente" });
  }
});

app.put("/api/admin/teachers/:id", auth, adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  const allowed = ["first_name","last_name","teacher_code","email","role","active"];
  const sets = [], vals = [];
  for (const k of allowed) {
    if (k in (req.body||{})) { sets.push(`${k}=$${sets.length+1}`); vals.push(req.body[k]); }
  }
  if (!sets.length) return res.status(400).json({ detail: "Nessun campo da aggiornare" });
  vals.push(id);
  try {
    const r = await qi(`UPDATE teachers SET ${sets.join(",")} WHERE id=$${vals.length} RETURNING id,first_name,last_name,teacher_code,email,role,active`, vals);
    if (!r.rowCount) return res.status(404).json({ detail: "Docente non trovato" });
    res.json(r.rows[0]);
  } catch (e) {
    if (String(e.message).toLowerCase().includes("duplicate key")) {
      return res.status(409).json({ detail: "Codice docente già esistente" });
    }
    console.error(e);
    res.status(500).json({ detail: "Errore aggiornamento docente" });
  }
});

app.delete("/api/admin/teachers/:id", auth, adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  const r = await qi(`DELETE FROM teachers WHERE id=$1`, [id]);
  if (!r.rowCount) return res.status(404).json({ detail: "Docente non trovato" });
  res.json({ ok: true });
});

// Import CSV: "Nome;Cognome;Codice;Email;Ruolo;Attivo(1/0)"
app.post("/api/admin/teachers/import", auth, adminOnly, async (req, res) => {
  const { csv = "" } = req.body || {};
  const lines = String(csv).split(/\r?\n/).filter(x => x.trim());
  let created = 0, updated = 0, skipped = 0, errors = [];
  for (const line of lines) {
    const parts = line.split(/;|,|\t/).map(s => s.trim());
    if (parts.length < 3) { skipped++; continue; }
    const [first_name, last_name, teacher_code, email=null, role="user", active="1"] = parts;
    try {
      const ex = await q(`SELECT id FROM teachers WHERE teacher_code=$1`, [teacher_code]);
      if (ex.length) {
        await qi(`UPDATE teachers SET first_name=$1,last_name=$2,email=$3,role=$4,active=$5 WHERE id=$6`,
          [first_name||null,last_name||null,email||null,role, active==="1", ex[0].id]);
        updated++;
      } else {
        await qi(`INSERT INTO teachers(first_name,last_name,teacher_code,email,role,active)
                  VALUES ($1,$2,$3,$4,$5,$6)`,
          [first_name||null,last_name||null,teacher_code,email||null,role,active==="1"]);
        created++;
      }
    } catch (e) {
      errors.push({ line, error: e.message });
    }
  }
  res.json({ created, updated, skipped, errors });
});

app.post("/api/admin/teachers/bulk", auth, adminOnly, async (req, res) => {
  const { teachers = [] } = req.body || {};
  let created = 0, updated = 0, skipped = 0, errors = [];
  for (const t of teachers) {
    try {
      if (!t.teacher_code) { skipped++; continue; }
      const ex = await q(`SELECT id FROM teachers WHERE teacher_code=$1`, [t.teacher_code]);
      if (ex.length) {
        await qi(`UPDATE teachers SET first_name=$1,last_name=$2,email=$3,role=$4,active=$5 WHERE id=$6`,
          [t.first_name||null,t.last_name||null,t.email||null,t.role||"user", !!t.active, ex[0].id]);
        updated++;
      } else {
        await qi(`INSERT INTO teachers(first_name,last_name,teacher_code,email,role,active)
                  VALUES ($1,$2,$3,$4,$5,$6)`,
          [t.first_name||null,t.last_name||null,t.teacher_code,t.email||null,t.role||"user", !!t.active]);
        created++;
      }
    } catch (e) {
      errors.push({ t, error: e.message });
    }
  }
  res.json({ created, updated, skipped, errors });
});

// ---------- Static (serve frontend) ----------
app.use(express.static(path.join(__dirname, "."))); // index.html, app.js, reset-password.html
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ---------- Start ----------
initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`🚀 Server pronto su :${PORT}`));
  })
  .catch((e) => {
    console.error("Init DB fallita:", e);
    process.exit(1);
  });
