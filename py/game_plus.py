"""Yangi shahar qo'shimchalari: osmono'par lifti, drift trassasi, haftalik ko'rgazmalar
(mashina va moda), kiyim do'koni, kod bilan uy fasadi, "bug ovchisi" missiyalari,
uy hayvoni parvarishi, hokim farmoni va konsertdagi eng ko'p qarsak olganlar.
"""
import hashlib
import json
import math
import random
import time
from datetime import datetime, timedelta

from flask import Blueprint, jsonify, request

import codecheck
import game
import game_fun as gf
import game_life as gl
import game_social as gs
import game_town as gt
from core import current_user, get_db, login_required

bp = Blueprint("game_plus", __name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS game_show_entries (
    week TEXT NOT NULL, kind TEXT NOT NULL, player_key TEXT NOT NULL, data TEXT NOT NULL, at REAL NOT NULL,
    PRIMARY KEY (week, kind, player_key)
);
CREATE TABLE IF NOT EXISTS game_show_votes (
    week TEXT NOT NULL, kind TEXT NOT NULL, voter TEXT NOT NULL, cand TEXT NOT NULL,
    PRIMARY KEY (week, kind, voter)
);
CREATE TABLE IF NOT EXISTS game_show_paid (
    week TEXT NOT NULL, kind TEXT NOT NULL, winner TEXT, votes INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (week, kind)
);
CREATE TABLE IF NOT EXISTS game_wardrobe (
    player_key TEXT NOT NULL, item TEXT NOT NULL, at REAL NOT NULL,
    PRIMARY KEY (player_key, item)
);
CREATE TABLE IF NOT EXISTS game_drift (
    player_key TEXT PRIMARY KEY, best INTEGER NOT NULL DEFAULT 0, day TEXT, paid INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS game_facade (
    player_key TEXT PRIMARY KEY, html TEXT NOT NULL, css TEXT NOT NULL, at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS game_bugfix (
    day TEXT NOT NULL, spot INTEGER NOT NULL, fixer TEXT NOT NULL, at REAL NOT NULL,
    PRIMARY KEY (day, spot)
);
CREATE TABLE IF NOT EXISTS game_pet_care (
    player_key TEXT PRIMARY KEY, name TEXT, xp INTEGER NOT NULL DEFAULT 0, fed_at REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS game_decree (
    day TEXT PRIMARY KEY, player_key TEXT NOT NULL, text TEXT NOT NULL, at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS weekly_top (
    week TEXT PRIMARY KEY, user_key TEXT NOT NULL, gift TEXT NOT NULL, at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS game_stage_best (
    player_key TEXT PRIMARY KEY, claps INTEGER NOT NULL DEFAULT 0, at REAL NOT NULL
);
"""


def upgrade(db) -> None:
    """Eski bazaga yangi ustunlar."""
    cols = {r[1] for r in db.execute("PRAGMA table_info(game_candidates)")}
    if cols and "program" not in cols:
        db.execute("ALTER TABLE game_candidates ADD COLUMN program TEXT")


def _me() -> str:
    return game.player_key(current_user())


def _err(text: str, code: int = 400):
    return jsonify(error=text), code


def _json() -> dict:
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def _money(n) -> str:
    return f"{int(n):,}".replace(",", " ")


def _now_tk() -> datetime:
    return datetime.now(gf.TASHKENT)


def _today() -> str:
    return _now_tk().strftime("%Y-%m-%d")


def week_id(dt: datetime | None = None) -> str:
    y, w, _ = (dt or _now_tk()).isocalendar()
    return f"{y}-W{w:02d}"


def _live(key: str, now: float):
    p = game._live.get(key)
    return p if p and now - p["t"] < game.ONLINE_SECONDS else None


def _near(key: str, pt: dict, r: float) -> bool:
    p = _live(key, time.time())
    return bool(p) and math.hypot(p["x"] - pt["x"], p["y"] - pt["y"]) < r


def _announce(name: str, text: str) -> None:
    with game._lock:
        game._chat.append({"id": next(game._msg_ids), "key": "owner", "name": name, "avatar": None, "t": time.time(), "text": text})


def _econ(db, key: str) -> dict:
    return game.economy_json(db, gs._row(db, key))


def _pay(db, key: str, price: int, what: str):
    """Pul yechish (yetmasa — xato javobi), aks holda None."""
    def change(row, money):
        if money < price:
            raise game.GameError(f"{what} uchun {_money(price)} so'm kerak")
        return -price, None
    _, err = gs._change(db, key, change)
    return err


# --------------------------------------------------------------------------- #
#  1. Osmono'par lifti: eshik oldida F — tomga chiqasiz, P — parashyutda tushasiz
# --------------------------------------------------------------------------- #
def roof_top(x: float, y: float) -> float:
    for t in gt.CITY_TOWERS:
        if t["x"] <= x <= t["x"] + t["w"] and t["y"] <= y <= t["y"] + t["h"]:
            return t["hgt"]
    return 0


game.ROOF_TOP = roof_top


@bp.post("/api/game/lift")
@login_required
def api_lift():
    key = _me()
    tid = _json().get("tower")
    tower = next((t for t in gt.CITY_TOWERS if t["id"] == tid), None)
    if not tower:
        return _err("Bino topilmadi")
    down = bool(_json().get("down"))
    p = _live(key, time.time())
    if not p or p.get("car"):
        return _err("Liftga piyoda kiring")
    if down:
        if roof_top(p["x"], p["y"]) != tower["hgt"]:
            return _err("Siz bu bino tomida emassiz")
        door = tower["door"]
        with game._lock:
            game._teleports[key] = (door["x"], door["y"] + 10, math.pi / 2)
            p["h"] = 0
        return jsonify(ok=True, x=door["x"], y=door["y"] + 10)
    if not _near(key, tower["door"], 110):
        return _err("Bino eshigiga yaqin boring")
    cx, cy = tower["x"] + tower["w"] / 2, tower["y"] + tower["h"] / 2
    with game._lock:
        game._teleports[key] = (cx, cy, math.pi / 2)
        p["h"] = tower["hgt"]
    return jsonify(ok=True, x=cx, y=cy, h=tower["hgt"])


# --------------------------------------------------------------------------- #
#  7. Drift trassasi: maydonda drift qilsangiz ochko — ochkoga pul (kunlik chegara)
# --------------------------------------------------------------------------- #
DRIFT_RATE = 60          # soniyasiga eng ko'p ochko
DRIFT_PAY = 0.2          # 1 ochko = 0.2 so'm... 5 ochko = 1 so'm
DRIFT_DAY_CAP = 15000
_drift_last: dict[str, float] = {}


def _in_drift(p) -> bool:
    d = gt.DRIFT
    return bool(p) and d["x"] - 40 <= p["x"] <= d["x"] + d["w"] + 40 and d["y"] - 40 <= p["y"] <= d["y"] + d["h"] + 40


def _drift_top(db) -> list:
    people = gs._people(db)
    return [{"name": people[r["player_key"]]["name"], "best": r["best"]}
            for r in db.execute("SELECT player_key, best FROM game_drift WHERE best > 0 ORDER BY best DESC LIMIT 10")
            if r["player_key"] in people]


@bp.get("/api/game/drift")
@login_required
def api_drift():
    key = _me()
    db = get_db()
    row = db.execute("SELECT * FROM game_drift WHERE player_key = ?", (key,)).fetchone()
    paid = row["paid"] if row and row["day"] == _today() else 0
    return jsonify(top=_drift_top(db), best=row["best"] if row else 0, paid=paid, cap=DRIFT_DAY_CAP)


@bp.post("/api/game/drift")
@login_required
def api_drift_score():
    key = _me()
    data = _json()
    try:
        points = max(0, int(data.get("points") or 0))
        secs = max(0.0, float(data.get("secs") or 0))
    except (TypeError, ValueError):
        return _err("Noto'g'ri ochko")
    now = time.time()
    p = _live(key, now)
    if not p or not p.get("car") or not _in_drift(p):
        return _err("Drift trassasida mashinada bo'ling")
    since = now - _drift_last.get(key, 0)
    _drift_last[key] = now
    secs = min(secs, since + 2, 120)
    points = min(points, int(secs * DRIFT_RATE))
    db = get_db()
    row = db.execute("SELECT * FROM game_drift WHERE player_key = ?", (key,)).fetchone()
    today = _today()
    paid = row["paid"] if row and row["day"] == today else 0
    money = max(0, min(int(points * DRIFT_PAY), DRIFT_DAY_CAP - paid))
    best = max(points, row["best"] if row else 0)
    db.execute("INSERT INTO game_drift (player_key, best, day, paid) VALUES (?, ?, ?, ?) "
               "ON CONFLICT(player_key) DO UPDATE SET best = excluded.best, day = excluded.day, paid = excluded.paid",
               (key, best, today, paid + money))
    db.commit()
    if money:
        gs.add_money(db, key, money)
    record = bool(row is None or points > row["best"]) and points > 0
    if record and points >= 1000:
        _announce("🏁 Drift", f"{current_user()['name']} drift trassasida yangi rekord qo'ydi: {_money(points)} ochko!")
    return jsonify(points=points, pay=money, best=best, record=record, left=DRIFT_DAY_CAP - paid - money, economy=_econ(db, key))


# --------------------------------------------------------------------------- #
#  6 va 15. Haftalik ko'rgazmalar: mashina ko'rgazmasi va moda ko'rgazmasi
# --------------------------------------------------------------------------- #
SHOW_KINDS = {"car": {"name": "Avtomobil ko'rgazmasi", "prize": 30000},
              "look": {"name": "Moda ko'rgazmasi", "prize": 20000}}


def _prev_week() -> str:
    return week_id(_now_tk() - timedelta(days=7))


def settle_shows(db) -> None:
    """O'tgan hafta g'oliblariga sovrin (bir marta)."""
    prev = _prev_week()
    for kind, info in SHOW_KINDS.items():
        if db.execute("SELECT 1 FROM game_show_paid WHERE week = ? AND kind = ?", (prev, kind)).fetchone():
            continue
        top = db.execute("SELECT cand, COUNT(*) AS n FROM game_show_votes WHERE week = ? AND kind = ? GROUP BY cand "
                         "ORDER BY n DESC, MIN(rowid) LIMIT 1", (prev, kind)).fetchone()
        cur = db.execute("INSERT OR IGNORE INTO game_show_paid (week, kind, winner, votes) VALUES (?, ?, ?, ?)",
                         (prev, kind, top["cand"] if top else None, top["n"] if top else 0))
        db.commit()
        if cur.rowcount and top:
            gs.add_money(db, top["cand"], info["prize"])
            gs._notify(top["cand"], f"🏆 {info['name']}da g'olib bo'ldingiz! +{_money(info['prize'])} so'm")
            name = gs._people(db).get(top["cand"], {}).get("name", "?")
            _announce("🏆 Ko'rgazma", f"{info['name']} g'olibi: {name} ({top['n']} ovoz) — +{_money(info['prize'])} so'm!")


def _entry_data(db, key: str, kind: str, car: str | None):
    row = gs._row(db, key)
    if kind == "car":
        if car not in json.loads(row["cars"]) or car not in game.CARS_BY_ID:
            raise game.GameError("Bu mashina sizda yo'q")
        t = game.player_tuning(row).get(car, {})
        info = game.CARS_BY_ID[car]
        return {"car": car, "name": info["name"], "color": t.get("color") or info["color"], "neon": t.get("neon"),
                "rims": t.get("rims"), "tint": bool(t.get("tint")), "speed": int(t.get("speed", 0) or 0)}
    looks = game.player_looks(row)
    if not looks:
        raise game.GameError("Avval «Ko'rinishim» da kiyimingizni tanlang")
    return looks


def _show_json(db, key: str, kind: str) -> dict:
    week = week_id()
    people = gs._people(db)
    votes = {r["cand"]: r["n"] for r in db.execute(
        "SELECT cand, COUNT(*) AS n FROM game_show_votes WHERE week = ? AND kind = ? GROUP BY cand", (week, kind))}
    mine = db.execute("SELECT cand FROM game_show_votes WHERE week = ? AND kind = ? AND voter = ?", (week, kind, key)).fetchone()
    entries = [{"key": r["player_key"], "name": people.get(r["player_key"], {}).get("name", "?"),
                "avatar": people.get(r["player_key"], {}).get("avatar"), "data": json.loads(r["data"]),
                "votes": votes.get(r["player_key"], 0), "me": r["player_key"] == key}
               for r in db.execute("SELECT * FROM game_show_entries WHERE week = ? AND kind = ? ORDER BY at", (week, kind))
               if r["player_key"] in people]
    entries.sort(key=lambda e: -e["votes"])
    last = db.execute("SELECT * FROM game_show_paid WHERE week = ? AND kind = ?", (_prev_week(), kind)).fetchone()
    now = _now_tk()
    left = 7 - now.isoweekday()
    return {"kind": kind, "title": SHOW_KINDS[kind]["name"], "prize": SHOW_KINDS[kind]["prize"], "week": week,
            "days_left": left, "entries": entries, "my_vote": mine["cand"] if mine else None,
            "entered": any(e["me"] for e in entries),
            "last": {"name": people.get(last["winner"], {}).get("name", "?"), "votes": last["votes"]} if last and last["winner"] else None}


@bp.get("/api/game/show/<kind>")
@login_required
def api_show(kind: str):
    if kind not in SHOW_KINDS:
        return _err("?", 404)
    db = get_db()
    key = _me()
    game.ensure_player(db, key)
    settle_shows(db)
    return jsonify(show=_show_json(db, key, kind))


@bp.post("/api/game/show/<kind>/enter")
@login_required
def api_show_enter(kind: str):
    if kind not in SHOW_KINDS:
        return _err("?", 404)
    key = _me()
    if key == "owner":
        return _err("Owner ko'rgazmada qatnashmaydi")
    db = get_db()
    game.ensure_player(db, key)
    try:
        data = _entry_data(db, key, kind, _json().get("car"))
    except game.GameError as e:
        return _err(str(e))
    db.execute("INSERT INTO game_show_entries (week, kind, player_key, data, at) VALUES (?, ?, ?, ?, ?) "
               "ON CONFLICT(week, kind, player_key) DO UPDATE SET data = excluded.data",
               (week_id(), kind, key, json.dumps(data), time.time()))
    db.commit()
    return jsonify(show=_show_json(db, key, kind))


@bp.post("/api/game/show/<kind>/vote")
@login_required
def api_show_vote(kind: str):
    if kind not in SHOW_KINDS:
        return _err("?", 404)
    key = _me()
    cand = _json().get("key")
    db = get_db()
    week = week_id()
    if cand == key:
        return _err("O'zingizga ovoz berib bo'lmaydi")
    if not db.execute("SELECT 1 FROM game_show_entries WHERE week = ? AND kind = ? AND player_key = ?", (week, kind, cand)).fetchone():
        return _err("Bunday ishtirokchi yo'q")
    db.execute("INSERT INTO game_show_votes (week, kind, voter, cand) VALUES (?, ?, ?, ?) "
               "ON CONFLICT(week, kind, voter) DO UPDATE SET cand = excluded.cand", (week, kind, key, cand))
    db.commit()
    return jsonify(show=_show_json(db, key, kind))


# --------------------------------------------------------------------------- #
#  15. Kiyim do'koni: maxsus shapka va ko'zoynaklar (sotib olinadi)
# --------------------------------------------------------------------------- #
CLOTHES = {
    "hat:cowboy": ("Kovboy shlyapasi", 8000), "hat:helmet": ("Poyga dubulg'asi", 12000),
    "hat:tiara": ("Malika tojisi", 15000), "hat:party": ("Bayram qalpoqchasi", 5000),
    "hat:chef": ("Oshpaz qalpog'i", 6000),
    "glasses:sun": ("Quyosh ko'zoynagi", 5000), "glasses:round": ("Dumaloq ko'zoynak", 4000),
    "glasses:star": ("Yulduz ko'zoynak", 9000), "glasses:heart": ("Yurak ko'zoynak", 9000),
}


def _owned(db, key: str) -> set:
    return {r["item"] for r in db.execute("SELECT item FROM game_wardrobe WHERE player_key = ?", (key,))}


def wardrobe(db, key: str) -> dict:
    return {"owned": sorted(_owned(db, key)), "prices": {k: v[1] for k, v in CLOTHES.items()},
            "names": {k: v[0] for k, v in CLOTHES.items()}}


def look_guard(db, key: str, looks: dict) -> str | None:
    owned = _owned(db, key)
    for k, v in looks.items():
        item = f"{k}:{v}"
        if item in CLOTHES and item not in owned:
            return f"«{CLOTHES[item][0]}» avval Kiyim do'konidan sotib olinadi (yangi shahar)"
    return None


game.WARDROBE = wardrobe
game.LOOK_GUARD = look_guard


@bp.post("/api/game/clothes/buy")
@login_required
def api_clothes_buy():
    key = _me()
    item = _json().get("item")
    if item not in CLOTHES:
        return _err("Bunday kiyim yo'q")
    db = get_db()
    game.ensure_player(db, key)
    if item in _owned(db, key):
        return _err("Bu kiyim sizda bor")
    err = _pay(db, key, CLOTHES[item][1], CLOTHES[item][0])
    if err:
        return err
    db.execute("INSERT OR IGNORE INTO game_wardrobe (player_key, item, at) VALUES (?, ?, ?)", (key, item, time.time()))
    db.commit()
    return jsonify(ok=True, economy=_econ(db, key), **wardrobe(db, key))


# --------------------------------------------------------------------------- #
#  10. Kod bilan uy fasadi: hovlingiz oldidagi ekranda sizning HTML/CSS ishingiz
# --------------------------------------------------------------------------- #
FACADE_MAX = 3000


def _home_plot(db, key: str):
    row = db.execute("SELECT plot FROM game_players WHERE player_key = ?", (key,)).fetchone()
    return row["plot"] if row else None


@bp.get("/api/game/facades")
@login_required
def api_facades():
    key = _me()
    db = get_db()
    people = gs._people(db)
    out = []
    for r in db.execute("SELECT f.*, p.plot FROM game_facade f JOIN game_players p ON p.player_key = f.player_key"):
        if r["plot"] is None or r["player_key"] not in people:
            continue
        out.append({"key": r["player_key"], "name": people[r["player_key"]]["name"], "plot": r["plot"],
                    "html": r["html"], "css": r["css"], "at": r["at"], "me": r["player_key"] == key})
    return jsonify(facades=out)


@bp.post("/api/game/facade")
@login_required
def api_facade_save():
    key = _me()
    data = _json()
    html, css = str(data.get("html") or ""), str(data.get("css") or "")
    if len(html) > FACADE_MAX or len(css) > FACADE_MAX:
        return _err(f"Kod juda uzun (HTML va CSS — {FACADE_MAX} belgigacha)")
    db = get_db()
    game.ensure_player(db, key)
    if _home_plot(db, key) is None:
        return _err("Avval hovli oling")
    if not html.strip():
        db.execute("DELETE FROM game_facade WHERE player_key = ?", (key,))
    else:
        db.execute("INSERT INTO game_facade (player_key, html, css, at) VALUES (?, ?, ?, ?) "
                   "ON CONFLICT(player_key) DO UPDATE SET html = excluded.html, css = excluded.css, at = excluded.at",
                   (key, html, css, time.time()))
    db.commit()
    return jsonify(ok=True)


# --------------------------------------------------------------------------- #
#  12. Bug ovchisi: har kuni shaharda 3 ta narsa "buziladi" — kodini tuzatgan birinchi pul oladi
# --------------------------------------------------------------------------- #
BUG_SPOTS = [
    {"x": 1200, "y": 420, "label": "🚦 Svetofor ishlamayapti"},
    {"x": 2340, "y": 610, "label": "🕰️ Soat to'xtab qoldi"},
    {"x": 3540, "y": 1180, "label": "💡 Ko'cha chirog'i o'chdi"},
    {"x": 4320, "y": -960, "label": "🚦 Yangi shahar svetofori buzildi"},
    {"x": 5100, "y": -340, "label": "📺 Reklama ekrani qotib qoldi"},
    {"x": 1980, "y": 1940, "label": "🏧 Bankomat xato beryapti"},
    {"x": 5880, "y": 2700, "label": "💡 Fonar miltillayapti"},
    {"x": 760, "y": 2700, "label": "⛲ Favvora nasosi to'xtadi"},
    {"x": 5880, "y": -980, "label": "🛗 Lift tugmasi ishlamayapti"},
]
BUGHUNT_N = 3
BUGHUNT_PAY = 8000


def _day_bugs(day: str) -> list:
    seed = int(hashlib.sha1(day.encode()).hexdigest()[:8], 16)
    rnd = random.Random(seed)
    spots = rnd.sample(range(len(BUG_SPOTS)), BUGHUNT_N)
    bugs = rnd.sample(codecheck.BUGS, BUGHUNT_N)
    return [(i, spots[i], bugs[i]) for i in range(BUGHUNT_N)]


@bp.get("/api/game/bughunt")
@login_required
def api_bughunt():
    db = get_db()
    day = _today()
    people = gs._people(db)
    fixed = {r["spot"]: r["fixer"] for r in db.execute("SELECT spot, fixer FROM game_bugfix WHERE day = ?", (day,))}
    return jsonify(pay=BUGHUNT_PAY, spots=[
        {"i": i, **BUG_SPOTS[s], "title": b["title"], "lang": b["lang"], "want": b["want"], "code": b["code"],
         "fixed": people.get(fixed[i], {}).get("name", "?") if i in fixed else None}
        for i, s, b in _day_bugs(day)])


@bp.post("/api/game/bughunt/<int:i>")
@login_required
def api_bughunt_fix(i: int):
    key = _me()
    day = _today()
    task = next((t for t in _day_bugs(day) if t[0] == i), None)
    if not task:
        return _err("Bunday buzilish yo'q")
    _, s, b = task
    db = get_db()
    if db.execute("SELECT 1 FROM game_bugfix WHERE day = ? AND spot = ?", (day, i)).fetchone():
        return _err("Buni allaqachon kimdir tuzatib bo'ldi")
    if not _near(key, BUG_SPOTS[s], 160):
        return _err("Buzilgan joyga yaqin boring")
    code = str(_json().get("code") or "")[:4000]
    import difflib
    if difflib.SequenceMatcher(None, b["code"], code, autojunk=False).ratio() < 0.5:
        return jsonify(ok=False, missing=["Kodni boshidan yozmang — faqat xatosini tuzating"])
    missing = codecheck.check(code, b["checks"])
    if missing:
        return jsonify(ok=False, missing=missing)
    cur = db.execute("INSERT OR IGNORE INTO game_bugfix (day, spot, fixer, at) VALUES (?, ?, ?, ?)", (day, i, key, time.time()))
    db.commit()
    if not cur.rowcount:
        return _err("Buni allaqachon kimdir tuzatib bo'ldi")
    gs.add_money(db, key, BUGHUNT_PAY)
    _announce("🐞 Bug ovchisi", f"{current_user()['name']} tuzatdi: {BUG_SPOTS[s]['label']} → ishlayapti! +{_money(BUGHUNT_PAY)} so'm")
    return jsonify(ok=True, pay=BUGHUNT_PAY, economy=_econ(db, key))


# --------------------------------------------------------------------------- #
#  14. Uy hayvoni parvarishi: ovqat, sayr (tajriba), daraja va hiylalar
# --------------------------------------------------------------------------- #
PET_LEVELS = [0, 60, 180, 400, 800]          # tajriba chegaralari: 1..5-daraja
PET_TRICKS = {"sit": ("O'tirish", 2), "jump": ("Sakrash", 3), "spin": ("Aylanish", 4), "dance": ("Raqs", 5)}
PET_FOOD = 500
HUNGER_SECS = 86400                          # bir kunda och qoladi
WALK_STEP = 400                              # shuncha yurish = 1 tajriba
_walk: dict[str, list] = {}                  # key -> [x, y, masofa]


def pet_level(xp: int) -> int:
    return sum(1 for t in PET_LEVELS if xp >= t)


def _care(db, key: str):
    return db.execute("SELECT * FROM game_pet_care WHERE player_key = ?", (key,)).fetchone()


def _care_json(db, key: str, now: float) -> dict | None:
    row = gs._row(db, key)
    if not row or not row["pet"]:
        return None
    c = _care(db, key)
    xp = c["xp"] if c else 0
    fed = c["fed_at"] if c else 0
    lvl = pet_level(xp)
    return {"name": (c["name"] if c else None) or "", "xp": xp, "level": lvl,
            "next": PET_LEVELS[lvl] if lvl < len(PET_LEVELS) else None,
            "food": max(0, round(100 - (now - fed) / HUNGER_SECS * 100)), "food_price": PET_FOOD,
            "tricks": [{"id": k, "name": v[0], "level": v[1], "open": lvl >= v[1]} for k, v in PET_TRICKS.items()]}


def _add_xp(db, key: str, n: int) -> None:
    db.execute("INSERT INTO game_pet_care (player_key, xp) VALUES (?, ?) "
               "ON CONFLICT(player_key) DO UPDATE SET xp = xp + excluded.xp", (key, n))
    db.commit()


@bp.get("/api/game/pet/care")
@login_required
def api_pet_care():
    db = get_db()
    return jsonify(care=_care_json(db, _me(), time.time()))


@bp.post("/api/game/pet/feed")
@login_required
def api_pet_feed():
    key = _me()
    db = get_db()
    now = time.time()
    care = _care_json(db, key, now)
    if not care:
        return _err("Sizda uy hayvoni yo'q")
    if care["food"] >= 90:
        return _err("Hayvoningiz to'q 🙂")
    err = _pay(db, key, PET_FOOD, "Ovqat")
    if err:
        return err
    db.execute("INSERT INTO game_pet_care (player_key, xp, fed_at) VALUES (?, 5, ?) "
               "ON CONFLICT(player_key) DO UPDATE SET fed_at = excluded.fed_at, xp = xp + 5", (key, now))
    db.commit()
    return jsonify(care=_care_json(db, key, now), economy=_econ(db, key))


@bp.post("/api/game/pet/name")
@login_required
def api_pet_name():
    key = _me()
    name = " ".join(str(_json().get("name") or "").split())[:16]
    db = get_db()
    if not _care_json(db, key, time.time()):
        return _err("Sizda uy hayvoni yo'q")
    db.execute("INSERT INTO game_pet_care (player_key, name) VALUES (?, ?) "
               "ON CONFLICT(player_key) DO UPDATE SET name = excluded.name", (key, name or None))
    db.commit()
    return jsonify(care=_care_json(db, key, time.time()))


@bp.post("/api/game/pet/trick")
@login_required
def api_pet_trick():
    key = _me()
    trick = _json().get("trick")
    db = get_db()
    care = _care_json(db, key, time.time())
    if not care:
        return _err("Sizda uy hayvoni yo'q")
    if trick not in PET_TRICKS:
        return _err("Qaysi hiyla?")
    if care["level"] < PET_TRICKS[trick][1]:
        return _err(f"Bu hiyla {PET_TRICKS[trick][1]}-darajada ochiladi")
    if care["food"] < 20:
        return _err("Hayvoningiz och — avval ovqat bering")
    extra = game.PLAYER_EXTRA.setdefault(key, {})
    extra["pt"] = [trick, round(time.time(), 1)]
    return jsonify(ok=True, trick=trick)


def _pet_hook(db, key: str, row, now: float, response: dict) -> None:
    """Sayr: hayvon bilan piyoda yurgan masofa — tajriba. Boshqalarga daraja va ism ko'rinadi."""
    if not row["pet"]:
        game.PLAYER_EXTRA.pop(key, None)
        _walk.pop(key, None)
        return
    p = game._live.get(key)
    extra = game.PLAYER_EXTRA.setdefault(key, {})
    c = _care(db, key)
    xp = c["xp"] if c else 0
    extra["pl"] = pet_level(xp)
    extra["pn"] = (c["name"] if c else None) or ""
    response["pet_ex"] = {"pl": extra["pl"], "pn": extra["pn"], "pt": extra.get("pt")}
    if extra.get("pt") and now - extra["pt"][1] > 4:
        extra.pop("pt", None)
    if not p or p.get("car"):
        return
    w = _walk.get(key)
    if not w:
        _walk[key] = [p["x"], p["y"], 0.0]
        return
    step = math.hypot(p["x"] - w[0], p["y"] - w[1])
    w[0], w[1] = p["x"], p["y"]
    if step > 400:   # teleport — hisoblanmaydi
        return
    fed = c["fed_at"] if c else 0
    if (now - fed) / HUNGER_SECS >= 0.8:   # och hayvon sayrdan o'rganmaydi
        return
    w[2] += step
    if w[2] >= WALK_STEP:
        n = int(w[2] // WALK_STEP)
        w[2] -= n * WALK_STEP
        before = pet_level(xp)
        _add_xp(db, key, n)
        if pet_level(xp + n) > before:
            response["pet_up"] = pet_level(xp + n)


# --------------------------------------------------------------------------- #
#  20. Hokim farmoni: rais kuniga bir marta butun shaharga e'lon yozadi
# --------------------------------------------------------------------------- #
DECREE_MAX = 160


def _decree_json(db) -> dict | None:
    r = db.execute("SELECT * FROM game_decree WHERE day = ?", (_today(),)).fetchone()
    if not r:
        return None
    return {"text": r["text"], "name": gs._people(db).get(r["player_key"], {}).get("name", "?"), "at": r["at"]}


@bp.get("/api/game/decree")
@login_required
def api_decree():
    db = get_db()
    return jsonify(decree=_decree_json(db), am_mayor=gl.mayor_key(db) == _me())


@bp.post("/api/game/decree")
@login_required
def api_decree_post():
    key = _me()
    db = get_db()
    if gl.mayor_key(db) != key:
        return _err("Farmonni faqat mahalla raisi (hokim) yozadi", 403)
    text = " ".join(str(_json().get("text") or "").split())[:DECREE_MAX]
    if len(text) < 5:
        return _err("Farmon matnini yozing")
    cur = db.execute("INSERT OR IGNORE INTO game_decree (day, player_key, text, at) VALUES (?, ?, ?, ?)", (_today(), key, text, time.time()))
    db.commit()
    if not cur.rowcount:
        return _err("Bugungi farmon yozilgan — ertaga yana")
    _announce("📜 Hokim farmoni", text)
    return jsonify(decree=_decree_json(db))


def _decree_hook(db, key: str, row, now: float, response: dict) -> None:
    d = _decree_cache.get("d")
    if now - _decree_cache.get("t", 0) > 20:
        d = _decree_json(db)
        _decree_cache.update(t=now, d=d)
    if d:
        response["decree"] = d


_decree_cache: dict = {}


# --------------------------------------------------------------------------- #
#  16. Konsert: eng ko'p qarsak olganlar (rekord)
# --------------------------------------------------------------------------- #
def _stage_best_hook(db, key: str, row, now: float, response: dict) -> None:
    st = response.get("stage")
    if st and st.get("me") and st["claps"] > 0:
        db.execute("INSERT INTO game_stage_best (player_key, claps, at) VALUES (?, ?, ?) "
                   "ON CONFLICT(player_key) DO UPDATE SET claps = MAX(claps, excluded.claps), at = excluded.at",
                   (key, st["claps"], now))
        db.commit()


@bp.get("/api/game/stage/top")
@login_required
def api_stage_top():
    db = get_db()
    people = gs._people(db)
    return jsonify(top=[{"name": people[r["player_key"]]["name"], "claps": r["claps"]}
                        for r in db.execute("SELECT * FROM game_stage_best ORDER BY claps DESC, at LIMIT 10") if r["player_key"] in people],
                   stage=gf._stage_json(_me(), time.time()))


game.SYNC_HOOKS.extend([_pet_hook, _decree_hook, _stage_best_hook])


def _forget(db, key: str) -> None:
    for t in ("game_show_entries", "game_wardrobe", "game_drift", "game_facade", "game_pet_care", "game_stage_best"):
        db.execute(f"DELETE FROM {t} WHERE player_key = ?", (key,))
    db.execute("DELETE FROM game_show_votes WHERE voter = ? OR cand = ?", (key, key))
    game.PLAYER_EXTRA.pop(key, None)


game.FORGET_HOOKS.append(_forget)


# --------------------------------------------------------------------------- #
#  Hafta boshida reytingdagi 1-o'ringa tasodifiy sovg'a
# --------------------------------------------------------------------------- #
TOP_MONEY = (50000, 100000, 150000, 200000)
TOP_CARS = ("porsche", "lambo", "cyber", "ferrari", "mclaren", "rolls")
TOP_FRAMES = ("oltin", "olov", "muz", "kamalak", "neon")


def _pick_gift(db, key: str, rnd: random.Random) -> tuple[str, str]:
    """(turi, qiymat) — o'yinchida yo'q narsa tanlanadi, bo'lmasa pul."""
    import portal
    row = game.ensure_player(db, key)
    options = [("money", str(rnd.choice(TOP_MONEY)))]
    cars = [c for c in TOP_CARS if c in game.CARS_BY_ID and c not in json.loads(row["cars"] or "[]")]
    if cars:
        options.append(("car", rnd.choice(cars)))
    clothes = [c for c in CLOTHES if c not in _owned(db, key)]
    if clothes:
        options.append(("clothes", rnd.choice(clothes)))
    deco = portal._deco_row(db, key)
    frames = [f for f in TOP_FRAMES if f"f:{f}" not in set(json.loads(deco["owned"] or "[]"))]
    if frames:
        options.append(("frame", rnd.choice(frames)))
    return rnd.choice(options)


def _give_gift(db, key: str, kind: str, value: str) -> str:
    """Sovg'ani beradi va matnini qaytaradi."""
    import portal
    if kind == "money":
        gs.add_money(db, key, int(value))
        return f"{_money(int(value))} so'm o'yin puli"
    if kind == "car":
        row = gs._row(db, key)
        cars = json.loads(row["cars"] or "[]")
        if value not in cars:
            db.execute("UPDATE game_players SET cars = ? WHERE player_key = ?", (json.dumps(cars + [value]), key))
        return f"🚗 {game.CARS_BY_ID[value]['name']} mashinasi"
    if kind == "clothes":
        db.execute("INSERT OR IGNORE INTO game_wardrobe (player_key, item, at) VALUES (?, ?, ?)", (key, value, time.time()))
        return f"👕 {CLOTHES[value][0]}"
    owned = set(json.loads(portal._deco_row(db, key)["owned"] or "[]")) | {f"f:{value}"}
    db.execute("UPDATE deco SET owned = ? WHERE user_key = ?", (json.dumps(sorted(owned)), key))
    return f"🖼️ «{portal.FRAMES[value][0]}» profil ramkasi"


TEMP_ADMIN_SECS = 2 * 86400


def _grant_temp_admin(db, user_id: int) -> None:
    """Haftaning eng zo'ri 2 kun admin bo'ladi («Ball berish» bo'limi, «🛡️ Admin» unvoni)."""
    from core import get_setting, set_setting
    import portal
    try:
        raw = json.loads(get_setting("admins_temp") or "{}")
    except ValueError:
        raw = {}
    raw[str(user_id)] = time.time() + TEMP_ADMIN_SECS
    set_setting("admins_temp", json.dumps(raw))
    key = f"u{user_id}"
    portal._deco_row(db, key)
    db.execute("UPDATE deco SET title = 'admin' WHERE user_key = ?", (key,))
    db.commit()
    portal.deco_map(db, True)


def expire_temp_admins(db) -> None:
    """Muddati o'tgan vaqtinchalik adminlikni olib tashlash (unvon ham)."""
    from core import admin_ids, get_setting, set_setting
    import portal
    try:
        raw = json.loads(get_setting("admins_temp") or "{}")
    except ValueError:
        raw = {}
    gone = [k for k, v in raw.items() if float(v) <= time.time()]
    if not gone:
        return
    for k in gone:
        raw.pop(k)
    set_setting("admins_temp", json.dumps(raw))
    still = admin_ids()
    for k in gone:
        if int(k) not in still:
            db.execute("UPDATE deco SET title = '' WHERE user_key = ? AND title = 'admin'", (f"u{k}",))
            import classroom
            classroom.notify(f"u{k}", "🛡️ 2 kunlik adminlik tugadi. Yana 1-o'ringa chiqing!", "/panel#rating")
    db.commit()
    portal.deco_map(db, True)


def weekly_top_gift(db, rnd: random.Random | None = None) -> dict | None:
    """Shu haftada hali berilmagan bo'lsa — reytingdagi 1-o'ringa sovg'a."""
    from core import RATING_SQL
    week = week_id()
    if db.execute("SELECT 1 FROM weekly_top WHERE week = ?", (week,)).fetchone():
        return None
    top = db.execute(RATING_SQL).fetchone()
    if not top or (top["total"] or 0) <= 0:
        return None
    key = f"u{top['id']}"
    cur = db.execute("INSERT OR IGNORE INTO weekly_top (week, user_key, gift, at) VALUES (?, ?, '', ?)", (week, key, time.time()))
    db.commit()
    if not cur.rowcount:
        return None
    kind, value = _pick_gift(db, key, rnd or random.Random())
    text = _give_gift(db, key, kind, value)
    _grant_temp_admin(db, top["id"])
    text += " va 2 kunga 🛡️ Admin"
    db.execute("UPDATE weekly_top SET gift = ? WHERE week = ?", (text, week))
    db.commit()
    import classroom
    classroom.notify(key, f"🏆 Siz reytingda 1-o'rindasiz! Haftalik sovg'a: {text}. «Ball berish» bo'limi 2 kun ochiq", "/panel#rating")
    _announce("🏆 Haftaning eng zo'ri", f"{top['name']} reytingda 1-o'rinda — sovg'a: {text}!")
    return {"week": week, "key": key, "gift": text}


@bp.get("/api/weekly-top")
@login_required
def api_weekly_top():
    db = get_db()
    r = db.execute("SELECT * FROM weekly_top WHERE gift != '' ORDER BY week DESC LIMIT 1").fetchone()
    if not r:
        return jsonify(top=None)
    people = gs._people(db)
    return jsonify(top={"week": r["week"], "name": people.get(r["user_key"], {}).get("name", "?"), "gift": r["gift"],
                        "me": r["user_key"] == _me()})


def _tick(db) -> None:
    settle_shows(db)
    expire_temp_admins(db)
    weekly_top_gift(db)
    import school
    school.pay_birthdays(db)


import portal  # noqa: E402
portal.TICKS.append(_tick)
