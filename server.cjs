// server.cjs - Prenotazione Carrelli (login con codice, code-only, periodi colorati, admin, bulk, import)
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
const Database = require("better-sqlite3");

dotenv.config();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "changeme";
const JWT_EXPIRE_MIN = parseInt(process.env.JWT_EXPIRE_MIN || "240", 10);
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@demo.local";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme";
const RESET_DB = process.env.RESET_DB === "1";
const TZ = process.env.TZ || "Europe/Rome";
const SMTP_DEBUG = process.env.SMTP_DEBUG === "1";

// ===== DB =====
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "notebook-booking.db");
if (RESET_DB && fs.existsSync(DB_PATH)) { fs.rmSync(DB_PATH); console.log("🧹 DB rimosso (RESET_DB=1)"); }
const db = new Database(DB_PATH);
db.pragma("foreign_keys = ON");
db.pragma("journal_mode = WAL");

// ===== Schema =====
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE,
  password TEXT,
  role TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT,
  last_login_at TEXT,
  first_name TEXT,
  last_name  TEXT,
  teacher_code TEXT UNIQUE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS notebooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ord INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  start TEXT,
  end   TEXT
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId INTEGER NOT NULL,
  notebookId INTEGER NOT NULL,
  date TEXT NOT NULL,
  time TEXT,
  periodId INTEGER,
  teacher_first TEXT NOT NULL,
  teacher_last  TEXT NOT NULL,
  class_name TEXT,
  room TEXT,
  FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(notebookId) REFERENCES notebooks(id) ON DELETE RESTRICT,
  FOREIGN KEY(periodId) REFERENCES periods(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_unique_slot_time
ON bookings (notebookId, date, time)
WHERE time IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_unique_slot_period
ON bookings (notebookId, date, periodId)
WHERE periodId IS NOT NULL;
`);

// Migrazioni soft
function ensureColumn(table, col, typeSql) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.find(c => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${typeSql}`);
    console.log(`🧩 Migrazione: ${table}.${col} aggiunta`);
  }
}
ensureColumn("users", "active", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("users", "created_at", "TEXT");
ensureColumn("users", "last_login_at", "TEXT");
ensureColumn("users", "first_name", "TEXT");
ensureColumn("users", "last_name", "TEXT");
ensureColumn("users", "teacher_code", "TEXT");

// Seed base
const findUserByEmail = db.prepare("SELECT id FROM users WHERE email = ?");
if (!findUserByEmail.get(ADMIN_EMAIL)) {
  const now = new Date().toISOString();
  const hashed = bcrypt.hashSync(ADMIN_PASSWORD, 10);
  db.prepare("INSERT INTO users (email,password,role,active,created_at) VALUES (?,?, 'admin', 1, ?)")
    .run(ADMIN_EMAIL, hashed, now);
  console.log(`✅ Admin creato: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
}
if (db.prepare("SELECT COUNT(*) c FROM notebooks").get().c === 0) {
  const seed = ["Carrello 1", "Carrello 2", "Carrello 3", "Carrello 4"];
  const ins = db.prepare("INSERT INTO notebooks (name, active) VALUES (?, 1)");
  const tx = db.transaction(arr => arr.forEach(n => ins.run(n)));
  tx(seed);
  console.log("🛒 Carrelli seed inseriti");
}
// Paracadute periodi 1→6
(function ensurePeriodsSeed(){
  const want = [
    { ord:1, name:"Prima ora" }, { ord:2, name:"Seconda ora" },
    { ord:3, name:"Terza ora" }, { ord:4, name:"Quarta ora"  },
    { ord:5, name:"Quinta ora"}, { ord:6, name:"Sesta ora"   }
  ];
  const have = db.prepare("SELECT ord,name FROM periods").all();
  if (have.length < 6) {
    const missing = want.filter(w => !have.find(h => h.ord===w.ord || h.name===w.name));
    if (missing.length){
      const ins = db.prepare("INSERT OR IGNORE INTO periods (ord, name, start, end) VALUES (?, ?, NULL, NULL)");
      const tx = db.transaction(arr => arr.forEach(r => ins.run(r.ord, r.name)));
      tx(missing);
      console.log("🕒 Periodi ripristinati:", missing.map(m=>m.name).join(", "));
    }
  }
})();

// Mail (opzionale)
const FROM = process.env.SMTP_FROM || "Prenotazioni <noreply@scuola.test>";
function getMailer() {
  const { SMTP_HOST:h, SMTP_PORT:p, SMTP_USER:u, SMTP_PASS:pw } = process.env;
  if (!h || !p || !u || !pw) return null;
  const transporter = nodemailer.createTransport({
    host: h, port: Number(p), secure: String(process.env.SMTP_SECURE||"false")==="true",
    auth: { user:u, pass:pw }, tls:{ rejectUnauthorized:false, minVersion:"TLSv1.2" }
  });
  if (SMTP_DEBUG) console.log("✉️ SMTP:", {host:h, port:p, user:u?.slice(0,3)+"***"});
  return transporter;
}
async function sendBookingMail({ type, to, booking, notebook, period }) {
  const mailer = getMailer(); if (!mailer || !to) return;
  const when = period ? `${period.name}${period.start&&period.end?` (${period.start}–${period.end})`:""}` : booking.time;
  const subject = (type==="confirm"?"Conferma prenotazione: ":"Cancellazione prenotazione: ")+`${notebook.name} – ${booking.date} ${when}`;
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto">
    <p>${type==="confirm"?"La tua prenotazione è stata <b>confermata</b>.":"La tua prenotazione è stata <b>cancellata</b>."}</p>
    <ul>
      <li><b>Carrello:</b> ${notebook.name}</li>
      <li><b>Data:</b> ${booking.date}</li>
      <li><b>Ora/Periodo:</b> ${when}</li>
      <li><b>Docente:</b> ${[booking.teacher_first,booking.teacher_last].filter(Boolean).join(" ")}</li>
      ${booking.class_name?`<li><b>Classe:</b> ${booking.class_name}</li>`:""}
      ${booking.room?`<li><b>Aula:</b> ${booking.room}</li>`:""}
    </ul>
  </div>`;
  try { await mailer.sendMail({ from: FROM, to, subject, html }); } catch(e){ console.warn("⚠️ mail prenotazione:", e.message); }
}

// Helpers
const nameOk = s => typeof s==="string" && /^[A-Za-zÀ-ÖØ-öø-ÿ' -]{2,60}$/.test(String(s).trim());
const hhmmOk = s => typeof s==="string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const norm = s => String(s||"").trim().toLowerCase();
function makeToken(payload, minutes = JWT_EXPIRE_MIN) {
  return jwt.sign({ ...payload, exp: Math.floor(Date.now()/1000)+minutes*60 }, JWT_SECRET);
}
function getAuthUser(req, res) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) { res.status(401).json({ detail:"Token mancante" }); return null; }
  try {
    const tok = jwt.verify(h.slice(7), JWT_SECRET);
    const u = db.prepare("SELECT id,email,role,active,first_name,last_name,teacher_code FROM users WHERE id=?").get(tok.id);
    if (!u) { res.status(401).json({ detail:"Utente non trovato" }); return null; }
    if (!u.active) { res.status(403).json({ detail:"Utente disattivato" }); return null; }
    return u;
  } catch { res.status(401).json({ detail:"Token non valido" }); return null; }
}
const getUserById = id => db.prepare("SELECT id,email,role,first_name,last_name,teacher_code,active FROM users WHERE id=?").get(id);
const getNotebookById = id => db.prepare("SELECT id,name,active FROM notebooks WHERE id=?").get(id);
const getPeriodById = id => db.prepare("SELECT id,ord,name,start,end FROM periods WHERE id=?").get(id);

// App
const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" }));

const PUBLIC_DIR = path.join(__dirname, "public");
if (fs.existsSync(PUBLIC_DIR)) app.use("/", express.static(PUBLIC_DIR, { extensions: ["html"] }));

// Health
app.get("/api/health", (_req, res) => res.json({ ok:true, tz:TZ }));

// ===== Auth =====
app.post("/api/login-code", (req, res) => {
  const { firstName, lastName, code } = req.body || {};
  if (!nameOk(firstName||"") || !nameOk(lastName||"") || !code) return res.status(400).json({ detail:"Nome, cognome e codice obbligatori" });
  const u = db.prepare(`
    SELECT id,first_name,last_name,teacher_code,role,active,email
    FROM users
    WHERE lower(trim(first_name)) = ? AND lower(trim(last_name)) = ? AND teacher_code = ?
  `).get(norm(firstName), norm(lastName), String(code).trim());
  if (!u) return res.status(401).json({ detail:"Dati non validi" });
  if (!u.active) return res.status(403).json({ detail:"Account disattivato. Contatta l'amministratore." });
  db.prepare("UPDATE users SET last_login_at=? WHERE id=?").run(new Date().toISOString(), u.id);
  const token = makeToken({ id:u.id, role:u.role||"user" });
  res.json({ token });
});

// login SOLO codice (usato in silenzio dal client se nome/cognome vuoti)
app.post("/api/login-code-only", (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ detail:"Codice obbligatorio" });
  const u = db.prepare(`
    SELECT id,first_name,last_name,teacher_code,role,active,email
    FROM users
    WHERE teacher_code = ?
  `).get(String(code).trim());
  if (!u) return res.status(401).json({ detail:"Codice non trovato" });
  if (!u.active) return res.status(403).json({ detail:"Account disattivato. Contatta l'amministratore." });
  db.prepare("UPDATE users SET last_login_at=? WHERE id=?").run(new Date().toISOString(), u.id);
  const token = makeToken({ id:u.id, role:u.role||"user" });
  res.json({ token, first_name: u.first_name, last_name: u.last_name });
});

app.post("/api/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ detail:"Email e password obbligatorie" });
  const row = db.prepare("SELECT id,email,password,role,active FROM users WHERE email=?").get(email);
  if (!row || !bcrypt.compareSync(password, row.password)) return res.status(401).json({ detail:"Credenziali errate" });
  if (!row.active) return res.status(403).json({ detail:"Account disattivato" });
  const token = makeToken({ id: row.id, role: row.role });
  db.prepare("UPDATE users SET last_login_at=? WHERE id=?").run(new Date().toISOString(), row.id);
  res.json({ token });
});

app.get("/api/me", (req, res) => {
  const u = getAuthUser(req,res); if(!u) return;
  res.json(u);
});

// ===== Periodi & Carrelli =====
app.get("/api/periods", (_req, res) => {
  res.json(db.prepare("SELECT id,ord,name,start,end FROM periods ORDER BY ord").all());
});
app.get("/api/notebooks", (_req, res) => {
  res.json(db.prepare("SELECT id,name,active FROM notebooks WHERE active=1 ORDER BY name").all());
});

// ===== Admin carrelli =====
app.get("/api/admin/notebooks", (req, res) => {
  const u=getAuthUser(req,res); if(!u) return; if(u.role!=="admin") return res.status(403).json({detail:"Solo admin"});
  res.json(db.prepare("SELECT id,name,active FROM notebooks ORDER BY id").all());
});
app.post("/api/admin/notebooks", (req, res) => {
  const u=getAuthUser(req,res); if(!u) return; if(u.role!=="admin") return res.status(403).json({detail:"Solo admin"});
  const { name, active=true } = req.body||{};
  const clean=String(name||"").trim(); if(!clean) return res.status(400).json({detail:"Nome obbligatorio"});
  try{
    const info=db.prepare("INSERT INTO notebooks (name,active) VALUES (?,?)").run(clean, active?1:0);
    res.status(201).json(db.prepare("SELECT id,name,active FROM notebooks WHERE id=?").get(info.lastInsertRowid));
  }catch(e){ if(String(e.message).toUpperCase().includes("UNIQUE")) return res.status(409).json({detail:"Nome già presente"}); throw e; }
});
app.post("/api/admin/notebooks/bulk", (req, res) => {
  const u=getAuthUser(req,res); if(!u) return; if(u.role!=="admin") return res.status(403).json({detail:"Solo admin"});
  const { base="Carrello", startFrom=1, count=1 } = req.body||{};
  const c = Math.max(1, Math.min(500, Number(count)||1));
  const s = Math.max(1, Number(startFrom)||1);
  const ins = db.prepare("INSERT OR IGNORE INTO notebooks (name,active) VALUES (?,1)");
  const tx = db.transaction(()=>{
    for(let i=0;i<c;i++){ ins.run(`${String(base).trim()} ${s+i}`); }
  });
  tx();
  res.json({ ok:true, created:c });
});
app.put("/api/admin/notebooks/:id", (req, res) => {
  const u=getAuthUser(req,res); if(!u) return; if(u.role!=="admin") return res.status(403).json({detail:"Solo admin"});
  const id=Number(req.params.id), {name,active}=req.body||{};
  const exists=db.prepare("SELECT id FROM notebooks WHERE id=?").get(id); if(!exists) return res.status(404).json({detail:"Carrello non trovato"});
  const fields=[], vals=[];
  if (typeof name==="string" && name.trim()){ fields.push("name=?"); vals.push(name.trim()); }
  if (typeof active==="boolean"){ fields.push("active=?"); vals.push(active?1:0); }
  if (!fields.length) return res.status(400).json({detail:"Nessun campo da aggiornare"});
  db.prepare(`UPDATE notebooks SET ${fields.join(", ")} WHERE id=?`).run(...vals, id);
  res.json(db.prepare("SELECT id,name,active FROM notebooks WHERE id=?").get(id));
});
app.delete("/api/admin/notebooks/:id", (req, res) => {
  const u=getAuthUser(req,res); if(!u) return; if(u.role!=="admin") return res.status(403).json({detail:"Solo admin"});
  const id=Number(req.params.id);
  const has = db.prepare("SELECT 1 FROM bookings WHERE notebookId=? LIMIT 1").get(id);
  if (has) return res.status(409).json({ detail:"Impossibile eliminare: esistono prenotazioni per questo carrello" });
  const info=db.prepare("DELETE FROM notebooks WHERE id=?").run(id);
  if(!info.changes) return res.status(404).json({detail:"Carrello non trovato"});
  res.json({ok:true});
});

// ===== Disponibilità =====
app.get("/api/availability", (req, res) => {
  const { date, time, periodId } = req.query||{};
  if (!date) return res.status(400).json({ detail:"Parametro 'date' obbligatorio (YYYY-MM-DD)" });
  if (!time && !periodId) return res.status(400).json({ detail:"Indicare 'time' (HH:MM) oppure 'periodId'" });
  if (time && !hhmmOk(time)) return res.status(400).json({ detail:"time non valido (HH:MM)" });
  const rows = db.prepare(`
    SELECT n.id, n.name, n.active,
      CASE WHEN EXISTS (
        SELECT 1 FROM bookings b
        WHERE b.notebookId = n.id AND b.date = ?
          AND ((? IS NOT NULL AND b.time = ?) OR (? IS NOT NULL AND b.periodId = ?))
      ) THEN 1 ELSE 0 END AS booked
    FROM notebooks n
    WHERE n.active=1
    ORDER BY n.name
  `).all(date, time||null, time||null, periodId||null, periodId||null);
  res.json(rows);
});

// ===== Prenotazioni =====
app.get("/api/bookings", (req, res) => {
  const u = getAuthUser(req,res); if(!u) return;
  const rows = db.prepare(`
    SELECT b.*, p.name AS period_name, p.start AS period_start, p.end AS period_end
    FROM bookings b
    LEFT JOIN periods p ON p.id=b.periodId
    WHERE b.userId=?
    ORDER BY b.date DESC, COALESCE(p.ord,999), b.time
  `).all(u.id);
  res.json(rows);
});
app.get("/api/admin/bookings", (req, res) => {
  const u=getAuthUser(req,res); if(!u) return; if(u.role!=="admin") return res.status(403).json({detail:"Solo admin"});
  const rows = db.prepare(`
    SELECT b.*, u.email AS user_email, u.first_name AS u_first, u.last_name AS u_last,
           n.name AS notebook_name, p.name AS period_name, p.start AS period_start, p.end AS period_end
    FROM bookings b
    JOIN users u ON u.id=b.userId
    JOIN notebooks n ON n.id=b.notebookId
    LEFT JOIN periods p ON p.id=b.periodId
    ORDER BY b.date DESC, COALESCE(p.ord,999), b.time
  `).all();
  res.json(rows);
});
app.post("/api/bookings", async (req, res) => {
  const u = getAuthUser(req,res); if(!u) return;
  const { notebookId, date, time, periodId, teacherFirst, teacherLast, class_name=null, room=null } = req.body||{};
  if (!notebookId || !date) return res.status(400).json({ detail:"notebookId e date obbligatori" });
  if (!time && !periodId) return res.status(400).json({ detail:"Indicare 'time' (HH:MM) oppure 'periodId'" });
  if (time && !hhmmOk(time)) return res.status(400).json({ detail:"time non valido (HH:MM)" });
  if (!nameOk(teacherFirst||"") || !nameOk(teacherLast||"")) return res.status(400).json({ detail:"Nome e cognome docente non validi" });

  const nb = getNotebookById(Number(notebookId)); if(!nb) return res.status(400).json({detail:"Carrello inesistente"});
  if (!nb.active) return res.status(400).json({detail:"Carrello non attivo"});

  let period = null, periodIdToSave = null, timeToSave = null;
  if (periodId) { period = getPeriodById(Number(periodId)); if(!period) return res.status(400).json({detail:"Periodo inesistente"}); periodIdToSave = period.id; }
  else { timeToSave = time; }

  try {
    const info = db.prepare(`
      INSERT INTO bookings (userId, notebookId, date, time, periodId, teacher_first, teacher_last, class_name, room)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      u.id, notebookId, date, timeToSave, periodIdToSave,
      String(teacherFirst).trim(), String(teacherLast).trim(), class_name||null, room||null
    );

    const booking = { id:info.lastInsertRowid, notebookId, date, time:timeToSave, periodId:periodIdToSave,
                      teacher_first:String(teacherFirst).trim(), teacher_last:String(teacherLast).trim(), class_name, room };

    try { const user = getUserById(u.id); const to = user?.email || null;
      if (to) await sendBookingMail({ type:"confirm", to, booking, notebook: nb, period });
    } catch(e){ console.warn("⚠️ email conferma:", e.message); }

    res.status(201).json({ ok:true, id: booking.id });
  } catch(e){
    if (String(e.message).toUpperCase().includes("UNIQUE")) return res.status(409).json({ detail:"Slot già prenotato per questo carrello" });
    throw e;
  }
});
app.delete("/api/bookings/:id", async (req, res) => {
  const u=getAuthUser(req,res); if(!u) return;
  const id=Number(req.params.id);
  const row = db.prepare("SELECT * FROM bookings WHERE id=?").get(id);
  if (!row) return res.status(404).json({ detail:"Prenotazione non trovata" });
  if (u.role!=="admin" && row.userId!==u.id) return res.status(403).json({ detail:"Non autorizzato" });
  db.prepare("DELETE FROM bookings WHERE id=?").run(id);

  try {
    const user = getUserById(row.userId);
    const nb = getNotebookById(row.notebookId);
    const period = row.periodId ? getPeriodById(row.periodId) : null;
    if (user?.email) await sendBookingMail({ type:"cancel", to:user.email, booking: row, notebook: nb, period });
  } catch(e){ console.warn("⚠️ email cancellazione:", e.message); }

  res.json({ ok:true });
});

// ===== Admin: Docenti =====
app.get("/api/admin/teachers", (req, res) => {
  const u=getAuthUser(req,res); if(!u) return; if(u.role!=="admin") return res.status(403).json({detail:"Solo admin"});
  const rows = db.prepare(`
    SELECT id, first_name, last_name, teacher_code, email, role, active, created_at, last_login_at
    FROM users
    WHERE role IN ('user','admin')
    ORDER BY last_name, first_name
  `).all();
  res.json(rows);
});
app.post("/api/admin/teachers", (req, res) => {
  const u=getAuthUser(req,res); if(!u) return; if(u.role!=="admin") return res.status(403).json({detail:"Solo admin"});
  const { first_name, last_name, teacher_code, email=null, role="user", active=true } = req.body||{};
  const nameOkLocal = s => typeof s==="string" && /^[A-Za-zÀ-ÖØ-öø-ÿ' -]{2,60}$/.test(String(s).trim());
  if (!nameOkLocal(first_name||"") || !nameOkLocal(last_name||"") || !teacher_code) return res.status(400).json({detail:"Nome, cognome e codice obbligatori"});
  try{
    const now=new Date().toISOString();
    const info = db.prepare(`INSERT INTO users (first_name,last_name,teacher_code,email,role,active,created_at)
                             VALUES (?,?,?,?,?,?,?)`)
                   .run(String(first_name).trim(), String(last_name).trim(), String(teacher_code).trim(),
                        email||null, role==="admin"?"admin":"user", active?1:0, now);
    res.status(201).json(db.prepare("SELECT * FROM users WHERE id=?").get(info.lastInsertRowid));
  }catch(e){
    if (String(e.message).toUpperCase().includes("UNIQUE")) return res.status(409).json({detail:"Codice docente o email già presente"});
    throw e;
  }
});
app.put("/api/admin/teachers/:id", (req, res) => {
  const u=getAuthUser(req,res); if(!u) return; if(u.role!=="admin") return res.status(403).json({detail:"Solo admin"});
  const id=Number(req.params.id);
  const { first_name, last_name, teacher_code, email, role, active } = req.body||{};
  const exists = db.prepare("SELECT id FROM users WHERE id=?").get(id);
  if(!exists) return res.status(404).json({detail:"Docente non trovato"});
  const fields=[], vals=[];
  if (typeof first_name==="string" && first_name.trim()){ fields.push("first_name=?"); vals.push(first_name.trim()); }
  if (typeof last_name==="string"  && last_name.trim()) { fields.push("last_name=?");  vals.push(last_name.trim()); }
  if (typeof teacher_code==="string" && teacher_code.trim()){ fields.push("teacher_code=?"); vals.push(teacher_code.trim()); }
  if (typeof email==="string" && email.trim()){ fields.push("email=?"); vals.push(email.trim()); }
  if (role && (role==="user"||role==="admin")){ fields.push("role=?"); vals.push(role); }
  if (typeof active==="boolean"){ fields.push("active=?"); vals.push(active?1:0); }
  if (!fields.length) return res.status(400).json({detail:"Nessun campo da aggiornare"});
  try{
    db.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id=?`).run(...vals, id);
  }catch(e){
    if (String(e.message).toUpperCase().includes("UNIQUE")) return res.status(409).json({detail:"Codice docente o email già presente"});
    throw e;
  }
  res.json(db.prepare("SELECT * FROM users WHERE id=?").get(id));
});
app.delete("/api/admin/teachers/:id", (req, res) => {
  const u=getAuthUser(req,res); if(!u) return; if(u.role!=="admin") return res.status(403).json({detail:"Solo admin"});
  const id = Number(req.params.id);
  const has = db.prepare("SELECT 1 FROM bookings WHERE userId=? LIMIT 1").get(id);
  if (has) return res.status(409).json({ detail:"Impossibile eliminare: il docente ha prenotazioni associate" });
  const info = db.prepare("DELETE FROM users WHERE id=?").run(id);
  if (!info.changes) return res.status(404).json({ detail:"Docente non trovato" });
  res.json({ ok:true });
});
app.post("/api/admin/teachers/import", (req, res) => {
  const u=getAuthUser(req,res); if(!u) return; if(u.role!=="admin") return res.status(403).json({detail:"Solo admin"});
  const { csv } = req.body||{};
  if (!csv || typeof csv!=="string") return res.status(400).json({detail:"CSV mancante"});
  const linesRaw = csv.split(/\r?\n/).filter(l=>l.trim().length>0);
  if (!linesRaw.length) return res.status(400).json({detail:"Nessuna riga trovata"});

  const splitSmart = (line) => {
    const s = line.replace(/(^"|"$)/g, "");
    const sc = (s.match(/;/g)||[]).length, cc=(s.match(/,/g)||[]).length, tc=(s.match(/\t/g)||[]).length;
    const sep = sc>=cc && sc>=tc ? ";" : (cc>=tc ? "," : "\t");
    return s.split(sep).map(x=>x.trim().replace(/^"(.*)"$/,'$1'));
  };

  let i=0; if (/nome|cognome|codice/i.test(linesRaw[0])) i=1;

  const ins = db.prepare(`INSERT INTO users (first_name,last_name,teacher_code,email,role,active,created_at)
                          VALUES (?,?,?,?,?,?,?)`);
  const upd = db.prepare(`UPDATE users SET first_name=?, last_name=?, email=?, role=?, active=? WHERE teacher_code=?`);
  const now = new Date().toISOString();
  let created=0, updated=0, skipped=0, errors=[];

  const tx = db.transaction(()=>{
    for (; i<linesRaw.length; i++){
      const parts = splitSmart(linesRaw[i]);
      const [fn, ln, code, email, role="user", active="1"] = parts;
      if (!fn || !ln || !code){ skipped++; continue; }
      const exists = db.prepare("SELECT id FROM users WHERE teacher_code=?").get(String(code).trim());
      try{
        if (!exists){
          ins.run(String(fn).trim(), String(ln).trim(), String(code).trim(), (email||null)||null,
                  (String(role).toLowerCase()==="admin"?"admin":"user"),
                  (String(active)==="1"||active===1)?1:0, now);
          created++;
        } else {
          upd.run(String(fn).trim(), String(ln).trim(), (email||null)||null,
                  (String(role).toLowerCase()==="admin"?"admin":"user"),
                  (String(active)==="1"||active===1)?1:0, String(code).trim());
          updated++;
        }
      }catch(e){ errors.push(`${code||'(senza codice)'}: ${e.message}`); }
    }
  });
  tx();

  res.json({ ok:true, created, updated, skipped, errors });
});
app.post("/api/admin/teachers/bulk", (req, res) => {
  const u=getAuthUser(req,res); if(!u) return; if(u.role!=="admin") return res.status(403).json({detail:"Solo admin"});
  const { teachers } = req.body||{};
  if (!Array.isArray(teachers)) return res.status(400).json({detail:"Array 'teachers' mancante"});
  const ins = db.prepare(`INSERT INTO users (first_name,last_name,teacher_code,email,role,active,created_at)
                          VALUES (?,?,?,?,?,?,?)`);
  const upd = db.prepare(`UPDATE users SET first_name=?, last_name=?, email=?, role=?, active=? WHERE teacher_code=?`);
  const now = new Date().toISOString();
  let created=0, updated=0, skipped=0, errors=[];
  const tx = db.transaction(()=>{
    for (const t of teachers){
      const fn=t.first_name||t.firstName, ln=t.last_name||t.lastName, code=t.teacher_code||t.code;
      const email=(t.email||null), role=(t.role==="admin"?"admin":"user"), active=(t.active===false?0:1);
      if (!fn || !ln || !code){ skipped++; continue; }
      const exists = db.prepare("SELECT id FROM users WHERE teacher_code=?").get(String(code).trim());
      try{
        if (!exists){ ins.run(String(fn).trim(), String(ln).trim(), String(code).trim(), email, role, active, now); created++; }
        else { upd.run(String(fn).trim(), String(ln).trim(), email, role, active, String(code).trim()); updated++; }
      }catch(e){ errors.push(`${code||'(senza codice)'}: ${e.message}`); }
    }
  });
  tx();
  res.json({ ok:true, created, updated, skipped, errors });
});

// Test mail
app.post("/api/test-email", async (req, res) => {
  const { to } = req.body||{};
  const mailer = getMailer(); if(!mailer) return res.status(400).json({detail:"SMTP non configurato"});
  try{ await mailer.verify(); await mailer.sendMail({from:FROM,to,subject:"Test SMTP",html:"<b>OK</b>"}); res.json({ok:true}); }
  catch(e){ res.status(500).json({detail:e.message}); }
});

app.listen(PORT, () => console.log(`🚀 Server pronto su http://localhost:${PORT}`));
