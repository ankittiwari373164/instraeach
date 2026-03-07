// db.js — SQLite via sql.js (pure JavaScript, no native modules needed)
const path = require('path');
const fs   = require('fs');

const DB_PATH = process.env.DB_PATH || './data/instraeach.db';
const DB_DIR  = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

let _db        = null;
let _saveTimer = null;

// Persist to disk with 300ms debounce
function scheduleSave() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    const data = _db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  }, 300);
}

// Convert spread params into the array sql.js expects
function toArray(params) {
  if (!params || params.length === 0) return [];
  if (Array.isArray(params[0])) return params[0];
  return params;
}

// Wrap sql.js into a better-sqlite3-style synchronous API
// so server.js needs zero changes
function makeWrapper(db) {
  function prepare(sql) {
    return {
      run(...args) {
        db.run(sql, toArray(args));
        scheduleSave();
        const r = db.exec('SELECT last_insert_rowid() as id');
        return { lastInsertRowid: r[0]?.values[0][0] ?? null };
      },
      get(...args) {
        const stmt = db.prepare(sql);
        stmt.bind(toArray(args));
        const row = stmt.step() ? stmt.getAsObject() : undefined;
        stmt.free();
        return row;
      },
      all(...args) {
        const stmt = db.prepare(sql);
        stmt.bind(toArray(args));
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
        return rows;
      },
    };
  }

  function exec(sql) {
    db.run(sql);
    scheduleSave();
  }

  function pragma(str) {
    try { db.run(`PRAGMA ${str}`); } catch (_) {}
  }

  return { prepare, exec, pragma };
}

async function initDb() {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();

  const fileData = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH) : null;
  _db = fileData ? new SQL.Database(fileData) : new SQL.Database();

  const db = makeWrapper(_db);

  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT UNIQUE NOT NULL,
      password   TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id           TEXT PRIMARY KEY,
      username     TEXT UNIQUE NOT NULL,
      session_id   TEXT NOT NULL,
      daily_limit  INTEGER DEFAULT 150,
      cooldown_ms  INTEGER DEFAULT 8000,
      status       TEXT DEFAULT 'idle',
      dms_today    INTEGER DEFAULT 0,
      dms_total    INTEGER DEFAULT 0,
      last_active  TEXT,
      created_at   TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS campaigns (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      account_id        TEXT NOT NULL,
      parent_category   TEXT DEFAULT 'general',
      sub_category      TEXT,
      location          TEXT DEFAULT 'Delhi',
      keywords          TEXT DEFAULT '[]',
      message           TEXT DEFAULT '',
      max_dms           INTEGER DEFAULT 100,
      cooldown_ms       INTEGER DEFAULT 15000,
      scrape_depth      INTEGER DEFAULT 1,
      dm_from_search    INTEGER DEFAULT 1,
      dm_from_followers INTEGER DEFAULT 1,
      skip_private      INTEGER DEFAULT 1,
      skip_dmed         INTEGER DEFAULT 1,
      status            TEXT DEFAULT 'pending',
      dms_sent          INTEGER DEFAULT 0,
      accounts_found    INTEGER DEFAULT 0,
      image_url         TEXT DEFAULT '',
      created_at        TEXT DEFAULT (datetime('now')),
      started_at        TEXT,
      finished_at       TEXT
    );
    CREATE TABLE IF NOT EXISTS processed_accounts (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id       TEXT NOT NULL,
      target_username  TEXT NOT NULL,
      source           TEXT,
      dm_sent          INTEGER DEFAULT 0,
      dm_sent_at       TEXT,
      created_at       TEXT DEFAULT (datetime('now')),
      UNIQUE(account_id, target_username)
    );
    CREATE TABLE IF NOT EXISTS logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id  TEXT,
      campaign_id TEXT,
      level       TEXT DEFAULT 'info',
      message     TEXT NOT NULL,
      username    TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS ping_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT,
      ip         TEXT,
      pinged_at  TEXT DEFAULT (datetime('now'))
    );
  `);


  // ── Migrate existing DBs — add missing columns safely ────────
  const migrations = [
    "ALTER TABLE campaigns ADD COLUMN cooldown_ms INTEGER DEFAULT 15000",
    "ALTER TABLE campaigns ADD COLUMN image_url TEXT DEFAULT ''",
    "ALTER TABLE campaigns ADD COLUMN parent_category TEXT DEFAULT 'general'",
    "ALTER TABLE campaigns ADD COLUMN location TEXT DEFAULT 'Delhi'",
    "ALTER TABLE campaigns ADD COLUMN keywords TEXT DEFAULT '[]'",
    "ALTER TABLE campaigns ADD COLUMN message TEXT DEFAULT ''",
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch(_) { /* column already exists */ }
  }

  // Save schema
  fs.writeFileSync(DB_PATH, Buffer.from(_db.export()));
  console.log('[DB] SQLite (sql.js) ready at', DB_PATH);
  return db;
}

module.exports = { initDb };