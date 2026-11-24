"""Mahalla — shahar 2: uy hayoti (bog', mehmon, uyqu, kundalik), yangi joylar (kino, orol, tog' va chang'i,
plyaj, g'or, tungi bozor, attraksionlar), mini-o'yinlar (shaxmat, domino, bilim jangi, kurash, arqon tortish, ko'pkari,
xazina xaritasi, matematik poyga, o'yinlar markazi), ijtimoiy (do'stga teleport, harakatlar,
mahalla yig'ini, ustoz, klan uyi, hududlar, reyting taxtasi, shikoyat), dars bilan bog'liq
(sandiq, davomat x2, inglizcha so'zlar, kod topshiriqlari, owner boss, haykal, kitob sertifikati,
imtihon kuni) va transport (velosiped ijarasi, vertolyot, kosmos, tuning, ochko tikish).
"""
import json
import math
import random
import re
import threading
import time
from datetime import datetime, timedelta

from flask import Blueprint, jsonify, request

import game
import game_city as gc
import game_fun as gf
import game_social as gs
import quiz
from core import RATING_SQL, current_user, get_db, get_setting, login_required, set_setting

bp = Blueprint("game_town", __name__)

_me = gc._me
_money = gc._money
_today = gc._today
_announce = gc._announce
_cooldown = gc._cooldown
_claim_once = gc._claim_once
_tlock = threading.Lock()


def _now_tk() -> datetime:
    return datetime.now(gf.TASHKENT)


def _is_owner() -> bool:
    u = current_user()
    return bool(u and u["role"] == "owner")


def _err(text: str, code: int = 400):
    return jsonify(error=text), code


def _econ(db, key):
    return gf._econ(db, key)


def _spend(db, key: str, price: int, what: str):
    """Puldan yechish. Xato bo'lsa — (jsonify, 400), aks holda None."""
    def change(row, money):
        if money < price:
            raise game.GameError(f"{what}: {_money(price)} so'm kerak")
        return -price, None
    _, err = gs._change(db, key, change)
    return err


def _near_pt(key: str, pt: dict, dist: float = 120):
    return gf._near(key, pt["x"], pt["y"], dist)


def _name(db, key: str) -> str:
    return gs._people(db).get(key, {}).get("name", "?")


def _online(key: str, now: float | None = None):
    return game._live_pos(key, now or time.time())


# --------------------------------------------------------------------------- #
#  O'yinchining qo'shimcha holati (ochko, hovli, bezaklar, ...) — bitta JSON
# --------------------------------------------------------------------------- #
DEFAULTS = {"energy": 100, "strength": 0, "points": 0, "garden": [], "decor": [], "certs": [],
            "chests": 0, "kit": {}, "mentor": None, "moon_seen": 0, "base": 0, "mars": 0, "hurt": 0}


def tget(db, key: str) -> dict:
    row = db.execute("SELECT data FROM game_town WHERE player_key = ?", (key,)).fetchone()
    d = dict(DEFAULTS)
    if row:
        try:
            d.update(json.loads(row["data"]))
        except ValueError:
            pass
    return d


def tset(db, key: str, d: dict) -> None:
    db.execute("INSERT INTO game_town (player_key, data) VALUES (?, ?) "
               "ON CONFLICT(player_key) DO UPDATE SET data = excluded.data", (key, json.dumps(d)))
    db.commit()


def tupdate(db, key: str, fn) -> dict:
    with _tlock:
        d = tget(db, key)
        fn(d)
        tset(db, key, d)
    return d


def _energy(d: dict, delta: int) -> None:
    d["energy"] = max(0, min(100, int(d.get("energy", 100)) + delta))


def diary(db, key: str, text: str, auto: bool = True) -> None:
    db.execute("INSERT INTO game_diary (player_key, text, auto, at) VALUES (?, ?, ?, ?)", (key, text[:300], int(auto), time.time()))
    db.commit()


# --------------------------------------------------------------------------- #
#  Xarita: yangi hududlar va binolar
# --------------------------------------------------------------------------- #
PARK = {"x": -1300, "y": -260, "w": 1400, "h": 1160}           # shimoli-g'arb: istirohat bog'i
MOUNT = {"x": -1400, "y": 2150, "w": 1500, "h": 1550}          # g'arb: tog', ko'pkari, klanlar ko'chasi
BEACH = {"x": 5450, "y": 3700, "w": 1150, "h": 1000}           # janubi-sharq: plyaj va dengiz
BEACH_SEA = {"x": 5450, "y": 4250, "w": 1150, "h": 450}
ISLAND = {"x": 8600, "y": 1400, "w": 900, "h": 900}            # faqat samolyotda boriladi
# Yangi shahar: shimoli-sharq (y < 0), eski vertikal ko'chalar shu yerga davom etadi.
# Pastki 60 birligi asosiy xarita bilan ustma-ust — chegarasiz o'tiladi.
CITY = {"x": 3500, "y": -1450, "w": 3220, "h": 1510}
CITY_ROADS = ([{"x": 3500, "y": y, "w": 3220, "h": game.ROAD} for y in (-1000, -380)]
              + [{"x": x, "y": -1450, "w": game.ROAD, "h": 1450} for x in (3500, 4280, 5060, 5840)])
_TOWER_COLORS = ("#1e3a8a", "#0f766e", "#7c3aed", "#be123c", "#0369a1", "#334155")
CITY_TOWERS = [{"x": bx + 20 + j * 230, "y": -1425, "w": 180, "h": 150, "hgt": 170 + (i * 7 + j * 3) % 5 * 45,
                "color": _TOWER_COLORS[(i * 3 + j) % len(_TOWER_COLORS)]}
               for i, bx in enumerate((3590, 4370, 5150, 5930)) for j in range(3)]

TOWN_PLACES = {
    # istirohat bog'i
    "nightmarket": {"x": -1200, "y": 500, "w": 360, "h": 90, "door": {"x": -1020, "y": 620}, "label": "🌙 TUNGI BOZOR", "color": "#4338ca", "hgt": 40},
    # tog'
    "cave": {"x": -560, "y": 3250, "w": 200, "h": 140, "door": {"x": -460, "y": 3410}, "label": "🕳️ G'OR", "color": "#57534e", "hgt": 90},
}
SPOTS = {
    "wheel": {"x": -1000, "y": 270}, "carousel": {"x": -620, "y": 250}, "rope": {"x": -500, "y": 650},
    "statue": {"x": -250, "y": 160}, "board": {"x": -250, "y": -60},
    "sun": {"x": 6000, "y": 4000}, "castle": {"x": 5700, "y": 4100}, "sub": {"x": 6400, "y": 4200},
    "island_land": {"x": 9050, "y": 1550}, "coconut": {"x": 9050, "y": 1850},
    "kopkari_goal": {"x": -850, "y": 2700},
}
KOPKARI = {"x": -1300, "y": 2450, "w": 900, "h": 500}
BIKES = [{"x": -150, "y": 400}, {"x": 5700, "y": 3850}]
CLAN_SLOTS = [{"id": i, "x": -1350 + i * 165, "y": 2190, "w": 130, "h": 100, "door": {"x": -1285 + i * 165, "y": 2310}} for i in range(8)]
ZONES = {"park": {"x": -700, "y": -100, "name": "Istirohat bog'i"},
         "mount": {"x": -300, "y": 3000, "name": "Tog' etagi"}, "beach": {"x": 6200, "y": 3900, "name": "Plyaj"}}
SKI = {"name": "Chang'i tushish", "need": (None,), "prize": 4000,
       "points": [{"x": -1050, "y": 3080}, {"x": -1250, "y": 3250}, {"x": -850, "y": 3420}, {"x": -1200, "y": 3560}, {"x": -1050, "y": 3640}]}
gc.CPRACES["ski"] = SKI

game.CARS.append({"id": "heli", "name": "Vertolyot", "price": 1500000, "speed": 2.8, "fare": 2.0,
                  "color": "#0f766e", "style": "heli", "flies": True})
game.CARS.sort(key=lambda c: c["price"])
game.CARS_BY_ID["heli"] = game.CARS[[c["id"] for c in game.CARS].index("heli")]

game.WORLD_DATA.update(
    town={"park": PARK, "mount": MOUNT, "beach": BEACH, "sea": BEACH_SEA, "island": ISLAND,
          "places": TOWN_PLACES, "spots": SPOTS, "kopkari": KOPKARI, "bikes": BIKES, "clan_slots": CLAN_SLOTS,
          "zones": ZONES,
          "city": {"rect": CITY, "roads": CITY_ROADS, "towers": CITY_TOWERS}},
    cpraces={k: {"name": v["name"], "points": v["points"]} for k, v in gc.CPRACES.items()},
)
game.EXTRA_AREAS = [PARK, MOUNT, BEACH, ISLAND, CITY]

ITEMS_NEW = {
    "olma": {"name": "Olma", "icon": "🍎", "sell": 600}, "uzum": {"name": "Uzum", "icon": "🍇", "sell": 500},
    "anor": {"name": "Anor", "icon": "🍑", "sell": 900}, "kokos": {"name": "Kokos", "icon": "🥥", "sell": 1500},
    "fonar": {"name": "Fonar", "icon": "🏮", "sell": 1000}, "navvot": {"name": "Navvot", "icon": "🍬", "sell": 500},
    "somsa": {"name": "Somsa", "icon": "🥟", "sell": 800}, "marvarid": {"name": "Marvarid", "icon": "🦪", "sell": 2500},
    "olmos": {"name": "Olmos", "icon": "💎", "sell": 8000}, "kislorod": {"name": "Kislorod balloni", "icon": "🫧", "sell": 3000},
    "mars_tosh": {"name": "Mars toshi", "icon": "🪨", "sell": 20000},
}
gc.ITEMS.update(ITEMS_NEW)


def _place(pid: str) -> dict:
    return TOWN_PLACES[pid]


def _at(key: str, pid: str, dist: float = 130) -> bool:
    return _near_pt(key, _place(pid)["door"], dist) is not None


def _inside(p, r, pad=0) -> bool:
    return p is not None and r["x"] - pad <= p["x"] <= r["x"] + r["w"] + pad and r["y"] - pad <= p["y"] <= r["y"] + r["h"] + pad


def _home_plots(db, key: str) -> list:
    return [r["plot"] for r in game.my_plots(db, key)]


def _near_home(db, key: str, dist: float = 220) -> int | None:
    for pid in _home_plots(db, key):
        g = game.plot_spawn(game.PLOTS[pid])
        if _near_pt(key, g, dist):
            return pid
    return None


# =========================================================================== #
#  UY HAYOTI
# =========================================================================== #
GARDEN = {"olma": {"price": 2000, "grow": 3600, "yield": 3}, "uzum": {"price": 3000, "grow": 5400, "yield": 5},
          "anor": {"price": 4000, "grow": 7200, "yield": 4}}
GARDEN_MAX = 4


def _garden_json(d: dict, now: float) -> list:
    return [{"kind": t["kind"], "left": max(0, round(t["at"] + GARDEN[t["kind"]]["grow"] - now))} for t in d["garden"] if t.get("kind") in GARDEN]


@bp.get("/api/game/garden")
@login_required
def api_garden():
    key = _me()
    return jsonify(trees=_garden_json(tget(get_db(), key), time.time()), catalog=GARDEN, max=GARDEN_MAX)


@bp.post("/api/game/garden/plant")
@login_required
def api_garden_plant():
    key = _me()
    kind = (request.get_json(silent=True) or {}).get("kind")
    if kind not in GARDEN:
        return _err("Qaysi daraxt?")
    db = get_db()
    if _near_home(db, key) is None:
        return _err("Uyingiz hovlisiga (darvoza oldiga) boring")
    if len(tget(db, key)["garden"]) >= GARDEN_MAX:
        return _err(f"Hovliga ko'pi bilan {GARDEN_MAX} ta daraxt sig'adi")
    err = _spend(db, key, GARDEN[kind]["price"], "Ko'chat")
    if err:
        return err
    d = tupdate(db, key, lambda d: d["garden"].append({"kind": kind, "at": time.time()}))
    return jsonify(trees=_garden_json(d, time.time()), economy=_econ(db, key))


@bp.post("/api/game/garden/harvest")
@login_required
def api_garden_harvest():
    key = _me()
    db = get_db()
    if _near_home(db, key) is None:
        return _err("Uyingiz hovlisiga boring")
    now = time.time()
    got = {}

    def fn(d):
        for t in d["garden"]:
            g = GARDEN.get(t.get("kind"))
            if g and now - t["at"] >= g["grow"]:
                got[t["kind"]] = got.get(t["kind"], 0) + g["yield"]
                t["at"] = now
    d = tupdate(db, key, fn)
    if not got:
        return _err("Hali hech narsa pishmadi 🌱")
    for item, n in got.items():
        gc.add_item(db, key, item, n)
    diary(db, key, "Bog'dan hosil terdim: " + ", ".join(f"{ITEMS_NEW[k]['icon']} {n}" for k, n in got.items()))
    return jsonify(got=got, trees=_garden_json(d, now))


# ---- Mehmonga chaqirish ----
_home_inv: dict[str, dict] = {}   # mehmon -> {from, plot, t}
_visits: dict[str, tuple] = {}    # mehmon -> (plot, until)


@bp.post("/api/game/home/invite")
@login_required
def api_home_invite():
    user = current_user()
    key = game.player_key(user)
    to = (request.get_json(silent=True) or {}).get("to")
    db = get_db()
    plots = [r for r in game.my_plots(db, key) if r["kind"]]
    if not plots:
        return _err("Avval hovlingizga uy quring")
    if not isinstance(to, str) or to == key or to not in gs._people(db):
        return _err("Kimni chaqirasiz?")
    _home_inv[to] = {"from": key, "name": user["name"], "plot": plots[0]["plot"], "t": time.time()}
    gs._notify(to, f"🏠 {user['name']} sizni uyiga mehmonga chaqirdi! Menyu → «Mehmonga borish»")
    return jsonify(ok=True)


@bp.get("/api/game/home/invites")
@login_required
def api_home_invites():
    key = _me()
    inv = _home_inv.get(key)
    if inv and time.time() - inv["t"] > 600:
        inv = None
    return jsonify(invite={"from": inv["from"], "name": inv["name"]} if inv else None)


@bp.post("/api/game/home/visit")
@login_required
def api_home_visit():
    key = _me()
    inv = _home_inv.pop(key, None)
    if not inv or time.time() - inv["t"] > 600:
        return _err("Taklif yo'q yoki eskirdi")
    g = game.plot_spawn(game.PLOTS[inv["plot"]])
    with game._lock:
        game._teleports[key] = (g["x"], g["y"], 0.0)
    _visits[key] = (inv["plot"], time.time() + 900)
    gs._notify(inv["from"], "🏠 Mehmoningiz keldi!")
    return jsonify(plot=inv["plot"], x=g["x"], y=g["y"])


@bp.get("/api/game/home/room/<int:plot_id>")
@login_required
def api_home_room(plot_id: int):
    key = _me()
    v = _visits.get(key)
    if not v or v[0] != plot_id or v[1] < time.time():
        return _err("Bu uyga taklif yo'q")
    db = get_db()
    rec = db.execute("SELECT * FROM game_plots WHERE plot = ?", (plot_id,)).fetchone()
    if not rec or not rec["kind"]:
        return _err("Uy topilmadi")
    return gs._room_json(db, rec, key)


# ---- Uyqu ----
SLEEP_BONUS = 3000


@bp.post("/api/game/sleep")
@login_required
def api_sleep():
    key = _me()
    db = get_db()
    if _near_home(db, key) is None:
        return _err("Uxlash uchun uyingizga boring 🛏️")
    wait = _cooldown(key, "sleep", 1800)
    if wait:
        return _err(f"Hali uyqingiz kelmadi 🙂 {math.ceil(wait / 60)} daqiqadan keyin")
    tupdate(db, key, lambda d: d.update(energy=100))
    pay = 0
    if _claim_once(db, key, "sleep"):
        pay = SLEEP_BONUS
        gs.add_money(db, key, pay)
    diary(db, key, "Uyda yaxshilab uxladim 😴 Energiya to'ldi")
    return jsonify(energy=100, pay=pay, economy=_econ(db, key))


# ---- Kundalik ----
@bp.get("/api/game/diary")
@login_required
def api_diary():
    key = _me()
    rows = get_db().execute("SELECT text, auto, at FROM game_diary WHERE player_key = ? ORDER BY id DESC LIMIT 60", (key,)).fetchall()
    return jsonify(items=[{"text": r["text"], "auto": bool(r["auto"]),
                           "at": datetime.fromtimestamp(r["at"], gf.TASHKENT).strftime("%d.%m %H:%M")} for r in rows])


@bp.post("/api/game/diary")
@login_required
def api_diary_add():
    key = _me()
    text = str((request.get_json(silent=True) or {}).get("text") or "").strip()
    if not 1 <= len(text) <= 300:
        return _err("1–300 belgi yozing")
    if _cooldown(key, "diary", 5):
        return _err("Sekinroq 🙂")
    diary(get_db(), key, text, auto=False)
    return api_diary()


DIARY_EVENTS = {"fish": "Baliq tutdim 🎣", "goal": "Gol urdim ⚽", "race_win": "Poygada g'olib bo'ldim 🏁",
                "build": "Uy qurdim/qavat qo'shdim 🏗️", "taxi": "Taksida yo'lovchi tashidim 🚕"}


def _diary_hook(db, key: str, kind: str, n: int = 1) -> None:
    text = DIARY_EVENTS.get(kind)
    if text and _cooldown(key, f"diary_{kind}", 600) == 0:
        diary(db, key, text)


# =========================================================================== #
#  JOYLAR
# =========================================================================== #
# ---- Kinoteatr: owner video qo'yadi ----
YT_RE = re.compile(r"(?:youtu\.be/|youtube\.com/(?:watch\?v=|embed/|shorts/|live/))([A-Za-z0-9_-]{11})")


@bp.get("/api/game/movie")
@login_required
def api_movie():
    raw = get_setting("game_movie")
    m = json.loads(raw) if raw else None
    if m:
        m["elapsed"] = max(0, round(time.time() - m["at"]))
    return jsonify(movie=m, owner=_is_owner())


@bp.post("/api/game/movie")
@login_required
def api_movie_set():
    if not _is_owner():
        return _err("Faqat owner", 403)
    data = request.get_json(silent=True) or {}
    url = str(data.get("url") or "").strip()
    if not url:
        set_setting("game_movie", None)
        return jsonify(movie=None)
    m = YT_RE.search(url)
    if not m:
        return _err("YouTube havolasini yuboring")
    title = str(data.get("title") or "Kino").strip()[:60] or "Kino"
    set_setting("game_movie", json.dumps({"id": m.group(1), "title": title, "at": time.time()}))
    _announce("🎬 Kinoteatr", f"Kinoteatrda yangi kino: «{title}» — hamma birga ko'ramiz! (favvora bog'idagi kinoteatr)")
    return api_movie()


# ---- Orol (samolyotda) ----
ISLAND_PRICE = 3000


@bp.post("/api/game/island/go")
@login_required
def api_island_go():
    key = _me()
    gate = game.AIRPORT["gate"]
    if not _near_pt(key, gate, 340):
        return _err("Aeroport darvozasiga boring")
    db = get_db()
    err = _spend(db, key, ISLAND_PRICE, "Orolga chipta")
    if err:
        return err
    s = SPOTS["island_land"]
    with game._lock:
        game._teleports[key] = (s["x"], s["y"], 0.0)
    diary(db, key, "Samolyotda orolga uchdim 🏝️")
    return jsonify(x=s["x"], y=s["y"], economy=_econ(db, key))


@bp.post("/api/game/island/back")
@login_required
def api_island_back():
    key = _me()
    if not _inside(_online(key), ISLAND, 30):
        return _err("Siz orolda emassiz")
    gate = game.AIRPORT["gate"]
    with game._lock:
        game._teleports[key] = (gate["x"], gate["y"], 0.0)
    return jsonify(x=gate["x"], y=gate["y"])


@bp.post("/api/game/island/coconut")
@login_required
def api_coconut():
    key = _me()
    if not _near_pt(key, SPOTS["coconut"], 160):
        return _err("Orol o'rtasidagi palmaga boring")
    db = get_db()
    if not _claim_once(db, key, "coconut"):
        return _err("Bugun kokos terdingiz — ertaga qayting 🥥")
    gc.add_item(db, key, "kokos", 3)
    gs.add_money(db, key, 3000)
    return jsonify(text="Palmadan 3 ta kokos va xazina sandiqchasi (+3 000 so'm) topdingiz! 🥥", economy=_econ(db, key))


# ---- Plyaj ----
_castles: list[dict] = []


@bp.post("/api/game/beach/sun")
@login_required
def api_beach_sun():
    key = _me()
    if not _near_pt(key, SPOTS["sun"], 220):
        return _err("Plyajdagi soyabon ostiga boring")
    db = get_db()
    tupdate(db, key, lambda d: _energy(d, 20))
    pay = 0
    if _claim_once(db, key, "sun"):
        pay = 2000
        gs.add_money(db, key, pay)
    return jsonify(text="Quyoshda toblandingiz ☀️ Energiya +20" + (f", +{_money(pay)} so'm" if pay else ""), economy=_econ(db, key))


@bp.post("/api/game/beach/castle")
@login_required
def api_beach_castle():
    user = current_user()
    key = game.player_key(user)
    p = _near_pt(key, SPOTS["castle"], 260)
    if not p:
        return _err("Plyajdagi qumga boring")
    wait = _cooldown(key, "castle", 120)
    if wait:
        return _err(f"Yangi qasr {wait} soniyadan keyin")
    now = time.time()
    _castles[:] = [c for c in _castles if c["until"] > now][-11:]
    _castles.append({"x": round(p["x"]), "y": round(p["y"]) + 30, "name": user["name"], "until": now + 900, "size": random.choice([1, 1.3, 1.6])})
    db = get_db()
    gs.add_money(db, key, 500)
    return jsonify(text="Qumdan qasr qurdingiz 🏰 +500 so'm", economy=_econ(db, key))


# ---- G'or ----
@bp.post("/api/game/cave")
@login_required
def api_cave():
    key = _me()
    if not _at(key, "cave", 150):
        return _err("G'or og'ziga boring (tog'da)")
    db = get_db()
    if not _claim_once(db, key, "cave"):
        return _err("Bugungi xazinani topdingiz — ertaga g'orda yangisi bo'ladi 🔦")
    pay = random.choice([2000, 3000, 5000, 8000, 15000])
    gs.add_money(db, key, pay)
    gem = random.random() < 0.35
    if gem:
        gc.add_item(db, key, "olmos")
    diary(db, key, f"G'ordan xazina topdim: {_money(pay)} so'm" + (" va olmos 💎" if gem else ""))
    return jsonify(pay=pay, gem=gem, economy=_econ(db, key))


# ---- Tungi bozor ----
NIGHT = {"fonar": 1500, "navvot": 800, "somsa": 1200}
FORTUNES = ["Bugun omadingiz chopadi — bitta qiyin savolga javob topasiz ✨", "Yaqin do'stingiz sizga sovg'a beradi 🎁",
            "Uy vazifangiz a'lo bo'ladi ⭐", "Ertaga yangi do'st topasiz 🤝", "Kodingizdagi xatoni tez topasiz 🐞",
            "Poygada birinchi bo'lasiz 🏁", "Kutilmagan xazina sizni kutmoqda 💎"]


def night_open() -> bool:
    h = _now_tk().hour
    return h >= 20 or h < 6


@bp.get("/api/game/nightmarket")
@login_required
def api_night():
    return jsonify(open=night_open() or _is_owner(), prices=NIGHT, catalog={k: ITEMS_NEW[k] for k in NIGHT})


@bp.post("/api/game/nightmarket")
@login_required
def api_night_buy():
    key = _me()
    data = request.get_json(silent=True) or {}
    if not _at(key, "nightmarket", 200):
        return _err("Tungi bozorga boring (istirohat bog'ida)")
    if not (night_open() or _is_owner()):
        return _err("Tungi bozor 20:00 dan 06:00 gacha ochiq 🌙")
    db = get_db()
    if data.get("fortune"):
        if _cooldown(key, "fortune", 60):
            return _err("Folbin dam olyapti 🔮")
        return jsonify(text="🔮 " + random.choice(FORTUNES))
    item = data.get("item")
    if item not in NIGHT:
        return _err("Nima olasiz?")
    err = _spend(db, key, NIGHT[item], ITEMS_NEW[item]["name"])
    if err:
        return err
    gc.add_item(db, key, item)
    return jsonify(text=f"{ITEMS_NEW[item]['icon']} {ITEMS_NEW[item]['name']} oldingiz", economy=_econ(db, key))


# ---- Attraksionlar ----
RIDES = {"wheel": {"price": 1000, "secs": 30}, "carousel": {"price": 700, "secs": 20}}


@bp.post("/api/game/ride")
@login_required
def api_ride():
    key = _me()
    rid = (request.get_json(silent=True) or {}).get("ride")
    if rid not in RIDES:
        return _err("Qaysi attraksion?")
    if not _near_pt(key, SPOTS[rid], 170):
        return _err("Attraksion oldiga boring")
    db = get_db()
    err = _spend(db, key, RIDES[rid]["price"], "Chipta")
    if err:
        return err
    return jsonify(secs=RIDES[rid]["secs"], economy=_econ(db, key))


@bp.get("/api/game/me2")
@login_required
def api_me2():
    key = _me()
    d = tget(get_db(), key)
    return jsonify(energy=d["energy"], strength=d["strength"], points=d["points"], certs=d["certs"],
                   decor=d["decor"], base=d["base"], mars=d["mars"], kit=d["kit"])


# =========================================================================== #
#  MINI-O'YINLAR: stol o'yinlari (shaxmat, domino, bilim jangi, kurash)
# =========================================================================== #
TABLE_GAMES = {"chess": {"name": "Shaxmat", "prize": 5000}, "domino": {"name": "Domino", "prize": 3000},
               "duel": {"name": "Bilim jangi", "prize": 3000}, "kurash": {"name": "Kurash", "prize": 2000}}
TABLE_WINS_PER_DAY = 5
_tables: dict[int, dict] = {}
_tby: dict[str, int] = {}
_tinv: dict[str, dict] = {}
_tid = [0]
_table_pay: list = []   # (winner, game, loser) — lock tashqarisida to'lanadi


# ---- Shaxmat (rokirovka va "en passant"siz, piyoda oxirida farzin bo'ladi) ----
def ch_init() -> list:
    back = ["R", "N", "B", "Q", "K", "B", "N", "R"]
    b = [""] * 64
    for c in range(8):
        b[c], b[8 + c], b[48 + c], b[56 + c] = "b" + back[c], "bP", "wP", "w" + back[c]
    return b


def ch_pseudo(b: list, color: str) -> list:
    out = []
    for i, p in enumerate(b):
        if not p or p[0] != color:
            continue
        r, c = divmod(i, 8)
        t = p[1]
        if t == "P":
            d = -1 if color == "w" else 1
            rr = r + d
            if 0 <= rr < 8 and not b[rr * 8 + c]:
                out.append((i, rr * 8 + c))
                if r == (6 if color == "w" else 1) and not b[(r + 2 * d) * 8 + c]:
                    out.append((i, (r + 2 * d) * 8 + c))
            for dc in (-1, 1):
                cc = c + dc
                if 0 <= rr < 8 and 0 <= cc < 8 and b[rr * 8 + cc] and b[rr * 8 + cc][0] != color:
                    out.append((i, rr * 8 + cc))
        elif t in "NK":
            steps = ([(1, 2), (2, 1), (-1, 2), (-2, 1), (1, -2), (2, -1), (-1, -2), (-2, -1)] if t == "N"
                     else [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)])
            for dr, dc in steps:
                rr, cc = r + dr, c + dc
                if 0 <= rr < 8 and 0 <= cc < 8 and (not b[rr * 8 + cc] or b[rr * 8 + cc][0] != color):
                    out.append((i, rr * 8 + cc))
        else:
            rook, bish = [(1, 0), (-1, 0), (0, 1), (0, -1)], [(1, 1), (1, -1), (-1, 1), (-1, -1)]
            for dr, dc in (rook if t == "R" else bish if t == "B" else rook + bish):
                rr, cc = r + dr, c + dc
                while 0 <= rr < 8 and 0 <= cc < 8:
                    q = b[rr * 8 + cc]
                    if q:
                        if q[0] != color:
                            out.append((i, rr * 8 + cc))
                        break
                    out.append((i, rr * 8 + cc))
                    rr, cc = rr + dr, cc + dc
    return out


def ch_apply(b: list, m) -> list:
    nb = b[:]
    f, t = m
    p = nb[f]
    nb[f] = ""
    if p[1] == "P" and t // 8 in (0, 7):
        p = p[0] + "Q"
    nb[t] = p
    return nb


def ch_in_check(b: list, color: str) -> bool:
    if color + "K" not in b:
        return True
    k = b.index(color + "K")
    return any(t == k for _, t in ch_pseudo(b, "b" if color == "w" else "w"))


def ch_legal(b: list, color: str) -> list:
    return [m for m in ch_pseudo(b, color) if not ch_in_check(ch_apply(b, m), color)]


# ---- Domino ----
def dm_legal(st: dict, hand: list) -> list:
    ch = st["chain"]
    if not ch:
        return [[i, "R"] for i in range(len(hand))]
    L, R = ch[0][0], ch[-1][1]
    out = []
    for i, (a, b) in enumerate(hand):
        if L in (a, b):
            out.append([i, "L"])
        if R in (a, b) and not (L == R and L in (a, b)):
            out.append([i, "R"])
    return out


def _new_table(game_id: str, a: str, b: str, names: dict) -> dict:
    _tid[0] += 1
    now = time.time()
    t = {"id": _tid[0], "game": game_id, "a": a, "b": b, "names": names, "turn": a, "winner": None, "draw": False,
         "t": now, "ended": None, "last": now}
    if game_id == "chess":
        t["board"] = ch_init()
        t["colors"] = {a: "w", b: "b"}
    elif game_id == "domino":
        tiles = [[x, y] for x in range(7) for y in range(x, 7)]
        random.shuffle(tiles)
        t["hands"] = {a: tiles[:7], b: tiles[7:14]}
        t["bone"] = tiles[14:]
        t["chain"] = []
        t["passes"] = 0
    elif game_id == "duel":
        pool = [i for i, q in enumerate(quiz.QUESTIONS) if q["topic"] in ("HTML", "CSS")]
        rng = random.Random()
        qs = [quiz.shuffled(i, rng) for i in rng.sample(pool, 5)]
        t["qs"] = [{"question": q["question"], "options": q["options"]} for q in qs]
        t["correct"] = [q["correct"] for q in qs]
        t["ans"] = {}
        t["deadline"] = now + 120
    elif game_id == "kurash":
        t["start"] = now + 3
        t["end"] = now + 13
        t["taps"] = {a: 0, b: 0}
        t["tap_at"] = {}
    _tables[t["id"]] = t
    _tby[a] = _tby[b] = t["id"]
    return t


def _finish(t: dict, winner: str | None, draw: bool = False) -> None:
    if t["winner"] or t["draw"]:
        return
    t["winner"], t["draw"], t["ended"] = winner, draw, time.time()
    if winner:
        _table_pay.append((winner, t["game"], t["b"] if winner == t["a"] else t["a"]))


def _settle_tables(db) -> None:
    while _table_pay:
        winner, gid, loser = _table_pay.pop(0)
        stat = f"tw_{gid}_{_today()}"
        cur = db.execute("SELECT n FROM game_stats WHERE player_key = ? AND stat = ?", (winner, stat)).fetchone()
        if cur and cur["n"] >= TABLE_WINS_PER_DAY:
            continue
        db.execute("INSERT INTO game_stats (player_key, stat, n) VALUES (?, ?, 1) "
                   "ON CONFLICT(player_key, stat) DO UPDATE SET n = n + 1", (winner, stat))
        db.commit()
        gs.add_money(db, winner, TABLE_GAMES[gid]["prize"])
        diary(db, winner, f"{TABLE_GAMES[gid]['name']}da {_name(db, loser)}ni yutdim 🏆")


def _tick_table(t: dict, now: float) -> None:
    if t["winner"] or t["draw"]:
        return
    if t["game"] == "duel" and (len(t["ans"]) == 2 or now > t["deadline"]):
        sc = {}
        for k in (t["a"], t["b"]):
            ans, at = t["ans"].get(k, ([], now + 999))
            sc[k] = (sum(1 for x, c in zip(ans, t["correct"]) if x == c), -at)
        t["scores"] = {k: v[0] for k, v in sc.items()}
        if sc[t["a"]] == sc[t["b"]]:
            _finish(t, None, draw=True)
        else:
            _finish(t, max(sc, key=sc.get))
    elif t["game"] == "kurash" and now > t["end"]:
        tp = t["taps"]
        if tp[t["a"]] == tp[t["b"]]:
            _finish(t, None, draw=True)
        else:
            _finish(t, max(tp, key=tp.get))
    elif now - t["last"] > 600:   # 10 daqiqa hech kim yurmasa — durang
        _finish(t, None, draw=True)


def _table_json(t: dict, key: str, now: float) -> dict:
    other = t["b"] if key == t["a"] else t["a"]
    out = {"id": t["id"], "game": t["game"], "name": TABLE_GAMES[t["game"]]["name"], "me": key, "other": other,
           "other_name": t["names"][other], "turn": t["turn"], "my_turn": t["turn"] == key, "winner": t["winner"],
           "draw": t["draw"], "prize": TABLE_GAMES[t["game"]]["prize"]}
    g = t["game"]
    if g == "chess":
        color = t["colors"][key]
        out.update(board=t["board"], color=color, check=ch_in_check(t["board"], color),
                   moves=ch_legal(t["board"], color) if t["turn"] == key and not t["winner"] and not t["draw"] else [])
    elif g == "domino":
        hand = t["hands"][key]
        out.update(hand=hand, chain=t["chain"], bone=len(t["bone"]), other_count=len(t["hands"][other]),
                   moves=dm_legal(t, hand) if t["turn"] == key else [], hands=t["hands"] if (t["winner"] or t["draw"]) else None)
    elif g == "duel":
        out.update(qs=t["qs"], answered=key in t["ans"], left=max(0, round(t["deadline"] - now)), scores=t.get("scores"),
                   correct=t["correct"] if (t["winner"] or t["draw"]) else None)
    elif g == "kurash":
        out.update(start_in=max(0, round(t["start"] - now, 1)), left=max(0, round(t["end"] - now, 1)),
                   mine=t["taps"][key], theirs=t["taps"][other])
    return out


@bp.post("/api/game/table/invite")
@login_required
def api_table_invite():
    user = current_user()
    key = game.player_key(user)
    data = request.get_json(silent=True) or {}
    gid, to = data.get("game"), data.get("to")
    if gid not in TABLE_GAMES:
        return _err("Qaysi o'yin?")
    now = time.time()
    if not isinstance(to, str) or to == key or not _online(to, now):
        return _err("U hozir o'yinda emas")
    with _tlock:
        for k in (key, to):
            tid = _tby.get(k)
            if tid in _tables and not (_tables[tid]["winner"] or _tables[tid]["draw"]):
                return _err("Kimdir hozir boshqa o'yinda")
        _tinv[to] = {"from": key, "name": user["name"], "game": gid, "t": now}
    gs._notify(to, f"🎲 {user['name']} sizni {TABLE_GAMES[gid]['name']}ga chaqiryapti! Menyu → «Takliflar»")
    return jsonify(ok=True)


@bp.get("/api/game/table/invites")
@login_required
def api_table_invites():
    key = _me()
    inv = _tinv.get(key)
    if inv and time.time() - inv["t"] > 120:
        inv = None
    return jsonify(invite={"from": inv["from"], "name": inv["name"], "game": inv["game"],
                           "game_name": TABLE_GAMES[inv["game"]]["name"]} if inv else None)


@bp.post("/api/game/table/accept")
@login_required
def api_table_accept():
    user = current_user()
    key = game.player_key(user)
    yes = (request.get_json(silent=True) or {}).get("yes") is not False
    db = get_db()
    with _tlock:
        inv = _tinv.pop(key, None)
        if not inv or time.time() - inv["t"] > 120:
            return _err("Taklif eskirdi")
        if not yes:
            gs._notify(inv["from"], f"{user['name']} taklifni rad etdi")
            return jsonify(table=None)
        t = _new_table(inv["game"], inv["from"], key, {inv["from"]: inv["name"], key: user["name"]})
        out = _table_json(t, key, time.time())
    gs._notify(inv["from"], f"🎲 {user['name']} rozi bo'ldi — {TABLE_GAMES[inv['game']]['name']} boshlandi!")
    _settle_tables(db)
    return jsonify(table=out)


@bp.get("/api/game/table")
@login_required
def api_table():
    key = _me()
    now = time.time()
    with _tlock:
        t = _tables.get(_tby.get(key))
        if t:
            _tick_table(t, now)
        out = _table_json(t, key, now) if t else None
    _settle_tables(get_db())
    return jsonify(table=out)


@bp.post("/api/game/table/move")
@login_required
def api_table_move():
    key = _me()
    data = request.get_json(silent=True) or {}
    now = time.time()
    with _tlock:
        t = _tables.get(_tby.get(key))
        if not t:
            return _err("O'yin yo'q")
        _tick_table(t, now)
        if t["winner"] or t["draw"]:
            return jsonify(table=_table_json(t, key, now))
        other = t["b"] if key == t["a"] else t["a"]
        g = t["game"]
        if g in ("chess", "domino") and t["turn"] != key:
            return _err("Hozir raqibingiz navbati")
        if g == "chess":
            m = data.get("move")
            color = t["colors"][key]
            legal = ch_legal(t["board"], color)
            if not (isinstance(m, list) and len(m) == 2 and tuple(m) in legal):
                return _err("Bunday yurish mumkin emas")
            t["board"] = ch_apply(t["board"], tuple(m))
            oc = t["colors"][other]
            if not ch_legal(t["board"], oc):
                if ch_in_check(t["board"], oc):
                    _finish(t, key)   # mat
                else:
                    _finish(t, None, draw=True)   # pat
            t["turn"] = other
        elif g == "domino":
            hand = t["hands"][key]
            legal = dm_legal(t, hand)
            if data.get("draw"):
                if legal or not t["bone"]:
                    return _err("Yurish bor — tosh olib bo'lmaydi" if legal else "Bozor bo'sh")
                hand.append(t["bone"].pop())
            elif data.get("pass"):
                if legal or t["bone"]:
                    return _err("O'tkazib bo'lmaydi")
                t["passes"] += 1
                t["turn"] = other
                if t["passes"] >= 2:   # yopildi: kimning toshlari yengil — o'sha yutadi
                    s = {k: sum(a + b for a, b in t["hands"][k]) for k in (key, other)}
                    if s[key] == s[other]:
                        _finish(t, None, draw=True)
                    else:
                        _finish(t, min(s, key=s.get))
            else:
                mv = data.get("move")
                if not (isinstance(mv, list) and mv in legal):
                    return _err("Bu toshni u yerga qo'yib bo'lmaydi")
                i, side = mv
                a, b = hand.pop(i)
                ch = t["chain"]
                if not ch:
                    ch.append([a, b])
                elif side == "L":
                    ch.insert(0, [a, b] if b == ch[0][0] else [b, a])
                else:
                    ch.append([a, b] if a == ch[-1][1] else [b, a])
                t["passes"] = 0
                t["turn"] = other
                if not hand:
                    _finish(t, key)
        elif g == "duel":
            ans = data.get("answers")
            if key in t["ans"] or not isinstance(ans, list) or len(ans) != len(t["qs"]):
                return _err("Javoblar qabul qilinmadi")
            t["ans"][key] = (ans, now)
            _tick_table(t, now)
        elif g == "kurash":
            taps = data.get("taps")
            if not isinstance(taps, int) or not 0 <= taps <= 8 or not t["start"] <= now <= t["end"] + 0.5:
                return jsonify(table=_table_json(t, key, now))
            if now - t["tap_at"].get(key, 0) >= 0.35:
                t["tap_at"][key] = now
                bonus = 1 + tget(get_db(), key)["strength"] / 100
                t["taps"][key] += round(taps * bonus)
        t["last"] = now
        out = _table_json(t, key, now)
    _settle_tables(get_db())
    return jsonify(table=out)


@bp.post("/api/game/table/resign")
@login_required
def api_table_resign():
    key = _me()
    with _tlock:
        t = _tables.get(_tby.get(key))
        if t and not (t["winner"] or t["draw"]):
            _finish(t, t["b"] if key == t["a"] else t["a"])
        _tby.pop(key, None)
    _settle_tables(get_db())
    return jsonify(table=None)


# =========================================================================== #
#  Arqon tortish (bog'da, ikki jamoa)
# =========================================================================== #
_tug: dict = {}
TUG_LOBBY, TUG_PLAY, TUG_PRIZE = 20, 15, 3000


def _tug_side(p) -> str:
    return "L" if p["x"] < SPOTS["rope"]["x"] else "R"


@bp.post("/api/game/tug/start")
@login_required
def api_tug_start():
    user = current_user()
    key = game.player_key(user)
    now = time.time()
    p = _near_pt(key, SPOTS["rope"], 260)
    if not p:
        return _err("Bog'dagi arqon oldiga boring")
    with _tlock:
        if _tug and _tug["phase"] != "done":
            return _err("Arqon tortish allaqachon boshlangan — qo'shiling!")
        _tug.clear()
        _tug.update(phase="lobby", ends=now + TUG_LOBBY, sides={key: _tug_side(p)}, taps={"L": 0, "R": 0}, tap_at={})
    _announce("🪢 Arqon tortish", f"{user['name']} arqon tortishni boshladi! {TUG_LOBBY} soniyada bog'dagi arqon yoniga keling (chap yoki o'ng tomonga)")
    return jsonify(ok=True)


@bp.post("/api/game/tug/join")
@login_required
def api_tug_join():
    key = _me()
    p = _near_pt(key, SPOTS["rope"], 300)
    with _tlock:
        if not _tug or _tug["phase"] != "lobby":
            return _err("Hozir qo'shilib bo'lmaydi")
        if not p:
            return _err("Arqon yoniga boring")
        _tug["sides"][key] = _tug_side(p)
    return jsonify(ok=True)


@bp.post("/api/game/tug/tap")
@login_required
def api_tug_tap():
    key = _me()
    taps = (request.get_json(silent=True) or {}).get("taps")
    now = time.time()
    with _tlock:
        if not _tug or _tug["phase"] != "play" or key not in _tug["sides"] or not isinstance(taps, int) or not 0 <= taps <= 8:
            return jsonify(ok=False)
        if now - _tug["tap_at"].get(key, 0) >= 0.35:
            _tug["tap_at"][key] = now
            _tug["taps"][_tug["sides"][key]] += taps
    return jsonify(ok=True)


def _tug_tick(db, now: float) -> None:
    pay = []
    with _tlock:
        if not _tug:
            return
        if _tug["phase"] == "lobby" and now > _tug["ends"]:
            sides = set(_tug["sides"].values())
            if len(sides) < 2:
                _tug.update(phase="done", ends=now + 8, result="Ikkala tomonda ham kamida bitta o'yinchi kerak edi", win=None)
            else:
                _tug.update(phase="play", ends=now + TUG_PLAY)
        elif _tug["phase"] == "play" and now > _tug["ends"]:
            L, R = _tug["taps"]["L"], _tug["taps"]["R"]
            win = None if L == R else ("L" if L > R else "R")
            _tug.update(phase="done", ends=now + 10, win=win, result="Durang!" if not win else f"{'Chap' if win == 'L' else 'O‘ng'} jamoa yutdi! 🎉")
            pay = [k for k, s in _tug["sides"].items() if s == win]
        elif _tug["phase"] == "done" and now > _tug["ends"]:
            _tug.clear()
    for k in pay:
        gs.add_money(db, k, TUG_PRIZE)


def _tug_json(key: str, now: float) -> dict | None:
    if not _tug:
        return None
    return {"phase": _tug["phase"], "left": max(0, round(_tug["ends"] - now)), "side": _tug["sides"].get(key),
            "L": sum(1 for s in _tug["sides"].values() if s == "L"), "R": sum(1 for s in _tug["sides"].values() if s == "R"),
            "taps": _tug["taps"], "win": _tug.get("win"), "result": _tug.get("result")}


# =========================================================================== #
#  Ko'pkari (otda, uloqni qozonga olib borish)
# =========================================================================== #
_uloq: dict = {}
KOPKARI_PRIZE = 10000


def _uloq_spawn(now: float) -> None:
    k = KOPKARI
    _uloq.clear()
    _uloq.update(x=random.uniform(k["x"] + 120, k["x"] + k["w"] - 120), y=random.uniform(k["y"] + 80, k["y"] + k["h"] - 80),
                 holder=None, name=None, at=now)


def _on_horse(key: str, now: float):
    p = _online(key, now)
    return p if p and p.get("car") == "horse" else None


@bp.post("/api/game/kopkari/grab")
@login_required
def api_kopkari_grab():
    user = current_user()
    key = game.player_key(user)
    now = time.time()
    p = _on_horse(key, now)
    if not p:
        return _err("Ko'pkari faqat otda chopiladi 🐎 (Avtosalonda ot bor)")
    with _tlock:
        if not _uloq or _uloq.get("wait", 0) > now:
            return _err("Uloq hali tashlanmadi")
        if _uloq["holder"] == key:
            return _err("Uloq sizda!")
        if _uloq["holder"]:
            h = _online(_uloq["holder"], now)
            if h and math.hypot(h["x"] - p["x"], h["y"] - p["y"]) > 90:
                return _err("Yaqinroq boring")
        elif math.hypot(_uloq["x"] - p["x"], _uloq["y"] - p["y"]) > 80:
            return _err("Uloqqa yaqinroq boring")
        _uloq.update(holder=key, name=user["name"], at=now)
    return jsonify(ok=True)


@bp.post("/api/game/kopkari/score")
@login_required
def api_kopkari_score():
    user = current_user()
    key = game.player_key(user)
    now = time.time()
    with _tlock:
        if _uloq.get("holder") != key:
            return _err("Uloq sizda emas")
        if not _near_pt(key, SPOTS["kopkari_goal"], 110):
            return _err("Qozonga (maydon o'rtasidagi aylana) olib boring")
        _uloq_spawn(now)
        _uloq["wait"] = now + 15
    db = get_db()
    gs.add_money(db, key, KOPKARI_PRIZE)
    _announce("🐎 Ko'pkari", f"{user['name']} uloqni qozonga tashladi! +{_money(KOPKARI_PRIZE)} so'm. Yangi uloq 15 soniyadan keyin")
    diary(db, key, "Ko'pkarida uloqni qozonga tashladim 🐎")
    return jsonify(pay=KOPKARI_PRIZE, economy=_econ(db, key))


def _uloq_tick(now: float) -> dict | None:
    with _tlock:
        if not _uloq:
            _uloq_spawn(now)
        if _uloq["holder"]:
            h = _online(_uloq["holder"], now)
            if not h or h.get("car") != "horse":   # otdan tushdi — uloq yerga tushadi
                if h:
                    _uloq.update(x=h["x"], y=h["y"])
                _uloq.update(holder=None, name=None)
            else:
                _uloq.update(x=h["x"], y=h["y"])
        return {"x": round(_uloq["x"]), "y": round(_uloq["y"]), "holder": _uloq["holder"], "name": _uloq["name"],
                "wait": max(0, round(_uloq.get("wait", 0) - now))}


# =========================================================================== #
#  Xazina xaritasi
# =========================================================================== #
CLUES = [("cave", "Tog'dagi qorong'i yo'lak oldida 🕳️"), ("nightmarket", "Oy chiqqanda ochiladigan bozorda 🌙"),
         ("bank", "Pul saqlanadigan bino eshigi oldida 🏦"), ("clock", "Har soatda qo'ng'iroq chaladigan minora tagida 🕐"),
         ("icecream", "Bolalar sevadigan sovuq shirinlik aravachasi yonida 🍦"), ("cinema", "Katta ekranda kino ko'rsatiladigan joyda 🎬"),
         ("post", "Xat va posilkalar keladigan joyda 📮"), ("pizza", "Issiq pitsa pishadigan joyda 🍕"),
         ("wash", "Mashinalar yuviladigan joyda 🧽"), ("court", "To'p savatga tashlanadigan maydonda 🏀"),
         ("stage", "Qo'shiq aytiladigan sahna oldida 🎤")]
TREASURE_PRIZE = 15000
_hunts: dict[str, dict] = {}


def _clue_pt(pid: str) -> dict:
    p = TOWN_PLACES.get(pid) or game.PLACES[pid]
    return p.get("door") or p.get("spot")


@bp.post("/api/game/treasure/start")
@login_required
def api_treasure_start():
    key = _me()
    db = get_db()
    if db.execute("SELECT 1 FROM game_claims WHERE player_key = ? AND kind = 'treasure' AND day = ?", (key, _today())).fetchone():
        return _err("Bugungi xazinani topgansiz — ertaga yangi xarita 🗺️")
    path = random.sample(CLUES, 3)
    _hunts[key] = {"path": path, "i": 0}
    return jsonify(clue=path[0][1], step=1, total=3)


@bp.post("/api/game/treasure/check")
@login_required
def api_treasure_check():
    key = _me()
    h = _hunts.get(key)
    if not h:
        return _err("Avval xaritani oling")
    pid, _ = h["path"][h["i"]]
    if not _near_pt(key, _clue_pt(pid), 150):
        return _err("Bu yerda hech narsa yo'q… maslahatni yana o'qing 🤔")
    h["i"] += 1
    if h["i"] < len(h["path"]):
        return jsonify(clue=h["path"][h["i"]][1], step=h["i"] + 1, total=len(h["path"]))
    _hunts.pop(key, None)
    db = get_db()
    if not _claim_once(db, key, "treasure"):
        return _err("Bugungi xazina olingan")
    gs.add_money(db, key, TREASURE_PRIZE)
    diary(db, key, "Xazina xaritasi bo'yicha sandiq topdim 🗺️💰")
    return jsonify(done=True, pay=TREASURE_PRIZE, economy=_econ(db, key))


# =========================================================================== #
#  Matematik poyga (hamma birga, 10 ta misol)
# =========================================================================== #
_math: dict = {}
MATH_GOAL, MATH_PRIZE, MATH_LOBBY, MATH_TIME = 10, 8000, 20, 120


def _math_q() -> dict:
    op = random.choice("+-×")
    if op == "×":
        a, b = random.randint(2, 12), random.randint(2, 12)
        r = a * b
    else:
        a, b = random.randint(10, 99), random.randint(2, 60)
        if op == "-" and b > a:
            a, b = b, a
        r = a + b if op == "+" else a - b
    return {"text": f"{a} {op} {b} = ?", "r": r}


@bp.post("/api/game/math/start")
@login_required
def api_math_start():
    user = current_user()
    key = game.player_key(user)
    now = time.time()
    with _tlock:
        if _math and _math["phase"] != "done":
            return _err("Poyga allaqachon bor — qo'shiling")
        _math.clear()
        _math.update(phase="lobby", ends=now + MATH_LOBBY, players={key: {"n": 0, "q": _math_q(), "name": user["name"], "wait": 0}}, winner=None)
    _announce("➗ Matematik poyga", f"{user['name']} matematik poyga boshladi! {MATH_LOBBY} soniyada qo'shiling: Menyu → «Matematik poyga»")
    return jsonify(math=_math_json(key, now))


@bp.post("/api/game/math/join")
@login_required
def api_math_join():
    user = current_user()
    key = game.player_key(user)
    now = time.time()
    with _tlock:
        if not _math or _math["phase"] != "lobby":
            return _err("Hozir qo'shilib bo'lmaydi")
        _math["players"].setdefault(key, {"n": 0, "q": _math_q(), "name": user["name"], "wait": 0})
    return jsonify(math=_math_json(key, now))


@bp.post("/api/game/math/answer")
@login_required
def api_math_answer():
    key = _me()
    a = (request.get_json(silent=True) or {}).get("a")
    now = time.time()
    pay = 0
    with _tlock:
        _math_tick(now)
        p = _math.get("players", {}).get(key)
        if not p or _math["phase"] != "play":
            return _err("Poyga ketmayapti")
        if p["wait"] > now:
            return _err("Xato edi — 2 soniya kuting")
        if a == p["q"]["r"]:
            p["n"] += 1
            p["q"] = _math_q()
            if p["n"] >= MATH_GOAL and not _math["winner"]:
                _math["winner"] = key
                _math.update(phase="done", ends=now + 12)
                pay = MATH_PRIZE
        else:
            p["wait"] = now + 2
        out = _math_json(key, now)
    if pay:
        db = get_db()
        gs.add_money(db, key, pay)
        _announce("➗ Matematik poyga", f"{out['players'][0]['name']} birinchi bo'lib {MATH_GOAL} ta misolni yechdi! +{_money(pay)} so'm")
    return jsonify(math=out)


def _math_tick(now: float) -> None:
    if not _math:
        return
    if _math["phase"] == "lobby" and now > _math["ends"]:
        _math.update(phase="play", ends=now + MATH_TIME)
    elif _math["phase"] == "play" and now > _math["ends"]:
        _math.update(phase="done", ends=now + 12)
    elif _math["phase"] == "done" and now > _math["ends"]:
        _math.clear()


def _math_json(key: str, now: float) -> dict | None:
    if not _math:
        return None
    p = _math["players"].get(key)
    return {"phase": _math["phase"], "left": max(0, round(_math["ends"] - now)), "joined": bool(p),
            "q": p["q"]["text"] if p and _math["phase"] == "play" else None, "n": p["n"] if p else 0, "goal": MATH_GOAL,
            "winner": _math["players"][_math["winner"]]["name"] if _math["winner"] else None,
            "players": sorted([{"name": v["name"], "n": v["n"]} for v in _math["players"].values()], key=lambda v: -v["n"])}


@bp.get("/api/game/math")
@login_required
def api_math():
    key = _me()
    now = time.time()
    with _tlock:
        _math_tick(now)
        return jsonify(math=_math_json(key, now))


# =========================================================================== #
#  O'yinlar markazi: bitta o'yinchi o'yinlari (tennis, bouling, darts, ritm, xotira, suv osti)
# =========================================================================== #
ARCADE = {"tennis": {"name": "Tennis", "rate": 300, "max": 30, "min": 10},
          "bowling": {"name": "Bouling", "rate": 30, "max": 300, "min": 8},
          "darts": {"name": "Darts", "rate": 20, "max": 300, "min": 6},
          "rhythm": {"name": "Ritm", "rate": 40, "max": 200, "min": 15},
          "memory": {"name": "Xotira", "rate": 600, "max": 12, "min": 8},
          "sub": {"name": "Suv osti kemasi", "rate": 200, "max": 40, "min": 15, "place": "sub"}}
ARCADE_DAY_CAP = 15000
_arcade: dict[str, dict] = {}


def _arcade_place_ok(key: str, place: str | None) -> bool:
    return _near_pt(key, SPOTS["sub"], 220) is not None if place == "sub" else True


@bp.post("/api/game/arcade/start")
@login_required
def api_arcade_start():
    key = _me()
    gid = (request.get_json(silent=True) or {}).get("game")
    g = ARCADE.get(gid)
    if not g:
        return _err("Qaysi o'yin?")
    if not _arcade_place_ok(key, g.get("place")):
        return _err("Plyajdagi suv osti kemasi bekatiga boring")
    _arcade[key] = {"game": gid, "t": time.time()}
    return jsonify(ok=True)


@bp.post("/api/game/arcade/finish")
@login_required
def api_arcade_finish():
    key = _me()
    data = request.get_json(silent=True) or {}
    st = _arcade.pop(key, None)
    score = data.get("score")
    if not st or st["game"] != data.get("game") or not isinstance(score, int) or score < 0:
        return _err("O'yin topilmadi")
    g = ARCADE[st["game"]]
    if time.time() - st["t"] < g["min"]:
        return _err("Juda tez 🤔")
    score = min(score, g["max"])
    db = get_db()
    stat = f"arc_{st['game']}_{_today()}"
    row = db.execute("SELECT n FROM game_stats WHERE player_key = ? AND stat = ?", (key, stat)).fetchone()
    got = row["n"] if row else 0
    pay = max(0, min(score * g["rate"], ARCADE_DAY_CAP - got))
    if pay:
        db.execute("INSERT INTO game_stats (player_key, stat, n) VALUES (?, ?, ?) "
                   "ON CONFLICT(player_key, stat) DO UPDATE SET n = n + excluded.n", (key, stat, pay))
        db.commit()
        gs.add_money(db, key, pay)
    pearls = 0
    if st["game"] == "sub" and score:
        pearls = min(5, score // 8)
        if pearls:
            gc.add_item(db, key, "marvarid", pearls)
    best = gc._record(db, f"arc_{st['game']}", key, -score) if score else False
    return jsonify(pay=pay, pearls=pearls, best=best, capped=pay < score * g["rate"], economy=_econ(db, key))


@bp.get("/api/game/arcade/top/<gid>")
@login_required
def api_arcade_top(gid: str):
    if gid not in ARCADE:
        return _err("?")
    top = gc._top(get_db(), f"arc_{gid}")
    for t in top:
        t["best"] = -t["best"]
    return jsonify(top=top)


# =========================================================================== #
#  IJTIMOIY
# =========================================================================== #
TELEPORT_PRICE = 2000


@bp.post("/api/game/friends/goto")
@login_required
def api_friend_goto():
    key = _me()
    who = (request.get_json(silent=True) or {}).get("key")
    db = get_db()
    ok = db.execute("SELECT 1 FROM game_friends WHERE status = 'ok' AND ((a = ? AND b = ?) OR (a = ? AND b = ?))",
                    (key, who, who, key)).fetchone()
    if not ok:
        return _err("Faqat do'stingiz oldiga teleport qilish mumkin")
    if key in game.RACE_AREA_KEYS:
        return _err("Poyga paytida bo'lmaydi")
    p = _online(who)
    if not p:
        return _err("Do'stingiz hozir o'yinda emas")
    err = _spend(db, key, TELEPORT_PRICE, "Teleport")
    if err:
        return err
    with game._lock:
        game._teleports[key] = (p["x"] + 45, p["y"], 0.0)
    gs._notify(who, f"✨ {_name(db, key)} sizning yoningizga teleport bo'ldi!")
    return jsonify(x=p["x"] + 45, y=p["y"], economy=_econ(db, key))


# ---- Harakatlar (qo'l silkitish, raqs, kulish, chapak, sakrash) ----
ACTS = ("wave", "dance", "laugh", "clap", "jump", "bow")
_acts: dict[str, dict] = {}
_honks: dict[str, float] = {}


@bp.post("/api/game/act")
@login_required
def api_act():
    key = _me()
    a = (request.get_json(silent=True) or {}).get("a")
    if a not in ACTS:
        return _err("?")
    _acts[key] = {"a": a, "t": time.time()}
    return jsonify(ok=True)


@bp.post("/api/game/honk")
@login_required
def api_honk():
    key = _me()
    now = time.time()
    if now - _honks.get(key, 0) > 1.2:
        _honks[key] = now
    return jsonify(ok=True)


# ---- Mahalla yig'ini ----
MEETING_PRICE = 1000


@bp.get("/api/game/meeting")
@login_required
def api_meeting():
    key = _me()
    db = get_db()
    now = time.time()
    people = gs._people(db)
    rows = db.execute("SELECT * FROM game_meeting ORDER BY id DESC LIMIT 20").fetchall()
    out = []
    for r in rows:
        votes = db.execute("SELECT player_key, yes FROM game_meeting_votes WHERE mid = ?", (r["id"],)).fetchall()
        mine = next((v["yes"] for v in votes if v["player_key"] == key), None)
        out.append({"id": r["id"], "text": r["text"], "author": people.get(r["author"], {}).get("name", "?"), "open": r["until"] > now,
                    "yes": sum(1 for v in votes if v["yes"]), "no": sum(1 for v in votes if not v["yes"]), "mine": mine,
                    "left_h": max(0, round((r["until"] - now) / 3600, 1)), "can_delete": _is_owner() or r["author"] == key})
    return jsonify(items=out, price=MEETING_PRICE)


@bp.post("/api/game/meeting")
@login_required
def api_meeting_add():
    key = _me()
    text = str((request.get_json(silent=True) or {}).get("text") or "").strip()
    if not 5 <= len(text) <= 200:
        return _err("Masalani 5–200 belgida yozing")
    db = get_db()
    if db.execute("SELECT 1 FROM game_meeting WHERE author = ? AND until > ?", (key, time.time())).fetchone():
        return _err("Sizning masalangiz hali ochiq — tugashini kuting")
    err = _spend(db, key, MEETING_PRICE, "Yig'inga masala qo'yish")
    if err:
        return err
    db.execute("INSERT INTO game_meeting (author, text, at, until) VALUES (?, ?, ?, ?)", (key, text, time.time(), time.time() + 86400))
    db.commit()
    _announce("🏢 Mahalla yig'ini", f"Yangi masala: «{text[:80]}» — Mahalla idorasida ovoz bering!")
    return api_meeting()


@bp.post("/api/game/meeting/<int:mid>/vote")
@login_required
def api_meeting_vote(mid: int):
    key = _me()
    yes = (request.get_json(silent=True) or {}).get("yes")
    if not isinstance(yes, bool):
        return _err("Ha yoki yo'q?")
    db = get_db()
    r = db.execute("SELECT until FROM game_meeting WHERE id = ?", (mid,)).fetchone()
    if not r or r["until"] < time.time():
        return _err("Ovoz berish tugagan")
    db.execute("INSERT OR REPLACE INTO game_meeting_votes (mid, player_key, yes) VALUES (?, ?, ?)", (mid, key, int(yes)))
    db.commit()
    return api_meeting()


@bp.delete("/api/game/meeting/<int:mid>")
@login_required
def api_meeting_del(mid: int):
    key = _me()
    db = get_db()
    r = db.execute("SELECT author FROM game_meeting WHERE id = ?", (mid,)).fetchone()
    if r and (_is_owner() or r["author"] == key):
        db.execute("DELETE FROM game_meeting WHERE id = ?", (mid,))
        db.execute("DELETE FROM game_meeting_votes WHERE mid = ?", (mid,))
        db.commit()
    return api_meeting()


# ---- Ustoz (mentor) ----
MENTOR_PRIZE = 5000
MENTOR_TIME = 300
_mentor_time: dict[str, float] = {}


@bp.get("/api/game/mentor")
@login_required
def api_mentor():
    key = _me()
    db = get_db()
    d = tget(db, key)
    people = gs._people(db)
    mentees = [r["player_key"] for r in db.execute("SELECT player_key, data FROM game_town").fetchall()
               if json.loads(r["data"]).get("mentor") == key]
    return jsonify(mentor={"key": d["mentor"], "name": people.get(d["mentor"], {}).get("name", "?")} if d["mentor"] else None,
                   mentees=[{"key": k, "name": people.get(k, {}).get("name", "?")} for k in mentees],
                   progress=round(_mentor_time.get(key, 0)), need=MENTOR_TIME, prize=MENTOR_PRIZE)


@bp.post("/api/game/mentor")
@login_required
def api_mentor_set():
    key = _me()
    who = (request.get_json(silent=True) or {}).get("key")
    db = get_db()
    if who is not None:
        ok = db.execute("SELECT 1 FROM game_friends WHERE status = 'ok' AND ((a = ? AND b = ?) OR (a = ? AND b = ?))",
                        (key, who, who, key)).fetchone()
        if not ok:
            return _err("Ustoz do'stlaringizdan biri bo'lishi kerak")
        if tget(db, who).get("mentor") == key:
            return _err("U sizning shogirdingiz")
    tupdate(db, key, lambda d: d.update(mentor=who))
    if who:
        gs._notify(who, f"🎓 {_name(db, key)} sizni ustoz qilib tanladi! Birga 5 daqiqa o'ynasangiz ikkalangizga bonus")
    return api_mentor()


def _mentor_tick(db, key: str, d: dict, dt: float, now: float) -> None:
    m = d.get("mentor")
    if not m:
        return
    a, b = _online(key, now), _online(m, now)
    if not a or not b or math.hypot(a["x"] - b["x"], a["y"] - b["y"]) > 300:
        return
    _mentor_time[key] = _mentor_time.get(key, 0) + dt
    if _mentor_time[key] >= MENTOR_TIME:
        _mentor_time[key] = 0
        if _claim_once(db, key, "mentor"):
            gs.add_money(db, key, MENTOR_PRIZE)
            gs.add_money(db, m, MENTOR_PRIZE)
            gs._notify(key, f"🎓 Ustozingiz bilan o'ynadingiz — ikkalangizga +{_money(MENTOR_PRIZE)} so'm!")
            gs._notify(m, f"🎓 Shogirdingizga yordam berdingiz — +{_money(MENTOR_PRIZE)} so'm!")


# ---- Klan uyi ----
CLAN_HOUSE_PRICE = 200000
CLAN_BONUS = 2000


def _clan_of(db, key: str):
    row = gs._row(db, key)
    if not row or not row["clan"]:
        return None
    return db.execute("SELECT * FROM game_clans WHERE id = ?", (row["clan"],)).fetchone()


def _clan_houses(db) -> list:
    rows = db.execute("SELECT h.slot, c.id, c.name, c.tag, c.color FROM game_clan_house h JOIN game_clans c ON c.id = h.clan").fetchall()
    return [{"slot": r["slot"], "clan": r["id"], "name": r["name"], "tag": r["tag"], "color": r["color"]} for r in rows]


@bp.post("/api/game/clanhouse/buy")
@login_required
def api_clanhouse_buy():
    key = _me()
    db = get_db()
    c = _clan_of(db, key)
    if not c or c["leader"] != key:
        return _err("Klan uyini faqat klan boshlig'i sotib oladi")
    if db.execute("SELECT 1 FROM game_clan_house WHERE clan = ?", (c["id"],)).fetchone():
        return _err("Klaningizning uyi bor")
    used = {r["slot"] for r in db.execute("SELECT slot FROM game_clan_house")}
    free = [s["id"] for s in CLAN_SLOTS if s["id"] not in used]
    if not free:
        return _err("Klanlar ko'chasida bo'sh joy qolmadi")
    cur = db.execute("UPDATE game_clans SET money = money - ? WHERE id = ? AND money >= ?", (CLAN_HOUSE_PRICE, c["id"], CLAN_HOUSE_PRICE))
    if not cur.rowcount:
        db.commit()
        return _err(f"Klan kassasida {_money(CLAN_HOUSE_PRICE)} so'm bo'lishi kerak")
    db.execute("INSERT INTO game_clan_house (slot, clan, at) VALUES (?, ?, ?)", (free[0], c["id"], time.time()))
    db.commit()
    _announce("🏰 Klanlar ko'chasi", f"[{c['tag']}] {c['name']} klani o'z uyini qurdi! (tog' etagida)")
    return jsonify(houses=_clan_houses(db))


@bp.post("/api/game/clanhouse/bonus")
@login_required
def api_clanhouse_bonus():
    key = _me()
    db = get_db()
    c = _clan_of(db, key)
    h = db.execute("SELECT slot FROM game_clan_house WHERE clan = ?", (c["id"],)).fetchone() if c else None
    if not h:
        return _err("Klaningizning uyi yo'q")
    if not _near_pt(key, CLAN_SLOTS[h["slot"]]["door"], 140):
        return _err("Klan uyingiz eshigiga boring")
    if not _claim_once(db, key, "clanbonus"):
        return _err("Bugungi bonusni oldingiz")
    gs.add_money(db, key, CLAN_BONUS)
    return jsonify(pay=CLAN_BONUS, economy=_econ(db, key))


# ---- Klan hududlari ----
ZONE_RADIUS = 130
ZONE_TAKE = 60          # raqib klandan 60 soniya ko'proq tursa — hudud o'tadi
ZONE_INCOME = 2000      # har soatda klan kassasiga
_zone_cap: dict[str, dict] = {z: {} for z in ZONES}
_last_seen: dict[str, float] = {}


def _zones_json(db) -> list:
    rows = {r["zone"]: r for r in db.execute("SELECT * FROM game_zones")}
    clans = {r["id"]: r for r in db.execute("SELECT id, tag, color, name FROM game_clans")}
    out = []
    for z, info in ZONES.items():
        r = rows.get(z)
        c = clans.get(r["clan"]) if r else None
        out.append({"id": z, "name": info["name"], "x": info["x"], "y": info["y"],
                    "clan": {"id": c["id"], "tag": c["tag"], "color": c["color"], "name": c["name"]} if c else None})
    return out


def _zone_tick(db, key: str, row, dt: float, now: float) -> str | None:
    if not row["clan"]:
        return None
    p = _online(key, now)
    if not p:
        return None
    for z, info in ZONES.items():
        if math.hypot(p["x"] - info["x"], p["y"] - info["y"]) > ZONE_RADIUS:
            continue
        cap = _zone_cap[z]
        cap[row["clan"]] = cap.get(row["clan"], 0) + dt
        cur = db.execute("SELECT clan FROM game_zones WHERE zone = ?", (z,)).fetchone()
        owner = cur["clan"] if cur else None
        if owner != row["clan"] and cap[row["clan"]] - cap.get(owner, 0) >= ZONE_TAKE:
            db.execute("INSERT OR REPLACE INTO game_zones (zone, clan, since, paid) VALUES (?, ?, ?, ?)", (z, row["clan"], now, now))
            db.commit()
            _zone_cap[z] = {}
            c = db.execute("SELECT tag, name FROM game_clans WHERE id = ?", (row["clan"],)).fetchone()
            _announce("🚩 Klan hududi", f"[{c['tag']}] {c['name']} klani «{info['name']}» hududini egalladi!")
        return z
    return None


def _zone_income(db, now: float) -> None:
    for r in db.execute("SELECT * FROM game_zones WHERE paid < ?", (now - 3600,)).fetchall():
        hours = min(24, int((now - r["paid"]) // 3600))
        db.execute("UPDATE game_clans SET money = money + ? WHERE id = ?", (hours * ZONE_INCOME, r["clan"]))
        db.execute("UPDATE game_zones SET paid = paid + ? WHERE zone = ?", (hours * 3600, r["zone"]))
    db.commit()


# ---- Reyting taxtasi, haykal, shaharning sekin o'zgaradigan holati ----
def _boards(db) -> dict:
    people = gs._people(db)
    rich = db.execute("SELECT player_key, money FROM game_players WHERE player_key != 'owner' ORDER BY money DESC LIMIT 3").fetchall()
    maze = gc._top(db, "maze")[:3]
    smart = db.execute(RATING_SQL).fetchall()[:3]
    nm = lambda k: people.get(k, {}).get("name", "?")
    return {"rich": [f"{nm(r['player_key'])} — {_money(r['money'])}" for r in rich],
            "fast": [f"{t['name']} — {t['best']} s" for t in maze],
            "smart": [f"{r['name']} — {r['total']} ball" for r in smart]}


def statue_name(db) -> str | None:
    manual = get_setting("game_statue")
    if manual:
        return manual
    since_iso = (datetime.now() - timedelta(days=7)).isoformat(timespec="seconds")
    since_day = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")
    row = db.execute(
        "SELECT u.name, COALESCE((SELECT SUM(s.score) FROM submissions s WHERE s.user_id = u.id AND s.created_at >= ?), 0) "
        "+ COALESCE((SELECT SUM(a.points) FROM attendance a WHERE a.user_id = u.id AND a.day >= ?), 0) AS total "
        "FROM users u ORDER BY total DESC, u.id ASC LIMIT 1", (since_iso, since_day)).fetchone()
    return row["name"] if row and row["total"] > 0 else None


_decor_cache = {"t": 0, "data": {}}


def _decor_all(db) -> dict:
    if time.time() - _decor_cache["t"] < 30:
        return _decor_cache["data"]
    out = {}
    for r in db.execute("SELECT t.player_key, t.data, p.plot FROM game_town t JOIN game_players p ON p.player_key = t.player_key").fetchall():
        dec = json.loads(r["data"]).get("decor") or []
        if dec and r["plot"] is not None:
            out[str(r["plot"])] = dec
    _decor_cache.update(t=time.time(), data=out)
    return out


@bp.get("/api/game/town")
@login_required
def api_town():
    db = get_db()
    raw = get_setting("game_movie")
    return jsonify(statue=statue_name(db), boards=_boards(db), houses=_clan_houses(db), decor=_decor_all(db),
                   zones=_zones_json(db), movie=json.loads(raw)["title"] if raw else None,
                   exam_day=get_setting("exam_day") == _today(), owner=_is_owner(), night=night_open())


@bp.post("/api/game/statue")
@login_required
def api_statue():
    if not _is_owner():
        return _err("Faqat owner", 403)
    name = str((request.get_json(silent=True) or {}).get("name") or "").strip()[:40]
    set_setting("game_statue", name or None)
    return jsonify(statue=statue_name(get_db()))


# ---- Shikoyat ----
@bp.post("/api/game/report")
@login_required
def api_report():
    user = current_user()
    key = game.player_key(user)
    data = request.get_json(silent=True) or {}
    who, reason = data.get("key"), str(data.get("reason") or "").strip()
    db = get_db()
    if not isinstance(who, str) or who not in gs._people(db) or who == key:
        return _err("Kim haqida?")
    if not 3 <= len(reason) <= 300:
        return _err("Sababini yozing (3–300 belgi)")
    if _cooldown(key, "report", 60):
        return _err("Bir daqiqada bitta shikoyat")
    db.execute("INSERT INTO game_reports (from_key, to_key, reason, at) VALUES (?, ?, ?, ?)", (key, who, reason, time.time()))
    db.commit()
    try:
        import classroom
        classroom.notify("owner", f"⚠️ O'yinda shikoyat: {user['name']} → {_name(db, who)}: {reason[:120]}", "/game")
    except Exception:   # bildirishnoma ishlamasa ham shikoyat saqlanadi
        pass
    gs._notify("owner", f"⚠️ Shikoyat: {user['name']} → {_name(db, who)}")
    return jsonify(ok=True)


@bp.get("/api/game/reports")
@login_required
def api_reports():
    if not _is_owner():
        return _err("Faqat owner", 403)
    db = get_db()
    people = gs._people(db)
    rows = db.execute("SELECT * FROM game_reports ORDER BY id DESC LIMIT 50").fetchall()
    return jsonify(items=[{"id": r["id"], "from": people.get(r["from_key"], {}).get("name", "?"), "to": people.get(r["to_key"], {}).get("name", "?"),
                           "to_key": r["to_key"], "reason": r["reason"], "done": bool(r["done"]),
                           "at": datetime.fromtimestamp(r["at"], gf.TASHKENT).strftime("%d.%m %H:%M")} for r in rows])


@bp.post("/api/game/reports/<int:rid>/done")
@login_required
def api_report_done(rid: int):
    if not _is_owner():
        return _err("Faqat owner", 403)
    db = get_db()
    db.execute("UPDATE game_reports SET done = 1 WHERE id = ?", (rid,))
    db.commit()
    return api_reports()


# =========================================================================== #
#  DARS BILAN BOG'LIQ
# =========================================================================== #
def _uid(key: str) -> int | None:
    return int(key[1:]) if key.startswith("u") and key[1:].isdigit() else None


# ---- Uy vazifasi sandig'i ----
CHEST_LOOT = [("money", 3000), ("money", 5000), ("money", 8000), ("money", 20000), ("item", "olmos"), ("item", "marvarid"), ("item", "guldasta")]


def _chests_total(db, key: str) -> int:
    uid = _uid(key)
    if uid is None:
        return 0
    return db.execute("SELECT COUNT(*) FROM submissions WHERE user_id = ?", (uid,)).fetchone()[0]


@bp.get("/api/game/chests")
@login_required
def api_chests():
    key = _me()
    db = get_db()
    return jsonify(available=max(0, _chests_total(db, key) - tget(db, key)["chests"]))


@bp.post("/api/game/chests/open")
@login_required
def api_chest_open():
    key = _me()
    db = get_db()
    with _tlock:
        d = tget(db, key)
        if _chests_total(db, key) - d["chests"] <= 0:
            return _err("Sandiq yo'q — uy vazifasini topshiring, sandiq keladi 📦")
        d["chests"] += 1
        tset(db, key, d)
    kind, val = random.choice(CHEST_LOOT)
    if kind == "money":
        gs.add_money(db, key, val)
        text = f"Sandiqdan {_money(val)} so'm chiqdi! 💰"
    else:
        gc.add_item(db, key, val)
        text = f"Sandiqdan {gc.ITEMS[val]['icon']} {gc.ITEMS[val]['name']} chiqdi!"
    diary(db, key, "Uy vazifasi sandig'ini ochdim: " + text)
    return jsonify(text=text, available=max(0, _chests_total(db, key) - d["chests"]), economy=_econ(db, key))


# ---- Darsga kelgan kuni daromad x2 ----
_att_cache: dict[str, tuple] = {}


def attended_today(db, key: str) -> bool:
    uid = _uid(key)
    if uid is None:
        return False
    day = datetime.now().strftime("%Y-%m-%d")
    c = _att_cache.get(key)
    if c and c[0] == day and time.time() - c[2] < 60:
        return c[1]
    r = db.execute("SELECT status FROM attendance WHERE day = ? AND user_id = ?", (day, uid)).fetchone()
    val = bool(r and r["status"] in ("keldi", "kechikdi"))
    _att_cache[key] = (day, val, time.time())
    return val


_orig_rate = game.player_rate


def _rate_x2(db, row) -> float:
    r = _orig_rate(db, row)
    try:
        return r * 2 if attended_today(db, row["player_key"]) else r
    except Exception:
        return r


game.player_rate = _rate_x2


# ---- Inglizcha so'z ovlash ----
WORDS = [("apple", "olma"), ("book", "kitob"), ("house", "uy"), ("water", "suv"), ("friend", "do'st"), ("school", "maktab"),
         ("teacher", "o'qituvchi"), ("car", "mashina"), ("tree", "daraxt"), ("sun", "quyosh"), ("moon", "oy"), ("star", "yulduz"),
         ("bread", "non"), ("road", "yo'l"), ("city", "shahar"), ("money", "pul"), ("happy", "xursand"), ("fast", "tez"),
         ("slow", "sekin"), ("big", "katta"), ("small", "kichik"), ("red", "qizil"), ("green", "yashil"), ("blue", "ko'k"),
         ("window", "deraza"), ("door", "eshik"), ("computer", "kompyuter"), ("keyboard", "klaviatura"), ("mouse", "sichqoncha"),
         ("code", "kod"), ("river", "daryo"), ("mountain", "tog'"), ("sea", "dengiz"), ("bird", "qush"), ("dog", "it"), ("cat", "mushuk"),
         ("flower", "gul"), ("rain", "yomg'ir"), ("snow", "qor"), ("morning", "ertalab"), ("night", "tun"), ("game", "o'yin")]
WORDS_ON_MAP = 10
WORD_PAY = 1000
_words: dict[int, dict] = {}
_word_id = [0]
_word_q: dict[str, dict] = {}


def _word_spawn() -> None:
    while len(_words) < WORDS_ON_MAP:
        _word_id[0] += 1
        x, y = game._sidewalk_spot()
        en, uz = random.choice(WORDS)
        _words[_word_id[0]] = {"id": _word_id[0], "x": x, "y": y, "en": en, "uz": uz}


@bp.get("/api/game/word/<int:wid>")
@login_required
def api_word(wid: int):
    key = _me()
    w = _words.get(wid)
    if not w or not _near_pt(key, w, 110):
        return _err("So'zga yaqinroq boring")
    opts = [w["uz"]] + random.sample([u for _, u in WORDS if u != w["uz"]], 3)
    random.shuffle(opts)
    _word_q[key] = {"id": wid, "right": w["uz"]}
    return jsonify(en=w["en"], options=opts)


@bp.post("/api/game/word/<int:wid>")
@login_required
def api_word_answer(wid: int):
    key = _me()
    q = _word_q.pop(key, None)
    if not q or q["id"] != wid or wid not in _words:
        return _err("So'z uchib ketdi — boshqasini toping")
    ans = (request.get_json(silent=True) or {}).get("answer")
    if ans != q["right"]:
        return jsonify(ok=False, right=q["right"])
    w = _words.pop(wid)
    _word_spawn()
    db = get_db()
    gs.add_money(db, key, WORD_PAY)
    return jsonify(ok=True, pay=WORD_PAY, text=f"{w['en']} = {w['uz']} ✅", economy=_econ(db, key))


# ---- Kod topshiriqlari -> uy bezaklari ----
CODE_TASKS = [
    {"id": "h1", "title": "Sarlavha", "task": "<h1> sarlavha va uning ostida <p> paragraf yozing.",
     "checks": [r"<h1[^>]*>.+?</h1>", r"<p[^>]*>.+?</p>"], "decor": "fonar", "decor_name": "🏮 Fonarlar"},
    {"id": "list", "title": "Ro'yxat", "task": "<ul> ichida kamida 3 ta <li> bo'lgan ro'yxat yozing.",
     "checks": [r"<ul[^>]*>(?:(?!</ul>).)*(?:<li[^>]*>.*?</li>(?:(?!</ul>).)*){3,}</ul>"], "decor": "gullar", "decor_name": "🌷 Gulzor"},
    {"id": "link", "title": "Havola va rasm", "task": "<a href=\"...\"> havola va alt yozilgan <img> rasm qo'ying.",
     "checks": [r"<a\s[^>]*href\s*=\s*[\"'][^\"']+[\"'][^>]*>.+?</a>", r"<img\s[^>]*alt\s*=\s*[\"'][^\"']+[\"']"], "decor": "bayroq", "decor_name": "🚩 Bayroq"},
    {"id": "flex", "title": "Flexbox", "task": "CSS'da display: flex va justify-content ishlatgan uslub yozing.",
     "checks": [r"display\s*:\s*flex", r"justify-content\s*:\s*[a-z-]+"], "decor": "neon", "decor_name": "💡 Neon yozuv"},
    {"id": "btn", "title": "Tugma va JavaScript", "task": "<button> va unga addEventListener('click', ...) yozing.",
     "checks": [r"<button[^>]*>.+?</button>", r"addEventListener\(\s*[\"']click[\"']"], "decor": "favvora", "decor_name": "⛲ Kichik favvora"},
]


@bp.get("/api/game/codetasks")
@login_required
def api_codetasks():
    d = tget(get_db(), _me())
    return jsonify(tasks=[{"id": t["id"], "title": t["title"], "task": t["task"], "decor": t["decor_name"], "done": t["decor"] in d["decor"]}
                          for t in CODE_TASKS])


@bp.post("/api/game/codetasks/<tid>")
@login_required
def api_codetask_check(tid: str):
    key = _me()
    t = next((x for x in CODE_TASKS if x["id"] == tid), None)
    code = str((request.get_json(silent=True) or {}).get("code") or "")
    if not t or not 10 <= len(code) <= 5000:
        return _err("Kod yozing")
    missing = [c for c in t["checks"] if not re.search(c, code, re.I | re.S)]
    if missing:
        return jsonify(ok=False, text="Hali to'liq emas — topshiriqni yana o'qing 🙂")
    db = get_db()
    first = t["decor"] not in tget(db, key)["decor"]
    if first:
        tupdate(db, key, lambda d: d["decor"].append(t["decor"]) if t["decor"] not in d["decor"] else None)
        _decor_cache["t"] = 0
        gs.add_money(db, key, 5000)
        diary(db, key, f"Kod topshirig'ini bajardim: {t['title']} → uyimga {t['decor_name']}")
    return jsonify(ok=True, first=first, text=f"To'g'ri! Uyingizga {t['decor_name']} qo'shildi" + (" va +5 000 so'm" if first else ""))


# ---- Owner boss ----
_boss: dict = {}
BOSS_TIME = 300
_boss_q: dict[str, dict] = {}


@bp.post("/api/game/boss/start")
@login_required
def api_boss_start():
    if not _is_owner():
        return _err("Faqat owner", 403)
    now = time.time()
    with _tlock:
        if _boss and _boss["ends"] > now and _boss["hp"] > 0:
            return _err("Boss allaqachon maydonda")
        n = max(1, game.online_count())
        f = game.FOUNTAIN
        _boss.clear()
        _boss.update(hp=10 + 6 * n, max=10 + 6 * n, ends=now + BOSS_TIME, hits={}, x=f["x"] - 160, y=f["y"] + 70, done=False)
    _announce("👾 BOSS", "Owner BOSS bo'lib favvora oldiga chiqdi! Hamma yugurib keling — savollarga javob berib uni yenging! (F)")
    return jsonify(ok=True)


@bp.get("/api/game/boss/q")
@login_required
def api_boss_q():
    key = _me()
    now = time.time()
    if not _boss or _boss["ends"] < now or _boss["hp"] <= 0:
        return _err("Boss yo'q")
    if not _near_pt(key, _boss, 450):
        return _err("Bossga yaqinroq boring")
    rng = random.Random()
    pool = [i for i, q in enumerate(quiz.QUESTIONS) if q["topic"] in ("HTML", "CSS")]
    q = quiz.shuffled(rng.choice(pool), rng)
    _boss_q[key] = {"right": q["correct"], "t": now}
    return jsonify(question=q["question"], options=q["options"], hp=_boss["hp"], max=_boss["max"])


@bp.post("/api/game/boss/hit")
@login_required
def api_boss_hit():
    user = current_user()
    key = game.player_key(user)
    a = (request.get_json(silent=True) or {}).get("answer")
    q = _boss_q.pop(key, None)
    now = time.time()
    if not q or not _boss or _boss["hp"] <= 0 or _boss["ends"] < now:
        return _err("Boss yo'q")
    if a != q["right"]:
        return jsonify(ok=False, right=q["right"], hp=_boss["hp"])
    pay = {}
    with _tlock:
        _boss["hp"] -= 1
        _boss["hits"][key] = _boss["hits"].get(key, 0) + 1
        if _boss["hp"] <= 0 and not _boss["done"]:
            _boss["done"] = True
            top = max(_boss["hits"], key=_boss["hits"].get)
            pay = {k: 10000 + (20000 if k == top else 0) for k in _boss["hits"]}
    if pay:
        db = get_db()
        for k, v in pay.items():
            gs.add_money(db, k, v)
            diary(db, k, "Owner bossini birga yengdik! 👾🏆")
        _announce("👾 BOSS", f"BOSS yengildi! 🎉 Hamma ishtirokchiga +10 000, eng ko'p urgan {_name(db, top)}ga yana +20 000 so'm")
    return jsonify(ok=True, hp=max(0, _boss["hp"]), won=bool(pay))


def _boss_json(now: float) -> dict | None:
    if not _boss:
        return None
    if _boss["hp"] <= 0:
        _boss.setdefault("gone", now + 8)
        if now > _boss["gone"]:
            return None
    elif _boss["ends"] < now:
        return None
    return {"hp": _boss["hp"], "max": _boss["max"], "x": _boss["x"], "y": _boss["y"], "left": max(0, round(_boss["ends"] - now))}


# ---- Kitob o'qish va sertifikat ----
BOOKS = [
    {"id": "html", "title": "HTML sirlari", "text": "HTML — veb sahifaning skeleti. Har bir sahifa <html> tegi bilan boshlanadi. "
     "<head> ichida sarlavha va sozlamalar, <body> ichida ko'rinadigan narsalar bo'ladi. Sarlavhalar <h1> dan <h6> gacha: "
     "<h1> eng katta. Havola <a> tegi bilan, rasm esa <img> tegi bilan qo'yiladi va rasmga albatta alt yoziladi.",
     "qs": [("Ko'rinadigan narsalar qaysi teg ichida?", ["<head>", "<body>", "<title>"], 1),
            ("Eng katta sarlavha qaysi?", ["<h6>", "<h3>", "<h1>"], 2), ("Rasmga nima yozish kerak?", ["alt", "href", "class"], 0)]},
    {"id": "css", "title": "CSS bilan bezash", "text": "CSS sahifani chiroyli qiladi. color — matn rangi, background — orqa fon. "
     "margin — elementning tashqi bo'shlig'i, padding — ichki bo'shlig'i. display: flex elementlarni bir qatorga teradi, "
     "justify-content ularni gorizontal joylaydi. Klassga murojaat nuqta bilan yoziladi: .karta { }.",
     "qs": [("Ichki bo'shliq qaysi?", ["margin", "padding", "border"], 1), ("Klass oldidan nima qo'yiladi?", ["#", ".", "@"], 1),
            ("Elementlarni bir qatorga nima teradi?", ["display: flex", "color: red", "font-size"], 0)]},
    {"id": "js", "title": "JavaScript sehri", "text": "JavaScript sahifani jonlantiradi. const — o'zgarmaydigan, let — o'zgaradigan "
     "o'zgaruvchi. document.querySelector elementni topadi. addEventListener('click', ...) tugma bosilganda ishlaydi. "
     "console.log() natijani konsolga chiqaradi.",
     "qs": [("O'zgaradigan o'zgaruvchi qaysi?", ["const", "let", "class"], 1), ("Elementni nima topadi?", ["querySelector", "console.log", "alert"], 0),
            ("Bosishni nima eshitadi?", ["addEventListener", "innerHTML", "push"], 0)]},
    {"id": "uz", "title": "O'zbekiston bo'ylab", "text": "O'zbekiston poytaxti — Toshkent. Samarqanddagi Registon maydonida uchta "
     "madrasa bor. Buxoro — qadimiy shahar, Xiva esa Ichan qal'a bilan mashhur. Navro'z bayrami 21-martda nishonlanadi va "
     "sumalak pishiriladi.",
     "qs": [("Poytaxt qaysi?", ["Samarqand", "Toshkent", "Buxoro"], 1), ("Registonda nechta madrasa?", ["2", "3", "5"], 1),
            ("Navro'z qachon?", ["21-mart", "1-yanvar", "9-may"], 0)]},
]
BOOK_PRIZE = 5000


@bp.get("/api/game/books")
@login_required
def api_books():
    key = _me()
    certs = tget(get_db(), key)["certs"]
    return jsonify(books=[{"id": b["id"], "title": b["title"], "text": b["text"], "passed": b["id"] in certs,
                           "qs": [{"q": q, "options": o} for q, o, _ in b["qs"]]} for b in BOOKS])


@bp.post("/api/game/books/<bid>")
@login_required
def api_book_test(bid: str):
    user = current_user()
    key = game.player_key(user)
    b = next((x for x in BOOKS if x["id"] == bid), None)
    ans = (request.get_json(silent=True) or {}).get("answers")
    if not b or not isinstance(ans, list) or len(ans) != len(b["qs"]):
        return _err("Hamma savolga javob bering")
    right = sum(1 for a, (_, _, c) in zip(ans, b["qs"]) if a == c)
    if right < len(b["qs"]):
        return jsonify(ok=False, right=right, total=len(b["qs"]), text="Kitobni yana bir bor o'qing 🙂")
    db = get_db()
    first = bid not in tget(db, key)["certs"]
    if first:
        tupdate(db, key, lambda d: d["certs"].append(bid) if bid not in d["certs"] else None)
        gs.add_money(db, key, BOOK_PRIZE)
        diary(db, key, f"«{b['title']}» kitobini o'qib sertifikat oldim 📜")
    return jsonify(ok=True, first=first, cert={"name": user["name"], "title": b["title"], "date": _now_tk().strftime("%d.%m.%Y")},
                   pay=BOOK_PRIZE if first else 0, economy=_econ(db, key))


# ---- Imtihon kuni: o'yin yopiladi ----
@bp.post("/api/game/examday")
@login_required
def api_examday():
    if not _is_owner():
        return _err("Faqat owner", 403)
    on = (request.get_json(silent=True) or {}).get("on") is True
    set_setting("exam_day", _today() if on else None)
    if on:
        _announce("📝 Imtihon kuni", "Bugun imtihon kuni — o'yin o'quvchilar uchun yopiladi. Omad! 🍀")
    return jsonify(exam_day=on)


@bp.before_app_request
def _exam_lock():
    path = request.path
    if not (path == "/game" or path.startswith("/api/game")):
        return None
    if path == "/api/game/examday":
        return None
    day = get_setting("exam_day")
    if not day or day != _today():
        return None
    user = current_user()
    if not user or user["role"] == "owner":
        return None
    if path == "/game":
        return ("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
                "<title>Imtihon kuni</title><body style='margin:0;display:grid;place-items:center;min-height:100vh;"
                "font-family:system-ui;background:#0f172a;color:#f8fafc;text-align:center;padding:16px'>"
                "<div><div style='font-size:64px'>📝</div><h1>Bugun imtihon kuni</h1><p>O'yin bugun yopiq. "
                "Imtihonga tayyorlaning — ertaga o'yin yana ochiladi! 🍀</p><p><a style='color:#38bdf8' href='/'>Panelga qaytish</a></p></div>")
    return jsonify(error="Bugun imtihon kuni — o'yin yopiq 📝", exam=True), 423


# =========================================================================== #
#  TRANSPORT
# =========================================================================== #
# ---- Velosiped ijarasi ----
BIKE_RENT = 500
BIKE_TIME = 600
game.RENTALS = getattr(game, "RENTALS", {})


@bp.post("/api/game/rentbike")
@login_required
def api_rent_bike():
    key = _me()
    if not any(_near_pt(key, b, 140) for b in BIKES):
        return _err("Velosiped ijarasi bekatiga boring (bog', plyaj yoki xizmat mahallasida)")
    db = get_db()
    err = _spend(db, key, BIKE_RENT, "Ijara")
    if err:
        return err
    game.RENTALS[key] = ("bike", time.time() + BIKE_TIME)
    return jsonify(car="bike", secs=BIKE_TIME, economy=_econ(db, key))


# ---- Kosmos: Oy bazasi, kislorod, Mars, kosmik stansiya ----
BASE_PRICE = 500000
MARS_PRICE = 2000000
MARS_NEED = 5
_space: dict[str, dict] = {}


def _space_json(db, key: str, now: float) -> dict:
    s = _space.get(key)
    if s and s["until"] < now:
        _space.pop(key, None)
        s = None
    d = tget(db, key)
    row = gs._row(db, key)
    people = gs._people(db)
    return {"where": s["where"] if s else None, "left": round(s["until"] - now) if s else 0, "base": bool(d["base"]),
            "moon": row["moon"], "mars": d["mars"], "mars_need": MARS_NEED, "mars_price": MARS_PRICE, "base_price": BASE_PRICE,
            "oxygen": s.get("oxygen", 0) if s else 0, "rocks": s.get("rocks", 0) if s else 0,
            "station": [people.get(k, {}).get("name", "?") for k, v in _space.items() if v["until"] > now and v["where"] == "station"]}


@bp.post("/api/game/space/arrive")
@login_required
def api_space_arrive():
    key = _me()
    db = get_db()
    row = gs._row(db, key)
    d = tget(db, key)
    if row["moon"] <= d["moon_seen"]:
        return _err("Avval kosmodromdan Oyga uching 🚀")
    tupdate(db, key, lambda d: d.update(moon_seen=row["moon"]))
    _space[key] = {"where": "moon", "until": time.time() + 600, "oxygen": 0, "rocks": 0}
    return jsonify(space=_space_json(db, key, time.time()))


@bp.get("/api/game/space")
@login_required
def api_space():
    key = _me()
    return jsonify(space=_space_json(get_db(), key, time.time()))


@bp.post("/api/game/space/<action>")
@login_required
def api_space_action(action: str):
    user = current_user()
    key = game.player_key(user)
    db = get_db()
    now = time.time()
    s = _space.get(key)
    if not s or s["until"] < now:
        return _err("Siz kosmosda emassiz")
    d = tget(db, key)
    text = ""
    if action == "base":
        if d["base"]:
            return _err("Oyda bazangiz bor")
        if s["where"] != "moon":
            return _err("Baza Oyda quriladi")
        err = _spend(db, key, BASE_PRICE, "Oy bazasi")
        if err:
            return err
        tupdate(db, key, lambda d: d.update(base=1))
        _announce("🌕 Oy", f"{user['name']} Oyda o'z bazasini qurdi! 🏠")
        text = "Oyda bazangiz tayyor! Endi kislorod yig'a olasiz 🫧"
    elif action == "oxygen":
        if not d["base"] or s["where"] != "moon":
            return _err("Kislorodni Oydagi bazada yig'asiz")
        if s.get("oxygen", 0) >= 5:
            return _err("Bu safar 5 ta balon yig'dingiz")
        if _cooldown(key, "oxygen", 30):
            return _err("Balon to'lyapti… 30 soniya")
        s["oxygen"] = s.get("oxygen", 0) + 1
        gc.add_item(db, key, "kislorod")
        text = "Kislorod baloni to'ldi 🫧 (bozorda sotsa bo'ladi)"
    elif action == "mars":
        if gs._row(db, key)["moon"] < MARS_NEED:
            return _err(f"Marsga Oyga {MARS_NEED} marta uchgandan keyin ruxsat")
        err = _spend(db, key, MARS_PRICE, "Mars missiyasi")
        if err:
            return err
        tupdate(db, key, lambda d: d.update(mars=d["mars"] + 1))
        s.update(where="mars", until=now + 600, rocks=0)
        _announce("🔴 Mars", f"{user['name']} MARSGA qo'ndi! 🚀🔴")
        diary(db, key, "Marsga uchdim! 🔴")
        text = "Marsga qo'ndingiz! Qizil toshlarni yig'ing 🪨"
    elif action == "rock":
        if s["where"] != "mars":
            return _err("Toshlar Marsda")
        if s.get("rocks", 0) >= 3:
            return _err("Kema to'ldi — 3 ta tosh")
        if _cooldown(key, "rock", 20):
            return _err("Qidiryapsiz… 20 soniya")
        s["rocks"] = s.get("rocks", 0) + 1
        gc.add_item(db, key, "mars_tosh")
        text = "Mars toshi topildi 🪨"
    elif action == "station":
        s.update(where="station")
        if _claim_once(db, key, "station"):
            gs.add_money(db, key, 10000)
            text = "Kosmik stansiyaga xush kelibsiz! 🛰️ +10 000 so'm (kunlik)"
        else:
            text = "Kosmik stansiyadasiz 🛰️"
    elif action == "moon":
        s.update(where="moon")
        text = "Oyga qaytdingiz 🌕"
    elif action == "home":
        _space.pop(key, None)
        return jsonify(space=None, text="Yerga qaytdingiz 🌍")
    else:
        return _err("?", 404)
    return jsonify(space=_space_json(db, key, now), text=text, economy=_econ(db, key))


# ---- Tuning: spoyler va signal ----
_kit_cache: dict[str, dict] = {}


def _kit_of(db, key: str) -> dict:
    if key not in _kit_cache:
        _kit_cache[key] = tget(db, key)["kit"]
    return _kit_cache[key]

KIT = {"spoiler": 20000, "horn": 5000}
HORNS = ("classic", "melody", "truck")


@bp.post("/api/game/kit")
@login_required
def api_kit():
    key = _me()
    data = request.get_json(silent=True) or {}
    db = get_db()
    d = tget(db, key)
    kit = dict(d["kit"])
    if "spoiler" in data:
        want = data["spoiler"] is True
        if want and not kit.get("spoiler_owned"):
            err = _spend(db, key, KIT["spoiler"], "Spoyler")
            if err:
                return err
            kit["spoiler_owned"] = True
        kit["spoiler"] = want
    if "horn" in data:
        h = data["horn"]
        if h not in HORNS:
            return _err("Qaysi signal?")
        owned = kit.get("horns", ["classic"])
        if h not in owned:
            err = _spend(db, key, KIT["horn"], "Signal")
            if err:
                return err
            owned = owned + [h]
        kit.update(horns=owned, horn=h)
    tupdate(db, key, lambda d: d.update(kit=kit))
    _kit_cache[key] = kit
    return jsonify(kit=kit, prices=KIT, economy=_econ(db, key))


# ---- Ochko tikish (poygada, pul emas) ----
POINTS_DAILY = 100
_bets: dict[int, dict] = {}       # poyga -> {player: (pick, amount)}
_bet_results: list = []           # (poyga, g'olib)


def _points_refill(db, key: str) -> dict:
    if _claim_once(db, key, "points"):
        return tupdate(db, key, lambda d: d.update(points=d["points"] + POINTS_DAILY))
    return tget(db, key)


@bp.get("/api/game/bets")
@login_required
def api_bets():
    key = _me()
    db = get_db()
    _settle_bets(db)
    d = _points_refill(db, key)
    races = []
    for rid, r in list(gs._races.items()):
        if r["winner"] is None and key not in (r["a"], r["b"]):
            mine = _bets.get(rid, {}).get(key)
            races.append({"id": rid, "a": r["a"], "b": r["b"], "a_name": r["names"].get(r["a"], "?"), "b_name": r["names"].get(r["b"], "?"),
                          "mine": {"pick": mine[0], "amount": mine[1]} if mine else None})
    top = db.execute("SELECT player_key, data FROM game_town").fetchall()
    people = gs._people(db)
    board = sorted([(json.loads(r["data"]).get("points", 0), people.get(r["player_key"], {}).get("name", "?")) for r in top], reverse=True)[:5]
    return jsonify(points=d["points"], races=races, top=[{"name": n, "points": p} for p, n in board if p])


@bp.post("/api/game/bets")
@login_required
def api_bet():
    key = _me()
    data = request.get_json(silent=True) or {}
    rid, pick, amount = data.get("race"), data.get("pick"), data.get("amount")
    r = gs._races.get(rid)
    if not r or r["winner"] is not None:
        return _err("Poyga tugagan")
    if key in (r["a"], r["b"]):
        return _err("O'z poygangizga tikib bo'lmaydi")
    if pick not in (r["a"], r["b"]) or not isinstance(amount, int) or not 1 <= amount <= 1000:
        return _err("Kimga va necha ochko?")
    if key in _bets.get(rid, {}):
        return _err("Bu poygaga tikkansiz")
    db = get_db()
    with _tlock:
        d = _points_refill(db, key)
        if d["points"] < amount:
            return _err("Ochko yetmaydi")
        d["points"] -= amount
        tset(db, key, d)
        _bets.setdefault(rid, {})[key] = (pick, amount)
    return api_bets()


_orig_end_race2 = gs._end_race


def _end_race_bets(r: dict, winner: str, now: float) -> None:
    _orig_end_race2(r, winner, now)
    for rid, rr in gs._races.items():
        if rr is r:
            _bet_results.append((rid, winner))


gs._end_race = _end_race_bets


def _settle_bets(db) -> None:
    while _bet_results:
        rid, winner = _bet_results.pop(0)
        for k, (pick, amount) in _bets.pop(rid, {}).items():
            if pick == winner:
                tupdate(db, k, lambda d, a=amount: d.update(points=d["points"] + 2 * a))
                gs._notify(k, f"🎯 Tikkan ochkongiz yutdi! +{2 * amount} ochko")


# =========================================================================== #
#  Sinxron
# =========================================================================== #
_misc = {"zone_pay": 0}


def _town_hook(db, key: str, row, now: float, response: dict) -> None:
    dt = min(1.0, max(0.0, now - _last_seen.get(key, now)))
    _last_seen[key] = now
    d = tget(db, key)
    me = _online(key, now)
    response["town"] = {"x2": attended_today(db, key),
                        "rent": max(0, round(game.RENTALS.get(key, (None, 0))[1] - now)), "kit": d["kit"]}
    # boshqa o'yinchilarning harakatlari, spoyler va signali
    for p in response.get("players", []):
        a = _acts.get(p["key"])
        if a and now - a["t"] < 4:
            p["act"] = a["a"]
        h = _honks.get(p["key"])
        if h and now - h < 1.5:
            p["honk"] = h
        kit = _kit_of(db, p["key"])
        if kit.get("spoiler"):
            p["spoiler"] = True
        if kit.get("horn") and kit["horn"] != "classic":
            p["horn"] = kit["horn"]
    # tadbirlar
    _tug_tick(db, now)
    response["tug"] = _tug_json(key, now) if me and (_inside(me, PARK, 200) or key in _tug.get("sides", {})) else None
    response["uloq"] = _uloq_tick(now) if me and _inside(me, MOUNT, 300) else None
    response["boss"] = _boss_json(now)
    with _tlock:
        _math_tick(now)
        response["math"] = _math_json(key, now) if _math else None
        t = _tables.get(_tby.get(key))
        response["table"] = {"id": t["id"], "game": t["game"], "over": bool(t["winner"] or t["draw"])} if t else None
    if not _words:
        _word_spawn()
    response["words"] = [{"id": w["id"], "x": w["x"], "y": w["y"], "en": w["en"]} for w in _words.values()
                         if me and math.hypot(w["x"] - me["x"], w["y"] - me["y"]) < 1800]
    response["castles"] = [c for c in _castles if c["until"] > now] if me and _inside(me, BEACH, 300) else []
    zone = _zone_tick(db, key, row, dt, now)
    if zone:
        response["zone"] = {"id": zone, "mine": round(_zone_cap[zone].get(row["clan"], 0)),
                            "best": round(max(_zone_cap[zone].values() or [0])), "need": ZONE_TAKE}
    if now - _misc["zone_pay"] > 60:
        _misc["zone_pay"] = now
        _zone_income(db, now)
        _settle_bets(db)
    _mentor_tick(db, key, d, dt, now)
    if _visits.get(key) and _visits[key][1] < now:
        _visits.pop(key, None)
    inv = _home_inv.get(key)
    tinv = _tinv.get(key)
    response["invites"] = {"home": inv["name"] if inv and now - inv["t"] < 600 else None,
                           "table": {"name": tinv["name"], "game": TABLE_GAMES[tinv["game"]]["name"]} if tinv and now - tinv["t"] < 120 else None}


game.SYNC_HOOKS.append(_town_hook)
game.EVENT_HOOKS.append(_diary_hook)


SCHEMA = """
CREATE TABLE IF NOT EXISTS game_town (
    player_key TEXT PRIMARY KEY,
    data       TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS game_diary (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    player_key TEXT NOT NULL,
    text       TEXT NOT NULL,
    auto       INTEGER NOT NULL DEFAULT 1,
    at         REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS game_diary_key ON game_diary (player_key, id);
CREATE TABLE IF NOT EXISTS game_meeting (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    author TEXT NOT NULL,
    text   TEXT NOT NULL,
    at     REAL NOT NULL,
    until  REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS game_meeting_votes (
    mid        INTEGER NOT NULL,
    player_key TEXT NOT NULL,
    yes        INTEGER NOT NULL,
    PRIMARY KEY (mid, player_key)
);
CREATE TABLE IF NOT EXISTS game_reports (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    from_key TEXT NOT NULL,
    to_key   TEXT NOT NULL,
    reason   TEXT NOT NULL,
    at       REAL NOT NULL,
    done     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS game_zones (
    zone  TEXT PRIMARY KEY,
    clan  INTEGER NOT NULL,
    since REAL NOT NULL,
    paid  REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS game_clan_house (
    slot INTEGER PRIMARY KEY,
    clan INTEGER NOT NULL UNIQUE,
    at   REAL NOT NULL
);
"""
