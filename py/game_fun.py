"""Mahalla — ishlar, o'yinlar va do'stlar.

Pochtachi va pitsa yetkazish, baliq ovlash, aksiya birjasi, metro, avtoyuvish, kinoteatr,
basketbol, parashyut, yashirinmachoq va quvlashmachoq, to'y, telefon (shaxsiy xabar),
do'stlar ro'yxati, emojilar va haftalik turnir.
"""
import json
import math
import random
import time
from datetime import datetime, timedelta, timezone

from flask import Blueprint, jsonify, request

import config
import game
import game_social as gs
from core import current_user, get_db, login_required

bp = Blueprint("game_fun", __name__)
TASHKENT = timezone(timedelta(hours=5))


def _me():
    return game.player_key(current_user())


def _near(key: str, x: float, y: float, dist: float, now: float | None = None):
    p = game._live_pos(key, now or time.time())
    return p if p and math.hypot(p["x"] - x, p["y"] - y) <= dist else None


def _pay(db, key: str, amount: float, cost: bool = False):
    """cost=True — puldan yechish (yetmasa GameError)."""
    def change(row, money):
        if cost and money < amount:
            raise game.GameError("Pul yetarli emas")
        return (-amount if cost else amount), None
    return game.apply_change(db, key, change)


def _econ(db, key: str) -> dict:
    return game.economy_json(db, gs._row(db, key))


def _gate(plot_id: int) -> dict:
    return game.plot_spawn(game.PLOTS[plot_id])


# --------------------------------------------------------------------------- #
#  Ishlar: pochtachi (3 ta posilka) va pitsa yetkazish (vaqt bilan, tez bo'lsa choychaqa)
# --------------------------------------------------------------------------- #
JOB_DIST = 120
POST_PARCELS = 3
_jobs: dict[str, dict] = {}


def _job_json(key: str, now: float) -> dict | None:
    j = _jobs.get(key)
    if not j:
        return None
    t = j["targets"][j["idx"]] if j["phase"] == "deliver" else j["pickup"]
    return {"kind": j["kind"], "phase": j["phase"], "x": t["x"], "y": t["y"], "left": len(j["targets"]) - j["idx"],
            "total": len(j["targets"]), "deadline": round(j["deadline"] - now, 1) if j.get("deadline") else None,
            "earned": j["earned"]}


@bp.post("/api/game/job/start")
@login_required
def api_job_start():
    key = _me()
    kind = (request.get_json(silent=True) or {}).get("kind")
    if kind not in ("post", "pizza", "build"):
        return jsonify(error="Qaysi ish?"), 400
    now = time.time()
    place = game.PLACES[{"post": "post", "pizza": "pizza", "build": "depot"}[kind]]["door"]
    with game._lock:
        if key in _jobs:
            return jsonify(error="Avval hozirgi ishni tugating"), 400
        n = 1 if kind == "pizza" else POST_PARCELS
        plots = random.sample(range(len(game.PLOTS)), n)
        if kind == "build":  # qurilish materiallarini boshqalarning binosiga olib borib qurib berasiz
            built = [r["plot"] for r in get_db().execute("SELECT plot FROM game_plots WHERE kind IS NOT NULL AND owner_key != ?", (key,))]
            if len(built) >= n:
                plots = random.sample(built, n)
        _jobs[key] = {"kind": kind, "phase": "pickup", "pickup": place, "targets": [_gate(i) for i in plots],
                      "idx": 0, "t": now, "deadline": None, "earned": 0}
        return jsonify(job=_job_json(key, now))


@bp.post("/api/game/job/step")
@login_required
def api_job_step():
    """Navbatdagi nuqtaga yetib keldi: posilka/pitsani olish yoki topshirish."""
    key = _me()
    now = time.time()
    pay = 0
    msg = ""
    with game._lock:
        j = _jobs.get(key)
        if not j:
            return jsonify(error="Sizda ish yo'q"), 400
        t = j["targets"][j["idx"]] if j["phase"] == "deliver" else j["pickup"]
        p = _near(key, t["x"], t["y"], JOB_DIST + 40, now)
        if not p:
            return jsonify(error="Hali yetib kelmadingiz"), 400
        if j["phase"] == "pickup":
            j["phase"] = "deliver"
            j["t"] = now
            if j["kind"] == "build":
                msg = "Qurilish materiallarini oldingiz — 3 ta binoga olib borib quring"
            elif j["kind"] == "pizza":
                d = abs(j["targets"][0]["x"] - t["x"]) + abs(j["targets"][0]["y"] - t["y"])
                j["deadline"] = now + max(25, d / (game.WALK_SPEED * 1.7) * 1.6)
                msg = "Pitsani oldingiz! Issiqligida yetkazing — vaqt ketdi"
            elif j["kind"] == "post":
                msg = f"{len(j['targets'])} ta posilkani oldingiz — manzillarga olib boring"
        else:
            prev = j["pickup"] if j["idx"] == 0 else j["targets"][j["idx"] - 1]
            dist = abs(t["x"] - prev["x"]) + abs(t["y"] - prev["y"])
            if j["kind"] == "post":
                pay = int(400 + dist * 0.5)
                msg = f"Posilka topshirildi: +{pay:,} so'm".replace(",", " ")
            elif j["kind"] == "build":
                pay = int(900 + dist * 0.5)
                msg = f"Qurilish ishi bajarildi: +{pay:,} so'm".replace(",", " ")
            else:
                base = int(600 + dist * 0.6)
                tip = int(base * 0.5) if now <= j["deadline"] else -int(base * 0.5)
                pay = base + tip
                msg = (f"Pitsa issiq yetdi! +{base:,} va choychaqa +{tip:,} so'm" if tip > 0
                       else f"Pitsa sovib qoldi... +{pay:,} so'm (choychaqasiz)").replace(",", " ")
            j["earned"] += pay
            j["idx"] += 1
            if j["idx"] >= len(j["targets"]):
                _jobs.pop(key, None)
                msg += " · Ish tugadi!"
        job = _job_json(key, now)
    db = get_db()
    if pay:
        _pay(db, key, pay)
    return jsonify(job=job, pay=pay, message=msg, economy=_econ(db, key))


@bp.post("/api/game/job/end")
@login_required
def api_job_end():
    with game._lock:
        _jobs.pop(_me(), None)
    return jsonify(ok=True)


# --------------------------------------------------------------------------- #
#  Baliq ovlash (ko'lda)
# --------------------------------------------------------------------------- #
FISH = [
    {"name": "Kumush karas", "kg": (0.3, 1.2), "price": 4000, "w": 40},
    {"name": "Zog'ora", "kg": (1.5, 5), "price": 3500, "w": 30},
    {"name": "Laqqa", "kg": (2, 9), "price": 3000, "w": 15},
    {"name": "Oq amur", "kg": (3, 12), "price": 2800, "w": 12},
    {"name": "Oltin baliq", "kg": (0.2, 0.5), "price": 150000, "w": 3},
]
_fish: dict[str, dict] = {}


def _near_pond(p) -> bool:
    pd = game.POND
    cx, cy = pd["x"] + pd["w"] / 2, pd["y"] + pd["h"] / 2
    k = math.hypot((p["x"] - cx) / (pd["w"] / 2), (p["y"] - cy) / (pd["h"] / 2))
    return 0.8 <= k <= 1.6


@bp.post("/api/game/fish/cast")
@login_required
def api_fish_cast():
    key = _me()
    now = time.time()
    with game._lock:
        p = game._live_pos(key, now)
        if not p or p["car"] or not _near_pond(p):
            return jsonify(error="Ko'l qirg'og'iga piyoda boring"), 400
        bite = now + random.uniform(3, 8)
        _fish[key] = {"bite": bite}
        return jsonify(bite_in=round(bite - now, 2))


@bp.post("/api/game/fish/pull")
@login_required
def api_fish_pull():
    key = _me()
    now = time.time()
    with game._lock:
        f = _fish.pop(key, None)
    if not f:
        return jsonify(error="Avval qarmoq tashlang"), 400
    if not f["bite"] - 0.3 <= now <= f["bite"] + 2.2:
        return jsonify(caught=None, message="Baliq qochib ketdi! Po'kak cho'kkanda torting")
    fish = random.choices(FISH, weights=[x["w"] for x in FISH])[0]
    kg = round(random.uniform(*fish["kg"]), 1)
    price = int(kg * fish["price"]) if fish["name"] != "Oltin baliq" else fish["price"]
    db = get_db()
    _pay(db, key, price)
    return jsonify(caught={"name": fish["name"], "kg": kg, "price": price}, economy=_econ(db, key))


# --------------------------------------------------------------------------- #
#  Aksiya birjasi (o'yin puli bilan)
# --------------------------------------------------------------------------- #
STOCKS = [
    {"sym": "UZUM", "name": "Uzum Market", "base": 1200, "vol": 0.22, "ph": 1.3},
    {"sym": "ARTL", "name": "Artel", "base": 800, "vol": 0.18, "ph": 2.1},
    {"sym": "TAXI", "name": "Mahalla Taksi", "base": 300, "vol": 0.3, "ph": 0.4},
    {"sym": "KOD", "name": "Kod Akademiya", "base": 450, "vol": 0.26, "ph": 3.7},
    {"sym": "OSH", "name": "Oltin Qozon", "base": 150, "vol": 0.35, "ph": 5.2},
]
STOCKS_BY = {s["sym"]: s for s in STOCKS}
MAX_SHARES = 10 ** 7


def stock_price(sym: str, minute: int) -> int:
    """Narx vaqtga bog'liq (har daqiqada o'zgaradi), hamma uchun bir xil."""
    s = STOCKS_BY[sym]
    noise = math.sin(minute * 12.9898 + s["ph"] * 7.13) * 43758.5453 % 1 - 0.5
    k = 1 + s["vol"] * (0.7 * math.sin(minute / 23 + s["ph"]) + 0.4 * math.sin(minute / 7 + s["ph"] * 2) + 0.3 * noise)
    return max(1, int(s["base"] * k))


def _holdings(row) -> dict:
    try:
        h = json.loads(row["stocks"] or "{}")
    except ValueError:
        h = {}
    return h if isinstance(h, dict) else {}


def _stocks_json(db, key: str):
    minute = int(time.time() // 60)
    row = gs._row(db, key)
    hold = _holdings(row)
    out = []
    for s in STOCKS:
        hist = [stock_price(s["sym"], m) for m in range(minute - 29, minute + 1)]
        h = hold.get(s["sym"], {"qty": 0, "cost": 0})
        out.append({"sym": s["sym"], "name": s["name"], "price": hist[-1], "prev": hist[-2], "history": hist,
                    "qty": h["qty"], "cost": h["cost"]})
    return jsonify(stocks=out, next_in=60 - int(time.time() % 60), economy=game.economy_json(db, row))


@bp.get("/api/game/stocks")
@login_required
def api_stocks():
    key = _me()
    db = get_db()
    game.ensure_player(db, key)
    return _stocks_json(db, key)


@bp.post("/api/game/stocks")
@login_required
def api_stocks_trade():
    key = _me()
    data = request.get_json(silent=True) or {}
    sym, action, qty = data.get("sym"), data.get("action"), data.get("qty")
    if sym not in STOCKS_BY or action not in ("buy", "sell"):
        return jsonify(error="Noto'g'ri so'rov"), 400
    if isinstance(qty, bool) or not isinstance(qty, int) or not 1 <= qty <= MAX_SHARES:
        return jsonify(error="Nechta aksiya? (butun son)"), 400
    db = get_db()
    game.ensure_player(db, key)
    price = stock_price(sym, int(time.time() // 60))

    def change(row, money):
        hold = _holdings(row)
        h = hold.get(sym, {"qty": 0, "cost": 0})
        if action == "buy":
            total = price * qty
            if money < total:
                raise game.GameError("Pul yetarli emas")
            if h["qty"] + qty > MAX_SHARES:
                raise game.GameError("Juda ko'p aksiya")
            h = {"qty": h["qty"] + qty, "cost": h["cost"] + total}
            delta = -total
        else:
            if h["qty"] < qty:
                raise game.GameError("Sizda buncha aksiya yo'q")
            avg = h["cost"] / h["qty"] if h["qty"] else 0
            h = {"qty": h["qty"] - qty, "cost": max(0, h["cost"] - int(avg * qty))}
            delta = price * qty
        hold[sym] = h
        if not h["qty"]:
            hold.pop(sym)
        return delta, lambda: db.execute("UPDATE game_players SET stocks = ? WHERE player_key = ?", (json.dumps(hold), key))

    _, err = gs._change(db, key, change)
    return err or _stocks_json(db, key)


# --------------------------------------------------------------------------- #
#  Metro, avtoyuvish, kinoteatr, basketbol
# --------------------------------------------------------------------------- #
METRO_PRICE = 500
WASH_PRICE = 2000
CINEMA_PRICE = 1000
HOOP_REWARD = 500
HOOP_COOLDOWN = 2.0
_hoop_at: dict[str, float] = {}


@bp.post("/api/game/metro")
@login_required
def api_metro():
    key = _me()
    to = (request.get_json(silent=True) or {}).get("to")
    if not isinstance(to, int) or isinstance(to, bool) or not 0 <= to < len(game.METRO):
        return jsonify(error="Bekatni tanlang"), 400
    now = time.time()
    with game._lock:
        here = next((m for m in game.METRO if _near(key, m["x"], m["y"], 110, now)), None)
        if here is None:
            return jsonify(error="Metro bekatiga boring"), 400
        if here["id"] == to:
            return jsonify(error="Siz shu bekatdasiz"), 400
    db = get_db()
    try:
        _pay(db, key, METRO_PRICE, cost=True)
    except game.GameError as err:
        return jsonify(error=str(err)), 400
    dest = game.METRO[to]
    with game._lock:
        game._teleports[key] = (dest["x"], dest["y"] + 40, math.pi / 2)
        if key in game._live:
            game._live[key].update(x=dest["x"], y=dest["y"] + 40, car=None)
    return jsonify(to=dest, economy=_econ(db, key))


@bp.post("/api/game/wash")
@login_required
def api_wash():
    key = _me()
    door = game.PLACES["wash"]["door"]
    p = _near(key, door["x"], door["y"], 150)
    if not p or not p["car"]:
        return jsonify(error="Mashinada avtoyuvishga kiring"), 400
    db = get_db()
    try:
        _pay(db, key, WASH_PRICE, cost=True)
    except game.GameError as err:
        return jsonify(error=str(err)), 400
    return jsonify(ok=True, economy=_econ(db, key))


@bp.post("/api/game/cinema")
@login_required
def api_cinema():
    key = _me()
    door = game.PLACES["cinema"]["door"]
    if not _near(key, door["x"], door["y"], 140):
        return jsonify(error="Kinoteatr eshigiga boring"), 400
    db = get_db()
    try:
        _pay(db, key, CINEMA_PRICE, cost=True)
    except game.GameError as err:
        return jsonify(error=str(err)), 400
    return jsonify(ok=True, economy=_econ(db, key))


@bp.post("/api/game/hoop")
@login_required
def api_hoop():
    key = _me()
    good = (request.get_json(silent=True) or {}).get("good") is True
    spot = game.PLACES["court"]["spot"]
    p = _near(key, spot["x"], spot["y"], 90)
    if not p or p["car"]:
        return jsonify(error="Basketbol maydonidagi chiziqqa piyoda turing"), 400
    now = time.time()
    if now - _hoop_at.get(key, 0) < HOOP_COOLDOWN:
        return jsonify(error="Sekinroq"), 429
    _hoop_at[key] = now
    db = get_db()
    if good:
        _pay(db, key, HOOP_REWARD)
    return jsonify(good=good, reward=HOOP_REWARD if good else 0, economy=_econ(db, key))


# --------------------------------------------------------------------------- #
#  Parashyut: samolyotdan sakrab, futbol maydonidagi nishonga qo'nish
# --------------------------------------------------------------------------- #
PARA_REWARD = 5000
PARA_RADIUS = 140
_para_land: dict[str, float] = {}


def para_target() -> dict:
    f = game.FIELD
    return {"x": f["x"] + f["w"] / 2, "y": f["y"] + f["h"] / 2, "r": PARA_RADIUS}


@bp.post("/api/game/para/land")
@login_required
def api_para_land():
    key = _me()
    now = time.time()
    t = para_target()
    with game._lock:
        jumped = _para_seen.get(key, 0)
        p = game._live_pos(key, now)
        if not jumped or now - jumped > 180:
            return jsonify(error="Avval samolyotdan parashyut bilan sakrang"), 400
        _para_seen.pop(key, None)
        hit = bool(p and p.get("h", 0) < 5 and math.hypot(p["x"] - t["x"], p["y"] - t["y"]) <= PARA_RADIUS)
    db = get_db()
    if hit:
        _pay(db, key, PARA_REWARD)
    return jsonify(hit=hit, reward=PARA_REWARD if hit else 0, economy=_econ(db, key))


_para_seen: dict[str, float] = {}


# --------------------------------------------------------------------------- #
#  Emojilar
# --------------------------------------------------------------------------- #
EMOJIS = ["😂", "👍", "🔥", "❤️", "😮", "😎", "👋", "🎉"]


@bp.post("/api/game/emote")
@login_required
def api_emote():
    key = _me()
    e = (request.get_json(silent=True) or {}).get("e")
    if e not in EMOJIS:
        return jsonify(error="Noto'g'ri emoji"), 400
    with game._lock:
        if key in game._live:
            game._live[key]["emote"] = {"e": e, "t": time.time()}
    return jsonify(ok=True)


# --------------------------------------------------------------------------- #
#  Do'stlar va telefon (shaxsiy xabarlar)
# --------------------------------------------------------------------------- #
PM_MAX = 300


def _friend_rows(db, key: str):
    return db.execute("SELECT * FROM game_friends WHERE a = ? OR b = ?", (key, key)).fetchall()


def _friends_json(db, key: str):
    people = gs._people(db)
    now = time.time()
    with game._lock:
        online = {k for k, p in game._live.items() if now - p["t"] < game.ONLINE_SECONDS}
    friends, incoming, outgoing = [], [], []
    for r in _friend_rows(db, key):
        other = r["b"] if r["a"] == key else r["a"]
        if other not in people:
            continue
        item = {"key": other, "name": people[other]["name"], "avatar": people[other]["avatar"], "online": other in online}
        if r["status"] == "ok":
            friends.append(item)
        elif r["a"] == key:
            outgoing.append(item)
        else:
            incoming.append(item)
    friends.sort(key=lambda f: (not f["online"], f["name"].lower()))
    last = db.execute("SELECT MAX(id) FROM game_pm WHERE b = ?", (key,)).fetchone()[0] or 0
    return jsonify(friends=friends, incoming=incoming, outgoing=outgoing, pm_last=last)


@bp.get("/api/game/friends")
@login_required
def api_friends():
    key = _me()
    db = get_db()
    game.ensure_player(db, key)
    return _friends_json(db, key)


@bp.post("/api/game/friends/<action>")
@login_required
def api_friends_action(action: str):
    user = current_user()
    key = game.player_key(user)
    other = (request.get_json(silent=True) or {}).get("key")
    db = get_db()
    if not isinstance(other, str) or other == key or other not in gs._people(db):
        return jsonify(error="Bunday odam yo'q"), 404
    row = db.execute("SELECT * FROM game_friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)",
                     (key, other, other, key)).fetchone()
    if action == "request":
        if row and row["status"] == "ok":
            return jsonify(error="Siz allaqachon do'stsiz"), 400
        if row and row["a"] == other:  # u ham so'rov yuborgan ekan — darhol do'st
            db.execute("UPDATE game_friends SET status = 'ok' WHERE a = ? AND b = ?", (other, key))
        elif not row:
            db.execute("INSERT INTO game_friends (a, b, status, created_at) VALUES (?, ?, 'pending', ?)", (key, other, time.time()))
            gs._notify(other, f"{user['name']} sizni do'stlikka qo'shmoqchi — Telefon → Do'stlar")
    elif action == "accept":
        if not row or row["a"] != other or row["status"] != "pending":
            return jsonify(error="So'rov topilmadi"), 400
        db.execute("UPDATE game_friends SET status = 'ok' WHERE a = ? AND b = ?", (other, key))
        gs._notify(other, f"{user['name']} do'stlik so'rovingizni qabul qildi!")
    elif action == "remove":
        db.execute("DELETE FROM game_friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)", (key, other, other, key))
    else:
        return jsonify(error="Noma'lum amal"), 400
    db.commit()
    return _friends_json(db, key)


@bp.get("/api/game/pm/<other>")
@login_required
def api_pm_thread(other: str):
    key = _me()
    db = get_db()
    rows = db.execute("SELECT * FROM game_pm WHERE (a = ? AND b = ?) OR (a = ? AND b = ?) ORDER BY id DESC LIMIT 50",
                      (key, other, other, key)).fetchall()
    return jsonify(messages=[{"id": r["id"], "me": r["a"] == key, "text": r["text"], "t": r["t"]} for r in reversed(rows)])


@bp.post("/api/game/pm")
@login_required
def api_pm_send():
    user = current_user()
    key = game.player_key(user)
    data = request.get_json(silent=True) or {}
    to = data.get("to")
    text = " ".join(str(data.get("text") or "").split())[:PM_MAX]
    db = get_db()
    if not isinstance(to, str) or to == key or to not in gs._people(db):
        return jsonify(error="Kimga yozasiz?"), 400
    if not text:
        return jsonify(error="Xabar bo'sh"), 400
    cur = db.execute("INSERT INTO game_pm (a, b, text, t) VALUES (?, ?, ?, ?)", (key, to, text, time.time()))
    db.commit()
    return jsonify(message={"id": cur.lastrowid, "me": True, "text": text, "t": time.time()})


# --------------------------------------------------------------------------- #
#  To'y
# --------------------------------------------------------------------------- #
WEDDING_MINUTES = 5
WEDDING_GIFT = 20000       # mahalladan yosh oilaga
WEDDING_TREAT = 2000       # to'yga kelgan har bir mehmonga "to'y oshi"
WEDDING_RADIUS = 260
_proposals: dict[str, dict] = {}
_weddings: list[dict] = []


@bp.post("/api/game/wedding/propose")
@login_required
def api_wedding_propose():
    user = current_user()
    key = game.player_key(user)
    to = (request.get_json(silent=True) or {}).get("to")
    db = get_db()
    people = gs._people(db)
    if not isinstance(to, str) or to == key or to not in people:
        return jsonify(error="Kimga?"), 400
    me_row = game.ensure_player(db, key)
    other = game.ensure_player(db, to)
    if me_row["spouse"] or other["spouse"]:
        return jsonify(error="Kimdir allaqachon turmush qurgan"), 400
    with game._lock:
        _proposals[to] = {"from": key, "name": user["name"], "t": time.time()}
    gs._notify(to, f"{user['name']} sizga to'y taklif qildi! 💍")
    return jsonify(ok=True, to=people[to]["name"])


@bp.post("/api/game/wedding/<answer>")
@login_required
def api_wedding_answer(answer: str):
    user = current_user()
    key = game.player_key(user)
    with game._lock:
        prop = _proposals.pop(key, None)
    if not prop or time.time() - prop["t"] > 600:
        return jsonify(error="Taklif topilmadi"), 400
    if answer == "decline":
        gs._notify(prop["from"], f"{user['name']} to'y taklifingizga rozi bo'lmadi")
        return jsonify(ok=True)
    if answer != "accept":
        return jsonify(error="?"), 400
    db = get_db()
    a, b = prop["from"], key
    if gs._row(db, a)["spouse"] or gs._row(db, b)["spouse"]:
        return jsonify(error="Kimdir allaqachon turmush qurgan"), 400
    db.execute("UPDATE game_players SET spouse = ? WHERE player_key = ?", (b, a))
    db.execute("UPDATE game_players SET spouse = ? WHERE player_key = ?", (a, b))
    db.commit()
    for k in (a, b):
        _pay(db, k, WEDDING_GIFT)
    f = game.FOUNTAIN
    now = time.time()
    with game._lock:
        _weddings.append({"names": f"{prop['name']} va {user['name']}", "couple": {a, b}, "x": f["x"] + f["w"] / 2,
                          "y": f["y"] + f["h"] + 60, "ends": now + WEDDING_MINUTES * 60, "guests": set()})
        game._chat.append({"id": next(game._msg_ids), "key": "owner", "name": "💍 To'y", "avatar": None, "t": now,
                           "text": f"{prop['name']} va {user['name']} to'yi! Favvora yoniga keling — "
                                   f"har bir mehmonga to'y oshi ({WEDDING_TREAT:,} so'm)!".replace(",", " ")})
    gs._notify(a, f"{user['name']} rozi bo'ldi! To'y boshlandi — favvora yoniga boring 💍")
    return jsonify(ok=True, economy=_econ(db, key))


@bp.post("/api/game/divorce")
@login_required
def api_divorce():
    key = _me()
    db = get_db()
    row = game.ensure_player(db, key)
    if not row["spouse"]:
        return jsonify(error="Siz turmush qurmagansiz"), 400
    db.execute("UPDATE game_players SET spouse = NULL WHERE player_key IN (?, ?)", (key, row["spouse"]))
    db.commit()
    gs._notify(row["spouse"], "Turmush o'rtog'ingiz ajrashdi 💔")
    return jsonify(ok=True)


# --------------------------------------------------------------------------- #
#  Yashirinmachoq va quvlashmachoq (bitta vaqtda bitta o'yin)
# --------------------------------------------------------------------------- #
MG_LOBBY = 20
MG_HIDE = 25
MG_PLAY = {"hide": 150, "tag": 150}
MG_CATCH = 45
MG_SHOW = 10
MG_PRIZE = {"found": 3000, "hider": 8000, "runner": 5000}
_mg: dict = {}


@bp.post("/api/game/mg/start")
@login_required
def api_mg_start():
    user = current_user()
    key = game.player_key(user)
    kind = (request.get_json(silent=True) or {}).get("type")
    if kind not in ("hide", "tag"):
        return jsonify(error="Qaysi o'yin?"), 400
    now = time.time()
    with game._lock:
        if _mg and _mg["phase"] != "done":
            return jsonify(error="Hozir boshqa o'yin ketyapti"), 400
        _mg.clear()
        _mg.update(id=int(now * 1000), type=kind, phase="lobby", host=key, players={key: user["name"]},
                   phase_ends=now + MG_LOBBY, found=[], it=None, last_tag=0, prev_it=None, results=None)
        title = "Yashirinmachoq" if kind == "hide" else "Quvlashmachoq"
        game._chat.append({"id": next(game._msg_ids), "key": "owner", "name": "🎮 O'yin", "avatar": None, "t": now,
                           "text": f"{user['name']} {title} boshlayapti! {MG_LOBBY} soniya ichida qo'shiling (ekrandagi kartada)"})
        return jsonify(mg=_mg_json(key, now))


@bp.post("/api/game/mg/join")
@login_required
def api_mg_join():
    user = current_user()
    key = game.player_key(user)
    now = time.time()
    with game._lock:
        if not _mg or _mg["phase"] != "lobby":
            return jsonify(error="Qo'shilish vaqti o'tdi"), 400
        _mg["players"][key] = user["name"]
        return jsonify(mg=_mg_json(key, now))


@bp.post("/api/game/mg/leave")
@login_required
def api_mg_leave():
    key = _me()
    with game._lock:
        if _mg and key in _mg["players"] and _mg["phase"] != "done":
            _mg["players"].pop(key)
            if key in (_mg.get("it"), _mg.get("seeker")) or len(_mg["players"]) < 2:
                _mg_finish(time.time(), cancelled=True)
    return jsonify(ok=True)


def _notify_nolock(key: str, text: str) -> None:
    """game._lock allaqachon olingan joyda xabar qo'shish."""
    inbox = game._gifts.setdefault(key, [])
    inbox.append({"text": text})
    del inbox[:-20]


def _mg_finish(now: float, cancelled: bool = False) -> None:
    """O'yin tugadi: natija va mukofotlar (lock ichida). Pul keyin hook'da beriladi."""
    pay = {}
    if not cancelled:
        if _mg["type"] == "hide":
            seeker = _mg["seeker"]
            pay[seeker] = MG_PRIZE["found"] * len(_mg["found"])
            for k in _mg["players"]:
                if k != seeker and k not in _mg["found"]:
                    pay[k] = MG_PRIZE["hider"]
        else:
            for k in _mg["players"]:
                if k != _mg["it"]:
                    pay[k] = MG_PRIZE["runner"]
    _mg.update(phase="done", phase_ends=now + MG_SHOW, results=pay, cancelled=cancelled, paid=set())


def _mg_tick(now: float) -> None:
    if not _mg:
        return
    if _mg["phase"] == "lobby" and now >= _mg["phase_ends"]:
        if len(_mg["players"]) < 2:
            _mg_finish(now, cancelled=True)
            return
        keys = list(_mg["players"])
        if _mg["type"] == "hide":
            _mg.update(phase="hiding", seeker=_mg["host"], phase_ends=now + MG_HIDE)
        else:
            _mg.update(phase="play", it=random.choice(keys), last_tag=now, phase_ends=now + MG_PLAY["tag"])
    elif _mg["phase"] == "hiding" and now >= _mg["phase_ends"]:
        _mg.update(phase="play", phase_ends=now + MG_PLAY["hide"])
    elif _mg["phase"] == "play":
        live = {k: game._live_pos(k, now) for k in _mg["players"]}
        if _mg["type"] == "hide":
            s = live.get(_mg["seeker"])
            if s:
                for k, p in live.items():
                    if k != _mg["seeker"] and k not in _mg["found"] and p and math.hypot(p["x"] - s["x"], p["y"] - s["y"]) < MG_CATCH:
                        _mg["found"].append(k)
                        _notify_nolock(k, f"{_mg['players'][_mg['seeker']]} sizni topdi!")
            if len(_mg["found"]) >= len(_mg["players"]) - 1:
                _mg_finish(now)
                return
        else:
            it = live.get(_mg["it"])
            if it and now - _mg["last_tag"] > 2:
                for k, p in live.items():
                    if k in (_mg["it"], _mg.get("prev_it")) or not p:
                        continue
                    if math.hypot(p["x"] - it["x"], p["y"] - it["y"]) < MG_CATCH:
                        _mg.update(prev_it=_mg["it"], it=k, last_tag=now)
                        break
            if now - _mg["last_tag"] > 3:
                _mg["prev_it"] = None
        if now >= _mg["phase_ends"]:
            _mg_finish(now)
    elif _mg["phase"] == "done" and now >= _mg["phase_ends"]:
        _mg.clear()


def _mg_json(key: str, now: float) -> dict | None:
    if not _mg:
        return None
    role = None
    if key in _mg["players"]:
        if _mg["type"] == "hide":
            role = "seeker" if key == _mg.get("seeker") else ("found" if key in _mg["found"] else "hider")
        else:
            role = "it" if key == _mg.get("it") else "runner"
    return {"id": _mg["id"], "type": _mg["type"], "phase": _mg["phase"], "left": max(0, round(_mg["phase_ends"] - now)),
            "players": len(_mg["players"]), "joined": key in _mg["players"], "role": role, "host": _mg["players"].get(_mg["host"]),
            "seeker": _mg.get("seeker"), "it": _mg.get("it"), "it_name": _mg["players"].get(_mg.get("it"), ""),
            "found": list(_mg["found"]), "keys": list(_mg["players"]),
            "result": (_mg["results"] or {}).get(key) if _mg["phase"] == "done" else None,
            "cancelled": _mg.get("cancelled", False)}


# --------------------------------------------------------------------------- #
#  Haftalik turnir: hafta davomida eng ko'p boyigan 3 kishi mukofot oladi
# --------------------------------------------------------------------------- #
WEEK_PRIZES = [500000, 250000, 100000]


def week_id(dt: datetime | None = None) -> str:
    dt = dt or datetime.now(TASHKENT)
    y, w, _ = dt.isocalendar()
    return f"{y}-W{w:02d}"


def _week_scores(db, wk: str, now: float) -> list:
    people = gs._people(db)
    rows = db.execute("SELECT * FROM game_players WHERE week_id = ? AND player_key != 'owner'", (wk,)).fetchall()
    out = []
    for r in rows:
        if r["player_key"] in people:
            w = gs.wealth_of(db, r, now)["wealth"]
            out.append({"key": r["player_key"], "name": people[r["player_key"]]["name"],
                        "avatar": people[r["player_key"]]["avatar"], "score": int(w - (r["week_start"] if r["week_start"] is not None else w))})
    out.sort(key=lambda x: -x["score"])
    return out


def _tournament_tick(db, key: str, row, now: float) -> None:
    """Yangi hafta: o'tgan hafta g'oliblarini mukofotlash; o'yinchining hafta boshidagi boyligini yozish."""
    wk = week_id()
    if key == "owner":  # owner turnirda qatnashmaydi (puli cheksiz)
        return
    if row["week_id"] != wk:
        prev = row["week_id"]
        if prev and not db.execute("SELECT 1 FROM game_weekly WHERE week = ?", (prev,)).fetchone():
            winners = [s for s in _week_scores(db, prev, now) if s["score"] > 0][:3]
            try:
                db.execute("INSERT INTO game_weekly (week, paid_at, winners) VALUES (?, ?, ?)",
                           (prev, now, json.dumps([w["key"] for w in winners])))
                db.commit()
                for i, w in enumerate(winners):
                    gs.add_money(db, w["key"], WEEK_PRIZES[i])
                    gs._notify(w["key"], f"Haftalik turnirda {i + 1}-o'rin! +{WEEK_PRIZES[i]:,} so'm 🏆".replace(",", " "))
            except Exception:  # boshqa so'rov allaqachon to'lagan
                db.rollback()
        wealth = gs.wealth_of(db, row, now)["wealth"]
        db.execute("UPDATE game_players SET week_id = ?, week_start = ? WHERE player_key = ?", (wk, float(wealth), key))
        db.commit()


@bp.get("/api/game/tournament")
@login_required
def api_tournament():
    key = _me()
    db = get_db()
    row = game.ensure_player(db, key)
    now = time.time()
    _tournament_tick(db, key, row, now)
    scores = _week_scores(db, week_id(), now)
    for i, s in enumerate(scores):
        s["place"] = i + 1
        s["me"] = s["key"] == key
    nowdt = datetime.now(TASHKENT)
    end = (nowdt - timedelta(days=nowdt.weekday())).replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=7)
    mine = next((s for s in scores if s["me"]), None)
    return jsonify(top=scores[:10], me=mine, prizes=WEEK_PRIZES, left=int((end - nowdt).total_seconds()), week=week_id())


# --------------------------------------------------------------------------- #
#  Sinxron: ishlar, o'yin, to'y, takliflar, xabarlar
# --------------------------------------------------------------------------- #
_tour_at: dict[str, float] = {}


def _fun_hook(db, key: str, row, now: float, response: dict) -> None:
    pay = {}
    with game._lock:
        response["job"] = _job_json(key, now)
        _mg_tick(now)
        mg = _mg_json(key, now)
        if _mg and _mg["phase"] == "done" and key in _mg["results"] and key not in _mg["paid"]:
            _mg["paid"].add(key)
            pay[key] = _mg["results"][key]
        response["mg"] = mg
        prop = _proposals.get(key)
        response["proposal"] = {"from": prop["from"], "name": prop["name"]} if prop and now - prop["t"] < 600 else None
        weds = []
        for w in list(_weddings):
            if now > w["ends"]:
                _weddings.remove(w)
                continue
            me = game._live.get(key)
            treat = False
            if me and key not in w["couple"] and key not in w["guests"] and math.hypot(me["x"] - w["x"], me["y"] - w["y"]) < WEDDING_RADIUS:
                w["guests"].add(key)
                pay[key] = pay.get(key, 0) + WEDDING_TREAT
                treat = True
            weds.append({"names": w["names"], "x": w["x"], "y": w["y"], "left": round(w["ends"] - now), "treat": treat})
        response["weddings"] = weds
        # Parashyut: samolyotdan sakraganini eslab qolamiz
        p = game._live.get(key)
        if p and p.get("para"):
            _para_seen.setdefault(key, now)
    since = request.get_json(silent=True) or {}
    pm_since = since.get("pm_since")
    if isinstance(pm_since, int) and not isinstance(pm_since, bool):
        people = None
        rows = db.execute("SELECT * FROM game_pm WHERE b = ? AND id > ? ORDER BY id LIMIT 20", (key, pm_since)).fetchall()
        if rows:
            people = gs._people(db)
            response["pm"] = [{"id": r["id"], "from": r["a"], "name": people.get(r["a"], {}).get("name", "?"),
                               "text": r["text"]} for r in rows]
    for k, amount in pay.items():
        if amount:
            gs.add_money(db, k, amount)
    if pay.get(key):
        response["economy"] = _econ(db, key)
        response["fun_paid"] = pay[key]
    if now - _tour_at.get(key, 0) > 60:
        _tour_at[key] = now
        _tournament_tick(db, key, row, now)


def _forget(db, key: str) -> None:
    with game._lock:
        _jobs.pop(key, None)
        _fish.pop(key, None)
        _proposals.pop(key, None)
        if _mg and key in _mg.get("players", {}):
            _mg["players"].pop(key)
    db.execute("DELETE FROM game_friends WHERE a = ? OR b = ?", (key, key))
    db.execute("UPDATE game_players SET spouse = NULL WHERE spouse = ?", (key,))


game.SYNC_HOOKS.append(_fun_hook)
game.FORGET_HOOKS.append(_forget)


# --------------------------------------------------------------------------- #
#  Uy hayvoni
# --------------------------------------------------------------------------- #
PETS = {"dog": 20000, "cat": 15000, "parrot": 25000}


@bp.post("/api/game/pet")
@login_required
def api_pet():
    key = _me()
    kind = (request.get_json(silent=True) or {}).get("kind")
    if kind not in PETS and kind != "":
        return jsonify(error="Qaysi hayvon?"), 400
    db = get_db()
    game.ensure_player(db, key)

    def change(row, money):
        if kind and row["pet"] == kind:
            raise game.GameError("Bu hayvon sizda bor")
        price = PETS.get(kind, 0)
        if money < price:
            raise game.GameError("Pul yetarli emas")
        return -price, lambda: db.execute("UPDATE game_players SET pet = ? WHERE player_key = ?", (kind or None, key))

    _, err = gs._change(db, key, change)
    return err or jsonify(pet=kind or None, prices=PETS, economy=_econ(db, key))


@bp.get("/api/game/pet")
@login_required
def api_pet_state():
    key = _me()
    db = get_db()
    row = game.ensure_player(db, key)
    return jsonify(pet=row["pet"], prices=PETS)


# --------------------------------------------------------------------------- #
#  Konsert sahnasi: sahnaga chiqing, tomoshabinlar qarsak chalsa — pul
# --------------------------------------------------------------------------- #
STAGE_TIME = 180
CLAP_PAY = 200
CLAP_COOLDOWN = 3
_stage: dict = {}
_clap_at: dict[str, float] = {}


def _stage_json(key: str, now: float) -> dict | None:
    if not _stage or now - _stage["since"] > STAGE_TIME:
        _stage.clear()
        return None
    return {"key": _stage["key"], "name": _stage["name"], "claps": _stage["claps"], "earned": _stage["earned"],
            "left": round(STAGE_TIME - (now - _stage["since"])), "me": _stage["key"] == key}


@bp.post("/api/game/stage/up")
@login_required
def api_stage_up():
    user = current_user()
    key = game.player_key(user)
    spot = game.PLACES["stage"]["spot"]
    now = time.time()
    with game._lock:
        if not _near(key, spot["x"], spot["y"], 90, now):
            return jsonify(error="Sahnaga yaqin boring"), 400
        cur = _stage_json(key, now)
        if cur and not cur["me"]:
            return jsonify(error=f"Sahnada {cur['name']} chiqyapti — navbat kuting"), 400
        _stage.update(key=key, name=user["name"], since=now, claps=0, earned=0)
        game._chat.append({"id": next(game._msg_ids), "key": "owner", "name": "🎤 Sahna", "avatar": None, "t": now,
                           "text": f"{user['name']} sahnaga chiqdi! Bog'dagi sahnaga keling va qarsak chaling 👏"})
        return jsonify(stage=_stage_json(key, now))


@bp.post("/api/game/stage/down")
@login_required
def api_stage_down():
    key = _me()
    with game._lock:
        if _stage.get("key") == key:
            _stage.clear()
    return jsonify(ok=True)


@bp.post("/api/game/stage/clap")
@login_required
def api_stage_clap():
    key = _me()
    now = time.time()
    spot = game.PLACES["stage"]["spot"]
    with game._lock:
        st = _stage_json(key, now)
        if not st:
            return jsonify(error="Sahnada hech kim yo'q"), 400
        if st["me"]:
            return jsonify(error="O'zingizga qarsak chalib bo'lmaydi"), 400
        if not _near(key, spot["x"], spot["y"], 650, now):
            return jsonify(error="Sahnaga yaqinroq keling"), 400
        if now - _clap_at.get(key, 0) < CLAP_COOLDOWN:
            return jsonify(error="Sekinroq 🙂"), 429
        _clap_at[key] = now
        _stage["claps"] += 1
        _stage["earned"] += CLAP_PAY
        performer = _stage["key"]
        if key in game._live:
            game._live[key]["emote"] = {"e": "👏", "t": now}
    gs.add_money(get_db(), performer, CLAP_PAY)
    return jsonify(ok=True)


def _stage_hook(db, key: str, row, now: float, response: dict) -> None:
    with game._lock:
        response["stage"] = _stage_json(key, now)


# --------------------------------------------------------------------------- #
#  Guruh chati: klan a'zolari yoki do'stlar
# --------------------------------------------------------------------------- #
def chat_audience(key: str, channel: str) -> list:
    db = get_db()
    if channel == "clan":
        row = gs._row(db, key)
        if not row or not row["clan"]:
            return []
        return [r["player_key"] for r in db.execute("SELECT player_key FROM game_players WHERE clan = ? AND player_key != ?", (row["clan"], key))]
    rows = db.execute("SELECT a, b FROM game_friends WHERE status = 'ok' AND (a = ? OR b = ?)", (key, key)).fetchall()
    return [r["b"] if r["a"] == key else r["a"] for r in rows]


game.SYNC_HOOKS.append(_stage_hook)
game.CHAT_AUDIENCE = chat_audience
