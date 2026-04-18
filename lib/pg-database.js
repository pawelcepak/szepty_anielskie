import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { translateSqliteToPostgres, toPgParams } from "./sql-translate.js";
import { CHARACTER_PORTRAITS, CHAR_ABOUT, DEFAULT_TYPICAL_HOURS, EXTRA_OR_BASE_ROWS, ORIGINAL_SEED_IDS } from "../character-catalog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makePrepare(poolOrClient, useTranslate) {
  return function prepare(sql) {
    const base = useTranslate ? translateSqliteToPostgres(sql) : sql;
    return {
      async run(...params) {
        const { query, values } = toPgParams(base, params);
        const r = await poolOrClient.query(query, values);
        return { changes: r.rowCount ?? 0, lastInsertRowid: null };
      },
      async get(...params) {
        const { query, values } = toPgParams(base, params);
        const r = await poolOrClient.query(query, values);
        return r.rows[0] ?? undefined;
      },
      async all(...params) {
        const { query, values } = toPgParams(base, params);
        const r = await poolOrClient.query(query, values);
        return r.rows;
      },
    };
  };
}

async function seedCharacters(db) {
  const ins = `INSERT INTO characters (id, name, tagline, category, sort_order, portrait_url, gender, skills, about, typical_hours_from, typical_hours_to)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      tagline = EXCLUDED.tagline,
      category = EXCLUDED.category,
      sort_order = EXCLUDED.sort_order,
      portrait_url = COALESCE(EXCLUDED.portrait_url, characters.portrait_url),
      gender = EXCLUDED.gender,
      skills = EXCLUDED.skills,
      about = EXCLUDED.about,
      typical_hours_from = COALESCE(EXCLUDED.typical_hours_from, characters.typical_hours_from),
      typical_hours_to = COALESCE(EXCLUDED.typical_hours_to, characters.typical_hours_to)`;
  for (const r of EXTRA_OR_BASE_ROWS) {
    const url = CHARACTER_PORTRAITS[r[0]] || null;
    const m = CHAR_ABOUT[r[0]] || { gender: "", skills: "", about: "" };
    const hp = DEFAULT_TYPICAL_HOURS[r[0]] || [null, null];
    await db.prepare(ins).run(...r, url, m.gender, m.skills, m.about, hp[0], hp[1]);
  }

  // Remove original seed characters
  if (ORIGINAL_SEED_IDS.length > 0) {
    const placeholders = ORIGINAL_SEED_IDS.map(() => "?").join(",");
    await db.prepare(`DELETE FROM characters WHERE id IN (${placeholders})`).run(...ORIGINAL_SEED_IDS);
  }

  // Assign portrait photos to user-added characters that have none
  const PORTRAIT_POOL = [
    "https://i.pravatar.cc/400?img=47",
    "https://i.pravatar.cc/400?img=48",
    "https://i.pravatar.cc/400?img=49",
    "https://i.pravatar.cc/400?img=50",
    "https://i.pravatar.cc/400?img=51",
    "https://i.pravatar.cc/400?img=52",
    "https://i.pravatar.cc/400?img=53",
    "https://i.pravatar.cc/400?img=54",
    "https://i.pravatar.cc/400?img=55",
    "https://i.pravatar.cc/400?img=56",
    "https://i.pravatar.cc/400?img=57",
    "https://i.pravatar.cc/400?img=58",
  ];
  const noPortraitRows = await db
    .prepare("SELECT id FROM characters WHERE portrait_url IS NULL OR portrait_url = '' ORDER BY sort_order ASC, name ASC")
    .all();
  for (let i = 0; i < noPortraitRows.length; i++) {
    await db
      .prepare("UPDATE characters SET portrait_url = ? WHERE id = ?")
      .run(PORTRAIT_POOL[i % PORTRAIT_POOL.length], noPortraitRows[i].id);
  }

  // Assign self-descriptions to mediums without about text
  const ABOUT_BY_CATEGORY = {
    wróżby: [
      "Pracuję z energią i intuicją od wielu lat. Widzę blokady, ukryte intencje i możliwe kierunki, które stoją przed Tobą. Moją metodą jest połączenie wrodzonej wrażliwości z głęboką empatią — nie oceniam, pomagam. Specjalizuję się w sprawach serca, relacjach rodzinnych oraz ważnych decyzjach życiowych, które wymagają jasnego spojrzenia z zewnątrz. Moje odczyty są szczere i konkretne.",
      "Intuicja to mój pierwszy zmysł. Zanim cokolwiek powiem, czuję energię sytuacji i osoby, z którą rozmawiam. Moje odczyty są bezpośrednie i konkretne — wskazuję zarówno możliwości, jak i zagrożenia, bo wiem, że prawdziwa pomoc wymaga szczerości. Pomagam w sprawach miłości, kariery i wewnętrznego spokoju, szczególnie gdy nie wiesz, w którą stronę się skierować.",
      "Widzę energię i emocje zapisane w każdej sytuacji. Przez lata pracy nauczyłam się, że każda historia jest wyjątkowa — dlatego każda rozmowa ze mną jest inna. Nie stosuję szablonów. Czytam to, co naprawdę obecne w Twoim życiu, i pokazuję to bez owijania w bawełnę. Jeśli szukasz prawdziwej odpowiedzi, a nie tylko pocieszenia — dobrze trafiłeś.",
    ],
    tarot: [
      "Tarot to dla mnie system symboliczny sięgający głębiej niż słowa. Pracuję z kartami od wielu lat, stale rozwijając warsztat i intuicję. Każde rozłożenie jest unikalną odpowiedzią na Twoją sytuację — bez gotowych formułek. Pomagam w rozumieniu relacji, kierunków rozwoju i podejmowaniu decyzji zgodnych z Twoją prawdziwą ścieżką.",
      "Uczę się od kart od lat i za każdym razem widzę w nich coś nowego. Tarot to nie przepowiednia — to zwierciadło Twojej sytuacji i energii w danym momencie. Pracuję spokojnie, dokładnie i bez pośpiechu. Każde pytanie traktuję poważnie, bo wiem, że rzadko pyta się o błahostki. Chodź, razem poszukamy odpowiedzi w kartach.",
    ],
    astrologia: [
      "Astrologia to moja pasja i sposób rozumienia życia. Przez lata nauki i praktyki nauczyłam się odczytywać horoskopy tak, by naprawdę służyły człowiekowi — nie jako wyrok losu, ale jako mapa możliwości i wyzwań. Analizuję horoskopy urodzeniowe, tranzyty planet i synergie. Pomagam zrozumieć trudne okresy i podejmować decyzje zgodne z naturą Twojego wykresu.",
      "Gwiazdy nie rządzą Twoim życiem — ale wiele o nim mówią. Zajmuję się tym, co zapisane w chwili Twojego urodzenia: Twoimi talentami, wyzwaniami i cyklami życiowymi. Pomagam zrozumieć wpływ planet na bieżące sytuacje i podejmować świadome decyzje, szczególnie w obszarach miłości, kariery i ważnych relacji.",
    ],
    jasnowidzenie: [
      "Jasnowidztwo towarzyszyło mi od dziecka — widzę obrazy, odczuwam emocje innych, dostaję przekazy, których nie szukam. Przez lata nauczyłam się pracować z tym darem świadomie i odpowiedzialnie. Każda sesja to coś więcej niż wróżba — to kontakt z głębszą warstwą rzeczywistości, która może dać Ci wskazówki niedostępne w codziennym życiu.",
      "Widzę i odczuwam to, co niewidoczne gołym okiem. Mój dar rozwijał się stopniowo, a lata pracy nauczyły mnie, jak odpowiedzialnie go używać. Przekazuję informacje bezpośrednio i bez owijania w bawełnę — wiem, że przyszedłeś po prawdę, nie po pocieszenie. Pomagam w sprawach, które nie dają spokoju i wymagają głębszej perspektywy.",
    ],
  };
  const defaultAbout = [
    "Pomagam w trudnych momentach życiowych — w sprawach serca, pracy, rodziny i osobistych decyzji. Moje podejście łączy intuicję z empatią. Każda rozmowa jest inna, bo każdy człowiek przynosi ze sobą unikalną historię. Traktuję każde pytanie poważnie i odpowiadam szczerze, nawet jeśli prawda wymaga odwagi.",
    "Pracuję z energią i intuicją, skupiając się na tym, co naprawdę ważne dla Ciebie. Nie mówię tego, co chcesz usłyszeć — mówię to, co widzę i czuję. Moje odczyty są konkretne i praktyczne. Pomagam w sprawach miłosnych, zawodowych i w każdej sytuacji, gdy potrzebujesz spojrzenia z zewnątrz.",
  ];
  function pickAbout(category, idx) {
    const cat = String(category || "").toLowerCase();
    let pool = defaultAbout;
    for (const [key, arr] of Object.entries(ABOUT_BY_CATEGORY)) {
      if (cat.includes(key)) { pool = arr; break; }
    }
    return pool[idx % pool.length];
  }
  const noAboutRows = await db
    .prepare("SELECT id, category FROM characters WHERE about IS NULL OR about = '' ORDER BY sort_order ASC, name ASC")
    .all();
  for (let i = 0; i < noAboutRows.length; i++) {
    await db
      .prepare("UPDATE characters SET about = ? WHERE id = ?")
      .run(pickAbout(noAboutRows[i].category, i), noAboutRows[i].id);
  }
}

export async function createPgDatabase(databaseUrl) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 12,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  });

  const schemaPath = path.join(__dirname, "..", "scripts", "postgres-schema.sql");
  const schemaSql = fs.readFileSync(schemaPath, "utf8");
  await pool.query(schemaSql);
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_email_change TEXT");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS gender TEXT");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS has_children TEXT");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS smokes TEXT");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS drinks_alcohol TEXT");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS has_car TEXT");

  const db = {
    prepare: makePrepare(pool, true),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const tx = { prepare: makePrepare(client, true) };
        await fn(tx);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
    _pool: pool,
  };

  await db
    .prepare(
      `INSERT INTO app_kv (key, value) VALUES ('assign_rr', '0') ON CONFLICT (key) DO NOTHING`
    )
    .run();

  await seedCharacters(db);

  return db;
}

export async function closePgDatabase(db) {
  if (db?._pool) await db._pool.end();
}
