"""Mahalla — qo'shimchalar.

Bank (omonat foiz bilan o'sadi) va kredit (qaytarish kerak), boylar reytingi, klanlar
(umumiy xazina va bayroq), do'stga mashina yoki uy sovg'a qilish, odamchaning ko'rinishi
(soch, kiyim, shapka), uy ichidagi mebel, mashina poygasi (pul tikiladi) va bog'dagi futbol to'pi.
"""
import json
import math
import re
import threading
import time

from flask import Blueprint, jsonify, request

import config
import game
from core import avatar_url, current_user, get_db, login_required

bp = Blueprint("game_social", __name__)

MAX_AMOUNT = 10 ** 18


def _amount(value, low: int = 1) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= MAX_AMOUNT:
        return None
    return value


def _row(db, key: str):
    return db.execute("SELECT * FROM game_players WHERE player_key = ?", (key,)).fetchone()


def _people(db) -> dict:
    return {p["key"]: p for p in game._all_people(db)}


def add_money(db, key: str, amount: float) -> None:
    """O'yinchi hisobiga pul qo'shish (yig'ilgan daromad ham hisobga olinadi)."""
    with game._econ_lock:
        row = _row(db, key)
        if row is None:
            return
        now = time.time()
        money = game.money_now(row, game.player_rate(db, row), now)
        db.execute("UPDATE game_players SET money = ?, income_at = ? WHERE player_key = ?",
                   (money + amount, now, key))
        db.commit()


def _change(db, key: str, change):
    """game.apply_change — xato bo'lsa (GameError) 400 javob."""
    try:
        return game.apply_change(db, key, change), None
    except game.GameError as err:
        return None, (jsonify(error=str(err)), 400)


# --------------------------------------------------------------------------- #
#  Bank va kredit
# --------------------------------------------------------------------------- #
BANK_RATE = 0.01        # omonat har soatda 1% o'sadi
LOAN_RATE = 0.02        # kredit qarzi har soatda 2% o'sadi
GROW_MAX_HOURS = 72     # foiz eng ko'pi bilan shuncha soat hisoblanadi
LOAN_HOURS = 24         # kreditni shuncha soatda qaytarish kerak, keyin puldan o'zi yechiladi
LOAN_BASE = 50000       # kredit chegarasi: 50 000 + bir soatlik daromad


def _grow(value: float, since: float, rate: float, now: float) -> float:
    if value <= 0:
        return 0.0
    hours = min(max(now - since, 0) / 3600, GROW_MAX_HOURS)
    return value * (1 + rate) ** hours


def bank_now(row, now: float) -> float:
    return _grow(row["bank"], row["bank_at"], BANK_RATE, now)


def loan_now(row, now: float) -> float:
    return _grow(row["loan"], row["loan_at"], LOAN_RATE, now)


def _debt(loan: float) -> int:
    """Qarz butun so'mda (bir necha millisoniyalik foiz 1 so'mga yaxlitlanib ketmasin)."""
    return math.ceil(loan - 0.01) if loan >= 1 else 0


def loan_limit(db, row) -> int:
    return int(min(10 ** 12, LOAN_BASE + game.player_rate(db, row) * 3600))


def bank_json(db, row) -> dict:
    now = time.time()
    loan = loan_now(row, now)
    return {
        "bank": math.floor(bank_now(row, now)),
        "loan": _debt(loan),
        "loan_left": max(0, round(row["loan_due"] - now)) if loan >= 1 else None,
        "limit": loan_limit(db, row),
        "bank_rate": BANK_RATE, "loan_rate": LOAN_RATE, "loan_hours": LOAN_HOURS,
    }


@bp.get("/api/game/bank")
@login_required
def api_bank():
    key = game.player_key(current_user())
    db = get_db()
    row = game.ensure_player(db, key)
    return jsonify(bank=bank_json(db, row), economy=game.economy_json(db, row))


@bp.post("/api/game/bank")
@login_required
def api_bank_action():
    key = game.player_key(current_user())
    data = request.get_json(silent=True) or {}
    action = data.get("action")
    amount = _amount(data.get("amount"))
    if action not in ("deposit", "withdraw", "borrow", "repay"):
        return jsonify(error="Noma'lum amal"), 400
    if amount is None:
        return jsonify(error="Summani yozing (butun son)"), 400
    db = get_db()
    game.ensure_player(db, key)
    done = {}

    def change(row, money):
        now = time.time()
        bank, loan = bank_now(row, now), loan_now(row, now)
        if action == "deposit":
            if money < amount:
                raise game.GameError("Pul yetarli emas")
            return -amount, lambda: db.execute(
                "UPDATE game_players SET bank = ?, bank_at = ? WHERE player_key = ?", (bank + amount, now, key))
        if action == "withdraw":
            if bank + 0.5 < amount:
                raise game.GameError("Bankda buncha pul yo'q")
            return amount, lambda: db.execute(
                "UPDATE game_players SET bank = ?, bank_at = ? WHERE player_key = ?", (max(0.0, bank - amount), now, key))
        if action == "borrow":
            if loan >= 1:
                raise game.GameError("Avval eski kreditni to'lang")
            limit = loan_limit(db, row)
            if amount > limit:
                raise game.GameError(f"Eng ko'pi bilan {limit:,} so'm kredit olish mumkin".replace(",", " "))
            return amount, lambda: db.execute(
                "UPDATE game_players SET loan = ?, loan_at = ?, loan_due = ? WHERE player_key = ?",
                (float(amount), now, now + LOAN_HOURS * 3600, key))
        # repay
        if loan < 1:
            raise game.GameError("Sizda qarz yo'q")
        pay = min(amount, _debt(loan))
        if money < pay:
            raise game.GameError("Pul yetarli emas")
        done["paid"] = pay
        left = loan - pay
        if left < 1:
            return -pay, lambda: db.execute(
                "UPDATE game_players SET loan = 0, loan_at = 0, loan_due = 0 WHERE player_key = ?", (key,))
        return -pay, lambda: db.execute(
            "UPDATE game_players SET loan = ?, loan_at = ? WHERE player_key = ?", (left, now, key))

    row, err = _change(db, key, change)
    if err:
        return err
    return jsonify(bank=bank_json(db, row), economy=game.economy_json(db, row), **done)


_collect_at: dict[str, float] = {}


def _collect_overdue(db, key: str, row, now: float, response: dict) -> None:
    """Kredit muddati o'tgan bo'lsa — qarz puldan o'zi yechiladi (har 10 soniyada tekshiriladi)."""
    if row["loan"] <= 0 or now < row["loan_due"] or now - _collect_at.get(key, 0) < 10:
        return
    _collect_at[key] = now
    taken = {}

    def change(r, money):
        loan = loan_now(r, now)
        pay = max(0, min(math.floor(money), _debt(loan)))
        taken["sum"] = pay
        left = loan - pay
        if left < 1:
            return -pay, lambda: db.execute(
                "UPDATE game_players SET loan = 0, loan_at = 0, loan_due = 0 WHERE player_key = ?", (key,))
        return -pay, lambda: db.execute(
            "UPDATE game_players SET loan = ?, loan_at = ? WHERE player_key = ?", (left, now, key))

    new_row = game.apply_change(db, key, change)
    if taken.get("sum"):
        response["economy"] = game.economy_json(db, new_row)
        response["loan_collected"] = taken["sum"]


# --------------------------------------------------------------------------- #
#  Boylar reytingi
# --------------------------------------------------------------------------- #
def wealth_of(db, row, now: float) -> dict:
    money = game.money_now(row, game.player_rate(db, row), now)
    prop = sum(game.invested(p["kind"], p["level"]) + (0 if p["plot"] == row["plot"] else game.LAND_PRICE)
               for p in game.my_plots(db, row["player_key"]))
    total = money + bank_now(row, now) - loan_now(row, now) + prop
    return {"wealth": math.floor(total), "money": math.floor(money), "property": prop}


@bp.get("/api/game/top")
@login_required
def api_top():
    me = game.player_key(current_user())
    db = get_db()
    game.ensure_player(db, me)
    now = time.time()
    people = _people(db)
    rows = db.execute(
        "SELECT p.*, c.tag AS clan_tag, c.color AS clan_color FROM game_players p "
        "LEFT JOIN game_clans c ON c.id = p.clan WHERE p.player_key != 'owner'").fetchall()
    board = []
    for r in rows:
        person = people.get(r["player_key"])
        if not person:
            continue
        board.append({"key": r["player_key"], "name": person["name"], "avatar": person["avatar"],
                      "clan": {"tag": r["clan_tag"], "color": r["clan_color"]} if r["clan_tag"] else None,
                      **wealth_of(db, r, now)})
    board.sort(key=lambda b: -b["wealth"])
    for i, b in enumerate(board):
        b["place"] = i + 1
        b["me"] = b["key"] == me
    mine = next((b for b in board if b["me"]), None)
    return jsonify(top=board[:10], me=mine, total=len(board))


# --------------------------------------------------------------------------- #
#  Klanlar
# --------------------------------------------------------------------------- #
CLAN_PRICE = 50000
CLAN_MAX = 12
CLAN_COLORS = ["#dc2626", "#2563eb", "#16a34a", "#f59e0b", "#7c3aed", "#ec4899", "#0f172a", "#14b8a6"]
CLAN_NAME_RE = re.compile(r"^[\w' -]{3,20}$")
CLAN_TAG_RE = re.compile(r"^[A-Z0-9]{2,4}$")


def _clan_json(db, clan, people: dict, me: str) -> dict:
    members = [r["player_key"] for r in db.execute(
        "SELECT player_key FROM game_players WHERE clan = ? ORDER BY player_key", (clan["id"],))]
    return {
        "id": clan["id"], "name": clan["name"], "tag": clan["tag"], "color": clan["color"],
        "money": math.floor(clan["money"]), "leader": clan["leader"],
        "leader_name": people.get(clan["leader"], {}).get("name", "?"),
        "members": [{"key": k, "name": people[k]["name"], "avatar": people[k]["avatar"], "me": k == me}
                    for k in members if k in people],
    }


def _clans_response(db, me: str):
    people = _people(db)
    row = _row(db, me)
    clans = [_clan_json(db, c, people, me) for c in db.execute("SELECT * FROM game_clans ORDER BY money DESC, id")]
    return jsonify(clans=clans, my=row["clan"] if row else None, price=CLAN_PRICE, max=CLAN_MAX,
                   colors=CLAN_COLORS, economy=game.economy_json(db, row))


@bp.get("/api/game/clans")
@login_required
def api_clans():
    me = game.player_key(current_user())
    db = get_db()
    game.ensure_player(db, me)
    return _clans_response(db, me)


@bp.post("/api/game/clans")
@login_required
def api_clan_create():
    me = game.player_key(current_user())
    data = request.get_json(silent=True) or {}
    name = " ".join(str(data.get("name") or "").split())
    tag = str(data.get("tag") or "").strip().upper()
    color = data.get("color")
    if not CLAN_NAME_RE.match(name):
        return jsonify(error="Klan nomi 3–20 ta harf bo'lsin"), 400
    if not CLAN_TAG_RE.match(tag):
        return jsonify(error="Bayroq yozuvi 2–4 ta lotin harf yoki raqam bo'lsin (masalan: ARS)"), 400
    if color not in CLAN_COLORS:
        return jsonify(error="Bayroq rangini tanlang"), 400
    db = get_db()
    game.ensure_player(db, me)
    if db.execute("SELECT 1 FROM game_clans WHERE name = ?", (name,)).fetchone():
        return jsonify(error="Bunday nomli klan bor"), 400

    def change(row, money):
        if row["clan"]:
            raise game.GameError("Siz allaqachon klandasiz")
        if money < CLAN_PRICE:
            raise game.GameError("Pul yetarli emas")

        def mutate():
            cur = db.execute("INSERT INTO game_clans (name, tag, color, leader, money, created_at) "
                             "VALUES (?, ?, ?, ?, 0, ?)", (name, tag, color, me, time.time()))
            db.execute("UPDATE game_players SET clan = ? WHERE player_key = ?", (cur.lastrowid, me))
        return -CLAN_PRICE, mutate

    _, err = _change(db, me, change)
    return err or _clans_response(db, me)


@bp.post("/api/game/clans/<int:clan_id>/join")
@login_required
def api_clan_join(clan_id: int):
    me = game.player_key(current_user())
    db = get_db()
    row = game.ensure_player(db, me)
    if row["clan"]:
        return jsonify(error="Avval hozirgi klandan chiqing"), 400
    if not db.execute("SELECT 1 FROM game_clans WHERE id = ?", (clan_id,)).fetchone():
        return jsonify(error="Bunday klan yo'q"), 404
    count = db.execute("SELECT COUNT(*) FROM game_players WHERE clan = ?", (clan_id,)).fetchone()[0]
    if count >= CLAN_MAX:
        return jsonify(error=f"Klan to'la ({CLAN_MAX} kishi)"), 400
    db.execute("UPDATE game_players SET clan = ? WHERE player_key = ?", (clan_id, me))
    db.commit()
    return _clans_response(db, me)


def _leave_clan(db, key: str) -> None:
    row = _row(db, key)
    if not row or not row["clan"]:
        return
    clan = db.execute("SELECT * FROM game_clans WHERE id = ?", (row["clan"],)).fetchone()
    db.execute("UPDATE game_players SET clan = NULL WHERE player_key = ?", (key,))
    if clan:
        rest = [r["player_key"] for r in db.execute(
            "SELECT player_key FROM game_players WHERE clan = ? ORDER BY player_key", (clan["id"],))]
        if not rest:
            db.execute("DELETE FROM game_clans WHERE id = ?", (clan["id"],))
            db.commit()
            if clan["money"] > 0:  # oxirgi a'zo — xazina unga qaytadi
                add_money(db, key, clan["money"])
            return
        if clan["leader"] == key:
            db.execute("UPDATE game_clans SET leader = ? WHERE id = ?", (rest[0], clan["id"]))
    db.commit()


@bp.post("/api/game/clans/leave")
@login_required
def api_clan_leave():
    me = game.player_key(current_user())
    db = get_db()
    game.ensure_player(db, me)
    _leave_clan(db, me)
    return _clans_response(db, me)


@bp.post("/api/game/clans/kick")
@login_required
def api_clan_kick():
    me = game.player_key(current_user())
    target = (request.get_json(silent=True) or {}).get("key")
    db = get_db()
    row = game.ensure_player(db, me)
    clan = row["clan"] and db.execute("SELECT * FROM game_clans WHERE id = ?", (row["clan"],)).fetchone()
    if not clan or clan["leader"] != me:
        return jsonify(error="Faqat klan boshlig'i chiqarib yubora oladi"), 403
    other = _row(db, target) if isinstance(target, str) else None
    if not other or other["clan"] != clan["id"] or target == me:
        return jsonify(error="Bu odam klaningizda emas"), 400
    db.execute("UPDATE game_players SET clan = NULL WHERE player_key = ?", (target,))
    db.commit()
    return _clans_response(db, me)


@bp.post("/api/game/clans/deposit")
@login_required
def api_clan_deposit():
    """Xazinaga o'z pulingizdan qo'shish."""
    me = game.player_key(current_user())
    amount = _amount((request.get_json(silent=True) or {}).get("amount"))
    if amount is None:
        return jsonify(error="Summani yozing (butun son)"), 400
    db = get_db()
    game.ensure_player(db, me)

    def change(row, money):
        if not row["clan"]:
            raise game.GameError("Siz klanda emassiz")
        if money < amount:
            raise game.GameError("Pul yetarli emas")
        return -amount, lambda: db.execute("UPDATE game_clans SET money = money + ? WHERE id = ?", (amount, row["clan"]))

    _, err = _change(db, me, change)
    return err or _clans_response(db, me)


@bp.post("/api/game/clans/pay")
@login_required
def api_clan_pay():
    """Klan boshlig'i xazinadan a'zoga (yoki o'ziga) pul beradi."""
    user = current_user()
    me = game.player_key(user)
    data = request.get_json(silent=True) or {}
    amount = _amount(data.get("amount"))
    to = data.get("to") or me
    if amount is None:
        return jsonify(error="Summani yozing (butun son)"), 400
    db = get_db()
    row = game.ensure_player(db, me)
    if not isinstance(to, str):
        return jsonify(error="Kimga berishni tanlang"), 400
    with game._econ_lock:
        clan = row["clan"] and db.execute("SELECT * FROM game_clans WHERE id = ?", (row["clan"],)).fetchone()
        if not clan or clan["leader"] != me:
            return jsonify(error="Xazinadan faqat klan boshlig'i pul bera oladi"), 403
        target = _row(db, to)
        if not target or target["clan"] != clan["id"]:
            return jsonify(error="Bu odam klaningizda emas"), 400
        if clan["money"] < amount:
            return jsonify(error="Xazinada buncha pul yo'q"), 400
        db.execute("UPDATE game_clans SET money = money - ? WHERE id = ?", (amount, clan["id"]))
        db.commit()
    add_money(db, to, amount)
    if to != me:
        _notify(to, f"{user['name']} klan xazinasidan sizga {amount:,} so'm berdi!".replace(",", " "))
    return _clans_response(db, me)


# --------------------------------------------------------------------------- #
#  Sovg'a: mashina yoki uy
# --------------------------------------------------------------------------- #
def _notify(key: str, text: str) -> None:
    with game._lock:
        inbox = game._gifts.setdefault(key, [])
        inbox.append({"text": text})
        del inbox[:-20]


@bp.post("/api/game/gift")
@login_required
def api_gift():
    user = current_user()
    me = game.player_key(user)
    data = request.get_json(silent=True) or {}
    to, car, plot = data.get("to"), data.get("car"), data.get("plot")
    db = get_db()
    target = _people(db).get(to) if isinstance(to, str) else None
    if target is None:
        return jsonify(error="Bunday odam yo'q"), 404
    if to == me:
        return jsonify(error="O'zingizga sovg'a qilib bo'lmaydi"), 400
    game.ensure_player(db, me)
    game.ensure_player(db, to)
    with game._econ_lock:
        mine = _row(db, me)
        if isinstance(car, str):
            cars = json.loads(mine["cars"])
            theirs = json.loads(_row(db, to)["cars"])
            if car not in cars:
                return jsonify(error="Bu mashina sizda yo'q"), 400
            if car in theirs:
                return jsonify(error=f"{target['name']}da bu mashina bor"), 400
            cars.remove(car)
            db.execute("UPDATE game_players SET cars = ? WHERE player_key = ?", (json.dumps(cars), me))
            db.execute("UPDATE game_players SET cars = ? WHERE player_key = ?", (json.dumps(theirs + [car]), to))
            thing = game.CARS_BY_ID[car]["name"] if car in game.CARS_BY_ID else "mashina"
        elif isinstance(plot, int) and not isinstance(plot, bool):
            rec = db.execute("SELECT * FROM game_plots WHERE plot = ? AND owner_key = ?", (plot, me)).fetchone()
            if rec is None:
                return jsonify(error="Bu yer sizniki emas"), 400
            if plot == mine["plot"]:
                return jsonify(error="Ota hovlini sovg'a qilib bo'lmaydi"), 400
            db.execute("UPDATE game_plots SET owner_key = ?, sale_price = NULL WHERE plot = ?", (to, plot))
            thing = (f"{game.variant_name(rec['kind'], rec['variant'])} ({rec['level']} qavat)"
                     if rec["kind"] else f"Yer №{plot + 1}")
        else:
            return jsonify(error="Nimani sovg'a qilishni tanlang"), 400
        db.commit()
    _notify(to, f"{user['name']} sizga sovg'a qildi: {thing}!")
    row = _row(db, me)
    return jsonify(economy=game.economy_json(db, row), plots=game.plots_list(db), to=target["name"], thing=thing)


# --------------------------------------------------------------------------- #
#  Ko'rinish (soch, kiyim, shapka)
# --------------------------------------------------------------------------- #
@bp.get("/api/game/looks")
@login_required
def api_looks():
    me = game.player_key(current_user())
    db = get_db()
    row = game.ensure_player(db, me)
    return jsonify(looks=game.player_looks(row), options=game.LOOKS)


@bp.post("/api/game/looks")
@login_required
def api_looks_save():
    me = game.player_key(current_user())
    data = request.get_json(silent=True) or {}
    looks = {}
    for k, allowed in game.LOOKS.items():
        v = data.get(k, "")
        if v not in allowed:
            return jsonify(error="Noto'g'ri tanlov"), 400
        looks[k] = v
    db = get_db()
    game.ensure_player(db, me)
    db.execute("UPDATE game_players SET looks = ? WHERE player_key = ?", (json.dumps(looks), me))
    db.commit()
    return jsonify(looks=looks)


# --------------------------------------------------------------------------- #
#  Uy ichi: mebel
# --------------------------------------------------------------------------- #
ROOM_W, ROOM_D = 10, 8      # xona katakchalari
FURNITURE_MAX = 60
FURNITURE = [
    {"id": "divan", "name": "Divan", "price": 3000, "w": 2, "d": 1, "color": "#2563eb"},
    {"id": "krovat", "name": "Karavot", "price": 5000, "w": 2, "d": 2, "color": "#f8fafc"},
    {"id": "stol", "name": "Stol", "price": 1500, "w": 1, "d": 1, "color": "#92400e"},
    {"id": "stul", "name": "Stul", "price": 600, "w": 1, "d": 1, "color": "#b45309"},
    {"id": "tv", "name": "Televizor", "price": 4000, "w": 2, "d": 1, "color": "#111827"},
    {"id": "shkaf", "name": "Shkaf", "price": 3500, "w": 2, "d": 1, "color": "#78350f"},
    {"id": "muzlatgich", "name": "Muzlatgich", "price": 4500, "w": 1, "d": 1, "color": "#e5e7eb"},
    {"id": "kompyuter", "name": "Kompyuter stoli", "price": 6000, "w": 2, "d": 1, "color": "#334155"},
    {"id": "gul", "name": "Gul (tuvak)", "price": 400, "w": 1, "d": 1, "color": "#16a34a"},
    {"id": "lampa", "name": "Torshyer", "price": 800, "w": 1, "d": 1, "color": "#fde68a"},
    {"id": "akvarium", "name": "Akvarium", "price": 7000, "w": 2, "d": 1, "color": "#38bdf8"},
    {"id": "gilam", "name": "Gilam", "price": 1200, "w": 3, "d": 2, "color": "#b91c1c", "floor": True},
]
FURNITURE_BY_ID = {f["id"]: f for f in FURNITURE}


def _cells(item: dict) -> set:
    f = FURNITURE_BY_ID[item["item"]]
    w, d = (f["d"], f["w"]) if item["r"] % 2 else (f["w"], f["d"])
    return {(item["x"] + i, item["z"] + j) for i in range(w) for j in range(d)}


def _fits(items: list, new: dict, skip: int | None = None) -> str | None:
    cells = _cells(new)
    if any(not (0 <= x < ROOM_W and 0 <= z < ROOM_D) for x, z in cells):
        return "Xonaga sig'maydi"
    floor = FURNITURE_BY_ID[new["item"]].get("floor")
    for i, other in enumerate(items):
        if i == skip or bool(FURNITURE_BY_ID[other["item"]].get("floor")) != bool(floor):
            continue  # gilam ustiga mebel qo'yish mumkin
        if cells & _cells(other):
            return "Bu joy band"
    return None


def _my_built_plot(db, key: str, plot_id: int):
    rec = db.execute("SELECT * FROM game_plots WHERE plot = ?", (plot_id,)).fetchone()
    if rec is None or rec["owner_key"] != key:
        return None, (jsonify(error="Bu bino sizniki emas"), 403)
    if not rec["kind"]:
        return None, (jsonify(error="Avval bino quring"), 400)
    return rec, None


def _load_items(rec) -> list:
    try:
        items = json.loads(rec["furniture"] or "[]")
    except ValueError:
        return []
    return [i for i in items if isinstance(i, dict) and i.get("item") in FURNITURE_BY_ID]


def _room_json(db, rec, key: str):
    row = _row(db, key)
    return jsonify(plot=rec["plot"], kind=rec["kind"], variant=rec["variant"], level=rec["level"],
                   items=_load_items(rec), catalog=FURNITURE, room={"w": ROOM_W, "d": ROOM_D, "max": FURNITURE_MAX},
                   economy=game.economy_json(db, row))


@bp.get("/api/game/plots/<int:plot_id>/furniture")
@login_required
def api_furniture(plot_id: int):
    me = game.player_key(current_user())
    db = get_db()
    game.ensure_player(db, me)
    rec, err = _my_built_plot(db, me, plot_id)
    return err or _room_json(db, rec, me)


@bp.post("/api/game/plots/<int:plot_id>/furniture")
@login_required
def api_furniture_change(plot_id: int):
    me = game.player_key(current_user())
    data = request.get_json(silent=True) or {}
    action = data.get("action")
    db = get_db()
    game.ensure_player(db, me)
    rec, err = _my_built_plot(db, me, plot_id)
    if err:
        return err

    def change(row, money):
        items = _load_items(db.execute("SELECT * FROM game_plots WHERE plot = ?", (plot_id,)).fetchone())
        save = lambda: db.execute("UPDATE game_plots SET furniture = ? WHERE plot = ?", (json.dumps(items), plot_id))
        if action == "add":
            f = FURNITURE_BY_ID.get(data.get("item"))
            x, z, r = data.get("x"), data.get("z"), data.get("r", 0)
            if not f or not all(isinstance(v, int) and not isinstance(v, bool) for v in (x, z, r)):
                raise game.GameError("Noto'g'ri mebel")
            if len(items) >= FURNITURE_MAX:
                raise game.GameError(f"Xonaga ko'pi bilan {FURNITURE_MAX} ta narsa sig'adi")
            new = {"item": f["id"], "x": x, "z": z, "r": r % 4}
            problem = _fits(items, new)
            if problem:
                raise game.GameError(problem)
            if money < f["price"]:
                raise game.GameError("Pul yetarli emas")
            items.append(new)
            return -f["price"], save
        index = data.get("index")
        if not isinstance(index, int) or isinstance(index, bool) or not 0 <= index < len(items):
            raise game.GameError("Bunday mebel yo'q")
        if action == "remove":
            refund = FURNITURE_BY_ID[items[index]["item"]]["price"] // 2
            items.pop(index)
            return refund, save
        if action == "rotate":
            turned = {**items[index], "r": (items[index]["r"] + 1) % 4}
            problem = _fits(items, turned, skip=index)
            if problem:
                raise game.GameError("Burab bo'lmaydi — joy yetmaydi")
            items[index] = turned
            return 0, save
        raise game.GameError("Noma'lum amal")

    _, err = _change(db, me, change)
    if err:
        return err
    rec = db.execute("SELECT * FROM game_plots WHERE plot = ?", (plot_id,)).fetchone()
    return _room_json(db, rec, me)


# --------------------------------------------------------------------------- #
#  Poyga: ikki o'yinchi marragacha, g'olib tikilgan pulni oladi
# --------------------------------------------------------------------------- #
RACE_INVITE_TTL = 30
RACE_COUNTDOWN = 4
RACE_TIMEOUT = 240
RACE_FINISH_DIST = 120
RACE_SHOW_RESULT = 8
_invites: dict[str, dict] = {}   # kimga -> {from, name, bet, t}
_races: dict[int, dict] = {}
_race_of: dict[str, int] = {}
_race_ids = iter(range(1, 10 ** 9))


def _in_race(key: str) -> bool:
    rid = _race_of.get(key)
    return bool(rid and rid in _races and _races[rid]["winner"] is None)


@bp.post("/api/game/race/invite")
@login_required
def api_race_invite():
    user = current_user()
    me = game.player_key(user)
    data = request.get_json(silent=True) or {}
    to = data.get("to")
    bet = _amount(data.get("bet"), low=0)
    if bet is None:
        return jsonify(error="Tikiladigan pulni yozing (0 ham bo'ladi)"), 400
    if to == me or not isinstance(to, str):
        return jsonify(error="Kim bilan poyga qilishni tanlang"), 400
    db = get_db()
    row = game.ensure_player(db, me)
    if game.money_now(row, game.player_rate(db, row)) < bet:
        return jsonify(error="Pul yetarli emas"), 400
    now = time.time()
    with game._lock:
        other = game._live_pos(to, now)
        if other is None:
            return jsonify(error="Bu odam hozir o'yinda emas"), 400
        if _in_race(me) or _in_race(to):
            return jsonify(error="Kimdir allaqachon poygada"), 400
        _invites[to] = {"from": me, "name": user["name"], "bet": bet, "t": now}
        name = other["name"]
    return jsonify(ok=True, to=name)


def _race_json(key: str, now: float) -> dict | None:
    rid = _race_of.get(key)
    r = _races.get(rid) if rid else None
    if not r:
        return None
    if r["winner"] is not None and now - r["ended"] > RACE_SHOW_RESULT:
        _race_of.pop(key, None)
        if not any(_race_of.get(k) == rid for k in (r["a"], r["b"])):
            _races.pop(rid, None)
        return None
    opp = r["b"] if key == r["a"] else r["a"]
    result = None
    if r["winner"] is not None:
        result = "me" if r["winner"] == key else ("draw" if r["winner"] == "" else "opp")
    return {"id": rid, "opp": r["names"][opp], "opp_key": opp, "bet": r["bet"], "fx": r["fx"], "fy": r["fy"],
            "start_in": round(r["start"] - now, 2), "result": result}


@bp.post("/api/game/race/accept")
@login_required
def api_race_accept():
    me = game.player_key(current_user())
    db = get_db()
    game.ensure_player(db, me)
    now = time.time()
    with game._lock:
        inv = _invites.pop(me, None)
        if not inv or now - inv["t"] > RACE_INVITE_TTL:
            return jsonify(error="Taklif eskirdi"), 400
        a, b = game._live_pos(inv["from"], now), game._live_pos(me, now)
        if a is None or b is None:
            return jsonify(error="Raqib o'yindan chiqib ketdi"), 400
        if _in_race(me) or _in_race(inv["from"]):
            return jsonify(error="Kimdir allaqachon poygada"), 400
        mid = ((a["x"] + b["x"]) / 2, (a["y"] + b["y"]) / 2)
        names = {inv["from"]: a["name"], me: b["name"]}
    bet = inv["bet"]
    if bet:
        with game._econ_lock:
            rows = {k: _row(db, k) for k in (inv["from"], me)}
            cash = {k: game.money_now(r, game.player_rate(db, r), now) for k, r in rows.items()}
            if cash[me] < bet:
                return jsonify(error="Pul yetarli emas"), 400
            if cash[inv["from"]] < bet:
                return jsonify(error=f"{names[inv['from']]}da pul yetarli emas"), 400
            for k in rows:
                db.execute("UPDATE game_players SET money = ?, income_at = ? WHERE player_key = ?", (cash[k] - bet, now, k))
            db.commit()
    # Marra — ikkalasining o'rtasidan 1400–2600 birlik uzoqda, yo'l chetida
    with game._lock:
        best = None
        for _ in range(300):
            x, y = game._sidewalk_spot()
            d = math.hypot(x - mid[0], y - mid[1])
            if 1400 <= d <= 2600:
                best = (x, y)
                break
            if best is None or abs(d - 2000) < abs(math.hypot(best[0] - mid[0], best[1] - mid[1]) - 2000):
                best = (x, y)
        rid = next(_race_ids)
        _races[rid] = {"a": inv["from"], "b": me, "names": names, "bet": bet, "fx": best[0], "fy": best[1],
                       "start": now + RACE_COUNTDOWN, "winner": None, "ended": 0}
        _race_of[inv["from"]] = rid
        _race_of[me] = rid
        race = _race_json(me, now)
    row = _row(db, me)
    return jsonify(race=race, economy=game.economy_json(db, row))


@bp.post("/api/game/race/decline")
@login_required
def api_race_decline():
    user = current_user()
    me = game.player_key(user)
    with game._lock:
        inv = _invites.pop(me, None)
    if inv:
        _notify(inv["from"], f"{user['name']} poygaga rozi bo'lmadi")
    return jsonify(ok=True)


def _race_hook(db, key: str, row, now: float, response: dict) -> None:
    pay = []
    with game._lock:
        inv = _invites.get(key)
        if inv and now - inv["t"] > RACE_INVITE_TTL:
            _invites.pop(key, None)
            inv = None
        response["race_invite"] = ({"from": inv["from"], "name": inv["name"], "bet": inv["bet"],
                                    "left": round(RACE_INVITE_TTL - (now - inv["t"]))} if inv else None)
        rid = _race_of.get(key)
        r = _races.get(rid) if rid else None
        if r and r["winner"] is None:
            me = game._live.get(key)
            if now >= r["start"] and me and math.hypot(me["x"] - r["fx"], me["y"] - r["fy"]) <= RACE_FINISH_DIST:
                r["winner"], r["ended"] = key, now
                pay.append((key, r["bet"] * 2))
            elif now - r["start"] > RACE_TIMEOUT:
                r["winner"], r["ended"] = "", now  # hech kim yetib kelmadi — pul qaytadi
                pay += [(r["a"], r["bet"]), (r["b"], r["bet"])]
        response["race"] = _race_json(key, now)
    for k, amount in pay:
        if amount:
            add_money(db, k, amount)
    if pay:
        response["economy"] = game.economy_json(db, _row(db, key))


# --------------------------------------------------------------------------- #
#  Futbol to'pi (bog'dagi maydonda, hamma bir xil to'pni ko'radi)
# --------------------------------------------------------------------------- #
BALL_FRICTION = 1.1     # tezlik har soniyada e^-1.1 marta kamayadi
BALL_KICK = 560
BALL_KICK_CAR = 820
BALL_REACH = 100        # tarmoq kechikishi: serverdagi joy bir oz orqada qolishi mumkin
_ball_lock = threading.Lock()
F = game.FIELD
_ball = {"x": F["x"] + F["w"] / 2, "y": F["y"] + F["h"] / 2, "vx": 0.0, "vy": 0.0, "t": time.time(),
         "score": [0, 0], "goal": 0, "goal_by": "", "goal_side": "", "last": ""}


def _ball_center() -> None:
    _ball.update(x=F["x"] + F["w"] / 2, y=F["y"] + F["h"] / 2, vx=0.0, vy=0.0)


def _advance_ball(now: float) -> None:
    dt = min(now - _ball["t"], 20)
    _ball["t"] = now
    h = 1 / 60
    cy = F["y"] + F["h"] / 2
    while dt > 0 and (_ball["vx"] or _ball["vy"]):
        step = min(h, dt)
        dt -= step
        _ball["x"] += _ball["vx"] * step
        _ball["y"] += _ball["vy"] * step
        k = math.exp(-BALL_FRICTION * step)
        _ball["vx"] *= k
        _ball["vy"] *= k
        for axis, lo, hi in (("x", F["x"], F["x"] + F["w"]), ("y", F["y"], F["y"] + F["h"])):
            v = "v" + axis
            if _ball[axis] < lo or _ball[axis] > hi:
                if axis == "x" and abs(_ball["y"] - cy) < game.GOAL_W / 2:
                    side = "right" if _ball[axis] < lo else "left"  # chap darvozaga kirsa — o'ngdagilar gol urdi
                    _ball["score"][0 if side == "left" else 1] += 1
                    _ball.update(goal=_ball["goal"] + 1, goal_by=_ball["last"], goal_side=side)
                    _ball_center()
                    return
                _ball[axis] = min(max(_ball[axis], lo), hi)
                _ball[v] = -_ball[v] * 0.7
        if math.hypot(_ball["vx"], _ball["vy"]) < 4:
            _ball["vx"] = _ball["vy"] = 0.0


def _ball_json() -> dict:
    return {"x": round(_ball["x"], 1), "y": round(_ball["y"], 1), "vx": round(_ball["vx"], 1),
            "vy": round(_ball["vy"], 1), "score": list(_ball["score"]), "goal": _ball["goal"],
            "goal_by": _ball["goal_by"], "goal_side": _ball["goal_side"]}


@bp.post("/api/game/ball/kick")
@login_required
def api_ball_kick():
    user = current_user()
    me = game.player_key(user)
    data = request.get_json(silent=True) or {}
    try:
        dx, dy = float(data.get("dx")), float(data.get("dy"))
    except (TypeError, ValueError):
        return jsonify(error="Noto'g'ri yo'nalish"), 400
    length = math.hypot(dx, dy)
    if not math.isfinite(length) or length < 1e-6:
        return jsonify(error="Noto'g'ri yo'nalish"), 400
    now = time.time()
    with game._lock:
        p = game._live_pos(me, now)
    with _ball_lock:
        _advance_ball(now)
        if p is None or math.hypot(p["x"] - _ball["x"], p["y"] - _ball["y"]) > BALL_REACH:
            return jsonify(error="To'pga yaqinroq boring", ball=_ball_json()), 400
        speed = BALL_KICK_CAR if p["car"] else BALL_KICK
        _ball.update(vx=dx / length * speed, vy=dy / length * speed, last=user["name"])
        return jsonify(ball=_ball_json())


def _ball_hook(db, key: str, row, now: float, response: dict) -> None:
    p = game._live.get(key)
    if not p or math.hypot(p["x"] - (F["x"] + F["w"] / 2), p["y"] - (F["y"] + F["h"] / 2)) > 2600:
        return
    with _ball_lock:
        _advance_ball(now)
        response["ball"] = _ball_json()


def _bank_hook(db, key: str, row, now: float, response: dict) -> None:
    _collect_overdue(db, key, row, now, response)


def _forget(db, key: str) -> None:
    _leave_clan(db, key)
    with game._lock:
        _invites.pop(key, None)



# --------------------------------------------------------------------------- #
#  Uy vazifasi bonusi: panelda yaxshi baho olsangiz — o'yinda pul
# --------------------------------------------------------------------------- #
HOMEWORK_BONUS = 20000   # har bir ijobiy ball uchun (5 ball = 100 000 so'm)


def homework_bonus(db, sub_id: int) -> int:
    """Baholangan ish uchun o'yin puli. Qayta baholansa — faqat farqi qo'shiladi (olib qo'yilmaydi)."""
    row = db.execute("SELECT s.user_id, s.score, s.game_bonus, h.title FROM submissions s "
                     "JOIN homeworks h ON h.id = s.homework_id WHERE s.id = ?", (sub_id,)).fetchone()
    if row is None:
        return 0
    extra = max(row["score"], 0) * HOMEWORK_BONUS - row["game_bonus"]
    if extra <= 0:
        return 0
    key = f"u{row['user_id']}"
    game.ensure_player(db, key)
    db.execute("UPDATE submissions SET game_bonus = game_bonus + ? WHERE id = ?", (extra, sub_id))
    db.commit()
    add_money(db, key, extra)
    _notify(key, f"Uy vazifasi «{row['title']}» uchun {row['score']} ball — o'yinda +{extra:,} so'm bonus!".replace(",", " "))
    return extra


# --------------------------------------------------------------------------- #
#  Kod chellenji: kichik HTML/CSS topshiriq, AI tekshiradi, to'g'ri bo'lsa — katta pul
# --------------------------------------------------------------------------- #
import random  # noqa: E402

import ai_check  # noqa: E402

CHALLENGES = [
    {"id": "button", "title": "Tugma", "reward": 50000,
     "task": "Ko'k fonli, oq yozuvli, burchaklari yumaloq (border-radius) «Yuborish» tugmasini (button) yarating."},
    {"id": "heading", "title": "Sarlavha va matn", "reward": 40000,
     "task": "Qizil rangli h1 sarlavha va uning tagida paragraf (p) yarating. Ikkalasi ham sahifa o'rtasida (text-align: center) tursin."},
    {"id": "list", "title": "Ro'yxat", "reward": 30000,
     "task": "Tartiblangan ro'yxat (ol) yarating: Olma, Nok, Uzum — 3 ta element."},
    {"id": "form", "title": "Kirish formasi", "reward": 70000,
     "task": "Forma (form) yarating: ism uchun input, parol uchun input (type=\"password\") va «Kirish» tugmasi."},
    {"id": "flex", "title": "Flexbox", "reward": 90000,
     "task": "Flexbox bilan 3 ta har xil rangli kvadratni (har biri 100×100px) bir qatorda, oralarida bo'sh joy (gap yoki margin) bilan joylashtiring."},
    {"id": "figure", "title": "Rasm va izoh", "reward": 60000,
     "task": "figure ichida rasm (img, alt atributi bilan) va uning tagida izoh (figcaption) yarating."},
    {"id": "hover", "title": "Hover havola", "reward": 60000,
     "task": "Havola (a) yarating: sichqoncha ustiga kelganda (:hover) rangi o'zgarsin."},
    {"id": "table", "title": "Jadval", "reward": 70000,
     "task": "3 ustunli jadval (table) yarating: birinchi qator sarlavha (th), keyin kamida 2 qator ma'lumot (td)."},
    {"id": "card", "title": "Markazdagi karta", "reward": 120000,
     "task": "Ekranning o'rtasida (gorizontal va vertikal) turgan karta yarating: oq fon, soya (box-shadow), ichida sarlavha va matn."},
    {"id": "grid", "title": "CSS Grid", "reward": 100000,
     "task": "CSS Grid bilan 2×2 to'r yarating: 4 ta rangli blok, oralarida 10px bo'sh joy (gap)."},
    {"id": "navbar", "title": "Navbar", "reward": 120000,
     "task": "Navbar yarating: chapda logotip matni, o'ngda 3 ta havola (Bosh sahifa, Biz haqimizda, Aloqa). Hammasi bir qatorda (display: flex, justify-content: space-between)."},
    {"id": "circle", "title": "Doira", "reward": 80000,
     "task": "150×150px yashil doira (border-radius: 50%) yarating, uning o'rtasida oq «OK» yozuvi tursin."},
]
CHALLENGES_BY_ID = {c["id"]: c for c in CHALLENGES}
CODE_MIN, CODE_MAX = 10, 8000
CHALLENGE_COOLDOWN = 30          # noto'g'ri javobdan keyin kutish (soniya)
_challenge_of: dict[str, str] = {}     # o'yinchi -> hozirgi topshiriq
_challenge_wait: dict[str, float] = {}
_challenge_busy: set = set()


def _solved(db, key: str) -> set:
    return {r["challenge"] for r in db.execute("SELECT challenge FROM game_challenges WHERE player_key = ?", (key,))}


def _pick_challenge(key: str, solved: set, skip: str | None = None) -> str | None:
    left = [c["id"] for c in CHALLENGES if c["id"] not in solved and c["id"] != skip]
    if not left:
        left = [c["id"] for c in CHALLENGES if c["id"] not in solved]
    choice = random.choice(left) if left else None
    if choice:
        _challenge_of[key] = choice
    else:
        _challenge_of.pop(key, None)
    return choice


def _challenge_json(db, key: str, **extra):
    solved = _solved(db, key)
    cid = _challenge_of.get(key)
    if cid is None or cid in solved:
        cid = _pick_challenge(key, solved)
    c = CHALLENGES_BY_ID.get(cid) if cid else None
    wait = max(0, round(_challenge_wait.get(key, 0) - time.time()))
    return jsonify(challenge=c, solved=len(solved), total=len(CHALLENGES), wait=wait, ai=ai_check.ai_enabled(),
                   economy=game.economy_json(db, _row(db, key)), **extra)


@bp.get("/api/game/challenge")
@login_required
def api_challenge():
    key = game.player_key(current_user())
    db = get_db()
    game.ensure_player(db, key)
    return _challenge_json(db, key)


@bp.post("/api/game/challenge/skip")
@login_required
def api_challenge_skip():
    key = game.player_key(current_user())
    db = get_db()
    game.ensure_player(db, key)
    _pick_challenge(key, _solved(db, key), skip=_challenge_of.get(key))
    return _challenge_json(db, key)


@bp.post("/api/game/challenge")
@login_required
def api_challenge_submit():
    key = game.player_key(current_user())
    data = request.get_json(silent=True) or {}
    code = data.get("code")
    db = get_db()
    game.ensure_player(db, key)
    cid = _challenge_of.get(key)
    c = CHALLENGES_BY_ID.get(cid) if cid else None
    if c is None or data.get("id") != cid:
        return jsonify(error="Topshiriq yangilandi — sahifani qayta oching"), 400
    if not isinstance(code, str) or not CODE_MIN <= len(code.strip()) <= CODE_MAX:
        return jsonify(error=f"Kodni yozing ({CODE_MIN}–{CODE_MAX} belgi)"), 400
    if cid in _solved(db, key):
        return jsonify(error="Bu topshiriq allaqachon bajarilgan"), 400
    wait = _challenge_wait.get(key, 0) - time.time()
    if wait > 0:
        return jsonify(error=f"{math.ceil(wait)} soniyadan keyin qayta urinib ko'ring"), 429
    if key in _challenge_busy:
        return jsonify(error="Kod tekshirilyapti, kuting…"), 429
    _challenge_busy.add(key)
    try:
        result = ai_check.check_code(c["task"], code.strip())
    except ai_check.AICheckError as err:
        return jsonify(error=str(err).replace("«Qayta tekshirish»ni bosing", "qayta yuboring")), 503
    finally:
        _challenge_busy.discard(key)
    if not result.passed:
        _challenge_wait[key] = time.time() + CHALLENGE_COOLDOWN
        return _challenge_json(db, key, result={"passed": False, "feedback": result.feedback, "mistakes": result.mistakes})
    cur = db.execute("INSERT OR IGNORE INTO game_challenges (player_key, challenge, solved_at) VALUES (?, ?, ?)",
                     (key, cid, time.time()))
    db.commit()
    if cur.rowcount:
        add_money(db, key, c["reward"])
    _pick_challenge(key, _solved(db, key))
    return _challenge_json(db, key, result={"passed": True, "feedback": result.feedback, "mistakes": [],
                                            "reward": c["reward"], "title": c["title"]})

game.SYNC_HOOKS.extend([_bank_hook, _race_hook, _ball_hook])
game.FORGET_HOOKS.append(_forget)
