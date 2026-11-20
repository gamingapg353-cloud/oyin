"""O'yin — Flask server.

Ishga tushirish (loyiha papkasidan):
    python py/app.py
So'ng brauzerda oching:  http://127.0.0.1:5000

HTML sahifalar loyiha papkasining o'zida turadi: index.html (kirish), panel.html (panel).
"""
import hmac
import os
import secrets
import sqlite3
import threading
import webbrowser
from datetime import timedelta

from flask import Flask, jsonify, redirect, render_template, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

import accounts
import ai_check
import config
import exam
import extras
import game_life
import game_city
import game
import game_social
import game_fun
import classroom
import school
import homework
import poll
from build_css import build_css
from core import (DATA_DIR, RATING_SQL, ROOT_DIR, avatar_url, close_db, current_user, get_db,
                  init_db, now_iso, owner_required, text_field)
from icons import icon

MAX_LEN = 64
MAX_UPLOAD_MB = 25
SECRET_PATH = DATA_DIR / "secret.key"


# --------------------------------------------------------------------------- #
#  Sozlash
# --------------------------------------------------------------------------- #
def load_secret_key() -> str:
    """Sessiya cookie'larini imzolash uchun kalit (birinchi ishga tushishda yaratiladi)."""
    DATA_DIR.mkdir(exist_ok=True)
    if SECRET_PATH.exists():
        return SECRET_PATH.read_text(encoding="utf-8").strip()
    key = secrets.token_hex(32)
    SECRET_PATH.write_text(key, encoding="utf-8")
    return key


app = Flask(
    __name__,
    template_folder=str(ROOT_DIR),          # index.html va panel.html shu yerda
    static_folder=str(ROOT_DIR / "static"),
)
app.config.update(
    SECRET_KEY=load_secret_key(),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(days=7),
    MAX_CONTENT_LENGTH=MAX_UPLOAD_MB * 1024 * 1024,
)
app.json.ensure_ascii = False
app.teardown_appcontext(close_db)
app.register_blueprint(homework.bp)
app.register_blueprint(accounts.bp)
app.register_blueprint(game.bp)
app.register_blueprint(game_social.bp)
app.register_blueprint(game_fun.bp)
app.register_blueprint(classroom.bp)
app.register_blueprint(school.bp)
app.before_request(classroom.before_request)
app.after_request(classroom.after_request)
app.register_blueprint(poll.bp)
app.register_blueprint(exam.bp)
app.register_blueprint(extras.bp)
app.register_blueprint(game_life.bp)
app.register_blueprint(game_city.bp)


def asset(filename: str) -> str:
    """static/ fayl manzili + versiya (fayl o'zgarsa brauzer eski nusxani ishlatmaydi)."""
    try:
        version = int((ROOT_DIR / "static" / filename).stat().st_mtime)
    except OSError:
        version = 0
    return url_for("static", filename=filename, v=version)


app.jinja_env.globals.update(icon=icon, asset=asset)


@app.after_request
def security_headers(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    return response


@app.errorhandler(413)
def too_large(_err):
    return jsonify(error=f"Fayllar juda katta: hammasi birga {MAX_UPLOAD_MB} MB dan oshmasin"), 413


def same_text(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def user_total(user_id: int) -> int:
    """Jami ball = owner bergan ballar + uy vazifalar + davomat (dars ballari)."""
    return classroom.user_total(get_db(), user_id)


# --------------------------------------------------------------------------- #
#  Sahifalar
# --------------------------------------------------------------------------- #
@app.get("/")
def login_page():
    if current_user():
        return redirect(url_for("panel"))
    return render_template("index.html")


@app.get("/panel")
def panel():
    user = current_user()
    if not user:
        return redirect(url_for("login_page"))
    return render_template(
        "panel.html",
        user=user,
        is_owner=user["role"] == "owner",
        ai_enabled=ai_check.ai_enabled(),
        max_score=config.HOMEWORK_MAX_SCORE,
        min_score=config.HOMEWORK_MIN_SCORE,
        accept=",".join(ai_check.ACCEPT),
    )


# --------------------------------------------------------------------------- #
#  API: kirish / chiqish
# --------------------------------------------------------------------------- #
@app.post("/api/login")
def api_login():
    data = request.get_json(silent=True) or {}
    role = data.get("role")
    login = text_field(data, "login")
    password = text_field(data, "password")
    if not login or not password:
        return jsonify(error="Login va parolni kiriting"), 400

    need_code = []

    def as_owner() -> bool:
        login_ok = same_text(login.lower(), config.OWNER_LOGIN.lower())
        password_ok = same_text(password, config.OWNER_PASSWORD)
        if not (login_ok and password_ok):
            return False
        secret = extras.twofa_secret()  # ikki bosqichli kirish yoqilgan bo'lsa — ilovadagi kod
        if secret and not extras.totp_ok(secret, data.get("code")):
            need_code.append(bool(data.get("code")))
            return False
        session.clear()
        session.permanent = True
        session.update(role="owner", login=config.OWNER_LOGIN)
        return True

    blocked = []

    def as_user() -> bool:
        row = get_db().execute(
            "SELECT id, name, password_hash, session_version FROM users WHERE login = ?", (login,)
        ).fetchone()
        if not (row and check_password_hash(row["password_hash"], password)):
            return False
        problem = classroom.login_check(row["id"], row["name"])  # begona qurilma — owner ruxsatisiz kirmaydi
        if problem:
            blocked.append(problem)
            return False
        session.clear()
        session.permanent = True
        session.update(role="user", uid=row["id"], sv=row["session_version"])
        classroom.touch_device(f"u{row['id']}", force=True)  # birinchi kirgan qurilma — asosiy
        return True

    # Tanlangan tugmani birinchi sinaymiz, lekin login/parol to'g'ri bo'lsa —
    # noto'g'ri tugma tanlangan bo'lsa ham kiritamiz.
    attempts = (as_owner, as_user) if role == "owner" else (as_user, as_owner)
    for attempt in attempts:
        if attempt():
            return jsonify(ok=True, role=session["role"], redirect=url_for("panel"))

    if blocked:
        return jsonify(error=blocked[0], blocked=True), 403
    if need_code:
        return jsonify(error="Kod noto'g'ri" if need_code[0] else "Authenticator ilovasidagi 6 xonali kodni yozing",
                       need_code=True), 401
    return jsonify(error="Login yoki parol noto'g'ri"), 401


@app.post("/api/logout")
def api_logout():
    session.clear()
    return jsonify(ok=True)


@app.get("/api/me")
def api_me():
    user = current_user()
    if not user:
        return jsonify(error="Avval tizimga kiring"), 401
    return jsonify(user=user)


# --------------------------------------------------------------------------- #
#  API: reyting (hamma kirganlar ko'radi)
# --------------------------------------------------------------------------- #
@app.get("/api/rating")
def rating():
    user = current_user()
    if not user:
        return jsonify(error="Avval tizimga kiring"), 401

    rows = get_db().execute(RATING_SQL).fetchall()
    is_owner = user["role"] == "owner"
    my_id = user.get("id")

    result = []
    for row in rows:
        item = {"id": row["id"], "name": row["name"], "avatar": avatar_url(row["avatar"]), "group_id": row["group_id"],
                "score": row["total"], "me": row["id"] == my_id}
        if is_owner:  # login faqat owner'ga ko'rinadi
            item["login"] = row["login"]
        result.append(item)
    return jsonify(users=result)


# --------------------------------------------------------------------------- #
#  API: odam qo'shish / o'chirish / ball berish (faqat owner)
# --------------------------------------------------------------------------- #
@app.post("/api/users")
@owner_required
def add_user():
    data = request.get_json(silent=True) or {}
    name = text_field(data, "name")
    # Login yoki parol bo'sh qolsa — ism ishlatiladi
    login = text_field(data, "login") or name
    password = text_field(data, "password") or name

    if not name:
        return jsonify(error="Ismni kiriting"), 400
    if max(len(name), len(login), len(password)) > MAX_LEN:
        return jsonify(error=f"Har bir maydon {MAX_LEN} belgidan oshmasin"), 400
    if login.lower() == config.OWNER_LOGIN.lower():
        return jsonify(error="Bu login band"), 409

    db = get_db()
    try:
        cur = db.execute(
            "INSERT INTO users (name, login, password_hash, created_at) VALUES (?, ?, ?, ?)",
            (name, login, generate_password_hash(password), now_iso()),
        )
        db.commit()
    except sqlite3.IntegrityError:
        return jsonify(error=f"«{login}» logini allaqachon band"), 409

    return jsonify(user={"id": cur.lastrowid, "name": name, "login": login, "score": 0}), 201


@app.post("/api/users/<int:user_id>/points")
@owner_required
def give_points(user_id: int):
    data = request.get_json(silent=True) or {}
    amount = data.get("amount")
    if isinstance(amount, bool) or not isinstance(amount, int) or amount == 0 or abs(amount) > 1000:
        return jsonify(error="Ball 1 dan 1000 gacha bo'lsin"), 400

    db = get_db()
    cur = db.execute("UPDATE users SET score = score + ? WHERE id = ?", (amount, user_id))
    db.commit()
    if cur.rowcount == 0:
        return jsonify(error="Foydalanuvchi topilmadi"), 404

    name = db.execute("SELECT name FROM users WHERE id = ?", (user_id,)).fetchone()["name"]
    return jsonify(user={"id": user_id, "name": name, "score": user_total(user_id)}, amount=amount)


@app.post("/api/users/<int:user_id>/points/reset")
@owner_required
def reset_points(user_id: int):
    """Hamma ballini ayirib tashlash: jami ball 0 bo'ladi.

    Uy vazifa natijalari (baholar) tarix sifatida saqlanib qoladi —
    owner bergan ball ularni teng qilib "yopadi", shuning uchun jami 0 chiqadi.
    """
    db = get_db()
    row = db.execute("SELECT name FROM users WHERE id = ?", (user_id,)).fetchone()
    if row is None:
        return jsonify(error="Foydalanuvchi topilmadi"), 404
    removed = user_total(user_id)
    db.execute(
        "UPDATE users SET score = -COALESCE((SELECT SUM(s.score) FROM submissions s WHERE s.user_id = ?), 0) "
        "- COALESCE((SELECT SUM(a.points) FROM attendance a WHERE a.user_id = ?), 0) "
        "WHERE id = ?", (user_id, user_id, user_id),
    )
    db.commit()
    return jsonify(user={"id": user_id, "name": row["name"], "score": user_total(user_id)}, removed=removed)


@app.delete("/api/users/<int:user_id>")
@owner_required
def delete_user(user_id: int):
    db = get_db()
    row = db.execute("SELECT avatar FROM users WHERE id = ?", (user_id,)).fetchone()
    if row is None:
        return jsonify(error="Foydalanuvchi topilmadi"), 404
    sub_ids = [r["id"] for r in db.execute("SELECT id FROM submissions WHERE user_id = ?", (user_id,))]
    db.execute("DELETE FROM users WHERE id = ?", (user_id,))
    db.commit()
    homework.remove_files(sub_ids)
    accounts.remove_avatar_file(row["avatar"])
    game.forget_player(f"u{user_id}")
    return jsonify(ok=True)



def load_custom_cars() -> None:
    """Ovoz bilan qo'shilgan mashinalarni Avtosalonga yuklash."""
    import core
    db = sqlite3.connect(core.DB_PATH)
    db.row_factory = sqlite3.Row
    try:
        poll.load_custom_cars(db)
    finally:
        db.close()


init_db()
load_custom_cars()

if __name__ == "__main__":
    build_css()
    url = f"http://{config.HOST}:{config.PORT}"
    print(f"\n  O'yin ishga tushdi:  {url}")
    print(f"  AI tekshiruv: {'yoqilgan' if ai_check.ai_enabled() else 'kalit qo`yilmagan (.env fayli)'}")
    if not (config.OWNER_LOGIN and config.OWNER_PASSWORD):
        print("  [!] Owner sozlanmagan: .env fayliga OWNER_LOGIN va OWNER_PASSWORD yozing.")
    print()
    # ishga_tushirish.bat orqali ochilganda brauzerni o'zi ochadi (faqat bir marta)
    if os.environ.get("OYIN_OPEN_BROWSER") == "1" and os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        threading.Timer(1.5, webbrowser.open, [url]).start()
    # .env o'zgarsa ham server qayta ishga tushadi
    app.run(host=config.HOST, port=config.PORT, debug=True, extra_files=[str(config.ENV_FILE)])
