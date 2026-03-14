// server.js — InstaReach Playwright Backend API
// All Python removed — bot runs via Playwright worker.js (pure Node.js)
require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { initDb } = require('./db');
const path     = require('path');
const fs       = require('fs');
const https    = require('https');
const { fork } = require('child_process');

const app        = express();
const PORT       = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || process.env.ADMIN_PASSWORD || 'instraeach_default_secret_2024';
const GROQ_KEY   = process.env.GROQ_API_KEY || '';

// ── Uploads dir ──────────────────────────────────────────────────────
const UPLOAD_DIR = process.env.UPLOAD_DIR || './data/uploads';
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '20mb' }));

// ── Serve frontend ────────────────────────────────────────────────
const FRONTEND_DIR = path.join(__dirname, 'frontend');
if (fs.existsSync(FRONTEND_DIR)) {
  app.use(express.static(FRONTEND_DIR));
  app.get('/',          (_req, res) => res.sendFile(path.join(FRONTEND_DIR, 'dashboard.html')));
  app.get('/dashboard', (_req, res) => res.sendFile(path.join(FRONTEND_DIR, 'dashboard.html')));
}
app.use('/uploads', express.static(UPLOAD_DIR));

// ── Auth middleware ──────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid or expired token' }); }
}

// ── Groq LLM helper ──────────────────────────────────────────────────
function groqEnhance(baseMessage, context = {}) {
  return new Promise((resolve) => {
    if (!GROQ_KEY) { resolve({ enhanced: baseMessage, style_used: 'no_key' }); return; }
    const styles = [
      'casual and friendly',
      'confident and direct',
      'curious and conversational',
      'empathetic',
      'enthusiastic but brief',
    ];
    const style    = styles[Math.floor(Math.random() * styles.length)];
    const category = context.category || 'business';
    const location = context.location || '';

    const systemPrompt = `You are an Instagram DM writer for a ${category} business${location ? ' in '+location : ''}.
Rewrite the message in a ${style} tone.
RULES: Max 3 sentences. No Hi/Hey/Hello. No sign-offs. No hashtags/emojis/asterisks. Output ONLY the message.`;

    const body = JSON.stringify({
      model: 'llama3-8b-8192', max_tokens: 180, temperature: 0.92,
      messages: [
        { role:'system', content: systemPrompt },
        { role:'user',   content: `Base: "${baseMessage}"\nRewrite now:` }
      ]
    });

    const req2 = https.request({
      hostname: 'api.groq.com', path: '/openai/v1/chat/completions', method: 'POST',
      headers: {
        'Content-Type':'application/json',
        'Authorization':`Bearer ${GROQ_KEY}`,
        'Content-Length': Buffer.byteLength(body)
      }
    }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try {
          const j = JSON.parse(d);
          resolve({ enhanced: j.choices?.[0]?.message?.content?.trim() || baseMessage, style_used: style });
        } catch { resolve({ enhanced: baseMessage, style_used: 'parse_error' }); }
      });
    });
    req2.on('error', () => resolve({ enhanced: baseMessage, style_used: 'fallback' }));
    req2.setTimeout(8000, () => { req2.destroy(); resolve({ enhanced: baseMessage, style_used: 'timeout' }); });
    req2.write(body); req2.end();
  });
}

// ── Bot state ─────────────────────────────────────────────────────────
let _botProcess  = null;
let _botRunning  = false;
let _botStop     = false;
let _botCampaign = null;
if (!global._pwLogs) global._pwLogs = [];

function botLog(msg, level, account_id, campaign_id, db) {
  console.log('[Bot]', (level||'info').toUpperCase(), msg);
  global._pwLogs.push({ ts: new Date().toISOString(), msg, level: level || 'info' });
  if (global._pwLogs.length > 500) global._pwLogs.shift();
  if (db) {
    try { db.prepare('INSERT INTO logs (account_id,campaign_id,level,message) VALUES (?,?,?,?)').run(account_id||null, campaign_id||null, level||'info', msg); } catch {}
  }
}

// ── Keys match helper ─────────────────────────────────────────────────
function keysMatch(stored, received) {
  const s = (stored  || '').trim();
  const r = (received|| '').trim();
  if (s === r) return true;
  try { if (s === decodeURIComponent(r).trim()) return true; } catch {}
  try { if (s === decodeURIComponent(decodeURIComponent(r)).trim()) return true; } catch {}
  return false;
}

// ── Run Bot using worker.js (Playwright) ─────────────────────────────
function runBot(campaign, account_id, db) {
  if (_botRunning) return;
  _botRunning  = true;
  _botStop     = false;
  _botCampaign = campaign.id;

  const igUser = process.env.IG_USERNAME || '';
  const igPass = process.env.IG_PASSWORD || '';

  if (!igPass) {
    botLog('ERROR: IG_PASSWORD not set! Set it in environment variables.', 'error', account_id, campaign.id, db);
    _botRunning = false; _botCampaign = null;
    return;
  }

  const campData = JSON.stringify({
    id         : campaign.id,
    name       : campaign.name,
    account_id : account_id,
    message    : campaign.message || 'Hi {{username}}! I am a real estate consultant in Delhi. Interested? Lets connect!',
    max_dms    : campaign.max_dms || 15,
    cooldown_ms: campaign.cooldown_ms || 15000,
    keywords   : campaign.keywords || '[]',
  });

  const env = {
    ...process.env,
    IG_USERNAME   : igUser,
    IG_PASSWORD   : igPass,
    CAMPAIGN_DATA : campData,
    SESSION_FILE  : './data/pw_session.json',
    HEADLESS      : process.env.HEADLESS || 'true',
  };

  botLog(`=== Playwright Bot starting: ${campaign.name} ===`, 'info', account_id, campaign.id, db);
  botLog(`Account: @${igUser} | Max DMs: ${campaign.max_dms || 15}`, 'info', account_id, campaign.id, db);

  const workerPath = path.join(__dirname, 'worker.js');
  _botProcess = fork(workerPath, [], { env, silent: true });

  _botProcess.stdout.on('data', data => {
    const lines = data.toString().split('\n').filter(l => l.trim());
    lines.forEach(line => {
      const level = line.includes('] OK ')   ? 'success'
                  : line.includes('] ERR')   ? 'error'
                  : line.includes('] WARN')  ? 'warn' : 'info';
      const msg = line.replace(/^\[\d{2}:\d{2}:\d{2}\] [A-Z]+ /, '');
      botLog(msg, level, account_id, campaign.id, db);
      if (line.includes('DM sent ->')) {
        try { db.prepare('UPDATE campaigns SET dms_sent = COALESCE(dms_sent,0) + 1 WHERE id=?').run(campaign.id); } catch {}
      }
    });
  });

  _botProcess.stderr.on('data', data => {
    const txt = data.toString().trim();
    if (txt && !txt.includes('DeprecationWarning') && !txt.includes('ExperimentalWarning')) {
      botLog('STDERR: ' + txt.slice(0, 200), 'warn', account_id, campaign.id, db);
    }
  });

  // IPC messages from worker.js
  _botProcess.on('message', ({ type, level, msg }) => {
    if (type === 'log') botLog(msg, level, account_id, campaign.id, db);
  });

  _botProcess.on('close', code => {
    botLog(`Bot ended (exit: ${code})`, code === 0 ? 'info' : 'warn', account_id, campaign.id, db);
    _botRunning = false; _botProcess = null; _botCampaign = null;
    try {
      const s = db.prepare('SELECT status FROM campaigns WHERE id=?').get(campaign.id);
      if (s?.status === 'running') {
        db.prepare("UPDATE campaigns SET status='done',finished_at=? WHERE id=?").run(new Date().toISOString(), campaign.id);
      }
    } catch {}
  });

  _botProcess.on('error', err => {
    botLog(`Failed to start worker: ${err.message}`, 'error', account_id, campaign.id, db);
    _botRunning = false; _botProcess = null; _botCampaign = null;
  });
}

// ── DB init and routes ────────────────────────────────────────────────
initDb().then(async db => {

  // ── Seed admin ──────────────────────────────────────────────────
  const existing = db.prepare('SELECT id FROM admins WHERE username = ?').get(process.env.ADMIN_USERNAME || 'admin');
  if (!existing) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'changeme123', 10);
    db.prepare('INSERT INTO admins (username,password) VALUES (?,?)').run(process.env.ADMIN_USERNAME||'admin', hash);
    console.log('[InstaReach] Admin created:', process.env.ADMIN_USERNAME || 'admin');
  }

  // ── Auto-seed account + campaign from env ───────────────────────
  {
    const S_SESSION  = process.env.SESSION_ID   || '';
    const S_ACCID    = process.env.ACCOUNT_ID   || 'acc-playwright-001';
    const S_IGUSER   = process.env.IG_USERNAME  || '';
    const S_CAMPID   = process.env.CAMPAIGN_ID  || 'camp-playwright-001';
    const S_CAMPNAME = process.env.CAMPAIGN_NAME|| 'Send';
    const S_MESSAGE  = process.env.DM_MESSAGE   || 'Hi {{username}}! I am a real estate consultant in Delhi. Interested? Lets connect!';

    if (S_IGUSER) {
      const existingAcc = db.prepare('SELECT id FROM accounts WHERE id=?').get(S_ACCID);
      if (!existingAcc) {
        db.prepare('INSERT OR IGNORE INTO accounts (id,username,session_id,status,dms_today,dms_total) VALUES (?,?,?,?,?,?)').run(S_ACCID, S_IGUSER, S_SESSION, 'idle', 0, 0);
      } else {
        db.prepare('UPDATE accounts SET session_id=?,username=? WHERE id=?').run(S_SESSION, S_IGUSER, S_ACCID);
      }

      const existingCamp = db.prepare('SELECT id FROM campaigns WHERE id=?').get(S_CAMPID);
      if (!existingCamp) {
        db.prepare('INSERT OR IGNORE INTO campaigns (id,account_id,name,message,status,dms_sent,max_dms,cooldown_ms,location,parent_category,sub_category) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(S_CAMPID, S_ACCID, S_CAMPNAME, S_MESSAGE, 'stopped', 0, 100, 15000, 'Delhi', 'real_estate', 'Residential');
      } else {
        db.prepare('UPDATE campaigns SET message=?,account_id=?,name=? WHERE id=?').run(S_MESSAGE, S_ACCID, S_CAMPNAME, S_CAMPID);
      }
      console.log('[InstaReach] Account seeded:', S_IGUSER);
    }
  }

  // ════════════════════════════════════════════════════════════════
  // AUTH
  // ════════════════════════════════════════════════════════════════
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

  // ════════════════════════════════════════════════════════════════
  // ACCOUNTS
  // ════════════════════════════════════════════════════════════════
  app.get('/api/accounts', auth, (req, res) => {
    const rows = db.prepare('SELECT id,username,daily_limit,cooldown_ms,status,dms_today,dms_total,last_active,created_at FROM accounts ORDER BY created_at DESC').all();
    res.json(rows);
  });

  app.post('/api/accounts', auth, (req, res) => {
    const { username, session_id, daily_limit=150, cooldown_ms=8000 } = req.body;
    if (!username || !session_id) return res.status(400).json({ error: 'username and session_id required' });
    const existing = db.prepare('SELECT id FROM accounts WHERE username=?').get(username.replace('@',''));
    if (existing) return res.status(400).json({ error: 'Account already exists' });
    const id = uuidv4();
    db.prepare('INSERT INTO accounts (id,username,session_id,daily_limit,cooldown_ms) VALUES (?,?,?,?,?)').run(id, username.replace('@',''), session_id, daily_limit, cooldown_ms);
    res.json({ id, username });
  });

  app.put('/api/accounts/:id', auth, (req, res) => {
    const { session_id, daily_limit, cooldown_ms, status } = req.body;
    const fields=[]; const vals=[];
    if (session_id  !== undefined) { fields.push('session_id = ?');  vals.push(session_id); }
    if (daily_limit !== undefined) { fields.push('daily_limit = ?'); vals.push(daily_limit); }
    if (cooldown_ms !== undefined) { fields.push('cooldown_ms = ?'); vals.push(cooldown_ms); }
    if (status      !== undefined) { fields.push('status = ?');      vals.push(status); }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id);
    db.prepare(`UPDATE accounts SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
    res.json({ ok: true });
  });

  app.delete('/api/accounts/:id', auth, (req, res) => {
    db.prepare('DELETE FROM accounts WHERE id=?').run(req.params.id);
    res.json({ ok:true });
  });

  // ════════════════════════════════════════════════════════════════
  // CAMPAIGNS
  // ════════════════════════════════════════════════════════════════
  app.get('/api/campaigns', auth, (req, res) => {
    const rows = db.prepare('SELECT c.*, a.username as account_username FROM campaigns c LEFT JOIN accounts a ON c.account_id=a.id ORDER BY c.created_at DESC').all();
    rows.forEach(c => { try { c.keywords = JSON.parse(c.keywords); } catch { c.keywords = []; } });
    res.json(rows);
  });

  app.post('/api/campaigns', auth, (req, res) => {
    const { name, account_id, parent_category, sub_category='', location, keywords=[], message, max_dms=100, scrape_depth=1, dm_from_search=true, dm_from_followers=true, skip_private=true, skip_dmed=true, use_ai_enhance=false, image_url='' } = req.body;
    if (!name || !account_id || !parent_category || !location || !message) return res.status(400).json({ error: 'name, account_id, parent_category, location, message required' });
    const id = uuidv4();
    db.prepare('INSERT INTO campaigns (id,name,account_id,parent_category,sub_category,location,keywords,message,max_dms,scrape_depth,dm_from_search,dm_from_followers,skip_private,skip_dmed,use_ai_enhance,image_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, name, account_id, parent_category, sub_category, location, JSON.stringify(keywords), message, max_dms, scrape_depth, dm_from_search?1:0, dm_from_followers?1:0, skip_private?1:0, skip_dmed?1:0, use_ai_enhance?1:0, image_url||'');
    db.prepare("UPDATE campaigns SET status='stopped',finished_at=? WHERE account_id=? AND id!=? AND status IN ('running','pending')").run(new Date().toISOString(), account_id, id);
    db.prepare("UPDATE campaigns SET status='running',started_at=? WHERE id=?").run(new Date().toISOString(), id);
    res.json({ id, name });
  });

  app.patch('/api/campaigns/:id/status', auth, (req, res) => {
    const { status } = req.body;
    const allowed = ['pending','running','paused','done','stopped'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const now = new Date().toISOString();
    if (status === 'running') {
      const camp = db.prepare('SELECT account_id FROM campaigns WHERE id=?').get(req.params.id);
      if (camp) {
        db.prepare("SELECT id FROM campaigns WHERE account_id=? AND status='running' AND id!=?").all(camp.account_id, req.params.id)
          .forEach(r => db.prepare('UPDATE campaigns SET status=?,finished_at=? WHERE id=?').run('stopped', now, r.id));
      }
      db.prepare('UPDATE campaigns SET status=?,started_at=? WHERE id=?').run(status, now, req.params.id);
    } else if (['done','stopped'].includes(status)) {
      db.prepare('UPDATE campaigns SET status=?,finished_at=? WHERE id=?').run(status, now, req.params.id);
    } else {
      db.prepare('UPDATE campaigns SET status=? WHERE id=?').run(status, req.params.id);
    }
    res.json({ ok:true });
  });

  app.delete('/api/campaigns/:id', auth, (req, res) => {
    db.prepare('DELETE FROM campaigns WHERE id=?').run(req.params.id);
    res.json({ ok:true });
  });

  app.get('/api/campaigns/:id/config', (req, res) => {
    const key = (req.query.key||'').trim();
    if (!key) return res.status(401).json({ error:'key required' });
    const campaign = db.prepare('SELECT c.*,a.session_id,a.username AS account_username,a.cooldown_ms,a.daily_limit FROM campaigns c LEFT JOIN accounts a ON c.account_id=a.id WHERE c.id=?').get(req.params.id);
    if (!campaign) return res.status(404).json({ error:'Campaign not found' });
    const storedKey = (campaign.session_id||'').trim();
    let decoded; try { decoded = decodeURIComponent(key).trim(); } catch { decoded = key; }
    if (storedKey !== key && storedKey !== decoded) return res.status(403).json({ error:'Invalid key' });
    try { campaign.keywords = JSON.parse(campaign.keywords); } catch { campaign.keywords = []; }
    res.json(campaign);
  });

  app.get('/api/campaigns/:id/status', (req, res) => {
    const row = db.prepare('SELECT status FROM campaigns WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ error:'Not found' });
    res.json({ status: row.status });
  });

  // ════════════════════════════════════════════════════════════════
  // AI MESSAGE ENHANCEMENT
  // ════════════════════════════════════════════════════════════════
  app.post('/api/enhance-message', async (req, res) => {
    const { message, key, account_id, campaign_id } = req.body;
    if (!message) return res.status(400).json({ error:'message required' });
    if (key && account_id) {
      const acc = db.prepare('SELECT session_id FROM accounts WHERE id=?').get(account_id);
      if (!acc || !keysMatch(acc.session_id, key)) return res.status(403).json({ error:'Invalid key' });
    }
    let context = {};
    if (campaign_id) {
      const camp = db.prepare('SELECT parent_category,sub_category,location,account_id FROM campaigns WHERE id=?').get(campaign_id);
      if (camp) { context = { category:[camp.parent_category,camp.sub_category].filter(Boolean).join(' > '), location:camp.location }; }
    }
    const { enhanced, style_used } = await groqEnhance(message, context);
    res.json({ enhanced, original:message, used_ai: enhanced!==message, style_used });
  });

  // ════════════════════════════════════════════════════════════════
  // IMAGE UPLOAD / LIST / DELETE
  // ════════════════════════════════════════════════════════════════
  app.post('/api/upload-image', auth, (req, res) => {
    const { data, filename, mime_type } = req.body;
    if (!data) return res.status(400).json({ error:'data required' });
    const ext   = (filename||'image.jpg').split('.').pop().replace(/[^a-z0-9]/gi,'').toLowerCase()||'jpg';
    const fname = `img_${Date.now()}_${uuidv4().slice(0,8)}.${ext}`;
    const fpath = path.join(UPLOAD_DIR, fname);
    try {
      fs.writeFileSync(fpath, Buffer.from(data.replace(/^data:[^;]+;base64,/,''), 'base64'));
      res.json({ ok:true, url:`/uploads/${fname}`, filename:fname });
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  app.get('/api/images', auth, (req, res) => {
    try {
      const files = fs.readdirSync(UPLOAD_DIR).filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f)).map(f => ({ filename:f, url:`/uploads/${f}` }));
      res.json(files);
    } catch { res.json([]); }
  });

  app.delete('/api/images/:filename', auth, (req, res) => {
    const fpath = path.join(UPLOAD_DIR, path.basename(req.params.filename));
    try { if (fs.existsSync(fpath)) fs.unlinkSync(fpath); res.json({ ok:true }); }
    catch(e) { res.status(500).json({ error:e.message }); }
  });

  // ════════════════════════════════════════════════════════════════
  // PROCESSED ACCOUNTS
  // ════════════════════════════════════════════════════════════════
  app.get('/api/processed', (req, res) => {
    const { account_id, key } = req.query;
    if (!account_id || !key) return res.status(400).json({ error:'account_id and key required' });
    const acc = db.prepare('SELECT session_id FROM accounts WHERE id=?').get(account_id);
    if (!acc || !keysMatch(acc.session_id, key)) return res.status(403).json({ error:'Invalid' });
    res.json(db.prepare('SELECT target_username,source,dm_sent_at FROM processed_accounts WHERE account_id=?').all(account_id));
  });

  app.post('/api/processed', (req, res) => {
    const { account_id, campaign_id, target_username, source='bot', dm_sent, key } = req.body;
    if (!account_id || !key || !target_username) return res.status(400).json({ error:'Missing fields' });
    const acc = db.prepare('SELECT session_id FROM accounts WHERE id=?').get(account_id);
    if (!acc || !keysMatch(acc.session_id, key)) return res.status(403).json({ error:'Invalid key' });
    try {
      const existing = db.prepare('SELECT id,dm_sent FROM processed_accounts WHERE account_id=? AND target_username=?').get(account_id, target_username);
      if (existing) {
        if (dm_sent && !existing.dm_sent) db.prepare('UPDATE processed_accounts SET dm_sent=1,dm_sent_at=? WHERE account_id=? AND target_username=?').run(new Date().toISOString(), account_id, target_username);
      } else {
        db.prepare('INSERT INTO processed_accounts (account_id,target_username,source,dm_sent,dm_sent_at) VALUES (?,?,?,?,?)').run(account_id, target_username, source, dm_sent?1:0, dm_sent?new Date().toISOString():null);
      }
      if (dm_sent) {
        db.prepare('UPDATE accounts SET dms_today=dms_today+1,dms_total=dms_total+1,last_active=? WHERE id=?').run(new Date().toISOString(), account_id);
        if (campaign_id) db.prepare('UPDATE campaigns SET dms_sent=dms_sent+1 WHERE id=?').run(campaign_id);
      }
      res.json({ ok:true });
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  // ════════════════════════════════════════════════════════════════
  // LOGS
  // ════════════════════════════════════════════════════════════════
  app.post('/api/log', (req, res) => {
    const { account_id, campaign_id, level='info', message, username, key } = req.body;
    if (!message) return res.status(400).json({ error:'message required' });
    if (key && account_id) {
      const acc = db.prepare('SELECT session_id FROM accounts WHERE id=?').get(account_id);
      if (!acc || !keysMatch(acc.session_id, key)) return res.status(403).json({ error:'Invalid key' });
    }
    db.prepare('INSERT INTO logs (account_id,campaign_id,level,message,username) VALUES (?,?,?,?,?)').run(account_id||null, campaign_id||null, level, message, username||null);
    res.json({ ok:true });
  });

  app.get('/api/logs', auth, (req, res) => {
    const { account_id, campaign_id } = req.query;
    const limit = Math.min(parseInt(req.query.limit)||200, 500);
    let q = 'SELECT l.*,a.username AS account_username FROM logs l LEFT JOIN accounts a ON l.account_id=a.id WHERE 1=1';
    const params = [];
    if (account_id)  { q += ' AND l.account_id=?';  params.push(account_id); }
    if (campaign_id) { q += ' AND l.campaign_id=?'; params.push(campaign_id); }
    q += ' ORDER BY l.id DESC LIMIT ?';
    params.push(limit);
    res.json(db.prepare(q).all(...params).reverse());
  });

  // ════════════════════════════════════════════════════════════════
  // BOT CONTROL — Playwright worker.js
  // ════════════════════════════════════════════════════════════════

  app.post('/api/pybot/start', auth, (req, res) => {
    if (_botRunning) return res.status(409).json({ error:'Bot already running — click Stop first' });
    const igPass = process.env.IG_PASSWORD || '';
    if (!igPass) return res.status(400).json({ error:'IG_PASSWORD not set! Add it to your environment variables.' });

    const { campaign_id, account_id } = req.body;
    let acc      = account_id  ? db.prepare('SELECT * FROM accounts WHERE id=?').get(account_id)                : null;
    if (!acc) acc = db.prepare('SELECT * FROM accounts WHERE username=?').get(process.env.IG_USERNAME||'');
    if (!acc) acc = db.prepare('SELECT * FROM accounts ORDER BY created_at LIMIT 1').get();
    if (!acc) return res.status(404).json({ error:'No accounts found' });

    let campaign = campaign_id ? db.prepare('SELECT * FROM campaigns WHERE id=?').get(campaign_id) : null;
    if (!campaign) campaign = db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC LIMIT 1').get();
    if (!campaign) return res.status(404).json({ error:'No campaigns found' });

    db.prepare("UPDATE campaigns SET status='running',started_at=? WHERE id=?").run(new Date().toISOString(), campaign.id);
    runBot(campaign, acc.id, db);
    res.json({ ok:true, message:'Playwright bot started!', campaign:campaign.name, account:acc.username });
  });

  app.post('/api/pybot/stop', auth, (req, res) => {
    _botStop = true;
    if (_botProcess) { _botProcess.kill('SIGTERM'); _botProcess = null; }
    if (_botCampaign) db.prepare("UPDATE campaigns SET status='stopped',finished_at=? WHERE id=?").run(new Date().toISOString(), _botCampaign);
    _botRunning = false; _botCampaign = null;
    res.json({ ok:true, message:'Bot stopped' });
  });

  app.get('/api/pybot/logs', auth, (_req, res) => res.json(global._pwLogs || []));

  app.post('/api/pybot/clear-session', auth, (_req, res) => {
    const f = './data/pw_session.json';
    try {
      if (fs.existsSync(f)) { fs.unlinkSync(f); res.json({ ok:true, message:'Session cleared — next run will re-login' }); }
      else res.json({ ok:true, message:'No session file found (already clear)' });
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  app.get('/api/bot/debug', auth, (req, res) => {
    res.json({
      botRunning : _botRunning,
      botCampaign: _botCampaign,
      igUsername : process.env.IG_USERNAME||'',
      igPassSet  : !!(process.env.IG_PASSWORD),
      engine     : 'playwright',
      campaigns  : db.prepare('SELECT id,name,status,message,account_id FROM campaigns').all(),
      accounts   : db.prepare('SELECT id,username,status FROM accounts').all(),
    });
  });

  // ════════════════════════════════════════════════════════════════
  // CRON — GET /api/bot/run?key=CRON_KEY
  // ════════════════════════════════════════════════════════════════
  app.get('/api/bot/run', async (req, res) => {
    const CRON_KEY = process.env.CRON_KEY || 'instraeach_cron_2024';
    if (req.query.key !== CRON_KEY) return res.status(403).json({ error:'Wrong key' });
    if (_botRunning) return res.json({ ok:true, message:'Bot already running', skipped:true });

    let campaign = db.prepare("SELECT c.*,a.session_id,a.username AS account_username,a.id AS acc_id FROM campaigns c JOIN accounts a ON c.account_id=a.id WHERE c.status='running' ORDER BY c.created_at DESC LIMIT 1").get();
    if (!campaign) campaign = db.prepare('SELECT c.*,a.session_id,a.username AS account_username,a.id AS acc_id FROM campaigns c JOIN accounts a ON c.account_id=a.id ORDER BY c.created_at DESC LIMIT 1').get();
    if (!campaign) return res.json({ ok:false, message:'No campaigns found' });

    db.prepare("UPDATE campaigns SET status='running',started_at=? WHERE id=?").run(new Date().toISOString(), campaign.id);
    console.log('[Cron] Starting bot:', campaign.name);
    res.json({ ok:true, message:'Bot started via cron', campaign:campaign.name });
    runBot({ ...campaign, account_id:campaign.acc_id }, campaign.acc_id, db);
  });

  // ════════════════════════════════════════════════════════════════
  // STATS
  // ════════════════════════════════════════════════════════════════
  app.get('/api/stats', auth, (req, res) => {
    res.json({
      dmsToday        : db.prepare('SELECT COALESCE(SUM(dms_today),0) AS v FROM accounts').get().v,
      dmsTotal        : db.prepare('SELECT COALESCE(SUM(dms_total),0) AS v FROM accounts').get().v,
      activeAccounts  : db.prepare("SELECT COUNT(*) AS v FROM accounts WHERE status IN ('running','idle')").get().v,
      runningCampaigns: db.prepare("SELECT COUNT(*) AS v FROM campaigns WHERE status='running'").get().v,
      totalCampaigns  : db.prepare('SELECT COUNT(*) AS v FROM campaigns').get().v,
      accountsScraped : db.prepare('SELECT COUNT(*) AS v FROM processed_accounts').get().v,
    });
  });

  // ════════════════════════════════════════════════════════════════
  // HEALTH / PING
  // ════════════════════════════════════════════════════════════════
  app.get('/ping',   (req, res) => { try { db.prepare('INSERT INTO ping_log (account_id,ip) VALUES (?,?)').run(req.query.account||null, req.ip); } catch {} res.json({ ok:true, ts:new Date().toISOString() }); });
  app.get('/health', (_req, res) => res.json({ status:'ok', engine:'playwright', ts:new Date().toISOString() }));

  // ── Session helpers ──────────────────────────────────────────────
  app.get('/admin/reset-session', (req, res) => {
    const { admin_key, account_id, new_session } = req.query;
    const ADMIN_KEY = process.env.ADMIN_KEY || 'instraeach_admin_2024';
    if (admin_key !== ADMIN_KEY) return res.status(403).json({ error:'Wrong admin_key' });
    if (!account_id || !new_session) return res.status(400).json({ error:'account_id and new_session required' });
    try {
      const decoded = decodeURIComponent(new_session).trim();
      db.prepare('UPDATE accounts SET session_id=? WHERE id=?').run(decoded, account_id);
      const acc = db.prepare('SELECT username FROM accounts WHERE id=?').get(account_id);
      res.json({ ok:true, username:acc?.username, preview:decoded.slice(0,30)+'...' });
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  app.post('/api/update-session', (req, res) => {
    const { account_id, old_key, new_key } = req.body;
    if (!account_id || !old_key || !new_key) return res.status(400).json({ error:'account_id, old_key, new_key required' });
    const acc = db.prepare('SELECT session_id,username FROM accounts WHERE id=?').get(account_id);
    if (!acc) return res.status(404).json({ error:'Account not found' });
    const stored = (acc.session_id||'').trim();
    const oldKey = decodeURIComponent(old_key).trim();
    const newKey = decodeURIComponent(new_key).trim();
    if (stored !== oldKey && stored !== newKey) return res.status(403).json({ error:'old_key does not match stored session_id' });
    db.prepare('UPDATE accounts SET session_id=? WHERE id=?').run(newKey, account_id);
    res.json({ ok:true, username:acc.username });
  });

  // ── Daily reset ───────────────────────────────────────────────
  function scheduleMidnightReset() {
    const now  = new Date();
    const next = new Date(now); next.setDate(next.getDate()+1); next.setHours(0,0,0,0);
    setTimeout(() => {
      db.prepare('UPDATE accounts SET dms_today=0').run();
      console.log('[InstaReach] Daily DM counts reset at midnight');
      setInterval(() => { db.prepare('UPDATE accounts SET dms_today=0').run(); }, 24*60*60*1000);
    }, next - now);
  }
  scheduleMidnightReset();

  app.use((err, req, res, next) => {
    console.error('[InstaReach] Error:', err.message);
    res.status(500).json({ error: err.message || 'Internal server error' });
  });

  app.listen(PORT, () => {
    console.log(`[InstaReach] Server → http://localhost:${PORT}`);
    console.log(`[InstaReach] Engine     : Playwright (Node.js — no Python)`);
    console.log(`[InstaReach] Groq AI    : ${GROQ_KEY ? '✓ enabled' : '✗ disabled'}`);
    console.log(`[InstaReach] Image dir  : ${UPLOAD_DIR}`);
  });

}).catch(err => { console.error('[InstaReach] DB init failed:', err); process.exit(1); });
