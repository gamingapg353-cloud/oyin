"""Ota-onaga Telegram hisobot, dars eslatmalari, ovozli izoh, profil bezagi va telefonga o'rnatish (PWA + push).

Doimiy ishlaydigan jarayon yo'q (bepul server), shuning uchun vaqtli ishlar — tick() — odamlar saytga
kirganda (har 10 soniyada ko'pi bilan bir marta) bajariladi.
"""
import base64
import hashlib
import hmac
import json
import re
import secrets
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from urllib.parse import urlparse

from flask import Blueprint, Response, jsonify, request, send_file

import classroom
import game
import game_fun as gf
import game_social as gs
import homework
import learn
from core import RATING_SQL, ROOT_DIR, UPLOAD_DIR, admin_ids, current_user, get_db, get_setting, login_required, owner_required, set_setting

bp = Blueprint("portal", __name__)


def _err(text: str, code: int = 400):
    return jsonify(error=text), code


def _json() -> dict:
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def now_tk() -> datetime:
    """Toshkent vaqti (bazadagi dars vaqtlari ham shu vaqtda, belgisiz)."""
    return datetime.now(gf.TASHKENT).replace(tzinfo=None)


# --------------------------------------------------------------------------- #
#  Vaqtli ishlar
# --------------------------------------------------------------------------- #
TICKS: list = []          # boshqa modullar qo'shadi: fn(db)
TICK_EVERY = 10
_tick_at = {"t": 0.0}


def tick(db) -> None:
    for fn in (_tick_lessons, _tick_streaks, _tick_weekly, *TICKS, _flush_push):
        try:
            fn(db)
        except Exception as err:  # vaqtli ish sahifani yiqitmasin
            db.rollback()
            print("[tick]", fn.__name__, type(err).__name__, err)


def after_request(response):
    if request.path.startswith("/api/") and time.time() - _tick_at["t"] > TICK_EVERY:
        _tick_at["t"] = time.time()
        tick(get_db())
    return response


# --------------------------------------------------------------------------- #
#  10. Dars jadvali: 10 daqiqa oldin eslatish, har hafta takrorlanadigan darslar
# --------------------------------------------------------------------------- #
REMIND_MIN = 10


def _tick_lessons(db) -> None:
    now = now_tk()
    soon = (now + timedelta(minutes=REMIND_MIN)).isoformat(timespec="minutes")
    cur = now.isoformat(timespec="minutes")
    for r in db.execute("SELECT * FROM lessons WHERE reminded = 0 AND starts_at > ? AND starts_at <= ?", (cur, soon)).fetchall():
        if not db.execute("UPDATE lessons SET reminded = 1 WHERE id = ? AND reminded = 0", (r["id"],)).rowcount:
            continue
        db.commit()
        mins = max(1, round((datetime.fromisoformat(r["starts_at"]) - now).total_seconds() / 60))
        text = f"⏰ {mins} daqiqadan keyin dars: {r['topic']} ({r['starts_at'][11:16]})"
        for u in db.execute("SELECT id FROM users WHERE ? IS NULL OR group_id = ?", (r["group_id"], r["group_id"])).fetchall():
            classroom.notify(f"u{u['id']}", text, "/panel#games")
            gs._notify(f"u{u['id']}", text)
        classroom.notify("owner", text, "/panel#games")
    # har hafta takrorlanadigan dars o'tib ketgan bo'lsa — keyingi haftaga suriladi
    ended = (now - timedelta(hours=2)).isoformat(timespec="minutes")
    for r in db.execute("SELECT * FROM lessons WHERE weekly = 1 AND starts_at < ?", (ended,)).fetchall():
        at = datetime.fromisoformat(r["starts_at"])
        while at <= now:
            at += timedelta(days=7)
        db.execute("UPDATE lessons SET starts_at = ?, reminded = 0 WHERE id = ? AND starts_at = ?", (at.isoformat(timespec="minutes"), r["id"], r["starts_at"]))
        db.commit()


def _tick_streaks(db) -> None:
    """Kechqurun: 🔥 uzilib qolmasin."""
    if now_tk().hour < 18:
        return
    today = learn._today()
    rows = db.execute("SELECT * FROM streaks WHERE last_day = ? AND cur >= 2 AND COALESCE(reminded, '') != ? LIMIT 20", (learn._yesterday(), today)).fetchall()
    for r in rows:
        if db.execute("UPDATE streaks SET reminded = ? WHERE user_key = ? AND COALESCE(reminded, '') != ?", (today, r["user_key"], today)).rowcount:
            db.commit()
            classroom.notify(r["user_key"], f"🔥 {r['cur']} kunlik olovingiz o'chib qoladi! Bugungi savolga javob bering", "/panel#learn/daily")


# --------------------------------------------------------------------------- #
#  9. Ota-onaga Telegram
# --------------------------------------------------------------------------- #
TG_WEEK_HOUR = 18        # yakshanba, Toshkent vaqti
TG_PER_TICK = 3
TG_MAX_PARENTS = 5


def _tg_call(token: str, method: str, data: dict, timeout: float = 8) -> dict:
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/{method}", data=json.dumps(data).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.load(res)
    except urllib.error.HTTPError as err:
        try:
            return json.load(err)
        except ValueError:
            return {"ok": False, "error_code": err.code}
    except (OSError, ValueError):
        return {"ok": False, "error_code": 0}   # xatoda token chiqmasin


def _tg_send(chat_id: int, text: str) -> dict:
    token = get_setting("tg_token")
    if not token:
        return {"ok": False}
    return _tg_call(token, "sendMessage", {"chat_id": chat_id, "text": text, "disable_web_page_preview": True})


def report_text(db, user_id: int) -> str | None:
    u = db.execute("SELECT id, name FROM users WHERE id = ?", (user_id,)).fetchone()
    if not u:
        return None
    now = now_tk()
    week = (now - timedelta(days=7)).strftime("%Y-%m-%d")
    rating = db.execute(RATING_SQL).fetchall()
    place = next((i + 1 for i, r in enumerate(rating) if r["id"] == user_id), "-")
    total = next((r["total"] for r in rating if r["id"] == user_id), 0)
    att = db.execute("SELECT status, points FROM attendance WHERE user_id = ? AND day >= ?", (user_id, week)).fetchall()
    n = lambda st: sum(1 for a in att if a["status"] == st)
    hw = db.execute("SELECT s.score, h.title FROM submissions s JOIN homeworks h ON h.id = s.homework_id WHERE s.user_id = ? AND s.status = 'checked' AND s.created_at >= ? ORDER BY s.id",
                    (user_id, week)).fetchall()
    missing = db.execute("SELECT COUNT(*) FROM homeworks h WHERE h.created_at >= ? AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.homework_id = h.id AND s.user_id = ?)",
                         (week, user_id)).fetchone()[0]
    tests = db.execute("SELECT a.score, e.title FROM exam_attempts a JOIN exams e ON e.id = a.exam_id WHERE a.user_id = ? AND a.finished_at >= ?",
                       (user_id, time.time() - 7 * 86400)).fetchall()
    lines = [f"👨‍🎓 {u['name']} — haftalik hisobot", f"📅 {week[8:]}.{week[5:7]} — {now.strftime('%d.%m.%Y')}", "",
             f"⭐ Jami ball: {total} (reytingda {place}-o'rin)",
             f"✅ Keldi: {n('keldi')} · ⏰ Kechikdi: {n('kechikdi')} · ❌ Kelmadi: {n('kelmadi')}",
             f"📝 Dars ballari: {sum(a['points'] for a in att)}", ""]
    if hw:
        lines.append("📚 Uy vazifalar:")
        lines += [f"  • {h['title']} — {h['score']} ball" for h in hw[:8]]
    lines.append(f"⚠️ Topshirilmagan vazifa: {missing} ta" if missing else "👍 Hamma vazifalar topshirilgan" if hw else "📚 Bu hafta uy vazifa topshirilmadi")
    if tests:
        lines.append("🎯 Testlar:")
        lines += [f"  • {t['title']} — {t['score']}/5" for t in tests[:5]]
    st = learn.streak_of(db, f"u{user_id}")
    if st["cur"]:
        lines.append(f"🔥 Kunlik savol: {st['cur']} kun ketma-ket")
    return "\n".join(lines)


def _week_key() -> str:
    """Oxirgi o'tgan yakshanba 18:00 ga tegishli hafta."""
    now = now_tk()
    sunday = now - timedelta(days=(now.weekday() + 1) % 7)
    sunday = sunday.replace(hour=TG_WEEK_HOUR, minute=0, second=0, microsecond=0)
    if sunday > now:
        sunday -= timedelta(days=7)
    return sunday.strftime("%Y-%m-%d")


def _send_reports(db, limit: int, week: str) -> int:
    rows = db.execute("SELECT * FROM tg_parents WHERE COALESCE(week, '') != ? ORDER BY id LIMIT ?", (week, limit)).fetchall()
    sent = 0
    for r in rows:
        if not db.execute("UPDATE tg_parents SET week = ? WHERE id = ? AND COALESCE(week, '') != ?", (week, r["id"], week)).rowcount:
            continue
        db.commit()
        text = report_text(db, r["user_id"])
        if text is None:
            db.execute("DELETE FROM tg_parents WHERE id = ?", (r["id"],))
            db.commit()
            continue
        res = _tg_send(r["chat_id"], text)
        if res.get("ok"):
            sent += 1
        elif res.get("error_code") == 403:   # ota-ona botni bloklagan
            db.execute("DELETE FROM tg_parents WHERE id = ?", (r["id"],))
            db.commit()
    return sent


def _tick_weekly(db) -> None:
    if not get_setting("tg_token") or get_setting("tg_on") != "1":
        return
    week = _week_key()
    if (get_setting("tg_since") or "") >= week:   # ulangan haftaning o'zida yubormaymiz
        return
    _send_reports(db, TG_PER_TICK, week)


def _tg_state(db) -> dict:
    rows = db.execute("SELECT p.*, u.name AS student FROM tg_parents p JOIN users u ON u.id = p.user_id ORDER BY u.name, p.id").fetchall()
    return {"connected": bool(get_setting("tg_token")), "username": get_setting("tg_username"), "on": get_setting("tg_on") == "1",
            "parents": [{"id": r["id"], "student": r["student"], "name": r["name"]} for r in rows],
            "students": [{"id": r["id"], "name": r["name"]} for r in db.execute("SELECT id, name FROM users ORDER BY name COLLATE NOCASE")]}


@bp.get("/api/telegram")
@owner_required
def api_tg():
    return jsonify(_tg_state(get_db()))


@bp.post("/api/telegram")
@owner_required
def api_tg_connect():
    """Owner BotFather'dan olgan tokenni qo'yadi. Token hech qachon qaytarib ko'rsatilmaydi."""
    token = str(_json().get("token") or "").strip()
    if not re.fullmatch(r"\d{5,15}:[\w-]{30,60}", token):
        return _err("Token noto'g'ri. @BotFather bergan tokenni to'liq qo'ying")
    me = _tg_call(token, "getMe", {})
    if not me.get("ok"):
        return _err("Telegram bu tokenni qabul qilmadi" if me.get("error_code") else "Telegram bilan aloqa yo'q — keyinroq urinib ko'ring")
    secret = secrets.token_urlsafe(24)
    hook = _tg_call(token, "setWebhook", {"url": f"https://{request.host}/tg/hook", "secret_token": secret, "allowed_updates": ["message"]})
    if not hook.get("ok"):
        return _err(f"Bot ulanmadi: {str(hook.get('description') or 'sayt internetda (https) bo‘lishi kerak')[:120]}")
    set_setting("tg_token", token)
    set_setting("tg_secret", secret)
    set_setting("tg_username", me["result"].get("username"))
    set_setting("tg_on", "1")
    set_setting("tg_since", _week_key())
    return jsonify(_tg_state(get_db()))


@bp.delete("/api/telegram")
@owner_required
def api_tg_remove():
    token = get_setting("tg_token")
    if token:
        _tg_call(token, "deleteWebhook", {})
    for k in ("tg_token", "tg_secret", "tg_username", "tg_on", "tg_since"):
        set_setting(k, None)
    return jsonify(_tg_state(get_db()))


@bp.post("/api/telegram/toggle")
@owner_required
def api_tg_toggle():
    set_setting("tg_on", "1" if _json().get("on") else "0")
    return jsonify(_tg_state(get_db()))


@bp.post("/api/telegram/send")
@owner_required
def api_tg_send_now():
    db = get_db()
    if not get_setting("tg_token"):
        return _err("Avval botni ulang")
    n = _send_reports(db, 25, f"now-{int(time.time())}")
    db.execute("UPDATE tg_parents SET week = ?", (_week_key(),))  # shu haftalikni yana yubormaslik uchun
    db.commit()
    return jsonify(sent=n)


@bp.delete("/api/telegram/parents/<int:pid>")
@owner_required
def api_tg_parent_delete(pid: int):
    db = get_db()
    db.execute("DELETE FROM tg_parents WHERE id = ?", (pid,))
    db.commit()
    return jsonify(_tg_state(db))


@bp.get("/api/users/<int:user_id>/tg-link")
@owner_required
def api_tg_link(user_id: int):
    """Ota-onaga beriladigan havola: botni ochib «Start» bossa — shu o'quvchiga ulanadi."""
    db = get_db()
    name = get_setting("tg_username")
    if not name:
        return _err("Avval Telegram botni ulang (Sozlamalar)")
    row = db.execute("SELECT tg_code FROM users WHERE id = ?", (user_id,)).fetchone()
    if row is None:
        return _err("Topilmadi", 404)
    code = row["tg_code"]
    if not code:
        code = secrets.token_urlsafe(12)
        db.execute("UPDATE users SET tg_code = ? WHERE id = ?", (code, user_id))
        db.commit()
    return jsonify(url=f"https://t.me/{name}?start={code}")


@bp.post("/tg/hook")
def tg_hook():
    secret = get_setting("tg_secret") or ""
    given = request.headers.get("X-Telegram-Bot-Api-Secret-Token", "")
    if not secret or not hmac.compare_digest(secret.encode(), given.encode()):
        return _err("?", 403)
    msg = _json().get("message")
    msg = msg if isinstance(msg, dict) else {}
    chat = msg.get("chat") if isinstance(msg.get("chat"), dict) else {}
    chat_id, text = chat.get("id"), str(msg.get("text") or "").strip()
    if chat.get("type") != "private" or not isinstance(chat_id, int):
        return jsonify(ok=True)
    db = get_db()
    reply = "Buyruqlar:\n/hisobot — haftalik hisobot\n/stop — hisobotni to'xtatish"
    if text.startswith("/start "):
        code = text.split(None, 1)[1].strip()
        u = db.execute("SELECT id, name FROM users WHERE tg_code = ?", (code,)).fetchone() if len(code) >= 8 else None
        if not u:
            reply = "Havola eskirgan. Ustozdan yangi havola so'rang."
        elif db.execute("SELECT COUNT(*) FROM tg_parents WHERE user_id = ? AND chat_id != ?", (u["id"], chat_id)).fetchone()[0] >= TG_MAX_PARENTS:
            reply = "Bu o'quvchiga ulangan odamlar soni ko'p. Ustozga murojaat qiling."
        else:
            first = " ".join(str((msg.get("from") or {}).get("first_name") or "Ota-ona").split())[:40]
            db.execute("INSERT OR IGNORE INTO tg_parents (chat_id, user_id, name, at, week) VALUES (?, ?, ?, ?, ?)", (chat_id, u["id"], first, time.time(), _week_key()))
            db.commit()
            classroom.notify("owner", f"👨‍👩‍👧 {u['name']}ning ota-onasi ({first}) Telegram hisobotga ulandi", "/panel#settings")
            reply = f"Assalomu alaykum! {u['name']} bo'yicha haftalik hisobot har yakshanba shu yerga keladi.\n\n/hisobot — hozirgi hisobot\n/stop — to'xtatish"
    elif text.startswith("/hisobot"):
        rows = db.execute("SELECT user_id FROM tg_parents WHERE chat_id = ?", (chat_id,)).fetchall()
        reply = "\n\n———\n\n".join(filter(None, (report_text(db, r["user_id"]) for r in rows))) or "Siz hali o'quvchiga ulanmagansiz. Ustoz bergan havolani oching."
    elif text.startswith("/stop"):
        db.execute("DELETE FROM tg_parents WHERE chat_id = ?", (chat_id,))
        db.commit()
        reply = "Hisobot to'xtatildi. Qayta ulash uchun ustoz bergan havolani oching."
    _tg_send(chat_id, reply)
    return jsonify(ok=True)


# --------------------------------------------------------------------------- #
#  13. Uy vazifaga ovozli izoh
# --------------------------------------------------------------------------- #
VOICE_MAX = 3 * 1024 * 1024
VOICE_TYPES = {"audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/aac"}


def _voice_path(sub_id: int):
    return UPLOAD_DIR / "voice" / f"{sub_id}.bin"


def drop_voice(sub_ids) -> None:
    for i in sub_ids:
        try:
            _voice_path(i).unlink(missing_ok=True)
        except OSError:   # fayl hozir eshitilyapti — keyin o'chadi
            pass


@bp.post("/api/submissions/<int:sub_id>/voice")
@owner_required
def api_voice_save(sub_id: int):
    sub = homework.load_submission(sub_id)
    if sub is None:
        return _err("Topilmadi", 404)
    file = request.files.get("audio")
    data = file.read(VOICE_MAX + 1) if file else b""
    mime = (file.mimetype or "").split(";")[0].replace("video/webm", "audio/webm") if file else ""
    if not data or mime not in VOICE_TYPES:
        return _err("Ovoz yozilmadi")
    if len(data) > VOICE_MAX:
        return _err("Ovozli izoh juda uzun (2 daqiqagacha)")
    path = _voice_path(sub_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    db = get_db()
    db.execute("UPDATE submissions SET voice = ? WHERE id = ?", (mime, sub_id))
    db.commit()
    classroom.notify(f"u{sub['user_id']}", "🎤 Ustoz uy ishingizga ovozli izoh qoldirdi — tinglang", "/panel#homework")
    return jsonify(ok=True)


@bp.get("/api/submissions/<int:sub_id>/voice")
@login_required
def api_voice_get(sub_id: int):
    user = current_user()
    sub = homework.load_submission(sub_id)
    if sub is None or not sub["voice"] or (user["role"] != "owner" and sub["user_id"] != user.get("id")):
        return _err("Topilmadi", 404)
    path = _voice_path(sub_id)
    if not path.is_file() or sub["voice"] not in VOICE_TYPES:
        return _err("Topilmadi", 404)
    res = send_file(path, mimetype=sub["voice"], conditional=True, max_age=0)
    res.headers["Cache-Control"] = "private, no-store"
    return res


@bp.delete("/api/submissions/<int:sub_id>/voice")
@owner_required
def api_voice_delete(sub_id: int):
    db = get_db()
    db.execute("UPDATE submissions SET voice = NULL WHERE id = ?", (sub_id,))
    db.commit()
    drop_voice([sub_id])
    return jsonify(ok=True)


# --------------------------------------------------------------------------- #
#  28. Profil bezagi: ramka, ism rangi, unvon
# --------------------------------------------------------------------------- #
FRAMES = {"": ("Ramkasiz", 0), "oddiy": ("Ko'k halqa", 20000), "yashil": ("Yashil halqa", 20000), "oltin": ("Oltin", 100000), "olov": ("Olov", 150000),
          "muz": ("Muz", 150000), "kamalak": ("Kamalak", 300000), "neon": ("Neon", 300000), "toj": ("Qirollik", 1000000)}
OWNER_FRAMES = {"toj"}      # faqat owner
COLORS = {"": ("Oddiy", 0, ""), "kok": ("Ko'k", 15000, "#3b82f6"), "yashil": ("Yashil", 15000, "#16a34a"), "pushti": ("Pushti", 25000, "#ec4899"),
          "siyoh": ("Binafsha", 25000, "#8b5cf6"), "toq": ("To'q sariq", 40000, "#ea580c"), "qizil": ("Qizil", 40000, "#ef4444"),
          "feruza": ("Feruza", 60000, "#0d9488"), "oltin": ("Oltin", 200000, "#ca8a04")}


def _stats(db, key: str) -> dict:
    one = lambda sql, *a: db.execute(sql, a).fetchone()[0] or 0
    done = {r["kind"]: r["n"] for r in db.execute("SELECT kind, COUNT(*) AS n FROM learn_done WHERE user_key = ? GROUP BY kind", (key,))}
    rating = db.execute(RATING_SQL).fetchall()
    return {"streak": one("SELECT MAX(best) FROM streaks WHERE user_key = ?", key), "wins": one("SELECT COUNT(*) FROM duels WHERE winner = ?", key),
            "bug": done.get("bug", 0), "maket": done.get("maket", 0), "site": done.get("site", 0), "peer": one("SELECT COUNT(*) FROM peer_reviews WHERE reviewer = ?", key),
            "learned": one("SELECT SUM(n) FROM learn_daily WHERE user_key = ? AND kind = 'learned'", key),
            "project": one("SELECT COUNT(*) FROM project_members m JOIN projects p ON p.id = m.project_id WHERE m.user_key = ? AND p.points IS NOT NULL", key),
            "first": int(bool(rating) and key == f"u{rating[0]['id']}" and rating[0]["total"] > 0), "owner": int(key == "owner"),
            "admin": int(key.startswith("u") and key[1:].isdigit() and int(key[1:]) in admin_ids())}


TITLES = {  # id: (unvon, shart matni, kalit, kerak)
    "yangi": ("Yangi dasturchi", "Hammaga ochiq", None, 0), "olov7": ("🔥 Olovli", "7 kun ketma-ket kunlik savol", "streak", 7),
    "olov30": ("🔥 Yengilmas", "30 kun ketma-ket kunlik savol", "streak", 30), "duel5": ("⚔️ Duelchi", "5 ta duelda g'alaba", "wins", 5),
    "duel20": ("⚔️ Duel ustasi", "20 ta duelda g'alaba", "wins", 20), "bug10": ("🐞 Xato ovchisi", "10 ta xato topish", "bug", 10),
    "bug30": ("🐞 Xatolar qiroli", "30 ta xato topish", "bug", 30), "maket4": ("🎨 Dizayner", "4 ta maketni takrorlash", "maket", 4),
    "maket12": ("🎨 Rassom", "12 ta maketni takrorlash", "maket", 12), "site": ("🏪 Sayt egasi", "Saytini ko'chaga chiqarish", "site", 1),
    "peer10": ("⭐ Hakam", "10 ta ishga baho berish", "peer", 10), "learn20": ("📒 Tirishqoq", "20 ta xatosini to'g'rilash", "learned", 20),
    "admin": ("🛡️ Admin", "Ustoz admin qilgan", "admin", 1),
    "team": ("👥 Jamoadosh", "Guruh loyihasini topshirish", "project", 1), "first": ("👑 Birinchi", "Reytingda 1-o'rin", "first", 1), "owner": ("👑 Owner", "Faqat owner", "owner", 1),
}


def deco_public(row, db=None) -> dict | None:
    if row is None:
        return None
    out = {"frame": row["frame"] if row["frame"] in FRAMES else "", "color": COLORS.get(row["color"], ("", 0, ""))[2],
           "title": TITLES[row["title"]][0] if row["title"] in TITLES else ""}
    return out if any(out.values()) else None


_deco_cache: dict = {"t": 0.0, "map": {}}


def deco_map(db, fresh: bool = False) -> dict:
    """player_key -> bezak (15 soniya xotirada — har sinxronda baza o'qilmasin)."""
    if fresh or time.time() - _deco_cache["t"] > 15:
        _deco_cache["map"] = {r["user_key"]: d for r in db.execute("SELECT * FROM deco") if (d := deco_public(r))}
        _deco_cache["t"] = time.time()
    return _deco_cache["map"]


def _deco_row(db, key: str):
    row = db.execute("SELECT * FROM deco WHERE user_key = ?", (key,)).fetchone()
    if row is None:
        db.execute("INSERT OR IGNORE INTO deco (user_key) VALUES (?)", (key,))
        db.commit()
        row = db.execute("SELECT * FROM deco WHERE user_key = ?", (key,)).fetchone()
    return row


def _deco_json(db, key: str) -> dict:
    row = _deco_row(db, key)
    owned = set(json.loads(row["owned"]))
    st = _stats(db, key)
    econ = game.economy_json(db, game.ensure_player(db, key))
    return {"frame": row["frame"], "color": row["color"], "title": row["title"], "money": econ["money"],
            "frames": [{"id": k, "name": n, "price": p, "own": p == 0 or f"f:{k}" in owned} for k, (n, p) in FRAMES.items()
                       if k not in OWNER_FRAMES or key == "owner"],
            "colors": [{"id": k, "name": n, "price": p, "hex": h, "own": p == 0 or f"c:{k}" in owned} for k, (n, p, h) in COLORS.items()],
            "titles": [{"id": k, "name": n, "about": a, "own": kind is None or st[kind] >= need, "have": min(st[kind], need) if kind else 0, "need": need}
                       for k, (n, a, kind, need) in TITLES.items() if (k != "owner" or key == "owner") and (k != "admin" or st["admin"])]}


@bp.get("/api/deco")
@login_required
def api_deco():
    return jsonify(_deco_json(get_db(), current_user()["key"]))


@bp.get("/api/deco/map")
@login_required
def api_deco_map():
    return jsonify(map=deco_map(get_db(), True))


@bp.post("/api/deco")
@login_required
def api_deco_set():
    """Kiyish; sotib olinmagan bo'lsa — o'yin pulidan sotib olinadi."""
    key = current_user()["key"]
    data = _json()
    kind, item = data.get("kind"), data.get("id")
    db = get_db()
    row = _deco_row(db, key)
    owned = set(json.loads(row["owned"]))
    if kind == "title":
        if item and (item not in TITLES or not next((t["own"] for t in _deco_json(db, key)["titles"] if t["id"] == item), False)):
            return _err("Bu unvon hali ochilmagan")
        db.execute("UPDATE deco SET title = ? WHERE user_key = ?", (item or "", key))
        db.commit()
    elif kind in ("frame", "color"):
        cat = FRAMES if kind == "frame" else COLORS
        if item not in cat or (kind == "frame" and item in OWNER_FRAMES and key != "owner"):
            return _err("Bunday bezak yo'q")
        tag, price = f"{kind[0]}:{item}", cat[item][1]
        if price and tag not in owned:
            def change(_row, money):
                if money < price:
                    raise game.GameError(f"Pul yetarli emas: {price:,} so'm kerak".replace(",", " "))
                fresh = set(json.loads(db.execute("SELECT owned FROM deco WHERE user_key = ?", (key,)).fetchone()["owned"]))
                if tag in fresh:
                    raise game.GameError("Allaqachon olingan")
                return -price, lambda: db.execute("UPDATE deco SET owned = ? WHERE user_key = ?", (json.dumps(sorted(fresh | {tag})), key))
            game.ensure_player(db, key)
            _, err = gs._change(db, key, change)
            if err:
                return err
        db.execute(f"UPDATE deco SET {kind} = ? WHERE user_key = ?", (item, key))
        db.commit()
    else:
        return _err("?")
    deco_map(db, True)
    return jsonify(_deco_json(db, key))


def _deco_hook(db, key: str, row, now: float, response: dict) -> None:
    m = deco_map(db)
    response["deco_me"] = m.get(key)
    for p in response.get("players", []):
        d = m.get(p["key"])
        if d:
            p["deco"] = d


game.SYNC_HOOKS.append(_deco_hook)


@bp.get("/api/users/<int:user_id>/admin")
@owner_required
def api_user_admin(user_id: int):
    return jsonify(admin=user_id in admin_ids())


@bp.post("/api/users/<int:user_id>/admin")
@owner_required
def api_user_admin_set(user_id: int):
    """O'quvchini admin qilish: «Ball berish» bo'limi ochiladi, unvoni — «🛡️ Admin»."""
    on = bool(_json().get("on"))
    db = get_db()
    if not db.execute("SELECT 1 FROM users WHERE id = ?", (user_id,)).fetchone():
        return _err("Bunday o'quvchi yo'q")
    ids = admin_ids()
    ids = ids | {user_id} if on else ids - {user_id}
    set_setting("admins", json.dumps(sorted(ids)))
    key = f"u{user_id}"
    _deco_row(db, key)
    if on:
        db.execute("UPDATE deco SET title = 'admin' WHERE user_key = ?", (key,))
    else:
        db.execute("UPDATE deco SET title = '' WHERE user_key = ? AND title = 'admin'", (key,))
    db.commit()
    deco_map(db, True)
    import classroom
    classroom.notify(key, "🛡️ Ustoz sizni admin qildi — «Ball berish» bo'limi ochildi" if on else "Adminlik olib tashlandi", "/panel")
    return jsonify(admin=on)


def _forget(db, key: str) -> None:
    db.execute("DELETE FROM deco WHERE user_key = ?", (key,))
    db.execute("DELETE FROM push_subs WHERE user_key = ?", (key,))
    db.execute("DELETE FROM push_queue WHERE user_key = ?", (key,))
    if key.startswith("u"):
        db.execute("DELETE FROM tg_parents WHERE user_id = ?", (int(key[1:]),))


game.FORGET_HOOKS.append(_forget)

# --------------------------------------------------------------------------- #
#  30. Telefonga o'rnatish (PWA) va bildirishnoma (web push, mazmunsiz — matnni qurilma o'zi oladi)
# --------------------------------------------------------------------------- #
_P = 2 ** 256 - 2 ** 224 + 2 ** 192 + 2 ** 96 - 1
_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
_G = (0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296, 0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5)


def _ec_add(a, b):
    if a is None:
        return b
    if b is None:
        return a
    if a[0] == b[0]:
        if (a[1] + b[1]) % _P == 0:
            return None
        m = (3 * a[0] * a[0] - 3) * pow(2 * a[1], -1, _P) % _P
    else:
        m = (b[1] - a[1]) * pow(b[0] - a[0], -1, _P) % _P
    x = (m * m - a[0] - b[0]) % _P
    return x, (m * (a[0] - x) - a[1]) % _P


def _ec_mul(k: int, pt=_G):
    out = None
    while k:
        if k & 1:
            out = _ec_add(out, pt)
        pt = _ec_add(pt, pt)
        k >>= 1
    return out


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _vapid() -> tuple[int, str]:
    """Sayt kaliti (birinchi marta yaratiladi): (maxfiy son, ochiq kalit)."""
    raw = get_setting("vapid_key")
    if not raw:
        raw = f"{secrets.randbelow(_N - 1) + 1:064x}"
        set_setting("vapid_key", raw)
    d = int(raw, 16)
    x, y = _ec_mul(d)
    return d, _b64(b"\x04" + x.to_bytes(32, "big") + y.to_bytes(32, "big"))


def _es256(d: int, data: bytes) -> bytes:
    z = int.from_bytes(hashlib.sha256(data).digest(), "big")
    while True:
        k = secrets.randbelow(_N - 1) + 1
        r = _ec_mul(k)[0] % _N
        s = pow(k, -1, _N) * (z + r * d) % _N
        if r and s:
            return r.to_bytes(32, "big") + s.to_bytes(32, "big")


_jwt_cache: dict[str, tuple[float, str]] = {}


def _vapid_header(endpoint: str) -> str:
    u = urlparse(endpoint)
    aud = f"{u.scheme}://{u.netloc}"
    now = time.time()
    if aud not in _jwt_cache or now - _jwt_cache[aud][0] > 6 * 3600:
        d, pub = _vapid()
        claims = {"aud": aud, "exp": int(now + 12 * 3600), "sub": get_setting("push_sub") or "https://localhost"}
        body = _b64(json.dumps({"typ": "JWT", "alg": "ES256"}).encode()) + "." + _b64(json.dumps(claims).encode())
        _jwt_cache[aud] = (now, f"vapid t={body}.{_b64(_es256(d, body.encode()))}, k={pub}")
    return _jwt_cache[aud][1]


# Faqat brauzerlarning rasmiy push serverlariga so'rov yuboriladi
PUSH_HOSTS = re.compile(r"^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|([\w-]+\.)*push\.apple\.com|([\w-]+\.)*notify\.windows\.com)$")


def _endpoint_ok(url) -> bool:
    if not isinstance(url, str) or len(url) > 700:
        return False
    u = urlparse(url)
    return u.scheme == "https" and u.port in (None, 443) and not u.username and bool(PUSH_HOSTS.match(u.hostname or ""))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def _push_one(endpoint: str) -> int:
    req = urllib.request.Request(endpoint, data=b"", method="POST", headers={"TTL": "86400", "Authorization": _vapid_header(endpoint), "Content-Length": "0"})
    try:
        with urllib.request.build_opener(_NoRedirect).open(req, timeout=4) as res:
            return res.status
    except urllib.error.HTTPError as err:
        return err.code
    except (OSError, ValueError):
        return 0


def enqueue(db, keys) -> None:
    """classroom.notify chaqiradi (commit — o'sha yerda)."""
    db.executemany("INSERT OR IGNORE INTO push_queue (user_key, t) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM push_subs WHERE user_key = ?)",
                   [(k, time.time(), k) for k in keys])


def _flush_push(db) -> None:
    start = time.time()
    db.execute("DELETE FROM push_queue WHERE t < ?", (start - 3600,))
    for r in db.execute("SELECT user_key FROM push_queue ORDER BY t LIMIT 8").fetchall():
        if not db.execute("DELETE FROM push_queue WHERE user_key = ?", (r["user_key"],)).rowcount:
            continue
        db.commit()
        for s in db.execute("SELECT endpoint FROM push_subs WHERE user_key = ?", (r["user_key"],)).fetchall():
            code = _push_one(s["endpoint"])
            if code in (404, 410):
                db.execute("DELETE FROM push_subs WHERE endpoint = ?", (s["endpoint"],))
        db.commit()
        if time.time() - start > 3:
            break
    db.commit()


@bp.get("/api/push")
@login_required
def api_push():
    key = current_user()["key"]
    n = get_db().execute("SELECT COUNT(*) FROM push_subs WHERE user_key = ?", (key,)).fetchone()[0]
    return jsonify(key=_vapid()[1], devices=n)


@bp.post("/api/push")
@login_required
def api_push_sub():
    key = current_user()["key"]
    endpoint = _json().get("endpoint")
    if not _endpoint_ok(endpoint):
        return _err("Bu brauzer qo'llab-quvvatlanmaydi")
    if get_setting("push_sub") != f"https://{request.host}":
        set_setting("push_sub", f"https://{request.host}")
    db = get_db()
    db.execute("INSERT INTO push_subs (endpoint, user_key, at) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_key = excluded.user_key, at = excluded.at",
               (endpoint, key, time.time()))
    # bitta odamda ko'pi bilan 5 ta qurilma
    db.execute("DELETE FROM push_subs WHERE user_key = ? AND endpoint NOT IN (SELECT endpoint FROM push_subs WHERE user_key = ? ORDER BY at DESC LIMIT 5)", (key, key))
    db.commit()
    return jsonify(ok=True)


@bp.post("/api/push/off")
@login_required
def api_push_off():
    db = get_db()
    db.execute("DELETE FROM push_subs WHERE endpoint = ? AND user_key = ?", (str(_json().get("endpoint") or ""), current_user()["key"]))
    db.commit()
    return jsonify(ok=True)


@bp.post("/api/push/test")
@login_required
def api_push_test():
    key = current_user()["key"]
    classroom.notify(key, "🔔 Bildirishnoma ishlayapti!", "/panel")
    return jsonify(ok=True)


@bp.get("/api/notifications/last")
@login_required
def api_notifications_last():
    r = get_db().execute("SELECT id, text, link FROM notifications WHERE user_key = ? AND seen = 0 ORDER BY id DESC LIMIT 1", (current_user()["key"],)).fetchone()
    return jsonify(item={"id": r["id"], "text": r["text"], "link": r["link"]} if r else None)


@bp.get("/manifest.webmanifest")
def manifest():
    icons = [{"src": f"/static/icons/icon-{s}.png", "sizes": f"{s}x{s}", "type": "image/png", "purpose": "any"} for s in (192, 512)]
    icons.append({"src": "/static/icons/maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"})
    data = {"id": "/panel", "name": "O'yin — o'quv platformasi", "short_name": "O'yin", "start_url": "/panel", "scope": "/", "display": "standalone",
            "background_color": "#0a1020", "theme_color": "#0a1020", "lang": "uz", "icons": icons,
            "shortcuts": [{"name": "Mahalla 3D", "url": "/game"}, {"name": "Kunlik savol", "url": "/panel#learn/daily"}]}
    return Response(json.dumps(data, ensure_ascii=False), mimetype="application/manifest+json", headers={"Cache-Control": "no-cache"})


@bp.get("/sw.js")
def service_worker():
    return Response((ROOT_DIR / "static" / "js" / "sw.js").read_text(encoding="utf-8"), mimetype="text/javascript",
                    headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"})


def return_owner_frames(db) -> None:
    """Faqat owner uchun qolgan ramkalar: o'quvchilardan yechiladi, sotib olganga puli qaytadi (init_db chaqiradi)."""
    for key, frame, raw in db.execute("SELECT user_key, frame, owned FROM deco WHERE user_key != 'owner'").fetchall():
        owned = set(json.loads(raw))
        bad = {f"f:{f}" for f in OWNER_FRAMES} & owned
        if bad:
            db.execute("UPDATE game_players SET money = money + ? WHERE player_key = ?", (sum(FRAMES[b[2:]][1] for b in bad), key))
        if bad or frame in OWNER_FRAMES:
            db.execute("UPDATE deco SET owned = ?, frame = ? WHERE user_key = ?", (json.dumps(sorted(owned - bad)), "" if frame in OWNER_FRAMES else frame, key))


SCHEMA = """
CREATE TABLE IF NOT EXISTS tg_parents (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, name TEXT NOT NULL, at REAL NOT NULL, week TEXT, UNIQUE (chat_id, user_id)
);
CREATE TABLE IF NOT EXISTS deco (
    user_key TEXT PRIMARY KEY, frame TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', owned TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, user_key TEXT NOT NULL, at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS push_queue (user_key TEXT PRIMARY KEY, t REAL NOT NULL);
"""
