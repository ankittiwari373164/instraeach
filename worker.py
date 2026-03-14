/**
 * InstaReach Playwright Worker v1
 * Replaces worker.py — pure Node.js, no Python required.
 * Uses Playwright (stealth) to operate Instagram via real browser.
 * All anti-detection, proxy, and AI-enhance features included.
 */

'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

// ── Logging ──────────────────────────────────────────────────────
function log(msg, level = 'info') {
  const ts     = new Date().toLocaleTimeString('en-GB');
  const prefix = { info:'P', success:'OK', error:'ERR', warn:'WARN' }[level] || 'P';
  const line   = `[${ts}] ${prefix} ${msg}`;
  console.log(line);
  // Also push to parent via IPC if available
  if (process.send) process.send({ type:'log', level, msg });
}

// ── Config from env ──────────────────────────────────────────────
const IG_USERNAME   = (process.env.IG_USERNAME   || '').trim().replace('@','').toLowerCase();
const IG_PASSWORD   = (process.env.IG_PASSWORD   || '').trim();
const SESSION_FILE  = process.env.SESSION_FILE   || './data/pw_session.json';
const GROQ_KEY      = process.env.GROQ_API_KEY   || '';
const PROXY_URL     = (process.env.IG_PROXY      || '').trim();
const HEADLESS_MODE = process.env.HEADLESS !== 'false'; // default headless=true

let campaign = {};
try { campaign = JSON.parse(process.env.CAMPAIGN_DATA || '{}'); } catch {}

const CAMPAIGN_NAME   = campaign.name       || 'Campaign';
const ACCOUNT_ID      = campaign.account_id || 'default';
const MESSAGE_TPL     = campaign.message    || 'Hi {{username}}! I help Delhi businesses grow online. Interested?';
const MAX_DMS         = Math.min(parseInt(campaign.max_dms) || 15, 20);
const CAMPAIGN_ID     = campaign.id         || '';

const PROCESSED_FILE  = `./data/processed_${ACCOUNT_ID.slice(0,8)}.json`;
const REPLIES_FILE    = `./data/replies_${ACCOUNT_ID.slice(0,8)}.json`;
const STATS_FILE      = `./data/stats_${ACCOUNT_ID.slice(0,8)}.json`;

let KEYWORDS = [];
try {
  const raw = campaign.keywords || '[]';
  KEYWORDS  = typeof raw === 'string' ? JSON.parse(raw) : (raw || []);
} catch {}

const EXTRA_KEYWORDS = [
  'real estate agent delhi', 'property dealer delhi',
  'delhi property', 'realestate delhi',
  'homes delhi', 'flats delhi',
  'property consultant delhi', 'real estate broker delhi',
];
const ALL_KEYWORDS = [...new Set([...KEYWORDS, ...EXTRA_KEYWORDS])];

// ── Ensure data dir ──────────────────────────────────────────────
fs.mkdirSync('./data', { recursive: true });

// ── Persistence helpers ──────────────────────────────────────────
function loadJson(file, def) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  return def;
}
function saveJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch(e) { log(`saveJson error: ${e.message}`, 'warn'); }
}
function loadSet(file)  { return new Set(loadJson(file, [])); }
function saveSet(file, s) { saveJson(file, [...s]); }

// ── Stats helpers ────────────────────────────────────────────────
function loadStats()  { return loadJson(STATS_FILE, {}); }
function saveStats(s) { saveJson(STATS_FILE, s); }

function checkDailyLimit(stats) {
  const today = new Date().toISOString().slice(0,10);
  const count = stats[`sent_${today}`] || 0;
  if (count >= 30) { log(`Daily limit reached (${count}/30). Run again tomorrow.`, 'warn'); return [false, count]; }
  log(`Daily progress: ${count}/30 DMs sent today. ${30-count} remaining.`);
  return [true, count];
}

// ── Human timing helpers ─────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
function rand(min, max) { return Math.random() * (max - min) + min; }

async function humanSleep(minMs, maxMs) {
  const ms = rand(minMs, maxMs);
  await sleep(ms);
}

async function typeHuman(page, selector, text) {
  await page.click(selector);
  await sleep(rand(200, 500));
  for (const ch of text) {
    await page.keyboard.type(ch, { delay: rand(40, 140) });
    if (Math.random() < 0.03) await sleep(rand(200, 800)); // occasional pause mid-type
  }
}

// ── Stealth patches ───────────────────────────────────────────────
async function applyStealthPatches(page) {
  await page.addInitScript(() => {
    // Overwrite webdriver flag
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // Fake plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [{ name:'Chrome PDF Plugin' },{ name:'Chrome PDF Viewer' },{ name:'Native Client' }]
    });

    // Fake languages
    Object.defineProperty(navigator, 'languages', { get: () => ['en-IN', 'en-US', 'en', 'hi'] });

    // Fake platform
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });

    // Overwrite chrome runtime to look like real Chrome
    window.chrome = { runtime: {} };

    // Remove Playwright-specific props
    delete window.__playwright;
    delete window.__pw_manual;
  });
}

// ── Browser launch ───────────────────────────────────────────────
async function launchBrowser() {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--window-size=1280,800',
    '--lang=en-IN',
  ];

  const launchOpts = {
    headless: HEADLESS_MODE,
    args,
    ignoreDefaultArgs: ['--enable-automation'],
  };

  // Proxy support
  if (PROXY_URL) {
    try {
      const u      = new URL(PROXY_URL);
      launchOpts.proxy = {
        server  : `${u.protocol}//${u.hostname}:${u.port}`,
        username: u.username || undefined,
        password: u.password || undefined,
      };
      log(`Proxy: ${u.hostname}:${u.port}`, 'success');
    } catch(e) { log(`Bad proxy URL: ${e.message}`, 'warn'); }
  }

  const browser = await chromium.launch(launchOpts);
  return browser;
}

// ── Session save / load ──────────────────────────────────────────
async function saveSession(context) {
  const state = await context.storageState();
  saveJson(SESSION_FILE, state);
  log('Session saved', 'success');
}

async function loadSession(browser) {
  const sessionData = loadJson(SESSION_FILE, null);
  if (sessionData && sessionData.cookies && sessionData.cookies.length > 0) {
    log('Loading saved session...');
    const context = await browser.newContext({
      storageState: sessionData,
      userAgent   : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport    : { width:1280, height:800 },
      locale      : 'en-IN',
      timezoneId  : 'Asia/Kolkata',
    });
    return context;
  }
  return null;
}

// ── Login ────────────────────────────────────────────────────────
async function doLogin(browser) {
  log('Logging in fresh...');
  const context = await browser.newContext({
    userAgent : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport  : { width:1280, height:800 },
    locale    : 'en-IN',
    timezoneId: 'Asia/Kolkata',
  });
  const page = context.pages()[0] || await context.newPage();
  await applyStealthPatches(page);

  await page.goto('https://www.instagram.com/accounts/login/', { waitUntil:'domcontentloaded', timeout:60000 });
  await humanSleep(2000, 4000);

  // Accept cookies if shown
  try {
    const cookieBtn = page.locator('button:has-text("Allow all cookies"), button:has-text("Accept All")');
    if (await cookieBtn.count() > 0) {
      await cookieBtn.first().click();
      await humanSleep(1000, 2000);
    }
  } catch {}

  // Type credentials
  await typeHuman(page, 'input[name="username"]', IG_USERNAME);
  await humanSleep(500, 1200);
  await typeHuman(page, 'input[name="password"]', IG_PASSWORD);
  await humanSleep(800, 1800);

  // Click login
  await page.click('button[type="submit"]');
  await humanSleep(4000, 7000);

  // Check for challenge / 2FA
  const url = page.url();
  if (url.includes('/challenge/') || url.includes('/two_factor/')) {
    log('Instagram challenge / 2FA detected. Cannot proceed automatically.', 'error');
    await context.close();
    return null;
  }

  // Check login success
  if (!url.includes('instagram.com') || url.includes('/accounts/login/')) {
    log('Login may have failed. Check credentials.', 'error');
    await context.close();
    return null;
  }

  // Dismiss "Save login info" popup
  try {
    const notNowBtn = page.locator('button:has-text("Not Now"), button:has-text("Save Info")');
    if (await notNowBtn.first().isVisible({ timeout:5000 })) {
      await notNowBtn.first().click();
      await humanSleep(1000, 2000);
    }
  } catch {}

  // Dismiss notifications popup
  try {
    const notifBtn = page.locator('button:has-text("Not Now"), button:has-text("Turn On")');
    if (await notifBtn.first().isVisible({ timeout:4000 })) {
      await notifBtn.first().click();
      await humanSleep(1000, 2000);
    }
  } catch {}

  await saveSession(context);
  log(`Logged in as @${IG_USERNAME}`, 'success');
  return context;
}

// ── Verify session is still alive ───────────────────────────────
async function verifySession(context) {
  try {
    const page = context.pages()[0] || await context.newPage();
    await applyStealthPatches(page);
    await page.goto('https://www.instagram.com/', { waitUntil:'domcontentloaded', timeout:30000 });
    await humanSleep(2000, 3000);

    // If redirected to login page → session dead
    if (page.url().includes('/accounts/login/')) return false;

    // Check for logged-in indicator (profile nav link)
    const profileIcon = page.locator('a[href*="/' + IG_USERNAME + '/"], nav a[aria-label="Profile"]');
    const isLoggedIn  = await profileIcon.count() > 0;
    return isLoggedIn;
  } catch (e) {
    log(`Session check error: ${e.message}`, 'warn');
    return false;
  }
}

// ── Get or create context ────────────────────────────────────────
async function getContext(browser) {
  // Try saved session first
  let context = await loadSession(browser);
  if (context) {
    const page = await context.newPage();
    await applyStealthPatches(page);
    const alive = await verifySession(context);
    if (alive) { log('Session restored ✓', 'success'); return context; }
    log('Session expired — re-logging in...', 'warn');
    await context.close();
  }

  // Fresh login
  if (!IG_USERNAME || !IG_PASSWORD) {
    log('ERROR: IG_USERNAME and IG_PASSWORD required!', 'error');
    return null;
  }
  return await doLogin(browser);
}

// ── Groq AI enhance ──────────────────────────────────────────────
async function groqEnhance(username, baseMsg = MESSAGE_TPL) {
  const msg = baseMsg.replace(/\{\{username\}\}/g, username);
  if (!GROQ_KEY) return msg;

  const styles = [
    'casual and friendly', 'confident and direct',
    'curious and conversational', 'empathetic', 'enthusiastic but brief'
  ];
  const style = styles[Math.floor(Math.random() * styles.length)];

  const body = JSON.stringify({
    model      : 'llama3-8b-8192',
    max_tokens : 180,
    temperature: 0.92,
    messages: [
      {
        role   : 'system',
        content: `You are an Instagram DM writer. Rewrite the message in a ${style} tone.
RULES: Max 3 sentences. No "Hi/Hey/Hello". No sign-offs. No hashtags, emojis, asterisks.
Output ONLY the final message, no explanation.`
      },
      { role:'user', content:`Message: "${msg}"\nRewrite now:` }
    ]
  });

  try {
    const { default: https } = await import('https');
    const result = await new Promise((res, rej) => {
      const req = https.request({
        hostname: 'api.groq.com',
        path    : '/openai/v1/chat/completions',
        method  : 'POST',
        headers : {
          'Content-Type'  : 'application/json',
          'Authorization' : `Bearer ${GROQ_KEY}`,
          'Content-Length': Buffer.byteLength(body),
        }
      }, r2 => {
        let d = '';
        r2.on('data', c => d += c);
        r2.on('end', () => {
          try {
            const j = JSON.parse(d);
            res(j.choices?.[0]?.message?.content?.trim() || msg);
          } catch { res(msg); }
        });
      });
      req.on('error', () => res(msg));
      req.setTimeout(8000, () => { req.destroy(); res(msg); });
      req.write(body); req.end();
    });
    log(`AI enhanced: ${result.slice(0,60)}`, 'info');
    return result;
  } catch { return msg; }
}

// ── Search users via Instagram web ──────────────────────────────
async function searchUsers(page, keyword, limit = 10) {
  try {
    const encoded = encodeURIComponent(keyword);
    await page.goto(`https://www.instagram.com/explore/search/keyword/?q=${encoded}`, {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    await humanSleep(2000, 4000);

    // Try extracting usernames from search results
    const usernames = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href^="/"]'));
      return links
        .map(a => {
          const m = a.href.match(/instagram\.com\/([a-zA-Z0-9._]+)\/?$/);
          return m ? m[1] : null;
        })
        .filter(u => u && !['explore','reels','stories','accounts','p','direct','tv'].includes(u));
    });

    // De-duplicate
    const unique = [...new Set(usernames)].slice(0, limit);
    return unique;
  } catch (e) {
    log(`Search "${keyword}" error: ${e.message}`, 'warn');
    return [];
  }
}

// ── Search via hashtag page ───────────────────────────────────────
async function searchHashtag(page, keyword, limit = 10) {
  try {
    const tag = keyword.replace(/^#/, '').replace(/\s+/g, '').toLowerCase();
    await page.goto(`https://www.instagram.com/explore/tags/${tag}/`, {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    await humanSleep(2000, 4000);

    // Click first post to get user context
    const posts = page.locator('article a, ._aagw');
    if (await posts.count() === 0) return [];

    const usernames = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href^="/"]'));
      return [...new Set(
        links
          .map(a => { const m = a.href.match(/\/([a-zA-Z0-9._]+)\/?$/); return m?.[1]; })
          .filter(u => u && !['explore','reels','stories','accounts','p','direct','tv','tags','reel'].includes(u))
      )].slice(0, 15);
    });
    return usernames.slice(0, limit);
  } catch(e) {
    log(`Hashtag "${keyword}" error: ${e.message}`, 'warn');
    return [];
  }
}

// ── Send DM ──────────────────────────────────────────────────────
async function sendDM(page, username, message) {
  try {
    // Navigate to user profile first (human-like)
    await page.goto(`https://www.instagram.com/${username}/`, {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    await humanSleep(2000, 4000);

    // Check if account exists / private
    const notFound = await page.locator('h2:has-text("Sorry, this page"), h2:has-text("isn\'t available")').count();
    if (notFound > 0) { log(`@${username} not found`, 'warn'); return 'skip'; }

    // Click Message button on profile
    const msgBtn = page.locator('button:has-text("Message"), div[role="button"]:has-text("Message")');
    if (await msgBtn.count() === 0) {
      log(`No Message button for @${username} (private or already following?)`, 'warn');
      return 'skip';
    }
    await msgBtn.first().click();
    await humanSleep(2500, 5000);

    // Handle "Not Now" on login save prompt if it pops up
    try {
      const notNow = page.locator('button:has-text("Not Now")');
      if (await notNow.isVisible({ timeout:2000 })) { await notNow.click(); await humanSleep(1000,2000); }
    } catch {}

    // We should now be in the DM thread — type message
    const msgBox = page.locator('div[aria-label="Message"], textarea[placeholder*="Message"], div[contenteditable="true"]');
    if (await msgBox.count() === 0) {
      log(`DM box not found for @${username}`, 'warn');
      return 'fail';
    }

    // Simulate typing delay (chars * ~55ms)
    await sleep(Math.max(3000, message.length * rand(40, 70)));
    await msgBox.first().click();
    await sleep(rand(300, 700));

    // Type character by character with human-like delay
    for (const ch of message) {
      await page.keyboard.type(ch, { delay: rand(35, 120) });
      if (Math.random() < 0.02) await sleep(rand(300, 900));
    }
    await humanSleep(800, 1500);

    // Send via Enter key
    await page.keyboard.press('Enter');
    await humanSleep(1500, 3000);

    // Verify message was sent (look for sent indicator)
    log(`DM sent -> @${username}`, 'success');
    return 'sent';

  } catch(e) {
    const err = e.message.toLowerCase();
    if (err.includes('timeout'))       { log(`Timeout @${username}`, 'warn'); return 'fail'; }
    if (err.includes('not found'))     return 'skip';
    if (err.includes('login'))         return 'relogin';
    log(`DM error @${username}: ${e.message.slice(0,100)}`, 'warn');
    return 'fail';
  }
}

// ── Check inbox for replies ───────────────────────────────────────
async function checkInbox(page, processed, replies) {
  log('Checking inbox...');
  try {
    await page.goto('https://www.instagram.com/direct/inbox/', {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    await humanSleep(2000, 4000);

    // Get thread list
    const threads = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('div[role="listitem"]'));
      return items.slice(0, 20).map(el => {
        const link = el.querySelector('a');
        const href = link?.href || '';
        const m    = href.match(/\/direct\/t\/(\d+)/);
        const name = el.querySelector('img')?.alt || '';
        return { threadId: m?.[1] || '', username: name.replace("'s profile photo", '').trim() };
      }).filter(t => t.threadId && t.username);
    });

    let newReplies = 0;
    for (const thread of threads) {
      if (!processed.has(thread.username)) continue;
      if (replies[thread.username]) continue;
      // Open thread and read last message
      try {
        await page.goto(`https://www.instagram.com/direct/t/${thread.threadId}/`, {
          waitUntil: 'domcontentloaded', timeout: 20000
        });
        await humanSleep(1500, 3000);
        const lastMsg = await page.evaluate(() => {
          const msgs = Array.from(document.querySelectorAll('div[dir="auto"]:not([aria-hidden="true"])'));
          return msgs[msgs.length - 1]?.innerText?.trim() || '';
        });
        if (lastMsg) {
          replies[thread.username] = lastMsg;
          saveJson(REPLIES_FILE, replies);
          log(`REPLY from @${thread.username}: ${lastMsg.slice(0, 80)}`, 'success');
          newReplies++;
        }
      } catch {}
      await humanSleep(1000, 2000);
    }
    log(`Inbox checked — ${Object.keys(replies).length} total replies (${newReplies} new)`);
  } catch(e) { log(`Inbox error: ${e.message}`, 'warn'); }
  return replies;
}

// ── Wait between DMs ─────────────────────────────────────────────
async function waitBetweenDMs(dmNum) {
  let base = rand(60000, 180000); // 1–3 min
  base *= (1.0 + dmNum * 0.06);  // fatigue factor
  if (Math.random() < 0.15) {
    const extra = rand(60000, 300000);
    base += extra;
    log(`Taking a longer break (${Math.round(base/1000)}s total)`);
  } else {
    log(`Waiting ${Math.round(base/1000)}s before next DM`);
  }
  await sleep(base);
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  if (!IG_USERNAME || !IG_PASSWORD) {
    log('ERROR: IG_USERNAME and IG_PASSWORD required!', 'error');
    process.exit(1);
  }

  log(`=== InstaReach Playwright: ${CAMPAIGN_NAME} ===`);
  log(`Account: @${IG_USERNAME} | Keywords: ${ALL_KEYWORDS.length}`);

  const stats = loadStats();
  const [canRun, todayCount] = checkDailyLimit(stats);
  if (!canRun) return;

  const actualMax  = Math.min(MAX_DMS, 30 - todayCount);
  log(`This session: up to ${actualMax} DMs`);

  const browser = await launchBrowser();
  let context;

  try {
    context = await getContext(browser);
    if (!context) { log('Could not create browser context. Exiting.', 'error'); await browser.close(); return; }

    const page = context.pages()[0] || await context.newPage();
    await applyStealthPatches(page);

    const processed = loadSet(PROCESSED_FILE);
    let   replies   = loadJson(REPLIES_FILE, {});
    log(`Lifetime DMed: ${processed.size} | Replies: ${Object.keys(replies).length}`);

    // Warmup — random browse
    await humanSleep(10000, 25000);
    await page.goto('https://www.instagram.com/', { waitUntil:'domcontentloaded', timeout:30000 });
    await humanSleep(3000, 6000);

    // Check inbox first
    if (processed.size > 0) {
      replies = await checkInbox(page, processed, replies);
    }

    // Collect targets
    log('Searching targets...');
    const targets = [];
    for (let i = 0; i < ALL_KEYWORDS.length; i++) {
      const kw    = ALL_KEYWORDS[i];
      const found = kw.startsWith('#')
        ? await searchHashtag(page, kw)
        : await searchUsers(page, kw);
      const fresh = found.filter(u =>
        !processed.has(u) && !targets.includes(u) &&
        !replies[u] && u !== IG_USERNAME
      );
      if (fresh.length) log(`"${kw}" -> ${fresh.length} new`);
      targets.push(...fresh);
      await humanSleep(3000, 10000);
      if (i % 3 === 2) await humanSleep(8000, 15000);
      if (targets.length >= 50) break;
    }

    log(`Total targets: ${targets.length}`);
    if (targets.length === 0) { log('No new targets found.', 'warn'); return; }

    // Shuffle
    targets.sort(() => Math.random() - 0.5);
    log(`Starting DMs (max ${actualMax})...`);

    let dmCount    = 0;
    let consecFail = 0;
    const today    = new Date().toISOString().slice(0, 10);

    for (const username of targets) {
      if (dmCount >= actualMax) { log(`Session limit: ${actualMax}. Run again in 2-3 hours.`, 'warn'); break; }
      if (processed.has(username)) continue;
      if (consecFail >= 3) {
        log('3 consecutive failures — pausing 10 min...', 'warn');
        await sleep(600000);
        consecFail = 0;
      }

      const msg    = await groqEnhance(username);
      log(`Sending DM to @${username}...`);
      let   result = await sendDM(page, username, msg);

      if (result === 'relogin') {
        log('Session expired — re-logging in...', 'warn');
        await context.close();
        context = await doLogin(browser);
        if (!context) { log('Re-login failed. Stopping.', 'error'); break; }
        const newPage = context.pages()[0] || await context.newPage();
        await applyStealthPatches(newPage);
        result = await sendDM(newPage, username, msg);
      }

      if (result === 'sent') {
        dmCount++;
        consecFail = 0;
        processed.add(username);
        saveSet(PROCESSED_FILE, processed);
        stats[`sent_${today}`] = (stats[`sent_${today}`] || 0) + 1;
        stats['total_sent']    = (stats['total_sent']    || 0) + 1;
        saveStats(stats);
        log(`DM sent -> @${username} (${dmCount}/${actualMax}) | Today: ${stats[`sent_${today}`]}/30`, 'success');

        if (dmCount % 5 === 0) {
          await sleep(rand(120000, 240000));
          const p2 = context.pages()[0] || await context.newPage();
          replies = await checkInbox(p2, processed, replies);
        } else {
          await waitBetweenDMs(dmCount);
        }

      } else if (result === 'skip') {
        processed.add(username);
        saveSet(PROCESSED_FILE, processed);
        await humanSleep(3000, 8000);
      } else {
        consecFail++;
        log(`Failed @${username} (#${consecFail})`, 'warn');
        await humanSleep(20000, 45000);
      }
    }

    // Final inbox check
    if (dmCount > 0) {
      await sleep(10000);
      const fp = context.pages()[0] || await context.newPage();
      replies = await checkInbox(fp, processed, replies);
    }

    stats['sessions']      = (stats['sessions']      || 0) + 1;
    stats['last_run']      = new Date().toISOString();
    stats['total_replies'] = Object.keys(replies).length;
    saveStats(stats);

    const total = stats['total_sent'] || 1;
    const rate  = ((Object.keys(replies).length / total) * 100).toFixed(1);
    log(`=== Done! ${dmCount} DMs sent ===`, 'success');
    log(`Lifetime: ${total} sent | ${Object.keys(replies).length} replies (${rate}% reply rate)`);
    log('Run again in 2-3 hours for next batch');

  } finally {
    if (context) await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch(e => { log(`Fatal: ${e.message}`, 'error'); process.exit(1); });
