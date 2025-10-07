// Notebook Booking – Express + SQLite (better-sqlite3)
// Richiede package.json con: { "type": "module" }

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Diagnostica base
process.on("uncaughtException", (e) => { console.error("💥 uncaughtException:", e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error("💥 unhandledRejection:", e); process.exit(1); });

dotenv.config();
process.env.TZ = process.env.TZ || "Europe/Rome"; // fuso coerente

// ------------------------------------------------------------
// Path & App init
// ------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
// Disattiva cache per tutte le risposte API/HTML
app.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

// ------------------------------------------------------------
// Database
// ------------------------------------------------------------
const dataDir = path.join(__dirname, "data");
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, "notebook-booking.db");

// reset opzionale
if (process.env.RESET_DB === "1") {
  try { fs.rmSync(dbPath, { force: true }); console.log("🧹 DB rimosso"); } catch {}
}

const db = new Database(dbPath);

// ------------------------------------------------------------
// Schema e migrazioni
// ------------------------------------------------------------

db.prepare(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    password TEXT,
    role TEXT
  )
`).run();
db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS notebooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  )
`).run();

/**
 * bookings:
 * - date/time: ciò che inserisce l’utente (per UI)
 * - slot_utc: la stessa data/ora convertita in UTC, usata per i vincoli
 * - docente/classe/aula: nuovi campi richiesti
 */
db.prepare(`
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER,
    notebook TEXT,
    date TEXT,
    time TEXT,
    slot_utc TEXT,
    docente TEXT,
    classe TEXT,
    aula TEXT,
    FOREIGN KEY(userId) REFERENCES users(id)
  )
`).run();

// Migrazioni: colonne mancanti + indici univoci
(() => {
  const cols = db.prepare("PRAGMA table_info(bookings)").all().map(c => c.name);

  const maybeAdd = (name, type = "TEXT") => {
    if (!cols.includes(name)) {
      db.prepare(`ALTER TABLE bookings ADD COLUMN ${name} ${type}`).run();
      console.log(`🔧 Migrazione: aggiunta bookings.${name}`);
    }
  };

  maybeAdd("slot_utc", "TEXT");
  maybeAdd("docente", "TEXT");
  maybeAdd("classe", "TEXT");
  maybeAdd("aula", "TEXT");

  // indice unico robusto (notebook + slot_utc)
  db.prepare(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_unique_slot_utc
    ON bookings (notebook, slot_utc)
  `).run();

  // backfill slot_utc dove mancante
  const rows = db.prepare("SELECT id, date, time FROM bookings WHERE slot_utc IS NULL OR slot_utc = ''").all();
  const upd = db.prepare("UPDATE bookings SET slot_utc = ? WHERE id = ?");
  const toUTC = (date, time) => {
    if (!date || !time) return null;
    const [Y, M, D] = date.split("-").map(Number);
    const [h, m] = time.split(":").map(Number);
    const local = new Date(Y, (M - 1), D, h, m, 0, 0);
    return new Date(local.getTime() - local.getTimezoneOffset() * 60000).toISOString();
  };
  const tx = db.transaction((arr) => {
    for (const r of arr) {
      const iso = toUTC(r.date, r.time);
      if (iso) upd.run(iso, r.id);
    }
  });
  if (rows.length) { tx(rows); console.log(`🔧 Backfill slot_utc completato (${rows.length})`); }
})();

// seed notebooks se tabella vuota
const nbCount = db.prepare("SELECT COUNT(*) AS c FROM notebooks").get().c;
if (!nbCount) {
  const seed = ["Lenovo Yoga Slim 7", "HP EliteBook 845", "Dell Latitude 7440", "MacBook Air M2"];
  const ins = db.prepare("INSERT INTO notebooks (name, active) VALUES (?, 1)");
  const tx = db.transaction((arr) => arr.forEach(n => ins.run(n)));
  tx(seed);
  console.log("🌱 Seed notebooks inseriti");
}

// ------------------------------------------------------------
// Helpers & Auth
// ------------------------------------------------------------
const JWT_SECRET = process.env.JWT_SECRET || "secretkey";

const isValidEmail = (email) => typeof email === "string" && email.length <= 254 && /\S+@\S+\.\S+/.test(email);
const isValidPassword = (pw) => typeof pw === "string" && pw.length >= 6 && pw.length <= 128;
const isValidDate = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
const isValidTime = (t) => typeof t === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t);
const isNonEmpty = (s) => typeof s === "string" && s.trim().length > 0 && s.trim().length <= 100;

function authMiddleware(req, res, next) {
  const raw = req.headers.authorization || "";
  const token = raw.startsWith("Bearer ") ? raw.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Token mancante" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Token non valido" });
  }
}
function adminOnly(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Solo admin" });
  next();
}

// Crea admin se manca
(() => {
  const adminEmail = process.env.ADMIN_EMAIL || "admin@demo.local";
  const adminPass = process.env.ADMIN_PASSWORD || "changeme";
  const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(adminEmail);
  if (!exists) {
    const hashed = bcrypt.hashSync(adminPass, 10);
    db.prepare("INSERT INTO users (email, password, role) VALUES (?, ?, ?)").run(adminEmail, hashed, "admin");
    console.log(`✅ Admin creato: ${adminEmail} / ${adminPass}`);
  }
})();

// ------------------------------------------------------------
// API
// ------------------------------------------------------------
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Auth
app.post("/api/register", (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!isValidEmail(email)) return res.status(400).json({ error: "Email non valida" });
    if (!isValidPassword(password)) return res.status(400).json({ error: "Password non valida (min 6 caratteri)" });

    const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (exists) return res.status(409).json({ error: "Email già registrata" });

    const hashed = bcrypt.hashSync(password, 10);
    const info = db.prepare("INSERT INTO users (email, password, role) VALUES (?, ?, 'user')").run(email, hashed);
    const token = jwt.sign({ id: info.lastInsertRowid, role: "user" }, JWT_SECRET, { expiresIn: "1h" });
    res.status(201).json({ token, user: { id: info.lastInsertRowid, email, role: "user" } });
  } catch (err) {
    console.error("REGISTER error:", err);
    res.status(500).json({ error: "Registrazione fallita" });
  }
});

app.post("/api/login", (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user) return res.status(401).json({ error: "Credenziali errate" });
  const ok = bcrypt.compareSync(password, user.password || "");
  if (!ok) return res.status(401).json({ error: "Credenziali errate" });

  const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: "1h" });
  res.json({ token });
});

app.get("/api/me", authMiddleware, (req, res) => {
  const u = db.prepare("SELECT id, email, role FROM users WHERE id = ?").get(req.user.id);
  res.json(u || null);
});

// Notebooks (pubblico: solo attivi)
app.get("/api/notebooks", (_req, res) => {
  const rows = db.prepare("SELECT id, name FROM notebooks WHERE active = 1 ORDER BY name").all();
  res.json(rows);
});

// Admin Notebooks CRUD
app.get("/api/admin/notebooks", authMiddleware, adminOnly, (_req, res) => {
  const rows = db.prepare("SELECT id, name, active FROM notebooks ORDER BY name").all();
  res.json(rows);
});

app.post("/api/admin/notebooks", authMiddleware, adminOnly, (req, res) => {
  const { name, active = 1 } = req.body || {};
  if (typeof name !== "string" || !name.trim()) return res.status(400).json({ error: "Nome notebook obbligatorio" });
  try {
    const info = db.prepare("INSERT INTO notebooks (name, active) VALUES (?, ?)").run(name.trim(), active ? 1 : 0);
    res.status(201).json({ id: info.lastInsertRowid, name: name.trim(), active: active ? 1 : 0 });
  } catch (err) {
    if (String(err.message || "").includes("UNIQUE")) return res.status(409).json({ error: "Nome già presente" });
    console.error("CREATE NOTEBOOK error:", err);
    res.status(500).json({ error: "Creazione notebook fallita" });
  }
});

app.put("/api/admin/notebooks/:id", authMiddleware, adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const { name, active } = req.body || {};
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID non valido" });

  const existing = db.prepare("SELECT id FROM notebooks WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "Notebook non trovato" });

  const fields = [];
  const values = [];
  if (typeof name === "string" && name.trim()) { fields.push("name = ?"); values.push(name.trim()); }
  if (active === 0 || active === 1 || active === true || active === false) { fields.push("active = ?"); values.push(active ? 1 : 0); }
  if (!fields.length) return res.status(400).json({ error: "Nessun campo da aggiornare" });

  try {
    db.prepare(`UPDATE notebooks SET ${fields.join(", ")} WHERE id = ?`).run(...values, id);
    const row = db.prepare("SELECT id, name, active FROM notebooks WHERE id = ?").get(id);
    res.json(row);
  } catch (err) {
    if (String(err.message || "").includes("UNIQUE")) return res.status(409).json({ error: "Nome già presente" });
    console.error("UPDATE NOTEBOOK error:", err);
    res.status(500).json({ error: "Aggiornamento notebook fallita" });
  }
});

app.delete("/api/admin/notebooks/:id", authMiddleware, adminOnly, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID non valido" });

  const del = db.prepare("DELETE FROM notebooks WHERE id = ?").run(id);
  if (!del.changes) return res.status(404).json({ error: "Notebook non trovato" });
  res.json({ ok: true });
});

// Prenotazioni
app.get("/api/bookings", authMiddleware, (req, res) => {
  const rows = db.prepare(`
    SELECT id, notebook, date, time, docente, classe, aula
    FROM bookings
    WHERE userId = ?
    ORDER BY date DESC, time DESC, id DESC
  `).all(req.user.id);
  res.json(rows);
});

app.post("/api/bookings", authMiddleware, (req, res) => {
  const { notebookId, date, time, docente, classe, aula } = req.body || {};
  if (!notebookId || !date || !time || !docente || !classe || !aula) {
    return res.status(400).json({ error: "Dati mancanti (notebookId, date, time, docente, classe, aula)" });
  }
  if (!isValidDate(date)) return res.status(400).json({ error: "Data non valida (YYYY-MM-DD)" });
  if (!isValidTime(time)) return res.status(400).json({ error: "Ora non valida (HH:MM)" });
  if (!isNonEmpty(docente)) return res.status(400).json({ error: "Docente obbligatorio" });
  if (!isNonEmpty(classe)) return res.status(400).json({ error: "Classe obbligatoria" });
  if (!isNonEmpty(aula)) return res.status(400).json({ error: "Aula obbligatoria" });

  const nb = db.prepare("SELECT name, active FROM notebooks WHERE id = ?").get(notebookId);
  if (!nb) return res.status(400).json({ error: "Notebook inesistente" });
  if (!nb.active) return res.status(400).json({ error: "Notebook non attivo" });

  const toUTC = (date, time) => {
    const [Y, M, D] = date.split("-").map(Number);
    const [h, m] = time.split(":").map(Number);
    const local = new Date(Y, (M - 1), D, h, m, 0, 0);
    return new Date(local.getTime() - local.getTimezoneOffset() * 60000).toISOString();
  };
  const slotUtc = toUTC(date, time);

  const overlap = db.prepare("SELECT id FROM bookings WHERE notebook = ? AND slot_utc = ?").get(nb.name, slotUtc);
  if (overlap) return res.status(409).json({ error: "Slot già prenotato per questo notebook" });

  try {
    const info = db.prepare(
      "INSERT INTO bookings (userId, notebook, date, time, slot_utc, docente, classe, aula) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(req.user.id, nb.name, date, time, slotUtc, String(docente).trim(), String(classe).trim(), String(aula).trim());
    res.status(201).json({ ok: true, id: info.lastInsertRowid });
  } catch (err) {
    if (String(err.message || "").includes("UNIQUE")) {
      return res.status(409).json({ error: "Slot già prenotato per questo notebook" });
    }
    console.error("CREATE BOOKING error:", err);
    res.status(500).json({ error: "Creazione prenotazione fallita" });
  }
});

// annulla prenotazione (proprietario o admin)
app.delete("/api/bookings/:id", authMiddleware, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID non valido" });

  const bk = db.prepare("SELECT userId FROM bookings WHERE id = ?").get(id);
  if (!bk) return res.status(404).json({ error: "Prenotazione non trovata" });
  if (req.user.role !== "admin" && bk.userId !== req.user.id) {
    return res.status(403).json({ error: "Non autorizzato" });
  }
  db.prepare("DELETE FROM bookings WHERE id = ?").run(id);
  res.json({ ok: true });
});

// ------------------------------------------------------------
// Statici (frontend) e root
// ------------------------------------------------------------
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ------------------------------------------------------------
// Avvio server
// ------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server up on port ${PORT}`));
