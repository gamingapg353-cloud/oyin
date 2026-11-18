"""Haftalik mashina ovozi.

O'yinchi mashina taklif qiladi: nomi (masalan, "Chevrolet") va qobiliyati ("tez bo'lsin").
Taklif qilish 30 ball turadi (reytingdan ayiriladi). Hamma bitta taklifga ovoz beradi.
Hafta tugaganda eng ko'p ovoz olgan mashina Avtosalonga qo'shiladi va yangi hafta boshlanadi.
Mashinaning tezligi, taksi haqi, ko'rinishi va rangi qobiliyatdagi so'zlardan aniqlanadi.
"""
import hashlib
import json
import re
import threading
import time

from flask import Blueprint, jsonify, request

import game
from core import current_user, get_db, login_required, owner_required

bp = Blueprint("poll", __name__)

POLL_DAYS = 7
PROPOSAL_COST = 30          # taklif qilish narxi (reyting ballari)
NAME_MAX = 30
ABILITY_MAX = 80
PALETTE = ["#dc2626", "#2563eb", "#16a34a", "#f97316", "#7c3aed", "#0891b2", "#be185d", "#4d7c0f", "#b45309"]
COLOR_WORDS = {
    "qizil": "#dc2626", "ko'k": "#2563eb", "kok": "#2563eb", "yashil": "#16a34a", "sariq": "#facc15",
    "qora": "#111827", "oq": "#f8fafc", "pushti": "#ec4899", "kumush": "#cbd5e1", "binafsha": "#7c3aed",
    "jigarrang": "#78350f", "havorang": "#38bdf8", "kulrang": "#6b7280", "oltin": "#d4a017",
}
_lock = threading.Lock()


def _has(text: str, *words: str) -> bool:
    """So'z boshida uchraydimi ("uch" — "uchadigan" da bor, "kuchli" da yo'q)."""
    return any(re.search(rf"(^|[^\w']){re.escape(w)}", text) for w in words)


def car_stats(name: str, ability: str) -> dict:
    """Qobiliyat matnidan mashina xususiyatlari."""
    t = ability.lower().replace("‘", "'").replace("’", "'").replace("`", "'")
    st = {"speed": 1.6, "fare": 1.0, "flies": False, "style": "sedan", "price": 60000}
    if _has(t, "uch", "fly", "samolyot"):
        st.update(flies=True, style="fly", speed=2.6, price=600000)
    elif _has(t, "juda tez", "eng tez", "raketa", "chaqmoq"):
        st.update(speed=2.7, style="super", price=350000)
    elif _has(t, "tez", "chaqqon", "sport", "poyga", "yugur"):
        st.update(speed=2.2, style="super", price=200000)
    if not st["flies"] and _has(t, "kuchli", "katta", "jip", "yo'ltanlamas", "baquvvat", "og'ir"):
        st["style"] = "suv"
        st["fare"] = max(st["fare"], 1.4)
        st["price"] += 60000
    if _has(t, "taksi", "pul", "boy", "daromad"):
        st["fare"] = round(st["fare"] + 0.6, 1)
        st["price"] += 80000
    if _has(t, "arzon"):
        st["price"] = int(st["price"] * 0.5)
    if _has(t, "qimmat"):
        st["price"] = int(st["price"] * 2)
    st["price"] = max(10000, int(round(st["price"] / 1000)) * 1000)
    st["color"] = PALETTE[int(hashlib.md5(name.lower().encode()).hexdigest(), 16) % len(PALETTE)]
    for word, color in COLOR_WORDS.items():
        if _has(t, word):
            st["color"] = color
    return st


def _car_from(row) -> dict:
    """custom_cars qatori -> Avtosalon mashinasi."""
    st = json.loads(row["stats"])
    car = {"id": row["id"], "name": row["name"], "price": st["price"], "speed": st["speed"], "fare": st["fare"],
           "color": st["color"], "style": st["style"], "custom": True, "ability": row["ability"],
           "author": row["author_name"]}
    if st.get("flies"):
        car["flies"] = True
    return car


def load_custom_cars(db) -> None:
    """Server ishga tushganda: ovoz bilan qo'shilgan mashinalar Avtosalonga."""
    for row in db.execute("SELECT * FROM custom_cars ORDER BY added_at"):
        game.add_custom_car(_car_from(row))


def _results(db, poll_id: int) -> list:
    return db.execute(
        "SELECT p.*, COUNT(v.voter_key) AS votes FROM car_proposals p "
        "LEFT JOIN car_votes v ON v.proposal_id = p.id AND v.poll_id = p.poll_id "
        "WHERE p.poll_id = ? GROUP BY p.id ORDER BY votes DESC, p.created_at ASC", (poll_id,),
    ).fetchall()


def finish_poll(db, poll_id: int):
    """Ovozni yakunlash: g'olib (kamida 1 ovoz) Avtosalonga qo'shiladi."""
    results = _results(db, poll_id)
    winner = results[0] if results and results[0]["votes"] > 0 else None
    if winner is not None:
        car_id = f"c_{winner['id']}"
        db.execute("INSERT OR IGNORE INTO custom_cars (id, name, ability, author_name, stats, added_at) "
                   "VALUES (?, ?, ?, ?, ?, ?)",
                   (car_id, winner["name"], winner["ability"], winner["author_name"], winner["stats"], time.time()))
        row = db.execute("SELECT * FROM custom_cars WHERE id = ?", (car_id,)).fetchone()
        game.add_custom_car(_car_from(row))
    db.execute("UPDATE car_polls SET closed = 1, winner = ? WHERE id = ?",
               (winner["id"] if winner is not None else None, poll_id))
    db.commit()
    return winner


def current_poll(db):
    """Hozirgi ochiq ovoz (muddati o'tgan bo'lsa — yakunlab, yangisini boshlaydi)."""
    with _lock:
        while True:
            row = db.execute("SELECT * FROM car_polls WHERE closed = 0 ORDER BY id DESC LIMIT 1").fetchone()
            now = time.time()
            if row is None:
                db.execute("INSERT INTO car_polls (started_at, ends_at) VALUES (?, ?)", (now, now + POLL_DAYS * 86400))
                db.commit()
                continue
            if now >= row["ends_at"]:
                finish_poll(db, row["id"])
                continue
            return row


def user_points(db, user: dict):
    """Reyting ballari (owner uchun None — u bepul taklif qiladi)."""
    if user["role"] != "user":
        return None
    row = db.execute(
        "SELECT u.score + COALESCE((SELECT SUM(s.score) FROM submissions s WHERE s.user_id = u.id), 0) "
        "FROM users u WHERE u.id = ?", (user["id"],),
    ).fetchone()
    return row[0] if row else 0


def poll_json(db, user: dict) -> dict:
    poll = current_poll(db)
    key = game.player_key(user)
    vote = db.execute("SELECT proposal_id FROM car_votes WHERE poll_id = ? AND voter_key = ?",
                      (poll["id"], key)).fetchone()
    proposals = [
        {"id": r["id"], "name": r["name"], "ability": r["ability"], "author": r["author_name"],
         "mine": r["author_key"] == key, "votes": r["votes"], "stats": json.loads(r["stats"])}
        for r in _results(db, poll["id"])
    ]
    last = db.execute(
        "SELECT p.name, p.author_name FROM car_polls c JOIN car_proposals p ON p.id = c.winner "
        "WHERE c.closed = 1 ORDER BY c.id DESC LIMIT 1").fetchone()
    return {
        "poll": {"id": poll["id"], "ends_at": poll["ends_at"], "now": time.time()},
        "proposals": proposals,
        "my_vote": vote["proposal_id"] if vote else None,
        "my_points": user_points(db, user),
        "cost": PROPOSAL_COST,
        "proposed": any(p["mine"] for p in proposals),
        "last_winner": {"name": last["name"], "author": last["author_name"]} if last else None,
        "is_owner": user["role"] == "owner",
    }


@bp.get("/api/poll")
@login_required
def api_poll():
    db = get_db()
    return jsonify(poll_json(db, current_user()))


@bp.post("/api/poll/propose")
@login_required
def api_propose():
    user = current_user()
    key = game.player_key(user)
    data = request.get_json(silent=True) or {}
    name = " ".join(str(data.get("name") or "").split())[:NAME_MAX]
    ability = " ".join(str(data.get("ability") or "").split())[:ABILITY_MAX]
    if len(name) < 2:
        return jsonify(error="Mashina nomini yozing (masalan, Chevrolet)"), 400
    if len(ability) < 2:
        return jsonify(error="Mashinaning qobiliyatini yozing (masalan, tez bo'lsin)"), 400
    db = get_db()
    poll = current_poll(db)
    if db.execute("SELECT 1 FROM car_proposals WHERE poll_id = ? AND author_key = ?", (poll["id"], key)).fetchone():
        return jsonify(error="Bu hafta siz allaqachon mashina taklif qildingiz"), 400
    taken = {c["name"].lower() for c in game.CARS}
    taken |= {r[0].lower() for r in db.execute("SELECT name FROM car_proposals WHERE poll_id = ?", (poll["id"],))}
    if name.lower() in taken:
        return jsonify(error="Bunday mashina allaqachon bor"), 400
    points = user_points(db, user)
    if points is not None and points < PROPOSAL_COST:
        return jsonify(error=f"Taklif qilish uchun {PROPOSAL_COST} ball kerak. Sizda {points} ball bor."), 400
    if points is not None:
        db.execute("UPDATE users SET score = score - ? WHERE id = ?", (PROPOSAL_COST, user["id"]))
    db.execute("INSERT INTO car_proposals (poll_id, name, ability, author_key, author_name, stats, created_at) "
               "VALUES (?, ?, ?, ?, ?, ?, ?)",
               (poll["id"], name, ability, key, user["name"], json.dumps(car_stats(name, ability)), time.time()))
    db.commit()
    return jsonify(poll_json(db, user))


@bp.post("/api/poll/vote")
@login_required
def api_vote():
    user = current_user()
    proposal = (request.get_json(silent=True) or {}).get("proposal")
    db = get_db()
    poll = current_poll(db)
    if not db.execute("SELECT 1 FROM car_proposals WHERE id = ? AND poll_id = ?", (proposal, poll["id"])).fetchone():
        return jsonify(error="Bunday variant yo'q"), 404
    db.execute("INSERT OR REPLACE INTO car_votes (poll_id, voter_key, proposal_id) VALUES (?, ?, ?)",
               (poll["id"], game.player_key(user), proposal))
    db.commit()
    return jsonify(poll_json(db, user))


@bp.post("/api/poll/finish")
@owner_required
def api_finish():
    """Owner: ovoz berishni hozir yakunlaydi (g'olib Avtosalonga qo'shiladi, yangi hafta boshlanadi)."""
    db = get_db()
    poll = current_poll(db)
    with _lock:
        winner = finish_poll(db, poll["id"])
    data = poll_json(db, current_user())
    data["winner"] = {"name": winner["name"], "id": f"c_{winner['id']}"} if winner is not None else None
    return jsonify(data)


@bp.delete("/api/poll/cars/<car_id>")
@owner_required
def api_delete_car(car_id: str):
    """Owner: ovoz bilan qo'shilgan mashinani Avtosalondan olib tashlaydi.
    Uni sotib olganlarga to'lagan pullari qaytariladi."""
    car = game.CARS_BY_ID.get(car_id)
    if car is None or not car.get("custom"):
        return jsonify(error="Faqat ovoz bilan qo'shilgan mashinani o'chirish mumkin"), 400
    db = get_db()
    refunded = 0
    with game._econ_lock:
        now = time.time()
        for row in db.execute("SELECT * FROM game_players").fetchall():
            cars = json.loads(row["cars"] or "[]")
            if car_id not in cars:
                continue
            cars.remove(car_id)
            money = game.money_now(row, game.player_rate(db, row), now) + car["price"]
            db.execute("UPDATE game_players SET cars = ?, money = ?, income_at = ? WHERE player_key = ?",
                       (json.dumps(cars), money, now, row["player_key"]))
            refunded += 1
        db.execute("DELETE FROM custom_cars WHERE id = ?", (car_id,))
        db.commit()
        game.CARS.remove(car)
        game.CARS_BY_ID.pop(car_id, None)
    return jsonify(ok=True, name=car["name"], refunded=refunded)
