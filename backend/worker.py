#!/usr/bin/env python3
# worker.py — InstaReach Python Bot (instagrapi)
# Runs on Render server — no browser, no Puppeteer, no Xvfb needed
# Uses Instagram's private mobile API directly via instagrapi

import os, sys, json, time, random, requests, logging
from datetime import datetime
from instagrapi import Client
from instagrapi.exceptions import (
    LoginRequired, ChallengeRequired, UserNotFound,
    DirectThreadNotFound, ClientError
)

# ── Config ────────────────────────────────────────────────────
API_URL    = os.environ.get('API_URL',    'https://instraeach.onrender.com')
ADMIN_USER = os.environ.get('ADMIN_USER', 'admin')
ADMIN_PASS = os.environ.get('ADMIN_PASS', 'changeme123')
ACCOUNT_ID  = os.environ.get('ACCOUNT_ID',  '')
SESSION_ID  = os.environ.get('SESSION_ID',  '')
CAMPAIGN_ID = os.environ.get('CAMPAIGN_ID', '')
_data_dir = '/var/data' if os.path.isdir('/var/data') else '/tmp'
SETTINGS_FILE = _data_dir + '/ig_settings.json'  # persists session on Render disk

logging.basicConfig(level=logging.INFO, format='[%(levelname)s] %(message)s')
log = logging.getLogger('instraeach')

# ── Dashboard API ─────────────────────────────────────────────
token = None

def api(method, path, body=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    r = requests.request(method, API_URL + path, json=body, headers=headers, timeout=15)
    try:
        return r.json()
    except:
        return {}

def login_dashboard():
    global token
    r = api('POST', '/api/login', {'username': ADMIN_USER, 'password': ADMIN_PASS})
    if not r.get('token'):
        raise Exception('Dashboard login failed: ' + str(r))
    token = r['token']
    log.info('✓ Dashboard login OK')

def log_to_db(msg, level='info', username=None):
    log.info(f'{level.upper()} {msg}')
    try:
        api('POST', '/api/log', {
            'account_id': ACCOUNT_ID,
            'level': level,
            'message': msg,
            'username': username,
            'key': SESSION_ID,
        })
    except:
        pass

def mark_processed(campaign_id, username, sent):
    try:
        api('POST', '/api/processed', {
            'account_id': ACCOUNT_ID,
            'campaign_id': campaign_id,
            'target_username': username,
            'source': 'bot',
            'dm_sent': sent,
            'key': SESSION_ID,
        })
    except:
        pass

def check_running(campaign_id):
    try:
        r = api('GET', f'/api/campaigns/{campaign_id}/status')
        return r.get('status') == 'running'
    except:
        return True

def enhance_message(message, campaign_id):
    try:
        r = api('POST', '/api/enhance-message', {
            'message': message,
            'campaign_id': campaign_id,
            'account_id': ACCOUNT_ID,
            'key': SESSION_ID,
        })
        enhanced = r.get('enhanced', '')
        if enhanced and len(enhanced) > 20:
            return enhanced
    except:
        pass
    return message

# ── Instagram client ──────────────────────────────────────────
def create_client():
    cl = Client()
    # Set mobile device settings to look like a real phone
    cl.set_device({
        'app_version': '269.0.0.18.75',
        'android_version': 26,
        'android_release': '8.0.0',
        'dpi': '480dpi',
        'resolution': '1080x1920',
        'manufacturer': 'OnePlus',
        'device': 'ONEPLUS A3003',
        'model': 'OnePlus3',
        'cpu': 'qcom',
        'version_code': '314665256',
    })
    cl.set_user_agent(
        'Instagram 269.0.0.18.75 Android (26/8.0.0; 480dpi; 1080x1920; OnePlus; ONEPLUS A3003; OnePlus3; qcom; en_IN; 314665256)'
    )
    return cl

def login_instagram(cl):
    # Try loading saved settings first (avoids re-login challenges)
    if os.path.exists(SETTINGS_FILE):
        try:
            cl.load_settings(SETTINGS_FILE)
            cl.login(cl.username, cl.password)
            log.info('✓ Instagram session restored from saved settings')
            return
        except Exception as e:
            log.warning(f'Saved session failed: {e} — logging in fresh')

    # Login by session ID
    try:
        cl.login_by_sessionid(SESSION_ID)
        log.info('✓ Instagram logged in via sessionid')
        # Save settings for next time
        os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
        cl.dump_settings(SETTINGS_FILE)
    except LoginRequired:
        raise Exception('Session expired — update SESSION_ID in Render env vars')
    except ChallengeRequired:
        raise Exception('Instagram challenge required — open Instagram app and verify')

# ── Search users ──────────────────────────────────────────────
def search_users(cl, keyword, limit=10):
    try:
        results = cl.search_users(keyword, count=limit)
        return [u.username for u in results if u.username]
    except Exception as e:
        log.warning(f'Search failed for "{keyword}": {e}')
        return []

# ── Send DM ───────────────────────────────────────────────────
def send_dm(cl, username, message, image_url=None):
    try:
        # Get user ID
        user_id = cl.user_id_from_username(username)
        if not user_id:
            log_to_db(f'User not found: @{username}', 'warn', username)
            return False

        # Send image if set
        if image_url:
            try:
                full_url = image_url if image_url.startswith('http') else API_URL + image_url
                img_resp = requests.get(full_url, timeout=15)
                if img_resp.status_code == 200:
                    # Save temp file
                    tmp_path = f'/tmp/ig_img_{int(time.time())}.jpg'
                    with open(tmp_path, 'wb') as f:
                        f.write(img_resp.content)
                    cl.direct_send_photo(tmp_path, [user_id])
                    os.remove(tmp_path)
                    log_to_db(f'✓ Image sent → @{username}', 'info', username)
            except Exception as e:
                log_to_db(f'Image send failed: {e} — text only', 'warn', username)

        # Send text message
        cl.direct_send(message, [user_id])
        log_to_db(f'✓ DM sent → @{username}', 'success', username)
        return True

    except UserNotFound:
        log_to_db(f'User not found: @{username}', 'warn', username)
        return False
    except Exception as e:
        log_to_db(f'DM failed @{username}: {str(e)}', 'error', username)
        return False

# ── Main ──────────────────────────────────────────────────────
def main():
    if not SESSION_ID or SESSION_ID == 'PASTE_YOUR_SESSION_ID_HERE':
        log.error('SESSION_ID not set in environment variables!')
        sys.exit(1)
    if not ACCOUNT_ID:
        log.error('ACCOUNT_ID not set in environment variables!')
        sys.exit(1)

    log.info('InstaReach Python Bot starting...')

    # Login to dashboard
    login_dashboard()

    # Get running campaign
    campaigns = api('GET', '/api/campaigns')
    if not isinstance(campaigns, list) or not campaigns:
        log.error('No campaigns found')
        sys.exit(1)

    if CAMPAIGN_ID:
        campaign = next((c for c in campaigns if c.get('id') == CAMPAIGN_ID), None)
        log.info('Looking for campaign %s: %s' % (CAMPAIGN_ID, 'found' if campaign else 'NOT FOUND'))
    else:
        campaign = next((c for c in campaigns if c.get('account_id') == ACCOUNT_ID), None)

    if not campaign:
        log.error('No campaign found for this account')
        sys.exit(1)

    campaign_id = campaign['id']
    log.info(f'Campaign: {campaign["name"]} | Max DMs: {campaign.get("max_dms", 50)}')

    # Load already-processed
    proc = api('GET', f'/api/processed?account_id={ACCOUNT_ID}&key={SESSION_ID}')
    processed = set()
    if isinstance(proc, list):
        processed = {p['target_username'] for p in proc if p.get('dm_sent_at')}
    log.info(f'Already DMed: {len(processed)} accounts (will skip)')

    # Login to Instagram
    cl = create_client()
    login_instagram(cl)

    # Keywords
    keywords = []
    try:
        kw = campaign.get('keywords', [])
        keywords = json.loads(kw) if isinstance(kw, str) else kw
    except:
        pass

    EXTRA = [
        'real estate agent delhi', 'property dealer delhi', 'delhi property',
        'realestate delhi', 'homes delhi', 'flats delhi',
        'property consultant delhi', 'real estate broker delhi',
        'buy flat delhi', 'sell property delhi',
    ]
    all_keywords = list(dict.fromkeys(keywords + EXTRA))  # dedupe, preserve order
    log.info(f'Searching {len(all_keywords)} keywords...')

    # Collect targets
    targets = []
    for kw in all_keywords:
        if not check_running(campaign_id):
            break
        found = search_users(cl, kw, limit=15)
        fresh = [u for u in found if u not in processed and u not in targets]
        if fresh:
            log.info(f'"{kw}" → {len(fresh)} new targets')
        targets.extend(fresh)
        time.sleep(random.uniform(1.5, 3.0))
        if len(targets) >= 80:
            break

    log.info(f'Total targets: {len(targets)}')

    if not targets:
        log_to_db('No new targets found — add more keywords in dashboard', 'warn')
        sys.exit(0)

    # Send DMs
    max_dms  = campaign.get('max_dms', 50)
    cooldown = max(12, (campaign.get('cooldown_ms', 13000) or 13000) / 1000)
    dm_count = 0
    account_username = campaign.get('account_username', '')

    log_to_db(f'Starting DMs — {len(targets)} targets, max {max_dms}')

    for username in targets:
        if dm_count >= max_dms:
            log_to_db(f'Max DMs ({max_dms}) reached', 'warn')
            break
        if not check_running(campaign_id):
            log_to_db('Campaign stopped from dashboard', 'warn')
            break
        if username in processed:
            continue

        # Build message
        base_msg = (campaign.get('message') or '') \
            .replace('{{username}}', username) \
            .replace('{{sender}}',   '@' + account_username) \
            .replace('{{category}}', campaign.get('parent_category') or '')

        # Groq enhance
        final_msg = enhance_message(base_msg, campaign_id)
        if final_msg != base_msg:
            log.info(f'✨ AI enhanced for @{username}')

        result = send_dm(cl, username, final_msg, campaign.get('image_url'))
        mark_processed(campaign_id, username, result)
        processed.add(username)
        if result:
            dm_count += 1

        # Human-like delay
        wait = random.uniform(cooldown, cooldown + 12)
        log.info(f'Waiting {wait:.0f}s... ({dm_count}/{max_dms} sent)')
        time.sleep(wait)

    # Mark campaign done
    log_to_db(f'Session complete — {dm_count} DMs sent', 'success')
    api('PATCH', f'/api/campaigns/{campaign_id}/status', {'status': 'done'})

    # Save session for next run
    cl.dump_settings(SETTINGS_FILE)
    log.info('✓ Session saved')

if __name__ == '__main__':
    main()