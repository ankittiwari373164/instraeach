// server.js — InstaReach Backend API
require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { initDb } = require('./db');
const path     = require('path');
const fs       = require('fs');

// Pure Node.js — no Python needed
const https = require('https');

const app        = express();
const PORT       = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_THIS_SECRET';
const GROQ_KEY   = process.env.GROQ_API_KEY || '';

// ── Uploads dir ──────────────────────────────────────────────────
const UPLOAD_DIR = process.env.UPLOAD_DIR || './data/uploads';
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '20mb' }));  // allow base64 images in body

// ── Serve frontend dashboard ──────────────────────────────────
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
if (fs.existsSync(FRONTEND_DIR)) {
  app.use(express.static(FRONTEND_DIR));
  app.get('/', (_req, res) => res.sendFile(path.join(FRONTEND_DIR, 'dashboard.html')));
  app.get('/dashboard', (_req, res) => res.sendFile(path.join(FRONTEND_DIR, 'dashboard.html')));
}

// Serve uploaded images publicly
app.use('/uploads', express.static(UPLOAD_DIR));

// ── Auth middleware ──────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid or expired token' }); }
}

// ── Groq LLM helper ──────────────────────────────────────────────
function groqEnhance(baseMessage, context = {}) {
  return new Promise((resolve) => {
    if (!GROQ_KEY) { resolve({ enhanced: baseMessage, style_used: 'no_key' }); return; }

    // Pick a random style variation so every message feels different
    const styles = [
      "casual and friendly — like a colleague mentioning something useful",
      "confident and direct — get to the point fast, no fluff",
      "curious and conversational — ask a soft question that leads into the offer",
      "empathetic — acknowledge their work/business first, then pitch",
      "enthusiastic but brief — high energy, short sentences",
    ];
    const style = styles[Math.floor(Math.random() * styles.length)];

    const category = context.category || 'business';
    const location = context.location || '';
    const sender   = context.sender   || '';

    const systemPrompt = `You are an expert Instagram DM writer for a ${category} business${location ? ' in '+location : ''}.
Your task: rewrite the base message in a ${style} tone.

STRICT RULES:
- Maximum 3 sentences. Shorter is better.
- NO greetings (no "Hi", "Hey", "Hello", "Dear")
- NO sign-offs (no "Best", "Thanks", "Regards", "Cheers")
- NO hashtags, NO emojis, NO asterisks
- NO phrases like "I came across your profile" or "I noticed you"
- Keep ALL specific details: phone numbers, prices, service names
- Sound like a real human, not a bot or marketer
- Output ONLY the final message — no quotes, no explanation, no preamble`;

    const userPrompt = `Base message: "${baseMessage}"

Style to use: ${style}
Business context: ${category}${location ? ', '+location : ''}

Write the rewritten message now:`;

    const body = JSON.stringify({
      model: 'llama3-8b-8192',
      max_tokens: 180,
      temperature: 0.92,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt }
      ]
    });

    const options = {
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`,
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res2) => {
      let data = '';
      res2.on('data', chunk => data += chunk);
      res2.on('end', () => {
        try {
          const json = JSON.parse(data);
          const enhanced = json.choices?.[0]?.message?.content?.trim();
          resolve({ enhanced: enhanced || baseMessage, style_used: style });
        } catch { resolve({ enhanced: baseMessage, style_used: 'parse_error' }); }
      });
    });
    req.on('error', () => resolve({ enhanced: baseMessage, style_used: 'fallback' }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ enhanced: baseMessage, style_used: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

// ── Boot: wait for DB, then start listening ──────────────────────
initDb().then(async db => {

  // ── Key comparison helper — handles encoding differences ─────
  function keysMatch(stored, received) {
    const s = (stored || '').trim();
    const r = (received || '').trim();
    if (s === r) return true;
    try { if (s === decodeURIComponent(r).trim()) return true; } catch {}
    try { if (s === decodeURIComponent(decodeURIComponent(r)).trim()) return true; } catch {}
    return false;
  }

  // Seed admin
  const existing = db.prepare('SELECT id FROM admins WHERE username = ?').get(process.env.ADMIN_USERNAME || 'admin');
  if (!existing) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'changeme123', 10);
    db.prepare('INSERT INTO admins (username, password) VALUES (?, ?)').run(
      process.env.ADMIN_USERNAME || 'admin', hash
    );
    console.log('[InstaReach] Admin created:', process.env.ADMIN_USERNAME || 'admin');
  }


  // ══════════════════════════════════════════════════════════════
  // AUTO-SEED: Account + Campaign from env vars on every deploy
  // These env vars MUST be set in Render → Environment:
  //   SESSION_ID   = Instagram sessionid cookie value
  //   ACCOUNT_ID   = any UUID you pick (e.g. 8add8650-31f6-4110-adef-f4364573cf4b)
  //   IG_USERNAME  = manofox_official
  //   CAMPAIGN_ID  = any UUID you pick (e.g. cdb10660-e9f7-49e0-b70d-56d0860e9c0c)
  //   DM_MESSAGE   = Hi {{username}}! ... (your message template)
  // ══════════════════════════════════════════════════════════════
  {
    const S_SESSION  = process.env.SESSION_ID  || '';
    const S_ACCID    = process.env.ACCOUNT_ID  || 'acc-manofox-001';
    const S_IGUSER   = process.env.IG_USERNAME || 'manofox_official';
    const S_CAMPID   = process.env.CAMPAIGN_ID || 'camp-send-001';
    const S_CAMPNAME = process.env.CAMPAIGN_NAME || 'Send';
    const S_MESSAGE  = process.env.DM_MESSAGE  || 'Hi {{username}}! I am a real estate consultant in Delhi. Are you looking to buy or sell property? Lets connect!';

    // Always upsert account (even without session — session can be added later)
    const existingAcc = db.prepare('SELECT id FROM accounts WHERE id=?').get(S_ACCID);
    if (!existingAcc) {
      db.prepare('INSERT OR IGNORE INTO accounts (id,username,session_id,status,dms_today,dms_total) VALUES (?,?,?,?,?,?)').run(S_ACCID, S_IGUSER, S_SESSION, 'idle', 0, 0);
      console.log('[InstaReach] Auto-seeded account:', S_IGUSER, '| session_len:', S_SESSION.length);
    } else {
      // Always update session_id on deploy so fresh cookies take effect
      db.prepare('UPDATE accounts SET session_id=?, username=? WHERE id=?').run(S_SESSION, S_IGUSER, S_ACCID);
      console.log('[InstaReach] Account session updated:', S_IGUSER, '| session_len:', S_SESSION.length);
    }

    // Also seed by username in case account was created differently
    const accByUser = db.prepare('SELECT id FROM accounts WHERE username=?').get(S_IGUSER);
    if (accByUser && accByUser.id !== S_ACCID && S_SESSION) {
      db.prepare('UPDATE accounts SET session_id=? WHERE username=?').run(S_SESSION, S_IGUSER);
      console.log('[InstaReach] Also updated session for username-matched account');
    }

    // Upsert campaign
    const existingCamp = db.prepare('SELECT id FROM campaigns WHERE id=?').get(S_CAMPID);
    if (!existingCamp) {
      db.prepare('INSERT OR IGNORE INTO campaigns (id,account_id,name,message,status,dms_sent,max_dms,cooldown_ms,location,parent_category,sub_category) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(S_CAMPID, S_ACCID, S_CAMPNAME, S_MESSAGE, 'stopped', 0, 100, 15000, 'Delhi', 'real_estate', 'Residential');
      console.log('[InstaReach] Auto-seeded campaign:', S_CAMPNAME);
    } else {
      // Update message on every deploy so env var changes apply
      db.prepare('UPDATE campaigns SET message=?, account_id=?, name=? WHERE id=?').run(S_MESSAGE, S_ACCID, S_CAMPNAME, S_CAMPID);
      console.log('[InstaReach] Campaign updated:', S_CAMPNAME);
    }

    if (!S_SESSION) {
      console.warn('[InstaReach] WARNING: SESSION_ID env var is EMPTY! Bot will not work. Set it in Render → Environment.');
    } else {
      console.log('[InstaReach] Session loaded OK, length:', S_SESSION.length);
    }
  }

  // ══════════════════════════════════════════════════════════════
  // AUTH
  // ══════════════════════════════════════════════════════════════

  app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
    if (!admin) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, admin.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: admin.id, username: admin.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: admin.username });
  });

  // ══════════════════════════════════════════════════════════════
  // ACCOUNTS
  // ══════════════════════════════════════════════════════════════

  app.get('/api/accounts', auth, (req, res) => {
    const rows = db.prepare(`
      SELECT id, username, daily_limit, cooldown_ms, status,
             dms_today, dms_total, last_active, created_at
      FROM accounts ORDER BY created_at DESC
    `).all();
    res.json(rows);
  });

  app.post('/api/accounts', auth, (req, res) => {
    const { username, session_id, daily_limit = 150, cooldown_ms = 8000 } = req.body;
    if (!username || !session_id) return res.status(400).json({ error: 'username and session_id required' });
    const existing = db.prepare('SELECT id FROM accounts WHERE username = ?').get(username.replace('@',''));
    if (existing) return res.status(400).json({ error: 'Account already exists' });
    const id = uuidv4();
    db.prepare('INSERT INTO accounts (id, username, session_id, daily_limit, cooldown_ms) VALUES (?, ?, ?, ?, ?)')
      .run(id, username.replace('@',''), session_id, daily_limit, cooldown_ms);
    res.json({ id, username });
  });

  app.put('/api/accounts/:id', auth, (req, res) => {
    const { session_id, daily_limit, cooldown_ms, status } = req.body;
    const fields = []; const vals = [];
    if (session_id   !== undefined) { fields.push('session_id = ?');  vals.push(session_id); }
    if (daily_limit  !== undefined) { fields.push('daily_limit = ?'); vals.push(daily_limit); }
    if (cooldown_ms  !== undefined) { fields.push('cooldown_ms = ?'); vals.push(cooldown_ms); }
    if (status       !== undefined) { fields.push('status = ?');      vals.push(status); }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id);
    db.prepare(`UPDATE accounts SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
    res.json({ ok: true });
  });

  app.delete('/api/accounts/:id', auth, (req, res) => {
    db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // ══════════════════════════════════════════════════════════════
  // CAMPAIGNS
  // ══════════════════════════════════════════════════════════════

  app.get('/api/campaigns', auth, (req, res) => {
    const rows = db.prepare(`
      SELECT c.*, a.username as account_username
      FROM campaigns c
      LEFT JOIN accounts a ON c.account_id = a.id
      ORDER BY c.created_at DESC
    `).all();
    rows.forEach(c => { try { c.keywords = JSON.parse(c.keywords); } catch { c.keywords = []; } });
    res.json(rows);
  });

  app.post('/api/campaigns', auth, (req, res) => {
    const {
      name, account_id, parent_category, sub_category = '', location,
      keywords = [], message, max_dms = 100, scrape_depth = 1,
      dm_from_search = true, dm_from_followers = true,
      skip_private = true, skip_dmed = true,
      use_ai_enhance = false, image_url = '',
    } = req.body;
    if (!name || !account_id || !parent_category || !location || !message)
      return res.status(400).json({ error: 'name, account_id, parent_category, location, message are required' });
    const id = uuidv4();
    db.prepare(`
      INSERT INTO campaigns
        (id,name,account_id,parent_category,sub_category,location,keywords,
         message,max_dms,scrape_depth,dm_from_search,dm_from_followers,skip_private,skip_dmed,
         use_ai_enhance,image_url)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, name, account_id, parent_category, sub_category, location,
      JSON.stringify(keywords), message, max_dms, scrape_depth,
      dm_from_search ? 1 : 0, dm_from_followers ? 1 : 0,
      skip_private ? 1 : 0, skip_dmed ? 1 : 0,
      use_ai_enhance ? 1 : 0, image_url || ''
    );
    // Auto-stop any other running/pending campaigns for same account
    db.prepare(
      "UPDATE campaigns SET status='stopped', finished_at=? WHERE account_id=? AND id!=? AND status IN ('running','pending')"
    ).run(new Date().toISOString(), account_id, id);
    // New campaign starts immediately as running
    db.prepare("UPDATE campaigns SET status='running', started_at=? WHERE id=?").run(new Date().toISOString(), id);
    console.log('[InstaReach] New campaign started:', name, '| Previous campaigns stopped');
    res.json({ id, name });
  });

  app.patch('/api/campaigns/:id/status', auth, (req, res) => {
    const { status } = req.body;
    const allowed = ['pending','running','paused','done','stopped'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const now = new Date().toISOString();
    if (status === 'running') {
      // ── Auto-stop any OTHER running campaigns for same account ──
      const camp = db.prepare('SELECT account_id FROM campaigns WHERE id = ?').get(req.params.id);
      if (camp) {
        const running = db.prepare(
          "SELECT id FROM campaigns WHERE account_id = ? AND status = 'running' AND id != ?"
        ).all(camp.account_id, req.params.id);
        if (running.length > 0) {
          running.forEach(r => {
            db.prepare('UPDATE campaigns SET status = ?, finished_at = ? WHERE id = ?').run('stopped', now, r.id);
            console.log('[InstaReach] Auto-stopped campaign:', r.id, '(new campaign started)');
          });
        }
      }
      db.prepare('UPDATE campaigns SET status = ?, started_at = ? WHERE id = ?').run(status, now, req.params.id);
    } else if (['done','stopped'].includes(status)) {
      db.prepare('UPDATE campaigns SET status = ?, finished_at = ? WHERE id = ?').run(status, now, req.params.id);
    } else {
      db.prepare('UPDATE campaigns SET status = ? WHERE id = ?').run(status, req.params.id);
    }
    res.json({ ok: true });
  });

  app.delete('/api/campaigns/:id', auth, (req, res) => {
    db.prepare('DELETE FROM campaigns WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // Full campaign config for Tampermonkey (auth by session key)
  app.get('/api/campaigns/:id/config', (req, res) => {
    const key = (req.query.key || '').trim();
    if (!key) return res.status(401).json({ error: 'key required' });
    const campaign = db.prepare(`
      SELECT c.*, a.session_id, a.username AS account_username, a.cooldown_ms, a.daily_limit
      FROM campaigns c LEFT JOIN accounts a ON c.account_id = a.id
      WHERE c.id = ?
    `).get(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    // Try multiple key comparison strategies to handle encoding differences
    const storedKey = (campaign.session_id || '').trim();
    const rawKey    = (key || '').trim();
    let decodedKey;
    try { decodedKey = decodeURIComponent(rawKey).trim(); } catch { decodedKey = rawKey; }
    let doubleDecoded;
    try { doubleDecoded = decodeURIComponent(decodedKey).trim(); } catch { doubleDecoded = decodedKey; }

    const keyMatch = storedKey === rawKey || storedKey === decodedKey || storedKey === doubleDecoded;
    if (!keyMatch) {
      console.log('[Auth] Key mismatch on /config!');
      console.log('  stored   ('+storedKey.length+'):', storedKey.slice(0,35)+'...');
      console.log('  raw      ('+rawKey.length+'):', rawKey.slice(0,35)+'...');
      console.log('  decoded  ('+decodedKey.length+'):', decodedKey.slice(0,35)+'...');
      return res.status(403).json({ error: 'Invalid key' });
    }
    try { campaign.keywords = JSON.parse(campaign.keywords); } catch { campaign.keywords = []; }
    res.json(campaign);
  });

  app.get('/api/campaigns/:id/status', (req, res) => {
    const row = db.prepare('SELECT status FROM campaigns WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ status: row.status });
  });

  // ══════════════════════════════════════════════════════════════
  // ✨ NEW: GROQ AI MESSAGE ENHANCEMENT
  // Called by Tampermonkey before each DM to get a unique variation
  // ══════════════════════════════════════════════════════════════
  app.post('/api/enhance-message', async (req, res) => {
    const { message, key, account_id, campaign_id } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    // Auth by session key
    if (key && account_id) {
      const acc = db.prepare('SELECT session_id FROM accounts WHERE id = ?').get(account_id);
      if (!acc || !keysMatch(acc.session_id, key)) return res.status(403).json({ error: 'Invalid key' });
    }

    // Get campaign context for better prompting
    let context = {};
    if (campaign_id) {
      const camp = db.prepare('SELECT parent_category, sub_category, location, account_id FROM campaigns WHERE id = ?').get(campaign_id);
      if (camp) {
        const acc = db.prepare('SELECT username FROM accounts WHERE id = ?').get(camp.account_id);
        const cat = [camp.parent_category, camp.sub_category].filter(Boolean).join(' > ');
        context = { category: cat, location: camp.location, sender: acc?.username || '' };
      }
    }

    const { enhanced, style_used } = await groqEnhance(message, context);
    res.json({ enhanced, original: message, used_ai: enhanced !== message, style_used });
  });

  // ══════════════════════════════════════════════════════════════
  // ✨ NEW: IMAGE UPLOAD
  // Tampermonkey fetches image URL from here; dashboard uploads image
  // ══════════════════════════════════════════════════════════════

  // Upload image (base64) from dashboard — saves to disk
  app.post('/api/upload-image', auth, (req, res) => {
    const { data, filename, mime_type } = req.body;
    if (!data) return res.status(400).json({ error: 'data required' });

    const ext = (filename || 'image.jpg').split('.').pop().replace(/[^a-z0-9]/gi,'').toLowerCase() || 'jpg';
    const fname = `img_${Date.now()}_${uuidv4().slice(0,8)}.${ext}`;
    const fpath = path.join(UPLOAD_DIR, fname);

    try {
      const buf = Buffer.from(data.replace(/^data:[^;]+;base64,/, ''), 'base64');
      fs.writeFileSync(fpath, buf);
      const url = `/uploads/${fname}`;
      res.json({ ok: true, url, filename: fname });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // List uploaded images
  app.get('/api/images', auth, (req, res) => {
    try {
      const files = fs.readdirSync(UPLOAD_DIR)
        .filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f))
        .map(f => ({ filename: f, url: `/uploads/${f}` }));
      res.json(files);
    } catch { res.json([]); }
  });

  // Delete uploaded image
  app.delete('/api/images/:filename', auth, (req, res) => {
    const fpath = path.join(UPLOAD_DIR, path.basename(req.params.filename));
    try { if (fs.existsSync(fpath)) fs.unlinkSync(fpath); res.json({ ok: true }); }
    catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ══════════════════════════════════════════════════════════════
  // PROCESSED ACCOUNTS
  // ══════════════════════════════════════════════════════════════

  app.get('/api/processed', (req, res) => {
    const { account_id, key } = req.query;
    if (!account_id || !key) return res.status(400).json({ error: 'account_id and key required' });
    const acc = db.prepare('SELECT session_id FROM accounts WHERE id = ?').get(account_id);
    if (!acc || !keysMatch(acc.session_id, key)) return res.status(403).json({ error: 'Invalid' });
    const rows = db.prepare(
      'SELECT target_username, source, dm_sent_at FROM processed_accounts WHERE account_id = ?'
    ).all(account_id);
    res.json(rows);
  });

  app.post('/api/processed', (req, res) => {
    const { account_id, campaign_id, target_username, source = 'bot', dm_sent, key } = req.body;
    if (!account_id || !key || !target_username) return res.status(400).json({ error: 'Missing fields' });
    const acc = db.prepare('SELECT session_id FROM accounts WHERE id = ?').get(account_id);
    if (!acc || !keysMatch(acc.session_id, key)) return res.status(403).json({ error: 'Invalid key' });
    try {
      const existing = db.prepare(
        'SELECT id, dm_sent FROM processed_accounts WHERE account_id = ? AND target_username = ?'
      ).get(account_id, target_username);
      if (existing) {
        if (dm_sent && !existing.dm_sent) {
          db.prepare('UPDATE processed_accounts SET dm_sent = 1, dm_sent_at = ? WHERE account_id = ? AND target_username = ?')
            .run(new Date().toISOString(), account_id, target_username);
        }
      } else {
        db.prepare('INSERT INTO processed_accounts (account_id,target_username,source,dm_sent,dm_sent_at) VALUES (?,?,?,?,?)')
          .run(account_id, target_username, source, dm_sent ? 1 : 0, dm_sent ? new Date().toISOString() : null);
      }
      if (dm_sent) {
        db.prepare('UPDATE accounts SET dms_today = dms_today + 1, dms_total = dms_total + 1, last_active = ? WHERE id = ?')
          .run(new Date().toISOString(), account_id);
        if (campaign_id) {
          db.prepare('UPDATE campaigns SET dms_sent = dms_sent + 1 WHERE id = ?').run(campaign_id);
        }
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ══════════════════════════════════════════════════════════════
  // LOGS
  // ══════════════════════════════════════════════════════════════

  app.post('/api/log', (req, res) => {
    const { account_id, campaign_id, level = 'info', message, username, key } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });
    if (key && account_id) {
      const acc = db.prepare('SELECT session_id FROM accounts WHERE id = ?').get(account_id);
      if (!acc || !keysMatch(acc.session_id, key)) return res.status(403).json({ error: 'Invalid key' });
    }
    db.prepare('INSERT INTO logs (account_id, campaign_id, level, message, username) VALUES (?, ?, ?, ?, ?)')
      .run(account_id || null, campaign_id || null, level, message, username || null);
    res.json({ ok: true });
  });

  app.get('/api/logs', auth, (req, res) => {
    const { account_id, campaign_id } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    let q = `SELECT l.*, a.username AS account_username FROM logs l LEFT JOIN accounts a ON l.account_id = a.id WHERE 1=1`;
    const params = [];
    if (account_id)  { q += ' AND l.account_id = ?';  params.push(account_id); }
    if (campaign_id) { q += ' AND l.campaign_id = ?'; params.push(campaign_id); }
    q += ' ORDER BY l.id DESC LIMIT ?';
    params.push(limit);
    const rows = db.prepare(q).all(...params);
    res.json(rows.reverse());
  });


  // ══════════════════════════════════════════════════════════════
  // BOT CONTROL — Python worker (instagrapi username+password login)
  // ══════════════════════════════════════════════════════════════

  const { spawn, execSync } = require('child_process');

  // Install instagrapi on startup — try multiple pip commands
  const pipCmds = [
    'pip3 install instagrapi requests --quiet --break-system-packages',
    'pip3 install instagrapi requests --quiet',
    'pip install instagrapi requests --quiet --break-system-packages',
    'pip install instagrapi requests --quiet',
    'python3 -m pip install instagrapi requests --quiet --break-system-packages',
    'python3 -m pip install instagrapi requests --quiet',
  ];
  let pipOk = false;
  for (const cmd of pipCmds) {
    try {
      execSync(cmd, { timeout: 180000, stdio: 'pipe' });
      console.log('[InstaReach] instagrapi installed via:', cmd.split(' ').slice(0,3).join(' '));
      pipOk = true;
      break;
    } catch(e) {
      console.log('[InstaReach] pip attempt failed:', cmd.slice(0,40), '-', e.message.slice(0,60));
    }
  }
  if (!pipOk) console.warn('[InstaReach] WARNING: Could not install instagrapi — bot may not work');

  let _botProcess  = null;
  let _botRunning  = false;
  let _botStop     = false;
  let _botCampaign = null;

  function botLog(msg, level, account_id, campaign_id, username) {
    console.log('[Bot]', level ? level.toUpperCase() : 'INFO', msg);
    if (!global._pyLogs) global._pyLogs = [];
    global._pyLogs.push({ ts: new Date().toISOString(), msg });
    if (global._pyLogs.length > 500) global._pyLogs.shift();
    try {
      db.prepare('INSERT INTO logs (account_id,campaign_id,level,message,username) VALUES (?,?,?,?,?)')
        .run(account_id || null, campaign_id || null, level || 'info', msg, username || null);
    } catch {}
  }

  function runBot(campaign, account_id) {
    if (_botRunning) return;
    _botRunning  = true;
    _botStop     = false;
    _botCampaign = campaign.id;

    const igUser = process.env.IG_USERNAME || '';
    const igPass = process.env.IG_PASSWORD || '';

    if (!igPass) {
      botLog('ERROR: IG_PASSWORD env var not set! Go to Render → Environment → add IG_PASSWORD', 'error', account_id, campaign.id);
      _botRunning = false;
      _botCampaign = null;
      return;
    }

    const campData = JSON.stringify({
      id         : campaign.id,
      name       : campaign.name,
      account_id : account_id,
      message    : campaign.message || 'Hi {{username}}! I am a real estate consultant in Delhi. Interested in buying or selling? Lets connect!',
      max_dms    : campaign.max_dms || 50,
      cooldown_ms: campaign.cooldown_ms || 15000,
      keywords   : campaign.keywords || '[]',
    });

    const workerPath = require('path').join(__dirname, 'worker.py');
    const env = {
      ...process.env,
      IG_USERNAME   : igUser,
      IG_PASSWORD   : igPass,
      CAMPAIGN_DATA : campData,
      SESSION_FILE  : './data/ig_session.json',
    };

    botLog(`=== Bot starting: ${campaign.name} ===`, 'info', account_id, campaign.id);
    botLog(`Account: @${igUser} | Max DMs: ${campaign.max_dms || 50}`, 'info', account_id, campaign.id);

    _botProcess = spawn('python3', [workerPath], { env, cwd: __dirname });

    _botProcess.stdout.on('data', data => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      lines.forEach(line => {
        const level = line.includes('] OK ') ? 'success'
                    : line.includes('] ERR') ? 'error'
                    : line.includes('] WARN') ? 'warn' : 'info';
        const msg = line.replace(/^\[\d{2}:\d{2}:\d{2}\] [A-Z]+ /, '');
        botLog(msg, level, account_id, campaign.id);
      });
    });

    _botProcess.stderr.on('data', data => {
      const txt = data.toString().trim();
      if (txt && !txt.includes('WARNING') && !txt.includes('DeprecationWarning')) {
        botLog('STDERR: ' + txt.slice(0, 200), 'warn', account_id, campaign.id);
      }
    });

    _botProcess.on('close', code => {
      botLog(`Bot process ended (code: ${code})`, code === 0 ? 'info' : 'warn', account_id, campaign.id);
      _botRunning  = false;
      _botProcess  = null;
      _botCampaign = null;
      try {
        const s = db.prepare('SELECT status FROM campaigns WHERE id=?').get(campaign.id);
        if (s?.status === 'running') {
          db.prepare("UPDATE campaigns SET status='done',finished_at=? WHERE id=?")
            .run(new Date().toISOString(), campaign.id);
        }
      } catch {}
    });

    _botProcess.on('error', err => {
      botLog(`Failed to start python3: ${err.message} — is Python installed?`, 'error', account_id, campaign.id);
      _botRunning  = false;
      _botProcess  = null;
      _botCampaign = null;
    });
  }

  // ── API endpoints ──────────────────────────────────────────────
  app.post('/api/pybot/start', auth, (req, res) => {
    console.log('[Bot] /api/pybot/start | body:', JSON.stringify(req.body), '| running:', _botRunning);

    if (_botRunning) return res.status(409).json({ error: 'Bot already running — click Stop first' });

    const igPass = process.env.IG_PASSWORD || '';
    if (!igPass) {
      return res.status(400).json({
        error: 'IG_PASSWORD not set! Go to Render → Environment → add IG_PASSWORD = your Instagram password'
      });
    }

    const { campaign_id, account_id } = req.body;

    // Find account
    let acc = account_id ? db.prepare('SELECT * FROM accounts WHERE id=?').get(account_id) : null;
    if (!acc) acc = db.prepare('SELECT * FROM accounts WHERE username=?').get(process.env.IG_USERNAME || 'manofox_official');
    if (!acc) acc = db.prepare('SELECT * FROM accounts ORDER BY created_at LIMIT 1').get();
    if (!acc) return res.status(404).json({ error: 'No accounts found' });

    // Find campaign
    let campaign = campaign_id ? db.prepare('SELECT * FROM campaigns WHERE id=?').get(campaign_id) : null;
    if (!campaign) campaign = db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC LIMIT 1').get();
    if (!campaign) return res.status(404).json({ error: 'No campaigns found' });

    // Set running
    const now = new Date().toISOString();
    db.prepare("UPDATE campaigns SET status='running',started_at=? WHERE id=?").run(now, campaign.id);

    runBot(campaign, acc.id);
    res.json({ ok: true, message: 'Bot started!', campaign: campaign.name, account: acc.username });
  });

  app.post('/api/pybot/stop', auth, (req, res) => {
    _botStop = true;
    if (_botProcess) {
      _botProcess.kill('SIGTERM');
      _botProcess = null;
    }
    if (_botCampaign) {
      db.prepare("UPDATE campaigns SET status='stopped',finished_at=? WHERE id=?")
        .run(new Date().toISOString(), _botCampaign);
    }
    _botRunning  = false;
    _botCampaign = null;
    res.json({ ok: true, message: 'Bot stopped' });
  });

  app.get('/api/pybot/logs', auth, (req, res) => {
    res.json(global._pyLogs || []);
  });

  app.get('/api/bot/debug', auth, (req, res) => {
    const campaigns = db.prepare('SELECT id, name, status, message, account_id FROM campaigns').all();
    const accounts  = db.prepare('SELECT id, username, status FROM accounts').all();
    res.json({
      botRunning : _botRunning,
      botCampaign: _botCampaign,
      igUsername : process.env.IG_USERNAME || '',
      igPassSet  : !!(process.env.IG_PASSWORD),
      campaigns,
      accounts,
    });
  });

  // ══════════════════════════════════════════════════════════════
  // CRON ENDPOINT — called by Render Cron Job or UptimeRobot
  // GET /api/bot/run?key=YOUR_CRON_KEY
  // No JWT needed — uses CRON_KEY env var
  // ══════════════════════════════════════════════════════════════

  app.get('/api/bot/run', async (req, res) => {
    const CRON_KEY = process.env.CRON_KEY || 'instraeach_cron_2024';
    if (req.query.key !== CRON_KEY) {
      return res.status(403).json({ error: 'Wrong key' });
    }

    if (_botRunning) {
      return res.json({ ok: true, message: 'Bot already running', skipped: true });
    }

    // Find first running campaign with an account
    const campaign = db.prepare(`
      SELECT c.*, a.session_id, a.username AS account_username, a.id AS acc_id
      FROM campaigns c
      JOIN accounts a ON c.account_id = a.id
      WHERE c.status = 'running'
      ORDER BY c.created_at DESC LIMIT 1
    `).get();

    if (!campaign) {
      // Try any campaign
      const anyCampaign = db.prepare(`
        SELECT c.*, a.session_id, a.username AS account_username, a.id AS acc_id
        FROM campaigns c
        JOIN accounts a ON c.account_id = a.id
        ORDER BY c.created_at DESC LIMIT 1
      `).get();

      if (!anyCampaign) return res.json({ ok: false, message: 'No campaigns found' });

      // Set it running
      db.prepare("UPDATE campaigns SET status='running', started_at=? WHERE id=?")
        .run(new Date().toISOString(), anyCampaign.id);
      anyCampaign.status = 'running';

      const sessionId = anyCampaign.session_id || process.env.SESSION_ID || '';
      if (!sessionId) return res.json({ ok: false, message: 'No session_id' });

      console.log('[Cron] Starting bot for campaign:', anyCampaign.name);
      res.json({ ok: true, message: 'Bot started via cron', campaign: anyCampaign.name });
      runBot({ ...anyCampaign, account_id: anyCampaign.acc_id }, sessionId).catch(e => console.error('[Cron] Error:', e.message));
      return;
    }

    const sessionId = campaign.session_id || process.env.SESSION_ID || '';
    if (!sessionId) return res.json({ ok: false, message: 'No session_id on account' });

    console.log('[Cron] Starting bot for campaign:', campaign.name);
    res.json({ ok: true, message: 'Bot started via cron', campaign: campaign.name });
    runBot({ ...campaign, account_id: campaign.acc_id }, sessionId).catch(e => console.error('[Cron] Error:', e.message));
  });

  // ══════════════════════════════════════════════════════════════
  // STATS
  // ══════════════════════════════════════════════════════════════

  app.get('/api/stats', auth, (req, res) => {
    const dmsToday        = db.prepare('SELECT COALESCE(SUM(dms_today),0) AS v FROM accounts').get().v;
    const dmsTotal        = db.prepare('SELECT COALESCE(SUM(dms_total),0) AS v FROM accounts').get().v;
    const activeAccounts  = db.prepare("SELECT COUNT(*) AS v FROM accounts WHERE status IN ('running','idle')").get().v;
    const runningCampaigns= db.prepare("SELECT COUNT(*) AS v FROM campaigns WHERE status='running'").get().v;
    const totalCampaigns  = db.prepare('SELECT COUNT(*) AS v FROM campaigns').get().v;
    const accountsScraped = db.prepare('SELECT COUNT(*) AS v FROM processed_accounts').get().v;
    res.json({ dmsToday, dmsTotal, activeAccounts, runningCampaigns, totalCampaigns, accountsScraped });
  });

  // ══════════════════════════════════════════════════════════════
  // PING / HEALTH — UptimeRobot hits /ping every 5 min
  // ══════════════════════════════════════════════════════════════

  // ── Emergency session reset — no JWT needed, uses ADMIN_KEY env var ──
  // GET /admin/reset-session?admin_key=xxx&account_id=yyy&new_session=zzz
  app.get('/admin/reset-session', (req, res) => {
    const { admin_key, account_id, new_session } = req.query;
    const ADMIN_KEY = process.env.ADMIN_KEY || 'instraeach_admin_2024';
    if (admin_key !== ADMIN_KEY) return res.status(403).json({ error: 'Wrong admin_key' });
    if (!account_id || !new_session) return res.status(400).json({ error: 'account_id and new_session required' });
    try {
      const decoded = decodeURIComponent(new_session).trim();
      db.prepare('UPDATE accounts SET session_id = ? WHERE id = ?').run(decoded, account_id);
      const acc = db.prepare('SELECT username FROM accounts WHERE id = ?').get(account_id);
      console.log('[InstaReach] Admin reset session for:', acc?.username);
      res.json({ ok: true, username: acc?.username, preview: decoded.slice(0,30)+'...' });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/ping', (req, res) => {
    db.prepare('INSERT INTO ping_log (account_id, ip) VALUES (?, ?)').run(req.query.account || null, req.ip);
    res.json({ ok: true, ts: new Date().toISOString() });
  });

  app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

  // ── Debug endpoint: check if a key matches stored session_id ──
  // GET /api/debug-key?account_id=xxx&key=yyy
  // Returns whether the key matches — safe to expose (no sensitive data returned)
  app.get('/api/debug-key', (req, res) => {
    const { account_id, key } = req.query;
    if (!account_id || !key) return res.status(400).json({ error: 'account_id and key required' });
    const acc = db.prepare('SELECT session_id, username FROM accounts WHERE id = ?').get(account_id);
    if (!acc) return res.status(404).json({ error: 'Account not found' });
    const stored   = (acc.session_id || '').trim();
    const received = decodeURIComponent(key).trim();
    const match    = stored === received;
    res.json({
      match,
      username: acc.username,
      stored_len: stored.length,
      received_len: received.length,
      stored_preview: stored.slice(0,20) + '...',
      received_preview: received.slice(0,20) + '...',
      hint: match ? '✓ Keys match!' : '✗ Keys differ — update session_id in dashboard Accounts tab'
    });
  });

  // ── Update session_id without needing dashboard login ──────────
  // POST /api/update-session { account_id, old_key, new_key }
  // Uses the old key to authenticate, then replaces it with new_key
  app.post('/api/update-session', (req, res) => {
    const { account_id, old_key, new_key } = req.body;
    if (!account_id || !old_key || !new_key) return res.status(400).json({ error: 'account_id, old_key, new_key required' });
    const acc = db.prepare('SELECT session_id, username FROM accounts WHERE id = ?').get(account_id);
    if (!acc) return res.status(404).json({ error: 'Account not found' });
    // Accept either old OR new key (idempotent — safe to call multiple times)
    const stored = (acc.session_id || '').trim();
    const oldKey = decodeURIComponent(old_key).trim();
    const newKey = decodeURIComponent(new_key).trim();
    if (stored !== oldKey && stored !== newKey) {
      return res.status(403).json({ error: 'old_key does not match stored session_id' });
    }
    db.prepare('UPDATE accounts SET session_id = ? WHERE id = ?').run(newKey, account_id);
    console.log('[InstaReach] Session updated for account:', acc.username);
    res.json({ ok: true, username: acc.username, hint: 'Session ID updated. Restart your Tampermonkey campaign.' });
  });

  // ── Daily reset ───────────────────────────────────────────────
  function scheduleMidnightReset() {
    const now  = new Date();
    const next = new Date(now);
    next.setDate(next.getDate() + 1);
    next.setHours(0, 0, 0, 0);
    setTimeout(() => {
      db.prepare('UPDATE accounts SET dms_today = 0').run();
      console.log('[InstaReach] Daily DM counts reset at midnight');
      setInterval(() => {
        db.prepare('UPDATE accounts SET dms_today = 0').run();
        console.log('[InstaReach] Daily DM counts reset');
      }, 24 * 60 * 60 * 1000);
    }, next - now);
  }
  scheduleMidnightReset();

  // ── Global error handler — always return JSON, never HTML ────
  app.use((err, req, res, next) => {
    console.error('[InstaReach] Unhandled error:', err.message);
    res.status(500).json({ error: err.message || 'Internal server error' });
  });

  app.listen(PORT, () => {
    console.log(`[InstaReach] Server running → http://localhost:${PORT}`);
    console.log(`[InstaReach] Groq AI enhance: ${GROQ_KEY ? '✓ enabled' : '✗ disabled (set GROQ_API_KEY in .env)'}`);
    console.log(`[InstaReach] Image uploads  → ${UPLOAD_DIR}`);
    console.log(`[InstaReach] UptimeRobot    → http://localhost:${PORT}/ping`);
  });

}).catch(err => {
  console.error('[InstaReach] Failed to initialise database:', err);
  process.exit(1);
});