"""Profil: foydalanuvchi ma'lumotlari, rasm (avatar) va parolni almashtirish."""
import re
import sqlite3
import time
from datetime import datetime

from flask import Blueprint, jsonify, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash

import config
import core
import game
from core import (RATING_SQL, avatar_url, bump_session_version, current_user, get_db, get_setting, login_required,
                  owner_required, set_setting, text_field)

bp = Blueprint("accounts", __name__)

MAX_AVATAR_BYTES = 2 * 1024 * 1024
MAX_PASSWORD = 64
AVATAR_NAME_RE = re.compile(r"^[a-z0-9_]+\.(png|jpg|gif|webp)$")
MONTHS = ["Yanvar", "Fevral", "Mart", "Aprel", "May", "Iyun",
          "Iyul", "Avgust", "Sentabr", "Oktabr", "Noyabr", "Dekabr"]


def sniff_image(data: bytes) -> str | None:
    """Fayl ichiga qarab rasm turini aniqlaydi (nomiga ishonmaymiz)."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def remove_avatar_file(filename: str | None) -> None:
    if filename and AVATAR_NAME_RE.match(filename):
        (core.AVATAR_DIR / filename).unlink(missing_ok=True)


def month_label(key: str) -> str:
    year, month = key.split("-")
    return f"{MONTHS[int(month) - 1]} {year}"


def date_label(iso: str) -> str:
    try:
        d = datetime.fromisoformat(iso)
    except ValueError:
        return ""
    return f"{d.day}-{MONTHS[d.month - 1]}, {d.year}"


# --------------------------------------------------------------------------- #
#  Rasm (avatar)
# --------------------------------------------------------------------------- #
@bp.get("/avatars/<name>")
@login_required
def serve_avatar(name: str):
    if not AVATAR_NAME_RE.match(name):
        return jsonify(error="Topilmadi"), 404
    # Nomida vaqt bor — rasm almashsa nom ham almashadi, shuning uchun uzoq keshlash mumkin
    return send_from_directory(core.AVATAR_DIR, name, max_age=30 * 24 * 3600)


def _avatar_target(target: str):
    """'me' yoki foydalanuvchi id'si -> (prefix, eski fayl, saqlovchi funksiya) yoki xato javobi."""
    user = current_user()
    if target == "me" and user["role"] == "owner":
        return ("owner", get_setting("owner_avatar"),
                lambda name: set_setting("owner_avatar", name)), None

    uid = user.get("id") if target == "me" else (int(target) if target.isdigit() else None)
    if uid is None:
        return None, (jsonify(error="Topilmadi"), 404)
    if user["role"] != "owner" and uid != user.get("id"):
        return None, (jsonify(error="Faqat o'z rasmingizni almashtira olasiz"), 403)
    row = get_db().execute("SELECT avatar FROM users WHERE id = ?", (uid,)).fetchone()
    if row is None:
        return None, (jsonify(error="Foydalanuvchi topilmadi"), 404)

    def save(name):
        db = get_db()
        db.execute("UPDATE users SET avatar = ? WHERE id = ?", (name, uid))
        db.commit()

    return (f"u{uid}", row["avatar"], save), None


@bp.post("/api/avatar/<target>")
@login_required
def upload_avatar(target: str):
    found, error = _avatar_target(target)
    if error:
        return error
    prefix, old, save = found

    upload = request.files.get("avatar")
    data = upload.read() if upload else b""
    if not data:
        return jsonify(error="Rasm tanlang"), 400
    if len(data) > MAX_AVATAR_BYTES:
        return jsonify(error="Rasm 2 MB dan oshmasin"), 400
    ext = sniff_image(data)
    if ext is None:
        return jsonify(error="Faqat PNG, JPG, GIF yoki WEBP rasm yuklang"), 400

    core.AVATAR_DIR.mkdir(parents=True, exist_ok=True)
    name = f"{prefix}_{int(time.time() * 1000)}.{ext}"
    (core.AVATAR_DIR / name).write_bytes(data)
    save(name)
    remove_avatar_file(old)
    return jsonify(avatar=avatar_url(name))


@bp.delete("/api/avatar/<target>")
@login_required
def delete_avatar(target: str):
    found, error = _avatar_target(target)
    if error:
        return error
    _prefix, old, save = found
    save(None)
    remove_avatar_file(old)
    return jsonify(avatar=None)


# --------------------------------------------------------------------------- #
#  Profil
# --------------------------------------------------------------------------- #
@bp.get("/api/profile/<int:user_id>")
@login_required
def profile(user_id: int):
    viewer = current_user()
    # Har kim faqat o'z profilini ko'radi — boshqasinikini bossa ham o'zinikiga tushadi.
    # Owner hammanikini ko'radi.
    if viewer["role"] != "owner":
        user_id = viewer["id"]
    db = get_db()
    ranking = db.execute(RATING_SQL).fetchall()
    index = next((i for i, r in enumerate(ranking) if r["id"] == user_id), None)
    if index is None:
        return jsonify(error="Foydalanuvchi topilmadi"), 404
    row = ranking[index]

    # Uy vazifa natijalari oylar bo'yicha (vazifa berilgan oyga qarab)
    max_score = config.HOMEWORK_MAX_SCORE
    months: dict[str, dict] = {}
    for hw in db.execute(
        "SELECT h.created_at, s.id AS sub_id, s.score FROM homeworks h "
        "LEFT JOIN submissions s ON s.homework_id = h.id AND s.user_id = ?", (user_id,)
    ):
        key = hw["created_at"][:7]
        m = months.setdefault(key, {"key": key, "label": month_label(key), "given": 0,
                                    "submitted": 0, "earned": 0})
        m["given"] += 1
        if hw["sub_id"] is not None:
            m["submitted"] += 1
            m["earned"] += hw["score"] or 0
    for m in months.values():
        m["possible"] = m["given"] * max_score
        m["percent"] = round(m["earned"] * 100 / m["possible"]) if m["possible"] else 0

    this_month = datetime.now().strftime("%Y-%m")
    current = months.pop(this_month, None) or {
        "key": this_month, "label": month_label(this_month), "given": 0, "submitted": 0,
        "earned": 0, "possible": 0, "percent": 0,
    }
    previous = sorted(months.values(), key=lambda m: m["key"], reverse=True)

    is_owner = viewer["role"] == "owner"
    is_me = viewer.get("id") == user_id
    data = {
        "id": row["id"],
        "name": row["name"],
        "avatar": avatar_url(row["avatar"]),
        "joined": row["created_at"],
        "joined_label": date_label(row["created_at"]),
        "rank": index + 1,
        "players": len(ranking),
        "total": row["total"],
        "is_me": is_me,
        "can_edit": is_owner or is_me,
        "month": current,
        "previous_months": previous,
        "max_score": max_score,
        "game": game.summary_for(db, f"u{user_id}"),
    }
    import portal
    data["deco"] = portal.deco_map(db, True).get(f"u{user_id}")
    if is_owner:
        data["login"] = row["login"]
    return jsonify(profile=data)


# --------------------------------------------------------------------------- #
#  Parol
# --------------------------------------------------------------------------- #
@bp.post("/api/me/password")
@login_required
def change_my_password():
    user = current_user()
    if user["role"] != "user":
        return jsonify(error="Owner paroli py/config.py faylida o'zgartiriladi"), 400
    data = request.get_json(silent=True) or {}
    current = text_field(data, "current")
    new = text_field(data, "new")

    db = get_db()
    row = db.execute("SELECT password_hash FROM users WHERE id = ?", (user["id"],)).fetchone()
    if not check_password_hash(row["password_hash"], current):
        return jsonify(error="Hozirgi parol noto'g'ri"), 400
    if not new or len(new) > MAX_PASSWORD:
        return jsonify(error=f"Yangi parol 1 dan {MAX_PASSWORD} belgigacha bo'lsin"), 400
    db.execute("UPDATE users SET password_hash = ? WHERE id = ?", (generate_password_hash(new), user["id"]))
    # Boshqa qurilmalardagi sessiyalar bekor bo'ladi, shu qurilmada esa kirgan holda qolasiz
    session["sv"] = bump_session_version(user["id"])
    db.commit()
    return jsonify(ok=True)


@bp.post("/api/users/<int:user_id>/credentials")
@owner_required
def set_user_credentials(user_id: int):
    """Owner foydalanuvchining ismini, loginini va/yoki parolini almashtiradi."""
    data = request.get_json(silent=True) or {}
    name = text_field(data, "name")
    login = text_field(data, "login")
    password = text_field(data, "password")
    if not (name or login or password):
        return jsonify(error="Yangi ism, login yoki parolni yozing"), 400
    if max(len(name), len(login), len(password)) > MAX_PASSWORD:
        return jsonify(error=f"Ism, login va parol {MAX_PASSWORD} belgidan oshmasin"), 400
    if login and login.lower() == config.OWNER_LOGIN.lower():
        return jsonify(error="Bu login band"), 409

    db = get_db()
    row = db.execute("SELECT name, login FROM users WHERE id = ?", (user_id,)).fetchone()
    if row is None:
        return jsonify(error="Foydalanuvchi topilmadi"), 404
    login_changed = bool(login) and login != row["login"]
    if login_changed:
        try:
            db.execute("UPDATE users SET login = ? WHERE id = ?", (login, user_id))
        except sqlite3.IntegrityError:
            db.rollback()
            return jsonify(error=f"«{login}» logini allaqachon band"), 409
    if name:
        db.execute("UPDATE users SET name = ? WHERE id = ?", (name, user_id))
    if password:
        db.execute("UPDATE users SET password_hash = ? WHERE id = ?", (generate_password_hash(password), user_id))
    # Login yoki parol almashsa — u odam hamma qurilmadan chiqib ketadi (faqat ism almashsa — yo'q)
    if login_changed or password:
        bump_session_version(user_id)
    db.commit()
    return jsonify(ok=True, name=name or row["name"], login=login or row["login"],
                   password_changed=bool(password), logged_out=bool(login_changed or password))


@bp.post("/api/users/<int:user_id>/password")
@owner_required
def set_user_password(user_id: int):
    data = request.get_json(silent=True) or {}
    new = text_field(data, "new")
    if not new or len(new) > MAX_PASSWORD:
        return jsonify(error=f"Yangi parol 1 dan {MAX_PASSWORD} belgigacha bo'lsin"), 400
    db = get_db()
    cur = db.execute("UPDATE users SET password_hash = ? WHERE id = ?", (generate_password_hash(new), user_id))
    if cur.rowcount == 0:
        return jsonify(error="Foydalanuvchi topilmadi"), 404
    bump_session_version(user_id)
    db.commit()
    return jsonify(ok=True)
