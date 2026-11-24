"""Mahalla — hayot: mahalla raisi saylovi, haydovchilik guvohnomasi, fermerlik,
kafe oshxonasi (restoran biznesi) va haftalik avtopoyga chempionati.
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
from core import current_user, get_db, login_required

bp = Blueprint("game_life", __name__)


def _me():
    return game.player_key(current_user())


def _money(n: int) -> str:
    return f"{n:,}".replace(",", " ")


# --------------------------------------------------------------------------- #
#  16. Mahalla raisi saylovi (har oy). G'olib keyingi oy rais: toj va kunlik maosh
# --------------------------------------------------------------------------- #
RUN_FEE = 20000
MAYOR_SALARY = 25000


def month_id(dt: datetime | None = None) -> str:
    return (dt or datetime.now(gf.TASHKENT)).strftime("%Y-%m")


def _prev_month() -> str:
    first = datetime.now(gf.TASHKENT).replace(day=1)
    return month_id(first - timedelta(days=1))


def _tally(db, month: str) -> list:
    return db.execute(
        "SELECT c.player_key, c.at, c.program, (SELECT COUNT(*) FROM game_votes v WHERE v.month = c.month AND v.cand = c.player_key) AS votes "
        "FROM game_candidates c WHERE c.month = ? ORDER BY votes DESC, c.at", (month,)).fetchall()


_mayor_cache: dict = {}


def mayor_key(db) -> str | None:
    """O'tgan oy saylovida eng ko'p ovoz olgan (kamida 1 ovoz)."""
    prev = _prev_month()
    if _mayor_cache.get("month") != prev or time.time() - _mayor_cache.get("t", 0) > 60:
        rows = _tally(db, prev)
        _mayor_cache.update(month=prev, t=time.time(), key=rows[0]["player_key"] if rows and rows[0]["votes"] > 0 else None)
    return _mayor_cache["key"]


@bp.get("/api/game/election")
@login_required
def api_election():
    key = _me()
    db = get_db()
    game.ensure_player(db, key)
    people = gs._people(db)
    month = month_id()
    rows = _tally(db, month)
    vote = db.execute("SELECT cand FROM game_votes WHERE month = ? AND voter = ?", (month, key)).fetchone()
    mk = mayor_key(db)
    now = datetime.now(gf.TASHKENT)
    nxt = (now.replace(day=1) + timedelta(days=32)).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    today = now.strftime("%Y-%m-%d")
    paid = db.execute("SELECT 1 FROM game_mayor_pay WHERE day = ?", (today,)).fetchone()
    return jsonify(
        month=month, days_left=max(0, (nxt - now).days),
        mayor={"key": mk, "name": people.get(mk, {}).get("name", "?"), "avatar": people.get(mk, {}).get("avatar")} if mk else None,
        am_mayor=mk == key, can_salary=mk == key and not paid,
        candidates=[{"key": r["player_key"], "name": people.get(r["player_key"], {}).get("name", "?"),
                     "avatar": people.get(r["player_key"], {}).get("avatar"), "votes": r["votes"], "program": r["program"] or "",
                     "me": r["player_key"] == key} for r in rows],
        my_vote=vote["cand"] if vote else None, running=any(r["player_key"] == key for r in rows),
        fee=RUN_FEE, salary=MAYOR_SALARY)


@bp.post("/api/game/election/run")
@login_required
def api_election_run():
    user = current_user()
    key = game.player_key(user)
    if key == "owner":
        return jsonify(error="Owner saylovda qatnashmaydi"), 400
    db = get_db()
    game.ensure_player(db, key)
    month = month_id()
    program = " ".join(str((request.get_json(silent=True) or {}).get("program") or "").split())[:300]
    if db.execute("SELECT 1 FROM game_candidates WHERE month = ? AND player_key = ?", (month, key)).fetchone():
        if program:  # nomzod dasturini yangilash
            db.execute("UPDATE game_candidates SET program = ? WHERE month = ? AND player_key = ?", (program, month, key))
            db.commit()
            return api_election()
        return jsonify(error="Siz allaqachon nomzodsiz"), 400
    if len(program) < 10:
        return jsonify(error="Dasturingizni yozing: saylansangiz nima qilasiz? (kamida 10 harf)"), 400

    def change(row, money):
        if money < RUN_FEE:
            raise game.GameError(f"Nomzod bo'lish {_money(RUN_FEE)} so'm turadi")
        return -RUN_FEE, lambda: db.execute("INSERT INTO game_candidates (month, player_key, at, program) VALUES (?, ?, ?, ?)",
                                            (month, key, time.time(), program))

    _, err = gs._change(db, key, change)
    if err:
        return err
    with game._lock:
        game._chat.append({"id": next(game._msg_ids), "key": "owner", "name": "🗳️ Saylov", "avatar": None, "t": time.time(),
                           "text": f"{user['name']} mahalla raisligiga nomzod bo'ldi! Telefon → Saylov orqali ovoz bering"})
    return api_election()


@bp.post("/api/game/election/vote")
@login_required
def api_election_vote():
    key = _me()
    cand = (request.get_json(silent=True) or {}).get("key")
    db = get_db()
    game.ensure_player(db, key)
    month = month_id()
    if cand == key:
        return jsonify(error="O'zingizga ovoz berib bo'lmaydi"), 400
    if not db.execute("SELECT 1 FROM game_candidates WHERE month = ? AND player_key = ?", (month, cand)).fetchone():
        return jsonify(error="Bunday nomzod yo'q"), 400
    cur = db.execute("INSERT OR IGNORE INTO game_votes (month, voter, cand) VALUES (?, ?, ?)", (month, key, cand))
    db.commit()
    if not cur.rowcount:
        return jsonify(error="Bu oy ovoz berib bo'lgansiz"), 400
    return api_election()


@bp.post("/api/game/election/salary")
@login_required
def api_election_salary():
    key = _me()
    db = get_db()
    if mayor_key(db) != key:
        return jsonify(error="Maoshni faqat mahalla raisi oladi"), 403
    today = datetime.now(gf.TASHKENT).strftime("%Y-%m-%d")
    cur = db.execute("INSERT OR IGNORE INTO game_mayor_pay (day, player_key) VALUES (?, ?)", (today, key))
    db.commit()
    if not cur.rowcount:
        return jsonify(error="Bugungi maosh olingan — ertaga keling"), 400
    gs.add_money(db, key, MAYOR_SALARY)
    return jsonify(ok=True, paid=MAYOR_SALARY, economy=gf._econ(db, key))


# --------------------------------------------------------------------------- #
#  17. Yo'l harakati qoidalari testi — tez mashinalar uchun guvohnoma
# --------------------------------------------------------------------------- #
LICENSE_SPEED = 2.0      # shu tezlikdan yuqori mashinalarni guvohnomasiz sotib olib bo'lmaydi
LICENSE_QUESTIONS = 5
LICENSE_PASS = 4
LICENSE_RETRY = 60
QUESTIONS = [
    ("Svetoforning qizil chirog'i nimani bildiradi?", ["Yuring", "To'xtang", "Tezlashing"], 1),
    ("Piyodalar o'tish joyida kim birinchi o'tadi?", ["Mashina", "Piyoda", "Kim tez bo'lsa"], 1),
    ("Shahar ichida odatiy tezlik chegarasi qancha?", ["60 km/soat", "120 km/soat", "200 km/soat"], 0),
    ("Xavfsizlik kamari qachon taqiladi?", ["Faqat trassada", "Har doim", "Hech qachon"], 1),
    ("Sariq chiroq yonsa nima qilinadi?", ["To'xtashga tayyorlaning", "Tezlashing", "Signal chaling"], 0),
    ("Haydash paytida telefonda gaplashish mumkinmi?", ["Ha", "Faqat qisqa", "Yo'q"], 2),
    ("«STOP» belgisi nimani talab qiladi?", ["Sekinlashing", "To'liq to'xtang", "Chapga buriling"], 1),
    ("Tez yordam mashinasi chiroq yoqib kelsa?", ["Yo'l bering", "Poyga qiling", "E'tibor bermang"], 0),
    ("Mast holda mashina haydash mumkinmi?", ["Yo'q, hech qachon", "Kechasi mumkin", "Sekin haydasa mumkin"], 0),
    ("Chorrahada o'ngga burilishdan oldin nima qilinadi?", ["Burilish chirog'ini yoqiladi", "Gaz bosiladi", "Hech narsa"], 0),
]


def needs_license(car_id: str) -> bool:
    car = game.CARS_BY_ID.get(car_id)
    return bool(car and car["speed"] >= LICENSE_SPEED)


@bp.get("/api/game/license")
@login_required
def api_license_get():
    key = _me()
    db = get_db()
    row = game.ensure_player(db, key)
    picks = random.sample(range(len(QUESTIONS)), LICENSE_QUESTIONS)
    wait = max(0, round(row["license_try"] + LICENSE_RETRY - time.time()))
    return jsonify(has=bool(row["license"]) or key == "owner", wait=wait, pass_n=LICENSE_PASS,
                   cars=[c["name"] for c in game.CARS if c["speed"] >= LICENSE_SPEED],
                   questions=[{"id": i, "q": QUESTIONS[i][0], "options": QUESTIONS[i][1]} for i in picks])


@bp.post("/api/game/license")
@login_required
def api_license_take():
    key = _me()
    db = get_db()
    row = game.ensure_player(db, key)
    if row["license"]:
        return jsonify(error="Guvohnoma sizda bor"), 400
    if time.time() - row["license_try"] < LICENSE_RETRY:
        return jsonify(error="Biroz kuting, keyin qayta topshiring"), 429
    answers = (request.get_json(silent=True) or {}).get("answers") or {}
    if not isinstance(answers, dict):
        return jsonify(error="Javoblar noto'g'ri"), 400
    ids = set()
    right = 0
    for qid, choice in answers.items():
        try:
            qid = int(qid)
        except (TypeError, ValueError):
            continue
        if 0 <= qid < len(QUESTIONS):
            ids.add(qid)
            right += int(choice == QUESTIONS[qid][2])
    if len(ids) != LICENSE_QUESTIONS:
        return jsonify(error=f"{LICENSE_QUESTIONS} ta savolning hammasiga javob bering"), 400
    passed = right >= LICENSE_PASS
    if passed:
        db.execute("UPDATE game_players SET license = 1 WHERE player_key = ?", (key,))
    else:
        db.execute("UPDATE game_players SET license_try = ? WHERE player_key = ?", (time.time(), key))
    db.commit()
    return jsonify(passed=passed, right=right, total=LICENSE_QUESTIONS)


# --------------------------------------------------------------------------- #
#  19. Fermerlik: o'z bo'sh yeringizga ekin eking, pishgach yig'ib soting
# --------------------------------------------------------------------------- #
CROPS = {
    "wheat": {"name": "Bug'doy", "icon": "🌾", "seed": 500, "grow": 120, "sell": 1500},
    "tomato": {"name": "Pomidor", "icon": "🍅", "seed": 1500, "grow": 300, "sell": 4200},
    "melon": {"name": "Qovun", "icon": "🍈", "seed": 3000, "grow": 600, "sell": 9000},
}
FARM_REACH = 320


def _plot_center(plot_id: int) -> tuple[float, float]:
    p = game.PLOTS[plot_id]
    return p["x"] + p["w"] / 2, p["y"] + p["h"] / 2


def _farm_rows(db):
    return db.execute("SELECT f.*, g.owner_key AS cur_owner, g.kind FROM game_farm f "
                      "LEFT JOIN game_plots g ON g.plot = f.plot").fetchall()


def farm_list(db, now: float) -> list:
    out = []
    for r in _farm_rows(db):
        if r["cur_owner"] != r["owner_key"] or r["kind"] is not None:
            continue  # yer sotilgan yoki bino qurilgan
        crop = CROPS.get(r["crop"])
        if crop:
            prog = min(1.0, (now - r["planted_at"]) / crop["grow"])
            out.append({"plot": r["plot"], "crop": r["crop"], "owner": r["owner_key"], "progress": round(prog, 2)})
    return out


@bp.get("/api/game/farm")
@login_required
def api_farm():
    key = _me()
    db = get_db()
    now = time.time()
    mine = [f for f in farm_list(db, now) if f["owner"] == key]
    for f in mine:
        f["left"] = max(0, round(CROPS[f["crop"]]["grow"] * (1 - f["progress"])))
    empty = [r["plot"] for r in db.execute("SELECT plot FROM game_plots WHERE owner_key = ? AND kind IS NULL", (key,))]
    return jsonify(crops=CROPS, mine=mine, empty=empty)


@bp.post("/api/game/farm/plant")
@login_required
def api_farm_plant():
    key = _me()
    data = request.get_json(silent=True) or {}
    plot, crop = data.get("plot"), data.get("crop")
    if crop not in CROPS:
        return jsonify(error="Qaysi ekin?"), 400
    if not isinstance(plot, int) or isinstance(plot, bool) or not 0 <= plot < len(game.PLOTS):
        return jsonify(error="Yer topilmadi"), 400
    db = get_db()
    game.ensure_player(db, key)
    own = db.execute("SELECT kind FROM game_plots WHERE plot = ? AND owner_key = ?", (plot, key)).fetchone()
    if not own:
        return jsonify(error="Bu yer sizniki emas"), 400
    if own["kind"] is not None:
        return jsonify(error="Bu yerda bino bor — ekin faqat bo'sh yerga ekiladi"), 400
    if not gf._near(key, *_plot_center(plot), FARM_REACH):
        return jsonify(error="Yeringizga yaqin boring"), 400
    old = db.execute("SELECT owner_key FROM game_farm WHERE plot = ?", (plot,)).fetchone()
    if old and old["owner_key"] == key:
        return jsonify(error="Bu yerda ekin bor — avval hosilni yig'ing"), 400
    price = CROPS[crop]["seed"]

    def change(row, money):
        if money < price:
            raise game.GameError("Urug'ga pul yetmaydi")
        return -price, lambda: db.execute("INSERT OR REPLACE INTO game_farm (plot, owner_key, crop, planted_at) VALUES (?, ?, ?, ?)",
                                          (plot, key, crop, time.time()))

    _, err = gs._change(db, key, change)
    return err or jsonify(ok=True, economy=gf._econ(db, key), farm=farm_list(db, time.time()))


@bp.post("/api/game/farm/harvest")
@login_required
def api_farm_harvest():
    key = _me()
    plot = (request.get_json(silent=True) or {}).get("plot")
    db = get_db()
    now = time.time()
    f = next((x for x in farm_list(db, now) if x["plot"] == plot and x["owner"] == key), None)
    if not f:
        return jsonify(error="Bu yerda ekiningiz yo'q"), 400
    if f["progress"] < 1:
        return jsonify(error="Hali pishmadi"), 400
    if not gf._near(key, *_plot_center(plot), FARM_REACH):
        return jsonify(error="Yeringizga yaqin boring"), 400
    cur = db.execute("DELETE FROM game_farm WHERE plot = ? AND owner_key = ?", (plot, key))
    db.commit()
    if not cur.rowcount:
        return jsonify(error="Hosil yig'ilgan"), 400
    pay = CROPS[f["crop"]]["sell"]
    gs.add_money(db, key, pay)
    game.emit(db, key, "farm")
    return jsonify(ok=True, pay=pay, economy=gf._econ(db, key), farm=farm_list(db, now))


# --------------------------------------------------------------------------- #
#  20. Restoran biznesi: kafe egasi oshxonada buyurtma tayyorlaydi (tez — ko'proq pul)
# --------------------------------------------------------------------------- #
DISHES = {
    "osh": {"name": "Osh", "icon": "🍚", "recipe": ["guruch", "sabzi", "go'sht", "piyoz"]},
    "lagmon": {"name": "Lag'mon", "icon": "🍜", "recipe": ["xamir", "go'sht", "qalampir", "piyoz"]},
    "somsa": {"name": "Somsa", "icon": "🥟", "recipe": ["xamir", "go'sht", "piyoz"]},
    "shashlik": {"name": "Shashlik", "icon": "🍢", "recipe": ["go'sht", "piyoz", "ziravor"]},
    "salat": {"name": "Salat", "icon": "🥗", "recipe": ["pomidor", "bodring", "piyoz"]},
}
INGREDIENTS = ["guruch", "sabzi", "go'sht", "piyoz", "xamir", "qalampir", "ziravor", "pomidor", "bodring"]
KITCHEN_REACH = 320
KITCHEN_MIN = 1.2         # bundan tez bo'lishi mumkin emas (bot)
KITCHEN_FAST = 8          # shu soniyagacha to'liq haq
KITCHEN_SLOW = 30         # bundan keyin buyurtma bekor
_orders: dict[str, dict] = {}


def _my_cafe(db, key: str):
    rows = db.execute("SELECT plot, level FROM game_plots WHERE owner_key = ? AND kind = 'kafe'", (key,)).fetchall()
    now = time.time()
    return next((r for r in rows if gf._near(key, *_plot_center(r["plot"]), KITCHEN_REACH, now)), None), bool(rows)


@bp.post("/api/game/kitchen/order")
@login_required
def api_kitchen_order():
    key = _me()
    db = get_db()
    cafe, has_any = _my_cafe(db, key)
    if not cafe:
        return jsonify(error="Kafengizga yaqin boring" if has_any else "Avval kafe quring (yer → bino → Kafe)"), 400
    dish = random.choice(list(DISHES))
    order = {"id": random.randint(1, 10 ** 9), "dish": dish, "at": time.time(), "plot": cafe["plot"], "level": cafe["level"]}
    _orders[key] = order
    return jsonify(order={"id": order["id"], "dish": dish, **DISHES[dish]}, ingredients=INGREDIENTS,
                   fast=KITCHEN_FAST, slow=KITCHEN_SLOW)


@bp.post("/api/game/kitchen/serve")
@login_required
def api_kitchen_serve():
    key = _me()
    data = request.get_json(silent=True) or {}
    order = _orders.get(key)
    if not order or order["id"] != data.get("id"):
        return jsonify(error="Buyurtma topilmadi"), 400
    t = time.time() - order["at"]
    if t < KITCHEN_MIN:
        return jsonify(error="Juda tez 🙂"), 400
    _orders.pop(key, None)
    items = data.get("items")
    if items != DISHES[order["dish"]]["recipe"]:
        return jsonify(ok=False, pay=0, msg="Taom noto'g'ri tayyorlandi — mijoz norozi 😕")
    if t > KITCHEN_SLOW:
        return jsonify(ok=False, pay=0, msg="Juda kech qoldingiz — mijoz ketib qoldi")
    base = 1200 + 40 * int(order["level"] or 0)
    factor = 1.0 if t <= KITCHEN_FAST else max(0.4, 1 - (t - KITCHEN_FAST) / (KITCHEN_SLOW - KITCHEN_FAST) * 0.6)
    pay = int(base * factor)
    db = get_db()
    gs.add_money(db, key, pay)
    game.emit(db, key, "kitchen")
    return jsonify(ok=True, pay=pay, time=round(t, 1), msg=f"Mazali! +{_money(pay)} so'm", economy=gf._econ(db, key))


# --------------------------------------------------------------------------- #
#  21. Avtopoyga chempionati: haftada eng ko'p poyga yutganlar — kubok va pul
# --------------------------------------------------------------------------- #
CUP_PRIZES = [300000, 150000, 75000]
_pending_wins: list = []
_cup_check = {"t": 0.0}

_orig_end_race = gs._end_race


def _end_race(r: dict, winner: str, now: float) -> None:
    _orig_end_race(r, winner, now)
    if winner:  # durang ("") hisoblanmaydi
        _pending_wins.append((gf.week_id(), winner))


gs._end_race = _end_race


def _flush_wins(db) -> None:
    while _pending_wins:
        wk, key = _pending_wins.pop(0)
        db.execute("INSERT INTO game_cup (week, player_key, wins) VALUES (?, ?, 1) "
                   "ON CONFLICT(week, player_key) DO UPDATE SET wins = wins + 1", (wk, key))
    db.commit()


def _cup_top(db, wk: str, n: int = 10) -> list:
    people = gs._people(db)
    rows = db.execute("SELECT player_key, wins FROM game_cup WHERE week = ? AND wins > 0 ORDER BY wins DESC, player_key LIMIT ?",
                      (wk, n)).fetchall()
    return [{"key": r["player_key"], "name": people.get(r["player_key"], {}).get("name", "?"),
             "avatar": people.get(r["player_key"], {}).get("avatar"), "wins": r["wins"]} for r in rows]


def _cup_payout(db) -> None:
    prev = gf.week_id(datetime.now(gf.TASHKENT) - timedelta(days=7))
    if db.execute("SELECT 1 FROM game_cup_paid WHERE week = ?", (prev,)).fetchone():
        return
    top = _cup_top(db, prev, 3)
    if not top:
        return
    cur = db.execute("INSERT OR IGNORE INTO game_cup_paid (week, winners, paid_at) VALUES (?, ?, ?)",
                     (prev, json.dumps([t["key"] for t in top]), time.time()))
    db.commit()
    if not cur.rowcount:
        return
    for i, t in enumerate(top):
        gs.add_money(db, t["key"], CUP_PRIZES[i])
        gs._notify(t["key"], f"🏆 Avtopoyga chempionati: {i + 1}-o'rin! +{_money(CUP_PRIZES[i])} so'm")


@bp.get("/api/game/cup")
@login_required
def api_cup():
    key = _me()
    db = get_db()
    _flush_wins(db)
    _cup_payout(db)
    top = _cup_top(db, gf.week_id())
    for i, t in enumerate(top):
        t["place"], t["me"] = i + 1, t["key"] == key
    mine = db.execute("SELECT wins FROM game_cup WHERE week = ? AND player_key = ?", (gf.week_id(), key)).fetchone()
    prev = gf.week_id(datetime.now(gf.TASHKENT) - timedelta(days=7))
    champs = db.execute("SELECT winners FROM game_cup_paid WHERE week = ?", (prev,)).fetchone()
    people = gs._people(db)
    last = [people.get(k, {}).get("name", "?") for k in json.loads(champs["winners"])] if champs else []
    return jsonify(top=top, my_wins=mine["wins"] if mine else 0, prizes=CUP_PRIZES, last=last, week=gf.week_id())


# --------------------------------------------------------------------------- #
#  Sinxron: ekinlar, rais toji, poyga g'alabalari
# --------------------------------------------------------------------------- #
def _life_hook(db, key: str, row, now: float, response: dict) -> None:
    if _pending_wins:
        _flush_wins(db)
    if now - _cup_check["t"] > 60:
        _cup_check["t"] = now
        _cup_payout(db)
    response["farm"] = farm_list(db, now)
    response["mayor"] = mayor_key(db)


game.SYNC_HOOKS.append(_life_hook)


# --------------------------------------------------------------------------- #
#  O'rgimchak odam: shaharda kichkina o'rgimchak yashiringan. Topgan odamni chaqadi —
#  u o'rgimchak odamga aylanadi (tomlarga chiqadi, to'r otib uchadi). Keyin o'rgimchak
#  boshqa joyga yashirinadi.
# --------------------------------------------------------------------------- #
SPIDER_SPOTS = [  # ko'zga tashlanmaydigan burchaklar
    {"x": 45, "y": 45}, {"x": 3330, "y": 40}, {"x": 6680, "y": 45}, {"x": 45, "y": 3755},
    {"x": 3300, "y": 3760}, {"x": 6675, "y": 3750}, {"x": 6680, "y": 1880}, {"x": 40, "y": 2240},
    {"x": 1760, "y": -1250}, {"x": 3350, "y": -1240}, {"x": 2620, "y": -1270}, {"x": 6680, "y": 4150},
]
SPIDER_SEE = 420     # shundan yaqin kelganda o'rgimchak ko'rinadi
SPIDER_REACH = 80    # shundan yaqin bo'lsa ushlab olsa bo'ladi
_spider = {"spot": random.randrange(len(SPIDER_SPOTS))}


def _spider_pos() -> dict:
    return SPIDER_SPOTS[_spider["spot"]]


@bp.post("/api/game/spider/catch")
@login_required
def api_spider_catch():
    user = current_user()
    key = game.player_key(user)
    db = get_db()
    row = game.ensure_player(db, key)
    if row["spider"]:
        return jsonify(error="Siz allaqachon o'rgimchak odamsiz 🕷️"), 400
    pos = _spider_pos()
    if not gf._near(key, pos["x"], pos["y"], SPIDER_REACH):
        return jsonify(error="O'rgimchak yaqinida emassiz"), 400
    db.execute("UPDATE game_players SET spider = 1 WHERE player_key = ?", (key,))
    db.commit()
    with game._lock:
        # o'rgimchak boshqa joyga qochib yashirinadi
        _spider["spot"] = random.choice([i for i in range(len(SPIDER_SPOTS)) if i != _spider["spot"]])
        game._chat.append({"id": next(game._msg_ids), "key": "owner", "name": "🕷️ O'rgimchak", "avatar": None, "t": time.time(),
                           "text": f"{user['name']}ni o'rgimchak chaqdi — endi u o'rgimchak odam! O'rgimchak yana yashirindi…"})
    return jsonify(ok=True, spider=True)


@bp.post("/api/game/spider/on")
@login_required
def api_spider_on():
    """Owner istagan payt o'rgimchak odam bo'ladi (o'rgimchakni qidirmasdan)."""
    if current_user()["role"] != "owner":
        return jsonify(error="Avval o'rgimchakni toping 🕷️"), 403
    db = get_db()
    game.ensure_player(db, "owner")
    db.execute("UPDATE game_players SET spider = 1 WHERE player_key = 'owner'")
    db.commit()
    return jsonify(ok=True, spider=True)


@bp.post("/api/game/spider/off")
@login_required
def api_spider_off():
    """Kuchdan voz kechish (oddiy odamga qaytish)."""
    key = _me()
    db = get_db()
    db.execute("UPDATE game_players SET spider = 0 WHERE player_key = ?", (key,))
    db.commit()
    return jsonify(ok=True, spider=False)


def _spider_hook(db, key: str, row, now: float, response: dict) -> None:
    response["spider_me"] = bool(row["spider"])
    pos = _spider_pos()
    p = game._live.get(key)
    # Faqat yaqin kelganda yuboriladi — tarmoqdan qidirib topib bo'lmaydi
    response["spider_bug"] = dict(pos) if p and math.hypot(p["x"] - pos["x"], p["y"] - pos["y"]) <= SPIDER_SEE else None


game.SYNC_HOOKS.append(_spider_hook)


# --------------------------------------------------------------------------- #
#  Dron: tepadan shaharni ko'rish va surat olish
# --------------------------------------------------------------------------- #
DRONE_PRICE = 50000


@bp.post("/api/game/drone")
@login_required
def api_drone_buy():
    key = _me()
    db = get_db()
    game.ensure_player(db, key)

    def change(row, money):
        if row["drone"]:
            raise game.GameError("Dron sizda bor")
        if money < DRONE_PRICE:
            raise game.GameError("Pul yetarli emas")
        return -DRONE_PRICE, lambda: db.execute("UPDATE game_players SET drone = 1 WHERE player_key = ?", (key,))

    _, err = gs._change(db, key, change)
    return err or jsonify(drone=True, economy=gf._econ(db, key))


# --------------------------------------------------------------------------- #
#  Kosmik raketa: kosmodromdan Oyga sayohat (eng boylar uchun)
# --------------------------------------------------------------------------- #
@bp.post("/api/game/rocket")
@login_required
def api_rocket():
    user = current_user()
    key = game.player_key(user)
    db = get_db()
    game.ensure_player(db, key)
    pad = game.ROCKET
    if not gf._near(key, pad["x"], pad["y"], 220):
        return jsonify(error="Kosmodromga boring (aeroportning janubida)"), 400

    def change(row, money):
        if money < pad["price"]:
            raise game.GameError(f"Oyga sayohat {_money(pad['price'])} so'm turadi")
        return -pad["price"], lambda: db.execute("UPDATE game_players SET moon = moon + 1 WHERE player_key = ?", (key,))

    row, err = gs._change(db, key, change)
    if err:
        return err
    times = gs._row(db, key)["moon"]
    with game._lock:
        game._chat.append({"id": next(game._msg_ids), "key": "owner", "name": "🚀 Kosmodrom", "avatar": None, "t": time.time(),
                           "text": f"{user['name']} Oyga uchdi! 🌕 ({times}-marta)"})
    return jsonify(ok=True, times=times, economy=gf._econ(db, key))


def _extras_hook(db, key: str, row, now: float, response: dict) -> None:
    response["drone"] = bool(row["drone"])
    response["moon"] = row["moon"]


game.SYNC_HOOKS.append(_extras_hook)


SCHEMA = """
CREATE TABLE IF NOT EXISTS game_candidates (
    month      TEXT NOT NULL,
    player_key TEXT NOT NULL,
    at         REAL NOT NULL,
    PRIMARY KEY (month, player_key)
);
CREATE TABLE IF NOT EXISTS game_votes (
    month TEXT NOT NULL,
    voter TEXT NOT NULL,
    cand  TEXT NOT NULL,
    PRIMARY KEY (month, voter)
);
CREATE TABLE IF NOT EXISTS game_mayor_pay (
    day        TEXT PRIMARY KEY,
    player_key TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS game_farm (
    plot       INTEGER PRIMARY KEY,
    owner_key  TEXT NOT NULL,
    crop       TEXT NOT NULL,
    planted_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS game_cup (
    week       TEXT NOT NULL,
    player_key TEXT NOT NULL,
    wins       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (week, player_key)
);
CREATE TABLE IF NOT EXISTS game_cup_paid (
    week    TEXT PRIMARY KEY,
    winners TEXT NOT NULL,
    paid_at REAL NOT NULL
);
"""
