"""Panel qo'shimchalari: uy vazifa muddati, portfolio, nishonlar,
kod muharriri, parolni tiklash va owner uchun ikki bosqichli kirish (2FA).
"""
import base64
import hashlib
import hmac
import json
import os
import secrets
import struct
import time
from datetime import date, datetime, timedelta
from urllib.parse import quote

from flask import Blueprint, jsonify, request
from werkzeug.security import generate_password_hash

import config
from core import (avatar_url, bump_session_version, current_user, get_db, get_setting, login_required,
                  owner_required, set_setting)

bp = Blueprint("extras", __name__)


def _int(value):
    return value if isinstance(value, int) and not isinstance(value, bool) else None


# --------------------------------------------------------------------------- #
#  1. Uy vazifa muddati: vaqtida topshirsa +1, kechiksa -1
# --------------------------------------------------------------------------- #
DEADLINE_BONUS = 1
DEADLINE_PENALTY = -1


def parse_deadline(value) -> tuple[str | None, str | None]:
    """'2026-11-20T18:00' -> (iso, xato)."""
    value = str(value or "").strip()
    if not value:
        return None, None
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        return None, "Muddat sanasi noto'g'ri"
    return dt.replace(second=0, microsecond=0).isoformat(timespec="minutes"), None


def deadline_mark(db, hw_id: int, user_id: int) -> int:
    """Birinchi topshirishda: muddatdan oldin bo'lsa +1, keyin bo'lsa -1 (bir marta)."""
    row = db.execute("SELECT deadline FROM homeworks WHERE id = ?", (hw_id,)).fetchone()
    if not row or not row["deadline"]:
        return 0
    late = datetime.now() > datetime.fromisoformat(row["deadline"])
    points = DEADLINE_PENALTY if late else DEADLINE_BONUS
    cur = db.execute("INSERT OR IGNORE INTO deadline_marks (homework_id, user_id, points, at) VALUES (?, ?, ?, ?)",
                     (hw_id, user_id, points, time.time()))
    if cur.rowcount:
        db.execute("UPDATE users SET score = score + ? WHERE id = ?", (points, user_id))
    db.commit()
    return points if cur.rowcount else 0


def deadline_of(db, hw_id: int, user_id: int):
    row = db.execute("SELECT points FROM deadline_marks WHERE homework_id = ? AND user_id = ?", (hw_id, user_id)).fetchone()
    return row["points"] if row else None


# --------------------------------------------------------------------------- #
#  3. Portfolio: eng yaxshi ishlar profilda
# --------------------------------------------------------------------------- #
PORTFOLIO_MAX = 12


def in_portfolio(db, sub_id: int) -> bool:
    return db.execute("SELECT 1 FROM portfolio WHERE submission_id = ?", (sub_id,)).fetchone() is not None


@bp.post("/api/portfolio/<int:sub_id>")
@login_required
def api_portfolio_toggle(sub_id: int):
    user = current_user()
    db = get_db()
    sub = db.execute("SELECT s.*, h.title FROM submissions s JOIN homeworks h ON h.id = s.homework_id WHERE s.id = ?",
                     (sub_id,)).fetchone()
    if not sub:
        return jsonify(error="Ish topilmadi"), 404
    if user["role"] != "owner" and sub["user_id"] != user.get("id"):
        return jsonify(error="Ruxsat yo'q"), 403
    if in_portfolio(db, sub_id):
        db.execute("DELETE FROM portfolio WHERE submission_id = ?", (sub_id,))
        db.commit()
        return jsonify(in_portfolio=False)
    if sub["status"] != "checked" or sub["score"] < 3:
        return jsonify(error="Portfolioga faqat tekshirilgan va 3 balldan yuqori ishlar qo'shiladi"), 400
    n = db.execute("SELECT COUNT(*) FROM portfolio WHERE user_id = ?", (sub["user_id"],)).fetchone()[0]
    if n >= PORTFOLIO_MAX:
        return jsonify(error=f"Portfolioda ko'pi bilan {PORTFOLIO_MAX} ta ish"), 400
    db.execute("INSERT INTO portfolio (submission_id, user_id, added_at) VALUES (?, ?, ?)", (sub_id, sub["user_id"], time.time()))
    db.commit()
    return jsonify(in_portfolio=True)


@bp.get("/api/profile/<int:user_id>/portfolio")
@login_required
def api_portfolio(user_id: int):
    db = get_db()
    rows = db.execute(
        "SELECT s.id, s.score, s.files, s.feedback, s.created_at, h.title FROM portfolio p "
        "JOIN submissions s ON s.id = p.submission_id JOIN homeworks h ON h.id = s.homework_id "
        "WHERE p.user_id = ? ORDER BY s.score DESC, p.added_at DESC", (user_id,)).fetchall()
    items = [{"id": r["id"], "title": r["title"], "score": r["score"], "max_score": config.HOMEWORK_MAX_SCORE,
              "files": json.loads(r["files"]), "feedback": (r["feedback"] or "")[:200], "date": r["created_at"][:10]}
             for r in rows]
    # Qo'shsa bo'ladigan ishlar (o'zi yoki owner uchun)
    user = current_user()
    candidates = []
    if user["role"] == "owner" or user.get("id") == user_id:
        cand = db.execute(
            "SELECT s.id, s.score, h.title FROM submissions s JOIN homeworks h ON h.id = s.homework_id "
            "WHERE s.user_id = ? AND s.status = 'checked' AND s.score >= 3 "
            "AND s.id NOT IN (SELECT submission_id FROM portfolio) ORDER BY s.score DESC", (user_id,)).fetchall()
        candidates = [{"id": r["id"], "title": r["title"], "score": r["score"]} for r in cand]
    return jsonify(items=items, candidates=candidates)


# --------------------------------------------------------------------------- #
#  7. Nishonlar (badge)
# --------------------------------------------------------------------------- #
BADGES = [
    ("streak10", "🔥", "10 kun ketma-ket", "Darsga 10 marta ketma-ket keldi"),
    ("noai", "🧠", "O'zi qildi", "5 ta uy vazifani AI'siz bajardi"),
    ("perfect", "⭐", "A'lochi", "3 ta uy vazifadan to'liq ball oldi"),
    ("ontime", "⏰", "Vaqtida", "5 ta vazifani muddatidan oldin topshirdi"),
    ("active", "💻", "Faol", "Saytda 10 soatdan ko'p vaqt o'tkazdi"),
    ("portfolio", "🖼️", "Ijodkor", "Portfoliosida 3 ta ish bor"),
]


def badges_of(db, user_id: int) -> list:
    got = set()
    # Ketma-ket kelgan darslar (oxiridan boshlab, "kelmadi" uzadi)
    days = db.execute("SELECT status FROM attendance WHERE user_id = ? ORDER BY day", (user_id,)).fetchall()
    run = best = 0
    for d in days:
        run = run + 1 if d["status"] in ("keldi", "kechikdi") else 0
        best = max(best, run)
    if best >= 10:
        got.add("streak10")
    subs = db.execute("SELECT score, ai_probability FROM submissions WHERE user_id = ? AND status = 'checked'", (user_id,)).fetchall()
    clean = [s for s in subs if s["ai_probability"] is None or s["ai_probability"] < config.AI_THRESHOLD]
    if len(clean) >= 5:
        got.add("noai")
    if sum(1 for s in subs if s["score"] >= config.HOMEWORK_MAX_SCORE) >= 3:
        got.add("perfect")
    if db.execute("SELECT COUNT(*) FROM deadline_marks WHERE user_id = ? AND points > 0", (user_id,)).fetchone()[0] >= 5:
        got.add("ontime")
    mins = db.execute("SELECT COALESCE(SUM(minutes), 0) FROM activity WHERE user_key = ?", (f"u{user_id}",)).fetchone()[0]
    if mins >= 600:
        got.add("active")
    if db.execute("SELECT COUNT(*) FROM portfolio WHERE user_id = ?", (user_id,)).fetchone()[0] >= 3:
        got.add("portfolio")
    return [{"id": b, "icon": i, "name": n, "about": a, "got": b in got} for b, i, n, a in BADGES]


@bp.get("/api/profile/<int:user_id>/badges")
@login_required
def api_badges(user_id: int):
    return jsonify(badges=badges_of(get_db(), user_id))


# --------------------------------------------------------------------------- #
#  6. Kod muharriri: HTML/CSS/JS yozib, darhol natijani ko'rish (owner o'quvchilarnikini ko'radi)
# --------------------------------------------------------------------------- #
CODE_MAX = 20000


@bp.get("/api/code")
@login_required
def api_code_get():
    user = current_user()
    row = get_db().execute("SELECT * FROM code_pad WHERE user_key = ?", (user["key"] if user["role"] == "owner" else f"u{user['id']}",)).fetchone()
    return jsonify(html=row["html"] if row else "", css=row["css"] if row else "", js=row["js"] if row else "")


@bp.post("/api/code")
@login_required
def api_code_save():
    user = current_user()
    data = request.get_json(silent=True) or {}
    html, css, js = (str(data.get(k) or "") for k in ("html", "css", "js"))
    if max(len(html), len(css), len(js)) > CODE_MAX:
        return jsonify(error=f"Kod {CODE_MAX} belgidan oshmasin"), 400
    key = "owner" if user["role"] == "owner" else f"u{user['id']}"
    db = get_db()
    db.execute("INSERT INTO code_pad (user_key, html, css, js, updated_at) VALUES (?, ?, ?, ?, ?) "
               "ON CONFLICT(user_key) DO UPDATE SET html = excluded.html, css = excluded.css, js = excluded.js, updated_at = excluded.updated_at",
               (key, html, css, js, time.time()))
    db.commit()
    return jsonify(ok=True)


@bp.get("/api/code/all")
@owner_required
def api_code_all():
    rows = get_db().execute(
        "SELECT c.*, u.name, u.avatar FROM code_pad c JOIN users u ON 'u' || u.id = c.user_key ORDER BY c.updated_at DESC").fetchall()
    return jsonify(items=[{"name": r["name"], "avatar": avatar_url(r["avatar"]), "html": r["html"], "css": r["css"], "js": r["js"],
                           "updated": datetime.fromtimestamp(r["updated_at"]).strftime("%d.%m %H:%M")} for r in rows])


# --------------------------------------------------------------------------- #
#  12. Parolni unutdim: owner bir bosishda yangi parol yaratadi
# --------------------------------------------------------------------------- #
@bp.post("/api/users/<int:user_id>/password/random")
@owner_required
def api_random_password(user_id: int):
    db = get_db()
    if not db.execute("SELECT 1 FROM users WHERE id = ?", (user_id,)).fetchone():
        return jsonify(error="Foydalanuvchi topilmadi"), 404
    new = f"{secrets.randbelow(900000) + 100000}"
    db.execute("UPDATE users SET password_hash = ? WHERE id = ?", (generate_password_hash(new), user_id))
    bump_session_version(user_id)
    db.commit()
    return jsonify(password=new)


# --------------------------------------------------------------------------- #
#  11. Owner uchun ikki bosqichli kirish (Google Authenticator kodi)
#      Telefon yo'qolsa: .env ga OWNER_2FA_OFF=1 yozib serverni qayta yoqing.
# --------------------------------------------------------------------------- #
def _totp(secret: str, counter: int) -> str:
    key = base64.b32decode(secret + "=" * (-len(secret) % 8))
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    off = digest[-1] & 0x0F
    code = (struct.unpack(">I", digest[off:off + 4])[0] & 0x7FFFFFFF) % 1_000_000
    return f"{code:06d}"


def totp_ok(secret: str, code) -> bool:
    code = "".join(ch for ch in str(code or "") if ch.isdigit())
    if len(code) != 6:
        return False
    step = int(time.time() // 30)
    return any(hmac.compare_digest(_totp(secret, step + d), code) for d in (-1, 0, 1))


def twofa_secret() -> str | None:
    if os.environ.get("OWNER_2FA_OFF") == "1":
        return None
    return get_setting("owner_totp")


@bp.get("/api/2fa")
@owner_required
def api_2fa_state():
    return jsonify(enabled=bool(get_setting("owner_totp")), bypass=os.environ.get("OWNER_2FA_OFF") == "1")


@bp.post("/api/2fa/setup")
@owner_required
def api_2fa_setup():
    secret = base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")
    set_setting("owner_totp_pending", secret)
    label = quote(f"O'yin:{config.OWNER_LOGIN}")
    uri = f"otpauth://totp/{label}?secret={secret}&issuer=O%27yin"
    return jsonify(secret=secret, uri=uri)


@bp.post("/api/2fa/enable")
@owner_required
def api_2fa_enable():
    secret = get_setting("owner_totp_pending")
    if not secret:
        return jsonify(error="Avval «Yoqish» tugmasini bosing"), 400
    if not totp_ok(secret, (request.get_json(silent=True) or {}).get("code")):
        return jsonify(error="Kod noto'g'ri — ilovadagi 6 xonali kodni yozing"), 400
    set_setting("owner_totp", secret)
    set_setting("owner_totp_pending", None)
    return jsonify(enabled=True)


@bp.post("/api/2fa/disable")
@owner_required
def api_2fa_disable():
    secret = get_setting("owner_totp")
    if secret and not totp_ok(secret, (request.get_json(silent=True) or {}).get("code")):
        return jsonify(error="Kod noto'g'ri"), 400
    set_setting("owner_totp", None)
    return jsonify(enabled=False)


SCHEMA = """
CREATE TABLE IF NOT EXISTS deadline_marks (
    homework_id INTEGER NOT NULL REFERENCES homeworks(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    points      INTEGER NOT NULL,
    at          REAL NOT NULL,
    PRIMARY KEY (homework_id, user_id)
);
CREATE TABLE IF NOT EXISTS portfolio (
    submission_id INTEGER PRIMARY KEY REFERENCES submissions(id) ON DELETE CASCADE,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    added_at      REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS code_pad (
    user_key   TEXT PRIMARY KEY,
    html       TEXT NOT NULL DEFAULT '',
    css        TEXT NOT NULL DEFAULT '',
    updated_at REAL NOT NULL,
    js         TEXT NOT NULL DEFAULT ''
);
"""
