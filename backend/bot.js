// bot.js — Puppeteer Instagram DM worker
// Runs inside the server process, controlled via start/stop API
// Uses Instagram session cookie (sessionid) — no password needed

const puppeteer = require('puppeteer-extra');
const Stealth   = require('puppeteer-extra-plugin-stealth');
puppeteer.use(Stealth());

const sleep = (ms, j = 0) => new Promise(r => setTimeout(r, ms + Math.floor(Math.random() * (j || 1))));
const rnd   = (a, b) => a + Math.floor(Math.random() * (b - a));

// ── State ────────────────────────────────────────────────────────────────────
let browser    = null;
let page       = null;
let running    = false;
let stopFlag   = false;
let currentJob = null;   // { campaignId, accountId }

// ── Logger (writes to DB via callback) ──────────────────────────────────────
let _logFn = null;
function setLogger(fn) { _logFn = fn; }
function log(msg, level = 'info', username = null) {
  console.log(`[Bot] ${level.toUpperCase()} ${msg}`);
  if (_logFn) _logFn(msg, level, username);
}

// ── Launch browser ───────────────────────────────────────────────────────────
async function launchBrowser() {
  if (browser) return;
  log('Launching browser...');
  browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,900',
    ],
    defaultViewport: { width: 1280, height: 900 },
  });
  log('Browser launched ✓');
}

async function closeBrowser() {
  if (browser) { await browser.close().catch(() => {}); browser = null; page = null; }
}

// ── Set Instagram session cookie ─────────────────────────────────────────────
async function setSession(sessionId) {
  if (!page) {
    page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
    );
    // Block images/fonts to speed up
    await page.setRequestInterception(true);
    page.on('request', req => {
      const type = req.resourceType();
      if (['image','font','media'].includes(type)) req.abort();
      else req.continue();
    });
  }
  await page.setCookie({
    name:   'sessionid',
    value:  sessionId,
    domain: '.instagram.com',
    path:   '/',
    httpOnly: true,
    secure: true,
  });
  log('Session cookie set ✓');
}

// ── Navigate to Instagram DMs ────────────────────────────────────────────────
async function goToInbox() {
  await page.goto('https://www.instagram.com/direct/inbox/', {
    waitUntil: 'networkidle2',
    timeout: 30000,
  });
  // Check if logged in
  const url = page.url();
  if (url.includes('/accounts/login')) {
    throw new Error('Session expired — update sessionid in dashboard');
  }
  log('✓ Logged in, inbox loaded');
}

// ── Search Instagram API for accounts ───────────────────────────────────────
async function searchAccounts(keyword) {
  try {
    const results = await page.evaluate(async (kw) => {
      const resp = await fetch(
        `/api/v1/web/search/topsearch/?context=blended&query=${encodeURIComponent(kw)}&include_reel=false`,
        { headers: { 'x-ig-app-id': '936619743392459', 'x-requested-with': 'XMLHttpRequest' }, credentials: 'include' }
      );
      if (!resp.ok) return [];
      const data = await resp.json();
      return (data.users || []).map(u => u.user?.username).filter(Boolean);
    }, keyword);
    return results;
  } catch (e) {
    log('Search failed for "' + keyword + '": ' + e.message, 'warn');
    return [];
  }
}

// ── Type text humanly ────────────────────────────────────────────────────────
async function humanType(selector, text, delayMin = 40, delayMax = 110) {
  const el = await page.$(selector);
  if (!el) throw new Error('Element not found: ' + selector);
  await el.click({ clickCount: 3 }); // select all
  await el.press('Backspace');
  for (const ch of text) {
    await el.type(ch, { delay: rnd(delayMin, delayMax) });
  }
}

// ── Send a DM ────────────────────────────────────────────────────────────────
async function sendDM(username, message, imageUrl, apiBase) {
  try {
    log('Sending DM to @' + username, 'info', username);

    // Step 1: Type in sidebar search
    const searchSel = 'input[placeholder="Search"]';
    await page.waitForSelector(searchSel, { timeout: 8000 });
    await humanType(searchSel, username);
    await sleep(2000, 500);

    // Step 2: Click the matching result
    const clicked = await page.evaluate((uname) => {
      const opts = [...document.querySelectorAll('[role="option"], [role="listbox"] [role="button"], ul li[role="button"]')];
      for (const el of opts) {
        if (el.textContent.toLowerCase().includes(uname.toLowerCase())) {
          el.click(); return true;
        }
      }
      return false;
    }, username);

    if (!clicked) {
      log('No result for @' + username + ' — skipping', 'warn', username);
      // Clear search
      await humanType(searchSel, '');
      return false;
    }

    await sleep(2500, 500);

    // Step 3: Find message box
    const msgSel = 'div[contenteditable="true"][aria-label], div[role="textbox"], div[contenteditable="true"]';
    await page.waitForSelector(msgSel, { timeout: 10000 });

    // Step 4: Paste image if configured
    if (imageUrl) {
      try {
        const fullUrl = imageUrl.startsWith('http') ? imageUrl : apiBase + imageUrl;
        // Inject image via clipboard API simulation
        await page.evaluate(async (url) => {
          const resp = await fetch(url);
          const blob = await resp.blob();
          const file = new File([blob], 'img.jpg', { type: blob.type || 'image/jpeg' });
          const dt   = new DataTransfer();
          dt.items.add(file);
          const box = document.querySelector('div[contenteditable="true"][aria-label], div[role="textbox"], div[contenteditable="true"]');
          if (box) {
            box.focus();
            box.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
          }
        }, fullUrl);
        log('✓ Image pasted', 'info', username);
        await sleep(2000, 500);
      } catch (e) {
        log('Image paste failed: ' + e.message + ' — text only', 'warn', username);
      }
    }

    // Step 5: Type message
    await page.focus(msgSel);
    await sleep(300);
    // Use execCommand for contenteditable
    await page.evaluate((msg) => {
      const el = document.querySelector('div[contenteditable="true"][aria-label], div[role="textbox"], div[contenteditable="true"]');
      if (el) {
        el.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        document.execCommand('insertText', false, msg);
      }
    }, message);
    await sleep(600, 300);

    // Step 6: Send with Enter
    await page.keyboard.press('Enter');
    await sleep(1500, 500);

    // Try Send button as fallback
    await page.evaluate(() => {
      const btn = document.querySelector('button[aria-label*="Send"], div[aria-label*="Send"], button[type="submit"]');
      if (btn && !btn.disabled) btn.click();
    });

    log('✓ DM sent → @' + username + (imageUrl ? ' +img' : ''), 'success', username);
    return true;

  } catch (e) {
    log('Exception @' + username + ': ' + e.message, 'error', username);
    return false;
  }
}

// ── Main campaign runner ─────────────────────────────────────────────────────
async function runCampaign({ campaign, account, processedSet, groqEnhanceFn, logToDb, markProcessedFn, checkRunningFn }) {
  if (running) { log('Bot already running', 'warn'); return; }
  running  = true;
  stopFlag = false;
  currentJob = { campaignId: campaign.id, accountId: account.id };
  setLogger(logToDb);

  let dmCount = 0;

  try {
    await launchBrowser();
    await setSession(account.session_id);
    await goToInbox();

    // Parse keywords
    let keywords = [];
    try { keywords = typeof campaign.keywords === 'string' ? JSON.parse(campaign.keywords) : campaign.keywords; } catch {}

    const EXTRA = [
      'real estate agent delhi', 'property dealer delhi', 'delhi property',
      'realestate delhi', 'homes delhi', 'flats delhi',
      'property consultant delhi', 'real estate broker delhi',
    ];
    const allKeywords = [...new Set([...keywords, ...EXTRA])];
    log('Searching ' + allKeywords.length + ' keywords...');

    // Collect targets
    const targets = [];
    for (const kw of allKeywords) {
      if (stopFlag) break;
      if (!(await checkRunningFn())) break;
      const found = await searchAccounts(kw);
      const fresh = found.filter(u => !processedSet.has(u) && !targets.includes(u));
      if (fresh.length) log('"' + kw + '" → ' + fresh.length + ' new');
      fresh.forEach(u => targets.push(u));
      await sleep(1200, 600);
      if (targets.length >= 80) break;
    }

    if (!targets.length) {
      log('No new targets found', 'warn');
    } else {
      log('Found ' + targets.length + ' targets. Starting DMs...');
    }

    const maxDms    = campaign.max_dms || 50;
    const cooldown  = Math.max(12000, campaign.cooldown_ms || 13000);

    for (const username of targets) {
      if (stopFlag)              { log('Stopped by user', 'warn'); break; }
      if (dmCount >= maxDms)     { log('Max DMs (' + maxDms + ') reached', 'warn'); break; }
      if (!(await checkRunningFn())) { log('Campaign stopped from dashboard', 'warn'); break; }
      if (processedSet.has(username)) continue;

      // Build base message with placeholders
      let baseMsg = (campaign.message || '')
        .replace(/\{\{username\}\}/g, username)
        .replace(/\{\{sender\}\}/g,   '@' + account.username)
        .replace(/\{\{category\}\}/g, campaign.parent_category || '');

      // Groq enhance
      const finalMsg = await groqEnhanceFn(baseMsg, {
        category: campaign.parent_category,
        location: campaign.location,
        sender:   account.username,
      });

      const result = await sendDM(username, finalMsg.enhanced || finalMsg, campaign.image_url || '', 'https://instraeach.onrender.com');
      await markProcessedFn(username, result === true);
      if (result === true) dmCount++;

      const wait = rnd(cooldown, cooldown + 12000);
      log('Waiting ' + (wait / 1000).toFixed(0) + 's...');
      await sleep(wait);
    }

    log('Session complete. DMs sent: ' + dmCount, 'success');

  } catch (e) {
    log('Bot error: ' + e.message, 'error');
  } finally {
    running    = false;
    stopFlag   = false;
    currentJob = null;
    await closeBrowser();
  }
}

function stopBot() {
  stopFlag = true;
  log('Stop signal sent', 'warn');
}

function isRunning() { return running; }
function getJob()    { return currentJob; }

module.exports = { runCampaign, stopBot, isRunning, getJob };