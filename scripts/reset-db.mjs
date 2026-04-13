/**
 * Czyści lokalną bazę (użytkownicy, operatorzy, wątki, wiadomości itd.).
 * ZATRZYMAJ wcześniej serwer (node server.js), inaczej Windows może zablokować plik.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const dataDir = path.join(root, "data");
const files = ["portal.sqlite", "portal.sqlite-wal", "portal.sqlite-shm"];

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
  console.log("Utworzono katalog data/");
  process.exit(0);
}

let removed = 0;
for (const name of files) {
  const p = path.join(dataDir, name);
  if (!fs.existsSync(p)) continue;
  try {
    fs.unlinkSync(p);
    console.log("Usunięto:", p);
    removed++;
  } catch (e) {
    console.error("Nie można usunąć (serwer nadal działa?):", p);
    console.error(e.message);
    process.exit(1);
  }
}

if (removed === 0) {
  console.log("Brak plików portal.sqlite — przy następnym starcie serwera powstanie świeża baza.");
} else {
  console.log("Gotowe. Uruchom ponownie: npm start — powstanie nowa baza + seed postaci.");
}
