/**
 * lib/db.js — Pure JSON store (no sql.js, no WASM, works on Vercel)
 * Vercel serverless: data lives in /tmp (ephemeral per cold start)
 * Local dev: data lives in ./data/
 *
 * Exposes a db.prepare().run/get/all API identical to better-sqlite3
 * so server.js needs zero changes.
 */
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const IS_VERCEL  = !!(process.env.VERCEL || process.env.VERCEL_ENV);
const DATA_DIR   = IS_VERCEL ? os.tmpdir() : path.join(process.cwd(), 'data');
const STORE_FILE = path.join(DATA_DIR, 'instraeach.json');

// ── In-memory store ───────────────────────────────────────────────
let _store = {
  admins:    [],
  accounts:  [],
  campaigns: [],
  dm_sent:   [],
  inbox:     [],
  replies:   [],
  logs:      [],
  ping_log:  [],
  _seq:      {},  // auto-increment counters per table
};

let _dirty     = false;
let _saveTimer = null;

function nextId(table) {
  _store._seq[table] = (_store._seq[table] || 0) + 1;
  return _store._seq[table];
}

function now() { return new Date().toISOString(); }

// ── Persist to disk ───────────────────────────────────────────────
function scheduleSave() {
  _dirty = true;
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try { fs.writeFileSync(STORE_FILE, JSON.stringify(_store)); _dirty = false; }
    catch (e) { console.warn('[DB] Save error:', e.message); }
  }, 200);
}

function loadStore() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {}
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = fs.readFileSync(STORE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      _store = { ..._store, ...parsed };
      console.log('[DB] Loaded store from', STORE_FILE);
    } else {
      console.log('[DB] Fresh store at', STORE_FILE);
    }
  } catch (e) {
    console.warn('[DB] Load error (starting fresh):', e.message);
  }
}

// ── SQL-like query engine ─────────────────────────────────────────
// Parses a tiny subset of SQL used by server.js
function parseWhere(whereClause, params) {
  if (!whereClause) return () => true;
  let idx = 0;
  const conditions = whereClause.split(/\s+AND\s+/i).map(cond => {
    const eqMatch = cond.match(/(\w+)\s*=\s*\?/);
    const likeMatch = cond.match(/(\w+)\s+LIKE\s+\?/i);
    const is0 = cond.match(/(\w+)\s*=\s*0/);
    const notNull = cond.match(/(\w+)\s+IS\s+NOT\s+NULL/i);
    if (likeMatch) {
      const col = likeMatch[1]; const val = (params[idx++] || '').replace(/%/g, '');
      return row => String(row[col] || '').toLowerCase().includes(val.toLowerCase());
    }
    if (eqMatch) {
      const col = eqMatch[1]; const val = params[idx++];
      return row => String(row[col] || '') === String(val || '');
    }
    if (is0) { const col = is0[1]; return row => !row[col]; }
    if (notNull) { const col = notNull[1]; return row => row[col] != null; }
    return () => true;
  });
  return row => conditions.every(fn => fn(row));
}

function parseOrderLimit(sql) {
  const orderMatch = sql.match(/ORDER BY\s+(\w+)\s*(ASC|DESC)?/i);
  const limitMatch = sql.match(/LIMIT\s+(\d+)/i);
  return {
    orderBy: orderMatch?.[1] || null,
    orderDir: (orderMatch?.[2] || 'ASC').toUpperCase(),
    limit: limitMatch ? parseInt(limitMatch[1]) : null,
  };
}

function getTable(sql) {
  const m = sql.match(/FROM\s+(\w+)/i) || sql.match(/INTO\s+(\w+)/i) || sql.match(/UPDATE\s+(\w+)/i) || sql.match(/DELETE\s+FROM\s+(\w+)/i);
  return m?.[1] || null;
}

function runSelect(sql, params) {
  const table = getTable(sql);
  if (!table || !_store[table]) return [];

  // Handle JOIN (simple LEFT JOIN only)
  const joinMatch = sql.match(/LEFT JOIN\s+(\w+)\s+\w+\s+ON\s+([\w.]+)\s*=\s*([\w.]+)/i);
  let rows = _store[table].map(r => ({ ...r }));

  if (joinMatch) {
    const joinTable = joinMatch[1];
    const leftCol   = joinMatch[2].split('.').pop();
    const rightCol  = joinMatch[3].split('.').pop();
    rows = rows.map(r => {
      const joined = (_store[joinTable] || []).find(j => String(j[rightCol]) === String(r[leftCol]));
      // Add joined columns with prefix if collision
      const extra = {};
      if (joined) Object.keys(joined).forEach(k => { extra[k] = r[k] !== undefined ? r[k] : joined[k]; });
      return { ...r, ...extra };
    });
  }

  // WHERE
  const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+ORDER|\s+LIMIT|$)/is);
  if (whereMatch) {
    const filter = parseWhere(whereMatch[1].trim(), params);
    rows = rows.filter(filter);
  }

  // ORDER BY + LIMIT
  const { orderBy, orderDir, limit } = parseOrderLimit(sql);
  if (orderBy) {
    rows.sort((a, b) => {
      const av = a[orderBy], bv = b[orderBy];
      if (av < bv) return orderDir === 'ASC' ? -1 : 1;
      if (av > bv) return orderDir === 'ASC' ? 1 : -1;
      return 0;
    });
  }
  if (limit) rows = rows.slice(0, limit);
  return rows;
}

// ── db.prepare() API (mimics better-sqlite3) ──────────────────────
function prepare(sql) {
  const sqlU = sql.trim().toUpperCase();

  return {
    run(...args) {
      const params = args.flat();
      // INSERT
      if (sqlU.startsWith('INSERT')) {
        const table = getTable(sql);
        if (!table) return { lastInsertRowid: null };
        if (!_store[table]) _store[table] = [];

        // Extract column names
        const colMatch = sql.match(/\(([^)]+)\)\s+VALUES/i);
        if (!colMatch) return { lastInsertRowid: null };
        const cols = colMatch[1].split(',').map(c => c.trim());
        const vals = params.slice(0, cols.length);
        const row  = { id: nextId(table) };
        cols.forEach((col, i) => {
          // Convert 0/1 booleans stored as strings
          row[col] = vals[i] !== undefined ? vals[i] : null;
        });

        // Set defaults for common timestamp fields
        if (row.created_at === undefined) row.created_at = now();
        if (sql.includes("datetime('now')") || sql.includes('DEFAULT (datetime')) {
          if (row.created_at === null) row.created_at = now();
        }

        // Handle INSERT OR IGNORE (check unique constraints manually)
        if (sqlU.includes('OR IGNORE') || sqlU.includes('INSERT IGNORE')) {
          const exists = _store[table].some(r => {
            if (table === 'dm_sent') return r.from_account_id === row.from_account_id && String(r.to_username).toLowerCase() === String(row.to_username).toLowerCase();
            if (table === 'inbox')   return r.from_username === row.from_username && r.message === row.message;
            return false;
          });
          if (exists) return { lastInsertRowid: null };
        }

        _store[table].push(row);
        scheduleSave();
        return { lastInsertRowid: row.id };
      }

      // UPDATE
      if (sqlU.startsWith('UPDATE')) {
        const table = getTable(sql);
        if (!table || !_store[table]) return {};
        const setMatch = sql.match(/SET\s+(.+?)\s+WHERE/is);
        const whereMatch = sql.match(/WHERE\s+(.+?)$/is);
        if (!setMatch) return {};

        const setClause = setMatch[1];
        const setParts  = setClause.split(',').map(p => p.trim());
        let paramIdx = 0;
        const updates = {};
        const increments = {};
        for (const part of setParts) {
          const eqMatch  = part.match(/(\w+)\s*=\s*\?/);
          const incMatch = part.match(/(\w+)\s*=\s*\1\s*\+\s*(\d+)/i);
          const nowMatch = part.match(/(\w+)\s*=\s*datetime\('now'\)/i);
          const val0Match= part.match(/(\w+)\s*=\s*0/);
          const val1Match= part.match(/(\w+)\s*=\s*1/);
          if (incMatch)  { increments[incMatch[1]] = parseInt(incMatch[2]); }
          else if (nowMatch)  { updates[nowMatch[1]] = now(); }
          else if (val0Match) { updates[val0Match[1]] = 0; }
          else if (val1Match) { updates[val1Match[1]] = 1; }
          else if (eqMatch)   { updates[eqMatch[1]] = params[paramIdx++]; }
        }

        const whereParams = params.slice(paramIdx);
        const filter = whereMatch ? parseWhere(whereMatch[1].trim(), whereParams) : () => true;
        _store[table].forEach(row => {
          if (filter(row)) {
            Object.assign(row, updates);
            Object.keys(increments).forEach(k => { row[k] = (row[k] || 0) + increments[k]; });
          }
        });
        scheduleSave();
        return {};
      }

      // DELETE
      if (sqlU.startsWith('DELETE')) {
        const table = getTable(sql);
        if (!table || !_store[table]) return {};
        const whereMatch = sql.match(/WHERE\s+(.+?)$/is);
        if (whereMatch) {
          const filter = parseWhere(whereMatch[1].trim(), params);
          _store[table] = _store[table].filter(row => !filter(row));
        } else {
          _store[table] = [];
        }
        scheduleSave();
        return {};
      }

      return {};
    },

    get(...args) {
      const params = args.flat();

      // COUNT(*)
      if (sql.includes('COUNT(*)')) {
        const table = getTable(sql);
        if (!table || !_store[table]) return { c: 0, v: 0 };
        const whereMatch = sql.match(/WHERE\s+(.+?)$/is);
        let rows = _store[table];
        if (whereMatch) {
          const filter = parseWhere(whereMatch[1].trim(), params);
          rows = rows.filter(filter);
        }
        return { c: rows.length, v: rows.length };
      }

      // SELECT ... LIMIT 1
      const rows = runSelect(sql, params);
      return rows[0] || undefined;
    },

    all(...args) {
      const params = args.flat();
      return runSelect(sql, params);
    },
  };
}

function exec(sql) {
  // Handle CREATE TABLE, PRAGMA — just ignore them (store is schema-free)
  return;
}

function pragma(str) { return; }

// ── initDb ────────────────────────────────────────────────────────
async function initDb() {
  loadStore();
  const db = { prepare, exec, pragma };
  console.log('[DB] JSON store ready at', STORE_FILE);
  return db;
}

module.exports = { initDb };