"""O'yin: o'z do'koning (nomi, belgisi, narxi), auksion, chatda stiker va javob."""
import json
import math
import time

from flask import Blueprint, jsonify, request

import game
import game_city as gc
import game_fun as gf
import game_social as gs
import game_town  # noqa: F401  (narsalar ro'yxati to'liq bo'lsin)
import portal
from core import current_user, get_db, login_required

bp = Blueprint("game_trade", __name__)


def _me() -> str:
    return game.player_key(current_user())


def _err(text: str, code: int = 400):
    return jsonify(error=text), code


def _json() -> dict:
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def _int(value):
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _money(n) -> str:
    return f"{int(n):,}".replace(",", " ")


# --------------------------------------------------------------------------- #
#  22. O'z do'koning: Magazin egasi nomi, belgisi va narxlarini o'zi qo'yadi
# --------------------------------------------------------------------------- #
SHOP_EMOJI = ["🏪", "🍎", "🍞", "💐", "🍦", "🎁", "💎", "🧸", "👑", "⚡", "🌟", "🐟"]
SHOP_COLORS = ["#dc2626", "#ea580c", "#ca8a04", "#16a34a", "#0d9488", "#2563eb", "#7c3aed", "#db2777"]
SHOP_SLOTS = 6           # nechta xil narsa
SHOP_STOCK = 50          # har biridan ko'pi bilan
SHOP_HOURS = 12          # xaridorlar ko'pi bilan shuncha soat hisoblanadi
SHOP_PER_HOUR = 5        # narx to'g'ri bo'lsa, soatiga shuncha xaridor


def fair_price(item: str) -> int:
    return int(gc.ITEMS[item]["sell"] * 1.5)


def wholesale(item: str) -> int:
    return int(gc.ITEMS[item]["sell"] * 1.15)


def demand(item: str, price: int) -> float:
    """Soatiga nechta sotiladi: narx qimmatlashsa — kam, arzon bo'lsa — ko'proq."""
    return max(0.0, min(SHOP_PER_HOUR * 1.6, SHOP_PER_HOUR * (2.2 - 1.2 * price / fair_price(item))))


def _shop_plot(db, plot_id: int):
    p = db.execute("SELECT * FROM game_plots WHERE plot = ?", (plot_id,)).fetchone()
    return p if p and p["kind"] == "magazin" and p["level"] > 0 else None


def _return_goods(db, plot_id: int) -> None:
    """Do'kon sotilgan yoki buzilgan: qolgan narsalar eski egasiga qaytadi."""
    for g in db.execute("SELECT * FROM shop_goods WHERE plot = ?", (plot_id,)).fetchall():
        if g["qty"]:
            gc.add_item(db, g["owner_key"], g["item"], g["qty"])
    db.execute("DELETE FROM shop_goods WHERE plot = ?", (plot_id,))
    db.execute("DELETE FROM shops WHERE plot = ?", (plot_id,))
    db.commit()


def _shop_row(db, plot_id: int):
    row = db.execute("SELECT * FROM shops WHERE plot = ?", (plot_id,)).fetchone()
    if row is None:
        return None
    p = _shop_plot(db, plot_id)
    if p is None or p["owner_key"] != row["owner_key"]:
        _return_goods(db, plot_id)
        return None
    return row


def _npc_sales(db, row) -> int:
    """Shahar xaridorlari o'tgan vaqt ichida nechta olgan bo'lsa — hisoblab, pulini egasiga beradi."""
    now = time.time()
    hours = min((now - row["npc_at"]) / 3600, SHOP_HOURS)
    if hours < 0.05:
        return 0
    if not db.execute("UPDATE shops SET npc_at = ? WHERE plot = ? AND npc_at = ?", (now, row["plot"], row["npc_at"])).rowcount:
        return 0
    total = sold = 0
    for g in db.execute("SELECT * FROM shop_goods WHERE plot = ? AND qty > 0", (row["plot"],)).fetchall():
        want = demand(g["item"], g["price"]) * hours + g["part"]
        n = min(int(want), g["qty"])
        db.execute("UPDATE shop_goods SET qty = qty - ?, part = ?, sold = sold + ? WHERE id = ?",
                   (n, (want - int(want)) if n < g["qty"] else 0, n, g["id"]))
        sold += n
        total += n * g["price"]
    if total:
        db.execute("UPDATE shops SET earned = earned + ? WHERE plot = ?", (total, row["plot"]))
    db.commit()
    if total:
        gs.add_money(db, row["owner_key"], total)
        gs._notify(row["owner_key"], f"{row['emoji']} {row['name']}: xaridorlar {sold} ta narsa oldi, +{_money(total)} so'm")
    return total


def _shop_json(db, plot_id: int, me: str) -> dict:
    row = _shop_row(db, plot_id)
    p = _shop_plot(db, plot_id)
    if p is None:
        return {"shop": None}
    mine = p["owner_key"] == me
    out = {"mine": mine, "plot": plot_id, "emoji_list": SHOP_EMOJI, "color_list": SHOP_COLORS, "catalog": gc.ITEMS, "slots": SHOP_SLOTS, "stock": SHOP_STOCK,
           "items": gc._items_json(db, me)}
    if row is None:
        return {**out, "shop": None}
    if mine:
        _npc_sales(db, row)
        row = _shop_row(db, plot_id)
    goods = [{"id": g["id"], "item": g["item"], "price": g["price"], "qty": g["qty"], "sold": g["sold"],
              **({"per_hour": round(demand(g["item"], g["price"]), 1), "fair": fair_price(g["item"])} if mine else {})}
             for g in db.execute("SELECT * FROM shop_goods WHERE plot = ? ORDER BY id", (plot_id,))]
    out["shop"] = {"name": row["name"], "emoji": row["emoji"], "color": row["color"], "earned": row["earned"], "goods": goods,
                   "owner": gs._people(db).get(row["owner_key"], {}).get("name", "?")}
    if mine:
        out["wholesale"] = {i: wholesale(i) for i in gc.ITEMS if gc.ITEMS[i].get("sell", 0) and gc.ITEMS[i]["sell"] <= 3000}
    return out


def _own_shop(db, key: str, plot_id: int):
    p = _shop_plot(db, plot_id)
    return p if p and p["owner_key"] == key else None


@bp.get("/api/game/shops/<int:plot_id>")
@login_required
def api_shop(plot_id: int):
    return jsonify(_shop_json(get_db(), plot_id, _me()))


@bp.post("/api/game/shops/<int:plot_id>")
@login_required
def api_shop_open(plot_id: int):
    key = _me()
    data = _json()
    name = " ".join(str(data.get("name") or "").split())[:24]
    emoji, color = data.get("emoji"), data.get("color")
    db = get_db()
    if not _own_shop(db, key, plot_id):
        return _err("Bu sizning Magaziningiz emas")
    if len(name) < 2:
        return _err("Do'kon nomini yozing")
    if emoji not in SHOP_EMOJI or color not in SHOP_COLORS:
        return _err("Belgi va rangni tanlang")
    _shop_row(db, plot_id)
    db.execute("INSERT INTO shops (plot, owner_key, name, emoji, color, npc_at, earned) VALUES (?, ?, ?, ?, ?, ?, 0) ON CONFLICT(plot) DO UPDATE SET "
               "name = excluded.name, emoji = excluded.emoji, color = excluded.color", (plot_id, key, name, emoji, color, time.time()))
    db.commit()
    return jsonify(_shop_json(db, plot_id, key))


def _place_goods(db, key: str, plot_id: int, item: str, qty: int, price: int) -> str | None:
    """Javonga qo'yish (narsa allaqachon olingan). Xato bo'lsa matn."""
    row = db.execute("SELECT * FROM shop_goods WHERE plot = ? AND item = ?", (plot_id, item)).fetchone()
    if row is None and db.execute("SELECT COUNT(*) FROM shop_goods WHERE plot = ?", (plot_id,)).fetchone()[0] >= SHOP_SLOTS:
        return f"Do'konda ko'pi bilan {SHOP_SLOTS} xil narsa"
    if (row["qty"] if row else 0) + qty > SHOP_STOCK:
        return f"Har bir narsadan ko'pi bilan {SHOP_STOCK} ta"
    db.execute("INSERT INTO shop_goods (plot, owner_key, item, price, qty, part, sold) VALUES (?, ?, ?, ?, ?, 0, 0) ON CONFLICT(plot, item) DO UPDATE SET "
               "qty = qty + excluded.qty, price = excluded.price", (plot_id, key, item, price, qty))
    return None


@bp.post("/api/game/shops/<int:plot_id>/goods")
@login_required
def api_shop_goods(plot_id: int):
    """action: add — o'zidagi narsani qo'yish, buy — ulgurjidan olib qo'yish, price — narx, take — olib qo'yish."""
    key = _me()
    data = _json()
    item, qty, price, action = data.get("item"), _int(data.get("qty")), _int(data.get("price")), data.get("action")
    db = get_db()
    if not _own_shop(db, key, plot_id) or _shop_row(db, plot_id) is None:
        return _err("Avval do'koningizni oching")
    if item not in gc.ITEMS:
        return _err("Narsani tanlang")
    if action in ("add", "buy", "price") and (price is None or not 100 <= price <= 10_000_000):
        return _err("Narx 100 dan 10 000 000 so'mgacha")
    if action in ("add", "buy") and (qty is None or not 1 <= qty <= SHOP_STOCK):
        return _err(f"Soni 1 dan {SHOP_STOCK} gacha")
    _npc_sales(db, _shop_row(db, plot_id))
    if action == "add":
        if not gc.take_item(db, key, item, qty):
            return _err("Sizda buncha yo'q")
        bad = _place_goods(db, key, plot_id, item, qty, price)
        if bad:
            gc.add_item(db, key, item, qty)
            return _err(bad)
        db.commit()
    elif action == "buy":
        if gc.ITEMS[item]["sell"] > 3000:
            return _err("Bu narsa ulgurjida yo'q")
        cost = wholesale(item) * qty

        def change(_row, money):
            if money < cost:
                raise game.GameError("Pul yetarli emas")
            bad = _place_goods(db, key, plot_id, item, qty, price)
            if bad:
                raise game.GameError(bad)
            return -cost, None
        _, err = gs._change(db, key, change)
        if err:
            db.rollback()
            return err
    elif action == "price":
        db.execute("UPDATE shop_goods SET price = ? WHERE plot = ? AND item = ?", (price, plot_id, item))
        db.commit()
    elif action == "take":
        g = db.execute("SELECT * FROM shop_goods WHERE plot = ? AND item = ?", (plot_id, item)).fetchone()
        if g and db.execute("DELETE FROM shop_goods WHERE id = ? AND qty = ?", (g["id"], g["qty"])).rowcount and g["qty"]:
            gc.add_item(db, key, item, g["qty"])
        db.commit()
    else:
        return _err("?")
    return jsonify(**_shop_json(db, plot_id, key), economy=gf._econ(db, key))


@bp.post("/api/game/shops/<int:plot_id>/buy")
@login_required
def api_shop_buy(plot_id: int):
    key = _me()
    data = _json()
    gid, price = _int(data.get("id")), _int(data.get("price"))
    db = get_db()
    row = _shop_row(db, plot_id)
    g = db.execute("SELECT * FROM shop_goods WHERE id = ? AND plot = ?", (gid, plot_id)).fetchone() if row else None
    if not g:
        return _err("Bu narsa tugagan")
    if row["owner_key"] == key:
        return _err("O'z do'koningizdan sotib olib bo'lmaydi")
    if g["price"] != price:
        return _err("Narx o'zgardi — qaytadan qarang")
    game.ensure_player(db, key)

    def change(_row, money):
        if money < g["price"]:
            raise game.GameError("Pul yetarli emas")
        if not db.execute("UPDATE shop_goods SET qty = qty - 1, sold = sold + 1 WHERE id = ? AND qty > 0 AND price = ?", (g["id"], g["price"])).rowcount:
            raise game.GameError("Bu narsa tugagan")
        return -g["price"], lambda: db.execute("UPDATE shops SET earned = earned + ? WHERE plot = ?", (g["price"], plot_id))
    _, err = gs._change(db, key, change)
    if err:
        db.rollback()
        return err
    gc.add_item(db, key, g["item"])
    gs.add_money(db, row["owner_key"], g["price"])
    gs._notify(row["owner_key"], f"{row['emoji']} {current_user()['name']} do'koningizdan {gc.ITEMS[g['item']]['name']} oldi: +{_money(g['price'])} so'm")
    return jsonify(**_shop_json(db, plot_id, key), economy=gf._econ(db, key))


def shops_list(db) -> list:
    """Xaritadagi do'kon nomlari (binolar yozuvi uchun)."""
    return [{"plot": r["plot"], "name": r["name"], "emoji": r["emoji"], "color": r["color"]} for r in db.execute(
        "SELECT s.* FROM shops s JOIN game_plots g ON g.plot = s.plot AND g.owner_key = s.owner_key WHERE g.kind = 'magazin' AND g.level > 0")]


@bp.get("/api/game/shops")
@login_required
def api_shops():
    db = get_db()
    people = gs._people(db)
    out = []
    for s in shops_list(db):
        row = db.execute("SELECT * FROM shops WHERE plot = ?", (s["plot"],)).fetchone()
        n = db.execute("SELECT COUNT(*) FROM shop_goods WHERE plot = ? AND qty > 0", (s["plot"],)).fetchone()[0]
        out.append({**s, "owner": people.get(row["owner_key"], {}).get("name", "?"), "mine": row["owner_key"] == _me(), "goods": n})
    return jsonify(shops=out)


# --------------------------------------------------------------------------- #
#  23. Auksion
# --------------------------------------------------------------------------- #
AUC_STEP = 0.05
AUC_FEE = 0.05
AUC_TIMES = {10, 30, 60, 180, 720, 1440}   # daqiqa
AUC_MAX = 2
AUC_EXTEND = 30
AUC_CAP = 10 ** 15


def _cars(db, key: str) -> list:
    return json.loads(db.execute("SELECT cars FROM game_players WHERE player_key = ?", (key,)).fetchone()["cars"] or "[]")


def _set_cars(db, key: str, cars: list) -> None:
    db.execute("UPDATE game_players SET cars = ? WHERE player_key = ?", (json.dumps(cars), key))


def _min_bid(a) -> int:
    return a["start"] if a["bidder"] is None else math.ceil(a["bid"] * (1 + AUC_STEP))


def _lot_title(db, kind: str, ref: str) -> str:
    if kind == "car":
        return f"🚗 {game.CARS_BY_ID[ref]['name']}" if ref in game.CARS_BY_ID else "🚗 Mashina"
    if kind == "item":
        return f"{gc.ITEMS[ref]['icon']} {gc.ITEMS[ref]['name']}" if ref in gc.ITEMS else "🎁 Narsa"
    p = db.execute("SELECT kind, level, variant FROM game_plots WHERE plot = ?", (int(ref),)).fetchone()
    if p and p["level"]:
        return f"🏠 {game.variant_name(p['kind'], p['variant'])} ({p['level']} qavat), {int(ref) + 1}-yer"
    return f"🟫 {int(ref) + 1}-yer"


def settle(db) -> None:
    """Vaqti tugagan auksionlarni yakunlash."""
    for a in db.execute("SELECT * FROM auctions WHERE status = 'open' AND ends_at <= ?", (time.time(),)).fetchall():
        if not db.execute("UPDATE auctions SET status = 'done' WHERE id = ? AND status = 'open' AND ends_at <= ?", (a["id"], time.time())).rowcount:
            continue
        db.commit()
        _finish(db, db.execute("SELECT * FROM auctions WHERE id = ?", (a["id"],)).fetchone())


def _finish(db, a) -> None:
    people = gs._people(db)
    buyer = a["bidder"] if a["bidder"] in people else None
    seller = a["seller"]
    ok = False
    if buyer:
        if a["kind"] == "item":
            gc.add_item(db, buyer, a["ref"], 1)
            ok = True
        elif a["kind"] == "car":
            cars = _cars(db, buyer)
            if a["ref"] not in cars and a["ref"] in game.CARS_BY_ID:
                _set_cars(db, buyer, cars + [a["ref"]])
                ok = True
        else:
            ok = _move_plot(db, int(a["ref"]), seller, buyer)
        db.commit()
    if buyer and ok:
        gain = int(a["bid"] * (1 - AUC_FEE))
        if seller in people:
            gs.add_money(db, seller, gain)
            gs._notify(seller, f"🔨 Auksion: {a['title']} sotildi, +{_money(gain)} so'm")
        gs._notify(buyer, f"🔨 Tabriklaymiz! Auksionda {a['title']} sizniki bo'ldi")
        gc._announce("🔨 Auksion", f"{a['title']} — {people[buyer]['name']} oldi: {_money(a['bid'])} so'm!")
        return
    if a["bidder"]:   # xaridor ololmadi yoki sotuvchida endi yo'q — puli qaytadi
        gs.add_money(db, a["bidder"], a["bid"])
        gs._notify(a["bidder"], f"🔨 Auksion bekor bo'ldi: {a['title']} — pulingiz qaytdi")
    _give_back(db, a)
    db.execute("UPDATE auctions SET status = 'cancelled' WHERE id = ?", (a["id"],))
    db.commit()
    if seller in people and not a["bidder"]:
        gs._notify(seller, f"🔨 Auksion: {a['title']} uchun hech kim pul taklif qilmadi")


def _give_back(db, a) -> None:
    """Sotuvchining narsasi/mashinasi qaytadi (ownerning sovg'a lotidan tashqari)."""
    if a["system"]:
        return
    if a["kind"] == "item":
        gc.add_item(db, a["seller"], a["ref"], 1)
    elif a["kind"] == "car" and db.execute("SELECT 1 FROM game_players WHERE player_key = ?", (a["seller"],)).fetchone():
        cars = _cars(db, a["seller"])
        if a["ref"] not in cars:
            _set_cars(db, a["seller"], cars + [a["ref"]])
    db.commit()


def _move_plot(db, plot: int, seller: str, buyer: str) -> bool:
    now = time.time()
    with game._econ_lock:
        rows = {k: db.execute("SELECT * FROM game_players WHERE player_key = ?", (k,)).fetchone() for k in (seller, buyer)}
        p = db.execute("SELECT * FROM game_plots WHERE plot = ?", (plot,)).fetchone()
        if p is None or p["owner_key"] != seller or rows[buyer] is None or (rows[seller] is not None and rows[seller]["plot"] == plot):
            return False
        for k, r in rows.items():   # yer almashishidan oldin yig'ilgan daromad saqlanadi
            if r is not None:
                db.execute("UPDATE game_players SET money = ?, income_at = ? WHERE player_key = ?", (game.money_now(r, game.player_rate(db, r), now), now, k))
        db.execute("UPDATE game_plots SET owner_key = ?, sale_price = NULL, bought_at = ? WHERE plot = ?", (buyer, now, plot))
        if rows[buyer]["plot"] is None:
            db.execute("UPDATE game_players SET plot = ? WHERE player_key = ?", (plot, buyer))
        db.commit()
    return True


def _auc_json(db, me: str) -> dict:
    settle(db)
    people = gs._people(db)
    now = time.time()
    lots = [{"id": a["id"], "kind": a["kind"], "title": a["title"], "seller": people.get(a["seller"], {}).get("name", "?"), "mine": a["seller"] == me,
             "bid": a["bid"] if a["bidder"] else None, "bidder": people.get(a["bidder"], {}).get("name") if a["bidder"] else None, "lead": a["bidder"] == me,
             "min": _min_bid(a), "left": max(0, round(a["ends_at"] - now)), "bids": a["bids"], "plot": int(a["ref"]) if a["kind"] == "plot" else None}
            for a in db.execute("SELECT * FROM auctions WHERE status = 'open' ORDER BY ends_at")]
    last = [{"title": a["title"], "name": people.get(a["bidder"], {}).get("name", "?"), "bid": a["bid"]}
            for a in db.execute("SELECT * FROM auctions WHERE status = 'done' ORDER BY id DESC LIMIT 6")]
    row = game.ensure_player(db, me)
    owner = current_user()["role"] == "owner"
    in_lots = {(a["kind"], a["ref"]) for a in db.execute("SELECT kind, ref FROM auctions WHERE status = 'open'")}
    cars = list(game.CARS_BY_ID) if owner else json.loads(row["cars"] or "[]")
    plots = [p for p in game.my_plots(db, me) if p["plot"] != row["plot"] and ("plot", str(p["plot"])) not in in_lots]
    return {"lots": lots, "last": last, "owner": owner, "fee": int(AUC_FEE * 100), "times": sorted(AUC_TIMES), "max": AUC_MAX,
            "can": {"car": [{"id": c, "name": game.CARS_BY_ID[c]["name"]} for c in cars if c in game.CARS_BY_ID and c not in ("bus", "plane")],
                    "plot": [{"id": str(p["plot"]), "name": _lot_title(db, "plot", str(p["plot"]))} for p in plots],
                    "item": [{"id": i, "name": f"{gc.ITEMS[i]['icon']} {gc.ITEMS[i]['name']} ({n})"} for i, n in gc._items_json(db, me).items()]}}


@bp.get("/api/game/auctions")
@login_required
def api_auctions():
    return jsonify(_auc_json(get_db(), _me()))


@bp.post("/api/game/auctions")
@login_required
def api_auction_new():
    user = current_user()
    key = game.player_key(user)
    owner = user["role"] == "owner"
    data = _json()
    kind, ref, start, mins = data.get("kind"), str(data.get("ref") or ""), _int(data.get("start")), _int(data.get("minutes"))
    blocked = game.SECURITY(user, "sell")
    if blocked:
        return blocked
    if kind not in ("car", "plot", "item") or start is None or not 1000 <= start <= AUC_CAP or mins not in AUC_TIMES:
        return _err("Narsa, boshlang'ich narx (kamida 1 000) va vaqtni tanlang")
    db = get_db()
    row = game.ensure_player(db, key)
    settle(db)
    if not owner and db.execute("SELECT COUNT(*) FROM auctions WHERE status = 'open' AND seller = ?", (key,)).fetchone()[0] >= AUC_MAX:
        return _err(f"Bir vaqtda ko'pi bilan {AUC_MAX} ta lot")
    system = 0
    title = None
    if kind == "item":
        if ref not in gc.ITEMS or not gc.take_item(db, key, ref, 1):
            return _err("Bu narsa sizda yo'q")
        title = _lot_title(db, kind, ref)
    elif kind == "car":
        if ref not in game.CARS_BY_ID or ref in ("bus", "plane"):
            return _err("Bu mashinani qo'yib bo'lmaydi")
        if owner:
            system = 1     # owner — noyob lot, o'z mashinasi ketmaydi
        else:
            with game._econ_lock:
                cars = _cars(db, key)
                if ref not in cars:
                    return _err("Bu mashina sizda yo'q")
                cars.remove(ref)
                _set_cars(db, key, cars)
                db.commit()
        title = _lot_title(db, kind, ref)
    else:
        p = db.execute("SELECT * FROM game_plots WHERE plot = ?", (int(ref) if ref.isdigit() else -1,)).fetchone()
        if p is None or p["owner_key"] != key:
            return _err("Bu yer sizniki emas")
        if row["plot"] == p["plot"]:
            return _err("Ota hovlini auksionga qo'yib bo'lmaydi")
        if db.execute("SELECT 1 FROM auctions WHERE status = 'open' AND kind = 'plot' AND ref = ?", (ref,)).fetchone():
            return _err("Bu yer allaqachon auksionda")
        db.execute("UPDATE game_plots SET sale_price = NULL WHERE plot = ?", (p["plot"],))
        title = _lot_title(db, kind, ref)
    db.execute("INSERT INTO auctions (kind, ref, title, seller, system, start, bid, bidder, bids, ends_at, status) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, 0, ?, 'open')",
               (kind, ref, title, key, system, start, time.time() + mins * 60))
    db.commit()
    gc._announce("🔨 Auksion", f"{user['name']} auksionga qo'ydi: {title}. Boshlang'ich narx — {_money(start)} so'm! Menyu → Auksion")
    return jsonify(**_auc_json(db, key), economy=gf._econ(db, key))


@bp.post("/api/game/auctions/<int:aid>/bid")
@login_required
def api_auction_bid(aid: int):
    user = current_user()
    key = game.player_key(user)
    amount = _int(_json().get("amount"))
    if user["role"] == "owner":
        return _err("Owner auksionda qatnashmaydi — puli tugamaydi 🙂")
    db = get_db()
    game.ensure_player(db, key)
    settle(db)
    a = db.execute("SELECT * FROM auctions WHERE id = ? AND status = 'open'", (aid,)).fetchone()
    if not a:
        return _err("Auksion tugagan")
    if a["seller"] == key:
        return _err("O'z lotingizga taklif bera olmaysiz")
    if a["bidder"] == key:
        return _err("Eng baland taklif sizniki")
    if amount is None or amount < _min_bid(a) or amount > AUC_CAP:
        return _err(f"Kamida {_money(_min_bid(a))} so'm taklif qiling")
    if a["kind"] == "car" and a["ref"] in _cars(db, key):
        return _err("Bu mashina sizda bor")

    def change(_row, money):
        if money < amount:
            raise game.GameError("Pul yetarli emas")
        now = time.time()
        cur = db.execute("UPDATE auctions SET bid = ?, bidder = ?, bids = bids + 1, ends_at = MAX(ends_at, ?) WHERE id = ? AND status = 'open' AND ends_at > ? AND bids = ?",
                         (amount, key, now + AUC_EXTEND, aid, now, a["bids"]))
        if not cur.rowcount:
            raise game.GameError("Kimdir sizdan oldin taklif qildi — qaytadan ko'ring")
        return -amount, None
    _, err = gs._change(db, key, change)
    if err:
        db.rollback()
        return err
    if a["bidder"]:
        gs.add_money(db, a["bidder"], a["bid"])
        gs._notify(a["bidder"], f"🔨 {a['title']}: {user['name']} ko'proq taklif qildi ({_money(amount)} so'm). Pulingiz qaytdi")
    return jsonify(**_auc_json(db, key), economy=gf._econ(db, key))


@bp.delete("/api/game/auctions/<int:aid>")
@login_required
def api_auction_cancel(aid: int):
    user = current_user()
    key = game.player_key(user)
    db = get_db()
    a = db.execute("SELECT * FROM auctions WHERE id = ? AND status = 'open'", (aid,)).fetchone()
    if not a or (a["seller"] != key and user["role"] != "owner"):
        return _err("Auksion topilmadi", 404)
    if a["bidder"] and user["role"] != "owner":
        return _err("Taklif berilgan lotni bekor qilib bo'lmaydi")
    if not db.execute("UPDATE auctions SET status = 'cancelled' WHERE id = ? AND status = 'open' AND bids = ?", (aid, a["bids"])).rowcount:
        return _err("Qaytadan urinib ko'ring")
    db.commit()
    if a["bidder"]:
        gs.add_money(db, a["bidder"], a["bid"])
        gs._notify(a["bidder"], f"🔨 Auksion bekor qilindi: {a['title']} — pulingiz qaytdi")
    _give_back(db, a)
    return jsonify(**_auc_json(db, key), economy=gf._econ(db, key))


portal.TICKS.append(settle)

_sig = {"t": 0.0, "shops": [], "auc": 0}


def _hook(db, key: str, row, now: float, response: dict) -> None:
    if now - _sig["t"] > 5:
        _sig.update(t=now, shops=shops_list(db), auc=db.execute("SELECT COUNT(*) FROM auctions WHERE status = 'open'").fetchone()[0])
    response["shops"] = _sig["shops"]
    response["auctions"] = _sig["auc"]


game.SYNC_HOOKS.append(_hook)


def _forget(db, key: str) -> None:
    db.execute("DELETE FROM shop_goods WHERE owner_key = ?", (key,))
    db.execute("DELETE FROM shops WHERE owner_key = ?", (key,))
    for a in db.execute("SELECT * FROM auctions WHERE status = 'open' AND (seller = ? OR bidder = ?)", (key, key)).fetchall():
        db.execute("UPDATE auctions SET status = 'cancelled' WHERE id = ?", (a["id"],))
        db.commit()
        if a["bidder"] and a["bidder"] != key:
            gs.add_money(db, a["bidder"], a["bid"])
        if a["seller"] != key:
            _give_back(db, a)


game.FORGET_HOOKS.append(_forget)

# --------------------------------------------------------------------------- #
#  27. Chat: stikerlar
# --------------------------------------------------------------------------- #
STICKERS = {s: t for s, t in (
    ("salom", "👋 Salom!"), ("zor", "🔥 Zo'r!"), ("kuldim", "😂 Voy kuldim"), ("rahmat", "🙏 Rahmat"), ("yutdim", "🏆 Yutdim!"), ("yordam", "🆘 Yordam"),
    ("kel", "🏃 Bu yoqqa kel"), ("kutdur", "⏳ Kutib tur"), ("poyga", "🏁 Poygami?"), ("pul", "💰 Boyman"), ("puldim", "😭 Pulim tugadi"), ("uxla", "😴 Uxlayapman"),
    ("jahl", "😤 Jahlim chiqdi"), ("yurak", "❤️ Yaxshi ko'raman"), ("tabrik", "🎉 Tabriklayman"), ("xop", "👌 Xo'p bo'ladi"), ("yoq", "🙅 Yo'q"), ("ha", "💯 Albatta"),
    ("kod", "💻 Kod yozyapman"), ("dars", "📚 Darsga boramiz"), ("bug", "🐞 Xato topdim"), ("olov", "🔥 7 kun ketma-ket"), ("qoch", "👻 Qochinglar!"), ("osh", "🍲 Osh tayyor"),
)}


@bp.get("/api/game/stickers")
@login_required
def api_stickers():
    return jsonify(stickers=[{"id": k, "text": v} for k, v in STICKERS.items()])


SCHEMA = """
CREATE TABLE IF NOT EXISTS shops (
    plot INTEGER PRIMARY KEY, owner_key TEXT NOT NULL, name TEXT NOT NULL, emoji TEXT NOT NULL, color TEXT NOT NULL, npc_at REAL NOT NULL, earned REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS shop_goods (
    id INTEGER PRIMARY KEY AUTOINCREMENT, plot INTEGER NOT NULL, owner_key TEXT NOT NULL, item TEXT NOT NULL, price INTEGER NOT NULL, qty INTEGER NOT NULL,
    part REAL NOT NULL, sold INTEGER NOT NULL, UNIQUE (plot, item)
);
CREATE TABLE IF NOT EXISTS auctions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref TEXT NOT NULL, title TEXT NOT NULL, seller TEXT NOT NULL, system INTEGER NOT NULL,
    start INTEGER NOT NULL, bid INTEGER NOT NULL, bidder TEXT, bids INTEGER NOT NULL, ends_at REAL NOT NULL, status TEXT NOT NULL
);
"""
