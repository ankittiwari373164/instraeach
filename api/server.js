// api/server.js — InstaReach v2 API
require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const path     = require('path');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');
const { initDb }     = require('../lib/db');
const engine         = require('../lib/dmEngine');

const app        = express();
const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || process.env.ADMIN_PASSWORD || 'instraeach_v2_secret';

app.use(cors());
app.use(express.json({ limit: '20mb' }));

// ── Serve frontend ────────────────────────────────────────────────
const publicDir = path.join(__dirname, '..', 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}
// Catch-all: serve index.html for any non-API route
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path === '/ping' || req.path === '/health') return next();
  const indexFile = path.join(__dirname, '..', 'public', 'index.html');
  if (fs.existsSync(indexFile)) {
    res.sendFile(indexFile);
  } else {
    res.status(404).send('index.html not found');
  }
});

// ── Auth ──────────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ── Boot ──────────────────────────────────────────────────────────
initDb().then(db => {
  engine.setDb(db);

  // Seed admin
  const existing = db.prepare('SELECT id FROM admins WHERE username=?').get(process.env.ADMIN_USERNAME || 'admin');
  if (!existing) {
    const hash = require('bcryptjs').hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10);
    db.prepare('INSERT INTO admins (username,password) VALUES (?,?)').run(process.env.ADMIN_USERNAME || 'admin', hash);
    console.log('[InstaReach v2] Admin seeded');
  }

  // ── Auth routes ───────────────────────────────────────────────
  app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const admin = db.prepare('SELECT * FROM admins WHERE username=?').get(username);
    if (!admin || !bcrypt.compareSync(password, admin.password))
      return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: admin.id, username: admin.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: admin.username });
  });

  // ── Stats ─────────────────────────────────────────────────────
  app.get('/api/stats', auth, (_req, res) => {
    const totalAccounts   = db.prepare('SELECT COUNT(*) AS c FROM accounts').get().c;
    const totalSent       = db.prepare('SELECT COUNT(*) AS c FROM dm_sent').get().c;
    const totalInbox      = db.prepare('SELECT COUNT(*) AS c FROM inbox').get().c;
    const unread          = db.prepare('SELECT COUNT(*) AS c FROM inbox WHERE is_read=0').get().c;
    const activeCampaigns = db.prepare("SELECT COUNT(*) AS c FROM campaigns WHERE status='running'").get().c;
    res.json({ totalAccounts, totalSent, totalInbox, unread, activeCampaigns });
  });

  // ── Accounts ──────────────────────────────────────────────────
  app.get('/api/accounts', auth, (_req, res) => {
    const rows = db.prepare('SELECT * FROM accounts ORDER BY created_at DESC').all();
    res.json(rows);
  });

  app.post('/api/accounts', auth, (req, res) => {
    const { username, session_id = '', password = '', daily_limit = 50, notes = '', totp_secret = '' } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });
    const clean = username.replace('@', '').trim();
    const existing = db.prepare('SELECT id FROM accounts WHERE username=?').get(clean);
    if (existing) return res.status(400).json({ error: 'Account already exists' });
    const total = db.prepare('SELECT COUNT(*) AS c FROM accounts').get().c;
    if (total >= 100) return res.status(400).json({ error: 'Max 100 accounts reached' });
    const id = uuidv4();
    db.prepare('INSERT INTO accounts (id,username,session_id,password,daily_limit,notes,totp_secret) VALUES (?,?,?,?,?,?,?)').run(id, clean, session_id, password || session_id, daily_limit, notes, totp_secret);
    res.json({ id, username: clean });
  });

  app.post('/api/accounts/bulk', auth, (req, res) => {
    const { accounts } = req.body;
    if (!Array.isArray(accounts)) return res.status(400).json({ error: 'accounts[] required' });
    let added = 0, skipped = 0;
    for (const acc of accounts) {
      try {
        const total = db.prepare('SELECT COUNT(*) AS c FROM accounts').get().c;
        if (total >= 100) break;
        const clean = (acc.username || '').replace('@', '').trim();
        if (!clean) { skipped++; continue; }
        const exists = db.prepare('SELECT id FROM accounts WHERE username=?').get(clean);
        if (exists) { skipped++; continue; }
        db.prepare('INSERT INTO accounts (id,username,session_id,password,daily_limit,notes) VALUES (?,?,?,?,?,?)')
          .run(uuidv4(), clean, acc.session_id || '', acc.password || acc.session_id || '', acc.daily_limit || 50, acc.notes || '');
        added++;
      } catch { skipped++; }
    }
    res.json({ added, skipped });
  });

  app.put('/api/accounts/:id', auth, (req, res) => {
    const { session_id, daily_limit, notes } = req.body;
    const fields = [], vals = [];
    if (session_id  !== undefined) { fields.push('session_id=?');  vals.push(session_id); }
    if (daily_limit !== undefined) { fields.push('daily_limit=?'); vals.push(daily_limit); }
    if (notes       !== undefined) { fields.push('notes=?');       vals.push(notes); }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id);
    db.prepare(`UPDATE accounts SET ${fields.join(',')} WHERE id=?`).run(...vals);
    res.json({ ok: true });
  });

  app.delete('/api/accounts/:id', auth, (req, res) => {
    db.prepare('DELETE FROM accounts WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  });

  app.delete('/api/accounts', auth, (_req, res) => {
    db.prepare('DELETE FROM accounts').run();
    res.json({ ok: true });
  });

  // Reset daily DM count
  app.post('/api/accounts/reset-daily', auth, (_req, res) => {
    db.prepare('UPDATE accounts SET dms_today=0').run();
    res.json({ ok: true });
  });

  // ── Test login for a single account ──────────────────────────
  app.post('/api/accounts/test-login', auth, async (req, res) => {
    const { account_id } = req.body;
    if (!account_id) return res.status(400).json({ ok: false, error: 'account_id required' });
    const acc = db.prepare('SELECT * FROM accounts WHERE id=?').get(account_id);
    if (!acc) return res.status(404).json({ ok: false, error: 'Account not found' });
    try {
      const result = await engine.testLogin(acc);
      // Update account status in db
      db.prepare("UPDATE accounts SET status=? WHERE id=?").run(result.ok ? 'idle' : 'error', acc.id);
      res.json(result);
    } catch(e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ── Upload Excel / CSV → replace ALL accounts ─────────────────
  // Receives parsed JSON from the frontend (SheetJS parses xlsx client-side)
  // POST /api/accounts/upload-replace  { accounts: [{username, session_id, daily_limit, notes}] }
  app.post('/api/accounts/upload-replace', auth, (req, res) => {
    const { accounts } = req.body;
    if (!Array.isArray(accounts) || !accounts.length)
      return res.status(400).json({ error: 'accounts[] required' });

    // Wipe existing and replace with new list
    db.prepare('DELETE FROM accounts').run();

    let added = 0, skipped = 0;
    const seen = new Set();
    for (const acc of accounts) {
      try {
        const clean = (acc.username || acc.Username || '').replace('@', '').trim().toLowerCase();
        if (!clean || seen.has(clean)) { skipped++; continue; }
        seen.add(clean);
        if (added >= 100) { skipped++; continue; }
        const pwd = acc.password || acc.Password || acc.session_id || acc.Session_ID || '';
        const sid = acc.session_id || acc.Session_ID || '';
        const totp = acc.totp_secret || acc.TOTP_Secret || acc.totp || '';
        db.prepare('INSERT INTO accounts (id,username,session_id,password,daily_limit,notes,totp_secret) VALUES (?,?,?,?,?,?,?)')
          .run(uuidv4(), clean, sid, pwd, parseInt(acc.daily_limit || acc.Daily_Limit) || 50, acc.notes || acc.Notes || '', totp);
        added++;
      } catch { skipped++; }
    }
    res.json({ ok: true, added, skipped, total: added });
  });

  // ── Download blank template CSV ────────────────────────────────
  app.get('/api/accounts/template.csv', (_req, res) => {
    const csv = [
      'username,password,totp_secret,daily_limit,notes',
      'account1,YourPassword123,,50,Main account',
      'account2,YourPassword456,,50,Backup account',
      'account3,YourPassword789,JBSWY3DPEHPK3PXP,50,2FA enabled account',
    ].join('\n') + '\n';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="instraeach_template.csv"');
    res.send(csv);
  });

  // ── TOTP verify ───────────────────────────────────────────────
  app.post('/api/totp/verify', auth, (req, res) => {
    const { totp_secret } = req.body;
    if (!totp_secret) return res.status(400).json({ ok: false, error: 'totp_secret required' });
    const { spawn } = require('child_process');
    const path = require('path');
    const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
    const py = spawn(pyCmd, [path.join(__dirname, '..', 'lib', 'ig_bridge.py')], { timeout: 10000 });
    let out = '';
    py.stdout.on('data', d => out += d);
    py.on('close', () => {
      try {
        const lines = out.trim().split('\n').filter(l => l.startsWith('{'));
        res.json(JSON.parse(lines[lines.length - 1]));
      } catch { res.json({ ok: false, error: 'Bridge error' }); }
    });
    py.on('error', err => res.json({ ok: false, error: err.message }));
    py.stdin.write(JSON.stringify({ cmd: 'verify_totp', totp_secret }));
    py.stdin.end();
  });


  // ── Campaigns ─────────────────────────────────────────────────
  app.get('/api/campaigns', auth, (_req, res) => {
    const rows = db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all();
    rows.forEach(r => { try { r.keywords = JSON.parse(r.keywords); } catch { r.keywords = []; } });
    res.json(rows);
  });

  app.post('/api/campaigns', auth, (req, res) => {
    const {
      name, parent_category, sub_category = '', location = 'India',
      keywords = [], message, max_targets = 500, dms_per_account = 5,
      image_b64 = '', image_ext = 'jpg',
    } = req.body;
    if (!name || !parent_category || !message)
      return res.status(400).json({ error: 'name, parent_category, message required' });
    const id = uuidv4();
    db.prepare(`INSERT INTO campaigns
      (id,name,parent_category,sub_category,location,keywords,message,max_targets,dms_per_account,status,image_b64,image_ext)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, name, parent_category, sub_category, location, JSON.stringify(keywords), message, max_targets, Math.min(dms_per_account, 20), 'pending', image_b64, image_ext);
    res.json({ id, name });
  });

  app.delete('/api/campaigns/:id', auth, (req, res) => {
    db.prepare('DELETE FROM campaigns WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  });

  // ── Engine ────────────────────────────────────────────────────
  app.get('/api/engine/status', auth, (_req, res) => {
    res.json({ running: engine.isRunning() });
  });

  app.post('/api/campaigns/:id/start', auth, (req, res) => {
    if (engine.isRunning()) return res.status(409).json({ error: 'Engine already running' });
    const total = db.prepare('SELECT COUNT(*) AS c FROM accounts').get().c;
    if (!total) return res.status(400).json({ error: 'No accounts loaded' });
    res.json({ ok: true, started: true });
    // Non-blocking
    engine.runCampaign(req.params.id).catch(e => {
      engine.addLog(`Fatal: ${e.message}`, req.params.id, null, 'error');
    });
  });

  app.post('/api/engine/stop', auth, (_req, res) => {
    engine.stop();
    res.json({ ok: true });
  });

  app.get('/api/engine/logs', auth, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '100'), 500);
    const camp  = req.query.campaign_id;
    let rows;
    if (camp) {
      rows = db.prepare('SELECT * FROM logs WHERE campaign_id=? ORDER BY id DESC LIMIT ?').all(camp, limit);
    } else {
      rows = db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(limit);
    }
    res.json(rows.reverse());
  });

  // ── Sent DMs ──────────────────────────────────────────────────
  app.get('/api/sent', auth, (req, res) => {
    const { account, campaign, search } = req.query;
    const limit = Math.min(parseInt(req.query.limit || '200'), 1000);
    let q = 'SELECT * FROM dm_sent WHERE 1=1';
    const params = [];
    if (account)  { q += ' AND from_account_id=?'; params.push(account); }
    if (campaign) { q += ' AND campaign_id=?';      params.push(campaign); }
    if (search)   { q += ' AND (to_username LIKE ? OR message LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    q += ' ORDER BY id DESC LIMIT ?'; params.push(limit);
    res.json(db.prepare(q).all(...params));
  });

  // Dedup check
  app.get('/api/dedup', auth, (_req, res) => {
    const rows = db.prepare('SELECT DISTINCT to_username FROM dm_sent ORDER BY to_username').all();
    res.json({ count: rows.length, usernames: rows.map(r => r.to_username) });
  });

  // ── Inbox ─────────────────────────────────────────────────────
  app.get('/api/inbox', auth, (req, res) => {
    const { account, unread, search } = req.query;
    const limit = Math.min(parseInt(req.query.limit || '200'), 1000);
    let q = `
      SELECT i.*,
        d.from_username AS sent_via_username,
        d.from_account_id AS sent_via_account_id,
        d.message AS original_dm,
        d.campaign_id AS dm_campaign_id
      FROM inbox i
      LEFT JOIN dm_sent d ON d.to_username = i.from_username COLLATE NOCASE
      WHERE 1=1
    `;
    const params = [];
    if (account) { q += ' AND i.to_account_id=?'; params.push(account); }
    if (unread === 'true') { q += ' AND i.is_read=0'; }
    if (search)  { q += ' AND (i.from_username LIKE ? OR i.message LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    q += ' ORDER BY i.id DESC LIMIT ?'; params.push(limit);

    const rows = db.prepare(q).all(...params);
    // Attach replies
    rows.forEach(row => {
      row.replies = db.prepare('SELECT * FROM replies WHERE inbox_id=? ORDER BY id ASC').all(row.id);
    });
    res.json(rows);
  });

  // Add incoming message (webhook or manual)
  app.post('/api/inbox', (req, res) => {
    const { from_username, to_account_id, to_username, message, campaign_id } = req.body;
    if (!from_username || !message) return res.status(400).json({ error: 'from_username and message required' });
    db.prepare('INSERT INTO inbox (from_username,to_account_id,to_username,message,campaign_id) VALUES (?,?,?,?,?)')
      .run(from_username, to_account_id || '', to_username || '', message, campaign_id || '');
    res.json({ ok: true });
  });

  // Mark read
  app.patch('/api/inbox/:id/read', auth, (req, res) => {
    db.prepare('UPDATE inbox SET is_read=1 WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  });

  // Reply to inbox message (sends real DM via original account)
  app.post('/api/inbox/:id/reply', auth, async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });
    try {
      const result = await engine.sendReply(parseInt(req.params.id), message);
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ── Inbox polling: check all accounts for new replies ─────────
  app.post('/api/inbox/sync', auth, async (_req, res) => {
    const accounts = db.prepare('SELECT id FROM accounts').all();
    res.json({ ok: true, accounts: accounts.length, message: 'Sync started in background' });
    for (const acc of accounts) {
      try { await engine.checkInbox(acc.id); } catch {}
    }
  });

  // ── Categories list ───────────────────────────────────────────
  app.get('/api/categories', (_req, res) => {
    res.json(Object.keys(engine.CATEGORY_KEYWORDS).map(k => ({
      id: k, label: k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      keywords: engine.CATEGORY_KEYWORDS[k],
    })));
  });

  // ── Ping ─────────────────────────────────────────────────────
  app.get('/ping', (req, res) => {
    db.prepare('INSERT INTO ping_log (ip) VALUES (?)').run(req.ip);
    res.json({ ok: true, ts: new Date().toISOString() });
  });

  app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

  // ── Reset ─────────────────────────────────────────────────────
  app.post('/api/reset/sent', auth, (_req, res) => {
    db.prepare('DELETE FROM dm_sent').run();
    db.prepare('UPDATE accounts SET dms_today=0,dms_total=0').run();
    res.json({ ok: true });
  });

  // ── Start server ──────────────────────────────────────────────
  app.listen(PORT, () => {
    console.log(`[InstaReach v2] Server → http://localhost:${PORT}`);
    console.log(`[InstaReach v2] Ping   → http://localhost:${PORT}/ping`);
  });

}).catch(err => {
  console.error('[InstaReach v2] Boot failed:', err);
  process.exit(1);
});

module.exports = app;// api/server.js — InstaReach v2 API
require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const path     = require('path');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');
const { initDb }     = require('../lib/db');
const engine         = require('../lib/dmEngine');

const app        = express();
const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || process.env.ADMIN_PASSWORD || 'instraeach_v2_secret';

app.use(cors());
app.use(express.json({ limit: '20mb' }));

// ── Serve frontend ────────────────────────────────────────────────
const publicDir = path.join(__dirname, '..', 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}
// Catch-all: serve index.html for any non-API route
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path === '/ping' || req.path === '/health') return next();
  const indexFile = path.join(__dirname, '..', 'public', 'index.html');
  if (fs.existsSync(indexFile)) {
    res.sendFile(indexFile);
  } else {
    res.status(404).send('index.html not found');
  }
});

// ── Auth ──────────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ── Boot ──────────────────────────────────────────────────────────
initDb().then(db => {
  engine.setDb(db);

  // Seed admin
  const existing = db.prepare('SELECT id FROM admins WHERE username=?').get(process.env.ADMIN_USERNAME || 'admin');
  if (!existing) {
    const hash = require('bcryptjs').hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10);
    db.prepare('INSERT INTO admins (username,password) VALUES (?,?)').run(process.env.ADMIN_USERNAME || 'admin', hash);
    console.log('[InstaReach v2] Admin seeded');
  }

  // ── Auth routes ───────────────────────────────────────────────
  app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const admin = db.prepare('SELECT * FROM admins WHERE username=?').get(username);
    if (!admin || !bcrypt.compareSync(password, admin.password))
      return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: admin.id, username: admin.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: admin.username });
  });

  // ── Stats ─────────────────────────────────────────────────────
  app.get('/api/stats', auth, (_req, res) => {
    const totalAccounts   = db.prepare('SELECT COUNT(*) AS c FROM accounts').get().c;
    const totalSent       = db.prepare('SELECT COUNT(*) AS c FROM dm_sent').get().c;
    const totalInbox      = db.prepare('SELECT COUNT(*) AS c FROM inbox').get().c;
    const unread          = db.prepare('SELECT COUNT(*) AS c FROM inbox WHERE is_read=0').get().c;
    const activeCampaigns = db.prepare("SELECT COUNT(*) AS c FROM campaigns WHERE status='running'").get().c;
    res.json({ totalAccounts, totalSent, totalInbox, unread, activeCampaigns });
  });

  // ── Accounts ──────────────────────────────────────────────────
  app.get('/api/accounts', auth, (_req, res) => {
    const rows = db.prepare('SELECT * FROM accounts ORDER BY created_at DESC').all();
    res.json(rows);
  });

  app.post('/api/accounts', auth, (req, res) => {
    const { username, session_id = '', password = '', daily_limit = 50, notes = '', totp_secret = '' } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });
    const clean = username.replace('@', '').trim();
    const existing = db.prepare('SELECT id FROM accounts WHERE username=?').get(clean);
    if (existing) return res.status(400).json({ error: 'Account already exists' });
    const total = db.prepare('SELECT COUNT(*) AS c FROM accounts').get().c;
    if (total >= 100) return res.status(400).json({ error: 'Max 100 accounts reached' });
    const id = uuidv4();
    db.prepare('INSERT INTO accounts (id,username,session_id,password,daily_limit,notes,totp_secret) VALUES (?,?,?,?,?,?,?)').run(id, clean, session_id, password || session_id, daily_limit, notes, totp_secret);
    res.json({ id, username: clean });
  });

  app.post('/api/accounts/bulk', auth, (req, res) => {
    const { accounts } = req.body;
    if (!Array.isArray(accounts)) return res.status(400).json({ error: 'accounts[] required' });
    let added = 0, skipped = 0;
    for (const acc of accounts) {
      try {
        const total = db.prepare('SELECT COUNT(*) AS c FROM accounts').get().c;
        if (total >= 100) break;
        const clean = (acc.username || '').replace('@', '').trim();
        if (!clean) { skipped++; continue; }
        const exists = db.prepare('SELECT id FROM accounts WHERE username=?').get(clean);
        if (exists) { skipped++; continue; }
        db.prepare('INSERT INTO accounts (id,username,session_id,password,daily_limit,notes) VALUES (?,?,?,?,?,?)')
          .run(uuidv4(), clean, acc.session_id || '', acc.password || acc.session_id || '', acc.daily_limit || 50, acc.notes || '');
        added++;
      } catch { skipped++; }
    }
    res.json({ added, skipped });
  });

  app.put('/api/accounts/:id', auth, (req, res) => {
    const { session_id, daily_limit, notes } = req.body;
    const fields = [], vals = [];
    if (session_id  !== undefined) { fields.push('session_id=?');  vals.push(session_id); }
    if (daily_limit !== undefined) { fields.push('daily_limit=?'); vals.push(daily_limit); }
    if (notes       !== undefined) { fields.push('notes=?');       vals.push(notes); }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id);
    db.prepare(`UPDATE accounts SET ${fields.join(',')} WHERE id=?`).run(...vals);
    res.json({ ok: true });
  });

  app.delete('/api/accounts/:id', auth, (req, res) => {
    db.prepare('DELETE FROM accounts WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  });

  app.delete('/api/accounts', auth, (_req, res) => {
    db.prepare('DELETE FROM accounts').run();
    res.json({ ok: true });
  });

  // Reset daily DM count
  app.post('/api/accounts/reset-daily', auth, (_req, res) => {
    db.prepare('UPDATE accounts SET dms_today=0').run();
    res.json({ ok: true });
  });

  // ── Test login for a single account ──────────────────────────
  app.post('/api/accounts/test-login', auth, async (req, res) => {
    const { account_id } = req.body;
    if (!account_id) return res.status(400).json({ ok: false, error: 'account_id required' });
    const acc = db.prepare('SELECT * FROM accounts WHERE id=?').get(account_id);
    if (!acc) return res.status(404).json({ ok: false, error: 'Account not found' });
    try {
      const result = await engine.testLogin(acc);
      // Update account status in db
      db.prepare("UPDATE accounts SET status=? WHERE id=?").run(result.ok ? 'idle' : 'error', acc.id);
      res.json(result);
    } catch(e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ── Upload Excel / CSV → replace ALL accounts ─────────────────
  // Receives parsed JSON from the frontend (SheetJS parses xlsx client-side)
  // POST /api/accounts/upload-replace  { accounts: [{username, session_id, daily_limit, notes}] }
  app.post('/api/accounts/upload-replace', auth, (req, res) => {
    const { accounts } = req.body;
    if (!Array.isArray(accounts) || !accounts.length)
      return res.status(400).json({ error: 'accounts[] required' });

    // Wipe existing and replace with new list
    db.prepare('DELETE FROM accounts').run();

    let added = 0, skipped = 0;
    const seen = new Set();
    for (const acc of accounts) {
      try {
        const clean = (acc.username || acc.Username || '').replace('@', '').trim().toLowerCase();
        if (!clean || seen.has(clean)) { skipped++; continue; }
        seen.add(clean);
        if (added >= 100) { skipped++; continue; }
        const pwd = acc.password || acc.Password || acc.session_id || acc.Session_ID || '';
        const sid = acc.session_id || acc.Session_ID || '';
        const totp = acc.totp_secret || acc.TOTP_Secret || acc.totp || '';
        db.prepare('INSERT INTO accounts (id,username,session_id,password,daily_limit,notes,totp_secret) VALUES (?,?,?,?,?,?,?)')
          .run(uuidv4(), clean, sid, pwd, parseInt(acc.daily_limit || acc.Daily_Limit) || 50, acc.notes || acc.Notes || '', totp);
        added++;
      } catch { skipped++; }
    }
    res.json({ ok: true, added, skipped, total: added });
  });

  // ── Download blank template CSV ────────────────────────────────
  app.get('/api/accounts/template.csv', (_req, res) => {
    const csv = [
      'username,password,totp_secret,daily_limit,notes',
      'account1,YourPassword123,,50,Main account',
      'account2,YourPassword456,,50,Backup account',
      'account3,YourPassword789,JBSWY3DPEHPK3PXP,50,2FA enabled account',
    ].join('\n') + '\n';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="instraeach_template.csv"');
    res.send(csv);
  });

  // ── TOTP verify ───────────────────────────────────────────────
  app.post('/api/totp/verify', auth, (req, res) => {
    const { totp_secret } = req.body;
    if (!totp_secret) return res.status(400).json({ ok: false, error: 'totp_secret required' });
    const { spawn } = require('child_process');
    const path = require('path');
    const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
    const py = spawn(pyCmd, [path.join(__dirname, '..', 'lib', 'ig_bridge.py')], { timeout: 10000 });
    let out = '';
    py.stdout.on('data', d => out += d);
    py.on('close', () => {
      try {
        const lines = out.trim().split('\n').filter(l => l.startsWith('{'));
        res.json(JSON.parse(lines[lines.length - 1]));
      } catch { res.json({ ok: false, error: 'Bridge error' }); }
    });
    py.on('error', err => res.json({ ok: false, error: err.message }));
    py.stdin.write(JSON.stringify({ cmd: 'verify_totp', totp_secret }));
    py.stdin.end();
  });


  // ── Campaigns ─────────────────────────────────────────────────
  app.get('/api/campaigns', auth, (_req, res) => {
    const rows = db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all();
    rows.forEach(r => { try { r.keywords = JSON.parse(r.keywords); } catch { r.keywords = []; } });
    res.json(rows);
  });

  app.post('/api/campaigns', auth, (req, res) => {
    const {
      name, parent_category, sub_category = '', location = 'India',
      keywords = [], message, max_targets = 500, dms_per_account = 5,
      image_b64 = '', image_ext = 'jpg',
    } = req.body;
    if (!name || !parent_category || !message)
      return res.status(400).json({ error: 'name, parent_category, message required' });
    const id = uuidv4();
    db.prepare(`INSERT INTO campaigns
      (id,name,parent_category,sub_category,location,keywords,message,max_targets,dms_per_account,status,image_b64,image_ext)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, name, parent_category, sub_category, location, JSON.stringify(keywords), message, max_targets, Math.min(dms_per_account, 20), 'pending', image_b64, image_ext);
    res.json({ id, name });
  });

  app.delete('/api/campaigns/:id', auth, (req, res) => {
    db.prepare('DELETE FROM campaigns WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  });

  // ── Engine ────────────────────────────────────────────────────
  app.get('/api/engine/status', auth, (_req, res) => {
    res.json({ running: engine.isRunning() });
  });

  app.post('/api/campaigns/:id/start', auth, (req, res) => {
    if (engine.isRunning()) return res.status(409).json({ error: 'Engine already running' });
    const total = db.prepare('SELECT COUNT(*) AS c FROM accounts').get().c;
    if (!total) return res.status(400).json({ error: 'No accounts loaded' });
    res.json({ ok: true, started: true });
    // Non-blocking
    engine.runCampaign(req.params.id).catch(e => {
      engine.addLog(`Fatal: ${e.message}`, req.params.id, null, 'error');
    });
  });

  app.post('/api/engine/stop', auth, (_req, res) => {
    engine.stop();
    res.json({ ok: true });
  });

  app.get('/api/engine/logs', auth, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '100'), 500);
    const camp  = req.query.campaign_id;
    let rows;
    if (camp) {
      rows = db.prepare('SELECT * FROM logs WHERE campaign_id=? ORDER BY id DESC LIMIT ?').all(camp, limit);
    } else {
      rows = db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(limit);
    }
    res.json(rows.reverse());
  });

  // ── Sent DMs ──────────────────────────────────────────────────
  app.get('/api/sent', auth, (req, res) => {
    const { account, campaign, search } = req.query;
    const limit = Math.min(parseInt(req.query.limit || '200'), 1000);
    let q = 'SELECT * FROM dm_sent WHERE 1=1';
    const params = [];
    if (account)  { q += ' AND from_account_id=?'; params.push(account); }
    if (campaign) { q += ' AND campaign_id=?';      params.push(campaign); }
    if (search)   { q += ' AND (to_username LIKE ? OR message LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    q += ' ORDER BY id DESC LIMIT ?'; params.push(limit);
    res.json(db.prepare(q).all(...params));
  });

  // Dedup check
  app.get('/api/dedup', auth, (_req, res) => {
    const rows = db.prepare('SELECT DISTINCT to_username FROM dm_sent ORDER BY to_username').all();
    res.json({ count: rows.length, usernames: rows.map(r => r.to_username) });
  });

  // ── Inbox ─────────────────────────────────────────────────────
  app.get('/api/inbox', auth, (req, res) => {
    const { account, unread, search } = req.query;
    const limit = Math.min(parseInt(req.query.limit || '200'), 1000);
    let q = `
      SELECT i.*,
        d.from_username AS sent_via_username,
        d.from_account_id AS sent_via_account_id,
        d.message AS original_dm,
        d.campaign_id AS dm_campaign_id
      FROM inbox i
      LEFT JOIN dm_sent d ON d.to_username = i.from_username COLLATE NOCASE
      WHERE 1=1
    `;
    const params = [];
    if (account) { q += ' AND i.to_account_id=?'; params.push(account); }
    if (unread === 'true') { q += ' AND i.is_read=0'; }
    if (search)  { q += ' AND (i.from_username LIKE ? OR i.message LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    q += ' ORDER BY i.id DESC LIMIT ?'; params.push(limit);

    const rows = db.prepare(q).all(...params);
    // Attach replies
    rows.forEach(row => {
      row.replies = db.prepare('SELECT * FROM replies WHERE inbox_id=? ORDER BY id ASC').all(row.id);
    });
    res.json(rows);
  });

  // Add incoming message (webhook or manual)
  app.post('/api/inbox', (req, res) => {
    const { from_username, to_account_id, to_username, message, campaign_id } = req.body;
    if (!from_username || !message) return res.status(400).json({ error: 'from_username and message required' });
    db.prepare('INSERT INTO inbox (from_username,to_account_id,to_username,message,campaign_id) VALUES (?,?,?,?,?)')
      .run(from_username, to_account_id || '', to_username || '', message, campaign_id || '');
    res.json({ ok: true });
  });

  // Mark read
  app.patch('/api/inbox/:id/read', auth, (req, res) => {
    db.prepare('UPDATE inbox SET is_read=1 WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  });

  // Reply to inbox message (sends real DM via original account)
  app.post('/api/inbox/:id/reply', auth, async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });
    try {
      const result = await engine.sendReply(parseInt(req.params.id), message);
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ── Inbox polling: check all accounts for new replies ─────────
  app.post('/api/inbox/sync', auth, async (_req, res) => {
    const accounts = db.prepare('SELECT id FROM accounts').all();
    res.json({ ok: true, accounts: accounts.length, message: 'Sync started in background' });
    for (const acc of accounts) {
      try { await engine.checkInbox(acc.id); } catch {}
    }
  });

  // ── Categories list ───────────────────────────────────────────
  app.get('/api/categories', (_req, res) => {
    res.json(Object.keys(engine.CATEGORY_KEYWORDS).map(k => ({
      id: k, label: k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      keywords: engine.CATEGORY_KEYWORDS[k],
    })));
  });

  // ── Ping ─────────────────────────────────────────────────────
  app.get('/ping', (req, res) => {
    db.prepare('INSERT INTO ping_log (ip) VALUES (?)').run(req.ip);
    res.json({ ok: true, ts: new Date().toISOString() });
  });

  app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

  // ── Reset ─────────────────────────────────────────────────────
  app.post('/api/reset/sent', auth, (_req, res) => {
    db.prepare('DELETE FROM dm_sent').run();
    db.prepare('UPDATE accounts SET dms_today=0,dms_total=0').run();
    res.json({ ok: true });
  });

  // ── Start server ──────────────────────────────────────────────
  app.listen(PORT, () => {
    console.log(`[InstaReach v2] Server → http://localhost:${PORT}`);
    console.log(`[InstaReach v2] Ping   → http://localhost:${PORT}/ping`);
  });

}).catch(err => {
  console.error('[InstaReach v2] Boot failed:', err);
  process.exit(1);
});

module.exports = app;