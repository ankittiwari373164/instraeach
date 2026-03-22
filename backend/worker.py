"""
InstaReach Worker v5 — All 10 Meta Detection Vectors

V1  Volume & Velocity    — account-age ramp (2/5/10/20/day), weekly cap 5x, 2h session gap
V2  Recipient Behaviour  — reply-rate monitor (40%/65%/100% capacity), follower-priority queue
V3  Content Fingerprint  — micro-variation chars (em-dash, &/and, contractions), length jitter 160-210
V4  Network Graph        — optional pre-DM follow (20%), deep inbox thread read
V5  Device Fingerprint   — persistent UUIDs (device_id, phone_id, advertising_id, android_id)
V6  TLS / HTTP           — instagrapi mobile API, correct headers
V7  Behavioural Baseline — HumanTimer with fatigue, typing simulation, warmup browsing
V8  IP Reputation        — Webshare proxy rotation with fallback
V9  Reported Feedback    — exponential backoff: 1h/2h/4h/8h/24h, -1 level per 3 clean sessions
V10 ML Baseline          — niche hashtag explore browsing, inbox read simulation
"""

import sys, os, json, time, random, requests, hashlib, re
from datetime import datetime, timedelta

# ── Logging ─────────────────────────────────────────────────────
def log(msg, level="info"):
    ts     = datetime.now().strftime("%H:%M:%S")
    prefix = {"info":"P","success":"OK","error":"ERR","warn":"WARN"}.get(level,"P")
    print(f"[{ts}] {prefix} {msg}", flush=True)

# ── Install instagrapi ───────────────────────────────────────────
try:
    from instagrapi import Client
    from instagrapi.exceptions import (
        LoginRequired, ChallengeRequired, TwoFactorRequired,
        UserNotFound, RateLimitError, MediaNotFound
    )
    log("instagrapi ready")
except ImportError:
    log("Installing instagrapi...", "warn")
    import subprocess
    ok = False
    for cmd in [
        [sys.executable,"-m","pip","install","instagrapi==2.1.2","requests","--quiet","--break-system-packages"],
        [sys.executable,"-m","pip","install","instagrapi==2.1.2","requests","--quiet"],
        ["pip3","install","instagrapi==2.1.2","requests","--quiet","--break-system-packages"],
        ["pip3","install","instagrapi==2.1.2","requests","--quiet"],
    ]:
        try:
            r = subprocess.run(cmd, timeout=180, capture_output=True, text=True)
            if r.returncode == 0:
                log(f"Installed via {cmd[0]}", "success")
                ok = True; break
            log(f"pip: {r.stderr[:60]}", "warn")
        except Exception as e:
            log(f"pip error: {e}", "warn")
    if not ok:
        log("FATAL: cannot install instagrapi", "error")
        sys.exit(1)
    from instagrapi import Client
    from instagrapi.exceptions import (
        LoginRequired, ChallengeRequired, TwoFactorRequired,
        UserNotFound, RateLimitError, MediaNotFound
    )
    log("instagrapi installed", "success")

os.makedirs("./data", exist_ok=True)

# ── Config ───────────────────────────────────────────────────────
IG_USERNAME   = os.environ.get("IG_USERNAME","").strip().lstrip("@").lower()
IG_PASSWORD   = os.environ.get("IG_PASSWORD","")
SESSION_FILE  = os.environ.get("SESSION_FILE","./data/ig_session.json")
GROQ_KEY      = os.environ.get("GROQ_API_KEY","")
WEBSHARE_USER = os.environ.get("WEBSHARE_USER","")
WEBSHARE_PASS = os.environ.get("WEBSHARE_PASS","")

if not IG_USERNAME or not IG_PASSWORD:
    log("ERROR: IG_USERNAME and IG_PASSWORD required!", "error")
    sys.exit(1)

try:
    campaign = json.loads(os.environ.get("CAMPAIGN_DATA","{}"))
except:
    campaign = {}

CAMPAIGN_NAME = campaign.get("name","Campaign")
ACCOUNT_ID    = campaign.get("account_id","default")
MESSAGE_TPL   = campaign.get("message","Hi {{username}}! I help Delhi businesses grow online with websites, social media and ads. Interested?")
MAX_DMS       = min(int(campaign.get("max_dms",15)), 15)

try:
    kw_raw   = campaign.get("keywords","[]")
    KEYWORDS = json.loads(kw_raw) if isinstance(kw_raw,str) else (kw_raw or [])
except:
    KEYWORDS = []

EXTRA_KEYWORDS = [
    "real estate agent delhi","property dealer delhi",
    "delhi property","realestate delhi","homes delhi","flats delhi",
    "property consultant delhi","real estate broker delhi",
    "digital marketing delhi","website design delhi",
]
ALL_KEYWORDS = list(dict.fromkeys(KEYWORDS + EXTRA_KEYWORDS))

# File paths keyed by account
_h = hashlib.md5(IG_USERNAME.encode()).hexdigest()[:8]
PROCESSED_FILE = f"./data/processed_{_h}.json"
REPLIES_FILE   = f"./data/replies_{_h}.json"
STATS_FILE     = f"./data/stats_{_h}.json"
DEVICE_FILE    = f"./data/device_{_h}.json"
SIGNAL_FILE    = f"./data/signal_{_h}.json"
INBOX_FILE     = f"./data/inbox_{_h}.json"

# ────────────────────────────────────────────────────────────────
# VECTOR 5 — Persistent Device UUIDs
# Generated once from account hash, never change between sessions
# ────────────────────────────────────────────────────────────────
def _uuid_from_seed(seed):
    h = hashlib.sha256(seed.encode()).hexdigest()
    return f"{h[0:8]}-{h[8:12]}-4{h[13:16]}-{h[16:20]}-{h[20:32]}"

def get_device_ids():
    if os.path.exists(DEVICE_FILE):
        try:
            with open(DEVICE_FILE) as f: return json.load(f)
        except: pass
    ids = {
        "device_id":      _uuid_from_seed(_h + "device"),
        "phone_id":       _uuid_from_seed(_h + "phone"),
        "advertising_id": _uuid_from_seed(_h + "adv"),
        "android_id":     hashlib.md5((_h + "android").encode()).hexdigest()[:16],
        "created_at":     datetime.now().isoformat(),
    }
    with open(DEVICE_FILE,"w") as f: json.dump(ids, f, indent=2)
    log(f"V5: Device IDs generated -> {DEVICE_FILE}")
    return ids

DEVICE_IDS = get_device_ids()

# Full device pool for instagrapi — consistent device per account via hash index
DEVICE_POOL = [
    {"app_version":"296.0.0.35.109","android_version":31,"android_release":"12.0.0",
     "dpi":"480dpi","resolution":"1080x2400","manufacturer":"samsung",
     "device":"SM-G991B","model":"Samsung Galaxy S21","cpu":"exynos2100","version_code":"514340314"},
    {"app_version":"296.0.0.35.109","android_version":30,"android_release":"11.0.0",
     "dpi":"395dpi","resolution":"1080x2400","manufacturer":"Xiaomi",
     "device":"sweetin","model":"M2101K6P","cpu":"qcom","version_code":"514340314"},
    {"app_version":"296.0.0.35.109","android_version":31,"android_release":"12.0.0",
     "dpi":"410dpi","resolution":"1080x2412","manufacturer":"OnePlus",
     "device":"IV2201","model":"IV2201","cpu":"qcom","version_code":"514340314"},
    {"app_version":"296.0.0.35.109","android_version":31,"android_release":"12.0.0",
     "dpi":"452dpi","resolution":"1080x2400","manufacturer":"realme",
     "device":"RMX3393","model":"RMX3393","cpu":"qcom","version_code":"514340314"},
]
_device_idx = int(hashlib.md5(ACCOUNT_ID.encode()).hexdigest(), 16) % len(DEVICE_POOL)
MY_DEVICE   = DEVICE_POOL[_device_idx]

# ────────────────────────────────────────────────────────────────
# VECTOR 9 — Exponential Backoff on Block Signals
# 1h → 2h → 4h → 8h → 16h → 24h cap
# 3 consecutive clean sessions reduces level by 1
# ────────────────────────────────────────────────────────────────
def _load_signal():
    try:
        if os.path.exists(SIGNAL_FILE):
            with open(SIGNAL_FILE) as f: return json.load(f)
    except: pass
    return {"blocks":0,"cooldown_until":None,"clean_sessions":0}

def _save_signal(s):
    with open(SIGNAL_FILE,"w") as f: json.dump(s, f, indent=2)

def record_block():
    s = _load_signal()
    s["blocks"] = s.get("blocks",0) + 1
    s["clean_sessions"] = 0
    hours = min(2 ** (s["blocks"] - 1), 24)   # 1,2,4,8,16,24
    s["cooldown_until"] = (datetime.now() + timedelta(hours=hours)).isoformat()
    _save_signal(s)
    log(f"V9: Block #{s['blocks']} — cooldown {hours}h until {s['cooldown_until'][:16]}", "warn")
    return hours

def record_clean_session():
    s = _load_signal()
    s["clean_sessions"] = s.get("clean_sessions",0) + 1
    if s["clean_sessions"] >= 3 and s.get("blocks",0) > 0:
        s["blocks"] = max(0, s["blocks"] - 1)
        s["clean_sessions"] = 0
        log(f"V9: 3 clean sessions - backoff reduced to level {s['blocks']}")
    _save_signal(s)

def check_cooldown():
    s = _load_signal()
    if not s.get("cooldown_until"): return True
    until = datetime.fromisoformat(s["cooldown_until"])
    if datetime.now() < until:
        mins = int((until - datetime.now()).total_seconds() / 60)
        log(f"V9: In cooldown — {mins}min remaining (block level {s.get('blocks',0)})", "warn")
        return False
    return True

# ────────────────────────────────────────────────────────────────
# VECTOR 1 — Volume & Velocity Guards
# ────────────────────────────────────────────────────────────────
def _read_stats():
    try:
        if os.path.exists(STATS_FILE):
            with open(STATS_FILE) as f: return json.load(f)
    except: pass
    return {"total_sent":0,"total_replies":0,"sessions":[],"daily":{},"weekly":[]}

def _write_stats(s):
    with open(STATS_FILE,"w") as f: json.dump(s, f, indent=2)

def get_account_age_days(stats):
    if not stats.get("first_seen"):
        stats["first_seen"] = datetime.now().isoformat()
        _write_stats(stats)
    return (datetime.now() - datetime.fromisoformat(stats["first_seen"])).days

def get_daily_cap(stats):
    age = get_account_age_days(stats)
    if age < 7:   return 2
    if age < 30:  return 5
    if age < 90:  return 10
    return 20

def get_daily_count(stats):
    today = datetime.now().strftime("%Y-%m-%d")
    return stats.get("daily",{}).get(today, 0)

def get_weekly_count(stats):
    cutoff = datetime.now() - timedelta(days=7)
    return sum(1 for ts in stats.get("weekly",[])
               if datetime.fromisoformat(ts) > cutoff)

def check_session_gap(stats):
    sessions = stats.get("sessions",[])
    if not sessions: return True
    last = datetime.fromisoformat(sessions[-1])
    gap_h = (datetime.now() - last).total_seconds() / 3600
    if gap_h < 2:
        log(f"V1: Last session {gap_h*60:.0f}min ago — 2h minimum required", "warn")
        return False
    return True

def check_volume_guards(stats):
    daily     = get_daily_count(stats)
    daily_cap = get_daily_cap(stats)
    weekly    = get_weekly_count(stats)
    weekly_cap = daily_cap * 5
    age        = get_account_age_days(stats)
    log(f"V1: Age {age}d | Daily {daily}/{daily_cap} | Weekly {weekly}/{weekly_cap}")
    if daily >= daily_cap:
        log(f"V1: Daily cap reached ({daily}/{daily_cap})", "warn"); return False, 0
    if weekly >= weekly_cap:
        log(f"V1: Weekly cap reached ({weekly}/{weekly_cap})", "warn"); return False, 0
    if not check_session_gap(stats):
        return False, 0
    return True, min(daily_cap - daily, MAX_DMS)

def record_dm_sent(stats):
    today = datetime.now().strftime("%Y-%m-%d")
    stats.setdefault("daily",{})[today] = stats["daily"].get(today,0) + 1
    stats.setdefault("weekly",[]).append(datetime.now().isoformat())
    stats["weekly"] = stats["weekly"][-500:]
    stats["total_sent"] = stats.get("total_sent",0) + 1
    _write_stats(stats)

def record_session(stats):
    stats.setdefault("sessions",[]).append(datetime.now().isoformat())
    stats["sessions"] = stats["sessions"][-100:]
    _write_stats(stats)

# ────────────────────────────────────────────────────────────────
# VECTOR 2 — Reply Rate Monitor
# ────────────────────────────────────────────────────────────────
def get_capacity_multiplier(stats):
    total = stats.get("total_sent", 0)
    if total < 20: return 1.0
    rate = stats.get("total_replies",0) / max(total, 1)
    if rate < 0.01:
        log(f"V2: Reply rate {rate*100:.2f}% < 1% — capacity 40%", "warn"); return 0.40
    if rate < 0.03:
        log(f"V2: Reply rate {rate*100:.2f}% < 3% — capacity 65%", "warn"); return 0.65
    log(f"V2: Reply rate {rate*100:.2f}% — full capacity")
    return 1.0

# ────────────────────────────────────────────────────────────────
# VECTOR 3 — Micro-Variation + Length Jitter
# ────────────────────────────────────────────────────────────────
SUBSTITUTIONS = [
    (" - ",    [" — ", " - ", " – "]),
    (" and ",  [" & ", " and ", " + "]),
    ("don't",  ["don't", "do not", "dont"]),
    ("can't",  ["can't", "cannot"]),
    ("I'm",    ["I'm", "I am"]),
    ("it's",   ["it's", "it is"]),
    ("you're", ["you're", "you are"]),
    ("great",  ["great", "amazing", "incredible", "awesome"]),
    ("love",   ["love", "adore", "really like"]),
    ("!",      ["!", "!!"]),
    ("Hi",     ["Hi", "Hey", "Hello"]),
    ("Thanks", ["Thanks", "Thank you", "Cheers"]),
]

def micro_variate(text):
    result = text
    for original, variants in SUBSTITUTIONS:
        if original in result and random.random() < 0.55:
            result = result.replace(original, random.choice(variants), 1)
    return result

def length_jitter(text):
    limit = random.randint(160, 210)
    if len(text) <= limit: return text
    trimmed = text[:limit]
    last_space = trimmed.rfind(" ")
    return (trimmed[:last_space] if last_space > 0 else trimmed).rstrip() + "..."

# ────────────────────────────────────────────────────────────────
# VECTOR 7 — Human Timer (fatigue model)
# ────────────────────────────────────────────────────────────────
class HumanTimer:
    def __init__(self):
        self.dm_count    = 0
        self.session_start = time.time()

    def wait(self):
        base = random.uniform(60, 180)
        # Fatigue: 6% slower per DM sent
        fatigue = base * (1.0 + self.dm_count * 0.06)
        # 15% chance of longer break (simulating distraction)
        if random.random() < 0.15:
            fatigue += random.uniform(120, 300)
            log(f"V7: Extended break ({fatigue:.0f}s total)")
        else:
            log(f"V7: Waiting {fatigue:.0f}s before next DM")
        time.sleep(fatigue)
        self.dm_count += 1

    def warmup(self):
        """Simulate browsing before starting DMs"""
        t = random.uniform(15, 40)
        log(f"V7: Warmup browse ({t:.0f}s)...")
        time.sleep(t)

    def between_searches(self):
        time.sleep(random.uniform(3, 12))

    def fatigue_break(self):
        """Every 5 DMs take a longer break"""
        if self.dm_count > 0 and self.dm_count % 5 == 0:
            t = random.uniform(120, 240)
            log(f"V7: Fatigue break ({t:.0f}s)...")
            time.sleep(t)

_timer = HumanTimer()

# ────────────────────────────────────────────────────────────────
# VECTOR 8 — Proxy (Webshare rotation + free fallback)
# ────────────────────────────────────────────────────────────────
WEBSHARE_PROXIES = [
    ("31.59.20.176","6754"),  ("23.95.150.145","6114"),
    ("198.23.239.134","6540"),("45.38.107.97","6014"),
    ("107.172.163.27","6543"),("198.105.121.200","6462"),
    ("64.137.96.74","6641"),  ("216.10.27.159","6837"),
    ("142.111.67.146","5611"),
]

def test_proxy(url):
    try:
        r = requests.get(
            "https://i.instagram.com/api/v1/si/fetch_headers/",
            proxies={"https":url,"http":url}, timeout=8,
            headers={"User-Agent":"Instagram 269.0.0.18.75 Android"}
        )
        return r.status_code in (200,400,403,429)
    except: return False

def get_proxy(attempt=0):
    """V8: Try Webshare proxies in rotation, fall back to free list"""
    if WEBSHARE_USER and WEBSHARE_PASS:
        for i in range(len(WEBSHARE_PROXIES)):
            idx = (attempt + i) % len(WEBSHARE_PROXIES)
            host, port = WEBSHARE_PROXIES[idx]
            url = f"http://{WEBSHARE_USER}:{WEBSHARE_PASS}@{host}:{port}"
            log(f"V8: Testing Webshare {idx+1}/{len(WEBSHARE_PROXIES)}: {host}:{port}")
            if test_proxy(url):
                log(f"V8: Proxy OK: {host}:{port}", "success")
                return url
            time.sleep(1)
        log("V8: All Webshare proxies failed — trying free list", "warn")

    env_proxy = os.environ.get("IG_PROXY","").strip()
    if env_proxy and env_proxy.lower() != "none":
        return env_proxy

    log("V8: Fetching free proxies...", "warn")
    for src in [
        "https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=8000&country=all&ssl=all&anonymity=elite",
        "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
    ]:
        try:
            r = requests.get(src, timeout=10)
            proxies = [p.strip() for p in r.text.split("\n") if ":" in p and len(p.strip()) < 22]
            random.shuffle(proxies)
            for p in proxies[:12]:
                u = f"http://{p}"
                if test_proxy(u):
                    log(f"V8: Free proxy OK: {p}", "success")
                    return u
        except: continue
    log("V8: No working proxy found", "warn")
    return None

# ────────────────────────────────────────────────────────────────
# VECTOR 5/6 — instagrapi client with persistent device + proxy
# ────────────────────────────────────────────────────────────────
def make_client(proxy_url=None):
    cl = Client()
    cl.set_device(MY_DEVICE)
    cl.set_locale("en_IN")
    cl.set_timezone_offset(19800)  # IST +5:30
    cl.delay_range = [3, 8]
    # V5: inject persistent UUIDs
    cl.device_id      = DEVICE_IDS["device_id"]
    cl.phone_id       = DEVICE_IDS["phone_id"]
    cl.advertising_id = DEVICE_IDS["advertising_id"]
    cl.android_id     = DEVICE_IDS["android_id"]
    if proxy_url:
        try:
            cl.set_proxy(proxy_url)
            disp = ("...@" + proxy_url.split("@")[-1]) if "@" in proxy_url else proxy_url
            log(f"V8: Proxy: {disp}", "success")
        except Exception as e:
            log(f"V8: Proxy error: {e}", "warn")
    return cl

def get_client():
    os.makedirs("./data", exist_ok=True)

    # Validate & load session
    if os.path.exists(SESSION_FILE):
        try:
            size = os.path.getsize(SESSION_FILE)
            if size < 100:
                log("Session file too small — removing", "warn")
                os.remove(SESSION_FILE)
        except: pass

    if os.path.exists(SESSION_FILE):
        log("Loading saved session...")
        try:
            cl = make_client(get_proxy())
            cl.load_settings(SESSION_FILE)
            cl.login(IG_USERNAME, IG_PASSWORD)
            info = cl.account_info()
            log(f"Session restored: @{info.username}", "success")
            return cl
        except Exception as e:
            log(f"Session invalid ({str(e)[:60]}) — fresh login", "warn")
            try: os.remove(SESSION_FILE)
            except: pass

    # Fresh login with proxy rotation
    last_err = None
    for attempt in range(1, 6):
        log(f"Login attempt {attempt}/5 as @{IG_USERNAME}...")
        time.sleep(random.uniform(3,8) * min(attempt,3))
        try:
            proxy = get_proxy(attempt)
            cl    = make_client(proxy)
            cl.login(IG_USERNAME, IG_PASSWORD)
            cl.dump_settings(SESSION_FILE)
            info = cl.account_info()
            time.sleep(random.uniform(4, 10))
            log(f"Logged in: @{info.username}", "success")
            return cl
        except TwoFactorRequired:
            log("2FA required — disable 2FA on Instagram", "error"); sys.exit(1)
        except ChallengeRequired:
            log("Challenge — approve login in Instagram app, retry in 10min", "error")
            record_block(); sys.exit(1)
        except Exception as e:
            last_err = str(e)
            is_block = "Expecting value" in last_err or "JSONDecodeError" in last_err
            log(f"Attempt {attempt} failed: {last_err[:80]}", "warn")
            if is_block:
                log("IP block detected — switching proxy", "warn")
                time.sleep(random.uniform(20, 45))
            else:
                time.sleep(30 * min(attempt, 3))

    log(f"All login attempts failed: {last_err}", "error")
    sys.exit(1)

def relogin(cl):
    log("Session expired — reconnecting...", "warn")
    try:
        if os.path.exists(SESSION_FILE): os.remove(SESSION_FILE)
        return get_client()
    except Exception as e:
        log(f"Reconnect failed: {e}", "error")
        return None

# ────────────────────────────────────────────────────────────────
# VECTOR 10 — Niche hashtag browsing + inbox simulation
# Builds interest graph, balances outbound/inbound API ratio
# ────────────────────────────────────────────────────────────────
NICHE_HASHTAGS = [
    "realestate","delhirealestate","propertydelhi","digitalmarketing",
    "socialmediamarketing","websitedesign","businessgrowth","startupindia",
    "propertydealerdelhi","homesindelhi",
]

def browse_niche_content(cl):
    log("V10: Browsing niche hashtags...")
    tags = random.sample(NICHE_HASHTAGS, min(3, len(NICHE_HASHTAGS)))
    for tag in tags:
        try:
            medias = cl.hashtag_medias_recent(tag, amount=random.randint(3,6))
            log(f"V10: Browsed #{tag} — {len(medias)} posts seen")
            # Simulate viewing a random post
            if medias:
                post = random.choice(medias)
                try: cl.media_info(post.pk)
                except: pass
            time.sleep(random.uniform(3, 8))
        except Exception as e:
            log(f"V10: #{tag} error: {e}", "warn")

def simulate_inbox_read(cl):
    log("V10: Simulating inbox read...")
    try:
        threads = cl.direct_threads(amount=random.randint(3,8))
        log(f"V10: Viewed {len(threads)} inbox threads")
        # Peek into 1-2 threads
        for thread in threads[:random.randint(1,2)]:
            try:
                cl.direct_messages(thread.id, amount=random.randint(3,5))
                time.sleep(random.uniform(2, 5))
            except: pass
    except Exception as e:
        log(f"V10: Inbox sim error: {e}", "warn")

# ────────────────────────────────────────────────────────────────
# VECTOR 4 — Deep inbox reply check + optional pre-DM follow
# ────────────────────────────────────────────────────────────────
def check_inbox_replies(cl, processed):
    log("V4: Deep inbox reply check...")
    inbox_state = {}
    try:
        if os.path.exists(INBOX_FILE):
            with open(INBOX_FILE) as f: inbox_state = json.load(f)
    except: pass

    replied = inbox_state.get("replied", {})
    new_count = 0
    try:
        threads = cl.direct_threads(amount=20)
        for thread in threads:
            try:
                if not thread.users: continue
                other = thread.users[0].username
                if other not in processed: continue
                # V4: Deep read — actually fetch messages inside thread
                msgs = cl.direct_messages(thread.id, amount=8)
                my_id = str(cl.user_id)
                for msg in msgs:
                    if str(msg.user_id) != my_id:
                        text = getattr(msg, "text", "") or "(media)"
                        if other not in replied:
                            replied[other] = {
                                "ts": datetime.now().isoformat(),
                                "text": text[:200],
                            }
                            new_count += 1
                            log(f"V4: Reply from @{other}: {text[:60]}", "success")
                time.sleep(random.uniform(1, 3))
            except Exception as e:
                log(f"V4: Thread error: {e}", "warn")
    except Exception as e:
        log(f"V4: Inbox error: {e}", "warn")

    inbox_state["replied"] = replied
    with open(INBOX_FILE,"w") as f: json.dump(inbox_state, f, indent=2)
    log(f"V4: {new_count} new replies | {len(replied)} total")
    return replied

def maybe_follow(cl, username):
    """V4: Pre-DM follow with 20% probability — creates graph edge"""
    if random.random() > 0.20: return
    try:
        user_id = cl.user_id_from_username(username)
        cl.user_follow(user_id)
        log(f"V4: Followed @{username} before DM (20% trigger)", "success")
        time.sleep(random.uniform(2, 6))
    except Exception as e:
        log(f"V4: Follow error @{username}: {e}", "warn")

# ────────────────────────────────────────────────────────────────
# VECTOR 2 — Follower-priority targeting
# Accounts already following you go to front of DM queue
# ────────────────────────────────────────────────────────────────
def get_my_followers(cl):
    log("V2: Fetching follower list for priority targeting...")
    try:
        followers = cl.user_followers(cl.user_id, amount=200)
        names = {u.username for u in followers.values()}
        log(f"V2: {len(names)} followers found")
        return names
    except Exception as e:
        log(f"V2: Follower fetch error: {e}", "warn")
        return set()

def prioritize_targets(targets, followers):
    priority = [u for u in targets if u in followers]
    rest     = [u for u in targets if u not in followers]
    log(f"V2: {len(priority)} follower-priority targets + {len(rest)} others")
    return priority + rest

# ────────────────────────────────────────────────────────────────
# VECTOR 3 — Groq AI message generation with micro-variation
# ────────────────────────────────────────────────────────────────
GROQ_MODELS = ["llama-3.1-8b-instant","llama3-8b-8192","llama-3.3-70b-versatile","gemma2-9b-it"]
GROQ_STYLES = ["casual and friendly","professional and concise","curious and engaging","warm and personal","brief and direct"]
MSG_VARIANTS = [
    "Hey {{username}}! We help Delhi businesses get more clients online. Free consult?",
    "Hi {{username}}, noticed your work! We do websites + social media for real estate pros. Quick chat?",
    "{{username}} your listings look great! We help agents get more leads online. Open to connecting?",
    "Hey {{username}}! We specialize in digital growth for Delhi property pros. Would love to help!",
    "Hi {{username}}, do you use Instagram to get clients? We help real estate pros maximize it.",
]
_sent_hashes = set()

def build_message(username, attempt=0):
    """V3: Build message with Groq AI + micro-variation + length jitter"""
    base = random.choice(MSG_VARIANTS).replace("{{username}}", f"@{username}")
    base = base.replace("{{sender}}", f"@{IG_USERNAME}")

    # Try Groq enhancement
    if GROQ_KEY:
        for model in GROQ_MODELS:
            try:
                style = GROQ_STYLES[attempt % len(GROQ_STYLES)]
                prompt = (
                    f"Rewrite this Instagram DM in a {style} tone. "
                    f"Max 180 chars. Natural language. Address @{username}. "
                    f"Vary opening — don't always start with Hi/Hey. "
                    f"Original: {base}\nReturn ONLY the rewritten message."
                )
                r = requests.post(
                    "https://api.groq.com/openai/v1/chat/completions",
                    headers={"Authorization":f"Bearer {GROQ_KEY}","Content-Type":"application/json"},
                    json={"model":model,"messages":[{"role":"user","content":prompt}],"max_tokens":150},
                    timeout=12
                )
                data = r.json()
                if "choices" in data and data["choices"]:
                    result = data["choices"][0]["message"]["content"].strip()
                    if len(result) >= 20:
                        # Dedup check via hash
                        h = hashlib.md5(result[:40].encode()).hexdigest()
                        if h not in _sent_hashes:
                            _sent_hashes.add(h)
                            base = result
                            log(f"Groq [{model.split('-')[0]}] ({style}): {result[:60]}")
                            break
                err = data.get("error",{}).get("message","")
                if "decommissioned" in err or "not found" in err: continue
                break
            except Exception as e:
                log(f"Groq error: {e}", "warn")
                break

    # V3: Apply micro-variation + length jitter on top of Groq output
    return length_jitter(micro_variate(base))

# ── Search users ─────────────────────────────────────────────────
def search_users(cl, keyword, limit=12):
    try:
        try: results = cl.search_users(keyword)
        except TypeError: results = cl.search_users(keyword, count=limit)
        return [u.username for u in results[:limit] if u.username]
    except RateLimitError:
        log("Rate limit on search — waiting 5min", "warn")
        time.sleep(300)
        return []
    except Exception as e:
        log(f'Search "{keyword}": {e}', "warn")
        return []

# ── Quality filter ────────────────────────────────────────────────
def is_quality_account(cl, username):
    """Filter out obvious bots/low-quality accounts"""
    try:
        info = cl.user_info_by_username(username)
        if info.media_count < 3:    return False   # no content
        if info.following_count < 10: return False  # too new
        if not info.biography:      return False   # no bio
        if info.is_private:         return False   # can't DM easily
        return True
    except: return True  # don't filter on error

# ── Send DM ───────────────────────────────────────────────────────
def send_dm(cl, username, message):
    try:
        # View profile first (natural behaviour)
        try:
            cl.user_info_by_username(username)
            time.sleep(random.uniform(2, 5))
        except: pass
        user_id = cl.user_id_from_username(username)
        # Typing simulation (proportional to message length)
        typing_time = max(3, len(message) * random.uniform(0.04, 0.07))
        time.sleep(min(typing_time, 20))
        cl.direct_send(message, user_ids=[user_id])
        return "sent"
    except UserNotFound: return "skip"
    except RateLimitError:
        log("Rate limited on DM — waiting 10min", "warn")
        time.sleep(600)
        return "fail"
    except LoginRequired: return "relogin"
    except ChallengeRequired:
        log(f"Challenge @{username} — skipping", "warn")
        record_block()
        return "block"
    except Exception as e:
        err = str(e)
        if "login_required" in err.lower(): return "relogin"
        if "challenge" in err.lower():
            record_block(); return "block"
        if "spam" in err.lower() or "block" in err.lower():
            record_block(); return "block"
        log(f"DM error @{username}: {err[:100]}", "warn")
        return "fail"

# ── Persistence helpers ───────────────────────────────────────────
def load_processed():
    try:
        if os.path.exists(PROCESSED_FILE):
            with open(PROCESSED_FILE) as f: s = set(json.load(f))
            log(f"Loaded {len(s)} processed accounts"); return s
    except: pass
    return set()

def save_processed(s):
    with open(PROCESSED_FILE,"w") as f: json.dump(list(s), f)

# ── Main ──────────────────────────────────────────────────────────
def main():
    log(f"=== InstaReach Worker v5 | {CAMPAIGN_NAME} ===")
    log(f"V5: device_id={DEVICE_IDS['device_id'][:8]}... (persistent)")

    # V9: Cooldown check
    if not check_cooldown():
        return

    stats = _read_stats()

    # V1: Volume guards
    ok, session_max = check_volume_guards(stats)
    if not ok: return

    # V2: Reply rate capacity multiplier
    mult        = get_capacity_multiplier(stats)
    session_max = max(1, int(session_max * mult))
    log(f"Session capacity: {session_max} DMs")

    # Login
    cl = get_client()

    # V7: Warmup before starting
    _timer.warmup()

    # V10: Niche browsing to build interest graph
    browse_niche_content(cl)

    # V10: Inbox simulation
    simulate_inbox_read(cl)

    processed = load_processed()
    replies   = {}

    # V2: Get follower list for priority queue
    my_followers = get_my_followers(cl)

    # V4: Initial inbox reply check
    if processed:
        replies = check_inbox_replies(cl, processed)

    # Search targets
    log("Searching targets...")
    raw_targets = []
    for i, kw in enumerate(ALL_KEYWORDS):
        found = search_users(cl, kw)
        fresh = [u for u in found if u not in processed and u not in raw_targets and u != IG_USERNAME]
        if fresh: log(f'"{kw}" -> {len(fresh)} new targets')
        raw_targets.extend(fresh)
        _timer.between_searches()
        if i % 3 == 2: time.sleep(random.uniform(8, 15))
        if len(raw_targets) >= 60: break

    # V2: Sort followers to front of queue
    targets = prioritize_targets(raw_targets, my_followers)
    log(f"Total targets: {len(targets)} | Sending up to {session_max}")

    if not targets:
        log("No new targets found — all accounts already DMed", "warn")
        return

    random.shuffle(targets[len([t for t in targets if t in my_followers]):])  # shuffle non-priority

    # DM loop
    dm_count    = 0
    consec_fail = 0

    for username in targets:
        if dm_count >= session_max:
            log(f"Session limit {session_max} reached — run again in 2-3h", "warn"); break
        if username in processed: continue
        if consec_fail >= 3:
            log("3 consecutive failures — pausing 10min", "warn")
            time.sleep(600); consec_fail = 0

        # V4: Optional pre-DM follow
        maybe_follow(cl, username)

        # Quality filter
        if not is_quality_account(cl, username):
            processed.add(username); save_processed(processed)
            log(f"Skipped @{username} (low quality)"); continue

        # V3: Build message with Groq + micro-variation + length jitter
        msg = build_message(username, attempt=dm_count)
        log(f"DM -> @{username}: {msg[:70]}...")

        result = send_dm(cl, username, msg)

        if result == "relogin":
            cl = relogin(cl)
            if not cl: break
            result = send_dm(cl, username, msg)

        if result == "sent":
            dm_count   += 1
            consec_fail = 0
            processed.add(username); save_processed(processed)
            record_dm_sent(stats)
            log(f"DM sent -> @{username} ({dm_count}/{session_max}) | Today: {get_daily_count(stats)}/{get_daily_cap(stats)}", "success")
            _timer.fatigue_break()
            if dm_count < session_max:
                _timer.wait()
            # V4: Check inbox every 5 DMs
            if dm_count % 5 == 0:
                replies = check_inbox_replies(cl, processed)
                simulate_inbox_read(cl)  # V10

        elif result == "skip":
            processed.add(username); save_processed(processed)
            time.sleep(random.uniform(2, 6))

        elif result in ("block","fail"):
            consec_fail += 1
            if result == "block":
                log("Block signal received — stopping session", "warn")
                break
            time.sleep(random.uniform(20, 45))

    # Final inbox check
    if dm_count > 0:
        time.sleep(10)
        replies = check_inbox_replies(cl, processed)
        simulate_inbox_read(cl)  # V10

    # Update stats
    stats["total_replies"] = len(replies)
    record_session(stats)
    record_clean_session()  # V9

    total  = stats.get("total_sent",1)
    rate   = f"{len(replies)/max(total,1)*100:.1f}%"
    log(f"=== Done! {dm_count} DMs sent ===", "success")
    log(f"Lifetime: {total} sent | {len(replies)} replies ({rate})")
    log(f"V1: Daily {get_daily_count(stats)}/{get_daily_cap(stats)} | Weekly {get_weekly_count(stats)}")
    log("Run again in 2+ hours for next batch")

if __name__ == "__main__":
    main()