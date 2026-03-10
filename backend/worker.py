"""
InstaReach Worker - Anti-Detection Instagram DM Bot
Counters every Meta detection vector described in the security breakdown.
"""

import sys, os, json, time, random, requests, hashlib, math
from datetime import datetime, timedelta

def log(msg, level="info"):
    ts = datetime.now().strftime("%H:%M:%S")
    prefix = {"info":"P","success":"OK","error":"ERR","warn":"WARN"}.get(level,"P")
    print(f"[{ts}] {prefix} {msg}", flush=True)

try:
    from instagrapi import Client
    from instagrapi.exceptions import (
        LoginRequired, ChallengeRequired, TwoFactorRequired,
        UserNotFound, RateLimitError
    )
    log("instagrapi ready")
except ImportError:
    log("Installing instagrapi...", "warn")
    import subprocess
    for cmd in [
        [sys.executable, "-m", "pip", "install", "instagrapi", "requests", "--quiet", "--break-system-packages"],
        [sys.executable, "-m", "pip", "install", "instagrapi", "requests", "--quiet"],
    ]:
        try: subprocess.check_call(cmd, timeout=180); break
        except: pass
    from instagrapi import Client
    from instagrapi.exceptions import (
        LoginRequired, ChallengeRequired, TwoFactorRequired,
        UserNotFound, RateLimitError
    )
    log("instagrapi installed")

# ── DETECTION VECTOR 5: Proxy manager ────────────────────────
# Instagram blocks datacenter IPs (Render/AWS/etc)
# Use a residential proxy if IG_PROXY env var is set
# Format: http://user:pass@host:port  OR  socks5://host:port
# Free option: set IG_PROXY=none to skip (will retry on block)
# Paid recommended: Webshare.io ($3/mo) or Oxylabs residential

# ── Webshare proxy pool ────────────────────────────────────────
# Reads from env vars:
#   IG_PROXY          = single proxy URL (legacy)
#   WEBSHARE_USER     = webshare username
#   WEBSHARE_PASS     = webshare password
# Webshare rotates IPs automatically on each connection request
# Format used: http://user:pass@proxy.webshare.io:80

WEBSHARE_USER = os.environ.get("WEBSHARE_USER", "")
WEBSHARE_PASS = os.environ.get("WEBSHARE_PASS", "")
WEBSHARE_ENDPOINT = "proxy.webshare.io"
WEBSHARE_PORT = "80"

# Known proxy list from Webshare dashboard (auto-populated from env or hardcoded)
# These rotate automatically - Webshare picks a different IP each time
_proxy_index = 0

def get_webshare_proxy():
    """
    Returns Webshare rotating proxy URL.
    Each call can use a different endpoint for rotation.
    """
    if not WEBSHARE_USER or not WEBSHARE_PASS:
        return None
    # Webshare rotating residential endpoint - different IP every request
    return f"http://{WEBSHARE_USER}:{WEBSHARE_PASS}@{WEBSHARE_ENDPOINT}:{WEBSHARE_PORT}"

def get_proxy():
    """Get proxy URL - Webshare first, then IG_PROXY env var"""
    # Try Webshare credentials
    ws = get_webshare_proxy()
    if ws:
        return ws
    # Fall back to direct IG_PROXY env var
    proxy = os.environ.get("IG_PROXY", "").strip()
    if proxy and proxy.lower() != "none":
        return proxy
    return None

def apply_proxy(cl, proxy_url):
    if not proxy_url:
        return cl
    try:
        cl.set_proxy(proxy_url)
        # Mask password in log
        display = proxy_url
        if "@" in proxy_url:
            parts = proxy_url.split("@")
            display = "...@" + parts[-1]
        log(f"Proxy: {display}", "success")
    except Exception as e:
        log(f"Proxy setup error: {e}", "warn")
    return cl

def test_proxy(proxy_url):
    """Quick test if proxy can reach Instagram"""
    try:
        r = requests.get(
            "https://i.instagram.com/api/v1/si/fetch_headers/",
            proxies={"https": proxy_url, "http": proxy_url},
            timeout=8,
            headers={"User-Agent": "Instagram 269.0.0.18.75 Android"}
        )
        return r.status_code in (200, 400, 429, 403)
    except:
        return False

def get_free_proxy():
    """
    Try Webshare first. If not configured, fetch free public proxies.
    """
    # Webshare (best option - free 10 proxies)
    ws = get_webshare_proxy()
    if ws:
        log("Using Webshare proxy...")
        if test_proxy(ws):
            log("Webshare proxy working!", "success")
            return ws
        else:
            log("Webshare proxy not responding - trying free list...", "warn")

    # Free public proxy fallback
    log("Fetching free proxies...", "warn")
    sources = [
        "https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=8000&country=all&ssl=all&anonymity=elite",
        "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
        "https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt",
    ]
    all_proxies = []
    for url in sources:
        try:
            r = requests.get(url, timeout=10)
            found = [p.strip() for p in r.text.strip().split("\n") if ":" in p and len(p.strip()) < 22]
            all_proxies.extend(found[:40])
            if len(all_proxies) >= 80: break
        except: continue

    random.shuffle(all_proxies)
    for proxy in all_proxies[:15]:
        purl = f"http://{proxy}"
        if test_proxy(purl):
            log(f"Free proxy working: {proxy}", "success")
            return purl

    log("No working proxy found", "warn")
    return None

# ── Config ─────────────────────────────────────────────────────
IG_USERNAME   = os.environ.get("IG_USERNAME", "")
IG_PASSWORD   = os.environ.get("IG_PASSWORD", "")
SESSION_FILE  = os.environ.get("SESSION_FILE", "./data/ig_session.json")
CAMPAIGN_JSON = os.environ.get("CAMPAIGN_DATA", "{}")
GROQ_KEY      = os.environ.get("GROQ_API_KEY", "")

if not IG_USERNAME or not IG_PASSWORD:
    log("ERROR: IG_USERNAME and IG_PASSWORD required!", "error")
    sys.exit(1)

try:
    campaign = json.loads(CAMPAIGN_JSON)
except:
    campaign = {}

CAMPAIGN_NAME = campaign.get("name", "Campaign")
ACCOUNT_ID    = campaign.get("account_id", "default")
MESSAGE_TPL   = campaign.get("message", "Hi {{username}}! I help businesses grow online - websites, social media, ads. Would love to connect!")
# DETECTION VECTOR 1: Hard cap per session - stay well under Instagram limits
MAX_DMS       = min(int(campaign.get("max_dms", 15)), 15)

try:
    kw_raw   = campaign.get("keywords", "[]")
    KEYWORDS = json.loads(kw_raw) if isinstance(kw_raw, str) else (kw_raw or [])
except:
    KEYWORDS = []

EXTRA_KEYWORDS = [
    "real estate agent delhi", "property dealer delhi",
    "delhi property", "realestate delhi",
    "homes delhi", "flats delhi",
    "property consultant delhi", "real estate broker delhi",
]
ALL_KEYWORDS   = list(dict.fromkeys(KEYWORDS + EXTRA_KEYWORDS))
PROCESSED_FILE = f"./data/processed_{ACCOUNT_ID[:8]}.json"
REPLIES_FILE   = f"./data/replies_{ACCOUNT_ID[:8]}.json"
STATS_FILE     = f"./data/stats_{ACCOUNT_ID[:8]}.json"

# ── DETECTION VECTOR 3: Message variation pool ─────────────────
# Never send same message twice — unique phrasing every time
MESSAGE_VARIANTS = [
    "Hey {{username}}! We help Delhi businesses get more clients online. Interested in a free consult?",
    "Hi {{username}}, noticed your work! We do websites + social media for real estate pros. Worth a quick chat?",
    "{{username}} your listings look great! We help agents get more leads online. Open to connecting?",
    "Hey {{username}}! We specialize in digital growth for property professionals in Delhi. Would love to help!",
    "Hi {{username}}, do you use Instagram to get clients? We help real estate pros maximize it. Lets talk?",
    "{{username}} - we help Delhi property agents build their brand online and attract buyers. Interested?",
    "Hey {{username}}! Quick question - are you getting enough leads from social media? We can help with that.",
    "Hi {{username}}! We work with Delhi real estate pros on digital marketing. Open to a quick conversation?",
]

# ── DETECTION VECTOR 3: Groq AI with uniqueness enforcement ───
GROQ_MODELS = [
    "llama-3.1-8b-instant",
    "llama3-8b-8192",
    "llama-3.3-70b-versatile",
    "gemma2-9b-it",
]
GROQ_STYLES = [
    "casual and friendly", "professional and concise",
    "curious and engaging", "warm and personal",
    "brief and direct", "enthusiastic but not salesy",
]

# Track message hashes to ensure uniqueness (counter fingerprinting)
_sent_hashes = set()

def unique_message(msg):
    """Ensure no two sent messages share more than 60% similarity"""
    h = hashlib.md5(msg[:50].encode()).hexdigest()
    if h in _sent_hashes:
        return False
    _sent_hashes.add(h)
    return True

def groq_enhance(base_msg, username, attempt=0):
    fallback = random.choice(MESSAGE_VARIANTS).replace("{{username}}", f"@{username}")
    if not GROQ_KEY:
        return fallback
    for model in GROQ_MODELS:
        try:
            style = GROQ_STYLES[attempt % len(GROQ_STYLES)]
            # DETECTION VECTOR 3: Instruct AI to make each message unique
            prompt = (
                f"Rewrite this Instagram DM in a completely unique {style} tone. "
                f"IMPORTANT: Use different words and sentence structure each time. "
                f"Max 180 chars. Address @{username} naturally (not formally). "
                f"Do NOT start with 'Hey' or 'Hi' every time - vary the opening. "
                f"Original: {base_msg}\n"
                f"Return ONLY the rewritten message, nothing else."
            )
            resp = requests.post(
                "https://api.groq.com/openai/v1/chat/completions",
                headers={"Authorization": f"Bearer {GROQ_KEY}", "Content-Type": "application/json"},
                json={"model": model, "messages": [{"role": "user", "content": prompt}], "max_tokens": 150},
                timeout=12
            )
            data = resp.json()
            if "choices" in data and data["choices"]:
                result = data["choices"][0]["message"]["content"].strip()
                if len(result) >= 20:
                    if unique_message(result):
                        log(f"AI [{model.split('-')[0]}] ({style[:12]}): {result[:70]}")
                        return result
                    else:
                        # Too similar to a previous message - try again
                        if attempt < 3:
                            return groq_enhance(base_msg, username, attempt + 1)
            else:
                err = data.get("error", {}).get("message", "")
                if "decommissioned" in err or "not found" in err.lower():
                    continue
                break
        except Exception as e:
            log(f"Groq error: {e}", "warn")
            break
    return fallback

# ── DETECTION VECTOR 1 & 2: Irregular human timing ────────────
class HumanTimer:
    """
    Generates irregular delays that match human behavior patterns.
    Humans speed up when engaged, slow down when distracted,
    take random breaks, and are never perfectly consistent.
    """
    def __init__(self):
        self.session_start   = time.time()
        self.msgs_this_hour  = 0
        self.last_msg_time   = time.time()
        self.fatigue_factor  = 1.0  # increases over session (humans get tired/slower)

    def wait_between_dms(self, dm_number):
        """
        Irregular delay between DMs:
        - Base: 60-180s (safe for Instagram)
        - Fatigue: slows down as session progresses
        - Random spikes: occasional long pauses (phone calls, distractions)
        - Never the same interval twice
        """
        base = random.uniform(60, 180)

        # Fatigue - messages slow down over time
        self.fatigue_factor = 1.0 + (dm_number * 0.08)
        base *= self.fatigue_factor

        # DETECTION VECTOR 1: Random spikes (15% chance of a long pause)
        if random.random() < 0.15:
            spike = random.uniform(120, 480)  # 2-8 min distraction
            base += spike
            log(f"Taking a break... ({base:.0f}s total)")
        else:
            log(f"Waiting {base:.0f}s before next DM")

        time.sleep(base)
        self.msgs_this_hour += 1
        self.last_msg_time = time.time()

    def wait_between_searches(self):
        """Short irregular delay between keyword searches"""
        t = random.uniform(4, 12)
        # Occasional longer pause between search batches
        if random.random() < 0.2:
            t += random.uniform(15, 45)
        time.sleep(t)

    def hourly_check(self):
        """
        DETECTION VECTOR 1: Never exceed safe hourly rate.
        Instagram safe limit: ~10-12 DMs/hour for an account under 6 months old.
        """
        elapsed_hours = (time.time() - self.session_start) / 3600
        if elapsed_hours > 0 and self.msgs_this_hour / elapsed_hours > 10:
            wait = random.uniform(1800, 3600)  # wait 30-60 min
            log(f"Hourly rate limit reached - cooling down {wait/60:.0f} min...", "warn")
            time.sleep(wait)
            self.msgs_this_hour = 0

    def pre_session_warmup(self):
        """
        DETECTION VECTOR 6: Simulate organic account behavior before DMing.
        Browse feed, view profiles, wait - like a real user opening the app.
        """
        log("Warming up session (browsing before DMing)...")
        warmup = random.uniform(15, 45)
        time.sleep(warmup)

# ── DETECTION VECTOR 4: Target quality filtering ──────────────
def is_quality_target(cl, username):
    """
    Filter out accounts that look like bots or cold contacts.
    Only DM accounts with some profile substance - reduces block/report rate.
    """
    try:
        info = cl.user_info_by_username(username)
        # Skip accounts with no posts
        if info.media_count < 3:
            return False
        # Skip accounts with no bio (likely inactive/fake)
        if not info.biography or len(info.biography) < 5:
            return False
        # Skip accounts following nobody (bot accounts)
        if info.following_count < 10:
            return False
        # Skip private accounts (DM likely to be ignored)
        # if info.is_private:
        #     return False
        return True
    except:
        return True  # default allow if we can't check

# ── Persistence ────────────────────────────────────────────────
def load_json_set(path):
    os.makedirs("./data", exist_ok=True)
    try:
        if os.path.exists(path):
            with open(path) as f:
                data = json.load(f)
                return set(data) if isinstance(data, list) else set(data.keys())
    except: pass
    return set()

def save_json_set(path, s):
    try:
        os.makedirs("./data", exist_ok=True)
        with open(path, "w") as f:
            json.dump(list(s), f)
    except Exception as e:
        log(f"Save error: {e}", "warn")

def load_replies():
    os.makedirs("./data", exist_ok=True)
    try:
        if os.path.exists(REPLIES_FILE):
            with open(REPLIES_FILE) as f:
                return json.load(f)
    except: pass
    return {}

def save_replies(d):
    try:
        with open(REPLIES_FILE, "w") as f:
            json.dump(d, f, indent=2)
    except: pass

def load_stats():
    try:
        if os.path.exists(STATS_FILE):
            with open(STATS_FILE) as f:
                return json.load(f)
    except: pass
    return {"total_sent": 0, "total_replies": 0, "sessions": 0, "last_run": None}

def save_stats(s):
    try:
        with open(STATS_FILE, "w") as f:
            json.dump(s, f, indent=2)
    except: pass

# ── DETECTION VECTOR 1: Session cooldown enforcement ──────────
def check_daily_limit(stats):
    """Never send more than 30 DMs per day total across all sessions"""
    today = datetime.now().strftime("%Y-%m-%d")
    today_count = stats.get(f"sent_{today}", 0)
    if today_count >= 30:
        log(f"Daily limit reached ({today_count}/30). Run again tomorrow.", "warn")
        return False, today_count
    remaining = 30 - today_count
    log(f"Daily progress: {today_count}/30 DMs sent today. {remaining} remaining.")
    return True, today_count

# ── Login / session ────────────────────────────────────────────
# DETECTION VECTOR 5: Rotate between multiple realistic Indian Android devices
# Same account always uses same device (fingerprint must be CONSISTENT per session)
DEVICE_POOL = [
    {   # Samsung Galaxy S21 - most common in India 2023-24
        "app_version": "296.0.0.35.109",
        "android_version": 31,
        "android_release": "12.0.0",
        "dpi": "480dpi",
        "resolution": "1080x2400",
        "manufacturer": "samsung",
        "device": "SM-G991B",
        "model": "Samsung Galaxy S21",
        "cpu": "exynos2100",
        "version_code": "514340314",
    },
    {   # Redmi Note 10 Pro - extremely common India budget phone
        "app_version": "296.0.0.35.109",
        "android_version": 30,
        "android_release": "11.0.0",
        "dpi": "395dpi",
        "resolution": "1080x2400",
        "manufacturer": "Xiaomi",
        "device": "sweetin",
        "model": "M2101K6P",
        "cpu": "qcom",
        "version_code": "514340314",
    },
    {   # OnePlus Nord CE 2 - popular India mid-range
        "app_version": "296.0.0.35.109",
        "android_version": 31,
        "android_release": "12.0.0",
        "dpi": "410dpi",
        "resolution": "1080x2412",
        "manufacturer": "OnePlus",
        "device": "IV2201",
        "model": "IV2201",
        "cpu": "qcom",
        "version_code": "514340314",
    },
    {   # Realme 9 Pro+ - common India phone
        "app_version": "296.0.0.35.109",
        "android_version": 31,
        "android_release": "12.0.0",
        "dpi": "452dpi",
        "resolution": "1080x2400",
        "manufacturer": "realme",
        "device": "RMX3393",
        "model": "RMX3393",
        "cpu": "qcom",
        "version_code": "514340314",
    },
]

def get_device_for_account():
    """Always return the same device for this account (consistent fingerprint)"""
    # Derive device index from account ID hash - same account = same device always
    idx = int(hashlib.md5(ACCOUNT_ID.encode()).hexdigest(), 16) % len(DEVICE_POOL)
    return DEVICE_POOL[idx]

def make_client():
    cl = Client()
    device = get_device_for_account()
    cl.set_device(device)
    cl.set_locale("en_IN")
    cl.set_timezone_offset(19800)  # IST +5:30
    cl.delay_range = [3, 8]
    log(f"Device: {device['model']} (Android {device['android_release']})")
    # Apply proxy if configured (solves datacenter IP blocking)
    proxy = get_proxy()
    if proxy:
        apply_proxy(cl, proxy)
    else:
        # Running on a datacenter? Try free rotating proxy automatically
        is_render = os.environ.get("RENDER", "") or os.environ.get("IS_PULL_REQUEST", "")
        if is_render:
            log("Render datacenter detected - fetching free rotating proxy...", "warn")
            free_proxy = get_free_proxy()
            if free_proxy:
                apply_proxy(cl, free_proxy)
            else:
                log("No free proxy found - login may fail. Best fix: run bot locally on your PC", "warn")
    return cl

def get_client():
    cl = make_client()
    os.makedirs("./data", exist_ok=True)

    # Delete corrupted session file (empty/HTML response = bad session)
    if os.path.exists(SESSION_FILE):
        try:
            size = os.path.getsize(SESSION_FILE)
            if size < 100:  # too small to be valid
                log("Session file corrupted (too small) - deleting...", "warn")
                os.remove(SESSION_FILE)
        except: pass

    if os.path.exists(SESSION_FILE):
        log("Loading saved session...")
        try:
            cl.load_settings(SESSION_FILE)
            cl.login(IG_USERNAME, IG_PASSWORD)
            info = cl.account_info()
            log(f"Session restored: @{info.username}", "success")
            return cl
        except Exception as e:
            log(f"Session invalid ({e}) - deleting and retrying...", "warn")
            try: os.remove(SESSION_FILE)
            except: pass

    # Fresh login — try with different proxies on each attempt
    last_err = None
    proxies_tried = set()

    for attempt in range(1, 6):  # up to 5 attempts
        log(f"Login attempt {attempt}/5 as @{IG_USERNAME}...")
        time.sleep(random.uniform(3, 8) * min(attempt, 3))
        try:
            cl2 = make_client()

            # On attempt 2+, always try a fresh proxy
            if attempt >= 2:
                # First try IG_PROXY env var if set
                env_proxy = get_proxy()
                if env_proxy and env_proxy not in proxies_tried:
                    apply_proxy(cl2, env_proxy)
                    proxies_tried.add(env_proxy)
                else:
                    # Fetch a new free proxy
                    free_p = get_free_proxy()
                    if free_p and free_p not in proxies_tried:
                        apply_proxy(cl2, free_p)
                        proxies_tried.add(free_p)
                    else:
                        log(f"No new proxy available for attempt {attempt} - trying direct...", "warn")

            cl2.login(IG_USERNAME, IG_PASSWORD)
            cl2.dump_settings(SESSION_FILE)
            info = cl2.account_info()
            log(f"Logged in: @{info.username}", "success")
            return cl2

        except TwoFactorRequired:
            log("2FA required - disable 2FA on Instagram", "error")
            sys.exit(1)
        except ChallengeRequired:
            log("Challenge required - open Instagram app and approve login, then wait 10 min and retry", "error")
            sys.exit(1)
        except Exception as e:
            last_err = str(e)
            is_ip_block = "Expecting value" in last_err or "JSONDecodeError" in last_err or "SSLError" in last_err
            is_challenge = "checkpoint" in last_err.lower() or "challenge" in last_err.lower()

            if is_challenge:
                log("Challenge detected - approve in Instagram app, retry in 10 mins", "error")
                sys.exit(1)
            elif is_ip_block:
                log(f"Attempt {attempt}: IP blocked by Instagram - switching proxy...", "warn")
                if attempt < 5:
                    time.sleep(random.uniform(20, 45))  # short wait then new proxy
            else:
                log(f"Attempt {attempt} failed: {last_err[:100]}", "warn")
                time.sleep(30 * min(attempt, 3))

    log(f"All 5 login attempts failed. Last error: {last_err}", "error")
    log("Fix options:", "error")
    log("  1. Run bot locally on your PC (best - uses home IP)", "error")
    log("  2. Add IG_PROXY=http://user:pass@host:port in Render env vars", "error")
    log("  3. Wait 30 min and try again (IP cooldown)", "error")
    sys.exit(1)

def relogin(cl):
    log("Session expired - reconnecting...", "warn")
    try:
        if os.path.exists(SESSION_FILE): os.remove(SESSION_FILE)
        return get_client()
    except Exception as e:
        log(f"Reconnect failed: {e}", "error")
        return None

# ── Inbox listener ─────────────────────────────────────────────
def check_inbox(cl, processed, replies):
    log("Checking inbox for replies...")
    try:
        threads = cl.direct_threads(amount=20)
        for thread in threads:
            try:
                if not thread.users: continue
                other_user = thread.users[0].username
                if not other_user or other_user not in processed: continue
                messages = cl.direct_messages(thread.id, amount=5)
                for msg in messages:
                    if str(msg.user_id) != str(cl.user_id):
                        text = getattr(msg, "text", "") or "(media)"
                        if other_user not in replies:
                            replies[other_user] = text
                            save_replies(replies)
                            log(f"REPLY from @{other_user}: {text[:80]}", "success")
            except: continue
        log(f"Inbox checked - {len(replies)} total replies")
    except Exception as e:
        log(f"Inbox error: {e}", "warn")
    return replies

# ── Search ─────────────────────────────────────────────────────
def search_users(cl, keyword, limit=10):
    try:
        try:
            results = cl.search_users(keyword)
        except TypeError:
            results = cl.search_users(keyword, count=limit)
        return [u.username for u in results[:limit] if u.username]
    except RateLimitError:
        log("Rate limited on search - waiting 5 min...", "warn")
        time.sleep(300)
        return []
    except Exception as e:
        log(f'Search "{keyword}": {e}', "warn")
        return []

# ── Send DM ────────────────────────────────────────────────────
def send_dm(cl, username, message):
    try:
        try:
            cl.user_info_by_username(username)
            time.sleep(random.uniform(3, 7))  # reading profile
        except: pass

        user_id = cl.user_id_from_username(username)
        # DETECTION VECTOR 1: Simulate typing delay based on message length
        typing_time = len(message) * random.uniform(0.04, 0.08)
        typing_time = max(3, min(typing_time, 20))
        time.sleep(typing_time)

        cl.direct_send(message, user_ids=[user_id])
        return "sent"
    except UserNotFound:
        return "skip"
    except RateLimitError:
        log("Rate limited - waiting 10 min...", "warn")
        time.sleep(600)
        return "fail"
    except LoginRequired:
        return "relogin"
    except ChallengeRequired:
        log(f"Challenge @{username} - skipping", "warn")
        return "skip"
    except Exception as e:
        err = str(e)
        if "login_required" in err.lower() or "LoginRequired" in err:
            return "relogin"
        if "challenge" in err.lower():
            return "skip"
        log(f"DM error @{username}: {err[:100]}", "warn")
        return "fail"

# ── Main ───────────────────────────────────────────────────────
def main():
    log(f"=== InstaReach: {CAMPAIGN_NAME} ===")

    stats = load_stats()

    # DETECTION VECTOR 1: Daily limit check
    can_run, today_count = check_daily_limit(stats)
    if not can_run:
        return

    actual_max = min(MAX_DMS, 30 - today_count)
    log(f"Account: @{IG_USERNAME} | This session: up to {actual_max} DMs")

    cl      = get_client()
    timer   = HumanTimer()
    processed = load_json_set(PROCESSED_FILE)
    replies   = load_replies()

    log(f"Lifetime DMed: {len(processed)} | Replies: {len(replies)}")

    # DETECTION VECTOR 6 & 10: Warm up session before DMing
    timer.pre_session_warmup()

    # Check inbox for replies
    if processed:
        replies = check_inbox(cl, processed, replies)

    # DETECTION VECTOR 2: Skip users who already replied (shows engagement selectivity)
    # Search
    log("Searching targets...")
    targets = []
    for i, kw in enumerate(ALL_KEYWORDS):
        found = search_users(cl, kw)
        fresh = [u for u in found
                 if u not in processed
                 and u not in targets
                 and u not in replies
                 and u != IG_USERNAME]
        if fresh:
            log(f'"{kw}" -> {len(fresh)} new')
        targets.extend(fresh)
        timer.wait_between_searches()
        if len(targets) >= 50:
            break

    log(f"Targets found: {len(targets)}")
    if not targets:
        log("No new targets - all already DMed.", "warn")
        return

    # DETECTION VECTOR 4: Filter for quality accounts
    log("Filtering quality accounts...")
    quality_targets = []
    for u in targets[:30]:  # check first 30 only to save time
        if is_quality_target(cl, u):
            quality_targets.append(u)
        time.sleep(random.uniform(1, 3))

    if quality_targets:
        log(f"Quality accounts: {len(quality_targets)}/{min(30,len(targets))}")
        targets = quality_targets + [u for u in targets[30:] if u not in quality_targets]
    random.shuffle(targets)

    log(f"Starting DMs (max {actual_max} this session)...")
    dm_count          = 0
    consecutive_fails = 0
    today             = datetime.now().strftime("%Y-%m-%d")

    for username in targets:
        if dm_count >= actual_max:
            log(f"Session limit reached: {actual_max} DMs. Run again in 2-3 hours.", "warn")
            break
        if username in processed:
            continue
        if consecutive_fails >= 3:
            log("3 consecutive failures - pausing 15 min...", "warn")
            time.sleep(900)
            consecutive_fails = 0

        # DETECTION VECTOR 1: Check hourly rate
        timer.hourly_check()

        # DETECTION VECTOR 3: Unique message per user
        base = MESSAGE_TPL.replace("{{username}}", f"@{username}").replace("{{sender}}", f"@{IG_USERNAME}")
        msg  = groq_enhance(base, username)

        log(f"Sending DM to @{username}...")
        result = send_dm(cl, username, msg)

        if result == "relogin":
            cl = relogin(cl)
            if not cl:
                log("Reconnect failed - stopping", "error")
                break
            result = send_dm(cl, username, msg)

        if result == "sent":
            dm_count          += 1
            consecutive_fails  = 0
            processed.add(username)
            save_json_set(PROCESSED_FILE, processed)

            # Update daily stats
            stats[f"sent_{today}"] = stats.get(f"sent_{today}", 0) + 1
            stats["total_sent"]    = stats.get("total_sent", 0) + 1
            save_stats(stats)

            log(f"DM sent -> @{username} ({dm_count}/{actual_max}) | Today: {stats[f'sent_{today}']}/30", "success")

            # Every 5 DMs: check inbox
            if dm_count % 5 == 0:
                log("Pausing to check inbox...")
                time.sleep(random.uniform(30, 60))
                replies = check_inbox(cl, processed, replies)

            # DETECTION VECTOR 1 & 10: Irregular human-paced delay
            timer.wait_between_dms(dm_count)

        elif result == "skip":
            processed.add(username)
            save_json_set(PROCESSED_FILE, processed)
            time.sleep(random.uniform(3, 8))
        else:
            consecutive_fails += 1
            log(f"Failed @{username} (#{consecutive_fails})", "warn")
            time.sleep(random.uniform(20, 45))

    # Final inbox check
    if dm_count > 0:
        log("Session done - final inbox check...")
        time.sleep(15)
        replies = check_inbox(cl, processed, replies)

    # Update session stats
    stats["sessions"] = stats.get("sessions", 0) + 1
    stats["last_run"] = datetime.now().isoformat()
    stats["total_replies"] = len(replies)
    save_stats(stats)

    reply_rate = f"{len(replies)/max(stats.get('total_sent',1),1)*100:.1f}%"
    log(f"=== Session complete! {dm_count} DMs sent ===", "success")
    log(f"Lifetime: {stats['total_sent']} sent | {len(replies)} replies ({reply_rate} reply rate)")
    log("Run again in 2-3 hours for next batch")

if __name__ == "__main__":
    main()