"""
InstaReach Worker — Instagram DM Bot
Uses instagrapi (username+password login) — same approach as the reader script.
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
    from instagrapi.exceptions import LoginRequired, ChallengeRequired, TwoFactorRequired, UserNotFound
    log("instagrapi ready")
except ImportError:
    log("Installing instagrapi...", "warn")
    import subprocess
    cmds = [
        [sys.executable, "-m", "pip", "install", "instagrapi", "requests", "--quiet", "--break-system-packages"],
        [sys.executable, "-m", "pip", "install", "instagrapi", "requests", "--quiet"],
        ["pip3", "install", "instagrapi", "requests", "--quiet", "--break-system-packages"],
        ["pip3", "install", "instagrapi", "requests", "--quiet"],
    ]
    for cmd in cmds:
        try:
            subprocess.check_call(cmd, timeout=180)
            log(f"Installed via: {' '.join(cmd[:4])}")
            break
        except Exception as e:
            log(f"pip attempt failed: {e}", "warn")
    from instagrapi import Client
    from instagrapi.exceptions import LoginRequired, ChallengeRequired, TwoFactorRequired, UserNotFound
    log("instagrapi installed")

# Config from env
IG_USERNAME   = os.environ.get("IG_USERNAME", "")
IG_PASSWORD   = os.environ.get("IG_PASSWORD", "")
SESSION_FILE  = os.environ.get("SESSION_FILE", "./data/ig_session.json")
CAMPAIGN_JSON = os.environ.get("CAMPAIGN_DATA", "{}")
GROQ_KEY      = os.environ.get("GROQ_API_KEY", "")

if not IG_USERNAME or not IG_PASSWORD:
    log("ERROR: IG_USERNAME and IG_PASSWORD env vars required!", "error")
    sys.exit(1)

# Parse campaign
try:
    campaign = json.loads(CAMPAIGN_JSON)
except:
    campaign = {}

CAMPAIGN_NAME = campaign.get("name", "Campaign")
ACCOUNT_ID    = campaign.get("account_id", "default")
MESSAGE_TPL   = campaign.get("message", "Hi {{username}}! I am a real estate consultant in Delhi. Interested in buying or selling? Lets connect!")
MAX_DMS       = int(campaign.get("max_dms", 50))
COOLDOWN_MIN  = max(15, int(campaign.get("cooldown_ms", 15000)) // 1000)
COOLDOWN_MAX  = COOLDOWN_MIN + 12
try:
    kw_raw = campaign.get("keywords", "[]")
    KEYWORDS = json.loads(kw_raw) if isinstance(kw_raw, str) else (kw_raw or [])
except:
    KEYWORDS = []

EXTRA_KEYWORDS = [
    "real estate agent delhi","property dealer delhi",
    "delhi property","realestate delhi",
    "homes delhi","flats delhi",
    "property consultant delhi","real estate broker delhi",
    "buy flat delhi","sell property delhi",
]
ALL_KEYWORDS = list(dict.fromkeys(KEYWORDS + EXTRA_KEYWORDS))

# Groq AI rewrite
GROQ_STYLES = ["casual and friendly","professional and concise","curious and engaging","warm and personal","brief and direct"]

def groq_enhance(base_msg, username):
    if not GROQ_KEY:
        return base_msg
    try:
        style = random.choice(GROQ_STYLES)
        prompt = f"Rewrite this Instagram DM in a {style} tone. Keep under 200 chars. Replace {{{{username}}}} with @{username}. Original: {base_msg}\nReturn ONLY the rewritten message."
        resp = requests.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={"Authorization": f"Bearer {GROQ_KEY}", "Content-Type": "application/json"},
            json={"model":"llama3-8b-8192","messages":[{"role":"user","content":prompt}],"max_tokens":200},
            timeout=10
        )
        result = resp.json()["choices"][0]["message"]["content"].strip()
        if len(result) >= 20:
            log(f"AI ({style[:15]}): {result[:60]}")
            return result
    except Exception as e:
        log(f"Groq error: {e}", "warn")
    return base_msg.replace("{{username}}", f"@{username}").replace("{{sender}}", f"@{IG_USERNAME}")

# Login — same logic as the reader script
def get_client():
    cl = Client()
    cl.delay_range = [2, 5]
    os.makedirs("./data", exist_ok=True)

    if os.path.exists(SESSION_FILE):
        log("Loading saved session...")
        try:
            cl.load_settings(SESSION_FILE)
            cl.login(IG_USERNAME, IG_PASSWORD)
            info = cl.account_info()
            log(f"Session restored: @{info.username}", "success")
            return cl
        except Exception as e:
            log(f"Saved session invalid ({e}), fresh login...", "warn")
            try: os.remove(SESSION_FILE)
            except: pass

    log(f"Logging in as @{IG_USERNAME}...")
    try:
        cl.login(IG_USERNAME, IG_PASSWORD)
        cl.dump_settings(SESSION_FILE)
        info = cl.account_info()
        log(f"Logged in: @{info.username}", "success")
        return cl
    except TwoFactorRequired:
        log("2FA required — disable 2FA on Instagram and retry", "error")
        sys.exit(1)
    except ChallengeRequired:
        log("Instagram challenge required — open Instagram app, verify, then retry", "error")
        sys.exit(1)
    except Exception as e:
        log(f"Login failed: {e}", "error")
        sys.exit(1)

# Processed accounts persistence
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

# Search
def search_users(cl, keyword, limit=15):
    try:
        results = cl.search_users(keyword, count=limit)
        return [u.username for u in results if u.username]
    except Exception as e:
        log(f'Search "{keyword}": {e}', "warn")
        return []

# Send DM
def send_dm(cl, username, message):
    try:
        user_id = cl.user_id_from_username(username)
        cl.direct_send(message, user_ids=[user_id])
        return True
    except UserNotFound:
        log(f"Not found: @{username}", "warn")
        return False
    except Exception as e:
        log(f"DM error @{username}: {e}", "warn")
        return False

# Main
def main():
    log(f"=== Bot starting: {CAMPAIGN_NAME} ===")
    log(f"Account: @{IG_USERNAME} | Max DMs: {MAX_DMS} | Keywords: {len(ALL_KEYWORDS)}")

    cl = get_client()

    processed = load_processed()
    log(f"Already DMed: {len(processed)} (will skip)")

    log("Searching targets...")
    targets = []
    for kw in ALL_KEYWORDS:
        found = search_users(cl, kw)
        fresh = [u for u in found if u not in processed and u not in targets and u != IG_USERNAME]
        if fresh:
            log(f'"{kw}" -> {len(fresh)} new')
        targets.extend(fresh)
        time.sleep(random.uniform(1.0, 2.0))
        if len(targets) >= 80:
            break

    log(f"Total targets: {len(targets)}")
    if not targets:
        log("No new targets found", "warn")
        return

    log(f"Starting DMs (max {MAX_DMS})...")
    dm_count = 0

    for username in targets:
        if dm_count >= MAX_DMS:
            log(f"Max DMs reached: {MAX_DMS}", "warn")
            break
        if username in processed:
            continue

        base_msg = MESSAGE_TPL.replace("{{username}}", f"@{username}").replace("{{sender}}", f"@{IG_USERNAME}")
        final_msg = groq_enhance(base_msg, username)

        log(f"Sending DM to @{username}...")
        sent = send_dm(cl, username, final_msg)
        processed.add(username)
        save_processed(processed)

        if sent:
            dm_count += 1
            log(f"DM sent -> @{username} ({dm_count}/{MAX_DMS})", "success")
        else:
            log(f"Failed: @{username}", "warn")

        wait = random.uniform(COOLDOWN_MIN, COOLDOWN_MAX)
        log(f"Waiting {wait:.0f}s...")
        time.sleep(wait)

    log(f"=== Done! {dm_count} DMs sent ===", "success")

if __name__ == "__main__":
    main()