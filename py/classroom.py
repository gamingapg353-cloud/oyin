"""Sinf: qurilma himoyasi, bildirishnomalar, ball sovg'asi, davomat va dars savollari.

Qurilma himoyasi: har bir akkauntga birinchi kirgan qurilma — "asosiy". Boshqa qurilmadan kirib
uy sotmoqchi, pul/ball sovg'a qilmoqchi bo'lsa, himoya uni akkauntdan chiqarib yuboradi
(sotuvdagi uylari ham sotuvdan olinadi). Owner kim qaysi akkauntga kirganini tepada ko'radi.

Davomat: owner sanani tanlaydi, har o'quvchiga Keldi / Kechikdi / Kelmadi va 0..5 ball qo'yadi
(Kelmadi = -1). «Boshlash» bosilsa o'quvchiga 5 ta HTML/CSS savol boradi — nechta to'g'ri
bo'lsa, shuncha ball o'sha kunga yoziladi.
"""
import json
import random
import secrets
import time
from datetime import date, datetime, timedelta

from flask import Blueprint, g, jsonify, request, session

import config
from core import avatar_url, current_user, get_db, get_setting, login_required, owner_required, set_setting

bp = Blueprint("classroom", __name__)

DEVICE_COOKIE = "oyin_dev"
ONLINE_WINDOW = 10 * 60          # shu vaqt ichida faollik bo'lsa — "kirgan"
SEEN_EVERY = 60                  # faollikni bazaga shuncha soniyada bir yozamiz


# --------------------------------------------------------------------------- #
#  Qurilmalar
# --------------------------------------------------------------------------- #
def device_id() -> str:
    """Brauzerning doimiy qurilma belgisi (cookie). Yo'q bo'lsa — yangisi (javobda o'rnatiladi)."""
    dev = request.cookies.get(DEVICE_COOKIE)
    if not dev or len(dev) > 64:
        dev = getattr(g, "new_device", None) or secrets.token_urlsafe(16)
        g.new_device = dev
    return dev


def _ua_label(ua: str) -> str:
    ua = ua or ""
    os_name = ("Android" if "Android" in ua else "iPhone" if "iPhone" in ua or "iPad" in ua
               else "Windows" if "Windows" in ua else "Mac" if "Mac OS" in ua else "Linux" if "Linux" in ua else "Noma'lum")
    browser = ("Edge" if "Edg/" in ua else "Opera" if "OPR/" in ua else "Chrome" if "Chrome" in ua
               else "Firefox" if "Firefox" in ua else "Safari" if "Safari" in ua else "Brauzer")
    return f"{os_name} · {browser}"


def touch_device(user_key: str, force: bool = False) -> None:
    """Shu qurilmadan faollikni yozadi (har SEEN_EVERY soniyada bir marta)."""
    now = time.time()
    if not force and now - session.get("seen", 0) < SEEN_EVERY:
        return
    session["seen"] = now
    db = get_db()
    dev = device_id()
    ua = (request.headers.get("User-Agent") or "")[:300]
    db.execute(
        "INSERT INTO devices (user_key, device, ua, first_at, last_at) VALUES (?, ?, ?, ?, ?) "
        "ON CONFLICT(user_key, device) DO UPDATE SET last_at = excluded.last_at, ua = excluded.ua",
        (user_key, dev, ua, now, now),
    )
    import school
    school.add_minute(db, user_key)  # faollik: saytda yana bir daqiqa
    db.commit()


def primary_device(db, user_key: str) -> str | None:
    row = db.execute("SELECT device FROM devices WHERE user_key = ? ORDER BY first_at, rowid LIMIT 1",
                     (user_key,)).fetchone()
    return row["device"] if row else None


def guard(user: dict, action: str):
    """Asosiy bo'lmagan qurilmadan xavfli amal — akkauntdan chiqarib yuboradi. Ruxsat bo'lsa None."""
    if not user or user["role"] == "owner":
        return None
    db = get_db()
    key = user["key"]
    touch_device(key, force=True)
    dev = device_id()
    if primary_device(db, key) in (None, dev):
        return None
    if action == "sell":
        db.execute("UPDATE game_plots SET sale_price = NULL WHERE owner_key = ?", (key,))
    db.execute("INSERT INTO security_log (user_key, device, action, t) VALUES (?, ?, ?, ?)", (key, dev, action, time.time()))
    db.commit()
    notify("owner", f"🛡️ Himoya: {user['name']} akkauntiga boshqa qurilmadan kirib "
                    f"{ {'sell': 'uy sotmoqchi', 'gift': 'sovg‘a qilmoqchi', 'points': 'ball bermoqchi'}.get(action, action) } bo'ldi — chiqarib yuborildi",
           "/panel#rating")
    session.clear()
    return jsonify(error="Himoya: bu akkaunt boshqa qurilmaga tegishli. Siz akkauntdan chiqarildingiz."), 401


@bp.get("/api/online-accounts")
@owner_required
def api_online_accounts():
    db = get_db()
    now = time.time()
    names = {f"u{r['id']}": r["name"] for r in db.execute("SELECT id, name FROM users")}
    rows = db.execute("SELECT * FROM devices WHERE last_at > ? ORDER BY first_at", (now - ONLINE_WINDOW,)).fetchall()
    accounts = {}
    for r in rows:
        if r["user_key"] not in names:
            continue
        acc = accounts.setdefault(r["user_key"], {"key": r["user_key"], "name": names[r["user_key"]], "devices": []})
        acc["devices"].append({"label": _ua_label(r["ua"]), "primary": r["device"] == primary_device(db, r["user_key"]),
                               "ago": int(now - r["last_at"])})
    out = sorted(accounts.values(), key=lambda a: (-len(a["devices"]), a["name"].lower()))
    for a in out:
        a["shared"] = len(a["devices"]) > 1 or not any(d["primary"] for d in a["devices"])
    log = [{"name": names.get(r["user_key"], "?"), "action": r["action"], "t": r["t"]}
           for r in db.execute("SELECT * FROM security_log ORDER BY id DESC LIMIT 10")]
    return jsonify(accounts=out, log=log)


@bp.post("/api/devices/reset")
@owner_required
def api_devices_reset():
    """Owner: akkauntning qurilmalarini tozalash (yangi telefon olgan bo'lsa — keyingi kirish asosiy bo'ladi)."""
    key = (request.get_json(silent=True) or {}).get("key")
    db = get_db()
    db.execute("DELETE FROM devices WHERE user_key = ?", (key,))
    db.commit()
    return jsonify(ok=True)


def after_request(response):
    dev = getattr(g, "new_device", None)
    if dev:
        response.set_cookie(DEVICE_COOKIE, dev, max_age=2 * 365 * 24 * 3600, httponly=True, samesite="Lax")
    return response


def before_request():
    if request.path.startswith("/api/") or request.path in ("/panel", "/game"):
        user = current_user()
        if user and user["role"] != "owner":
            touch_device(user["key"])


# --------------------------------------------------------------------------- #
#  Bildirishnomalar (qo'ng'iroq)
# --------------------------------------------------------------------------- #
def notify(user_key: str, text: str, link: str = "") -> None:
    db = get_db()
    db.execute("INSERT INTO notifications (user_key, text, link, t, seen) VALUES (?, ?, ?, ?, 0)",
               (user_key, text[:300], link, time.time()))
    db.commit()


def notify_all_users(text: str, link: str = "") -> None:
    db = get_db()
    now = time.time()
    db.executemany("INSERT INTO notifications (user_key, text, link, t, seen) VALUES (?, ?, ?, ?, 0)",
                   [(f"u{r['id']}", text[:300], link, now) for r in db.execute("SELECT id FROM users")])
    db.commit()


def mention(author: dict, text: str) -> int:
    """Chatdagi @ism — o'sha odamga bildirishnoma. Nechta odam belgilanganini qaytaradi."""
    if "@" not in text:
        return 0
    db = get_db()
    people = [("owner", config.OWNER_NAME, config.OWNER_LOGIN)] + [
        (f"u{r['id']}", r["name"], r["login"]) for r in db.execute("SELECT id, name, login FROM users")]
    low = text.lower()
    hits = set()
    for key, name, login in people:
        for handle in {name.lower(), name.lower().replace(" ", ""), (login or "").lower()}:
            if handle and f"@{handle}" in low and key != author["key"]:
                hits.add(key)
    for key in hits:
        notify(key, f"💬 {author['name']} o'yin chatida sizni eslatdi: {text[:160]}", "/game")
    return len(hits)


@bp.get("/api/notifications")
@login_required
def api_notifications():
    key = current_user()["key"]
    db = get_db()
    rows = db.execute("SELECT * FROM notifications WHERE user_key = ? ORDER BY id DESC LIMIT 30", (key,)).fetchall()
    unread = db.execute("SELECT COUNT(*) FROM notifications WHERE user_key = ? AND seen = 0", (key,)).fetchone()[0]
    return jsonify(items=[{"id": r["id"], "text": r["text"], "link": r["link"], "t": r["t"], "seen": bool(r["seen"])}
                          for r in rows], unread=unread)


@bp.post("/api/notifications/read")
@login_required
def api_notifications_read():
    key = current_user()["key"]
    db = get_db()
    db.execute("UPDATE notifications SET seen = 1 WHERE user_key = ?", (key,))
    db.commit()
    return jsonify(ok=True)


# --------------------------------------------------------------------------- #
#  Ball sovg'asi (reytingda): o'z ballingizdan boshqaga berish
# --------------------------------------------------------------------------- #
GIFT_MAX = 100


def user_total(db, user_id: int) -> int:
    row = db.execute(TOTAL_SQL + " WHERE u.id = ?", (user_id,)).fetchone()
    return row["total"] if row else 0


TOTAL_SQL = (
    "SELECT u.id, u.score + COALESCE((SELECT SUM(s.score) FROM submissions s WHERE s.user_id = u.id), 0) "
    "+ COALESCE((SELECT SUM(a.points) FROM attendance a WHERE a.user_id = u.id), 0) AS total FROM users u"
)


@bp.post("/api/points/gift")
@login_required
def api_points_gift():
    user = current_user()
    if user["role"] != "user":
        return jsonify(error="Owner «Ball berish» bo'limidan beradi"), 400
    data = request.get_json(silent=True) or {}
    to, amount = data.get("to"), data.get("amount")
    if isinstance(amount, bool) or not isinstance(amount, int) or not 1 <= amount <= GIFT_MAX:
        return jsonify(error=f"1 dan {GIFT_MAX} gacha ball bera olasiz"), 400
    if not isinstance(to, int) or isinstance(to, bool) or to == user["id"]:
        return jsonify(error="Kimga berishni tanlang"), 400
    blocked = guard(user, "points")
    if blocked:
        return blocked
    db = get_db()
    target = db.execute("SELECT id, name FROM users WHERE id = ?", (to,)).fetchone()
    if target is None:
        return jsonify(error="Bunday odam yo'q"), 404
    if user_total(db, user["id"]) < amount:
        return jsonify(error="Sizda buncha ball yo'q"), 400
    db.execute("UPDATE users SET score = score - ? WHERE id = ?", (amount, user["id"]))
    db.execute("UPDATE users SET score = score + ? WHERE id = ?", (amount, to))
    db.execute("INSERT INTO point_gifts (from_id, to_id, amount, t) VALUES (?, ?, ?, ?)", (user["id"], to, amount, time.time()))
    db.commit()
    notify(f"u{to}", f"🎁 {user['name']} sizga {amount} ball sovg'a qildi!", "/panel#rating")
    return jsonify(ok=True, to=target["name"], amount=amount, my_total=user_total(db, user["id"]))


# --------------------------------------------------------------------------- #
#  Davomat va ball berish
# --------------------------------------------------------------------------- #
STATUSES = ("keldi", "kechikdi", "kelmadi")
MAX_POINTS = 5
ABSENT_POINTS = -1


def _day(value) -> str | None:
    try:
        return date.fromisoformat(str(value)).isoformat()
    except (TypeError, ValueError):
        return None


def lesson_days() -> list:
    try:
        days = json.loads(get_setting("lesson_days") or "[]")
    except ValueError:
        return []
    return [d for d in days if isinstance(d, int) and 0 <= d <= 6]


def _homework_state(db, user_id: int) -> dict | None:
    row = db.execute(
        "SELECT s.status, s.score, s.graded_by, h.title FROM submissions s JOIN homeworks h ON h.id = s.homework_id "
        "WHERE s.user_id = ? ORDER BY s.id DESC LIMIT 1", (user_id,)).fetchone()
    if row is None:
        return None
    return {"title": row["title"], "status": row["status"], "score": row["score"], "by": row["graded_by"]}


@bp.get("/api/attendance")
@owner_required
def api_attendance():
    day = _day(request.args.get("day")) or date.today().isoformat()
    month = day[:7]
    db = get_db()
    marks = {r["user_id"]: r for r in db.execute("SELECT * FROM attendance WHERE day = ?", (day,))}
    users = []
    group = request.args.get("group", type=int)
    sql = "SELECT id, name, avatar FROM users " + ("WHERE group_id = ? " if group else "") + "ORDER BY name COLLATE NOCASE"
    for u in db.execute(sql, (group,) if group else ()):
        a = marks.get(u["id"])
        users.append({"id": u["id"], "name": u["name"], "avatar": avatar_url(u["avatar"]),
                      "status": a["status"] if a else None, "points": a["points"] if a else 0,
                      "homework": _homework_state(db, u["id"])})
    recorded = [r["day"] for r in db.execute("SELECT DISTINCT day FROM attendance WHERE day LIKE ?", (month + "%",))]
    return jsonify(day=day, users=users, recorded=recorded, lesson_days=lesson_days(), max=MAX_POINTS,
                   today=date.today().isoformat())


@bp.post("/api/attendance")
@owner_required
def api_attendance_set():
    data = request.get_json(silent=True) or {}
    day = _day(data.get("day"))
    user_id, status, points = data.get("user_id"), data.get("status"), data.get("points", 0)
    if not day or day > date.today().isoformat():
        return jsonify(error="Sanani tanlang (kelajakdagi kun emas)"), 400
    if not isinstance(user_id, int) or isinstance(user_id, bool):
        return jsonify(error="O'quvchini tanlang"), 400
    if status is not None and status not in STATUSES:
        return jsonify(error="Holat: keldi, kechikdi yoki kelmadi"), 400
    if isinstance(points, bool) or not isinstance(points, int) or not 0 <= points <= MAX_POINTS:
        return jsonify(error=f"Ball 0 dan {MAX_POINTS} gacha"), 400
    db = get_db()
    if not db.execute("SELECT 1 FROM users WHERE id = ?", (user_id,)).fetchone():
        return jsonify(error="Bunday o'quvchi yo'q"), 404
    if status is None:
        db.execute("DELETE FROM attendance WHERE day = ? AND user_id = ?", (day, user_id))
    else:
        value = ABSENT_POINTS if status == "kelmadi" else points
        db.execute("INSERT INTO attendance (day, user_id, status, points, updated_at) VALUES (?, ?, ?, ?, ?) "
                   "ON CONFLICT(day, user_id) DO UPDATE SET status = excluded.status, points = excluded.points, "
                   "updated_at = excluded.updated_at", (day, user_id, status, value, time.time()))
    db.commit()
    return jsonify(ok=True, points=ABSENT_POINTS if status == "kelmadi" else (points if status else 0))


@bp.post("/api/attendance/settings")
@owner_required
def api_attendance_settings():
    days = (request.get_json(silent=True) or {}).get("days")
    if not isinstance(days, list) or not all(isinstance(d, int) and not isinstance(d, bool) and 0 <= d <= 6 for d in days):
        return jsonify(error="Dars kunlarini tanlang"), 400
    set_setting("lesson_days", json.dumps(sorted(set(days))))
    return jsonify(lesson_days=lesson_days())


def _install() -> None:
    import game
    game.SECURITY = guard
    game.MENTION = mention


_install()

