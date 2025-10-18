
# main.py
# FastAPI server per "Notebook Booking" (SQLite)
# Avvio: uvicorn main:app --reload --host 0.0.0.0 --port 3000

import os
import sqlite3
import bcrypt
import jwt
from datetime import datetime, timedelta
from typing import Optional, List

from fastapi import FastAPI, Depends, HTTPException, status, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, EmailStr, constr

# =========================
# Config & costanti
# =========================
JWT_SECRET = os.getenv("JWT_SECRET", "secretkey")
JWT_EXPIRE_MIN = int(os.getenv("JWT_EXPIRE_MIN", "60"))
ADMIN_EMAIL = os.getenv("ADMIN_EMAIL", "admin@demo.local")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "changeme")
RESET_DB = os.getenv("RESET_DB", "0") == "1"

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, "notebook-booking.db")

# =========================
# DB utils (sqlite3)
# =========================
def get_db():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    if RESET_DB and os.path.exists(DB_PATH):
        try:
            os.remove(DB_PATH)
            print("🧹 DB rimosso")
        except Exception as e:
            print("⚠️ Impossibile rimuovere DB:", e)

    conn = get_db()
    cur = conn.cursor()

    # users
    cur.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE,
        password TEXT,
        role TEXT
    )
    """)
    cur.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)")

    # notebooks
    cur.execute("""
    CREATE TABLE IF NOT EXISTS notebooks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
    )
    """)

    # bookings
    cur.execute("""
    CREATE TABLE IF NOT EXISTS bookings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL,
        notebookId INTEGER NOT NULL,
        date TEXT NOT NULL,          -- YYYY-MM-DD
        time TEXT NOT NULL,          -- HH:MM
        teacher TEXT,                -- docente (nome e cognome)
        class_name TEXT,             -- classe
        room TEXT,                   -- aula
        FOREIGN KEY(userId) REFERENCES users(id),
        FOREIGN KEY(notebookId) REFERENCES notebooks(id)
    )
    """)

    # indice unico anti-sovrapposizione (stesso notebook, stessa data e ora)
    cur.execute("""
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_unique_slot
    ON bookings (notebookId, date, time)
    """)

    # seed admin
    cur.execute("SELECT id FROM users WHERE email = ?", (ADMIN_EMAIL,))
    if cur.fetchone() is None:
        hashed = bcrypt.hashpw(ADMIN_PASSWORD.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
        cur.execute("INSERT INTO users (email, password, role) VALUES (?, ?, ?)",
                    (ADMIN_EMAIL, hashed, "admin"))
        print(f"✅ Admin creato: {ADMIN_EMAIL} / {ADMIN_PASSWORD}")

    # seed notebooks (se vuoto)
    cur.execute("SELECT COUNT(*) AS c FROM notebooks")
    c = cur.fetchone()["c"]
    if c == 0:
        seed = ["Lenovo Yoga Slim 7", "HP EliteBook 845", "Dell Latitude 7440", "MacBook Air M2"]
        for name in seed:
            cur.execute("INSERT INTO notebooks (name, active) VALUES (?, 1)", (name,))
        print("🌱 Seed notebooks inseriti")

    conn.commit()
    conn.close()

# =========================
# Schemi Pydantic
# =========================
class RegisterIn(BaseModel):
    email: EmailStr
    password: constr(min_length=6, max_length=128)

class LoginIn(BaseModel):
    email: EmailStr
    password: constr(min_length=6, max_length=128)

class UserOut(BaseModel):
    id: int
    email: EmailStr
    role: str

class NotebookCreate(BaseModel):
    name: constr(min_length=1)
    active: Optional[bool] = True

class NotebookUpdate(BaseModel):
    name: Optional[constr(min_length=1)] = None
    active: Optional[bool] = None

class NotebookOut(BaseModel):
    id: int
    name: str
    active: int

class BookingCreate(BaseModel):
    notebookId: int
    date: constr(regex=r"^\d{4}-\d{2}-\d{2}$")
    time: constr(regex=r"^(?:[01]\d|2[0-3]):[0-5]\d$")
    teacher: Optional[constr(max_length=120)] = None
    class_name: Optional[constr(max_length=50)] = None
    room: Optional[constr(max_length=50)] = None

class BookingOut(BaseModel):
    id: int
    notebookId: int
    date: str
    time: str
    teacher: Optional[str]
    class_name: Optional[str]
    room: Optional[str]

# =========================
# Auth helpers
# =========================
def make_token(user_id: int, role: str) -> str:
    payload = {
        "id": user_id,
        "role": role,
        "exp": datetime.utcnow() + timedelta(minutes=JWT_EXPIRE_MIN)
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")

def get_current_user(authorization: Optional[str] = Header(default=None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token mancante")

    token = authorization[7:]
    try:
        data = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token non valido")

    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT id, email, role FROM users WHERE id = ?", (data["id"],))
    row = cur.fetchone()
    conn.close()

    if not row:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Utente non trovato")

    return {"id": row["id"], "email": row["email"], "role": row["role"]}

def admin_only(user=Depends(get_current_user)):
    if user["role"] != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Solo admin")
    return user

# =========================
# App & CORS
# =========================
app = FastAPI(title="Notebook Booking API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # restringi se vuoi
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Static (facoltativo): servi ./public come frontend
PUBLIC_DIR = os.path.join(os.path.dirname(__file__), "public")
if os.path.isdir(PUBLIC_DIR):
    app.mount("/", StaticFiles(directory=PUBLIC_DIR, html=True), name="public")

# =========================
# Startup
# =========================
@app.on_event("startup")
def on_startup():
    init_db()

# =========================
# Routes
# =========================

@app.get("/api/health")
def health():
    return {"ok": True}

# --- Auth ---
@app.post("/api/register")
def register(payload: RegisterIn):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT id FROM users WHERE email = ?", (payload.email,))
    if cur.fetchone():
        conn.close()
        raise HTTPException(status_code=409, detail="Email già registrata")

    hashed = bcrypt.hashpw(payload.password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    cur.execute("INSERT INTO users (email, password, role) VALUES (?, ?, ?)",
                (payload.email, hashed, "user"))
    user_id = cur.lastrowid
    conn.commit()
    conn.close()

    token = make_token(user_id, "user")
    return {"token": token, "user": {"id": user_id, "email": payload.email, "role": "user"}}

@app.post("/api/login")
def login(payload: LoginIn):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT id, email, password, role FROM users WHERE email = ?", (payload.email,))
    row = cur.fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=401, detail="Credenziali errate")
    if not bcrypt.checkpw(payload.password.encode("utf-8"), row["password"].encode("utf-8")):
        raise HTTPException(status_code=401, detail="Credenziali errate")

    token = make_token(row["id"], row["role"])
    return {"token": token}

@app.get("/api/me", response_model=UserOut)
def me(user=Depends(get_current_user)):
    return user

# --- Notebooks (pubblico: solo attivi) ---
@app.get("/api/notebooks", response_model=List[NotebookOut])
def list_notebooks_public():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT id, name, active FROM notebooks WHERE active = 1 ORDER BY name")
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows

# --- Notebooks admin CRUD ---
@app.get("/api/admin/notebooks", response_model=List[NotebookOut])
def list_notebooks_admin(_=Depends(admin_only)):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT id, name, active FROM notebooks ORDER BY name")
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows

@app.post("/api/admin/notebooks", response_model=NotebookOut, status_code=201)
def create_notebook(payload: NotebookCreate, _=Depends(admin_only)):
    name = payload.name.strip()
    active = 1 if (payload.active is None or payload.active) else 0
    if not name:
        raise HTTPException(status_code=400, detail="Nome obbligatorio")

    conn = get_db()
    cur = conn.cursor()
    try:
        cur.execute("INSERT INTO notebooks (name, active) VALUES (?,?)", (name, active))
        nid = cur.lastrowid
        conn.commit()
        cur.execute("SELECT id, name, active FROM notebooks WHERE id = ?", (nid,))
        row = dict(cur.fetchone())
        return row
    except sqlite3.IntegrityError as e:
        if "UNIQUE" in str(e).upper():
            raise HTTPException(status_code=409, detail="Nome già presente")
        raise
    finally:
        conn.close()

@app.put("/api/admin/notebooks/{notebook_id}", response_model=NotebookOut)
def update_notebook(notebook_id: int, payload: NotebookUpdate, _=Depends(admin_only)):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT id FROM notebooks WHERE id = ?", (notebook_id,))
    if cur.fetchone() is None:
        conn.close()
        raise HTTPException(status_code=404, detail="Notebook non trovato")

    fields = []
    values = []
    if payload.name is not None and payload.name.strip():
        fields.append("name = ?")
        values.append(payload.name.strip())
    if payload.active is not None:
        fields.append("active = ?")
        values.append(1 if payload.active else 0)
    if not fields:
        conn.close()
        raise HTTPException(status_code=400, detail="Nessun campo da aggiornare")

    try:
        cur.execute(f"UPDATE notebooks SET {', '.join(fields)} WHERE id = ?", (*values, notebook_id))
        conn.commit()
        cur.execute("SELECT id, name, active FROM notebooks WHERE id = ?", (notebook_id,))
        return dict(cur.fetchone())
    except sqlite3.IntegrityError as e:
        if "UNIQUE" in str(e).upper():
            raise HTTPException(status_code=409, detail="Nome già presente")
        raise
    finally:
        conn.close()

@app.delete("/api/admin/notebooks/{notebook_id}")
def delete_notebook(notebook_id: int, _=Depends(admin_only)):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("DELETE FROM notebooks WHERE id = ?", (notebook_id,))
    if cur.rowcount == 0:
        conn.close()
        raise HTTPException(status_code=404, detail="Notebook non trovato")
    conn.commit()
    conn.close()
    return {"ok": True}

# --- Prenotazioni ---
@app.get("/api/bookings", response_model=List[BookingOut])
def my_bookings(user=Depends(get_current_user)):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
        SELECT id, notebookId, date, time, teacher, class_name, room
        FROM bookings
        WHERE userId = ?
        ORDER BY date DESC, time DESC, id DESC
    """, (user["id"],))
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows

@app.post("/api/bookings", status_code=201)
def create_booking(payload: BookingCreate, user=Depends(get_current_user)):
    # verifica notebook esistente e attivo
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT id, active FROM notebooks WHERE id = ?", (payload.notebookId,))
    nb = cur.fetchone()
    if nb is None:
        conn.close()
        raise HTTPException(status_code=400, detail="Notebook inesistente")
    if nb["active"] == 0:
        conn.close()
        raise HTTPException(status_code=400, detail="Notebook non attivo")

    # anti-sovrapposizione
    try:
        cur.execute("""
            INSERT INTO bookings (userId, notebookId, date, time, teacher, class_name, room)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (
            user["id"],
            payload.notebookId,
            payload.date,
            payload.time,
            payload.teacher or None,
            payload.class_name or None,
            payload.room or None
        ))
        booking_id = cur.lastrowid
        conn.commit()
        return {"ok": True, "id": booking_id}
    except sqlite3.IntegrityError as e:
        # cattura indice unico (notebookId,date,time)
        if "UNIQUE" in str(e).upper():
            raise HTTPException(status_code=409, detail="Slot già prenotato per questo notebook")
        raise
    finally:
        conn.close()

@app.delete("/api/bookings/{booking_id}")
def cancel_booking(booking_id: int, user=Depends(get_current_user)):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT id, userId FROM bookings WHERE id = ?", (booking_id,))
    row = cur.fetchone()
    if row is None:
        conn.close()
        raise HTTPException(status_code=404, detail="Prenotazione non trovata")

    # l'utente può cancellare solo le sue; l'admin qualsiasi
    if user["role"] != "admin" and row["userId"] != user["id"]:
        conn.close()
        raise HTTPException(status_code=403, detail="Non autorizzato a cancellare questa prenotazione")

    cur.execute("DELETE FROM bookings WHERE id = ?", (booking_id,))
    conn.commit()
    conn.close()
    return {"ok": True}
