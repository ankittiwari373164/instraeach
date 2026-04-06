#!/usr/bin/env python3
"""
ig_bridge.py — InstaReach v4
Supports: username/password login, TOTP 2FA, image+text DMs, search, inbox.
"""
import sys, json, os, base64, tempfile, warnings
warnings.filterwarnings("ignore")


# ── TOTP helper ────────────────────────────────────────────────────
def get_totp_code(secret):
    """Generate current TOTP code from base32 secret (no extra libs needed)."""
    try:
        import hmac, hashlib, struct, time, base64 as b64
        secret = secret.strip().upper().replace(' ', '')
        missing = len(secret) % 8
        if missing:
            secret += '=' * (8 - missing)
        key = b64.b32decode(secret)
        t = int(time.time()) // 30
        msg = struct.pack('>Q', t)
        h = hmac.new(key, msg, hashlib.sha1).digest()
        offset = h[-1] & 0x0F
        code = struct.unpack('>I', h[offset:offset+4])[0] & 0x7FFFFFFF
        return str(code % 1000000).zfill(6)
    except Exception as e:
        raise RuntimeError(f"TOTP generation failed: {e}")


# ── Image preparation ──────────────────────────────────────────────
def prepare_image(image_b64, image_ext):
    img_bytes = base64.b64decode(image_b64)
    try:
        from PIL import Image
        import io
        img = Image.open(io.BytesIO(img_bytes))
        if img.mode in ('RGBA', 'P', 'LA'):
            bg = Image.new('RGB', img.size, (255, 255, 255))
            if img.mode == 'P':
                img = img.convert('RGBA')
            mask = img.split()[-1] if img.mode in ('RGBA', 'LA') else None
            bg.paste(img, mask=mask)
            img = bg
        elif img.mode != 'RGB':
            img = img.convert('RGB')
        w, h = img.size
        if w < 320 or h < 320:
            scale = max(320 / w, 320 / h)
            img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
        if max(img.size) > 1440:
            scale = 1440 / max(img.size)
            img = img.resize((int(img.size[0]*scale), int(img.size[1]*scale)), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format='JPEG', quality=92)
        img_bytes = buf.getvalue()
        image_ext = 'jpg'
    except ImportError:
        pass
    tmp = tempfile.NamedTemporaryFile(suffix=f'.{image_ext}', delete=False)
    tmp.write(img_bytes)
    tmp.close()
    return tmp.name


# ── Client loader ──────────────────────────────────────────────────
def load_client(username, session_file, password=None, totp_secret=None):
    from instagrapi import Client
    cl = Client()
    cl.delay_range = [2, 5]

    # Try saved session first
    if session_file and os.path.exists(session_file):
        try:
            cl.load_settings(session_file)
            cl.login(username, password or "")
            cl.dump_settings(session_file)
            return cl
        except Exception:
            pass

    if not password:
        raise RuntimeError(f"No valid session and no password for @{username}")

    try:
        cl.login(username, password)
        if session_file:
            os.makedirs(os.path.dirname(session_file), exist_ok=True)
            cl.dump_settings(session_file)
        return cl

    except Exception as e:
        err_str = str(e)
        # Detect 2FA requirement
        if 'two_factor' in err_str.lower() or 'TwoFactorRequired' in err_str or '2fa' in err_str.lower():
            if not totp_secret:
                raise RuntimeError(
                    f"2FA required for @{username} but no TOTP secret provided. "
                    "Add your authenticator app secret key to the account."
                )
            totp_code = get_totp_code(totp_secret)
            try:
                cl.login(username, password, verification_code=totp_code)
                if session_file:
                    os.makedirs(os.path.dirname(session_file), exist_ok=True)
                    cl.dump_settings(session_file)
                return cl
            except Exception as e2:
                raise RuntimeError(f"2FA login failed for @{username}: {e2}")

        if 'challenge' in err_str.lower():
            raise RuntimeError(
                f"Challenge required for @{username} — open Instagram on your phone "
                "and approve the login, then retry."
            )
        raise RuntimeError(f"Login failed for @{username}: {e}")


# ── Commands ───────────────────────────────────────────────────────
def cmd_login(data):
    try:
        load_client(data["username"], data.get("session_file",""), data["password"], data.get("totp_secret","") or None)
        return {"ok": True, "username": data["username"]}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def cmd_search(data):
    try:
        cl = load_client(data["username"], data.get("session_file",""), data.get("password",""), data.get("totp_secret","") or None)
        keyword = data["keyword"]
        users = set()
        hashtag  = keyword.replace(" ","").replace("-","").lower()
        hashtag2 = keyword.replace(" ","_").lower()
        for fn, arg, amt in [
            (cl.hashtag_medias_recent, hashtag,  30),
            (cl.hashtag_medias_top,    hashtag,  20),
            (cl.hashtag_medias_recent, hashtag2, 20),
        ]:
            try:
                for m in fn(arg, amount=amt):
                    if hasattr(m,'user') and m.user: users.add(m.user.username)
                if len(users) >= 20: break
            except Exception: pass
        if len(users) < 5:
            try:
                for u in cl.search_users(keyword, count=15): users.add(u.username)
            except Exception: pass
        return {"ok": True, "users": list(users)}
    except Exception as e:
        return {"ok": False, "error": str(e), "users": []}


def cmd_send_dm(data):
    username     = data["username"]
    password     = data.get("password","")
    totp_secret  = data.get("totp_secret","") or None
    session_file = data.get("session_file","")
    to_username  = data["to_username"]
    message      = data["message"]
    image_b64    = data.get("image_b64","").strip()
    image_ext    = data.get("image_ext","jpg") or "jpg"
    tmp_path     = None
    try:
        cl = load_client(username, session_file, password, totp_secret)
        user_id = cl.user_id_from_username(to_username)

        image_sent = False
        if image_b64:
            try:
                tmp_path = prepare_image(image_b64, image_ext)
                from pathlib import Path
                cl.direct_send_photo(Path(tmp_path), user_ids=[user_id])
                image_sent = True
            except Exception as ie:
                return {"ok": False, "reason": "image_error", "error": f"Image failed: {ie}"}
            finally:
                if tmp_path and os.path.exists(tmp_path):
                    try: os.unlink(tmp_path)
                    except: pass
                tmp_path = None

        if message:
            cl.direct_send(message, user_ids=[user_id])

        return {"ok": True, "image_sent": image_sent}
    except Exception as e:
        err = str(e).lower()
        reason = "unknown"
        if "login" in err or "challenge" in err: reason = "session_expired"
        elif "429" in err or "throttle" in err:  reason = "rate_limited"
        elif "not found" in err:                  reason = "user_not_found"
        elif "block" in err:                      reason = "blocked"
        return {"ok": False, "reason": reason, "error": str(e)}
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try: os.unlink(tmp_path)
            except: pass


def cmd_inbox(data):
    try:
        cl = load_client(data["username"], data.get("session_file",""), data.get("password",""), data.get("totp_secret","") or None)
        messages = []
        for thread in cl.direct_threads(amount=20):
            other = thread.users[0] if thread.users else None
            if not other: continue
            for msg in thread.messages:
                if str(msg.user_id) == str(other.pk) and msg.text:
                    messages.append({"from_username": other.username, "text": msg.text, "timestamp": str(msg.timestamp)})
        return {"ok": True, "messages": messages}
    except Exception as e:
        return {"ok": False, "error": str(e), "messages": []}


def cmd_verify_totp(data):
    try:
        secret = data.get("totp_secret","")
        if not secret: return {"ok": False, "error": "No TOTP secret provided"}
        code = get_totp_code(secret)
        return {"ok": True, "code": code}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def main():
    try:
        data = json.loads(sys.stdin.read().strip())
    except Exception:
        print(json.dumps({"ok": False, "error": "Invalid JSON"})); sys.exit(1)
    handlers = {"login": cmd_login, "search": cmd_search, "send_dm": cmd_send_dm, "inbox": cmd_inbox, "verify_totp": cmd_verify_totp}
    handler = handlers.get(data.get("cmd",""))
    if not handler:
        print(json.dumps({"ok": False, "error": f"Unknown command: {data.get('cmd')}"})); sys.exit(1)
    print(json.dumps(handler(data)))

if __name__ == "__main__":
    main()
