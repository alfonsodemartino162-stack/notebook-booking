# ============================================
# Avvio automatico server FastAPI (Notebook Booking)
# ============================================

Write-Host ""
Write-Host "============================================"
Write-Host "   Avvio Notebook Booking con FastAPI"
Write-Host "============================================"
Write-Host ""

# 1) Crea ambiente virtuale se non esiste
if (!(Test-Path ".\.venv")) {
    Write-Host "Creazione ambiente virtuale .venv..."
    python -m venv .venv
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Errore nella creazione del virtualenv. Verifica che 'python' sia nel PATH."
        exit 1
    }
}

# 2) Attiva virtual environment
Write-Host "Attivazione ambiente virtuale..."
. .\.venv\Scripts\Activate.ps1
if ($LASTEXITCODE -ne 0) {
    Write-Error "Impossibile attivare l'ambiente virtuale. Controlla l'ExecutionPolicy."
    exit 1
}

# 3) Installa / aggiorna dipendenze
Write-Host "Installazione/aggiornamento dipendenze..."
pip install --upgrade pip
pip install fastapi==0.115.0 "uvicorn[standard]==0.30.6" bcrypt==4.2.0 PyJWT==2.9.0

if ($LASTEXITCODE -ne 0) {
    Write-Error "Installazione dipendenze fallita."
    exit 1
}

# 4) Crea cartella data/ se non esiste
if (!(Test-Path ".\data")) {
    Write-Host "Creazione cartella data/"
    New-Item -ItemType Directory -Path ".\data" | Out-Null
}

# 5) Crea database SQLite se mancante
$dbPath = ".\data\notebook-booking.db"
if (!(Test-Path $dbPath)) {
    Write-Host "Creazione database iniziale $dbPath ..."

    # Schema SQL
    $schemaSql = @'
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE,
  password TEXT,
  role TEXT
);

CREATE TABLE IF NOT EXISTS notebooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId INTEGER,
  notebook TEXT,
  docente TEXT,
  classe TEXT,
  aula TEXT,
  date TEXT,
  time TEXT,
  FOREIGN KEY(userId) REFERENCES users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_unique_slot ON bookings (notebook, date, time);
'@

    $schemaFile = ".\data\init_schema.sql"
    $schemaSql | Out-File -Encoding UTF8 $schemaFile

    # Script Python temporaneo per inizializzare il DB
    $pyFile = ".\data\init_db.py"
$pyCode = @'
import sqlite3, os, sys

db_path = os.path.join("data", "notebook-booking.db")
schema_path = os.path.join("data", "init_schema.sql")

os.makedirs("data", exist_ok=True)

conn = sqlite3.connect(db_path)
with open(schema_path, "r", encoding="utf-8") as f:
    conn.executescript(f.read())
conn.commit()
conn.close()

print("Database inizializzato correttamente.")
'@
    $pyCode | Out-File -Encoding UTF8 $pyFile

    python $pyFile
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Inizializzazione database fallita."
        exit 1
    }
}

# 6) Variabili d'ambiente (modificabili)
$env:JWT_SECRET = "super-chiave-segreta"
$env:ADMIN_EMAIL = "admin@scuola.local"
$env:ADMIN_PASSWORD = "PasswordFort3!"
# 0 = non resettare all'avvio; 1 = resetta (se il tuo main.py lo supporta)
$env:RESET_DB = "0"

# 7) Avvio del server
Write-Host ""
Write-Host "Tutto pronto! Avvio del server su http://localhost:3000 ..."
uvicorn main:app --reload --host 0.0.0.0 --port 3000
