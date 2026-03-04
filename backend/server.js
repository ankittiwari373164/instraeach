// server.js — InstaReach Backend API
require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { initDb } = require('./db');
const { spawn, execSync }  = require('child_process');
const path     = require('path');
const fs       = require('fs');

// ── Install Python deps into vendor dir ──────────────────────
const VENDOR_DIR = path.join(__dirname, 'vendor');
if (!fs.existsSync(VENDOR_DIR)) fs.mkdirSync(VENDOR_DIR, { recursive: true });
try {
  execSync('python3 -c "import sys; sys.path.insert(0,process.env.VENDOR_DIR||"./vendor"); import instagrapi"', { stdio: 'ignore', env: { ...process.env, VENDOR_DIR } });
  console.log('[InstaReach] Python instagrapi already installed');
} catch {
  console.log('[InstaReach] Installing Python dependencies to vendor/...');
  try {
    execSync('pip3 install instagrapi==2.1.3 requests Pillow --quiet --target=' + VENDOR_DIR, { stdio: 'inherit', timeout: 180000 });
    console.log('[InstaReach] Python dependencies installed');
  } catch(e) {
    console.warn('[InstaReach] pip3 install failed:', e.message);
  }
}
const https    = require('https');

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


  // ── Auto-seed account from env vars (survives deploys) ────────
  const SEED_SESSION    = process.env.SESSION_ID || '';
  const SEED_ACCOUNT_ID = process.env.ACCOUNT_ID || '';
  const SEED_IG_USER    = process.env.IG_USERNAME || 'manofox_official';
  if (SEED_SESSION && SEED_ACCOUNT_ID) {
    const existingAcc = db.prepare('SELECT id FROM accounts WHERE id = ?').get(SEED_ACCOUNT_ID);
    if (!existingAcc) {
      db.prepare('INSERT OR IGNORE INTO accounts (id, username, session_id, status, dms_today, dms_total) VALUES (?,?,?,?,?,?)').run(SEED_ACCOUNT_ID, SEED_IG_USER, SEED_SESSION, 'idle', 0, 0);
      console.log('[InstaReach] Auto-seeded account:', SEED_IG_USER);
    } else {
      db.prepare('UPDATE accounts SET session_id=?, username=? WHERE id=?').run(SEED_SESSION, SEED_IG_USER, SEED_ACCOUNT_ID);
      console.log('[InstaReach] Account session synced:', SEED_IG_USER);
    }
  }
  // ── Auto-seed campaign from env vars ─────────────────────────
  const SEED_CAMPAIGN_ID = process.env.CAMPAIGN_ID || '';
  const SEED_CAMPAIGN_NAME = process.env.CAMPAIGN_NAME || 'Main Campaign';
  const SEED_MESSAGE = process.env.DM_MESSAGE || 'Hi {{username}}! I am {{sender}}, a real estate consultant in Delhi. Are you looking to buy or sell property?';
  if (SEED_CAMPAIGN_ID && SEED_ACCOUNT_ID && SEED_SESSION) {
    const existingCamp = db.prepare('SELECT id FROM campaigns WHERE id=?').get(SEED_CAMPAIGN_ID);
    if (!existingCamp) {
      db.prepare('INSERT OR IGNORE INTO campaigns (id,account_id,name,message,status,dms_sent,max_dms,cooldown_ms,location,parent_category,sub_category) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(SEED_CAMPAIGN_ID, SEED_ACCOUNT_ID, SEED_CAMPAIGN_NAME, SEED_MESSAGE, 'stopped', 0, 100, 15000, 'Delhi', 'real_estate', 'Residential');
      console.log('[InstaReach] Auto-seeded campaign:', SEED_CAMPAIGN_NAME);
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
  // BOT CONTROL — Pure Node.js, Instagram API, no Python/browser
  // ══════════════════════════════════════════════════════════════

  // ── Instagram API helpers ──────────────────────────────────────
  function igGet(path, sessionId) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'i.instagram.com',
        path: path,
        method: 'GET',
        headers: {
          'User-Agent': 'Instagram 269.0.0.18.75 Android (26/8.0.0; 480dpi; 1080x1920; OnePlus; ONEPLUS A3003; OnePlus3; qcom; en_IN; 314665256)',
          'X-IG-App-ID': '567067343352427',
          'Accept': '*/*',
          'Accept-Language': 'en-IN',
          'Cookie': 'sessionid=' + sessionId,
        }
      };
      const req = https.request(options, res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  function igPost(path, sessionId, params) {
    return new Promise((resolve, reject) => {
      const postData = Object.entries(params)
        .map(([k,v]) => encodeURIComponent(k) + '=' + encodeURIComponent(typeof v === 'object' ? JSON.stringify(v) : String(v)))
        .join('&');
      const options = {
        hostname: 'i.instagram.com',
        path: path,
        method: 'POST',
        headers: {
          'User-Agent': 'Instagram 269.0.0.18.75 Android (26/8.0.0; 480dpi; 1080x1920; OnePlus; ONEPLUS A3003; OnePlus3; qcom; en_IN; 314665256)',
          'X-IG-App-ID': '567067343352427',
          'Accept': '*/*',
          'Accept-Language': 'en-IN',
          'Cookie': 'sessionid=' + sessionId,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData),
        }
      };
      const req = https.request(options, res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  async function igSearchUsers(sessionId, query) {
    try {
      const r = await igGet('/api/v1/users/search/?q=' + encodeURIComponent(query) + '&count=15', sessionId);
      if (r.body && r.body.users) return r.body.users.map(u => u.username).filter(Boolean);
      if (r.status === 401) throw new Error('Session expired (401)');
    } catch(e) { console.log('[Bot] Search error:', e.message); }
    return [];
  }

  async function igGetUserId(sessionId, username) {
    try {
      const r = await igGet('/api/v1/users/' + username + '/usernameinfo/', sessionId);
      if (r.body && r.body.user) return String(r.body.user.pk || r.body.user.id);
    } catch {}
    return null;
  }

  async function igSendDM(sessionId, userId, message) {
    try {
      const r = await igPost('/api/v1/direct_v2/threads/broadcast/text/', sessionId, {
        recipient_users: '[[' + userId + ']]',
        client_context: Date.now().toString(),
        thread_ids: '[]',
        text: message,
      });
      console.log('[Bot] DM status:', r.status, JSON.stringify(r.body).slice(0,100));
      return r.status === 200;
    } catch(e) {
      console.log('[Bot] DM error:', e.message);
      return false;
    }
  }

  // ── Bot state ─────────────────────────────────────────────────
  let _botRunning  = false;
  let _botStop     = false;
  let _botCampaign = null;

  function botLog(msg, level, account_id, campaign_id, username) {
    const ts = new Date().toISOString();
    console.log('[Bot]', (level||'info').toUpperCase(), msg);
    if (!global._pyLogs) global._pyLogs = [];
    global._pyLogs.push({ ts, msg: (level === 'error' ? 'ERR: ' : level === 'success' ? 'OK: ' : '') + msg });
    if (global._pyLogs.length > 300) global._pyLogs.shift();
    try {
      db.prepare('INSERT INTO logs (account_id,campaign_id,level,message,username) VALUES (?,?,?,?,?)')
        .run(account_id || null, campaign_id || null, level || 'info', msg, username || null);
    } catch {}
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function runBot(campaign, sessionId) {
    _botRunning  = true;
    _botStop     = false;
    _botCampaign = campaign.id;
    const account_id  = campaign.account_id;
    const campaign_id = campaign.id;
    const L = (m, l, u) => botLog(m, l || 'info', account_id, campaign_id, u);

    L('Bot started: ' + campaign.name);
    L('Session: ' + sessionId.slice(0,15) + '...');

    try {
      // Verify session works
      const me = await igGet('/api/v1/accounts/current_user/', sessionId);
      if (me.status === 401 || me.status === 403) {
        L('Session expired! Status: ' + me.status + ' — update SESSION_ID in Render env vars', 'error');
        return;
      }
      const igUsername = me.body?.user?.username || 'unknown';
      L('Logged in as: @' + igUsername);

      // Parse keywords
      let keywords = [];
      try { keywords = typeof campaign.keywords === 'string' ? JSON.parse(campaign.keywords) : (campaign.keywords || []); } catch {}
      const EXTRA = ['real estate agent delhi','property dealer delhi','delhi property','realestate delhi','property consultant delhi','buy flat delhi','homes delhi','flats delhi'];
      const allKw = [...new Set([...keywords, ...EXTRA])];
      L('Keywords to search: ' + allKw.length);

      // Load processed
      const proc = db.prepare('SELECT target_username FROM processed_accounts WHERE account_id=? AND dm_sent=1').all(account_id);
      const done = new Set(proc.map(r => r.target_username));
      L('Already DMed: ' + done.size);

      // Search targets
      const targets = [];
      for (const kw of allKw) {
        if (_botStop) break;
        const found = await igSearchUsers(sessionId, kw);
        const fresh = found.filter(u => !done.has(u) && !targets.includes(u));
        if (fresh.length) L('"'+ kw +'" -> ' + fresh.length + ' new targets');
        targets.push(...fresh);
        await sleep(1500 + Math.floor(Math.random()*1500));
        if (targets.length >= 80) break;
      }

      L('Total targets: ' + targets.length);
      if (!targets.length) { L('No new targets found', 'warn'); return; }

      const maxDms   = campaign.max_dms || 50;
      const cooldown = Math.max(15000, campaign.cooldown_ms || 15000);
      let dmCount    = 0;

      L('Starting DMs — max ' + maxDms);

      for (const username of targets) {
        if (_botStop)          { L('Stopped by user', 'warn'); break; }
        if (dmCount >= maxDms) { L('Max DMs reached: ' + maxDms, 'warn'); break; }

        const row = db.prepare('SELECT status FROM campaigns WHERE id=?').get(campaign_id);
        if (row?.status !== 'running') { L('Campaign stopped from dashboard', 'warn'); break; }
        if (done.has(username)) continue;

        // Build message
        let msg = (campaign.message || 'Hi!')
          .replace(/\{\{username\}\}/g, username)
          .replace(/\{\{sender\}\}/g, '@' + (campaign.account_username || ''))
          .replace(/\{\{category\}\}/g, campaign.parent_category || '');

        // Groq enhance
        try {
          const enhanced = await groqEnhance(msg, { category: campaign.parent_category, location: campaign.location });
          if (enhanced?.enhanced) msg = enhanced.enhanced;
        } catch {}

        L('Sending to @' + username, 'info', username);

        const uid = await igGetUserId(sessionId, username);
        if (!uid) {
          L('User not found: @' + username, 'warn', username);
          done.add(username);
          await sleep(3000);
          continue;
        }

        const sent = await igSendDM(sessionId, uid, msg);
        done.add(username);

        try {
          db.prepare('INSERT OR IGNORE INTO processed_accounts (account_id,target_username,source,dm_sent,dm_sent_at) VALUES (?,?,?,?,?)')
            .run(account_id, username, 'bot', sent ? 1 : 0, sent ? new Date().toISOString() : null);
          if (sent) {
            db.prepare('UPDATE accounts SET dms_today=dms_today+1,dms_total=dms_total+1,last_active=? WHERE id=?').run(new Date().toISOString(), account_id);
            db.prepare('UPDATE campaigns SET dms_sent=dms_sent+1 WHERE id=?').run(campaign_id);
            dmCount++;
            L('Sent to @' + username, 'success', username);
          } else {
            L('DM failed: @' + username, 'warn', username);
          }
        } catch {}

        const wait = cooldown + Math.floor(Math.random() * 10000);
        L('Waiting ' + Math.round(wait/1000) + 's (' + dmCount + '/' + maxDms + ' sent)');
        await sleep(wait);
      }

      L('Session complete! ' + dmCount + ' DMs sent', 'success');

    } catch(e) {
      L('Bot error: ' + e.message, 'error');
      console.error('[Bot] Stack:', e.stack);
    } finally {
      _botRunning  = false;
      _botStop     = false;
      _botCampaign = null;
      try {
        const s = db.prepare('SELECT status FROM campaigns WHERE id=?').get(campaign_id);
        if (s?.status === 'running') {
          db.prepare("UPDATE campaigns SET status='done',finished_at=? WHERE id=?").run(new Date().toISOString(), campaign_id);
        }
      } catch {}
    }
  }

  // ── Bot API endpoints ─────────────────────────────────────────
  app.post('/api/pybot/start', auth, (req, res) => {
    console.log('[Bot] /api/pybot/start called | body:', JSON.stringify(req.body), '| _botRunning:', _botRunning);
    if (_botRunning) { console.log('[Bot] Already running, rejecting'); return res.status(409).json({ error: 'Bot already running' }); }

    const { campaign_id, account_id } = req.body;
    if (!campaign_id || !account_id) return res.status(400).json({ error: 'campaign_id and account_id required' });

    const acc = db.prepare('SELECT * FROM accounts WHERE id=?').get(account_id);
    if (!acc) return res.status(404).json({ error: 'Account not found' });

    const sessionId = acc.session_id || process.env.SESSION_ID || '';
    if (!sessionId) return res.status(400).json({ error: 'No session_id — add it in Accounts tab' });

    const campaign = db.prepare('SELECT * FROM campaigns WHERE id=?').get(campaign_id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const now = new Date().toISOString();
    db.prepare("UPDATE campaigns SET status='stopped',finished_at=? WHERE account_id=? AND id!=? AND status IN ('running','pending')").run(now, account_id, campaign_id);
    db.prepare("UPDATE campaigns SET status='running',started_at=? WHERE id=?").run(now, campaign_id);

    console.log('[Bot] Starting for campaign:', campaign.name, '| account:', acc.username, '| session:', sessionId.slice(0,15)+'...');

    runBot({ ...campaign, account_username: acc.username }, sessionId)
      .catch(e => console.error('[Bot] Uncaught:', e.message));

    res.json({ ok: true, message: 'Bot started!' });
  });

  app.post('/api/pybot/stop', auth, (req, res) => {
    _botStop = true;
    if (_botCampaign) {
      db.prepare("UPDATE campaigns SET status='stopped',finished_at=? WHERE id=?").run(new Date().toISOString(), _botCampaign);
    }
    res.json({ ok: true, message: 'Stop signal sent' });
  });

  app.get('/api/pybot/logs', auth, (req, res) => {
    res.json(global._pyLogs || []);
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