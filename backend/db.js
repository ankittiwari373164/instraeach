// db.js — SQLite via sql.js (pure JavaScript, no native modules needed)
const path = require('path');
const fs   = require('fs');

const DB_PATH = process.env.DB_PATH || './data/instraeach.db';
const DB_DIR  = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

let _db        = null;
let _saveTimer = null;

// Persist to disk with 300ms debounce
// Uses atomic write (temp file + rename) to avoid Windows file lock issues
function scheduleSave() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      const data = _db.export();
      const buf  = Buffer.from(data);
      const tmp  = DB_PATH + '.tmp';
      fs.writeFileSync(tmp, buf);
      // Atomic rename — safe on Windows too
      if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
      fs.renameSync(tmp, DB_PATH);
    } catch(e) {
      // If rename fails (Windows lock), try direct write
      try { fs.writeFileSync(DB_PATH, Buffer.from(_db.export())); } catch {}
    }
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
      parent_category   TEXT NOT NULL,
      sub_category      TEXT,
      location          TEXT NOT NULL,
      keywords          TEXT NOT NULL,
      message           TEXT NOT NULL,
      max_dms           INTEGER DEFAULT 100,
      scrape_depth      INTEGER DEFAULT 1,
      dm_from_search    INTEGER DEFAULT 1,
      dm_from_followers INTEGER DEFAULT 1,
      skip_private      INTEGER DEFAULT 1,
      skip_dmed         INTEGER DEFAULT 1,
      status            TEXT DEFAULT 'pending',
      use_ai_enhance    INTEGER DEFAULT 0,
      image_url         TEXT DEFAULT '',
      dms_sent          INTEGER DEFAULT 0,
      accounts_found    INTEGER DEFAULT 0,
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

  // ── Migrations: add new columns to existing databases ────────
  // ALTER TABLE IF NOT EXISTS not supported in sql.js SQLite,
  // so check PRAGMA table_info first and only ALTER if column is missing.
  try {
    const campInfo = _db.exec("PRAGMA table_info(campaigns)");
    const existingCols = (campInfo[0]?.values || []).map(r => r[1]);

    if (!existingCols.includes('use_ai_enhance')) {
      _db.run("ALTER TABLE campaigns ADD COLUMN use_ai_enhance INTEGER DEFAULT 0");
      console.log('[DB] Migration: added use_ai_enhance column to campaigns');
    }
    if (!existingCols.includes('image_url')) {
      _db.run("ALTER TABLE campaigns ADD COLUMN image_url TEXT DEFAULT ''");
      console.log('[DB] Migration: added image_url column to campaigns');
    }
  } catch(migErr) {
    console.log('[DB] Migration warning:', migErr.message);
  }

  // Save schema to disk immediately on first run
  fs.writeFileSync(DB_PATH, Buffer.from(_db.export()));
  console.log('[DB] SQLite (sql.js) ready at', require('path').resolve(DB_PATH));
  return db;
}

module.exports = { initDb };