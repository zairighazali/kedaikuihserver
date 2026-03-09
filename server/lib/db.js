// backend/lib/db.js
// Neon PostgreSQL client using the 'pg' driver

const { Pool } = require("pg");

// BUG FIX 1: Warn immediately if DATABASE_URL is missing
if (!process.env.DATABASE_URL) {
  console.error("❌ [DB] DATABASE_URL is not set in .env — Neon will not connect!");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // BUG FIX 2: ssl config was too rigid. Neon connection strings already include
  // sslmode=require. We detect this and set rejectUnauthorized: false only when needed.
  // Without this, Node.js rejects Neon's certificate on many hosting platforms.
  ssl: process.env.DATABASE_URL?.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000, // BUG FIX 3: increased from 5000 — Neon serverless
                                   // instances need up to 10s on cold start
});

// BUG FIX 4: Test connection on startup for immediate clear error feedback
pool.connect((err, client, release) => {
  if (err) {
    console.error("❌ [DB] Cannot connect to Neon:", err.message);
    console.error("   Check DATABASE_URL in .env");
    console.error("   Format: postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/dbname?sslmode=require");
  } else {
    console.log("✅ [DB] Connected to Neon PostgreSQL");
    release();
  }
});

pool.on("error", (err) => {
  console.error("❌ [DB] Unexpected pool error:", err.message);
});

async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    if (process.env.NODE_ENV !== "production") {
      console.log(`[DB] ${Date.now() - start}ms — ${text.slice(0, 80)}`);
    }
    return res;
  } catch (err) {
    console.error("[DB Error]", err.message);
    if (process.env.NODE_ENV !== "production") {
      console.error("  Query:", text);
      console.error("  Params:", params);
    }
    throw err;
  }
}

async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn({ query: (text, params) => client.query(text, params) });
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { query, transaction, pool };