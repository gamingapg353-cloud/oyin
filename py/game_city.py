"""Mahalla — shahar hayoti: maktab, kutubxona, ustaxonalar (tikuvchi, sartarosh, avtomexanik,
novvoy, muzqaymoq, gul do'koni), bozor rastasi, pochta qutisi, uy ijarasi, sarmoya, reklama
taxtasi, dron kuryer, bayroqni olish, labirint, velosiped va qayiq poygalari, klanlar futbol
kubogi, qor jangi, kometa, cho'kkan kema xazinasi va svetofor jarimasi.
"""
import json
import math
import random
import time
from datetime import datetime, timedelta

from flask import Blueprint, jsonify, request

import game
import game_fun as gf
import game_social as gs
import quiz
from core import current_user, get_db, login_required

bp = Blueprint("game_city", __name__)


def _me():
    return game.player_key(current_user())


def _money(n: int) -> str:
    return f"{int(n):,}".replace(",", " ")


def _today() -> str:
    return datetime.now(gf.TASHKENT).strftime("%Y-%m-%d")


def _announce(name: str, text: str) -> None:
    with game._lock:
        game._chat.append({"id": next(game._msg_ids), "key": "owner", "name": name, "avatar": None,
                           "t": time.time(), "text": text})


def _near_place(key: str, pid: str, dist: float = 160) -> bool:
    p = game.PLACES[pid]
    spot = p.get("door") or p.get("spot") or {"x": p["x"] + p["w"] / 2, "y": p["y"] + p["h"] / 2}
    return gf._near(key, spot["x"], spot["y"], dist) is not None


def _claim_once(db, key: str, kind: str, day: str | None = None) -> bool:
    """Kuniga (yoki berilgan davrda) bir marta: True — birinchi marta."""
    cur = db.execute("INSERT OR IGNORE INTO game_claims (player_key, kind, day) VALUES (?, ?, ?)",
                     (key, kind, day or _today()))
    db.commit()
    return bool(cur.rowcount)


_cool: dict[tuple, float] = {}


def _cooldown(key: str, kind: str, seconds: float) -> int:
    """Qolgan kutish soniyasi (0 bo'lsa — mumkin va hisob boshlanadi)."""
    now = time.time()
    left = _cool.get((key, kind), 0) + seconds - now
    if left > 0:
        return math.ceil(left)
    _cool[(key, kind)] = now
    return 0


# --------------------------------------------------------------------------- #
#  Narsalar (inventar): non, guldasta, muzqaymoq
# --------------------------------------------------------------------------- #
ITEMS = {
    "non": {"name": "Issiq non", "icon": "🍞", "sell": 900},
    "guldasta": {"name": "Guldasta", "icon": "💐", "sell": 1600},
    "muzqaymoq": {"name": "Muzqaymoq", "icon": "🍦", "sell": 700},
}


def add_item(db, key: str, item: str, n: int = 1) -> None:
    db.execute("INSERT INTO game_items (player_key, item, qty) VALUES (?, ?, ?) "
               "ON CONFLICT(player_key, item) DO UPDATE SET qty = qty + excluded.qty", (key, item, n))
    db.commit()


def take_item(db, key: str, item: str, n: int = 1) -> bool:
    cur = db.execute("UPDATE game_items SET qty = qty - ? WHERE player_key = ? AND item = ? AND qty >= ?", (n, key, item, n))
    db.commit()
    return bool(cur.rowcount)


def _items_json(db, key: str) -> dict:
    rows = db.execute("SELECT item, qty FROM game_items WHERE player_key = ? AND qty > 0", (key,)).fetchall()
    return {r["item"]: r["qty"] for r in rows if r["item"] in ITEMS}


@bp.get("/api/game/items")
@login_required
def api_items():
    key = _me()
    return jsonify(items=_items_json(get_db(), key), catalog=ITEMS)


@bp.post("/api/game/items/sell")
@login_required
def api_items_sell():
    key = _me()
    data = request.get_json(silent=True) or {}
    item, qty = data.get("item"), data.get("qty") or 1
    if item not in ITEMS or not isinstance(qty, int) or isinstance(qty, bool) or not 1 <= qty <= 999:
        return jsonify(error="Noto'g'ri narsa"), 400
    db = get_db()
    if not take_item(db, key, item, qty):
        return jsonify(error="Sizda buncha yo'q"), 400
    pay = ITEMS[item]["sell"] * qty
    gs.add_money(db, key, pay)
    return jsonify(ok=True, pay=pay, items=_items_json(db, key), economy=gf._econ(db, key))


# ---- Bozor rastasi: o'yinchilar bir-biriga sotadi ----
@bp.get("/api/game/stall")
@login_required
def api_stall():
    key = _me()
    db = get_db()
    people = gs._people(db)
    rows = db.execute("SELECT * FROM game_stall ORDER BY id DESC LIMIT 60").fetchall()
    return jsonify(listings=[{"id": r["id"], "item": r["item"], "price": r["price"], "seller": people.get(r["seller"], {}).get("name", "?"),
                              "mine": r["seller"] == key} for r in rows if r["item"] in ITEMS],
                   items=_items_json(db, key), catalog=ITEMS)


@bp.post("/api/game/stall")
@login_required
def api_stall_post():
    key = _me()
    data = request.get_json(silent=True) or {}
    item, price = data.get("item"), data.get("price")
    if item not in ITEMS or not isinstance(price, int) or isinstance(price, bool) or not 100 <= price <= 1_000_000:
        return jsonify(error="Narsa va narxni (100 — 1 000 000) yozing"), 400
    db = get_db()
    if db.execute("SELECT COUNT(*) FROM game_stall WHERE seller = ?", (key,)).fetchone()[0] >= 10:
        return jsonify(error="Rastada ko'pi bilan 10 ta narsa"), 400
    if not take_item(db, key, item):
        return jsonify(error="Bu narsa sizda yo'q"), 400
    db.execute("INSERT INTO game_stall (seller, item, price, at) VALUES (?, ?, ?, ?)", (key, item, price, time.time()))
    db.commit()
    return api_stall()


@bp.post("/api/game/stall/<int:lid>/buy")
@login_required
def api_stall_buy(lid: int):
    key = _me()
    db = get_db()
    row = db.execute("SELECT * FROM game_stall WHERE id = ?", (lid,)).fetchone()
    if not row:
        return jsonify(error="Sotib bo'lingan"), 400
    if row["seller"] == key:
        return jsonify(error="O'z narsangizni ololmaysiz"), 400

    def change(r, money):
        if money < row["price"]:
            raise game.GameError("Pul yetarli emas")
        return -row["price"], lambda: db.execute("DELETE FROM game_stall WHERE id = ?", (lid,))

    _, err = gs._change(db, key, change)
    if err:
        return err
    add_item(db, key, row["item"])
    gs.add_money(db, row["seller"], row["price"])
    gs._notify(row["seller"], f"Bozorda {ITEMS[row['item']]['name']} sotildi: +{_money(row['price'])} so'm")
    return api_stall()


@bp.delete("/api/game/stall/<int:lid>")
@login_required
def api_stall_remove(lid: int):
    key = _me()
    db = get_db()
    row = db.execute("SELECT * FROM game_stall WHERE id = ? AND seller = ?", (lid, key)).fetchone()
    if row:
        db.execute("DELETE FROM game_stall WHERE id = ?", (lid,))
        db.commit()
        add_item(db, key, row["item"])
    return api_stall()


# --------------------------------------------------------------------------- #
#  Pochta qutisi: do'stga xat va sovg'a (narsa)
# --------------------------------------------------------------------------- #
@bp.get("/api/game/mail")
@login_required
def api_mail():
    key = _me()
    db = get_db()
    people = gs._people(db)
    rows = db.execute("SELECT * FROM game_mail WHERE to_key = ? ORDER BY id DESC LIMIT 30", (key,)).fetchall()
    db.execute("UPDATE game_mail SET seen = 1 WHERE to_key = ?", (key,))
    db.commit()
    return jsonify(mail=[{"id": r["id"], "from": people.get(r["from_key"], {}).get("name", "?"), "text": r["text"],
                          "item": r["item"], "new": not r["seen"],
                          "at": datetime.fromtimestamp(r["at"]).strftime("%d.%m %H:%M")} for r in rows],
                   items=_items_json(db, key), catalog=ITEMS,
                   people=[{"key": k, "name": v["name"]} for k, v in people.items() if k != key])


@bp.post("/api/game/mail")
@login_required
def api_mail_send():
    user = current_user()
    key = game.player_key(user)
    data = request.get_json(silent=True) or {}
    to, text, item = data.get("to"), " ".join(str(data.get("text") or "").split())[:300], data.get("item") or None
    db = get_db()
    if to == key or to not in gs._people(db):
        return jsonify(error="Kimga yuborasiz?"), 400
    if not text and not item:
        return jsonify(error="Xat yozing yoki sovg'a tanlang"), 400
    if item and (item not in ITEMS or not take_item(db, key, item)):
        return jsonify(error="Bu narsa sizda yo'q"), 400
    db.execute("INSERT INTO game_mail (from_key, to_key, text, item, at, seen) VALUES (?, ?, ?, ?, ?, 0)",
               (key, to, text, item, time.time()))
    db.commit()
    if item:
        add_item(db, to, item)
    gs._notify(to, f"📮 {user['name']} sizga xat yubordi{' va ' + ITEMS[item]['icon'] if item else ''} — Menyu → Pochta qutisi")
    return jsonify(ok=True, items=_items_json(db, key))


# --------------------------------------------------------------------------- #
#  Ustaxonalar: tikuvchi, avtomexanik, muzqaymoq, gul do'koni (buyurtma — tez bajaring)
# --------------------------------------------------------------------------- #
COLORS = ["qizil", "ko'k", "yashil", "sariq", "qora", "oq", "binafsha", "pushti"]
PARTS = ["g'ildirak", "fara", "akkumulyator", "dvigatel", "tormoz", "oyna"]
FLAVORS = ["vanil", "shokolad", "qulupnay", "pista", "limon"]
FLOWERS = ["atirgul", "lola", "romashka", "nilufar", "chinnigul", "boychechak"]
WORK = {
    "icecream": {"place": "icecream", "pay": 1000, "title": "Muzqaymoq"},
}
_orders: dict[str, dict] = {}


def _make_order(job: str) -> dict:
    if job == "tailor":
        c = random.choice(COLORS)
        thing = random.choice(["ko'ylak", "shim", "kurtka", "do'ppi"])
        return {"text": f"Mijoz {thing} uchun {c} mato so'radi", "want": [c], "options": COLORS}
    if job == "mechanic":
        broken = random.sample(PARTS, 3)
        return {"text": "Mashinada 3 ta qism buzilgan: " + ", ".join(broken) + " — ularni almashtiring",
                "want": sorted(broken), "options": PARTS, "multi": True}
    if job == "icecream":
        f = random.choice(FLAVORS)
        return {"text": f"Bola {f} muzqaymoq so'rayapti", "want": [f], "options": FLAVORS}
    fl = random.sample(FLOWERS, 3)
    return {"text": "Guldasta: " + ", ".join(fl), "want": sorted(fl), "options": FLOWERS, "multi": True}


@bp.post("/api/game/work/<job>/order")
@login_required
def api_work_order(job: str):
    key = _me()
    if job not in WORK:
        return jsonify(error="Qaysi ish?"), 404
    if not _near_place(key, WORK[job]["place"]):
        return jsonify(error=f"{WORK[job]['title']}ga boring"), 400
    o = _make_order(job)
    o.update(id=random.randint(1, 10 ** 9), at=time.time(), job=job)
    _orders[key] = o
    return jsonify(order={k: o[k] for k in ("id", "text", "options") } | {"multi": o.get("multi", False), "need": len(o["want"])},
                   pay=WORK[job]["pay"])


@bp.post("/api/game/work/<job>/done")
@login_required
def api_work_done(job: str):
    key = _me()
    data = request.get_json(silent=True) or {}
    o = _orders.get(key)
    if not o or o["job"] != job or o["id"] != data.get("id"):
        return jsonify(error="Buyurtma topilmadi"), 400
    t = time.time() - o["at"]
    if t < 0.8:
        return jsonify(error="Juda tez 🙂"), 400
    _orders.pop(key, None)
    ans = data.get("answer")
    ok = isinstance(ans, list) and sorted(map(str, ans)) == o["want"]
    if not ok:
        return jsonify(ok=False, pay=0, msg="Noto'g'ri bajarildi — mijoz norozi 😕")
    base = WORK[job]["pay"]
    pay = int(base * (1.5 if t <= 6 else 1.0 if t <= 15 else 0.6))
    db = get_db()
    gs.add_money(db, key, pay)
    item = WORK[job].get("item")
    if item:
        add_item(db, key, item)
    game.emit(db, key, "craft")
    return jsonify(ok=True, pay=pay, time=round(t, 1), item=item,
                   msg=f"Barakalla! +{_money(pay)} so'm{' va ' + ITEMS[item]['icon'] if item else ''}", economy=gf._econ(db, key))


# --------------------------------------------------------------------------- #
#  Uy ijarasi va sarmoya
# --------------------------------------------------------------------------- #
RENT_PER_LEVEL = 1500


@bp.post("/api/game/rent/claim")
@login_required
def api_rent_claim():
    key = _me()
    db = get_db()
    homes = db.execute("SELECT level FROM game_plots WHERE owner_key = ? AND kind = 'uy' AND level > 0", (key,)).fetchall()
    if not homes:
        return jsonify(error="Ijaraga beradigan uyingiz yo'q — yerga Uy quring"), 400
    if not _claim_once(db, key, "rent"):
        return jsonify(error="Bugungi ijara haqi olingan — ertaga keling"), 400
    pay = sum(h["level"] for h in homes) * RENT_PER_LEVEL
    gs.add_money(db, key, pay)
    return jsonify(pay=pay, homes=len(homes), economy=gf._econ(db, key))


INVEST_RATE = 0.02     # kuniga 2%
INVEST_DAYS = 30


@bp.get("/api/game/invest")
@login_required
def api_invest():
    key = _me()
    db = get_db()
    people = gs._people(db)
    now = time.time()
    mine = []
    for r in db.execute("SELECT * FROM game_invest WHERE investor = ? ORDER BY id DESC", (key,)):
        days = int((min(now, r["until"]) - r["last_claim"]) // 86400)
        mine.append({"id": r["id"], "plot": r["plot"], "amount": r["amount"], "owner": people.get(r["owner"], {}).get("name", "?"),
                     "claim": int(days * r["amount"] * INVEST_RATE), "days_left": max(0, int((r["until"] - now) // 86400))})
    targets = [{"plot": r["plot"], "kind": r["kind"], "level": r["level"], "owner": people.get(r["owner_key"], {}).get("name", "?")}
               for r in db.execute("SELECT plot, kind, level, owner_key FROM game_plots WHERE kind IN ('kafe', 'magazin', 'ofis') "
                                   "AND level > 0 AND owner_key != ? ORDER BY level DESC LIMIT 30", (key,))]
    return jsonify(mine=mine, targets=targets, rate=INVEST_RATE, days=INVEST_DAYS)


@bp.post("/api/game/invest")
@login_required
def api_invest_make():
    user = current_user()
    key = game.player_key(user)
    data = request.get_json(silent=True) or {}
    plot, amount = data.get("plot"), data.get("amount")
    if not isinstance(amount, int) or isinstance(amount, bool) or not 10000 <= amount <= 5_000_000:
        return jsonify(error="Sarmoya 10 000 dan 5 000 000 gacha"), 400
    db = get_db()
    row = db.execute("SELECT owner_key, kind FROM game_plots WHERE plot = ? AND kind IN ('kafe', 'magazin', 'ofis') AND level > 0",
                     (plot,)).fetchone()
    if not row or row["owner_key"] == key:
        return jsonify(error="Bu biznesga sarmoya qilib bo'lmaydi"), 400
    now = time.time()

    def change(r, money):
        if money < amount:
            raise game.GameError("Pul yetarli emas")
        return -amount, lambda: db.execute(
            "INSERT INTO game_invest (investor, owner, plot, amount, at, last_claim, until) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (key, row["owner_key"], plot, amount, now, now, now + INVEST_DAYS * 86400))

    _, err = gs._change(db, key, change)
    if err:
        return err
    gs.add_money(db, row["owner_key"], amount)   # pul biznes egasiga
    gs._notify(row["owner_key"], f"💼 {user['name']} biznesingizga {_money(amount)} so'm sarmoya kiritdi!")
    return api_invest()


@bp.post("/api/game/invest/claim")
@login_required
def api_invest_claim():
    key = _me()
    db = get_db()
    now = time.time()
    total = 0
    for r in db.execute("SELECT * FROM game_invest WHERE investor = ?", (key,)).fetchall():
        days = int((min(now, r["until"]) - r["last_claim"]) // 86400)
        if days > 0:
            total += int(days * r["amount"] * INVEST_RATE)
            db.execute("UPDATE game_invest SET last_claim = last_claim + ? WHERE id = ?", (days * 86400, r["id"]))
    db.commit()
    if not total:
        return jsonify(error="Hali dividend yo'q — har 24 soatda 2% yig'iladi"), 400
    gs.add_money(db, key, total)
    return jsonify(pay=total, economy=gf._econ(db, key))


# --------------------------------------------------------------------------- #
#  Dron kuryer
# --------------------------------------------------------------------------- #
_drone_jobs: dict[str, dict] = {}


@bp.post("/api/game/dronejob/start")
@login_required
def api_dronejob_start():
    key = _me()
    db = get_db()
    row = game.ensure_player(db, key)
    if not row["drone"]:
        return jsonify(error="Avval dron sotib oling (Menyu → Dron)"), 400
    if key in _drone_jobs:
        return jsonify(error="Dron hali yo'lda"), 400
    p = game._live_pos(key, time.time())
    if not p:
        return jsonify(error="O'yinga kiring"), 400
    plot = random.choice(game.PLOTS)
    tx, ty = plot["x"] + plot["w"] / 2, plot["y"] + plot["h"] / 2
    dist = math.hypot(tx - p["x"], ty - p["y"])
    eta = max(5.0, min(14.0, dist / 450))
    _drone_jobs[key] = {"t": time.time(), "eta": eta, "dist": dist}
    return jsonify(target={"x": tx, "y": ty}, eta=eta, from_={"x": p["x"], "y": p["y"]})


@bp.post("/api/game/dronejob/finish")
@login_required
def api_dronejob_finish():
    key = _me()
    j = _drone_jobs.get(key)
    if not j:
        return jsonify(error="Yetkazish yo'q"), 400
    if time.time() - j["t"] < j["eta"] - 0.3:
        return jsonify(error="Dron hali yetib bormadi"), 400
    _drone_jobs.pop(key, None)
    pay = int(1200 + j["dist"] * 0.35)
    db = get_db()
    gs.add_money(db, key, pay)
    return jsonify(pay=pay, economy=gf._econ(db, key))


# --------------------------------------------------------------------------- #
#  Bayroqni olish: bayroqni olib o'z uyingizga yetkazing; boshqalar tegib tortib oladi
# --------------------------------------------------------------------------- #
FLAG_SPOTS = [{"x": 1200, "y": 1020}, {"x": 2370, "y": 640}, {"x": 3150, "y": 3080}, {"x": 4720, "y": 1520},
              {"x": 5480, "y": 2300}, {"x": 900, "y": 2300}, {"x": 3930, "y": 760}]
FLAG_PRIZE = 20000
FLAG_TOUCH = 55
_flag: dict = {"x": FLAG_SPOTS[0]["x"], "y": FLAG_SPOTS[0]["y"], "holder": None, "away_until": 0}


def _flag_json(now: float) -> dict | None:
    if now < _flag["away_until"]:
        return None
    h = _flag["holder"]
    if h:
        p = game._live_pos(h, now)
        if not p:  # egasi o'yindan chiqdi — bayroq o'sha joyda qoladi
            _flag["holder"] = None
        else:
            _flag["x"], _flag["y"] = p["x"], p["y"]
    return {"x": round(_flag["x"]), "y": round(_flag["y"]), "holder": _flag["holder"],
            "name": game._live.get(_flag["holder"], {}).get("name") if _flag["holder"] else None}


@bp.post("/api/game/flag/grab")
@login_required
def api_flag_grab():
    user = current_user()
    key = game.player_key(user)
    now = time.time()
    with game._lock:
        f = _flag_json(now)
        if not f:
            return jsonify(error="Bayroq hali chiqmadi"), 400
        if f["holder"] == key:
            return jsonify(error="Bayroq sizda"), 400
        if not gf._near(key, f["x"], f["y"], FLAG_TOUCH + (25 if f["holder"] else 0), now):
            return jsonify(error="Bayroqqa yaqinroq boring"), 400
        stolen = f["holder"]
        _flag["holder"] = key
    if stolen:
        gs._notify(stolen, f"🚩 {user['name']} bayroqni tortib oldi!")
    return jsonify(ok=True)


@bp.post("/api/game/flag/deliver")
@login_required
def api_flag_deliver():
    user = current_user()
    key = game.player_key(user)
    db = get_db()
    row = game.ensure_player(db, key)
    if row["plot"] is None:
        return jsonify(error="Uyingiz yo'q"), 400
    gate = game.plot_spawn(game.PLOTS[row["plot"]])
    now = time.time()
    with game._lock:
        if _flag["holder"] != key:
            return jsonify(error="Bayroq sizda emas"), 400
        if not gf._near(key, gate["x"], gate["y"], 170, now):
            return jsonify(error="Bayroqni uyingiz darvozasiga olib boring"), 400
        spot = random.choice([s for s in FLAG_SPOTS if (s["x"], s["y"]) != (round(_flag["x"]), round(_flag["y"]))])
        _flag.update(holder=None, x=spot["x"], y=spot["y"], away_until=now + 30)
    gs.add_money(db, key, FLAG_PRIZE)
    _announce("🚩 Bayroq", f"{user['name']} bayroqni uyiga olib bordi! +{_money(FLAG_PRIZE)} so'm. Yangi bayroq 30 soniyadan keyin chiqadi")
    return jsonify(ok=True, pay=FLAG_PRIZE, economy=gf._econ(db, key))


# --------------------------------------------------------------------------- #
#  Labirint, velosiped va qayiq poygalari (vaqtga)
# --------------------------------------------------------------------------- #
MAZE = {"rect": {"x": 100, "y": -1250, "w": 1200, "h": 1190}, "area": game.MAZE_RECT, "cells": 12, "seed": 2026,
        "start": {"x": 750, "y": -30}, "finish": {"x": 750, "y": -1215}}
CPRACES = {
    "bike": {"name": "Velo-marafon", "need": ("bike", "skate"), "prize": 4000,
             "points": [{"x": 2060, "y": 1180}, {"x": 2060, "y": 1940}, {"x": 3540, "y": 1940}, {"x": 3540, "y": 420}, {"x": 2060, "y": 420}, {"x": 2060, "y": 1180}]},
    "boat": {"name": "Qayiq poygasi", "need": ("boat",), "prize": 5000,
             "points": [{"x": 7150, "y": 3450}, {"x": 7900, "y": 3050}, {"x": 7950, "y": 3950}, {"x": 7250, "y": 4000}, {"x": 7150, "y": 3450}]},
}
_runs: dict[tuple, dict] = {}


def _week() -> str:
    return gf.week_id()


def _record(db, kind: str, key: str, secs: float) -> bool:
    wk = _week()
    row = db.execute("SELECT best FROM game_records WHERE kind = ? AND week = ? AND player_key = ?", (kind, wk, key)).fetchone()
    if row and row["best"] <= secs:
        return False
    db.execute("INSERT INTO game_records (kind, week, player_key, best) VALUES (?, ?, ?, ?) "
               "ON CONFLICT(kind, week, player_key) DO UPDATE SET best = excluded.best", (kind, wk, key, secs))
    db.commit()
    return True


def _top(db, kind: str) -> list:
    people = gs._people(db)
    rows = db.execute("SELECT player_key, best FROM game_records WHERE kind = ? AND week = ? ORDER BY best LIMIT 10", (kind, _week())).fetchall()
    return [{"name": people.get(r["player_key"], {}).get("name", "?"), "best": round(r["best"], 1)} for r in rows]


@bp.get("/api/game/records/<kind>")
@login_required
def api_records(kind: str):
    if kind not in ("maze", *CPRACES):
        return jsonify(error="?"), 404
    return jsonify(top=_top(get_db(), kind))


@bp.post("/api/game/maze/start")
@login_required
def api_maze_start():
    key = _me()
    s = MAZE["start"]
    if not gf._near(key, s["x"], s["y"], 140):
        return jsonify(error="Labirint kirishiga boring"), 400
    _runs[(key, "maze")] = {"t": time.time()}
    return jsonify(ok=True)


@bp.post("/api/game/maze/finish")
@login_required
def api_maze_finish():
    key = _me()
    run = _runs.get((key, "maze"))
    f = MAZE["finish"]
    if not run:
        return jsonify(error="Avval kirishda «Boshlash» ni bosing"), 400
    if not gf._near(key, f["x"], f["y"], 140):
        return jsonify(error="Chiqishga yeting"), 400
    secs = time.time() - run["t"]
    if secs < 20:
        return jsonify(error="Juda tez — devordan o'tib bo'lmaydi 🙂"), 400
    _runs.pop((key, "maze"), None)
    db = get_db()
    best = _record(db, "maze", key, secs)
    pay = 5000 if secs < 240 else 2000
    gs.add_money(db, key, pay)
    return jsonify(time=round(secs, 1), best=best, pay=pay, top=_top(db, "maze"), economy=gf._econ(db, key))


def _vehicle_ok(key: str, race: dict, now: float) -> bool:
    p = game._live.get(key)
    if not p or now - p["t"] > 5:
        return False
    if "boat" in race["need"]:
        return bool(p.get("boat"))
    return p.get("car") in race["need"]


@bp.post("/api/game/cprace/<rid>/start")
@login_required
def api_cprace_start(rid: str):
    key = _me()
    race = CPRACES.get(rid)
    if not race:
        return jsonify(error="?"), 404
    now = time.time()
    p0 = race["points"][0]
    if not gf._near(key, p0["x"], p0["y"], 150, now):
        return jsonify(error=f"{race['name']} boshlanish joyiga boring"), 400
    if not _vehicle_ok(key, race, now):
        return jsonify(error="Velosiped yoki skeytbordda bo'ling" if rid == "bike" else "Qayiqda bo'ling (portdagi ko'prikdan)"), 400
    _runs[(key, rid)] = {"t": now, "i": 1}
    return jsonify(next=1, points=race["points"])


@bp.post("/api/game/cprace/<rid>/check")
@login_required
def api_cprace_check(rid: str):
    key = _me()
    race = CPRACES.get(rid)
    run = _runs.get((key, rid))
    if not race or not run:
        return jsonify(error="Poyga boshlanmagan"), 400
    now = time.time()
    pt = race["points"][run["i"]]
    if not gf._near(key, pt["x"], pt["y"], 130, now) or not _vehicle_ok(key, race, now):
        return jsonify(error="Nazorat nuqtasiga yeting"), 400
    run["i"] += 1
    if run["i"] < len(race["points"]):
        return jsonify(next=run["i"])
    secs = now - run["t"]
    _runs.pop((key, rid), None)
    db = get_db()
    best = _record(db, rid, key, secs)
    gs.add_money(db, key, race["prize"])
    return jsonify(done=True, time=round(secs, 1), best=best, pay=race["prize"], top=_top(db, rid), economy=gf._econ(db, key))


# --------------------------------------------------------------------------- #
#  Klanlar futbol kubogi (haftalik gollar)
# --------------------------------------------------------------------------- #
FCUP_PRIZE = 50000
_fcup_check = {"t": 0.0}


def _goal_hook(db, key: str, kind: str, n: int = 1) -> None:
    if kind != "goal":
        return
    row = gs._row(db, key)
    if row and row["clan"]:
        db.execute("INSERT INTO game_clan_goals (week, clan, goals) VALUES (?, ?, ?) "
                   "ON CONFLICT(week, clan) DO UPDATE SET goals = goals + excluded.goals", (_week(), row["clan"], n))
        db.commit()


def _fcup_top(db, wk: str) -> list:
    return [{"clan": r["clan"], "name": r["name"], "tag": r["tag"], "goals": r["goals"]} for r in db.execute(
        "SELECT g.clan, g.goals, c.name, c.tag FROM game_clan_goals g JOIN game_clans c ON c.id = g.clan "
        "WHERE g.week = ? AND g.goals > 0 ORDER BY g.goals DESC LIMIT 10", (wk,))]


def _fcup_payout(db) -> None:
    prev = gf.week_id(datetime.now(gf.TASHKENT) - timedelta(days=7))
    if db.execute("SELECT 1 FROM game_claims WHERE player_key = 'fcup' AND kind = 'fcup' AND day = ?", (prev,)).fetchone():
        return
    top = _fcup_top(db, prev)
    if not top:
        return
    if not _claim_once(db, "fcup", "fcup", prev):
        return
    for m in db.execute("SELECT player_key FROM game_players WHERE clan = ?", (top[0]["clan"],)).fetchall():
        gs.add_money(db, m["player_key"], FCUP_PRIZE)
        gs._notify(m["player_key"], f"⚽ Klaningiz futbol kubogini yutdi! +{_money(FCUP_PRIZE)} so'm")


@bp.get("/api/game/fcup")
@login_required
def api_fcup():
    db = get_db()
    _fcup_payout(db)
    return jsonify(top=_fcup_top(db, _week()), prize=FCUP_PRIZE)


# --------------------------------------------------------------------------- #
#  Qor jangi (qishda), kometa, cho'kkan kema xazinasi, svetofor jarimasi
# --------------------------------------------------------------------------- #
WINTER_MONTHS = (11, 12, 1, 2, 3)


@bp.post("/api/game/snowball")
@login_required
def api_snowball():
    key = _me()
    if datetime.now(gf.TASHKENT).month not in WINTER_MONTHS:
        return jsonify(error="Qor jangi faqat qishda ❄️"), 400
    target = (request.get_json(silent=True) or {}).get("key")
    now = time.time()
    if target == key:
        return jsonify(error="?"), 400
    with game._lock:
        t = game._live_pos(target, now) if isinstance(target, str) else None
        if not t or not gf._near(key, t["x"], t["y"], 380, now):
            return jsonify(error="Juda uzoq"), 400
        if target in game._live:
            game._live[target]["emote"] = {"e": "❄️", "t": now}
    if _cooldown(key, "snow", 1.2):
        return jsonify(error="Qor tayyorlanmoqda…"), 429
    db = get_db()
    day = "snow-" + _today()
    db.execute("INSERT INTO game_stats (player_key, stat, n) VALUES (?, ?, 1) "
               "ON CONFLICT(player_key, stat) DO UPDATE SET n = n + 1", (key, day))
    db.commit()
    hits = db.execute("SELECT n FROM game_stats WHERE player_key = ? AND stat = ?", (key, day)).fetchone()["n"]
    return jsonify(hits=hits)


@bp.get("/api/game/snowball")
@login_required
def api_snow_top():
    db = get_db()
    people = gs._people(db)
    rows = db.execute("SELECT player_key, n FROM game_stats WHERE stat = ? ORDER BY n DESC LIMIT 10", ("snow-" + _today(),)).fetchall()
    return jsonify(top=[{"name": people.get(r["player_key"], {}).get("name", "?"), "hits": r["n"]} for r in rows],
                   winter=datetime.now(gf.TASHKENT).month in WINTER_MONTHS)


COMET_EVERY, COMET_LEN = 600, 30
COMET_PRIZE, COMET_SMALL = 10000, 1000


def comet_now(now: float) -> dict | None:
    phase = now % COMET_EVERY
    return {"id": int(now // COMET_EVERY), "left": round(COMET_LEN - phase, 1)} if phase < COMET_LEN else None


@bp.post("/api/game/comet/wish")
@login_required
def api_comet():
    user = current_user()
    key = game.player_key(user)
    c = comet_now(time.time())
    if not c:
        return jsonify(error="Kometa o'tib ketdi"), 400
    db = get_db()
    if not _claim_once(db, key, "comet", str(c["id"])):
        return jsonify(error="Tilak tiladingiz ✨"), 400
    first = _claim_once(db, "comet", "comet-first", str(c["id"]))
    pay = COMET_PRIZE if first else COMET_SMALL
    gs.add_money(db, key, pay)
    if first:
        _announce("☄️ Kometa", f"{user['name']} kometani birinchi ko'rib tilak tiladi! +{_money(pay)} so'm")
    return jsonify(first=first, pay=pay, economy=gf._econ(db, key))


WRECK = {"x": 7600, "y": 3700, "prize": 15000}


@bp.post("/api/game/wreck")
@login_required
def api_wreck():
    key = _me()
    now = time.time()
    p = game._live.get(key)
    if not p or not p.get("boat") or not gf._near(key, WRECK["x"], WRECK["y"], 170, now):
        return jsonify(error="Suv osti kemasida cho'kkan kema ustiga boring"), 400
    db = get_db()
    if not _claim_once(db, key, "wreck"):
        return jsonify(error="Bugungi xazina olingan — ertaga yana sho'ng'ing"), 400
    gs.add_money(db, key, WRECK["prize"])
    return jsonify(pay=WRECK["prize"], economy=gf._econ(db, key))


@bp.post("/api/game/fine")
@login_required
def api_fine():
    """Qizil chiroqda o'tdi — o'yinchining o'zi jarima to'laydi (faqat o'z pulidan)."""
    key = _me()
    if _cooldown(key, "fine", 20):
        return jsonify(ok=True, fine=0)
    db = get_db()

    def change(row, money):
        return -min(500, max(0, money)), None

    _, err = gs._change(db, key, change)
    return err or jsonify(ok=True, fine=500, economy=gf._econ(db, key))


# --------------------------------------------------------------------------- #
#  Sinxron
# --------------------------------------------------------------------------- #
def _city_hook(db, key: str, row, now: float, response: dict) -> None:
    with game._lock:
        response["flag"] = _flag_json(now)
    response["comet"] = comet_now(now)
    if now - _fcup_check["t"] > 60:
        _fcup_check["t"] = now
        _fcup_payout(db)


game.SYNC_HOOKS.append(_city_hook)
game.EVENT_HOOKS.append(_goal_hook)
game.WORLD_DATA.update(maze=MAZE, cpraces={k: {"name": v["name"], "points": v["points"]} for k, v in CPRACES.items()},
                       wreck=WRECK, flag_spots=FLAG_SPOTS)


SCHEMA = """
CREATE TABLE IF NOT EXISTS game_items (
    player_key TEXT NOT NULL,
    item       TEXT NOT NULL,
    qty        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (player_key, item)
);
CREATE TABLE IF NOT EXISTS game_stall (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    seller TEXT NOT NULL,
    item   TEXT NOT NULL,
    price  INTEGER NOT NULL,
    at     REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS game_mail (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    from_key TEXT NOT NULL,
    to_key   TEXT NOT NULL,
    text     TEXT NOT NULL,
    item     TEXT,
    at       REAL NOT NULL,
    seen     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS game_claims (
    player_key TEXT NOT NULL,
    kind       TEXT NOT NULL,
    day        TEXT NOT NULL,
    PRIMARY KEY (player_key, kind, day)
);
CREATE TABLE IF NOT EXISTS game_stats (
    player_key TEXT NOT NULL,
    stat       TEXT NOT NULL,
    n          INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (player_key, stat)
);
CREATE TABLE IF NOT EXISTS game_invest (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    investor   TEXT NOT NULL,
    owner      TEXT NOT NULL,
    plot       INTEGER NOT NULL,
    amount     INTEGER NOT NULL,
    at         REAL NOT NULL,
    last_claim REAL NOT NULL,
    until      REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS game_billboard (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    player_key TEXT NOT NULL,
    name       TEXT NOT NULL,
    text       TEXT NOT NULL,
    until      REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS game_records (
    kind       TEXT NOT NULL,
    week       TEXT NOT NULL,
    player_key TEXT NOT NULL,
    best       REAL NOT NULL,
    PRIMARY KEY (kind, week, player_key)
);
CREATE TABLE IF NOT EXISTS game_clan_goals (
    week  TEXT NOT NULL,
    clan  INTEGER NOT NULL,
    goals INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (week, clan)
);
"""
