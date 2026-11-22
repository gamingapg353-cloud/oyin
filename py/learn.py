"""Mashqlar: kunlik 1 savol (🔥), xatolar daftari, kod dueli, xatoni top, maketni takrorla,
guruh loyihasi, saytlar ko'chasi va o'quvchilarning bir-biriga bahosi.
"""
import difflib
import hashlib
import json
import random
import re
import time
from datetime import datetime, timedelta

from flask import Blueprint, jsonify, request

import classroom
import codecheck
import game
import game_fun as gf
import game_social as gs
import game_town  # noqa: F401  (WORLD_DATA["town"])
import homework
import quiz
from core import avatar_url, current_user, get_db, get_setting, login_required, owner_required, set_setting

bp = Blueprint("learn", __name__)
CODE_MAX = 20000


def _today() -> str:
    return datetime.now(gf.TASHKENT).strftime("%Y-%m-%d")


def _yesterday() -> str:
    return (datetime.now(gf.TASHKENT) - timedelta(days=1)).strftime("%Y-%m-%d")


def _key() -> str:
    return current_user()["key"]


def _err(text: str, code: int = 400):
    return jsonify(error=text), code


def _clean(value, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def _json() -> dict:
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def _code(value, limit: int = CODE_MAX) -> str:
    return value[:limit] if isinstance(value, str) else ""


def _int(value):
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def pay(db, key: str, amount: int) -> None:
    game.ensure_player(db, key)
    gs.add_money(db, key, amount)


def _people(db) -> dict:
    return gs._people(db)


def _count_today(db, key: str, kind: str) -> int:
    row = db.execute("SELECT n FROM learn_daily WHERE user_key = ? AND kind = ? AND day = ?", (key, kind, _today())).fetchone()
    return row["n"] if row else 0


def _bump_today(db, key: str, kind: str) -> None:
    db.execute("INSERT INTO learn_daily (user_key, kind, day, n) VALUES (?, ?, ?, 1) "
               "ON CONFLICT(user_key, kind, day) DO UPDATE SET n = n + 1", (key, kind, _today()))


# --------------------------------------------------------------------------- #
#  5. Xatolar daftari
# --------------------------------------------------------------------------- #
LEARN_NEED = 2          # shuncha marta to'g'ri javob berilsa — daftardan o'chadi
LEARN_PAY = 500


def _qkey(text: str) -> str:
    return hashlib.sha1(" ".join(text.split()).encode()).hexdigest()[:16]


def note(db, user_key: str, q: dict, ok: bool) -> None:
    """Testlardagi javob: xato bo'lsa savol daftarga yoziladi (commit — chaqiruvchida)."""
    if not user_key.startswith("u") or ok:
        return
    data = {k: q.get(k) for k in ("topic", "question", "options", "correct", "explain")}
    db.execute("INSERT INTO mistakes (user_key, qkey, data, wrong, good, t) VALUES (?, ?, ?, 1, 0, ?) "
               "ON CONFLICT(user_key, qkey) DO UPDATE SET wrong = wrong + 1, good = 0, t = excluded.t",
               (user_key, _qkey(str(q.get("question"))), json.dumps(data, ensure_ascii=False), time.time()))


def _backfill(db, user: dict) -> None:
    """Bir marta: ilgari yechilgan testlardagi xatolar ham daftarga tushadi."""
    key = user["key"]
    if db.execute("SELECT 1 FROM learn_daily WHERE user_key = ? AND kind = 'backfill'", (key,)).fetchone():
        return
    rows = [(r["questions"], r["answers"]) for r in db.execute(
        "SELECT e.questions, a.answers FROM exam_attempts a JOIN exams e ON e.id = a.exam_id WHERE a.user_id = ? AND a.finished_at IS NOT NULL", (user["id"],))]
    rows += [(r["questions"], r["answers"]) for r in db.execute("SELECT questions, answers FROM lesson_quiz WHERE user_id = ?", (user["id"],))]
    for qs, ans in rows:
        try:
            qs, ans = json.loads(qs), json.loads(ans or "[]")
        except ValueError:
            continue
        for q, a in zip(qs, ans):
            if a is not None and a != q.get("correct"):
                note(db, key, q, False)
    db.execute("INSERT INTO learn_daily (user_key, kind, day, n) VALUES (?, 'backfill', ?, 1)", (key, _today()))
    db.commit()


@bp.get("/api/mistakes")
@login_required
def api_mistakes():
    user = current_user()
    db = get_db()
    if user["role"] == "user":
        _backfill(db, user)
    rows = db.execute("SELECT * FROM mistakes WHERE user_key = ? ORDER BY wrong DESC, t DESC LIMIT 100", (user["key"],)).fetchall()
    items = []
    for r in rows:
        q = json.loads(r["data"])
        items.append({"id": r["qkey"], "topic": q["topic"], "question": q["question"], "wrong": r["wrong"], "good": r["good"], "need": LEARN_NEED})
    learned = db.execute("SELECT COALESCE(SUM(n), 0) FROM learn_daily WHERE user_key = ? AND kind = 'learned'", (user["key"],)).fetchone()[0]
    return jsonify(items=items, learned=learned)


@bp.get("/api/mistakes/<qid>")
@login_required
def api_mistake_question(qid: str):
    row = get_db().execute("SELECT data FROM mistakes WHERE user_key = ? AND qkey = ?", (_key(), qid)).fetchone()
    if not row:
        return _err("Savol topilmadi", 404)
    q = json.loads(row["data"])
    order = list(range(len(q["options"])))
    random.shuffle(order)
    return jsonify(id=qid, topic=q["topic"], question=q["question"], options=[q["options"][i] for i in order])


@bp.post("/api/mistakes/<qid>")
@login_required
def api_mistake_answer(qid: str):
    key = _key()
    db = get_db()
    row = db.execute("SELECT * FROM mistakes WHERE user_key = ? AND qkey = ?", (key, qid)).fetchone()
    if not row:
        return _err("Savol topilmadi", 404)
    q = json.loads(row["data"])
    right = q["options"][q["correct"]]
    ok = _json().get("answer") == right
    done = False
    if ok:
        good = row["good"] + 1
        done = good >= LEARN_NEED
        if done:
            cur = db.execute("DELETE FROM mistakes WHERE user_key = ? AND qkey = ? AND good = ?", (key, qid, row["good"]))
            done = bool(cur.rowcount)
            if done:
                _bump_today(db, key, "learned")
        else:
            db.execute("UPDATE mistakes SET good = ? WHERE user_key = ? AND qkey = ?", (good, key, qid))
    else:
        db.execute("UPDATE mistakes SET good = 0, wrong = wrong + 1, t = ? WHERE user_key = ? AND qkey = ?", (time.time(), key, qid))
    db.commit()
    if done:
        pay(db, key, LEARN_PAY)
    return jsonify(correct=ok, right=right, explain=q.get("explain") or "", done=done, pay=LEARN_PAY if done else 0)


# --------------------------------------------------------------------------- #
#  4. Kunlik 1 savol va 🔥
# --------------------------------------------------------------------------- #
DAILY_BASE, DAILY_STEP, DAILY_CAP = 2000, 500, 30


def streak_of(db, key: str) -> dict:
    row = db.execute("SELECT * FROM streaks WHERE user_key = ?", (key,)).fetchone()
    if not row:
        return {"cur": 0, "best": 0, "done": False}
    alive = row["last_day"] in (_today(), _yesterday())
    return {"cur": row["cur"] if alive else 0, "best": row["best"], "done": row["last_day"] == _today()}


def _daily_question(key: str) -> dict:
    """Har kim uchun kunning savoli (o'zgarmaydi, kundan-kunga takrorlanmaydi)."""
    day = datetime.now(gf.TASHKENT).toordinal()
    order = list(range(len(quiz.QUESTIONS)))
    random.Random(f"daily{key}{day // len(order)}").shuffle(order)
    return quiz.shuffled(order[day % len(order)], random.Random(f"{key}{day}"))


def streak_top(db, limit: int = 5) -> list:
    people = _people(db)
    rows = db.execute("SELECT user_key, cur FROM streaks WHERE last_day IN (?, ?) ORDER BY cur DESC, best DESC LIMIT ?",
                      (_today(), _yesterday(), limit)).fetchall()
    return [{"name": people[r["user_key"]]["name"], "avatar": people[r["user_key"]]["avatar"], "cur": r["cur"]} for r in rows if r["user_key"] in people]


@bp.get("/api/daily-question")
@login_required
def api_daily_q():
    key = _key()
    db = get_db()
    q = _daily_question(key)
    row = db.execute("SELECT * FROM daily_answers WHERE user_key = ? AND day = ?", (key, _today())).fetchone()
    out = {"topic": q["topic"], "question": q["question"], "options": q["options"], "streak": streak_of(db, key), "top": streak_top(db)}
    if row:
        out.update(answered=True, choice=row["choice"], right=q["correct"], explain=q["explain"])
    else:
        out.update(answered=False)
    return jsonify(out)


@bp.post("/api/daily-question")
@login_required
def api_daily_answer():
    key = _key()
    choice = _int(_json().get("choice"))
    q = _daily_question(key)
    if choice is None or not 0 <= choice < len(q["options"]):
        return _err("Javobni tanlang")
    db = get_db()
    ok = choice == q["correct"]
    cur = db.execute("INSERT OR IGNORE INTO daily_answers (user_key, day, choice, ok) VALUES (?, ?, ?, ?)", (key, _today(), choice, int(ok)))
    if not cur.rowcount:
        return _err("Bugungi savolga javob bergansiz — ertaga yana")
    row = db.execute("SELECT * FROM streaks WHERE user_key = ?", (key,)).fetchone()
    n = row["cur"] + 1 if row and row["last_day"] == _yesterday() else 1
    best = max(n, row["best"] if row else 0)
    db.execute("INSERT INTO streaks (user_key, cur, best, last_day) VALUES (?, ?, ?, ?) ON CONFLICT(user_key) DO UPDATE SET "
               "cur = excluded.cur, best = excluded.best, last_day = excluded.last_day", (key, n, best, _today()))
    note(db, key, q, ok)
    db.commit()
    money = DAILY_BASE + DAILY_STEP * min(n, DAILY_CAP) if ok else 0
    if money:
        pay(db, key, money)
    return jsonify(correct=ok, right=q["correct"], explain=q["explain"], pay=money, streak=streak_of(db, key), top=streak_top(db))


# --------------------------------------------------------------------------- #
#  1. Kod dueli
# --------------------------------------------------------------------------- #
DUEL_TIME = 600
DUEL_WAIT = 180
DUEL_PAY = 20000
DUEL_PAID_PAIR, DUEL_PAID_DAY = 3, 10
_duel_cool: dict[str, float] = {}


def _duel_refresh(db) -> None:
    now = time.time()
    db.execute("UPDATE duels SET status = 'cancelled' WHERE status = 'pending' AND created < ?", (now - DUEL_WAIT,))
    db.execute("UPDATE duels SET status = 'done', ended = started + ? WHERE status = 'running' AND started < ?", (DUEL_TIME, now - DUEL_TIME))
    db.commit()


def _duel_json(db, d, me: str, full: bool = False) -> dict:
    people = _people(db)
    task = codecheck.DUEL_BY_ID.get(d["task"], {})
    side = "a" if me == d["a"] else "b" if me == d["b"] else None
    now = time.time()

    def who(k):
        p = people.get(k, {})
        return {"key": k, "name": p.get("name", "?"), "avatar": p.get("avatar"), "len": len(d["a_code"] if k == d["a"] else d["b_code"])}
    out = {"id": d["id"], "status": d["status"], "a": who(d["a"]), "b": who(d["b"]), "side": side, "winner": d["winner"],
           "left": max(0, round(d["started"] + DUEL_TIME - now)) if d["status"] == "running" else 0,
           "title": task.get("title") if d["status"] != "pending" else None, "level": task.get("level"),
           "wait": max(0, round(d["created"] + DUEL_WAIT - now)) if d["status"] == "pending" else 0}
    if full and d["status"] in ("running", "done"):
        out["task"] = task.get("task")
        # Duel ketayotganda raqibning kodi ko'rinmaydi; tomoshabin va tugagandan keyin — ikkalasi
        see_both = d["status"] == "done" or side is None
        out["a_code"] = d["a_code"] if see_both or side == "a" else None
        out["b_code"] = d["b_code"] if see_both or side == "b" else None
    return out


def _duel(db, did: int):
    _duel_refresh(db)
    return db.execute("SELECT * FROM duels WHERE id = ?", (did,)).fetchone()


@bp.get("/api/duels")
@login_required
def api_duels():
    me = _key()
    db = get_db()
    _duel_refresh(db)
    rows = db.execute("SELECT * FROM duels WHERE status IN ('pending', 'running') ORDER BY id DESC LIMIT 30").fetchall()
    last = db.execute("SELECT * FROM duels WHERE status = 'done' ORDER BY id DESC LIMIT 8").fetchall()
    now = time.time()
    with game._lock:
        online = {k for k, p in game._live.items() if now - p["t"] < game.ONLINE_SECONDS}
    online |= {r["user_key"] for r in db.execute("SELECT DISTINCT user_key FROM devices WHERE last_at > ?", (now - 180,))}
    people = [{"key": k, "name": p["name"], "avatar": p["avatar"], "online": k in online} for k, p in _people(db).items() if k != me]
    people.sort(key=lambda p: (not p["online"], p["name"].lower()))
    names = _people(db)
    top = [{"name": names[r["winner"]]["name"], "wins": r["n"]} for r in db.execute(
        "SELECT winner, COUNT(*) AS n FROM duels WHERE winner IS NOT NULL GROUP BY winner ORDER BY n DESC LIMIT 5") if r["winner"] in names]
    return jsonify(active=[_duel_json(db, d, me) for d in rows if d["status"] == "running" or me in (d["a"], d["b"])],
                   last=[_duel_json(db, d, me) for d in last], people=people, top=top, pay=DUEL_PAY, time=DUEL_TIME)


@bp.post("/api/duels")
@login_required
def api_duel_new():
    user = current_user()
    me = user["key"]
    data = _json()
    to, level = data.get("to"), _int(data.get("level"))
    db = get_db()
    _duel_refresh(db)
    if to == me or to not in _people(db):
        return _err("Raqibni tanlang")
    for k, text in ((me, "Sizda ochiq duel bor — avval uni tugating"), (to, "U hozir boshqa duelda")):
        if db.execute("SELECT 1 FROM duels WHERE status IN ('pending', 'running') AND (a = ? OR b = ?)", (k, k)).fetchone():
            return _err(text)
    pool = [t["id"] for t in codecheck.DUEL_TASKS if level not in (1, 2, 3) or t["level"] == level]
    cur = db.execute("INSERT INTO duels (a, b, task, status, created, started, a_code, b_code) VALUES (?, ?, ?, 'pending', ?, 0, '', '')",
                     (me, to, random.choice(pool), time.time()))
    db.commit()
    classroom.notify(to, f"⚔️ {user['name']} sizni kod dueliga chaqirdi — 3 daqiqa ichida qabul qiling!", "/panel#learn/duel")
    gs._notify(to, f"⚔️ {user['name']} sizni kod dueliga chaqirdi — Panel → Mashqlar → Kod dueli")
    return jsonify(duel=_duel_json(db, _duel(db, cur.lastrowid), me)), 201


@bp.get("/api/duels/<int:did>")
@login_required
def api_duel_get(did: int):
    db = get_db()
    d = _duel(db, did)
    if not d:
        return _err("Duel topilmadi", 404)
    if d["status"] in ("pending", "cancelled") and _key() not in (d["a"], d["b"]):
        return _err("Duel hali boshlanmagan", 403)
    return jsonify(duel=_duel_json(db, d, _key(), True))


@bp.post("/api/duels/<int:did>/<action>")
@login_required
def api_duel_action(did: int, action: str):
    user = current_user()
    me = user["key"]
    db = get_db()
    d = _duel(db, did)
    if not d or me not in (d["a"], d["b"]):
        return _err("Duel topilmadi", 404)
    side = "a" if me == d["a"] else "b"
    other = d["b"] if side == "a" else d["a"]
    if action == "accept":
        if me != d["b"] or d["status"] != "pending":
            return _err("Taklif eskirgan")
        db.execute("UPDATE duels SET status = 'running', started = ? WHERE id = ? AND status = 'pending'", (time.time() + 3, did))
        db.commit()
        classroom.notify(d["a"], f"⚔️ {user['name']} duelni qabul qildi — boshlandi!", "/panel#learn/duel")
    elif action == "cancel":
        if d["status"] == "pending":
            db.execute("UPDATE duels SET status = 'cancelled' WHERE id = ? AND status = 'pending'", (did,))
        elif d["status"] == "running":  # taslim bo'lish
            db.execute("UPDATE duels SET status = 'done', winner = ?, ended = ? WHERE id = ? AND status = 'running'", (other, time.time(), did))
        db.commit()
    elif action == "code":
        if d["status"] == "running":
            db.execute(f"UPDATE duels SET {side}_code = ? WHERE id = ? AND status = 'running'", (_code(_json().get("code"), 8000), did))
            db.commit()
        return jsonify(ok=True)
    elif action == "submit":
        if d["status"] != "running":
            return _err("Duel tugagan")
        code = _code(_json().get("code"), 8000)
        now = time.time()
        if now < d["started"]:
            return _err("Hali boshlanmadi")
        if now - _duel_cool.get(me, 0) < 3:
            return _err("3 soniyada bir marta tekshirish mumkin", 429)
        _duel_cool[me] = now
        missing = codecheck.check(code, codecheck.DUEL_BY_ID[d["task"]]["checks"])
        db.execute(f"UPDATE duels SET {side}_code = ? WHERE id = ?", (code, did))
        db.commit()
        if missing:
            return jsonify(ok=False, missing=missing, duel=_duel_json(db, _duel(db, did), me, True))
        cur = db.execute("UPDATE duels SET status = 'done', winner = ?, ended = ? WHERE id = ? AND status = 'running' AND winner IS NULL", (me, now, did))
        db.commit()
        if not cur.rowcount:
            return _err("Raqib oldinroq tugatdi")
        day = now - 86400
        pair = db.execute("SELECT COUNT(*) FROM duels WHERE paid = 1 AND ended > ? AND winner = ? AND (a = ? OR b = ?)", (day, me, other, other)).fetchone()[0]
        total = db.execute("SELECT COUNT(*) FROM duels WHERE paid = 1 AND ended > ? AND winner = ?", (day, me)).fetchone()[0]
        money = DUEL_PAY if pair < DUEL_PAID_PAIR and total < DUEL_PAID_DAY else 0
        if money:
            db.execute("UPDATE duels SET paid = 1 WHERE id = ?", (did,))
            db.commit()
            pay(db, me, money)
        classroom.notify(other, f"⚔️ {user['name']} duelda sizdan oldin tugatdi. Yana urinib ko'ring!", "/panel#learn/duel")
        return jsonify(ok=True, pay=money, duel=_duel_json(db, _duel(db, did), me, True))
    else:
        return _err("?", 404)
    return jsonify(duel=_duel_json(db, _duel(db, did), me, True))


# --------------------------------------------------------------------------- #
#  2. Xatoni top
# --------------------------------------------------------------------------- #
@bp.get("/api/bugs")
@login_required
def api_bugs():
    key = _key()
    db = get_db()
    done = {r["item"] for r in db.execute("SELECT item FROM learn_done WHERE user_key = ? AND kind = 'bug'", (key,))}
    names = _people(db)
    top = [{"name": names[r["user_key"]]["name"], "n": r["n"]} for r in db.execute(
        "SELECT user_key, COUNT(*) AS n FROM learn_done WHERE kind = 'bug' GROUP BY user_key ORDER BY n DESC LIMIT 5") if r["user_key"] in names]
    return jsonify(items=[{**{k: b[k] for k in ("id", "lang", "level", "title", "want", "code")}, "done": b["id"] in done,
                           "pay": codecheck.BUG_PAY[b["level"]]} for b in codecheck.BUGS], top=top)


@bp.post("/api/bugs/<bid>")
@login_required
def api_bug_check(bid: str):
    key = _key()
    b = codecheck.BUGS_BY_ID.get(bid)
    code = _code(_json().get("code"), 4000)
    if not b or not code.strip():
        return _err("Kodni tuzating")
    if difflib.SequenceMatcher(None, b["code"], code, autojunk=False).ratio() < 0.5:
        return jsonify(ok=False, missing=["Kodni boshidan yozmang — faqat xatosini tuzating"])
    missing = codecheck.check(code, b["checks"])
    if missing:
        return jsonify(ok=False, missing=missing)
    db = get_db()
    first = _mark_done(db, key, "bug", bid)
    if first:
        pay(db, key, codecheck.BUG_PAY[b["level"]])
    return jsonify(ok=True, first=first, pay=codecheck.BUG_PAY[b["level"]] if first else 0)


def _mark_done(db, key: str, kind: str, item: str) -> bool:
    cur = db.execute("INSERT OR IGNORE INTO learn_done (user_key, kind, item, t) VALUES (?, ?, ?, ?)", (key, kind, item, time.time()))
    db.commit()
    return bool(cur.rowcount)


# --------------------------------------------------------------------------- #
#  3. Maketni takrorla
# --------------------------------------------------------------------------- #
@bp.get("/api/makets")
@login_required
def api_makets():
    user = current_user()
    key = user["key"]
    db = get_db()
    best = {r["maket"]: r for r in db.execute("SELECT * FROM maket_best WHERE user_key = ?", (key,))}
    names = _people(db)
    tops: dict[str, list] = {}
    for r in db.execute("SELECT maket, user_key, pct, html, css FROM maket_best WHERE pct > 0 ORDER BY pct DESC, LENGTH(html) + LENGTH(css), t"):
        lst = tops.setdefault(r["maket"], [])
        if len(lst) < 3 and r["user_key"] in names:
            lst.append({"name": names[r["user_key"]]["name"], "pct": r["pct"], "size": len(r["html"]) + len(r["css"])})
    return jsonify(items=[{"id": m["id"], "title": m["title"], "level": m["level"], "colors": m["colors"], "pay": codecheck.MAKET_PAY[m["level"]],
                           "image": f"/static/makets/{m['id']}.png", "best": best[m["id"]]["pct"] if m["id"] in best else 0,
                           "html": best[m["id"]]["html"] if m["id"] in best else "", "css": best[m["id"]]["css"] if m["id"] in best else "",
                           "top": tops.get(m["id"], [])} for m in codecheck.MAKETS], need=codecheck.MAKET_PASS)


@bp.post("/api/makets/<mid>")
@login_required
def api_maket_save(mid: str):
    key = _key()
    m = codecheck.MAKETS_BY_ID.get(mid)
    data = _json()
    html, css = _code(data.get("html"), 6000), _code(data.get("css"), 6000)
    pct = data.get("pct")
    if not m or isinstance(pct, bool) or not isinstance(pct, (int, float)) or not 0 <= pct <= 100:
        return _err("Noto'g'ri natija")
    if len((html + css).strip()) < 20:
        return _err("Avval kod yozing")
    if pct >= codecheck.MAKET_PASS and (not re.search(m["need"], html + css, re.I) or re.search(r"<\s*(img|svg|canvas|object|iframe|video|image)\b|url\(", html + css, re.I)):
        return _err("Rasm qo'ymasdan, faqat HTML va CSS bilan chizing 🙂")
    pct = round(float(pct), 1)
    db = get_db()
    row = db.execute("SELECT pct FROM maket_best WHERE user_key = ? AND maket = ?", (key, mid)).fetchone()
    better = not row or pct >= row["pct"]
    if better:
        db.execute("INSERT INTO maket_best (user_key, maket, pct, html, css, t) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_key, maket) DO UPDATE SET "
                   "pct = excluded.pct, html = excluded.html, css = excluded.css, t = excluded.t", (key, mid, pct, html, css, time.time()))
        db.commit()
    first = pct >= codecheck.MAKET_PASS and _mark_done(db, key, "maket", mid)
    if first:
        pay(db, key, codecheck.MAKET_PAY[m["level"]])
    return jsonify(best=max(pct, row["pct"] if row else 0), pct=pct, pay=codecheck.MAKET_PAY[m["level"]] if first else 0)


# --------------------------------------------------------------------------- #
#  6. Guruh loyihasi: bitta saytni birga yozish (har faylni bir vaqtda bitta odam yozadi)
# --------------------------------------------------------------------------- #
FILES = ("html", "css", "js")
LOCK_TTL = 25
PROJECT_MAX = 4


def _is_member(db, pid: int, user: dict) -> bool:
    return user["role"] == "owner" or db.execute("SELECT 1 FROM project_members WHERE project_id = ? AND user_key = ?", (pid, user["key"])).fetchone() is not None


def _project(db, pid: int):
    return db.execute("SELECT * FROM projects WHERE id = ? AND active = 1", (pid,)).fetchone()


def _project_members(db, pid: int) -> list:
    people = _people(db)
    now = time.time()
    return [{"key": r["user_key"], "name": people.get(r["user_key"], {}).get("name", "?"), "avatar": people.get(r["user_key"], {}).get("avatar"),
             "here": now - r["seen"] < 12} for r in db.execute("SELECT * FROM project_members WHERE project_id = ? ORDER BY user_key", (pid,))]


def _project_json(db, p, user: dict, known: dict | None = None) -> dict:
    people = _people(db)
    now = time.time()
    files = {}
    for f in db.execute("SELECT * FROM project_files WHERE project_id = ?", (p["id"],)):
        locked = f["lock_by"] if f["lock_by"] and now - f["lock_at"] < LOCK_TTL else None
        item = {"version": f["version"], "lock": locked, "lock_name": people.get(locked, {}).get("name") if locked else None,
                "mine": locked == user["key"], "by": people.get(f["updated_by"], {}).get("name")}
        if known is None or known.get(f["name"]) != f["version"]:
            item["content"] = f["content"]
        files[f["name"]] = item
    log = [{"name": people.get(r["user_key"], {}).get("name", "?"), "text": r["text"], "me": r["user_key"] == user["key"],
            "at": datetime.fromtimestamp(r["t"], gf.TASHKENT).strftime("%H:%M")}
           for r in db.execute("SELECT * FROM project_log WHERE project_id = ? ORDER BY id DESC LIMIT 30", (p["id"],))][::-1]
    return {"id": p["id"], "title": p["title"], "about": p["about"], "members": _project_members(db, p["id"]), "files": files, "log": log,
            "points": p["points"], "can_delete": user["role"] == "owner" or p["created_by"] == user["key"],
            "member": db.execute("SELECT 1 FROM project_members WHERE project_id = ? AND user_key = ?", (p["id"], user["key"])).fetchone() is not None}


@bp.get("/api/projects")
@login_required
def api_projects():
    user = current_user()
    db = get_db()
    rows = db.execute("SELECT * FROM projects WHERE active = 1 ORDER BY id DESC").fetchall()
    items = [{"id": p["id"], "title": p["title"], "about": p["about"], "members": _project_members(db, p["id"]), "points": p["points"]}
             for p in rows if _is_member(db, p["id"], user)]
    people = [{"key": k, "name": v["name"]} for k, v in _people(db).items() if k.startswith("u") and k != user["key"]]
    return jsonify(items=items, people=people, max=PROJECT_MAX)


@bp.post("/api/projects")
@login_required
def api_project_new():
    user = current_user()
    data = _json()
    title, about = _clean(data.get("title"), 60), _clean(data.get("about"), 300)
    db = get_db()
    people = _people(db)
    raw = data.get("members")
    members = list(dict.fromkeys(k for k in raw if isinstance(k, str) and k.startswith("u") and k in people)) if isinstance(raw, list) else []
    if user["role"] == "user":
        members = [user["key"]] + [k for k in members if k != user["key"]]
        if db.execute("SELECT 1 FROM projects WHERE active = 1 AND created_by = ?", (user["key"],)).fetchone():
            return _err("Sizning ochiq loyihangiz bor — avval uni tugating yoki o'chiring")
    if not title:
        return _err("Loyiha nomini yozing")
    if not 2 <= len(members) <= PROJECT_MAX:
        return _err(f"2 dan {PROJECT_MAX} gacha o'quvchi tanlang")
    cur = db.execute("INSERT INTO projects (title, about, created_by, created_at, active, points) VALUES (?, ?, ?, ?, 1, NULL)",
                     (title, about, user["key"], time.time()))
    pid = cur.lastrowid
    db.executemany("INSERT INTO project_members (project_id, user_key, seen) VALUES (?, ?, 0)", [(pid, k) for k in members])
    db.executemany("INSERT INTO project_files (project_id, name, content, version, updated_by, updated_at) VALUES (?, ?, '', 1, NULL, 0)", [(pid, f) for f in FILES])
    db.commit()
    for k in members:
        if k != user["key"]:
            classroom.notify(k, f"👥 {user['name']} sizni «{title}» guruh loyihasiga qo'shdi", f"/panel#learn/projects/{pid}")
    return jsonify(id=pid), 201


@bp.get("/api/projects/<int:pid>")
@login_required
def api_project_get(pid: int):
    user = current_user()
    db = get_db()
    p = _project(db, pid)
    if not p or not _is_member(db, pid, user):
        return _err("Loyiha topilmadi", 404)
    db.execute("UPDATE project_members SET seen = ? WHERE project_id = ? AND user_key = ?", (time.time(), pid, user["key"]))
    db.commit()
    known = None
    if request.args.get("html"):
        known = {f: request.args.get(f, type=int) for f in FILES}
    return jsonify(_project_json(db, p, user, known))


@bp.post("/api/projects/<int:pid>/lock")
@login_required
def api_project_lock(pid: int):
    user = current_user()
    data = _json()
    name, on = data.get("file"), bool(data.get("on"))
    db = get_db()
    p = _project(db, pid)
    if not p or not _is_member(db, pid, user) or name not in FILES:
        return _err("Loyiha topilmadi", 404)
    now = time.time()
    if on:
        cur = db.execute("UPDATE project_files SET lock_by = ?, lock_at = ? WHERE project_id = ? AND name = ? AND (lock_by IS NULL OR lock_by = ? OR lock_at < ?)",
                         (user["key"], now, pid, name, user["key"], now - LOCK_TTL))
        # bir vaqtda bitta fayl: qolganlarini bo'shatamiz
        if cur.rowcount:
            db.execute("UPDATE project_files SET lock_by = NULL WHERE project_id = ? AND name != ? AND lock_by = ?", (pid, name, user["key"]))
    else:
        cur = db.execute("UPDATE project_files SET lock_by = NULL WHERE project_id = ? AND name = ? AND lock_by = ?", (pid, name, user["key"]))
    db.commit()
    out = _project_json(db, p, user)
    if on and not cur.rowcount:
        return jsonify(error=f"Bu faylni hozir {out['files'][name]['lock_name'] or 'boshqa odam'} yozyapti", **{"project": out}), 409
    return jsonify(out)


@bp.post("/api/projects/<int:pid>/save")
@login_required
def api_project_save(pid: int):
    user = current_user()
    data = _json()
    name, content = data.get("file"), data.get("content")
    db = get_db()
    p = _project(db, pid)
    if not p or not _is_member(db, pid, user) or name not in FILES:
        return _err("Loyiha topilmadi", 404)
    if not isinstance(content, str) or len(content) > CODE_MAX:
        return _err(f"Kod {CODE_MAX} belgidan oshmasin")
    now = time.time()
    cur = db.execute("UPDATE project_files SET content = ?, version = version + 1, updated_by = ?, updated_at = ?, lock_at = ? "
                     "WHERE project_id = ? AND name = ? AND lock_by = ?", (content, user["key"], now, now, pid, name, user["key"]))
    db.commit()
    if not cur.rowcount:
        return _err("Faylni band qilish vaqti tugadi — «Yozish»ni qayta bosing", 409)
    v = db.execute("SELECT version FROM project_files WHERE project_id = ? AND name = ?", (pid, name)).fetchone()["version"]
    return jsonify(version=v)


@bp.post("/api/projects/<int:pid>/message")
@login_required
def api_project_message(pid: int):
    user = current_user()
    text = _clean(_json().get("text"), 300)
    db = get_db()
    p = _project(db, pid)
    if not p or not _is_member(db, pid, user):
        return _err("Loyiha topilmadi", 404)
    if not text:
        return _err("Xabar yozing")
    db.execute("INSERT INTO project_log (project_id, user_key, text, t) VALUES (?, ?, ?, ?)", (pid, user["key"], text, time.time()))
    db.commit()
    return jsonify(_project_json(db, p, user))


@bp.post("/api/projects/<int:pid>/grade")
@owner_required
def api_project_grade(pid: int):
    points = _int(_json().get("points"))
    db = get_db()
    p = _project(db, pid)
    if not p or points is None or not 0 <= points <= 5:
        return _err("Ball 0 dan 5 gacha")
    diff = points - (p["points"] or 0)
    for m in _project_members(db, pid):
        db.execute("UPDATE users SET score = score + ? WHERE id = ?", (diff, int(m["key"][1:])))
    db.execute("UPDATE projects SET points = ? WHERE id = ?", (points, pid))
    db.commit()
    for m in _project_members(db, pid):
        classroom.notify(m["key"], f"👥 «{p['title']}» loyihasiga {points} ball qo'yildi", f"/panel#learn/projects/{pid}")
    return jsonify(points=points)


@bp.delete("/api/projects/<int:pid>")
@login_required
def api_project_delete(pid: int):
    user = current_user()
    db = get_db()
    p = _project(db, pid)
    if not p or not (user["role"] == "owner" or p["created_by"] == user["key"]):
        return _err("Loyiha topilmadi", 404)
    db.execute("UPDATE projects SET active = 0 WHERE id = ?", (pid,))
    db.commit()
    return jsonify(ok=True)


# --------------------------------------------------------------------------- #
#  7. Saytlar ko'chasi (o'yinda: istirohat bog'idagi do'konchalar)
# --------------------------------------------------------------------------- #
SITE_SLOTS = [{"x": -1180 + i * 130, "y": 800} for i in range(9)]   # park janubi bo'ylab
SITE_EMOJI = ["🌐", "🚀", "🎮", "🍕", "📚", "⚽", "🎵", "🐱", "🌸", "💡", "🛒", "🎨"]


def _sites(db) -> list:
    people = _people(db)
    likes = {r["site"]: r["n"] for r in db.execute("SELECT site, COUNT(*) AS n FROM site_likes GROUP BY site")}
    rows = [r for r in db.execute("SELECT * FROM sites") if r["user_key"] in people]
    rows.sort(key=lambda r: (-likes.get(r["user_key"], 0), r["at"]))
    return [{"key": r["user_key"], "name": people[r["user_key"]]["name"], "title": r["title"], "emoji": r["emoji"],
             "likes": likes.get(r["user_key"], 0), "at": r["at"], "slot": i if i < len(SITE_SLOTS) else None} for i, r in enumerate(rows)]


@bp.get("/api/sites")
@login_required
def api_sites():
    user = current_user()
    db = get_db()
    liked = {r["site"] for r in db.execute("SELECT site FROM site_likes WHERE user_key = ?", (user["key"],))}
    items = [{**s, "liked": s["key"] in liked, "mine": s["key"] == user["key"]} for s in _sites(db)]
    projects = [{"id": p["id"], "title": p["title"]} for p in db.execute("SELECT * FROM projects WHERE active = 1") if _is_member(db, p["id"], user)]
    return jsonify(items=items, emoji=SITE_EMOJI, projects=projects)


@bp.get("/api/sites/<key>")
@login_required
def api_site(key: str):
    db = get_db()
    r = db.execute("SELECT * FROM sites WHERE user_key = ?", (key,)).fetchone()
    if not r:
        return _err("Sayt topilmadi", 404)
    liked = db.execute("SELECT 1 FROM site_likes WHERE site = ? AND user_key = ?", (key, _key())).fetchone() is not None
    n = db.execute("SELECT COUNT(*) FROM site_likes WHERE site = ?", (key,)).fetchone()[0]
    return jsonify(key=key, title=r["title"], emoji=r["emoji"], html=r["html"], css=r["css"], js=r["js"],
                   name=_people(db).get(key, {}).get("name", "?"), likes=n, liked=liked, mine=key == _key())


@bp.post("/api/sites")
@login_required
def api_site_publish():
    user = current_user()
    data = _json()
    title, emoji = _clean(data.get("title"), 40), data.get("emoji")
    if not title:
        return _err("Sayt nomini yozing")
    if emoji not in SITE_EMOJI:
        emoji = SITE_EMOJI[0]
    db = get_db()
    pid = _int(data.get("project"))
    if pid is not None:
        if not _project(db, pid) or not _is_member(db, pid, user):
            return _err("Loyiha topilmadi", 404)
        src = {r["name"]: r["content"] for r in db.execute("SELECT name, content FROM project_files WHERE project_id = ?", (pid,))}
    else:
        row = db.execute("SELECT * FROM code_pad WHERE user_key = ?", (user["key"],)).fetchone()
        src = {f: row[f] for f in FILES} if row else {}
    if len("".join(src.values()).strip()) < 20:
        return _err("Avval «Kod muharriri»da sayt yozing")
    first = db.execute("SELECT 1 FROM sites WHERE user_key = ?", (user["key"],)).fetchone() is None
    db.execute("INSERT INTO sites (user_key, title, emoji, html, css, js, at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_key) DO UPDATE SET "
               "title = excluded.title, emoji = excluded.emoji, html = excluded.html, css = excluded.css, js = excluded.js, at = excluded.at",
               (user["key"], title, emoji, src.get("html", ""), src.get("css", ""), src.get("js", ""), time.time()))
    db.commit()
    if first and _mark_done(db, user["key"], "site", "first"):
        pay(db, user["key"], 10000)
    return api_sites()


@bp.delete("/api/sites/<key>")
@login_required
def api_site_delete(key: str):
    user = current_user()
    if user["role"] != "owner" and key != user["key"]:
        return _err("Ruxsat yo'q", 403)
    db = get_db()
    db.execute("DELETE FROM sites WHERE user_key = ?", (key,))
    db.execute("DELETE FROM site_likes WHERE site = ?", (key,))
    db.commit()
    if key != user["key"]:
        classroom.notify(key, "🏪 Owner saytingizni ko'chadan olib tashladi", "/panel#learn/sites")
    return api_sites()


@bp.post("/api/sites/<key>/like")
@login_required
def api_site_like(key: str):
    me = _key()
    db = get_db()
    if key == me or not db.execute("SELECT 1 FROM sites WHERE user_key = ?", (key,)).fetchone():
        return _err("O'zingizga yulduz qo'yib bo'lmaydi" if key == me else "Sayt topilmadi")
    if not db.execute("DELETE FROM site_likes WHERE site = ? AND user_key = ?", (key, me)).rowcount:
        db.execute("INSERT INTO site_likes (site, user_key) VALUES (?, ?)", (key, me))
    db.commit()
    n = db.execute("SELECT COUNT(*) FROM site_likes WHERE site = ?", (key,)).fetchone()[0]
    return jsonify(likes=n, liked=db.execute("SELECT 1 FROM site_likes WHERE site = ? AND user_key = ?", (key, me)).fetchone() is not None)


def _sites_sig(db) -> str:
    r = db.execute("SELECT COUNT(*) AS n, COALESCE(MAX(at), 0) AS t FROM sites").fetchone()
    n = db.execute("SELECT COUNT(*) FROM site_likes").fetchone()[0]
    return f"{r['n']}|{r['t']}|{n}"


_sig_cache = {"t": 0.0, "v": ""}


def _sync_hook(db, key: str, row, now: float, response: dict) -> None:
    if now - _sig_cache["t"] > 5:
        _sig_cache.update(t=now, v=_sites_sig(db))
    response["sites_sig"] = _sig_cache["v"]


game.SYNC_HOOKS.append(_sync_hook)
game.WORLD_DATA["town"]["sites"] = SITE_SLOTS


# --------------------------------------------------------------------------- #
#  8. Baho berish: o'quvchilar bir-birining uy ishiga yulduz va izoh qo'yadi
# --------------------------------------------------------------------------- #
PEER_PAY, PEER_DAY = 1000, 10
PEER_TEXT = {".html", ".htm", ".css", ".js", ".txt", ".md"}


def peer_on() -> bool:
    return get_setting("peer_off") != "1"


def _peer_stats(db, sub_id: int) -> dict:
    r = db.execute("SELECT COUNT(*) AS n, AVG(stars) AS s FROM peer_reviews WHERE submission_id = ?", (sub_id,)).fetchone()
    return {"n": r["n"], "avg": round(r["s"], 1) if r["n"] else None}


def _may_peer(db, sub, user: dict) -> bool:
    """O'zi shu vazifani topshirib, tekshirtirgan bo'lsagina boshqalarnikini ko'radi (ko'chirmasligi uchun)."""
    if user["role"] == "owner" or sub["user_id"] == user.get("id"):
        return True
    if not peer_on() or sub["status"] != "checked":
        return False
    return db.execute("SELECT 1 FROM submissions WHERE homework_id = ? AND user_id = ? AND status = 'checked'",
                      (sub["homework_id"], user["id"])).fetchone() is not None


@bp.get("/api/homeworks/<int:hw_id>/peers")
@login_required
def api_peers(hw_id: int):
    user = current_user()
    db = get_db()
    if user["role"] == "user" and not db.execute("SELECT 1 FROM submissions WHERE homework_id = ? AND user_id = ? AND status = 'checked'", (hw_id, user["id"])).fetchone():
        return jsonify(items=[], locked=True, on=peer_on())
    if user["role"] == "user" and not peer_on():
        return jsonify(items=[], locked=False, on=False)
    rows = db.execute("SELECT s.*, u.name, u.avatar FROM submissions s JOIN users u ON u.id = s.user_id WHERE s.homework_id = ? AND s.status = 'checked' ORDER BY s.id", (hw_id,)).fetchall()
    mine = {r["submission_id"]: r for r in db.execute("SELECT * FROM peer_reviews WHERE reviewer = ?", (user["key"],))}
    return jsonify(locked=False, on=peer_on(), items=[{"id": r["id"], "name": r["name"], "avatar": avatar_url(r["avatar"]), "files": json.loads(r["files"]), **_peer_stats(db, r["id"]),
                          "my": mine[r["id"]]["stars"] if r["id"] in mine else None, "mine": r["user_id"] == user.get("id")} for r in rows])


@bp.get("/api/peers/<int:sub_id>")
@login_required
def api_peer(sub_id: int):
    user = current_user()
    db = get_db()
    sub = homework.load_submission(sub_id)
    if sub is None or not _may_peer(db, sub, user):
        return _err("Ruxsat yo'q", 403)
    files = []
    for name in json.loads(sub["files"]):
        path = homework.submission_dir(sub_id) / name
        if path.suffix.lower() in PEER_TEXT and path.is_file() and path.stat().st_size <= 200_000:
            files.append({"name": name, "text": path.read_text(encoding="utf-8", errors="replace")[:60000]})
    reviews = [{"id": r["id"], "name": r["name"], "stars": r["stars"], "text": r["text"], "me": r["reviewer"] == user["key"]}
               for r in db.execute("SELECT p.*, COALESCE(u.name, 'Owner') AS name FROM peer_reviews p LEFT JOIN users u ON p.reviewer = 'u' || u.id "
                                   "WHERE p.submission_id = ? ORDER BY p.id DESC", (sub_id,))]
    return jsonify(id=sub_id, name=sub["user_name"], mine=sub["user_id"] == user.get("id"), files=files, all_files=json.loads(sub["files"]),
                   reviews=reviews, **_peer_stats(db, sub_id))


@bp.post("/api/peers/<int:sub_id>")
@login_required
def api_peer_review(sub_id: int):
    user = current_user()
    data = _json()
    stars, text = _int(data.get("stars")), _clean(data.get("text"), 300)
    db = get_db()
    sub = homework.load_submission(sub_id)
    if sub is None or not _may_peer(db, sub, user):
        return _err("Ruxsat yo'q", 403)
    if sub["user_id"] == user.get("id"):
        return _err("O'z ishingizga baho bera olmaysiz")
    if stars is None or not 1 <= stars <= 5:
        return _err("1 dan 5 gacha yulduz qo'ying")
    first = db.execute("SELECT 1 FROM peer_reviews WHERE submission_id = ? AND reviewer = ?", (sub_id, user["key"])).fetchone() is None
    db.execute("INSERT INTO peer_reviews (submission_id, reviewer, stars, text, t) VALUES (?, ?, ?, ?, ?) ON CONFLICT(submission_id, reviewer) DO UPDATE SET "
               "stars = excluded.stars, text = excluded.text, t = excluded.t", (sub_id, user["key"], stars, text, time.time()))
    db.commit()
    money = 0
    if first:
        classroom.notify(f"u{sub['user_id']}", f"⭐ {user['name']} uy ishingizga {stars} yulduz qo'ydi{': ' + text if text else ''}", "/panel#homework")
        if user["role"] == "user" and len(text) >= 10 and _count_today(db, user["key"], "peer") < PEER_DAY and _mark_done(db, user["key"], "peer", str(sub_id)):
            _bump_today(db, user["key"], "peer")
            db.commit()
            money = PEER_PAY
            pay(db, user["key"], money)
    return jsonify(pay=money, **_peer_stats(db, sub_id))


@bp.delete("/api/peer-reviews/<int:rid>")
@login_required
def api_peer_delete(rid: int):
    user = current_user()
    db = get_db()
    if user["role"] == "owner":
        db.execute("DELETE FROM peer_reviews WHERE id = ?", (rid,))
    else:
        db.execute("DELETE FROM peer_reviews WHERE id = ? AND reviewer = ?", (rid, user["key"]))
    db.commit()
    return jsonify(ok=True)


@bp.post("/api/peer-settings")
@owner_required
def api_peer_settings():
    set_setting("peer_off", None if _json().get("on") else "1")
    return jsonify(on=peer_on())


def _forget(db, key: str) -> None:
    for table, col in (("mistakes", "user_key"), ("daily_answers", "user_key"), ("streaks", "user_key"), ("learn_daily", "user_key"), ("learn_done", "user_key"),
                       ("maket_best", "user_key"), ("project_members", "user_key"), ("sites", "user_key"), ("site_likes", "user_key"), ("site_likes", "site"),
                       ("peer_reviews", "reviewer"), ("duels", "a"), ("duels", "b")):
        db.execute(f"DELETE FROM {table} WHERE {col} = ?", (key,))


game.FORGET_HOOKS.append(_forget)

SCHEMA = """
CREATE TABLE IF NOT EXISTS mistakes (
    user_key TEXT NOT NULL, qkey TEXT NOT NULL, data TEXT NOT NULL, wrong INTEGER NOT NULL, good INTEGER NOT NULL, t REAL NOT NULL,
    PRIMARY KEY (user_key, qkey)
);
CREATE TABLE IF NOT EXISTS daily_answers (user_key TEXT NOT NULL, day TEXT NOT NULL, choice INTEGER NOT NULL, ok INTEGER NOT NULL, PRIMARY KEY (user_key, day));
CREATE TABLE IF NOT EXISTS streaks (user_key TEXT PRIMARY KEY, cur INTEGER NOT NULL, best INTEGER NOT NULL, last_day TEXT NOT NULL, reminded TEXT);
CREATE TABLE IF NOT EXISTS learn_daily (user_key TEXT NOT NULL, kind TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (user_key, kind, day));
CREATE TABLE IF NOT EXISTS learn_done (user_key TEXT NOT NULL, kind TEXT NOT NULL, item TEXT NOT NULL, t REAL NOT NULL, PRIMARY KEY (user_key, kind, item));
CREATE TABLE IF NOT EXISTS duels (
    id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT NOT NULL, b TEXT NOT NULL, task TEXT NOT NULL, status TEXT NOT NULL,
    created REAL NOT NULL, started REAL NOT NULL, ended REAL, a_code TEXT NOT NULL, b_code TEXT NOT NULL, winner TEXT, paid INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS maket_best (user_key TEXT NOT NULL, maket TEXT NOT NULL, pct REAL NOT NULL, html TEXT NOT NULL, css TEXT NOT NULL, t REAL NOT NULL, PRIMARY KEY (user_key, maket));
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, about TEXT NOT NULL, created_by TEXT NOT NULL, created_at REAL NOT NULL, active INTEGER NOT NULL, points INTEGER
);
CREATE TABLE IF NOT EXISTS project_members (project_id INTEGER NOT NULL, user_key TEXT NOT NULL, seen REAL NOT NULL, PRIMARY KEY (project_id, user_key));
CREATE TABLE IF NOT EXISTS project_files (
    project_id INTEGER NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL, version INTEGER NOT NULL, updated_by TEXT, updated_at REAL NOT NULL,
    lock_by TEXT, lock_at REAL NOT NULL DEFAULT 0, PRIMARY KEY (project_id, name)
);
CREATE TABLE IF NOT EXISTS project_log (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, user_key TEXT NOT NULL, text TEXT NOT NULL, t REAL NOT NULL);
CREATE TABLE IF NOT EXISTS sites (
    user_key TEXT PRIMARY KEY, title TEXT NOT NULL, emoji TEXT NOT NULL, html TEXT NOT NULL, css TEXT NOT NULL, js TEXT NOT NULL, at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS site_likes (site TEXT NOT NULL, user_key TEXT NOT NULL, PRIMARY KEY (site, user_key));
CREATE TABLE IF NOT EXISTS peer_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT, submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    reviewer TEXT NOT NULL, stars INTEGER NOT NULL, text TEXT NOT NULL, t REAL NOT NULL, UNIQUE (submission_id, reviewer)
);
"""
