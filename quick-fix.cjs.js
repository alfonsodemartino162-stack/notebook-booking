// quick-fix.cjs
// Applica il "fix rapido" su Windows per notebook-booking:
// - Passa a CommonJS (rimuove "type":"module")
// - Rimuove lo script che forza la compilazione di better-sqlite3
// - Imposta "start": "node server.cjs"
// - Rinomina server.js -> server.cjs (se esiste)
// - Suggerisce i comandi per pulire e reinstallare

const fs = require("fs");
const path = require("path");

const projectRoot = process.cwd();
const pkgPath = path.join(projectRoot, "package.json");
const serverJs = path.join(projectRoot, "server.js");
const serverCjs = path.join(projectRoot, "server.cjs");

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function writeJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

(function run() {
  if (!fs.existsSync(pkgPath)) {
    console.error("❌ Non trovo package.json nella cartella corrente.");
    process.exit(1);
  }

  // 1) patch package.json
  const pkg = readJSON(pkgPath);

  // a) Scripts
  pkg.scripts = pkg.scripts || {};
  // rimuovi postinstall che forza la build-from-source di better-sqlite3
  if (pkg.scripts.postinstall && /better-sqlite3|build-from-source/i.test(pkg.scripts.postinstall)) {
    delete pkg.scripts.postinstall;
    console.log("🧹 Rimossa script 'postinstall' che forzava la build di better-sqlite3.");
  }

  // imposta start su server.cjs
  pkg.scripts.start = "node server.cjs";

  // b) Type: rimuovi "module" per usare CommonJS
  if (pkg.type === "module") {
    delete pkg.type;
    console.log("🔁 Rimosso \"type\":\"module\" (torna CommonJS).");
  }

  writeJSON(pkgPath, pkg);
  console.log("✅ package.json aggiornato (CommonJS + start su server.cjs).");

  // 2) rinomina server.js -> server.cjs se necessario
  try {
    if (fs.existsSync(serverCjs)) {
      console.log("ℹ️ server.cjs esiste già: nessuna rinomina necessaria.");
    } else if (fs.existsSync(serverJs)) {
      fs.renameSync(serverJs, serverCjs);
      console.log("📄 Rinominato server.js → server.cjs");
    } else {
      console.log("⚠️ Né server.js né server.cjs trovati. Assicurati che il file del server esista.");
    }
  } catch (e) {
    console.error("❌ Errore durante la rinomina:", e.message);
  }

  // 3) istruzioni next-step
  console.log("\n🚀 Prossimi passi (PowerShell, da eseguire nella root del progetto):\n");
  console.log('  setx NPM_CONFIG_BUILD_FROM_SOURCE false');
  console.log('  rd /s /q node_modules');
  console.log('  del package-lock.json');
  console.log('  npm install');
  console.log('  npm start');
  console.log("\nDopo 'npm start' apri http://localhost:3000\n");
})();
