"""Mahalla — do'stlar bilan o'ynaladigan o'yin.

Piyoda yoki mashinada yurasiz, ko'chadagi tangalarni terasiz, Ota hovlini sotib olib
kuchaytirasiz va Avtosalondan mashina olasiz. Hovli va mashinalar har soatda pul olib keladi.

Kim qayerda turgani — server xotirasida (qayta ishga tushsa tozalanadi),
pul, hovli va mashinalar — bazada.
"""
import json
import math
import random
import threading
import time

from flask import Blueprint, jsonify, redirect, render_template, request, url_for

import config
from core import avatar_url, current_user, get_db, login_required

bp = Blueprint("game", __name__)

# --------------------------------------------------------------------------- #
#  Iqtisod
# --------------------------------------------------------------------------- #
START_MONEY = 1500          # yangi o'yinchi puli
COIN_VALUE = 50            # bitta tanga
OFFLINE_CAP_HOURS = 24     # o'yinga kirmasangiz ham shuncha soatgacha daromad yig'iladi

HOUSE_LEVELS = [  # Ota hovli darajalari (daromad — o'sha darajadagi soatlik pul)
    {"level": 1, "name": "Eski hovli", "price": 1000, "income": 600},
    {"level": 2, "name": "Ta'mirlangan hovli", "price": 4000, "income": 1800},
    {"level": 3, "name": "Yangi uy", "price": 12000, "income": 4500},
    {"level": 4, "name": "Ikki qavatli uy", "price": 30000, "income": 10000},
    {"level": 5, "name": "Hashamatli hovli", "price": 80000, "income": 24000},
]

CARS = [  # Avtosalon
    {"id": "jajji", "name": "Jajji", "price": 2500, "income": 400, "speed": 1.5, "color": "#f59e0b"},
    {"id": "shamol", "name": "Shamol", "price": 9000, "income": 1200, "speed": 1.8, "color": "#22c55e"},
    {"id": "chaqmoq", "name": "Chaqmoq", "price": 25000, "income": 3000, "speed": 2.1, "color": "#3b82f6"},
    {"id": "boron", "name": "Bo'ron", "price": 60000, "income": 7000, "speed": 2.5, "color": "#ef4444"},
]
CARS_BY_ID = {car["id"]: car for car in CARS}

# --------------------------------------------------------------------------- #
#  Xarita (server va brauzer bir xil xaritadan foydalanadi)
# --------------------------------------------------------------------------- #
WORLD_W, WORLD_H = 2400, 1600
ROAD = 80
H_ROADS = [380, 1140]          # gorizontal yo'llar (yuqori cheti, y)
V_ROADS = [380, 1160, 1940]    # vertikal yo'llar (chap cheti, x)

WALK_SPEED = 190               # piyoda tezlik (px/soniya); mashina — shundan necha barobar
PICK_RADIUS = 46
COIN_COUNT = 28
COIN_RESPAWN_SECONDS = 8
ONLINE_SECONDS = 6


def _make_plots() -> list[dict]:
    """Hovli joylari: 18 ta, yo'l bo'yida. gate — darvoza qaysi tomonda."""
    plots = []
    for row_y, gate in ((480, "top"), (950, "bottom"), (190, "bottom")):
        for block_x in (470, 1250):
            for i in range(3):
                plots.append({"x": block_x + i * 230, "y": row_y, "w": 220, "h": 170, "gate": gate})
    return plots


PLOTS = _make_plots()
SHOP = {"x": 40, "y": 560, "w": 300, "h": 190, "door": {"x": 190, "y": 790}}   # Avtosalon
FOUNTAIN = {"x": 2140, "y": 730, "w": 140, "h": 140}                            # bog'dagi favvora
POND = {"x": 640, "y": 1300, "w": 360, "h": 190}                                # ko'l


def house_rect(plot: dict) -> dict:
    y = plot["y"] + 16 if plot["gate"] == "bottom" else plot["y"] + 64
    return {"x": plot["x"] + 40, "y": y, "w": 140, "h": 90}


def plot_spawn(plot: dict) -> dict:
    """Hovli darvozasi oldidagi yo'l."""
    y = plot["y"] + plot["h"] + 40 if plot["gate"] == "bottom" else plot["y"] - 40
    return {"x": plot["x"] + plot["w"] / 2, "y": y}


def _overlaps(px: float, py: float, rect: dict, pad: float = 0) -> bool:
    return (rect["x"] - pad <= px <= rect["x"] + rect["w"] + pad
            and rect["y"] - pad <= py <= rect["y"] + rect["h"] + pad)


BLOCKED_AREAS = PLOTS + [SHOP, FOUNTAIN, POND]


def _on_road(x: float, y: float) -> bool:
    return any(r <= y <= r + ROAD for r in H_ROADS) or any(r <= x <= r + ROAD for r in V_ROADS)


def _make_trees() -> list[dict]:
    rng = random.Random(7)
    trees = []
    while len(trees) < 70:
        x, y = rng.uniform(30, WORLD_W - 30), rng.uniform(30, WORLD_H - 30)
        if _on_road(x, y) or any(_overlaps(x, y, a, 40) for a in BLOCKED_AREAS):
            continue
        if any(math.hypot(x - t["x"], y - t["y"]) < 70 for t in trees):
            continue
        trees.append({"x": round(x), "y": round(y), "r": rng.choice([22, 26, 30])})
    return trees


WORLD_DATA = {
    "w": WORLD_W, "h": WORLD_H, "road": ROAD, "h_roads": H_ROADS, "v_roads": V_ROADS,
    "plots": PLOTS, "shop": SHOP, "fountain": FOUNTAIN, "pond": POND, "trees": _make_trees(),
    "default_spawn": {"x": 1200, "y": 800},
}

# --------------------------------------------------------------------------- #
#  Jonli holat (xotirada)
# --------------------------------------------------------------------------- #
_lock = threading.Lock()
_live: dict[str, dict] = {}      # player_key -> {x, y, dir, car, t, name, avatar}
_coins: dict[int, tuple] = {}    # coin_id -> (x, y)
_respawn: list[float] = []
_next_coin = 1
_rng = random.Random()


def _random_coin_spot() -> tuple:
    while True:
        x, y = _rng.uniform(40, WORLD_W - 40), _rng.uniform(40, WORLD_H - 40)
        if not any(_overlaps(x, y, a, 24) for a in BLOCKED_AREAS):
            return round(x), round(y)


def _add_coin() -> None:
    global _next_coin
    _coins[_next_coin] = _random_coin_spot()
    _next_coin += 1


def _tick_coins(now: float) -> None:
    """Tangalar yetishmasa qo'shadi (lock ichida chaqiriladi)."""
    if not _coins and not _respawn:
        for _ in range(COIN_COUNT):
            _add_coin()
    due = [t for t in _respawn if t <= now]
    for _ in due:
        _add_coin()
    _respawn[:] = [t for t in _respawn if t > now]


def _dist_to_segment(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    """Nuqtadan kesmagacha masofa — tez yurganda ham yo'ldagi tanga hisoblanadi."""
    dx, dy = bx - ax, by - ay
    length2 = dx * dx + dy * dy
    t = 0.0 if length2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length2))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def _coin_list() -> list[dict]:
    return [{"id": cid, "x": x, "y": y} for cid, (x, y) in _coins.items()]


def _others(me: str, now: float) -> list[dict]:
    return [
        {"key": key, "name": p["name"], "avatar": p["avatar"], "x": p["x"], "y": p["y"],
         "dir": p["dir"], "car": p["car"]}
        for key, p in _live.items()
        if key != me and now - p["t"] < ONLINE_SECONDS
    ]


def online_count() -> int:
    now = time.time()
    with _lock:
        return sum(1 for p in _live.values() if now - p["t"] < ONLINE_SECONDS)


def forget_player(key: str) -> None:
    """Foydalanuvchi o'chirilganda: xotira va bazadan olib tashlash."""
    with _lock:
        _live.pop(key, None)
    db = get_db()
    db.execute("DELETE FROM game_players WHERE player_key = ?", (key,))
    db.commit()


# --------------------------------------------------------------------------- #
#  O'yinchi puli va mulki (bazada)
# --------------------------------------------------------------------------- #
_econ_lock = threading.Lock()


def player_key(user: dict) -> str:
    return user["key"]


def income_rate(house_level: int, cars: list) -> int:
    rate = HOUSE_LEVELS[house_level - 1]["income"] if house_level else 0
    return rate + sum(CARS_BY_ID[c]["income"] for c in cars if c in CARS_BY_ID)


def money_now(row, now: float | None = None) -> float:
    now = time.time() if now is None else now
    elapsed = min(max(now - row["income_at"], 0), OFFLINE_CAP_HOURS * 3600)
    rate = income_rate(row["house_level"], json.loads(row["cars"]))
    return row["money"] + rate * elapsed / 3600


def ensure_player(db, key: str):
    row = db.execute("SELECT * FROM game_players WHERE player_key = ?", (key,)).fetchone()
    if row:
        return row
    with _econ_lock:
        used = {r["plot"] for r in db.execute("SELECT plot FROM game_players WHERE plot IS NOT NULL")}
        plot = next((i for i in range(len(PLOTS)) if i not in used), None)
        db.execute(
            "INSERT OR IGNORE INTO game_players (player_key, money, income_at, plot) VALUES (?, ?, ?, ?)",
            (key, START_MONEY, time.time(), plot),
        )
        db.commit()
    return db.execute("SELECT * FROM game_players WHERE player_key = ?", (key,)).fetchone()


class GameError(Exception):
    """Xarid amalga oshmadi (pul yetmaydi va h.k.)."""


def apply_change(db, key: str, change):
    """Yig'ilgan daromadni pulga qo'shib, o'zgarishni yozadi.

    change(row, money) -> (delta, house_level | None, cars | None) yoki GameError.
    Hammasi bitta lock ichida — tugma ikki marta bosilsa ham pul bir marta yechiladi.
    """
    with _econ_lock:
        row = db.execute("SELECT * FROM game_players WHERE player_key = ?", (key,)).fetchone()
        now = time.time()
        money = money_now(row, now)
        delta, house_level, cars = change(row, money)
        db.execute(
            "UPDATE game_players SET money = ?, income_at = ?, house_level = ?, cars = ? WHERE player_key = ?",
            (money + delta, now,
             row["house_level"] if house_level is None else house_level,
             row["cars"] if cars is None else json.dumps(cars), key),
        )
        db.commit()
        return db.execute("SELECT * FROM game_players WHERE player_key = ?", (key,)).fetchone()


def economy_json(row) -> dict:
    level = row["house_level"]
    cars = json.loads(row["cars"])
    return {
        "money": math.floor(money_now(row)),
        "rate": income_rate(level, cars),
        "house_level": level,
        "house": HOUSE_LEVELS[level - 1] if level else None,
        "next_house": HOUSE_LEVELS[level] if level < len(HOUSE_LEVELS) else None,
        "cars": cars,
        "plot": row["plot"],
    }


def summary_for(db, key: str) -> dict | None:
    """Profil sahifasi uchun qisqa ma'lumot."""
    row = db.execute("SELECT * FROM game_players WHERE player_key = ?", (key,)).fetchone()
    if row is None:
        return None
    data = economy_json(row)
    data["car_names"] = [CARS_BY_ID[c]["name"] for c in data["cars"] if c in CARS_BY_ID]
    return data


def houses_list(db) -> list[dict]:
    rows = db.execute(
        "SELECT g.player_key, g.plot, g.house_level, u.name FROM game_players g "
        "LEFT JOIN users u ON g.player_key = 'u' || u.id WHERE g.plot IS NOT NULL"
    ).fetchall()
    return [
        {"key": r["player_key"], "plot": r["plot"], "level": r["house_level"],
         "name": config.OWNER_NAME if r["player_key"] == "owner" else (r["name"] or "?")}
        for r in rows
    ]


# --------------------------------------------------------------------------- #
#  Sahifa va API
# --------------------------------------------------------------------------- #
@bp.get("/game")
def game_page():
    user = current_user()
    if not user:
        return redirect(url_for("login_page"))
    return render_template("game.html", user=user)


@bp.get("/api/game/online")
@login_required
def api_online():
    return jsonify(online=online_count())


@bp.get("/api/game/state")
@login_required
def api_state():
    user = current_user()
    key = player_key(user)
    db = get_db()
    row = ensure_player(db, key)
    plot = row["plot"]
    spawn = plot_spawn(PLOTS[plot]) if plot is not None else WORLD_DATA["default_spawn"]
    now = time.time()
    with _lock:
        _tick_coins(now)
        coins, players = _coin_list(), _others(key, now)
    return jsonify(
        me={"key": key, "name": user["name"], "avatar": user["avatar"], "spawn": spawn},
        economy=economy_json(row),
        world=WORLD_DATA,
        catalog={"houses": HOUSE_LEVELS, "cars": CARS},
        houses=houses_list(db),
        coins=coins,
        players=players,
        walk_speed=WALK_SPEED,
        coin_value=COIN_VALUE,
        offline_cap_hours=OFFLINE_CAP_HOURS,
    )


@bp.post("/api/game/sync")
@login_required
def api_sync():
    """Brauzer har ~0.15 soniyada joylashuvini yuboradi, boshqalarni va tangalarni oladi."""
    user = current_user()
    key = player_key(user)
    data = request.get_json(silent=True) or {}
    try:
        x, y = float(data.get("x")), float(data.get("y"))
        direction = float(data.get("dir") or 0)
    except (TypeError, ValueError):
        return jsonify(error="Noto'g'ri joylashuv"), 400
    if not all(math.isfinite(v) for v in (x, y, direction)):
        return jsonify(error="Noto'g'ri joylashuv"), 400

    db = get_db()
    row = ensure_player(db, key)
    owned = json.loads(row["cars"])
    car = data.get("car") if data.get("car") in owned else None
    x = min(max(x, 10), WORLD_W - 10)
    y = min(max(y, 10), WORLD_H - 10)
    picks = [c for c in (data.get("pick") or [])[:10] if isinstance(c, int) and not isinstance(c, bool)]

    now = time.time()
    corrected = False
    picked = 0
    with _lock:
        _tick_coins(now)
        prev = _live.get(key)
        start = (x, y)
        if prev and now - prev["t"] < 5:
            start = (prev["x"], prev["y"])
            # Juda tez "sakrash" bo'lsa — eski joyiga qaytaramiz
            dt = min(now - prev["t"], 1.0)
            speeds = [CARS_BY_ID[c]["speed"] for c in (car, prev["car"]) if c in CARS_BY_ID]
            limit = WALK_SPEED * max(speeds + [1]) * dt * 1.6 + 40
            if math.hypot(x - prev["x"], y - prev["y"]) > limit:
                x, y, corrected = prev["x"], prev["y"], True
        _live[key] = {"x": x, "y": y, "dir": direction, "car": car, "t": now,
                      "name": user["name"], "avatar": user["avatar"]}
        for cid in picks:
            coin = _coins.get(cid)
            if coin and _dist_to_segment(coin[0], coin[1], *start, x, y) <= PICK_RADIUS:
                del _coins[cid]
                _respawn.append(now + COIN_RESPAWN_SECONDS)
                picked += 1
        coins, players = _coin_list(), _others(key, now)

    if picked:
        row = apply_change(db, key, lambda _row, _money: (picked * COIN_VALUE, None, None))
    response = {"economy": economy_json(row), "coins": coins, "players": players,
                "houses": houses_list(db), "picked": picked}
    if corrected:
        response["correct"] = {"x": x, "y": y}
    return jsonify(response)


@bp.post("/api/game/house")
@login_required
def api_upgrade_house():
    key = player_key(current_user())
    db = get_db()
    ensure_player(db, key)

    def upgrade(row, money):
        level = row["house_level"]
        if level >= len(HOUSE_LEVELS):
            raise GameError("Ota hovli eng yuqori darajada")
        price = HOUSE_LEVELS[level]["price"]
        if money < price:
            raise GameError("Pul yetarli emas")
        return -price, level + 1, None

    try:
        row = apply_change(db, key, upgrade)
    except GameError as err:
        return jsonify(error=str(err)), 400
    return jsonify(economy=economy_json(row), houses=houses_list(db))


@bp.post("/api/game/cars/<car_id>")
@login_required
def api_buy_car(car_id: str):
    key = player_key(current_user())
    car = CARS_BY_ID.get(car_id)
    if car is None:
        return jsonify(error="Bunday mashina yo'q"), 404
    db = get_db()
    ensure_player(db, key)

    def buy(row, money):
        cars = json.loads(row["cars"])
        if car_id in cars:
            raise GameError("Bu mashina sizda bor")
        if money < car["price"]:
            raise GameError("Pul yetarli emas")
        return -car["price"], None, cars + [car_id]

    try:
        row = apply_change(db, key, buy)
    except GameError as err:
        return jsonify(error=str(err)), 400
    return jsonify(economy=economy_json(row))
