import "dotenv/config";
import { Client } from "pg";

async function main() {
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) {
    throw new Error("Brak DATABASE_URL.");
  }
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const db = await client.query("SELECT current_database() AS db, current_user AS usr");
    const users = await client.query("SELECT COUNT(*)::int AS c FROM users");
    const operators = await client.query("SELECT COUNT(*)::int AS c FROM operators");
    console.log("[pg:check] connected:", db.rows[0]);
    console.log("[pg:check] users:", users.rows[0].c, "operators:", operators.rows[0].c);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[pg:check] error:", err?.message || err);
  process.exit(1);
});
