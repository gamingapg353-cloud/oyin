"""Maktab funksiyalari: guruhlar, dars jadvali, oy o'quvchisi, ota-onaga hisobot, faollik,
ko'chirib olishni aniqlash, AI yordamchi, so'rovnoma, sovg'alar do'koni, tug'ilgan kun va
yutuqlar devori.
"""
import difflib
import json
import re
import secrets
import time
from datetime import date, datetime, timedelta
from pathlib import Path

from flask import Blueprint, abort, jsonify, render_template_string, request

import ai_check
import classroom
from core import avatar_url, current_user, get_db, login_required, owner_required

bp = Blueprint("school", __name__)
NAME_MAX = 60


def _clean(value, limit=NAME_MAX) -> str:
    return " ".join(str(value or "").split())[:limit]


def _int(value):
    return value if isinstance(value, int) and not isinstance(value, bool) else None


# --------------------------------------------------------------------------- #
#  Guruhlar
# --------------------------------------------------------------------------- #
@bp.get("/api/groups")
@login_required
def api_groups():
    db = get_db()
    rows = db.execute("SELECT g.id, g.name, (SELECT COUNT(*) FROM users u WHERE u.group_id = g.id) AS n "
                      "FROM groups g ORDER BY g.name COLLATE NOCASE").fetchall()
    return jsonify(groups=[{"id": r["id"], "name": r["name"], "count": r["n"]} for r in rows])


@bp.post("/api/groups")
@owner_required
def api_group_create():
    name = _clean((request.get_json(silent=True) or {}).get("name"), 40)
    if len(name) < 1:
        return jsonify(error="Guruh nomini yozing"), 400
    db = get_db()
    if db.execute("SELECT 1 FROM groups WHERE name = ?", (name,)).fetchone():
        return jsonify(error="Bunday guruh bor"), 400
    db.execute("INSERT INTO groups (name) VALUES (?)", (name,))
    db.commit()
    return api_groups()


@bp.delete("/api/groups/<int:gid>")
@owner_required
def api_group_delete(gid: int):
    db = get_db()
    db.execute("UPDATE users SET group_id = NULL WHERE group_id = ?", (gid,))
    db.execute("DELETE FROM groups WHERE id = ?", (gid,))
    db.commit()
    return api_groups()


@bp.post("/api/users/<int:user_id>/group")
@owner_required
def api_user_group(user_id: int):
    gid = (request.get_json(silent=True) or {}).get("group_id")
    db = get_db()
    if gid is not None and not db.execute("SELECT 1 FROM groups WHERE id = ?", (_int(gid),)).fetchone():
        return jsonify(error="Bunday guruh yo'q"), 400
    db.execute("UPDATE users SET group_id = ? WHERE id = ?", (gid, user_id))
    db.commit()
    return jsonify(ok=True)


# --------------------------------------------------------------------------- #
#  Dars jadvali
# --------------------------------------------------------------------------- #
@bp.get("/api/lessons")
@login_required
def api_lessons():
    user = current_user()
    db = get_db()
    import portal
    now = (portal.now_tk() - timedelta(minutes=30)).isoformat(timespec="minutes")  # dars vaqtlari — Toshkent vaqtida
    gid = None
    if user["role"] == "user":
        row = db.execute("SELECT group_id FROM users WHERE id = ?", (user["id"],)).fetchone()
        gid = row["group_id"] if row else None
    rows = db.execute("SELECT l.*, g.name AS gname FROM lessons l LEFT JOIN groups g ON g.id = l.group_id "
                      "WHERE l.starts_at >= ? ORDER BY l.starts_at LIMIT 20", (now[:16],)).fetchall()
    out = [{"id": r["id"], "starts_at": r["starts_at"], "topic": r["topic"], "group": r["gname"], "group_id": r["group_id"], "weekly": bool(r["weekly"])}
           for r in rows if user["role"] == "owner" or r["group_id"] in (None, gid)]
    return jsonify(lessons=out)


@bp.post("/api/lessons")
@owner_required
def api_lesson_add():
    data = request.get_json(silent=True) or {}
    topic = _clean(data.get("topic"), 120)
    try:
        starts = datetime.fromisoformat(str(data.get("starts_at"))).isoformat(timespec="minutes")
    except ValueError:
        return jsonify(error="Sana va vaqtni tanlang"), 400
    if not topic:
        return jsonify(error="Dars mavzusini yozing"), 400
    gid = data.get("group_id")
    db = get_db()
    db.execute("INSERT INTO lessons (starts_at, topic, group_id, weekly) VALUES (?, ?, ?, ?)", (starts, topic, _int(gid), int(bool(data.get("weekly")))))
    db.commit()
    return api_lessons()


@bp.delete("/api/lessons/<int:lid>")
@owner_required
def api_lesson_delete(lid: int):
    db = get_db()
    db.execute("DELETE FROM lessons WHERE id = ?", (lid,))
    db.commit()
    return api_lessons()


# --------------------------------------------------------------------------- #
#  Oy o'quvchisi (oy davomida eng ko'p ball yig'gan)
# --------------------------------------------------------------------------- #
def month_scores(db, ym: str) -> dict:
    """ym = 'YYYY-MM'. Davomat + uy vazifa + test ballari (shu oy ichidagi)."""
    scores: dict = {}

    def add(uid, v):
        scores[uid] = scores.get(uid, 0) + (v or 0)

    for r in db.execute("SELECT user_id, SUM(points) AS s FROM attendance WHERE day LIKE ? GROUP BY user_id", (ym + "%",)):
        add(r["user_id"], r["s"])
    for r in db.execute("SELECT user_id, SUM(score) AS s FROM submissions WHERE created_at LIKE ? GROUP BY user_id", (ym + "%",)):
        add(r["user_id"], r["s"])
    y, m = map(int, ym.split("-"))
    start = datetime(y, m, 1).timestamp()
    end = datetime(y + (m == 12), m % 12 + 1, 1).timestamp()
    for r in db.execute("SELECT user_id, SUM(score) AS s FROM exam_attempts WHERE finished_at >= ? AND finished_at < ? GROUP BY user_id",
                        (start, end)):
        add(r["user_id"], r["s"])
    return scores


def _prev_month(ym: str) -> str:
    y, m = map(int, ym.split("-"))
    return f"{y - (m == 1)}-{(m - 2) % 12 + 1:02d}"


def best_of(db, ym: str) -> dict | None:
    scores = {k: v for k, v in month_scores(db, ym).items() if v > 0}
    if not scores:
        return None
    uid = max(scores, key=lambda k: (scores[k], -k))
    u = db.execute("SELECT id, name, avatar FROM users WHERE id = ?", (uid,)).fetchone()
    return {"id": u["id"], "name": u["name"], "avatar": avatar_url(u["avatar"]), "score": scores[uid], "month": ym} if u else None


@bp.get("/api/best-month")
@login_required
def api_best_month():
    db = get_db()
    ym = date.today().isoformat()[:7]
    return jsonify(prev=best_of(db, _prev_month(ym)), current=best_of(db, ym))


# --------------------------------------------------------------------------- #
#  Ota-onaga hisobot (login kerak emas, maxfiy havola orqali)
# --------------------------------------------------------------------------- #
@bp.post("/api/users/<int:user_id>/report-link")
@owner_required
def api_report_link(user_id: int):
    db = get_db()
    row = db.execute("SELECT report_token FROM users WHERE id = ?", (user_id,)).fetchone()
    if row is None:
        return jsonify(error="Topilmadi"), 404
    token = row["report_token"]
    if not token or (request.get_json(silent=True) or {}).get("new"):
        token = secrets.token_urlsafe(12)
        db.execute("UPDATE users SET report_token = ? WHERE id = ?", (token, user_id))
        db.commit()
    return jsonify(url=f"{request.host_url.rstrip('/')}/report/{token}")


REPORT_HTML = """<!doctype html><html lang="uz"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>{{ u.name }} — hisobot</title>
<style>
body{font-family:system-ui,"Segoe UI",sans-serif;margin:0;background:#f1f5f9;color:#0f172a}
main{max-width:720px;margin:0 auto;padding:20px 16px}
.card{background:#fff;border-radius:16px;padding:16px 18px;margin-bottom:14px;box-shadow:0 2px 10px rgba(0,0,0,.05)}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:0 0 10px}
.big{font-size:34px;font-weight:800;color:#2563eb}.muted{color:#64748b;font-size:14px}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{padding:6px 4px;border-bottom:1px solid #e2e8f0;text-align:left}
.ok{color:#16a34a;font-weight:700}.bad{color:#dc2626;font-weight:700}.late{color:#d97706;font-weight:700}
.badge{display:inline-block;background:#fef3c7;color:#92400e;border-radius:999px;padding:4px 10px;font-weight:700;font-size:13px}
</style></head><body><main>
<div class="card"><h1>{{ u.name }}</h1><p class="muted">Ota-ona uchun hisobot · {{ today }}</p>
<div class="big">{{ total }} ball</div><p class="muted">Jami ball (reytingda {{ place }}-o'rin, {{ count }} o'quvchi ichida)</p>
{% if best %}<p><span class="badge">👑 {{ best }} oyning eng yaxshi o'quvchisi</span></p>{% endif %}</div>
<div class="card"><h2>So'nggi 7 kun davomati</h2>{% if att %}<table>{% for a in att %}<tr><td>{{ a.day }}</td>
<td class="{{ 'ok' if a.status == 'keldi' else ('late' if a.status == 'kechikdi' else 'bad') }}">{{ {'keldi':'Keldi','kechikdi':'Kechikdi','kelmadi':'Kelmadi'}[a.status] }}</td>
<td>{{ a.points }} ball</td></tr>{% endfor %}</table>{% else %}<p class="muted">Bu hafta belgilangan dars yo'q.</p>{% endif %}</div>
<div class="card"><h2>Uy vazifalar</h2>{% if hw %}<table>{% for h in hw %}<tr><td>{{ h.title }}</td><td>{{ h.created_at[:10] }}</td>
<td class="{{ 'ok' if h.score > 0 else 'bad' }}">{{ h.score }} ball</td></tr>{% endfor %}</table>{% else %}<p class="muted">Hali topshirilmagan.</p>{% endif %}</div>
<div class="card"><h2>Testlar</h2>{% if tests %}<table>{% for t in tests %}<tr><td>{{ t.title }}</td><td>{{ t.score }} / 5</td></tr>{% endfor %}</table>
{% else %}<p class="muted">Hali test yechilmagan.</p>{% endif %}</div>
<p class="muted">Bu sahifa faqat havolani bilganlarga ochiq.</p></main></body></html>"""


@bp.get("/report/<token>")
def report_page(token: str):
    db = get_db()
    u = db.execute("SELECT * FROM users WHERE report_token = ?", (token,)).fetchone()
    if u is None or len(token) < 8:
        abort(404)
    from core import RATING_SQL
    rating = db.execute(RATING_SQL).fetchall()
    place = next((i + 1 for i, r in enumerate(rating) if r["id"] == u["id"]), "-")
    total = next((r["total"] for r in rating if r["id"] == u["id"]), 0)
    week_ago = (date.today() - timedelta(days=7)).isoformat()
    att = db.execute("SELECT * FROM attendance WHERE user_id = ? AND day >= ? ORDER BY day DESC", (u["id"], week_ago)).fetchall()
    hw = db.execute("SELECT s.score, s.created_at, h.title FROM submissions s JOIN homeworks h ON h.id = s.homework_id "
                    "WHERE s.user_id = ? AND s.status = 'checked' ORDER BY s.id DESC LIMIT 8", (u["id"],)).fetchall()
    tests = db.execute("SELECT a.score, e.title FROM exam_attempts a JOIN exams e ON e.id = a.exam_id "
                       "WHERE a.user_id = ? AND a.finished_at IS NOT NULL ORDER BY a.finished_at DESC LIMIT 8", (u["id"],)).fetchall()
    prev = best_of(db, _prev_month(date.today().isoformat()[:7]))
    return render_template_string(REPORT_HTML, u=u, total=total, place=place, count=len(rating), att=att, hw=hw,
                                  tests=tests, today=date.today().isoformat(),
                                  best=prev["month"] if prev and prev["id"] == u["id"] else None)


# --------------------------------------------------------------------------- #
#  Faollik: saytda necha daqiqa (classroom.touch_device har daqiqada yozadi)
# --------------------------------------------------------------------------- #
def add_minute(db, user_key: str) -> None:
    db.execute("INSERT INTO activity (user_key, day, minutes) VALUES (?, ?, 1) "
               "ON CONFLICT(user_key, day) DO UPDATE SET minutes = minutes + 1", (user_key, date.today().isoformat()))


@bp.get("/api/activity/<int:user_id>")
@owner_required
def api_activity(user_id: int):
    db = get_db()
    days = [(date.today() - timedelta(days=i)).isoformat() for i in range(13, -1, -1)]
    rows = {r["day"]: r["minutes"] for r in db.execute(
        "SELECT day, minutes FROM activity WHERE user_key = ? AND day >= ?", (f"u{user_id}", days[0]))}
    return jsonify(days=[{"day": d, "minutes": rows.get(d, 0)} for d in days])


# --------------------------------------------------------------------------- #
#  Ko'chirib olishni aniqlash: bir xil uy vazifa
# --------------------------------------------------------------------------- #
COPY_LIMIT = 85      # shu foizdan o'xshash bo'lsa — ogohlantirish
TEXT_EXT = {".html", ".htm", ".css", ".scss", ".js", ".txt", ".md", ".json"}


def _sub_text(folder: Path, names: list) -> str:
    parts = []
    for n in sorted(names):
        f = folder / n
        if f.suffix.lower() in TEXT_EXT and f.is_file():
            parts.append(f.read_text(encoding="utf-8", errors="ignore"))
    return re.sub(r"\s+", "", "\n".join(parts)).lower()[:60000]


def check_copy(db, sub_id: int, submission_dir) -> None:
    sub = db.execute("SELECT * FROM submissions WHERE id = ?", (sub_id,)).fetchone()
    mine = _sub_text(submission_dir(sub_id), json.loads(sub["files"]))
    if len(mine) < 40:
        return
    best = (0, None)
    for other in db.execute("SELECT s.id, s.files, u.name FROM submissions s JOIN users u ON u.id = s.user_id "
                            "WHERE s.homework_id = ? AND s.id != ?", (sub["homework_id"], sub_id)):
        theirs = _sub_text(submission_dir(other["id"]), json.loads(other["files"]))
        if len(theirs) < 40:
            continue
        ratio = int(difflib.SequenceMatcher(None, mine, theirs, autojunk=False).ratio() * 100)
        if ratio > best[0]:
            best = (ratio, other["name"])
    if best[0] >= COPY_LIMIT:
        db.execute("UPDATE submissions SET copy_of = ?, copy_score = ? WHERE id = ?", (best[1], best[0], sub_id))
        db.commit()
        name = db.execute("SELECT name FROM users WHERE id = ?", (sub["user_id"],)).fetchone()["name"]
        classroom.notify("owner", f"⚠ Ko'chirish ehtimoli: {name} ishi {best[1]} ishiga {best[0]}% o'xshash", "/panel#homework")


# --------------------------------------------------------------------------- #
#  AI yordamchi: javobni emas, maslahat beradi
# --------------------------------------------------------------------------- #
HINT_PER_DAY = 15


@bp.post("/api/ai/hint")
@login_required
def api_ai_hint():
    user = current_user()
    data = request.get_json(silent=True) or {}
    code = str(data.get("code") or "")[:6000]
    question = _clean(data.get("question"), 400)
    if not code.strip() and not question:
        return jsonify(error="Kodingizni va savolingizni yozing"), 400
    db = get_db()
    key = user["key"]
    today = date.today().isoformat()
    row = db.execute("SELECT n FROM ai_hint_use WHERE user_key = ? AND day = ?", (key, today)).fetchone()
    if row and row["n"] >= HINT_PER_DAY and user["role"] != "owner":
        return jsonify(error=f"Bugun {HINT_PER_DAY} ta savol berdingiz — ertaga yana"), 429
    try:
        hint = ai_check.hint(code, question)
    except ai_check.AICheckError as err:
        return jsonify(error=str(err).replace("«Qayta tekshirish»ni bosing", "qayta so'rang")), 503
    db.execute("INSERT INTO ai_hint_use (user_key, day, n) VALUES (?, ?, 1) "
               "ON CONFLICT(user_key, day) DO UPDATE SET n = n + 1", (key, today))
    db.commit()
    left = HINT_PER_DAY - ((row["n"] if row else 0) + 1)
    return jsonify(hint=hint, left=max(0, left))


# --------------------------------------------------------------------------- #
#  So'rovnoma
# --------------------------------------------------------------------------- #
def _polls_json(db, user):
    uid = user.get("id")
    out = []
    for p in db.execute("SELECT * FROM polls2 ORDER BY active DESC, id DESC LIMIT 20"):
        options = json.loads(p["options"])
        counts = [0] * len(options)
        mine = None
        for v in db.execute("SELECT user_id, choice FROM poll_votes2 WHERE poll_id = ?", (p["id"],)):
            if 0 <= v["choice"] < len(counts):
                counts[v["choice"]] += 1
            if v["user_id"] == uid:
                mine = v["choice"]
        item = {"id": p["id"], "question": p["question"], "options": options, "counts": counts,
                "mine": mine, "active": bool(p["active"]), "total": sum(counts)}
        # Yozma javoblar: o'quvchi faqat o'zinikini, owner hammasini ko'radi
        answers = db.execute("SELECT a.*, u.name, u.avatar FROM poll_answers a JOIN users u ON u.id = a.user_id "
                             "WHERE a.poll_id = ? ORDER BY a.at", (p["id"],)).fetchall()
        item["answer_count"] = len(answers)
        mine_text = next((a["text"] for a in answers if a["user_id"] == uid), None)
        item["my_answer"] = mine_text
        if user["role"] == "owner":
            item["answers"] = [{"name": a["name"], "avatar": avatar_url(a["avatar"]), "text": a["text"],
                                "at": datetime.fromtimestamp(a["at"]).strftime("%d.%m %H:%M")} for a in answers]
        out.append(item)
    return jsonify(polls=out)


@bp.get("/api/polls")
@login_required
def api_polls():
    return _polls_json(get_db(), current_user())


@bp.post("/api/polls")
@owner_required
def api_poll_create():
    data = request.get_json(silent=True) or {}
    q = _clean(data.get("question"), 300)
    options = [_clean(o, 80) for o in (data.get("options") or []) if _clean(o, 80)]
    if not q:
        return jsonify(error="Savolni yozing"), 400
    # Variantlarsiz — o'quvchilar javobni o'zi yozadi; variantli eski usul ham ishlaydi
    if options and (not 2 <= len(options) <= 6 or len(set(options)) != len(options)):
        return jsonify(error="Variantlar 2–6 ta va har xil bo'lsin"), 400
    db = get_db()
    db.execute("INSERT INTO polls2 (question, options, active, created_at) VALUES (?, ?, 1, ?)",
               (q, json.dumps(options, ensure_ascii=False), time.time()))
    db.commit()
    classroom.notify_all_users(f"💬 Ustoz savol berdi: {q[:80]} — javob yozing", "/panel#polls")
    return _polls_json(db, current_user())


@bp.post("/api/polls/<int:pid>/vote")
@login_required
def api_poll_vote(pid: int):
    user = current_user()
    if user["role"] != "user":
        return jsonify(error="Owner ovoz bermaydi"), 400
    choice = _int((request.get_json(silent=True) or {}).get("choice"))
    db = get_db()
    p = db.execute("SELECT * FROM polls2 WHERE id = ?", (pid,)).fetchone()
    if p is None or not p["active"]:
        return jsonify(error="So'rovnoma yopilgan"), 400
    if choice is None or not 0 <= choice < len(json.loads(p["options"])):
        return jsonify(error="Variantni tanlang"), 400
    db.execute("INSERT INTO poll_votes2 (poll_id, user_id, choice) VALUES (?, ?, ?) "
               "ON CONFLICT(poll_id, user_id) DO UPDATE SET choice = excluded.choice", (pid, user["id"], choice))
    db.commit()
    return _polls_json(db, user)


@bp.post("/api/polls/<int:pid>/answer")
@login_required
def api_poll_answer(pid: int):
    """O'quvchi savolga yozma javob beradi (qayta yozsa — yangilanadi)."""
    user = current_user()
    if user["role"] != "user":
        return jsonify(error="Javobni o'quvchilar yozadi"), 400
    text = str((request.get_json(silent=True) or {}).get("text") or "").strip()[:1000]
    if not text:
        return jsonify(error="Javobni yozing"), 400
    db = get_db()
    p = db.execute("SELECT * FROM polls2 WHERE id = ?", (pid,)).fetchone()
    if p is None or not p["active"]:
        return jsonify(error="Savol yopilgan"), 400
    first = not db.execute("SELECT 1 FROM poll_answers WHERE poll_id = ? AND user_id = ?", (pid, user["id"])).fetchone()
    db.execute("INSERT INTO poll_answers (poll_id, user_id, text, at) VALUES (?, ?, ?, ?) "
               "ON CONFLICT(poll_id, user_id) DO UPDATE SET text = excluded.text, at = excluded.at",
               (pid, user["id"], text, time.time()))
    db.commit()
    if first:
        classroom.notify("owner", f"💬 {user['name']} javob yozdi: {text[:80]}", "/panel#polls")
    return _polls_json(db, user)


@bp.delete("/api/polls/<int:pid>")
@owner_required
def api_poll_delete(pid: int):
    db = get_db()
    db.execute("DELETE FROM polls2 WHERE id = ?", (pid,))
    db.commit()
    return _polls_json(db, current_user())


@bp.post("/api/polls/<int:pid>/close")
@owner_required
def api_poll_close(pid: int):
    db = get_db()
    db.execute("UPDATE polls2 SET active = 0 WHERE id = ?", (pid,))
    db.commit()
    return _polls_json(db, current_user())


# --------------------------------------------------------------------------- #
#  Sovg'alar do'koni: ballni sovg'aga almashtirish
# --------------------------------------------------------------------------- #
def _rewards_json(db, user):
    mine = set()  # ball beradigan sovg'ani har kim bir marta oladi
    if user["role"] == "user":
        mine = {r["reward_id"] for r in db.execute(
            "SELECT reward_id FROM reward_orders WHERE user_id = ? AND bonus > 0 AND status != 'cancelled'", (user["id"],))}
    rewards = [{"id": r["id"], "name": r["name"], "cost": r["cost"], "stock": r["stock"], "bonus": r["bonus"],
                "taken": r["id"] in mine}
               for r in db.execute("SELECT * FROM rewards WHERE active = 1 ORDER BY cost")]
    q = ("SELECT o.*, r.name AS rname, u.name AS uname FROM reward_orders o JOIN rewards r ON r.id = o.reward_id "
         "JOIN users u ON u.id = o.user_id ")
    rows = (db.execute(q + "ORDER BY o.id DESC LIMIT 50") if user["role"] == "owner"
            else db.execute(q + "WHERE o.user_id = ? ORDER BY o.id DESC LIMIT 20", (user["id"],)))
    orders = [{"id": r["id"], "reward": r["rname"], "user": r["uname"], "cost": r["cost"], "bonus": r["bonus"], "status": r["status"], "t": r["t"]}
              for r in rows]
    total = classroom.user_total(db, user["id"]) if user["role"] == "user" else None
    return jsonify(rewards=rewards, orders=orders, my_total=total)


@bp.get("/api/rewards")
@login_required
def api_rewards():
    return _rewards_json(get_db(), current_user())


@bp.post("/api/rewards")
@owner_required
def api_reward_add():
    data = request.get_json(silent=True) or {}
    name = _clean(data.get("name"), 80)
    cost, stock = _int(data.get("cost")), _int(data.get("stock"))
    bonus = _int(data.get("bonus") or 0)
    if bonus is None or not 0 <= bonus <= 1000:
        return jsonify(error="Beriladigan ball 0–1000 bo'lsin"), 400
    low = 0 if bonus else 1  # ball beradigan sovg'a bepul ham bo'lishi mumkin
    if not name or cost is None or not low <= cost <= 10000 or stock is None or not 0 <= stock <= 1000:
        return jsonify(error=f"Nomi, narxi ({low}–10000 ball) va soni (0–1000) kerak"), 400
    db = get_db()
    db.execute("INSERT INTO rewards (name, cost, stock, active, bonus) VALUES (?, ?, ?, 1, ?)", (name, cost, stock, bonus))
    db.commit()
    return _rewards_json(db, current_user())


@bp.delete("/api/rewards/<int:rid>")
@owner_required
def api_reward_delete(rid: int):
    db = get_db()
    db.execute("UPDATE rewards SET active = 0 WHERE id = ?", (rid,))
    db.commit()
    return _rewards_json(db, current_user())


@bp.post("/api/rewards/<int:rid>/redeem")
@login_required
def api_reward_redeem(rid: int):
    user = current_user()
    if user["role"] != "user":
        return jsonify(error="Faqat o'quvchilar oladi"), 400
    blocked = classroom.guard(user, "points")
    if blocked:
        return blocked
    db = get_db()
    r = db.execute("SELECT * FROM rewards WHERE id = ? AND active = 1", (rid,)).fetchone()
    if r is None:
        return jsonify(error="Bunday sovg'a yo'q"), 404
    if r["stock"] <= 0:
        return jsonify(error="Bu sovg'a tugagan"), 400
    if classroom.user_total(db, user["id"]) < r["cost"]:
        return jsonify(error="Ballingiz yetmaydi"), 400
    # Owner tasdig'i kerak emas: olindi — ball darhol yechiladi/beriladi. Ikki marta bosilsa ham bir marta o'tadi.
    db.commit()
    db.execute("BEGIN IMMEDIATE")
    try:
        if r["bonus"] and db.execute("SELECT 1 FROM reward_orders WHERE reward_id = ? AND user_id = ? AND status != 'cancelled'",
                                     (rid, user["id"])).fetchone():
            db.rollback()
            return jsonify(error="Bu sovg'ani allaqachon olgansiz"), 400
        if classroom.user_total(db, user["id"]) < r["cost"]:
            db.rollback()
            return jsonify(error="Ballingiz yetmaydi"), 400
        if not db.execute("UPDATE rewards SET stock = stock - 1 WHERE id = ? AND active = 1 AND stock > 0", (rid,)).rowcount:
            db.rollback()
            return jsonify(error="Bu sovg'a tugagan"), 400
        db.execute("UPDATE users SET score = score + ? WHERE id = ?", (r["bonus"] - r["cost"], user["id"]))
        db.execute("INSERT INTO reward_orders (reward_id, user_id, cost, status, t, bonus) VALUES (?, ?, ?, 'given', ?, ?)",
                   (rid, user["id"], r["cost"], time.time(), r["bonus"]))
        db.commit()
    except Exception:
        db.rollback()
        raise
    plus = f", +{r['bonus']} ball berildi" if r["bonus"] else ""
    classroom.notify("owner", f"🎁 {user['name']} «{r['name']}» sovg'asini oldi ({r['cost']} ball{plus})", "/panel#shop")
    return _rewards_json(db, user)


@bp.post("/api/orders/<int:oid>")
@owner_required
def api_order_status(oid: int):
    status = (request.get_json(silent=True) or {}).get("status")
    if status not in ("given", "cancelled"):
        return jsonify(error="?"), 400
    db = get_db()
    o = db.execute("SELECT * FROM reward_orders WHERE id = ?", (oid,)).fetchone()
    # given — faqat eski kutilayotganlar uchun; bekor qilish — istalgan payt
    if o is None or o["status"] == "cancelled" or (status == "given" and o["status"] != "pending"):
        return jsonify(error="Buyurtma topilmadi"), 400
    if not db.execute("UPDATE reward_orders SET status = ? WHERE id = ? AND status = ?", (status, oid, o["status"])).rowcount:
        return jsonify(error="Buyurtma topilmadi"), 400
    if status == "cancelled":  # ball va sovg'a qaytadi
        db.execute("UPDATE users SET score = score + ? WHERE id = ?", (o["cost"] - o["bonus"], o["user_id"]))
        db.execute("UPDATE rewards SET stock = stock + 1 WHERE id = ?", (o["reward_id"],))
    db.commit()
    classroom.notify(f"u{o['user_id']}", "🎁 Sovg'angiz topshirildi!" if status == "given" else "Sovg'a bekor qilindi — ballingiz qaytdi")
    return _rewards_json(db, current_user())


# --------------------------------------------------------------------------- #
#  Tug'ilgan kun
# --------------------------------------------------------------------------- #
BDAY_BONUS = 5


def _bday(value) -> str | None:
    m = re.fullmatch(r"(\d{2})-(\d{2})", str(value or ""))
    if not m:
        return None
    try:
        date(2000, int(m.group(1)), int(m.group(2)))
    except ValueError:
        return None
    return value


@bp.post("/api/birthday")
@login_required
def api_birthday_set():
    user = current_user()
    data = request.get_json(silent=True) or {}
    target = data.get("user_id") if user["role"] == "owner" else user.get("id")
    value = data.get("date")
    if value not in (None, "") and not _bday(value):
        return jsonify(error="Sana noto'g'ri (oy-kun)"), 400
    db = get_db()
    db.execute("UPDATE users SET birthday = ? WHERE id = ?", (value or None, _int(target)))
    db.commit()
    return jsonify(ok=True, birthday=value or None)


@bp.get("/api/birthdays/today")
@login_required
def api_birthdays_today():
    db = get_db()
    today = date.today()
    mmdd = today.strftime("%m-%d")
    year = str(today.year)
    rows = db.execute("SELECT id, name, avatar, bday_paid FROM users WHERE birthday = ?", (mmdd,)).fetchall()
    for r in rows:
        if r["bday_paid"] != year:  # yiliga bir marta: bonus va hammaga xabar
            db.execute("UPDATE users SET bday_paid = ?, score = score + ? WHERE id = ?", (year, BDAY_BONUS, r["id"]))
            db.commit()
            classroom.notify_all_users(f"🎂 Bugun {r['name']}ning tug'ilgan kuni! Tabriklang!", "/panel#games")
            classroom.notify(f"u{r['id']}", f"🎂 Tug'ilgan kuningiz bilan! Sovg'a: +{BDAY_BONUS} ball")
    return jsonify(people=[{"id": r["id"], "name": r["name"], "avatar": avatar_url(r["avatar"])} for r in rows])


# --------------------------------------------------------------------------- #
#  Profil uchun qo'shimcha: tug'ilgan kun, faollik, oy o'quvchisi
# --------------------------------------------------------------------------- #
@bp.get("/api/profile/<int:user_id>/extra")
@login_required
def api_profile_extra(user_id: int):
    user = current_user()
    if user["role"] != "owner":
        user_id = user["id"]
    db = get_db()
    u = db.execute("SELECT u.birthday, g.name AS gname, u.group_id FROM users u LEFT JOIN groups g ON g.id = u.group_id "
                   "WHERE u.id = ?", (user_id,)).fetchone()
    if u is None:
        return jsonify(error="Topilmadi"), 404
    ym = date.today().isoformat()[:7]
    prev = best_of(db, _prev_month(ym))
    return jsonify(birthday=u["birthday"], group=u["gname"], group_id=u["group_id"],
                   best=prev if prev and prev["id"] == user_id else None,
                   month_score=month_scores(db, ym).get(user_id, 0))


# --------------------------------------------------------------------------- #
#  Yutuqlar devori
# --------------------------------------------------------------------------- #
@bp.get("/api/wall")
@login_required
def api_wall():
    db = get_db()
    ym = date.today().isoformat()[:7]
    items = []
    prev = best_of(db, _prev_month(ym))
    if prev:
        items.append({"icon": "👑", "title": "O'tgan oyning eng yaxshi o'quvchisi", "name": prev["name"], "value": f"{prev['score']} ball"})
    cur = best_of(db, ym)
    if cur:
        items.append({"icon": "🔥", "title": "Shu oyning yetakchisi", "name": cur["name"], "value": f"{cur['score']} ball"})
    from core import RATING_SQL
    top = db.execute(RATING_SQL).fetchone()
    if top and top["total"] > 0:
        items.append({"icon": "🏆", "title": "Reytingda birinchi", "name": top["name"], "value": f"{top['total']} ball"})
    r = db.execute("SELECT u.name, COUNT(*) AS n FROM exam_attempts a JOIN users u ON u.id = a.user_id "
                   "WHERE a.score = 5 GROUP BY a.user_id ORDER BY n DESC LIMIT 1").fetchone()
    if r:
        items.append({"icon": "🎯", "title": "Eng ko'p 5/5 test", "name": r["name"], "value": f"{r['n']} marta"})
    r = db.execute("SELECT u.name, COUNT(*) AS n FROM submissions s JOIN users u ON u.id = s.user_id "
                   "WHERE s.score >= 5 GROUP BY s.user_id ORDER BY n DESC LIMIT 1").fetchone()
    if r:
        items.append({"icon": "📚", "title": "Eng ko'p a'lo uy vazifa", "name": r["name"], "value": f"{r['n']} ta"})
    r = db.execute("SELECT u.name, COUNT(*) AS n FROM attendance a JOIN users u ON u.id = a.user_id "
                   "WHERE a.status = 'keldi' GROUP BY a.user_id ORDER BY n DESC LIMIT 1").fetchone()
    if r:
        items.append({"icon": "✅", "title": "Eng ko'p darsga kelgan", "name": r["name"], "value": f"{r['n']} dars"})
    r = db.execute("SELECT player_key, COUNT(*) AS n FROM game_challenges GROUP BY player_key ORDER BY n DESC LIMIT 1").fetchone()
    if r and r["player_key"].startswith("u"):
        u = db.execute("SELECT name FROM users WHERE id = ?", (int(r["player_key"][1:]),)).fetchone()
        if u:
            items.append({"icon": "💻", "title": "Kod chellenji ustasi", "name": u["name"], "value": f"{r['n']} ta"})
    r = db.execute("SELECT p.player_key, p.money FROM game_players p WHERE p.player_key != 'owner' ORDER BY p.money DESC LIMIT 1").fetchone()
    if r and r["player_key"].startswith("u"):
        u = db.execute("SELECT name FROM users WHERE id = ?", (int(r["player_key"][1:]),)).fetchone()
        if u:
            items.append({"icon": "💰", "title": "O'yindagi eng boy", "name": u["name"], "value": f"{int(r['money']):,} so'm".replace(",", " ")})
    return jsonify(items=items)
