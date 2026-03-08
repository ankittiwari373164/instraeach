"""
InstaReach Worker — Human-like Instagram DM Bot
Uses instagrapi with realistic delays and behavior patterns
"""

import sys, os, json, time, random, requests
from datetime import datetime

def log(msg, level="info"):
    ts = datetime.now().strftime("%H:%M:%S")
    prefix = {"info":"P","success":"OK","error":"ERR","warn":"WARN"}.get(level,"P")
    print(f"[{ts}] {prefix} {msg}", flush=True)

# Install instagrapi if missing
try:
    from instagrapi import Client
    from instagrapi.exceptions import (
        LoginRequired, ChallengeRequired, TwoFactorRequired,
        UserNotFound, ClientError, RateLimitError
    )
    log("instagrapi ready")
except ImportError:
    log("Installing instagrapi...", "warn")
    import subprocess
    for cmd in [
        [sys.executable, "-m", "pip", "install", "instagrapi", "requests", "--quiet", "--break-system-packages"],
        [sys.executable, "-m", "pip", "install", "instagrapi", "requests", "--quiet"],
    ]:
        try:
            subprocess.check_call(cmd, timeout=180)
            break
        except: pass
    from instagrapi import Client
    from instagrapi.exceptions import (
        LoginRequired, ChallengeRequired, TwoFactorRequired,
        UserNotFound, ClientError, RateLimitError
    )
    log("instagrapi installed")

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
MESSAGE_TPL   = campaign.get("message", "Hi {{username}}! I am a real estate consultant in Delhi. Interested in buying or selling? Lets connect!")
MAX_DMS       = min(int(campaign.get("max_dms", 30)), 30)  # Hard cap at 30/session
try:
    kw_raw = campaign.get("keywords", "[]")
    KEYWORDS = json.loads(kw_raw) if isinstance(kw_raw, str) else (kw_raw or [])
except:
    KEYWORDS = []

EXTRA_KEYWORDS = [
    "real estate agent delhi", "property dealer delhi",
    "delhi property", "realestate delhi",
    "homes delhi", "flats delhi",
    "property consultant delhi", "real estate broker delhi",
]
ALL_KEYWORDS = list(dict.fromkeys(KEYWORDS + EXTRA_KEYWORDS))

# ── Human-like sleep ───────────────────────────────────────────
def human_sleep(min_s, max_s, reason=""):
    t = random.uniform(min_s, max_s)
    # Add occasional longer pauses (simulate reading/browsing)
    if random.random() < 0.15:
        t += random.uniform(10, 30)
        log(f"Taking a longer break... ({t:.0f}s) {reason}")
    else:
        if reason: log(f"Waiting {t:.0f}s {reason}")
    time.sleep(t)

# ── Groq AI rewrite ────────────────────────────────────────────
GROQ_STYLES = [
    "casual and friendly", "professional and concise",
    "curious and engaging", "warm and personal", "brief and direct"
]

def groq_enhance(base_msg, username):
    if not GROQ_KEY:
        return base_msg.replace("{{username}}", f"@{username}").replace("{{sender}}", f"@{IG_USERNAME}")
    try:
        style = random.choice(GROQ_STYLES)
        prompt = f"Rewrite this Instagram DM in a {style} tone. Max 180 chars. Replace {{{{username}}}} with @{username}. Original: {base_msg}\nReturn ONLY the rewritten message."
        resp = requests.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={"Authorization": f"Bearer {GROQ_KEY}", "Content-Type": "application/json"},
            json={"model": "mixtral-8x7b-32768", "messages": [{"role": "user", "content": prompt}], "max_tokens": 150},
            timeout=12
        )
        data = resp.json()
        if "choices" in data and data["choices"]:
            result = data["choices"][0]["message"]["content"].strip()
            if len(result) >= 20:
                log(f"AI ({style[:15]}): {result[:70]}")
                return result
        else:
            log(f"Groq response: {json.dumps(data)[:100]}", "warn")
    except Exception as e:
        log(f"Groq error: {e}", "warn")
    return base_msg.replace("{{username}}", f"@{username}").replace("{{sender}}", f"@{IG_USERNAME}")

# ── Login ──────────────────────────────────────────────────────
def get_client():
    cl = Client()
    # Realistic Indian Android device
    cl.set_device({
        "app_version": "269.0.0.18.75",
        "android_version": 28,
        "android_release": "9.0.0",
        "dpi": "420dpi",
        "resolution": "1080x2220",
        "manufacturer": "samsung",
        "device": "SM-G960F",
        "model": "Samsung Galaxy S9",
        "cpu": "exynos9810",
        "version_code": "314665256",
    })
    cl.set_locale("en_IN")
    cl.set_timezone_offset(19800)  # IST +5:30
    cl.delay_range = [3, 8]        # 3-8s between API calls

    os.makedirs("./data", exist_ok=True)

    # Try saved session first
    if os.path.exists(SESSION_FILE):
        log("Loading saved session...")
        try:
            cl.load_settings(SESSION_FILE)
            cl.login(IG_USERNAME, IG_PASSWORD)
            info = cl.account_info()
            log(f"Session restored: @{info.username}", "success")
            return cl
        except Exception as e:
            log(f"Session invalid ({e}), fresh login...", "warn")
            try: os.remove(SESSION_FILE)
            except: pass

    # Fresh login
    log(f"Fresh login as @{IG_USERNAME}...")
    # Random pre-login delay (like a human opening the app)
    time.sleep(random.uniform(2, 5))
    try:
        cl.login(IG_USERNAME, IG_PASSWORD)
        cl.dump_settings(SESSION_FILE)
        info = cl.account_info()
        log(f"Logged in: @{info.username}", "success")
        # Simulate post-login browsing (scroll feed briefly)
        time.sleep(random.uniform(5, 12))
        return cl
    except TwoFactorRequired:
        log("2FA required — disable 2FA on Instagram", "error")
        sys.exit(1)
    except ChallengeRequired as e:
        log(f"Challenge required — open Instagram app and approve the login from your phone, then retry in 10 mins", "error")
        sys.exit(1)
    except Exception as e:
        log(f"Login failed: {e}", "error")
        sys.exit(1)

# ── Processed persistence ──────────────────────────────────────
def load_processed():
    try:
        pfile = f"./data/processed_{ACCOUNT_ID[:8]}.json"
        if os.path.exists(pfile):
            with open(pfile) as f:
                return set(json.load(f))
    except: pass
    return set()

def save_processed(s):
    try:
        with open(f"./data/processed_{ACCOUNT_ID[:8]}.json", "w") as f:
            json.dump(list(s), f)
    except: pass

# ── Search with human pacing ───────────────────────────────────
def search_users(cl, keyword, limit=12):
    try:
        try:
            results = cl.search_users(keyword)
        except TypeError:
            results = cl.search_users(keyword, count=limit)
        usernames = [u.username for u in results[:limit] if u.username]
        return usernames
    except RateLimitError:
        log(f"Rate limited on search — waiting 5 min...", "warn")
        time.sleep(300)
        return []
    except Exception as e:
        log(f'Search "{keyword}": {e}', "warn")
        return []

# ── Send DM with human behavior ────────────────────────────────
def send_dm(cl, username, message):
    try:
        # Simulate viewing profile before DMing (human behavior)
        try:
            user_info = cl.user_info_by_username(username)
            time.sleep(random.uniform(2, 5))  # "reading" the profile
        except:
            pass

        user_id = cl.user_id_from_username(username)
        time.sleep(random.uniform(1, 3))  # pause before sending

        cl.direct_send(message, user_ids=[user_id])
        return True
    except UserNotFound:
        log(f"Not found: @{username}", "warn")
        return False
    except RateLimitError:
        log(f"Rate limited on DM — waiting 10 min...", "warn")
        time.sleep(600)
        return False
    except ChallengeRequired:
        log(f"Challenge on DM @{username} — skipping, Instagram needs verification", "warn")
        return False
    except Exception as e:
        err = str(e)
        if "ChallengeResolve" in err or "challenge" in err.lower():
            log(f"Challenge @{username} — skipping", "warn")
        else:
            log(f"DM error @{username}: {err[:120]}", "warn")
        return False

# ── Main ───────────────────────────────────────────────────────
def main():
    log(f"=== Bot starting: {CAMPAIGN_NAME} ===")
    log(f"Account: @{IG_USERNAME} | Max DMs this session: {MAX_DMS}")

    cl = get_client()

    processed = load_processed()
    log(f"Already DMed: {len(processed)} (will skip)")

    # Search with gaps between keywords (human-like)
    log("Searching targets...")
    targets = []
    for i, kw in enumerate(ALL_KEYWORDS):
        found = search_users(cl, kw)
        fresh = [u for u in found if u not in processed and u not in targets and u != IG_USERNAME]
        if fresh:
            log(f'"{kw}" -> {len(fresh)} new')
        targets.extend(fresh)

        # Gap between searches: 3-8s, longer every 3rd keyword
        if i % 3 == 2:
            human_sleep(8, 15, "(keyword batch pause)")
        else:
            human_sleep(3, 7)

        if len(targets) >= 60:
            break

    log(f"Total targets: {len(targets)}")
    if not targets:
        log("No new targets found", "warn")
        return

    # Shuffle targets for less predictable pattern
    random.shuffle(targets)

    log(f"Starting DMs (max {MAX_DMS} this session)...")
    dm_count = 0
    consecutive_fails = 0

    for i, username in enumerate(targets):
        if dm_count >= MAX_DMS:
            log(f"Session limit reached: {MAX_DMS} DMs. Run again later.", "warn")
            break
        if username in processed:
            continue

        # Stop if too many consecutive failures (account likely flagged)
        if consecutive_fails >= 3:
            log("3 consecutive failures — pausing 15 min to avoid ban", "warn")
            time.sleep(900)
            consecutive_fails = 0

        # Build message
        base_msg = MESSAGE_TPL.replace("{{username}}", f"@{username}").replace("{{sender}}", f"@{IG_USERNAME}")
        final_msg = groq_enhance(base_msg, username)

        log(f"Sending DM to @{username}...")
        sent = send_dm(cl, username, final_msg)
        processed.add(username)
        save_processed(processed)

        if sent:
            dm_count += 1
            consecutive_fails = 0
            log(f"DM sent -> @{username} ({dm_count}/{MAX_DMS})", "success")
            # Human delay between DMs: 45-120s (realistic)
            human_sleep(45, 120, f"before next DM")
            # Every 5 DMs, take a longer break
            if dm_count % 5 == 0:
                pause = random.uniform(120, 300)
                log(f"Taking a {pause:.0f}s break after {dm_count} DMs (anti-detection)...")
                time.sleep(pause)
        else:
            consecutive_fails += 1
            log(f"Failed: @{username} (fail #{consecutive_fails})", "warn")
            human_sleep(15, 30)

    log(f"=== Session complete! {dm_count} DMs sent ===", "success")
    log(f"Tip: Run again in 2-3 hours for next batch")

if __name__ == "__main__":
    main()