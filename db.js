// db.js — SQLite database setup for InstaReach Playwright
'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const DATA_DIR = process.env.DATA_DIR || './data';
const DB_PATH  = path.join(DATA_DIR, 'instraeach.db');

function initDb() {
  return new Promise((resolve, reject) => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const db = new Database(DB_PATH);

      // WAL mode for better concurrency
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');

      db.exec(`
        CREATE TABLE IF NOT EXISTS admins (
          id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          username   TEXT NOT NULL UNIQUE,
          password   TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS accounts (
          id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          username    TEXT NOT NULL UNIQUE,
          session_id  TEXT,
          daily_limit INTEGER DEFAULT 150,
          cooldown_ms INTEGER DEFAULT 8000,
          status      TEXT    DEFAULT 'idle',
          dms_today   INTEGER DEFAULT 0,
          dms_total   INTEGER DEFAULT 0,
          last_active TEXT,
          created_at  TEXT    DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS campaigns (
          id                TEXT    PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          account_id        TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          name              TEXT    NOT NULL,
          parent_category   TEXT    DEFAULT '',
          sub_category      TEXT    DEFAULT '',
          location          TEXT    DEFAULT '',
          keywords          TEXT    DEFAULT '[]',
          message           TEXT    NOT NULL,
          max_dms           INTEGER DEFAULT 100,
          scrape_depth      INTEGER DEFAULT 1,
          dm_from_search    INTEGER DEFAULT 1,
          dm_from_followers INTEGER DEFAULT 1,
          skip_private      INTEGER DEFAULT 1,
          skip_dmed         INTEGER DEFAULT 1,
          use_ai_enhance    INTEGER DEFAULT 0,
          image_url         TEXT    DEFAULT '',
          status            TEXT    DEFAULT 'stopped',
          dms_sent          INTEGER DEFAULT 0,
          started_at        TEXT,
          finished_at       TEXT,
          created_at        TEXT    DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS processed_accounts (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id      TEXT NOT NULL,
          target_username TEXT NOT NULL,
          source          TEXT DEFAULT 'bot',
          dm_sent         INTEGER DEFAULT 0,
          dm_sent_at      TEXT,
          created_at      TEXT DEFAULT (datetime('now')),
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
          ts         TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_logs_campaign   ON logs(campaign_id);
        CREATE INDEX IF NOT EXISTS idx_logs_account    ON logs(account_id);
        CREATE INDEX IF NOT EXISTS idx_processed_acct  ON processed_accounts(account_id);
      `);

      // ── Migrations: safely add columns that may be missing in older DBs ──
      const migrations = [
        `ALTER TABLE campaigns ADD COLUMN cooldown_ms        INTEGER DEFAULT 15000`,
        `ALTER TABLE campaigns ADD COLUMN scrape_depth       INTEGER DEFAULT 1`,
        `ALTER TABLE campaigns ADD COLUMN dm_from_search     INTEGER DEFAULT 1`,
        `ALTER TABLE campaigns ADD COLUMN dm_from_followers  INTEGER DEFAULT 1`,
        `ALTER TABLE campaigns ADD COLUMN skip_private       INTEGER DEFAULT 1`,
        `ALTER TABLE campaigns ADD COLUMN skip_dmed          INTEGER DEFAULT 1`,
        `ALTER TABLE campaigns ADD COLUMN use_ai_enhance     INTEGER DEFAULT 0`,
        `ALTER TABLE campaigns ADD COLUMN image_url          TEXT    DEFAULT ''`,
        `ALTER TABLE accounts  ADD COLUMN cooldown_ms        INTEGER DEFAULT 8000`,
        `ALTER TABLE accounts  ADD COLUMN daily_limit        INTEGER DEFAULT 150`,
      ];

      for (const sql of migrations) {
        try { db.exec(sql); } catch (e) { /* column already exists — skip */ }
      }

      console.log('[InstaReach] Database ready:', DB_PATH);
      resolve(db);
    } catch(err) {
      reject(err);
    }
  });
}

module.exports = { initDb };