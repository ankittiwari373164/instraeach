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

def _install_instagrapi():
    import subprocess
    cmds = [
        [sys.executable, "-m", "pip", "install", "instagrapi==2.1.2", "requests", "--quiet", "--break-system-packages"],
        [sys.executable, "-m", "pip", "install", "instagrapi==2.1.2", "requests", "--quiet"],
        ["pip3", "install", "instagrapi==2.1.2", "requests", "--quiet", "--break-system-packages"],
        ["pip3", "install", "instagrapi==2.1.2", "requests", "--quiet"],
    ]
    for cmd in cmds:
        try:
            result = subprocess.run(cmd, timeout=180, capture_output=True, text=True)
            if result.returncode == 0:
                log(f"instagrapi installed via: {cmd[0]} {cmd[2]}", "success")
                return True
            log(f"pip attempt failed: {result.stderr[:80]}", "warn")
        except Exception as e:
            log(f"pip error: {e}", "warn")
    return False

try:
    from instagrapi import Client
    from instagrapi.exceptions import (
        LoginRequired, ChallengeRequired, TwoFactorRequired,
        UserNotFound, RateLimitError
    )
    log("instagrapi ready")
except ImportError:
    log("instagrapi not found - installing...", "warn")
    ok = _install_instagrapi()
    if not ok:
        log("FATAL: Could not install instagrapi. Check build logs in Render.", "error")
        log("Fix: add 'pip3 install instagrapi' to your Render build command", "error")
        sys.exit(1)
    try:
        from instagrapi import Client
        from instagrapi.exceptions import (
            LoginRequired, ChallengeRequired, TwoFactorRequired,
            UserNotFound, RateLimitError
        )
        log("instagrapi installed and loaded", "success")
    except ImportError as e:
        log(f"FATAL: instagrapi import failed after install: {e}", "error")
        sys.exit(1)

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

# Your 9 Webshare free proxies from dashboard screenshot
WEBSHARE_PROXIES = [
    ("31.59.20.176",    "6754"),
    ("23.95.150.145",   "6114"),
    ("198.23.239.134",  "6540"),
    ("45.38.107.97",    "6014"),
    ("107.172.163.27",  "6543"),
    ("198.105.121.200", "6462"),
    ("64.137.96.74",    "6641"),
    ("216.10.27.159",   "6837"),
    ("142.111.67.146",  "5611"),
]
_proxy_index = 0

def get_proxy():
    """Primary proxy getter - Webshare list first, then IG_PROXY env var"""
    if WEBSHARE_USER and WEBSHARE_PASS and WEBSHARE_PROXIES:
        host, port = WEBSHARE_PROXIES[0]
        return f"http://{WEBSHARE_USER}:{WEBSHARE_PASS}@{host}:{port}"
    direct = os.environ.get("IG_PROXY", "").strip()
    if direct and direct.lower() != "none":
        return direct
    return None

def apply_proxy(cl, proxy_url):
    if not proxy_url: return cl
    try:
        cl.set_proxy(proxy_url)
        display = ("...@" + proxy_url.split("@")[-1]) if "@" in proxy_url else proxy_url
        log(f"Proxy active: {display}", "success")
    except Exception as e:
        log(f"Proxy error: {e}", "warn")
    return cl

def test_proxy(proxy_url):
    try:
        r = requests.get(
            "https://i.instagram.com/api/v1/si/fetch_headers/",
            proxies={"https": proxy_url, "http": proxy_url},
            timeout=8,
            headers={"User-Agent": "Instagram 269.0.0.18.75 Android"}
        )
        return r.status_code in (200, 400, 403, 429)
    except: return False

def get_free_proxy(attempt=0):
    """Rotate through Webshare proxies, then fall back to free public proxies"""
    if WEBSHARE_USER and WEBSHARE_PASS and WEBSHARE_PROXIES:
        for i in range(len(WEBSHARE_PROXIES)):
            idx = (attempt + i) % len(WEBSHARE_PROXIES)
            host, port = WEBSHARE_PROXIES[idx]
            purl = f"http://{WEBSHARE_USER}:{WEBSHARE_PASS}@{host}:{port}"
            log(f"Testing Webshare {idx+1}/{len(WEBSHARE_PROXIES)}: {host}:{port}")
            if test_proxy(purl):
                log(f"Webshare proxy {host}:{port} working!", "success")
                return purl
            time.sleep(2)
        log("All Webshare proxies failed - trying free public proxies...", "warn")

    log("Fetching free public proxies...", "warn")
    sources = [
        "https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=8000&country=all&ssl=all&anonymity=elite",
        "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
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
            cl.login(LOGIN_ID, IG_PASSWORD)
            info = cl.account_info()
            log(f"Session restored: @{info.username}", "success")
            return cl
        except Exception as e:
            log(f"Session invalid ({e}) - deleting and retrying...", "warn")
            try: os.remove(SESSION_FILE)
            except: pass

    # Normalize username (remove @ if present, lowercase, strip spaces)
    clean_user = IG_USERNAME.strip().lstrip("@").lower()
    if clean_user != IG_USERNAME:
        log(f"Username normalized: {IG_USERNAME} -> {clean_user}", "warn")

    # Fresh login — try with different proxies on each attempt
    last_err = None
    proxies_tried = set()

    # Also try login with email if IG_EMAIL env var is set
    IG_EMAIL = os.environ.get("IG_EMAIL", "").strip()

    for attempt in range(1, 6):  # up to 5 attempts
        log(f"Login attempt {attempt}/5 as @{IG_USERNAME}...")
        time.sleep(random.uniform(3, 8) * min(attempt, 3))
        try:
            cl2 = make_client()

            # Proxy selection per attempt
            if attempt == 1:
                # First attempt: use Webshare directly
                proxy = get_proxy()
                if proxy:
                    apply_proxy(cl2, proxy)
                    proxies_tried.add(proxy)
            elif attempt == 2:
                # Second attempt: Webshare with port 8080 explicitly
                ws = get_webshare_proxy()
                if ws and ws not in proxies_tried:
                    apply_proxy(cl2, ws)
                    proxies_tried.add(ws)
            else:
                # Further attempts: try free proxies
                free_p = get_free_proxy()
                if free_p and free_p not in proxies_tried:
                    apply_proxy(cl2, free_p)
                    proxies_tried.add(free_p)

            # Try email login on even attempts (more reliable through proxies)
            login_id = IG_EMAIL if (attempt % 2 == 0 and IG_EMAIL) else IG_USERNAME
            log(f"Logging in as: {login_id[:4]}***")
            cl2.login(login_id, IG_PASSWORD)
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
            is_ip_block  = "Expecting value" in last_err or "JSONDecodeError" in last_err or "SSLError" in last_err or "ProxyError" in last_err
            is_not_found = "can't find" in last_err.lower() or "not found" in last_err.lower()
            is_challenge  = "checkpoint" in last_err.lower() or "challenge" in last_err.lower()

            if is_challenge:
                log("Challenge detected - approve in Instagram app, retry in 10 mins", "error")
                sys.exit(1)
            elif is_not_found:
                log(f"Attempt {attempt}: Account not found via this proxy - trying different proxy...", "warn")
                time.sleep(random.uniform(10, 20))
            elif is_ip_block:
                log(f"Attempt {attempt}: Proxy error - switching proxy...", "warn")
                if attempt < 5:
                    time.sleep(random.uniform(15, 30))
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