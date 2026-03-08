"""
InstaReach Worker - Instagram DM Bot
Mirrors WhatsApp reader/sender logic:
  - Persistent session (load once, reuse forever)
  - Listen for incoming DMs (reply detection)
  - Send outbound DMs to targets
  - Human-like behavior throughout
"""

import sys, os, json, time, random, requests, threading
from datetime import datetime

def log(msg, level="info"):
    ts = datetime.now().strftime("%H:%M:%S")
    prefix = {"info":"P","success":"OK","error":"ERR","warn":"WARN"}.get(level,"P")
    print(f"[{ts}] {prefix} {msg}", flush=True)

# ── Install instagrapi ─────────────────────────────────────────
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
MESSAGE_TPL   = campaign.get("message", "Hi {{username}}! I am a digital marketing expert in Delhi. We help businesses grow online with websites, social media and ads. Interested?")
MAX_DMS       = min(int(campaign.get("max_dms", 25)), 25)
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

# ── Groq AI — tries multiple models like a fallback chain ─────
GROQ_MODELS = [
    "llama-3.1-8b-instant",
    "llama3-8b-8192",
    "llama-3.3-70b-versatile",
    "gemma2-9b-it",
]
GROQ_STYLES = [
    "casual and friendly", "professional and concise",
    "curious and engaging", "warm and personal", "brief and direct"
]

def groq_enhance(base_msg, username):
    if not GROQ_KEY:
        return base_msg.replace("{{username}}", f"@{username}").replace("{{sender}}", f"@{IG_USERNAME}")
    for model in GROQ_MODELS:
        try:
            style = random.choice(GROQ_STYLES)
            prompt = (
                f"Rewrite this Instagram DM in a {style} tone. "
                f"Max 180 chars. Replace {{{{username}}}} with @{username}. "
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
                    log(f"AI [{model.split('-')[0]}] ({style[:12]}): {result[:70]}")
                    return result
            else:
                err = data.get("error", {}).get("message", "")
                if "decommissioned" in err or "not found" in err.lower():
                    continue  # try next model
                log(f"Groq: {err[:80]}", "warn")
                break
        except Exception as e:
            log(f"Groq error: {e}", "warn")
            break
    return base_msg.replace("{{username}}", f"@{username}").replace("{{sender}}", f"@{IG_USERNAME}")

# ── Human-like sleep ───────────────────────────────────────────
def human_sleep(min_s, max_s, label=""):
    t = random.uniform(min_s, max_s)
    if random.random() < 0.12:
        t += random.uniform(8, 20)
    if label:
        log(f"Waiting {t:.0f}s {label}")
    time.sleep(t)

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
    """Load dict of {username: message} for accounts that replied"""
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
    except Exception as e:
        log(f"Replies save error: {e}", "warn")

# ── Session / login  (mirrors WhatsApp LocalAuth pattern) ─────
def make_client():
    cl = Client()
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
    cl.delay_range = [3, 8]
    return cl

def get_client():
    """
    Mirrors WhatsApp LocalAuth:
      1. Try saved session file (no QR / no password re-entry)
      2. Fall back to fresh login and SAVE session for next time
    """
    cl = make_client()
    os.makedirs("./data", exist_ok=True)

    # -- Try saved session (like .wwebjs_auth) --
    if os.path.exists(SESSION_FILE):
        log("Loading saved session (like LocalAuth)...")
        try:
            cl.load_settings(SESSION_FILE)
            cl.login(IG_USERNAME, IG_PASSWORD)
            info = cl.account_info()
            log(f"Session restored: @{info.username}", "success")
            # Simulate brief post-login activity
            time.sleep(random.uniform(3, 7))
            return cl
        except Exception as e:
            log(f"Saved session invalid ({e}) - fresh login...", "warn")
            try: os.remove(SESSION_FILE)
            except: pass

    # -- Fresh login (like first QR scan) --
    log(f"Fresh login as @{IG_USERNAME}...")
    time.sleep(random.uniform(2, 5))
    try:
        cl.login(IG_USERNAME, IG_PASSWORD)
        cl.dump_settings(SESSION_FILE)   # save for next run (like LocalAuth)
        info = cl.account_info()
        log(f"Logged in: @{info.username}", "success")
        time.sleep(random.uniform(5, 10))
        return cl
    except TwoFactorRequired:
        log("2FA required - disable 2FA on Instagram", "error")
        sys.exit(1)
    except ChallengeRequired:
        log("Challenge required - open Instagram app, approve login, retry in 10 mins", "error")
        sys.exit(1)
    except Exception as e:
        log(f"Login failed: {e}", "error")
        sys.exit(1)

def relogin(cl):
    """Auto reconnect when session expires mid-run (like WhatsApp reconnected event)"""
    log("Session expired - reconnecting...", "warn")
    try:
        if os.path.exists(SESSION_FILE): os.remove(SESSION_FILE)
        return get_client()
    except Exception as e:
        log(f"Reconnect failed: {e}", "error")
        return None

# ── Listen for incoming DMs (mirrors WhatsApp message event) ──
def check_inbox(cl, dm_targets, replies):
    """
    Mirrors WhatsApp client.on('message') handler.
    Checks recent DM threads for replies from people we DMed.
    Logs any new replies found.
    """
    log("Checking inbox for replies...")
    try:
        threads = cl.direct_threads(amount=20)
        new_replies = 0
        for thread in threads:
            try:
                # Get username of the other person
                if not thread.users: continue
                other_user = thread.users[0].username
                if not other_user: continue

                # Only care about people we DMed
                if other_user not in dm_targets: continue

                # Fetch recent messages in thread
                messages = cl.direct_messages(thread.id, amount=5)
                for msg in messages:
                    # If message is FROM them (not us) it is a reply
                    if str(msg.user_id) != str(cl.user_id):
                        text = getattr(msg, 'text', '') or '(media/sticker)'
                        if other_user not in replies:
                            replies[other_user] = text
                            save_replies(replies)
                            log(f"REPLY from @{other_user}: {text[:80]}", "success")
                            new_replies += 1
            except: continue
        if new_replies == 0:
            log(f"Inbox checked - no new replies yet")
        else:
            log(f"Found {new_replies} new replies!", "success")
    except Exception as e:
        log(f"Inbox check error: {e}", "warn")
    return replies

# ── Search targets ─────────────────────────────────────────────
def search_users(cl, keyword, limit=12):
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

# ── Send DM (mirrors WhatsApp sendMessage) ────────────────────
def send_dm(cl, username, message):
    """
    Mirrors WhatsApp sendMessage(to, message):
      - Look up user ID from username (like formatting chatId)
      - Send the message
      - Return status string
    """
    try:
        # View profile briefly (human behavior - like opening a chat)
        try:
            cl.user_info_by_username(username)
            time.sleep(random.uniform(2, 5))
        except: pass

        # Resolve username to user_id (like chatId = number + @c.us)
        user_id = cl.user_id_from_username(username)
        time.sleep(random.uniform(1, 3))

        cl.direct_send(message, user_ids=[user_id])
        return "sent"

    except UserNotFound:
        log(f"Not found: @{username}", "warn")
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
            log(f"Challenge @{username} - skipping", "warn")
            return "skip"
        log(f"DM error @{username}: {err[:100]}", "warn")
        return "fail"

# ── Main ───────────────────────────────────────────────────────
def main():
    log(f"=== InstaReach starting: {CAMPAIGN_NAME} ===")
    log(f"Account: @{IG_USERNAME} | Max DMs: {MAX_DMS}/session")

    # Connect (like client.initialize())
    cl = get_client()

    # Load state from disk
    processed = load_json_set(PROCESSED_FILE)
    replies   = load_replies()
    log(f"Already DMed: {len(processed)} | Replies received: {len(replies)}")

    # Check inbox first (like readRecentMessages on ready)
    if processed:
        cl = check_inbox_safe(cl, processed, replies)

    # Search for new targets
    log("Searching targets...")
    targets = []
    for i, kw in enumerate(ALL_KEYWORDS):
        found = search_users(cl, kw)
        fresh = [u for u in found
                 if u not in processed
                 and u not in targets
                 and u not in replies       # skip people who already replied
                 and u != IG_USERNAME]
        if fresh:
            log(f'"{kw}" -> {len(fresh)} new')
        targets.extend(fresh)
        if i % 3 == 2:
            human_sleep(8, 15, "(batch pause)")
        else:
            human_sleep(3, 7)
        if len(targets) >= 60:
            break

    log(f"Total targets: {len(targets)}")
    if not targets:
        log("No new targets - all already DMed. Run again tomorrow.", "warn")
        return

    random.shuffle(targets)
    log(f"Starting DMs (max {MAX_DMS} this session)...")

    dm_count         = 0
    consecutive_fails = 0
    dm_targets_this_run = set()

    for username in targets:
        if dm_count >= MAX_DMS:
            log(f"Session limit: {MAX_DMS} DMs. Run again in 2-3 hours.", "warn")
            break
        if username in processed:
            continue
        if consecutive_fails >= 3:
            log("3 consecutive failures - pausing 10 min...", "warn")
            time.sleep(600)
            consecutive_fails = 0

        # Build message (Groq AI rewrite)
        base  = MESSAGE_TPL.replace("{{username}}", f"@{username}").replace("{{sender}}", f"@{IG_USERNAME}")
        msg   = groq_enhance(base, username)

        log(f"Sending DM to @{username}...")
        result = send_dm(cl, username, msg)

        # Auto-reconnect (like WhatsApp disconnected -> reconnect)
        if result == "relogin":
            cl = relogin(cl)
            if not cl:
                log("Reconnect failed - stopping", "error")
                break
            result = send_dm(cl, username, msg)  # retry after reconnect

        if result == "sent":
            dm_count += 1
            consecutive_fails = 0
            processed.add(username)
            dm_targets_this_run.add(username)
            save_json_set(PROCESSED_FILE, processed)
            log(f"DM sent -> @{username} ({dm_count}/{MAX_DMS})", "success")

            # Every 5 DMs: check inbox for replies (like WhatsApp message listener)
            if dm_count % 5 == 0:
                pause = random.uniform(120, 240)
                log(f"Break after {dm_count} DMs ({pause:.0f}s) + inbox check...")
                time.sleep(pause)
                cl = check_inbox_safe(cl, processed, replies)
            else:
                human_sleep(45, 110, "before next DM")

        elif result == "skip":
            processed.add(username)
            save_json_set(PROCESSED_FILE, processed)
            human_sleep(3, 8)
        else:
            consecutive_fails += 1
            log(f"Failed @{username} (#{consecutive_fails})", "warn")
            human_sleep(15, 35)

    # Final inbox check after sending all DMs
    if dm_count > 0:
        log("Session done - final inbox check...")
        time.sleep(10)
        check_inbox_safe(cl, processed, replies)

    log(f"=== Session complete! {dm_count} DMs sent ===", "success")
    log(f"Total DMed: {len(processed)} | Replies: {len(replies)}")
    log("Run again in 2-3 hours for next batch")

def check_inbox_safe(cl, processed, replies):
    """Wrapper: re-login if session expired during inbox check"""
    try:
        replies = check_inbox(cl, processed, replies)
        return cl
    except LoginRequired:
        cl = relogin(cl)
        if cl:
            check_inbox(cl, processed, replies)
        return cl
    except Exception as e:
        log(f"Inbox check failed: {e}", "warn")
        return cl

if __name__ == "__main__":
    main()