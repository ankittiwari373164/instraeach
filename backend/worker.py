"""
InstaReach Worker v3 - Complete rewrite
Human-like Instagram DM bot using instagrapi
"""
import sys, os, json, time, random, requests, hashlib
from datetime import datetime

# ── Logging ────────────────────────────────────────────────────
def log(msg, level="info"):
    ts = datetime.now().strftime("%H:%M:%S")
    prefix = {"info":"P","success":"OK","error":"ERR","warn":"WARN"}.get(level,"P")
    print(f"[{ts}] {prefix} {msg}", flush=True)

# ── Install instagrapi ─────────────────────────────────────────
try:
    from instagrapi import Client
    from instagrapi.exceptions import LoginRequired, ChallengeRequired, TwoFactorRequired, UserNotFound, RateLimitError
    log("instagrapi ready")
except ImportError:
    log("Installing instagrapi...", "warn")
    import subprocess
    installed = False
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
                installed = True
                break
            log(f"pip failed: {r.stderr[:60]}", "warn")
        except Exception as e:
            log(f"pip error: {e}", "warn")
    if not installed:
        log("FATAL: cannot install instagrapi", "error")
        sys.exit(1)
    from instagrapi import Client
    from instagrapi.exceptions import LoginRequired, ChallengeRequired, TwoFactorRequired, UserNotFound, RateLimitError
    log("instagrapi installed", "success")

# ── Config from env ────────────────────────────────────────────
IG_USERNAME  = os.environ.get("IG_USERNAME","").strip().lstrip("@").lower()
IG_PASSWORD  = os.environ.get("IG_PASSWORD","")
SESSION_FILE = os.environ.get("SESSION_FILE","./data/ig_session.json")
GROQ_KEY     = os.environ.get("GROQ_API_KEY","")
WEBSHARE_USER = os.environ.get("WEBSHARE_USER","")
WEBSHARE_PASS = os.environ.get("WEBSHARE_PASS","")

if not IG_USERNAME or not IG_PASSWORD:
    log("ERROR: IG_USERNAME and IG_PASSWORD required!", "error")
    sys.exit(1)

try:
    campaign = json.loads(os.environ.get("CAMPAIGN_DATA","{}"))
except:
    campaign = {}

CAMPAIGN_NAME  = campaign.get("name","Campaign")
ACCOUNT_ID     = campaign.get("account_id","default")
MESSAGE_TPL    = campaign.get("message","Hi {{username}}! I help Delhi businesses grow online with websites, social media and ads. Interested?")
MAX_DMS        = min(int(campaign.get("max_dms",15)), 15)
PROCESSED_FILE = f"./data/processed_{ACCOUNT_ID[:8]}.json"
REPLIES_FILE   = f"./data/replies_{ACCOUNT_ID[:8]}.json"
STATS_FILE     = f"./data/stats_{ACCOUNT_ID[:8]}.json"

try:
    kw_raw   = campaign.get("keywords","[]")
    KEYWORDS = json.loads(kw_raw) if isinstance(kw_raw,str) else (kw_raw or [])
except:
    KEYWORDS = []

EXTRA_KEYWORDS = [
    "real estate agent delhi","property dealer delhi",
    "delhi property","realestate delhi",
    "homes delhi","flats delhi",
    "property consultant delhi","real estate broker delhi",
]
ALL_KEYWORDS = list(dict.fromkeys(KEYWORDS + EXTRA_KEYWORDS))

# Webshare free proxies from dashboard
WEBSHARE_PROXIES = [
    ("31.59.20.176","6754"),("23.95.150.145","6114"),
    ("198.23.239.134","6540"),("45.38.107.97","6014"),
    ("107.172.163.27","6543"),("198.105.121.200","6462"),
    ("64.137.96.74","6641"),("216.10.27.159","6837"),
    ("142.111.67.146","5611"),
]

DEVICE_POOL = [
    {"app_version":"296.0.0.35.109","android_version":31,"android_release":"12.0.0","dpi":"480dpi","resolution":"1080x2400","manufacturer":"samsung","device":"SM-G991B","model":"Samsung Galaxy S21","cpu":"exynos2100","version_code":"514340314"},
    {"app_version":"296.0.0.35.109","android_version":30,"android_release":"11.0.0","dpi":"395dpi","resolution":"1080x2400","manufacturer":"Xiaomi","device":"sweetin","model":"M2101K6P","cpu":"qcom","version_code":"514340314"},
    {"app_version":"296.0.0.35.109","android_version":31,"android_release":"12.0.0","dpi":"410dpi","resolution":"1080x2412","manufacturer":"OnePlus","device":"IV2201","model":"IV2201","cpu":"qcom","version_code":"514340314"},
    {"app_version":"296.0.0.35.109","android_version":31,"android_release":"12.0.0","dpi":"452dpi","resolution":"1080x2400","manufacturer":"realme","device":"RMX3393","model":"RMX3393","cpu":"qcom","version_code":"514340314"},
]

GROQ_MODELS  = ["llama-3.1-8b-instant","llama3-8b-8192","llama-3.3-70b-versatile","gemma2-9b-it"]
GROQ_STYLES  = ["casual and friendly","professional and concise","curious and engaging","warm and personal","brief and direct"]
MSG_VARIANTS = [
    "Hey {{username}}! We help Delhi businesses get more clients online. Free consult?",
    "Hi {{username}}, noticed your work! We do websites + social media for real estate pros. Quick chat?",
    "{{username}} your listings look great! We help agents get more leads online. Open to connecting?",
    "Hey {{username}}! We specialize in digital growth for Delhi property pros. Would love to help!",
    "Hi {{username}}, do you use Instagram to get clients? We help real estate pros maximize it.",
]
_sent_hashes = set()

# ── Persistence helpers ────────────────────────────────────────
def ensure_data():
    os.makedirs("./data", exist_ok=True)

def load_set(path):
    ensure_data()
    try:
        if os.path.exists(path):
            with open(path) as f: return set(json.load(f))
    except: pass
    return set()

def save_set(path, s):
    ensure_data()
    try:
        with open(path,"w") as f: json.dump(list(s), f)
    except Exception as e: log(f"save_set error: {e}","warn")

def load_dict(path):
    ensure_data()
    try:
        if os.path.exists(path):
            with open(path) as f: return json.load(f)
    except: pass
    return {}

def save_dict(path, d):
    ensure_data()
    try:
        with open(path,"w") as f: json.dump(d, f, indent=2)
    except Exception as e: log(f"save_dict error: {e}","warn")

def load_stats():
    return load_dict(STATS_FILE)

def save_stats(s):
    save_dict(STATS_FILE, s)

def load_processed():
    s = load_set(PROCESSED_FILE)
    log(f"Loaded {len(s)} processed accounts from disk")
    return s

def save_processed(s):
    save_set(PROCESSED_FILE, s)

def load_replies():
    return load_dict(REPLIES_FILE)

def save_replies(d):
    save_dict(REPLIES_FILE, d)

def check_daily_limit(stats):
    today = datetime.now().strftime("%Y-%m-%d")
    count = stats.get(f"sent_{today}", 0)
    if count >= 30:
        log(f"Daily limit reached ({count}/30). Run again tomorrow.","warn")
        return False, count
    log(f"Daily progress: {count}/30 DMs sent today. {30-count} remaining.")
    return True, count

# ── Proxy helpers ──────────────────────────────────────────────
def get_proxy():
    if WEBSHARE_USER and WEBSHARE_PASS and WEBSHARE_PROXIES:
        host, port = WEBSHARE_PROXIES[0]
        return f"http://{WEBSHARE_USER}:{WEBSHARE_PASS}@{host}:{port}"
    p = os.environ.get("IG_PROXY","").strip()
    return p if p and p.lower() != "none" else None

def apply_proxy(cl, proxy_url):
    if not proxy_url: return cl
    try:
        cl.set_proxy(proxy_url)
        display = ("...@" + proxy_url.split("@")[-1]) if "@" in proxy_url else proxy_url
        log(f"Proxy: {display}", "success")
    except Exception as e: log(f"Proxy error: {e}","warn")
    return cl

def test_proxy(proxy_url):
    try:
        r = requests.get(
            "https://i.instagram.com/api/v1/si/fetch_headers/",
            proxies={"https":proxy_url,"http":proxy_url}, timeout=8,
            headers={"User-Agent":"Instagram 269.0.0.18.75 Android"}
        )
        return r.status_code in (200,400,403,429)
    except: return False

def get_working_proxy(attempt=0):
    """Try each Webshare proxy in rotation, fall back to free list"""
    if WEBSHARE_USER and WEBSHARE_PASS:
        for i in range(len(WEBSHARE_PROXIES)):
            idx = (attempt + i) % len(WEBSHARE_PROXIES)
            host, port = WEBSHARE_PROXIES[idx]
            purl = f"http://{WEBSHARE_USER}:{WEBSHARE_PASS}@{host}:{port}"
            log(f"Testing Webshare {idx+1}/{len(WEBSHARE_PROXIES)}: {host}:{port}")
            if test_proxy(purl):
                log(f"Webshare {host}:{port} OK", "success")
                return purl
            time.sleep(1)
        log("All Webshare proxies failed - trying free list...", "warn")

    log("Fetching free proxies...", "warn")
    for url in [
        "https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=8000&country=all&ssl=all&anonymity=elite",
        "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
    ]:
        try:
            r = requests.get(url, timeout=10)
            proxies = [p.strip() for p in r.text.strip().split("\n") if ":" in p and len(p.strip()) < 22]
            random.shuffle(proxies)
            for p in proxies[:10]:
                purl = f"http://{p}"
                if test_proxy(purl):
                    log(f"Free proxy OK: {p}", "success")
                    return purl
        except: continue
    log("No working proxy found", "warn")
    return None

# ── Device & client ────────────────────────────────────────────
def get_device():
    idx = int(hashlib.md5(ACCOUNT_ID.encode()).hexdigest(), 16) % len(DEVICE_POOL)
    return DEVICE_POOL[idx]

def make_client(proxy_url=None):
    cl = Client()
    cl.set_device(get_device())
    cl.set_locale("en_IN")
    cl.set_timezone_offset(19800)
    cl.delay_range = [3, 8]
    if proxy_url:
        apply_proxy(cl, proxy_url)
    return cl

def get_client():
    ensure_data()
    # Check for corrupted session
    if os.path.exists(SESSION_FILE):
        if os.path.getsize(SESSION_FILE) < 100:
            log("Session file corrupted - removing", "warn")
            os.remove(SESSION_FILE)

    # Try saved session first
    if os.path.exists(SESSION_FILE):
        log("Loading saved session...")
        proxy = get_proxy()
        cl = make_client(proxy)
        try:
            cl.load_settings(SESSION_FILE)
            cl.login(IG_USERNAME, IG_PASSWORD)
            info = cl.account_info()
            log(f"Session restored: @{info.username}", "success")
            return cl
        except Exception as e:
            log(f"Session invalid ({str(e)[:60]}) - fresh login...", "warn")
            try: os.remove(SESSION_FILE)
            except: pass

    # Fresh login with proxy rotation
    last_err = None
    for attempt in range(1, 6):
        log(f"Login attempt {attempt}/5 as @{IG_USERNAME}...")
        wait = random.uniform(3, 8) * min(attempt, 3)
        time.sleep(wait)
        try:
            proxy = get_proxy() if attempt == 1 else get_working_proxy(attempt)
            cl = make_client(proxy)
            cl.login(IG_USERNAME, IG_PASSWORD)
            cl.dump_settings(SESSION_FILE)
            info = cl.account_info()
            log(f"Logged in: @{info.username}", "success")
            time.sleep(random.uniform(4, 10))
            return cl
        except TwoFactorRequired:
            log("2FA required - disable 2FA on Instagram", "error")
            sys.exit(1)
        except ChallengeRequired:
            log("Challenge required - open Instagram app, approve login, retry in 10 mins", "error")
            sys.exit(1)
        except Exception as e:
            last_err = str(e)
            is_ip_block = "Expecting value" in last_err or "JSONDecodeError" in last_err
            log(f"Attempt {attempt} failed: {last_err[:80]}", "warn")
            if is_ip_block:
                log("IP blocked - switching proxy...", "warn")
                time.sleep(random.uniform(20, 40))
            else:
                time.sleep(30 * min(attempt, 3))

    log(f"All login attempts failed: {last_err}", "error")
    sys.exit(1)

def relogin():
    log("Session expired - reconnecting...", "warn")
    try:
        if os.path.exists(SESSION_FILE): os.remove(SESSION_FILE)
        return get_client()
    except Exception as e:
        log(f"Reconnect failed: {e}", "error")
        return None

# ── Groq AI ────────────────────────────────────────────────────
def groq_enhance(username, attempt=0):
    base = random.choice(MSG_VARIANTS).replace("{{username}}", f"@{username}")
    if not GROQ_KEY:
        return base
    for model in GROQ_MODELS:
        try:
            style = GROQ_STYLES[attempt % len(GROQ_STYLES)]
            prompt = (f"Rewrite this Instagram DM in a {style} tone. Max 180 chars. "
                      f"Keep it natural, address @{username}. Vary the opening - don't always start with Hi/Hey. "
                      f"Original: {base}\nReturn ONLY the message.")
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
                    # Dedup check
                    h = hashlib.md5(result[:40].encode()).hexdigest()
                    if h not in _sent_hashes:
                        _sent_hashes.add(h)
                        log(f"AI [{model.split('-')[0]}]: {result[:60]}")
                        return result
            else:
                err = data.get("error",{}).get("message","")
                if "decommissioned" in err: continue
                break
        except Exception as e:
            log(f"Groq error: {e}","warn")
            break
    return base

# ── Search ─────────────────────────────────────────────────────
def search_users(cl, keyword, limit=12):
    try:
        try: results = cl.search_users(keyword)
        except TypeError: results = cl.search_users(keyword, count=limit)
        return [u.username for u in results[:limit] if u.username]
    except RateLimitError:
        log("Rate limited on search - waiting 5 min...","warn")
        time.sleep(300)
        return []
    except Exception as e:
        log(f'Search "{keyword}": {e}','warn')
        return []

# ── Send DM ────────────────────────────────────────────────────
def send_dm(cl, username, message):
    try:
        try:
            cl.user_info_by_username(username)
            time.sleep(random.uniform(2, 5))
        except: pass
        user_id = cl.user_id_from_username(username)
        # Typing simulation
        time.sleep(max(3, len(message) * random.uniform(0.04, 0.07)))
        cl.direct_send(message, user_ids=[user_id])
        return "sent"
    except UserNotFound: return "skip"
    except RateLimitError:
        log("Rate limited on DM - waiting 10 min...","warn")
        time.sleep(600)
        return "fail"
    except LoginRequired: return "relogin"
    except ChallengeRequired:
        log(f"Challenge @{username} - skipping","warn")
        return "skip"
    except Exception as e:
        err = str(e)
        if "login_required" in err.lower() or "LoginRequired" in err: return "relogin"
        if "challenge" in err.lower(): return "skip"
        log(f"DM error @{username}: {err[:100]}","warn")
        return "fail"

# ── Inbox check ────────────────────────────────────────────────
def check_inbox(cl, processed, replies):
    log("Checking inbox for replies...")
    try:
        threads = cl.direct_threads(amount=20)
        new_replies = 0
        for thread in threads:
            try:
                if not thread.users: continue
                other = thread.users[0].username
                if not other or other not in processed: continue
                msgs = cl.direct_messages(thread.id, amount=5)
                for msg in msgs:
                    if str(msg.user_id) != str(cl.user_id):
                        text = getattr(msg,"text","") or "(media)"
                        if other not in replies:
                            replies[other] = text
                            save_replies(replies)
                            log(f"REPLY from @{other}: {text[:80]}", "success")
                            new_replies += 1
            except: continue
        log(f"Inbox checked - {len(replies)} total replies ({new_replies} new)")
    except Exception as e:
        log(f"Inbox error: {e}","warn")
    return replies

# ── Human timing ───────────────────────────────────────────────
def wait_between_dms(dm_num):
    base = random.uniform(60, 180)
    base *= (1.0 + dm_num * 0.06)  # fatigue
    if random.random() < 0.15:
        extra = random.uniform(60, 300)
        base += extra
        log(f"Taking a longer break ({base:.0f}s total)")
    else:
        log(f"Waiting {base:.0f}s before next DM")
    time.sleep(base)

# ── Main ───────────────────────────────────────────────────────
def main():
    log(f"=== InstaReach: {CAMPAIGN_NAME} ===")
    log(f"Account: @{IG_USERNAME} | Keywords: {len(ALL_KEYWORDS)}")

    stats = load_stats()
    can_run, today_count = check_daily_limit(stats)
    if not can_run:
        return

    actual_max = min(MAX_DMS, 30 - today_count)
    log(f"This session: up to {actual_max} DMs")

    cl         = get_client()
    processed  = load_processed()
    replies    = load_replies()
    log(f"Lifetime DMed: {len(processed)} | Replies: {len(replies)}")

    # Warmup - simulate browsing
    time.sleep(random.uniform(10, 25))

    # Check inbox first
    if processed:
        replies = check_inbox(cl, processed, replies)

    # Search targets
    log("Searching targets...")
    targets = []
    for i, kw in enumerate(ALL_KEYWORDS):
        found = search_users(cl, kw)
        fresh = [u for u in found if u not in processed and u not in targets and u not in replies and u != IG_USERNAME]
        if fresh: log(f'"{kw}" -> {len(fresh)} new')
        targets.extend(fresh)
        time.sleep(random.uniform(3, 10) + (random.uniform(8,15) if i % 3 == 2 else 0))
        if len(targets) >= 50: break

    log(f"Total targets: {len(targets)}")
    if not targets:
        log("No new targets found - all already DMed","warn")
        return

    random.shuffle(targets)
    log(f"Starting DMs (max {actual_max})...")
    dm_count = 0
    consec_fails = 0
    today = datetime.now().strftime("%Y-%m-%d")

    for username in targets:
        if dm_count >= actual_max:
            log(f"Session limit: {actual_max}. Run again in 2-3 hours.","warn")
            break
        if username in processed: continue
        if consec_fails >= 3:
            log("3 consecutive failures - pausing 10 min...","warn")
            time.sleep(600)
            consec_fails = 0

        msg = groq_enhance(username)
        log(f"Sending DM to @{username}...")
        result = send_dm(cl, username, msg)

        if result == "relogin":
            cl = relogin()
            if not cl:
                log("Reconnect failed - stopping","error")
                break
            result = send_dm(cl, username, msg)

        if result == "sent":
            dm_count += 1
            consec_fails = 0
            processed.add(username)
            save_processed(processed)
            stats[f"sent_{today}"] = stats.get(f"sent_{today}", 0) + 1
            stats["total_sent"]    = stats.get("total_sent", 0) + 1
            save_stats(stats)
            log(f"DM sent -> @{username} ({dm_count}/{actual_max}) | Today: {stats[f'sent_{today}']}/30", "success")

            if dm_count % 5 == 0:
                time.sleep(random.uniform(120, 240))
                replies = check_inbox(cl, processed, replies)
            else:
                wait_between_dms(dm_count)

        elif result == "skip":
            processed.add(username)
            save_processed(processed)
            time.sleep(random.uniform(3, 8))
        else:
            consec_fails += 1
            log(f"Failed @{username} (#{consec_fails})","warn")
            time.sleep(random.uniform(20, 45))

    # Final inbox check
    if dm_count > 0:
        time.sleep(10)
        replies = check_inbox(cl, processed, replies)

    stats["sessions"]      = stats.get("sessions", 0) + 1
    stats["last_run"]      = datetime.now().isoformat()
    stats["total_replies"] = len(replies)
    save_stats(stats)

    total = stats.get("total_sent", 1)
    rate  = f"{len(replies)/max(total,1)*100:.1f}%"
    log(f"=== Done! {dm_count} DMs sent ===", "success")
    log(f"Lifetime: {total} sent | {len(replies)} replies ({rate} reply rate)")
    log("Run again in 2-3 hours for next batch")

if __name__ == "__main__":
    main()