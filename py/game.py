"""Mahalla — do'stlar bilan o'ynaladigan 3D o'yin.

Odam bo'lib piyoda yoki mashinada yurasiz. Pulni taksida ishlaysiz: yo'lovchini olib,
manziliga eltasiz (taksini "Yandex" tugmasi yoqadi). Har kimning o'z yeri (Ota hovli) bor,
qo'shimcha yerlarni cheksiz sotib olish va narx qo'yib boshqa o'yinchiga sotish mumkin. Har bir
yerga nima qurishni o'zingiz tanlaysiz — Uy (25 qavatgacha), Magazin (40), Kafe (60) yoki
Ofis (100) — har qavat uchun HTML/CSS savoli beriladi. Binolar har soniyada
pul olib keladi. Mashinalar faqat Avtosalonda sotiladi: BMW, Mercedes, Lamborghini va uchadigan Tesla.

Kim qayerda turgani, yo'lovchilar — server xotirasida (qayta ishga tushsa tozalanadi),
pul, yerlar, binolar va mashinalar — bazada.
"""
import itertools
import json
import math
import random
import threading
import time
from collections import deque

from flask import Blueprint, Response, jsonify, redirect, render_template, request, url_for

import config
import quiz
from core import avatar_url, current_user, get_db, get_setting, login_required, owner_required

bp = Blueprint("game", __name__)

# --------------------------------------------------------------------------- #
#  Iqtisod
# --------------------------------------------------------------------------- #
START_MONEY = 75000         # yangi o'yinchi puli (BMW + birinchi uyga yetadi)
OWNER_MONEY = float(10 ** 32)  # owner puli (100000000000000000000000000000000) — tugamaydi (REAL ustun)
OFFLINE_CAP_HOURS = 24      # o'yinga kirmasangiz ham shuncha soatgacha daromad yig'iladi
LAND_PRICE = 25000          # qo'shimcha bo'sh yer narxi (Ota hovli — bepul)
QUIZ_COOLDOWN = 8           # noto'g'ri javobdan keyin yangi savolgacha kutish (soniya)
MIN_SALE_PRICE = 1000       # sotuvga qo'yiladigan eng past narx
MAX_SALE_PRICE = 10 ** 18   # va eng balandi
OWNER_MAX_STEP = 10         # owner savolsiz bir bosishda shuncha qavat qo'sha oladi
MAX_LEVEL = 100             # eng baland bino (Ofis) qavatlari
MAX_PRICE = 300000          # har turning eng yuqori qavati narxi

# Bino turlari: har birining o'z qavat chegarasi (max) bor — Uy pastroq, Ofis 100 qavatgacha.
# 1-qavat narxi (base) dan eng yuqori qavat narxi (MAX_PRICE) gacha teng o'sadi.
# Har qavat o'z daromadini qo'shadi: qavat narxi / payback (so'm/soniya),
# ya'ni qavat payback soniyada o'zini oqlaydi.
BUILDINGS = {
    "uy": {"name": "Uy", "color": "#d97757", "base": 40000, "payback": 10800, "max": 25,
           "about": "Turar joy. Eng arzoni."},
    "magazin": {"name": "Magazin", "color": "#22c55e", "base": 50000, "payback": 10000, "max": 40,
                "about": "Pastda do'kon, tepada xonadonlar."},
    "kafe": {"name": "Kafe", "color": "#f59e0b", "base": 60000, "payback": 9500, "max": 60,
             "about": "Pastda kafe, tepada mehmonxona. Daromadi yaxshi."},
    "ofis": {"name": "Ofis", "color": "#3b82f6", "base": 70000, "payback": 9000, "max": MAX_LEVEL,
             "about": "Shisha osmono'par: qimmatroq, lekin eng ko'p pul keltiradi."},
}
BUILDING_ORDER = ["uy", "magazin", "kafe", "ofis"]

# Har bir turning 4 ta varianti: narx va daromad bir xil, ko'rinishi va yozuvi boshqa
VARIANTS = {
    "uy": [
        {"id": "hovli", "name": "Hovli uy", "about": "G'isht devor, qizil tom."},
        {"id": "kottej", "name": "Yog'och kottej", "about": "Yog'ochdan, iliq va shinam."},
        {"id": "villa", "name": "Oq villa", "about": "Oppoq devorlar, havorang tom."},
        {"id": "zamonaviy", "name": "Zamonaviy uy", "about": "Kulrang beton va katta oynalar."},
    ],
    "magazin": [
        {"id": "gadjet", "name": "Gadjet do'kon", "about": "Telefon, noutbuk, quloqchinlar."},
        {"id": "oziq", "name": "Oziq-ovqat", "about": "Supermarket: non, meva, sut."},
        {"id": "kiyim", "name": "Kiyim do'koni", "about": "Ko'ylak, krossovka, kurtka."},
        {"id": "gul", "name": "Gul do'koni", "about": "Guldastalar va sovg'alar."},
    ],
    "kafe": [
        {"id": "kofe", "name": "Kofe-kafe", "about": "Kofe va shirinliklar."},
        {"id": "pizza", "name": "Pitsa", "about": "Issiq pitsa pechdan."},
        {"id": "burger", "name": "Burger", "about": "Burger va kartoshka fri."},
        {"id": "choyxona", "name": "Choyxona", "about": "Palov, choy va somsa."},
    ],
    "ofis": [
        {"id": "it", "name": "IT park", "about": "Dasturchilar ofisi."},
        {"id": "bank", "name": "Bank", "about": "Pul va kartalar."},
        {"id": "klinika", "name": "Klinika", "about": "Shifokorlar va dorixona."},
        {"id": "markaz", "name": "O'quv markazi", "about": "Kurslar va darslar."},
    ],
}
VARIANT_IDS = {kind: [v["id"] for v in items] for kind, items in VARIANTS.items()}


def variant_name(kind: str, variant: str | None) -> str:
    """Bino nomi: variant bo'lsa — uning nomi (Gadjet do'kon), bo'lmasa — tur nomi (Magazin)."""
    for v in VARIANTS.get(kind, []):
        if v["id"] == variant:
            return v["name"]
    return BUILDINGS[kind]["name"]

# Mashinalar (faqat Avtosalonda). fare — taksi haqi koeffitsienti.
CARS = [  # narxi bo'yicha (Avtosalonda shu tartibda)
    {"id": "skate", "name": "Skeytbord", "price": 1000, "speed": 1.15, "fare": 0,
     "color": "#f97316", "style": "skate"},
    {"id": "bike", "name": "Velosiped", "price": 2000, "speed": 1.25, "fare": 0,
     "color": "#16a34a", "style": "bike"},
    {"id": "horse", "name": "Ot", "price": 8000, "speed": 1.6, "fare": 0, "color": "#7c2d12", "style": "horse"},
    {"id": "jiguli", "name": "Jiguli", "price": 12000, "speed": 1.4, "fare": 0.8,
     "color": "#16a34a", "style": "sedan"},
    {"id": "damas", "name": "Damas", "price": 20000, "speed": 1.5, "fare": 1.2,
     "color": "#f8fafc", "style": "van"},
    {"id": "bmw", "name": "BMW M5", "price": 30000, "speed": 1.7, "fare": 1.0,
     "color": "#1d4ed8", "style": "sedan"},
    {"id": "bus", "name": "Avtobus", "price": 60000, "speed": 1.5, "fare": 1.0,
     "color": "#facc15", "style": "bus"},
    {"id": "mercedes", "name": "Mercedes G-Class", "price": 90000, "speed": 1.9, "fare": 1.3,
     "color": "#111827", "style": "suv"},
    {"id": "range", "name": "Range Rover", "price": 140000, "speed": 2.0, "fare": 1.4,
     "color": "#14532d", "style": "suv"},
    {"id": "porsche", "name": "Porsche 911", "price": 180000, "speed": 2.2, "fare": 1.5,
     "color": "#dc2626", "style": "super"},
    {"id": "lambo", "name": "Lamborghini Aventador", "price": 250000, "speed": 2.4, "fare": 1.7,
     "color": "#facc15", "style": "super"},
    {"id": "bugatti", "name": "Bugatti Chiron", "price": 600000, "speed": 2.8, "fare": 1.9,
     "color": "#1e40af", "style": "super"},
    {"id": "cyber", "name": "Kibertrak", "price": 350000, "speed": 2.3, "fare": 1.7,
     "color": "#cbd5e1", "style": "cyber"},
    {"id": "ferrari", "name": "Ferrari SF90", "price": 400000, "speed": 2.6, "fare": 1.8,
     "color": "#dc2626", "style": "hyper"},
    {"id": "mclaren", "name": "McLaren P1", "price": 450000, "speed": 2.65, "fare": 1.8,
     "color": "#f97316", "style": "hyper"},
    {"id": "rolls", "name": "Rolls-Royce Cullinan", "price": 500000, "speed": 2.3, "fare": 2.4,
     "color": "#1e1b4b", "style": "suv"},
    {"id": "koenig", "name": "Koenigsegg Jesko", "price": 900000, "speed": 3.1, "fare": 2.0,
     "color": "#f8fafc", "style": "hyper"},
    {"id": "carpet", "name": "Uchar gilam", "price": 800000, "speed": 2.6, "fare": 0,
     "color": "#b91c1c", "style": "carpet", "flies": True},
    {"id": "tesla", "name": "Tesla (uchadigan)", "price": 1000000, "speed": 3.0, "fare": 2.2,
     "color": "#e5e7eb", "style": "fly", "flies": True},
    {"id": "plane", "name": "Samolyot", "price": 3000000, "speed": 4.0, "fare": 2.6,
     "color": "#f8fafc", "style": "plane", "flies": True, "cruise": 420},
]
CARS.sort(key=lambda c: c["price"])
CARS_BY_ID = {car["id"]: car for car in CARS}  # eski mashinalar core.init_db da ko'chiriladi


def add_custom_car(car: dict) -> None:
    """Haftalik ovozda g'olib bo'lgan mashinani Avtosalonga qo'shish (CATALOG["cars"] ham shu ro'yxat)."""
    if car["id"] not in CARS_BY_ID:
        CARS.append(car)
        CARS_BY_ID[car["id"]] = car

# Taksi
TAXI_WAITING = 10            # bir vaqtda kutib turgan yo'lovchilar
TAXI_BASE_FARE = 300
TAXI_PER_UNIT = 0.6          # masofa birligi uchun so'm
TAXI_MIN_TRIP = 700          # manzil kamida shuncha uzoqda
TAXI_PICK_DIST = 110
TAXI_DROP_DIST = 130
TAXI_RESPAWN_SECONDS = 4
SHOP_RADIUS = 200            # Avtosalon eshigidan shu masofada mashina sotib olinadi


def max_level(kind: str | None) -> int:
    """Shu bino turining eng ko'p qavatlari."""
    return BUILDINGS[kind]["max"] if kind in BUILDINGS else MAX_LEVEL


def _price(base: int, level: int, top: int) -> int:
    value = base + (MAX_PRICE - base) * (level - 1) / (top - 1)
    return int(round(value / 100.0)) * 100


# PRICES[kind][L] — L-qavat narxi, INVESTED[kind][L] — 1..L qavatlarga jami sarflangan pul
PRICES = {k: [0] + [_price(b["base"], lv, b["max"]) for lv in range(1, b["max"] + 1)] for k, b in BUILDINGS.items()}
INVESTED = {}
for _kind, _prices in PRICES.items():
    _total, INVESTED[_kind] = 0, [0]
    for _p in _prices[1:]:
        _total += _p
        INVESTED[_kind].append(_total)


def level_price(kind: str, level: int) -> int:
    """level-qavat narxi (yuzlikka yaxlitlangan)."""
    return PRICES[kind][level]


def invested(kind: str | None, level: int) -> int:
    if not kind or kind not in BUILDINGS or level < 1:
        return 0
    return INVESTED[kind][min(level, max_level(kind))]


def level_income(kind: str | None, level: int) -> float:
    """level qavatli binoning daromadi, so'm/soniya (har qavat o'z hissasini qo'shadi)."""
    if not kind or kind not in BUILDINGS or level < 1:
        return 0.0
    return round(invested(kind, level) / BUILDINGS[kind]["payback"], 2)


CATALOG = {
    "buildings": [
        {"id": kind, "name": BUILDINGS[kind]["name"], "about": BUILDINGS[kind]["about"],
         "color": BUILDINGS[kind]["color"],
         "first": {"price": level_price(kind, 1), "income": level_income(kind, 1)},
         "max": max_level(kind), "payback": BUILDINGS[kind]["payback"], "variants": VARIANTS[kind],
         "last": {"price": level_price(kind, max_level(kind)), "income": level_income(kind, max_level(kind))}}
        for kind in BUILDING_ORDER
    ],
    "cars": CARS,
    "land_price": LAND_PRICE,
    "max_level": MAX_LEVEL,
    "quiz_cooldown": QUIZ_COOLDOWN,
    "min_sale_price": MIN_SALE_PRICE,
    "taxi_pick_dist": TAXI_PICK_DIST,
    "taxi_drop_dist": TAXI_DROP_DIST,
    "shop_radius": SHOP_RADIUS,
}

# --------------------------------------------------------------------------- #
#  Xarita (server va brauzer bir xil xaritadan foydalanadi)
# --------------------------------------------------------------------------- #
WORLD_W, WORLD_H = 6720, 3800
ROAD = 80
H_ROADS = [380, 1140, 1900, 2660, 3420]                         # gorizontal yo'llar (yuqori cheti, y)
V_ROADS = [380, 1160, 1940, 2720, 3500, 4280, 5060, 5840]       # vertikal yo'llar (chap cheti, x)

WALK_SPEED = 190               # piyoda tezlik (birlik/soniya); mashina — shundan necha barobar
ONLINE_SECONDS = 6
FLY_HEIGHT = 1100              # uchadigan mashina eng baland ucha oladigan joy (100 qavatli binodan baland)
FLY_CRUISE = 160               # odatdagi uchish balandligi


def _make_plots() -> list[dict]:
    """Yerlar. Tartib o'zgarmasin: o'yinchilarning yer raqamlari shunga bog'liq.
    Birinchi 24 tasi — eski xaritadagi yerlar, keyingilari — kengaytirilgan qismdagilar."""
    plots = []

    def row(row_y: int, gate: str, blocks):
        for block_x in blocks:
            for i in range(3):
                plots.append({"id": len(plots), "x": block_x + i * 230, "y": row_y,
                              "w": 220, "h": 170, "gate": gate})

    old_rows = ((480, "top"), (950, "bottom"), (190, "bottom"), (1240, "top"))
    for row_y, gate in old_rows:
        row(row_y, gate, (470, 1250))
    # Kengaytirilgan xarita: o'ngdagi bloklar (2030-blokning o'rtasida — bog')
    for row_y, gate in old_rows:
        blocks = (2810, 3590) if row_y in (480, 950) else (2030, 2810, 3590)
        row(row_y, gate, blocks)
    # Pastki yangi yo'l (y=1900) bo'yidagi qatorlar
    for row_y, gate in ((1710, "bottom"), (1990, "top")):
        row(row_y, gate, (470, 1250, 2030, 2810, 3590))
    # Yana kattalashtirilgan xarita (6720×3800): o'ngdagi uchta yangi blok...
    for row_y, gate in old_rows + ((1710, "bottom"), (1990, "top")):
        row(row_y, gate, (4370, 5150, 5930))
    # ...va pastdagi ikki yangi ko'cha (y=2660, 3420) bo'yidagi qatorlar (2810-blok — ikkinchi bog')
    for row_y, gate in ((2470, "bottom"), (2760, "top"), (3230, "bottom"), (3520, "top")):
        blocks = (470, 1250, 2030, 3590, 4370, 5150, 5930) if row_y in (2760, 3230) else             (470, 1250, 2030, 2810, 3590, 4370, 5150, 5930)
        row(row_y, gate, blocks)
    # Yangi shahar (shimoli-sharq, y < 0): to'rt qator, eski ko'chalar davomida
    for row_y, gate in ((-1190, "bottom"), (-900, "top"), (-570, "bottom"), (-280, "top")):
        row(row_y, gate, (3590, 4370, 5150, 5930))
    return plots


PLOTS = _make_plots()
SHOP = {"x": 40, "y": 560, "w": 300, "h": 190, "door": {"x": 190, "y": 790}}   # Avtosalon
FOUNTAIN = {"x": 2300, "y": 730, "w": 140, "h": 140}                            # bog'dagi favvora
POND = {"x": 40, "y": 1290, "w": 300, "h": 200}                                 # ko'l
# Poyga trassasi: xaritaning pastidagi o'rmonda (faqat poyga paytida ko'rinadi va kirish mumkin)
TRACK = {"cx": 3360, "cy": 3800 + 620, "half": 1500, "r": 380, "w": 170, "laps": 3}
TRACK["rect"] = {"x": TRACK["cx"] - TRACK["half"] - TRACK["r"] - 140, "y": TRACK["cy"] - TRACK["r"] - 140,
                 "w": 2 * (TRACK["half"] + TRACK["r"] + 140), "h": 2 * (TRACK["r"] + 140)}
# Daryo: shaharning janubi-g'arbida (pastki ko'cha ortida), ustida ko'prik — ko'prikdan baliq tutiladi
RIVER = {"rect": {"x": 0, "y": 3740, "w": 1300, "h": 700},
         "water": {"x": 0, "y": 4000, "w": 1300, "h": 150},
         "bridge": {"x": 560, "y": 3985, "w": 120, "h": 180}}
# Labirint: shimoli-g'arbdagi o'rmonda. Yurish maydoni — game_city.MAZE["rect"] + shahar bilan ulaydigan kirish yo'lagi
MAZE_RECT = {"x": 100, "y": -1250, "w": 1200, "h": 1350}
EXTRA_AREAS: list[dict] = []     # game_town: bog', tog', plyaj, orol
RENTALS: dict[str, tuple] = {}     # game_town: ijaraga olingan transport (mashina, tugash vaqti)
# Kosmodrom: aeroportning janubida — Oyga sayohat
ROCKET = {"x": 7150, "y": 2450, "price": 1000000}
# Aeroport: xaritaning sharqidagi o'rmonda (1900-ko'cha davomida). Doim kirish mumkin.
AIRPORT = {"rect": {"x": 6600, "y": 1250, "w": 1380, "h": 1500},  # shahar cheti bilan biroz ustma-ust (o'tish uchun)
           "runway": {"x": 7560, "y": 1330, "w": 150, "h": 1340},
           "terminal": {"x": 6960, "y": 1600, "w": 300, "h": 170},
           "gate": {"x": 7330, "y": 1860}}
# Akvapark: xaritaning g'arbidagi o'rmonda (1140-ko'cha davomida). Doim kirish mumkin.
AQUA = {"rect": {"x": -1300, "y": 900, "w": 1420, "h": 1150},
        "pool": {"x": -1150, "y": 1300, "w": 760, "h": 480},
        "slides": [{"x": -1180, "y": 1240}, {"x": -800, "y": 1240}, {"x": -420, "y": 1240}]}
# Bog'dagi joylar (favvora bog'i): pochta, pitsa, basketbol, kino; Avtosalon yonida avtoyuvish
PLACES = {
    "post": {"x": 2070, "y": 500, "w": 120, "h": 80, "door": {"x": 2130, "y": 600}},
    "pizza": {"x": 2560, "y": 500, "w": 120, "h": 80, "door": {"x": 2620, "y": 600}},
    "court": {"x": 2070, "y": 960, "w": 200, "h": 140, "hoop": {"x": 2092, "y": 1030}, "spot": {"x": 2180, "y": 1030}},
    "cinema": {"x": 2540, "y": 950, "w": 150, "h": 140, "door": {"x": 2615, "y": 1112}},
    "wash": {"x": 60, "y": 860, "w": 260, "h": 200, "door": {"x": 190, "y": 960}},
    "depot": {"x": 2820, "y": 2760, "w": 120, "h": 90, "door": {"x": 2880, "y": 2875}},
    "stage": {"x": 2560, "y": 680, "w": 130, "h": 90, "spot": {"x": 2625, "y": 725}},
    "bank": {"x": 2290, "y": 960, "w": 160, "h": 110, "door": {"x": 2370, "y": 940}},
    "clock": {"x": 2340, "y": 520, "w": 60, "h": 60, "spot": {"x": 2370, "y": 610}},
    "icecream": {"x": 2210, "y": 640, "w": 50, "h": 40, "spot": {"x": 2235, "y": 700}},
}
# Hayvonot bog'i — shimoldagi o'rmonda (1940-ko'cha davomi), port — janubi-sharqda (3420-ko'cha davomi)
ZOO = {"rect": {"x": 1700, "y": -1300, "w": 1700, "h": 1360},
       "pens": [{"kind": "lion", "x": 1800, "y": -600, "w": 380, "h": 300}, {"kind": "elephant", "x": 2250, "y": -650, "w": 420, "h": 350},
                {"kind": "giraffe", "x": 2750, "y": -650, "w": 380, "h": 350}, {"kind": "zebra", "x": 1800, "y": -1150, "w": 380, "h": 300},
                {"kind": "monkey", "x": 2250, "y": -1150, "w": 420, "h": 300}, {"kind": "penguin", "x": 2750, "y": -1150, "w": 380, "h": 300}]}
PORT = {"rect": {"x": 6600, "y": 2850, "w": 1600, "h": 1350},
        "sea": {"x": 7000, "y": 2900, "w": 1150, "h": 1250},
        "pier": {"x": 6960, "y": 3460}}
METRO = [{"id": 0, "name": "Shimoli-g'arb", "x": 200, "y": 250}, {"id": 1, "name": "Aeroport yo'li", "x": 6680, "y": 2040},
         {"id": 2, "name": "Stadion", "x": 2840, "y": 3380}, {"id": 3, "name": "Janubi-g'arb", "x": 200, "y": 3600}]
# Avtobus bekatlari (yo'l chetidagi trotuarda), aylana yo'nalish
BUS_STOPS = [{"x": 810, "y": 1128}, {"x": 2370, "y": 1128}, {"x": 3930, "y": 1128}, {"x": 5490, "y": 1128},
             {"x": 5490, "y": 2648}, {"x": 3930, "y": 2648}, {"x": 2370, "y": 2648}, {"x": 810, "y": 2648}]
FIELD = {"x": 2880, "y": 2900, "w": 540, "h": 340}                              # futbol maydoni (ikkinchi bog'da)
GOAL_W = 110                                                                     # darvoza kengligi


def _make_benches() -> list[dict]:
    """O'tiradigan skameykalar: favvora atrofida va futbol maydoni chetida. dir — qaragan tomoni (radian)."""
    cx, cy = FOUNTAIN["x"] + FOUNTAIN["w"] / 2, FOUNTAIN["y"] + FOUNTAIN["h"] / 2
    benches = [{"x": cx + dx * 105, "y": cy + dy * 105, "dir": math.atan2(-dy, -dx)}
               for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1))]
    for i in range(4):
        x = FIELD["x"] + 90 + i * 120
        benches.append({"x": x, "y": FIELD["y"] - 55, "dir": math.pi / 2})
        benches.append({"x": x, "y": FIELD["y"] + FIELD["h"] + 55, "dir": -math.pi / 2})
    return [{"id": i, "x": round(b["x"]), "y": round(b["y"]), "dir": round(b["dir"], 4)} for i, b in enumerate(benches)]


BENCHES = _make_benches()


def building_rect(plot: dict) -> dict:
    """Bino egallaydigan joy (darvozadan uzoqroqda, old tomoni darvozaga qaragan)."""
    y = plot["y"] + 15 if plot["gate"] == "bottom" else plot["y"] + 55
    return {"x": plot["x"] + 35, "y": y, "w": 150, "h": 100}


def plot_spawn(plot: dict) -> dict:
    """Yer darvozasi oldidagi yo'l."""
    y = plot["y"] + plot["h"] + 40 if plot["gate"] == "bottom" else plot["y"] - 40
    return {"x": plot["x"] + plot["w"] / 2, "y": y}


def _overlaps(px: float, py: float, rect: dict, pad: float = 0) -> bool:
    return (rect["x"] - pad <= px <= rect["x"] + rect["w"] + pad
            and rect["y"] - pad <= py <= rect["y"] + rect["h"] + pad)


BLOCKED_AREAS = PLOTS + [SHOP, FOUNTAIN, POND]


def _on_road(x: float, y: float, pad: float = 0) -> bool:
    return (any(r - pad <= y <= r + ROAD + pad for r in H_ROADS)
            or any(r - pad <= x <= r + ROAD + pad for r in V_ROADS))


def _make_trees() -> list[dict]:
    rng = random.Random(7)
    trees = []
    attempts = 0
    while len(trees) < 380 and attempts < 60000:
        attempts += 1
        x, y = rng.uniform(30, WORLD_W - 30), rng.uniform(30, WORLD_H - 30)
        if _on_road(x, y, 16) or any(_overlaps(x, y, a, 40) for a in BLOCKED_AREAS):
            continue
        if any(math.hypot(x - t["x"], y - t["y"]) < 70 for t in trees):
            continue
        trees.append({"x": round(x), "y": round(y), "r": rng.choice([22, 26, 30])})
    # Futbol maydoni va skameykalar ustida daraxt bo'lmasin
    return [t for t in trees if not _overlaps(t["x"], t["y"], FIELD, 90)
            and all(math.hypot(t["x"] - b["x"], t["y"] - b["y"]) > 45 for b in BENCHES)
            and not any(_overlaps(t["x"], t["y"], pl, 45) for pl in PLACES.values())
            and all(math.hypot(t["x"] - m["x"], t["y"] - m["y"]) > 70 for m in METRO)]


WORLD_DATA = {
    "w": WORLD_W, "h": WORLD_H, "road": ROAD, "h_roads": H_ROADS, "v_roads": V_ROADS,
    "plots": PLOTS, "buildings": [building_rect(p) for p in PLOTS],
    "shop": SHOP, "fountain": FOUNTAIN, "pond": POND, "trees": _make_trees(),
    "field": FIELD, "goal_w": GOAL_W, "benches": BENCHES, "track": TRACK, "airport": AIRPORT, "bus_stops": BUS_STOPS,
    "aqua": AQUA, "places": PLACES, "metro": METRO, "zoo": ZOO, "port": PORT, "river": RIVER, "rocket": ROCKET,
    "default_spawn": {"x": 1200, "y": 800}, "fly_height": FLY_HEIGHT, "fly_cruise": FLY_CRUISE,
}

# --------------------------------------------------------------------------- #
#  Jonli holat (xotirada)
# --------------------------------------------------------------------------- #
_lock = threading.Lock()
_live: dict[str, dict] = {}      # player_key -> {x, y, h, dir, car, t, name, avatar}
_quizzes: dict[str, dict] = {}   # player_key -> javob kutilayotgan savol (to'g'ri javob faqat serverda)
_quiz_recent: dict[str, list] = {}   # player_key -> yaqinda berilgan savollar (takrorlanmasin)
_quiz_cooldown: dict[str, float] = {}  # player_key -> noto'g'ri javobdan keyin kutish tugash vaqti
QUIZ_TTL = 600                   # savolga 10 daqiqa ichida javob berish kerak

_passengers: dict[int, dict] = {}  # yo'lovchi id -> {x, y, tx, ty, fare}
_seats: dict[str, str] = {}      # yo'lovchi -> haydovchi (do'stning mashinasida)
_rides: dict[str, dict] = {}       # player_key -> olib ketilayotgan yo'lovchi
_passenger_respawn: list[float] = []
_next_passenger = 1
_rng = random.Random()


def _sidewalk_spot() -> tuple:
    """Yo'l chetidagi tasodifiy joy (yo'lovchi turadigan yoki tushadigan)."""
    while True:
        # Yo'lning chekkasi (yo'l ichida, trotuar yonida)
        if _rng.random() < 0.5:
            r = _rng.choice(H_ROADS)
            x = _rng.uniform(60, WORLD_W - 60)
            y = r + 10 if _rng.random() < 0.5 else r + ROAD - 10
        else:
            r = _rng.choice(V_ROADS)
            y = _rng.uniform(60, WORLD_H - 60)
            x = r + 10 if _rng.random() < 0.5 else r + ROAD - 10
        if not any(_overlaps(x, y, a, 6) for a in BLOCKED_AREAS):
            return round(x), round(y)


def _add_passenger() -> None:
    global _next_passenger
    x, y = _sidewalk_spot()
    while True:
        tx, ty = _sidewalk_spot()
        dist = math.hypot(tx - x, ty - y)
        if dist >= TAXI_MIN_TRIP:
            break
    _passengers[_next_passenger] = {"x": x, "y": y, "tx": tx, "ty": ty,
                                    "fare": int(TAXI_BASE_FARE + dist * TAXI_PER_UNIT)}
    _next_passenger += 1


def _tick_passengers(now: float) -> None:
    """Yo'lovchilar yetishmasa qo'shadi (lock ichida chaqiriladi)."""
    while len(_passengers) + len(_passenger_respawn) < TAXI_WAITING:
        _add_passenger()
    due = [t for t in _passenger_respawn if t <= now]
    for _ in due:
        _add_passenger()
    _passenger_respawn[:] = [t for t in _passenger_respawn if t > now]


def _passenger_list() -> list[dict]:
    return [{"id": pid, "x": p["x"], "y": p["y"], "fare": p["fare"]} for pid, p in _passengers.items()]


TAXI_FAST_BONUS = 2.0        # juda tez yetkazsangiz — yo'l haqi 2 barobar
TAXI_SLOW_MULT = 0.6         # juda sekin bo'lsa — 60%
TAXI_FAST_RATIO = 1.3        # kutilgan vaqtdan 1.3 barobar tezroq (yoki teng) — to'liq bonus
TAXI_SLOW_RATIO = 4.0        # 4 barobar sekin — eng kam haq


def taxi_expected(ride: dict, car_id: str | None) -> float:
    """Yo'lovchini yetkazish uchun kutilgan vaqt (soniya): ko'chalar bo'ylab masofa / mashina tezligi."""
    speed = WALK_SPEED * (CARS_BY_ID[car_id]["speed"] if car_id in CARS_BY_ID else 1.7)
    return max(4.0, (abs(ride["tx"] - ride["x"]) + abs(ride["ty"] - ride["y"])) / speed)


def taxi_multiplier(elapsed: float, expected: float) -> float:
    ratio = elapsed / expected
    if ratio <= TAXI_FAST_RATIO:
        return TAXI_FAST_BONUS
    if ratio >= TAXI_SLOW_RATIO:
        return TAXI_SLOW_MULT
    k = (ratio - TAXI_FAST_RATIO) / (TAXI_SLOW_RATIO - TAXI_FAST_RATIO)
    return round(TAXI_FAST_BONUS + (TAXI_SLOW_MULT - TAXI_FAST_BONUS) * k, 2)


def _ride_json(key: str) -> dict | None:
    ride = _rides.get(key)
    if not ride:
        return None
    live = _live.get(key)
    expected = taxi_expected(ride, live["car"] if live else None)
    return {"id": ride["id"], "tx": ride["tx"], "ty": ride["ty"], "fare": ride["fare"],
            "elapsed": round(time.time() - ride.get("t", time.time()), 1), "expected": round(expected, 1),
            "fast": round(expected * TAXI_FAST_RATIO, 1), "slow": round(expected * TAXI_SLOW_RATIO, 1)}


def _others(me: str, now: float) -> list[dict]:
    return [
        {"key": key, "name": p["name"], "avatar": p["avatar"], "x": p["x"], "y": p["y"],
         "h": p.get("h", 0), "dir": p["dir"], "car": p["car"], "taxi": key in _rides,
         "seat": _seats.get(key),  # kimning mashinasida yo'lovchi bo'lib o'tiribdi
         "looks": p.get("looks") or {}, "clan": p.get("clan"), "pose": p.get("pose"),
         "drift": p.get("drift", False), "tune": p.get("tune"), "para": p.get("para", False),
         "ring": p.get("ring", False), "dirt": round(p.get("dirt", 0), 2), "pet": p.get("pet"), "boat": p.get("boat", False),
         "spider": p.get("spider", False), "web": p.get("web"), "ex": PLAYER_EXTRA.get(key),
         "emote": p["emote"]["e"] if p.get("emote") and now - p["emote"]["t"] < 4 else None}
        for key, p in _live.items()
        if key != me and now - p["t"] < ONLINE_SECONDS
    ]


def online_count() -> int:
    now = time.time()
    with _lock:
        return sum(1 for p in _live.values() if now - p["t"] < ONLINE_SECONDS)


def forget_player(key: str) -> None:
    """Foydalanuvchi o'chirilganda: xotira va bazadan olib tashlash (yerlari bo'shaydi)."""
    with _lock:
        _live.pop(key, None)
        _rides.pop(key, None)
        _gifts.pop(key, None)
        _seats.pop(key, None)
    db = get_db()
    for hook in FORGET_HOOKS:  # klan, poyga (game_social.py)
        hook(db, key)
    db.execute("DELETE FROM game_players WHERE player_key = ?", (key,))
    db.execute("DELETE FROM game_plots WHERE owner_key = ?", (key,))
    db.commit()


# --------------------------------------------------------------------------- #
#  O'yinchi puli va mulki (bazada)
# --------------------------------------------------------------------------- #
_econ_lock = threading.Lock()


class GameError(Exception):
    """Xarid amalga oshmadi (pul yetmaydi va h.k.)."""


def player_key(user: dict) -> str:
    return user["key"]


def my_plots(db, key: str) -> list:
    return db.execute(
        "SELECT plot, kind, level, sale_price, variant FROM game_plots WHERE owner_key = ? ORDER BY bought_at, plot", (key,)
    ).fetchall()


def player_rate(db, row) -> float:
    """Daromad, so'm/soniya (faqat binolardan)."""
    return round(sum(level_income(p["kind"], p["level"]) for p in my_plots(db, row["player_key"])), 2)


def money_now(row, rate: float, now: float | None = None) -> float:
    now = time.time() if now is None else now
    elapsed = min(max(now - row["income_at"], 0), OFFLINE_CAP_HOURS * 3600)
    return row["money"] + rate * elapsed


def ensure_player(db, key: str):
    row = db.execute("SELECT * FROM game_players WHERE player_key = ?", (key,)).fetchone()
    if row:
        if key == "owner" and row["money"] < OWNER_MONEY / 2:
            # Owner puli tugamaydi: kamayib ketsa yana to'ldiriladi
            with _econ_lock:
                db.execute("UPDATE game_players SET money = ? WHERE player_key = 'owner'", (OWNER_MONEY,))
                db.commit()
            row = db.execute("SELECT * FROM game_players WHERE player_key = ?", (key,)).fetchone()
        return row
    with _econ_lock:
        # Yangi o'yinchiga bitta bo'sh yer — Ota hovli (bepul)
        used = {r["plot"] for r in db.execute("SELECT plot FROM game_plots")}
        home = next((p["id"] for p in PLOTS if p["id"] not in used), None)
        now = time.time()
        cur = db.execute(
            "INSERT OR IGNORE INTO game_players (player_key, money, income_at, plot, spider) VALUES (?, ?, ?, ?, ?)",
            (key, OWNER_MONEY if key == "owner" else START_MONEY, now, home, int(key == "owner")),  # owner — o'rgimchak odam
        )
        if cur.rowcount and home is not None:
            db.execute(
                "INSERT OR IGNORE INTO game_plots (plot, owner_key, kind, level, bought_at) "
                "VALUES (?, ?, NULL, 0, ?)", (home, key, now),
            )
        db.commit()
    return db.execute("SELECT * FROM game_players WHERE player_key = ?", (key,)).fetchone()


def apply_change(db, key: str, change):
    """Yig'ilgan daromadni pulga qo'shib, o'zgarishni yozadi.

    change(row, money) -> (delta, mutate | None) yoki GameError.
    mutate() — bazadagi boshqa o'zgarishlar (yer, bino, mashina).
    Hammasi bitta lock ichida — tugma ikki marta bosilsa ham pul bir marta yechiladi.
    """
    with _econ_lock:
        row = db.execute("SELECT * FROM game_players WHERE player_key = ?", (key,)).fetchone()
        now = time.time()
        money = money_now(row, player_rate(db, row), now)
        delta, mutate = change(row, money)
        if mutate:
            mutate()
        db.execute("UPDATE game_players SET money = ?, income_at = ? WHERE player_key = ?",
                   (money + delta, now, key))
        db.commit()
        return db.execute("SELECT * FROM game_players WHERE player_key = ?", (key,)).fetchone()


def economy_json(db, row) -> dict:
    rate = player_rate(db, row)
    plots = []
    for p in my_plots(db, row["player_key"]):
        home = p["plot"] == row["plot"]
        level = p["level"]
        nxt = level + 1 if p["kind"] and level < max_level(p["kind"]) else None
        plots.append({
            "plot": p["plot"], "kind": p["kind"], "variant": p["variant"], "level": level, "home": home,
            "income": level_income(p["kind"], level),
            "next_price": level_price(p["kind"], nxt) if nxt else None,
            "next_income": level_income(p["kind"], nxt) if nxt else None,
            "price": p["sale_price"],  # sotuvga qo'yilgan narx (None — sotuvda emas)
            "invested": invested(p["kind"], level) + (0 if home else LAND_PRICE),
        })
    return {
        "money": math.floor(money_now(row, rate)),
        "rate": rate,
        "cars": json.loads(row["cars"]),
        "home": row["plot"],
        "plots": plots,
    }


def summary_for(db, key: str) -> dict | None:
    """Profil sahifasi uchun qisqa ma'lumot."""
    row = db.execute("SELECT * FROM game_players WHERE player_key = ?", (key,)).fetchone()
    if row is None:
        return None
    data = economy_json(db, row)
    data["car_names"] = [CARS_BY_ID[c]["name"] for c in data["cars"] if c in CARS_BY_ID]
    data["buildings"] = [
        {"name": variant_name(p["kind"], p["variant"]), "level": p["level"], "home": p["home"]}
        if p["kind"] else {"name": "Bo'sh yer", "level": 0, "home": p["home"]}
        for p in data["plots"]
    ]
    return data


def plots_list(db) -> list[dict]:
    rows = db.execute(
        "SELECT g.plot, g.owner_key, g.kind, g.level, g.sale_price, g.variant, u.name, p.plot AS home_plot, "
        "c.tag AS clan_tag, c.color AS clan_color FROM game_plots g "
        "LEFT JOIN users u ON g.owner_key = 'u' || u.id "
        "LEFT JOIN game_players p ON p.player_key = g.owner_key "
        "LEFT JOIN game_clans c ON c.id = p.clan"
    ).fetchall()
    return [
        {"plot": r["plot"], "owner": r["owner_key"], "kind": r["kind"], "variant": r["variant"], "level": r["level"],
         "home": r["home_plot"] == r["plot"], "price": r["sale_price"],
         "flag": {"tag": r["clan_tag"], "color": r["clan_color"]}
         if r["clan_tag"] and r["home_plot"] == r["plot"] else None,
         "name": config.OWNER_NAME if r["owner_key"] == "owner" else (r["name"] or "?")}
        for r in rows
    ]


FORGET_HOOKS: list = []  # game_social qo'shadi: hook(db, key)
SECURITY = lambda user, action: None   # classroom.guard: boshqa qurilmadan xavfli amal
MENTION = lambda user, text, only=None: 0   # classroom.mention: chatdagi @eslatish
RACE_AREA_KEYS: set = set()  # poygadagilar — trassada yura oladi
_teleports: dict = {}        # player_key -> (x, y, dir): keyingi sinxronda shu joyga ko'chiriladi
PLAYER_EXTRA: dict = {}     # game_plus: o'yinchi haqida qo'shimcha (uy hayvoni darajasi, hiylasi)
ROOF_TOP = lambda x, y: 0   # game_plus: shu nuqtadagi osmono'par tomi balandligi (lift bilan chiqiladi)
SYNC_HOOKS: list = []   # game_social qo'shadi: hook(db, key, row, now, response)
LOOKS = {
    "skin": ["#f0c08a", "#e0a96d", "#c68642", "#8d5524", "#ffdbac"],
    "hair": ["#2b2b2b", "#6b3f1d", "#d4a017", "#b91c1c", "#f8fafc", "#7c3aed", "#2563eb"],
    "shirt": ["#2563eb", "#dc2626", "#16a34a", "#f59e0b", "#7c3aed", "#ec4899", "#0f172a", "#f8fafc", "#14b8a6"],
    "pants": ["#1f2937", "#1e3a8a", "#78350f", "#4b5563", "#f5f5f4", "#166534"],
    "hat": ["", "cap", "hat", "beanie", "crown", "cowboy", "helmet", "tiara", "party", "chef"],
    "glasses": ["", "sun", "round", "star", "heart"],
}
WARDROBE = lambda db, key: {}            # game_plus: kiyim do'konidan olinganlar va narxlar
LOOK_GUARD = lambda db, key, looks: None  # game_plus: sotib olinmagan kiyim bo'lsa — xato matni


def player_looks(row) -> dict:
    """Saqlangan ko'rinish (faqat ruxsat etilgan qiymatlar)."""
    try:
        raw = json.loads(row["looks"] or "{}")
    except (ValueError, TypeError, IndexError, KeyError):
        raw = {}
    return {k: raw[k] for k, allowed in LOOKS.items() if isinstance(raw, dict) and raw.get(k) in allowed}


TUNE_SPEED_STEP = 0.08   # har tezlik darajasi +8%
TUNE_MAX_SPEED = 3


def player_tuning(row) -> dict:
    try:
        data = json.loads(row["tuning"] or "{}")
    except (ValueError, TypeError, IndexError, KeyError):
        return {}
    return data if isinstance(data, dict) else {}


def tune_speed(tuning: dict, car: str | None) -> float:
    lvl = (tuning.get(car) or {}).get("speed", 0) if car else 0
    return 1 + TUNE_SPEED_STEP * min(max(int(lvl or 0), 0), TUNE_MAX_SPEED)


EVENT_HOOKS: list = []   # kunlik vazifalar: hook(db, key, kind, n)


def emit(db, key: str, kind: str, n: int = 1) -> None:
    for hook in EVENT_HOOKS:
        hook(db, key, kind, n)


def clan_badge(db, row) -> dict | None:
    if not row["clan"]:
        return None
    c = db.execute("SELECT id, tag, color FROM game_clans WHERE id = ?", (row["clan"],)).fetchone()
    return {"id": c["id"], "tag": c["tag"], "color": c["color"]} if c else None


def _web(value):
    """O'rgimchak to'ri qayerga yopishgani (boshqalar ham to'rni ko'radi)."""
    if not isinstance(value, dict):
        return None
    try:
        x, y, h = float(value.get("x")), float(value.get("y")), float(value.get("h") or 0)
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(v) for v in (x, y, h)):
        return None
    return {"x": round(x), "y": round(y), "h": round(min(max(h, 0), FLY_HEIGHT))}


def _unit(value) -> float:
    """0..1 oralig'idagi son (mashina iflosligi); noto'g'ri qiymat — 0."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return 0.0
    return min(max(float(value), 0.0), 1.0)


def _live_pos(key: str, now: float):
    p = _live.get(key)
    return p if p and now - p["t"] < ONLINE_SECONDS else None


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
    home = row["plot"]
    spawn = plot_spawn(PLOTS[home]) if home is not None and home < len(PLOTS) else WORLD_DATA["default_spawn"]
    now = time.time()
    with _lock:
        _tick_passengers(now)
        passengers, players, ride = _passenger_list(), _others(key, now), _ride_json(key)
        chat = [_chat_public(m) for m in list(_chat) if _chat_visible(m, key)][-30:]
        voice_last = _voices[-1]["id"] if _voices else 0
    return jsonify(
        me={"key": key, "name": user["name"], "avatar": user["avatar"], "spawn": spawn},
        chat=chat,
        voice_last=voice_last,
        economy=economy_json(db, row),
        world=WORLD_DATA,
        catalog=CATALOG,
        plots=plots_list(db),
        passengers=passengers,
        ride=ride,
        players=players,
        walk_speed=WALK_SPEED,
        offline_cap_hours=OFFLINE_CAP_HOURS,
    )


@bp.post("/api/game/sync")
@login_required
def api_sync():
    """Brauzer har ~0.15 soniyada joylashuvini yuboradi, boshqalarni va yo'lovchilarni oladi."""
    user = current_user()
    key = player_key(user)
    data = request.get_json(silent=True) or {}
    try:
        x, y = float(data.get("x")), float(data.get("y"))
        direction = float(data.get("dir") or 0)
        height = float(data.get("h") or 0)  # sakrash / uchish balandligi
    except (TypeError, ValueError):
        return jsonify(error="Noto'g'ri joylashuv"), 400
    if not all(math.isfinite(v) for v in (x, y, direction, height)):
        return jsonify(error="Noto'g'ri joylashuv"), 400

    db = get_db()
    row = ensure_player(db, key)
    owned = json.loads(row["cars"])
    rent = RENTALS.get(key)
    if rent and rent[1] > time.time():
        owned = owned + [rent[0]]   # ijaraga olingan velosiped
    car = data.get("car") if data.get("car") in owned else None
    flying = bool(car and CARS_BY_ID[car].get("flies"))
    prev0 = _live.get(key)
    para = (not car and bool(data.get("para")) and prev0 is not None
            and (prev0.get("para") or (prev0.get("car") in CARS_BY_ID and CARS_BY_ID[prev0["car"]].get("flies") and prev0.get("h", 0) > 150)
                 or (not prev0.get("car") and prev0.get("h", 0) > 100 and ROOF_TOP(prev0["x"], prev0["y"]) > 0)))  # tomdan sakrash
    if para and prev0:
        height = min(height, prev0.get("h", 0))  # parashyutda faqat pastga tushiladi
    spider = bool(row["spider"]) and not car
    cap = FLY_HEIGHT + 20 if (flying or para or spider) else 120
    if not car:
        cap = max(cap, ROOF_TOP(x, y) + 5, prev0.get("h", 0) if para and prev0 else 0)  # osmono'par tomida turish
    height = min(max(height, 0), cap)
    world_rect = {"x": 0, "y": 0, "w": WORLD_W, "h": WORLD_H}
    areas = [TRACK["rect"]] if key in RACE_AREA_KEYS else [world_rect, AIRPORT["rect"], AQUA["rect"], ZOO["rect"], PORT["rect"], RIVER["rect"], MAZE_RECT, *EXTRA_AREAS]
    inside_rect = lambda a: a["x"] + 10 <= x <= a["x"] + a["w"] - 10 and a["y"] + 10 <= y <= a["y"] + a["h"] - 10
    in_area = any(inside_rect(a) for a in areas)
    if not in_area:  # chegaradan tashqarida — eng yaqin ruxsat etilgan joyga
        area = areas[0]
        x = min(max(x, area["x"] + 10), area["x"] + area["w"] - 10)
        y = min(max(y, area["y"] + 10), area["y"] + area["h"] - 10)

    looks, clan = player_looks(row), clan_badge(db, row)
    tuning = player_tuning(row)
    now = time.time()
    corrected = False
    seat = None
    with _lock:
        _tick_passengers(now)
        prev = _live.get(key)
        driver_key = _seats.get(key)
        teleport = _teleports.pop(key, None)
        if teleport:
            # Server o'zi ko'chirdi (poyga trassasiga yoki undan qaytish)
            x, y, direction = teleport
            corrected = True
            _seats.pop(key, None)
        elif key in RACE_AREA_KEYS and not in_area and prev:
            # Poygachi trassadan tashqarida (masalan, sahifani qayta ochdi) — trassadagi joyiga qaytaramiz
            x, y, corrected = prev["x"], prev["y"], True
        elif driver_key:
            # Do'stning mashinasida: joylashuv — haydovchiniki (o'zi yurmaydi)
            d = _live_pos(driver_key, now)
            if d and d["car"] and not _seats.get(driver_key):
                x, y, direction, car = d["x"], d["y"], d["dir"], None
                height = d.get("h", 0)
                seat = {"driver": driver_key, "name": d["name"]}
            else:
                _seats.pop(key, None)  # haydovchi tushdi yoki o'yindan chiqdi
                if d:
                    x, y = d["x"] + 40, d["y"]
                corrected = True
        elif prev and now - prev["t"] < 5:
            # Juda tez "sakrash" bo'lsa — eski joyiga qaytaramiz
            dt = min(now - prev["t"], 1.0)
            speeds = [CARS_BY_ID[c]["speed"] * tune_speed(tuning, c) for c in (car, prev["car"]) if c in CARS_BY_ID]
            if spider:
                speeds.append(4.0)  # to'r bilan uchish
            limit = WALK_SPEED * max(speeds + [1]) * dt * 1.6 + 40
            if math.hypot(x - prev["x"], y - prev["y"]) > limit:
                x, y, corrected = prev["x"], prev["y"], True
        pose = data.get("pose") if data.get("pose") in ("sit", "dance") and not car and not seat else None
        emote = prev.get("emote") if prev else None
        _live[key] = {"x": x, "y": y, "h": height if (flying or not car or seat) else 0, "dir": direction,
                      "para": para and height > 0, "emote": emote, "ring": bool(row["spouse"]), "pet": row["pet"],
                      "boat": bool(data.get("boat")) and not car and _overlaps(x, y, PORT["sea"], 20),
                      "dirt": _unit(data.get("dirt")),
                      "spider": spider, "web": _web(data.get("web")) if spider else None,
                      "car": car, "t": now, "name": user["name"], "avatar": user["avatar"],
                      "looks": looks, "clan": clan, "pose": pose,
                      "drift": bool(data.get("drift")) and bool(car),
                      "tune": {k: v for k, v in tuning.get(car, {}).items() if k in ("color", "neon", "rims", "tint")} if car else None}
        passengers, players, ride = _passenger_list(), _others(key, now), _ride_json(key)
        gifts = _gifts.pop(key, [])
        chat_since, voice_since = _int(data.get("chat_since")), _int(data.get("voice_since"))
        chat = [_chat_public(m) for m in _chat if m["id"] > chat_since and _chat_visible(m, key)]
        voices = [{"id": v["id"], "key": v["key"], "name": v["name"]} for v in _voices
                  if v["id"] > voice_since and v["key"] != key and now - v["t"] < VOICE_TTL
                  and (not v.get("to") or key in v["to"])]

    response = {"economy": economy_json(db, row), "passengers": passengers, "ride": ride,
                "players": players, "plots": plots_list(db), "gifts": gifts, "seat": seat,
                "chat": chat, "voices": voices}
    for hook in SYNC_HOOKS:  # bank, poyga, futbol to'pi (game_social.py)
        hook(db, key, row, now, response)
    if corrected:
        response["correct"] = {"x": x, "y": y, "dir": direction}
    return jsonify(response)


# --------------------------------------------------------------------------- #
#  Chat va ovozli xabarlar (rasiya: tugmani bosib turib gapiriladi)
# --------------------------------------------------------------------------- #
CHAT_MAX_LEN = 200
VOICE_MAX_BYTES = 600 * 1024     # ~15 soniyalik ovoz
VOICE_TTL = 30                   # ovoz bo'lagi 30 soniya saqlanadi (jonli ovoz)
_chat: deque = deque(maxlen=100)
_voices: deque = deque(maxlen=600)   # jonli ovoz bo'laklari (har biri ~1 soniya)
_msg_ids = itertools.count(1)


def _int(value) -> int:
    try:
        return max(int(value), 0)
    except (TypeError, ValueError):
        return 0


@bp.post("/api/game/chat")
@login_required
def api_chat():
    user = current_user()
    data = request.get_json(silent=True) or {}
    import game_trade
    import portal
    sticker = data.get("sticker") if data.get("sticker") in game_trade.STICKERS else None
    text = game_trade.STICKERS[sticker] if sticker else " ".join(str(data.get("text") or "").split())
    if not text:
        return jsonify(error="Xabar bo'sh"), 400
    channel = data.get("channel")
    channel = channel if channel in ("clan", "friends") else "all"
    msg = {"id": 0, "key": player_key(user), "name": user["name"], "avatar": user["avatar"],
           "text": text[:CHAT_MAX_LEN], "t": time.time(), "channel": channel}
    if sticker:
        msg["sticker"] = sticker
    deco = portal.deco_map(get_db()).get(msg["key"])
    if deco and deco["color"]:
        msg["color"] = deco["color"]
    reply = data.get("reply")
    if isinstance(reply, int) and not isinstance(reply, bool):
        with _lock:
            src = next((m for m in _chat if m["id"] == reply and _chat_visible(m, msg["key"])), None)
            # maxfiy (klan/do'st) xabarga javob ham faqat o'sha kanalda iqtibos qilinadi
            if src and src.get("channel", "all") in ("all", channel):
                msg["reply"] = {"name": src["name"], "text": src["text"][:80]}
                reply_to = src["key"]
            else:
                reply_to = None
    else:
        reply_to = None
    if channel != "all":
        msg["to"] = CHAT_AUDIENCE(player_key(user), channel)
        if not msg["to"]:
            return jsonify(error="Klaningiz yo'q" if channel == "clan" else "Hali do'stingiz yo'q"), 400
    with _lock:
        msg["id"] = next(_msg_ids)
        _chat.append(msg)
    MENTION(user, msg["text"], msg.get("to"))  # @ism — o'sha odamga bildirishnoma
    if reply_to and reply_to != msg["key"] and (reply_to == "owner" or reply_to.startswith("u")) and (channel == "all" or reply_to in msg["to"]):
        import game_social
        game_social._notify(reply_to, f"↩️ {user['name']} sizga javob berdi: {msg['text'][:60]}")
    return jsonify(message=_chat_public(msg))


def _chat_visible(m: dict, key: str) -> bool:
    return "to" not in m or key == m["key"] or key in m["to"]


def _chat_public(m: dict) -> dict:
    return {k: v for k, v in m.items() if k != "to"}


CHAT_AUDIENCE = lambda key, channel: []   # game_fun: klan a'zolari yoki do'stlar


@bp.post("/api/game/voice")
@login_required
def api_voice():
    user = current_user()
    file = request.files.get("audio")
    if file is None:
        return jsonify(error="Ovoz yuborilmadi"), 400
    data = file.read(VOICE_MAX_BYTES + 1)
    if not data:
        return jsonify(error="Ovoz bo'sh"), 400
    if len(data) > VOICE_MAX_BYTES:
        return jsonify(error="Ovozli xabar juda uzun"), 400
    mime = (file.mimetype or "audio/webm").split(";")[0]
    if not mime.startswith("audio/"):
        return jsonify(error="Bu ovoz emas"), 400
    now = time.time()
    to = None
    if request.form.get("channel") == "clan":  # klan ovozli xonasi: faqat klandoshlar eshitadi
        to = CHAT_AUDIENCE(player_key(user), "clan")
        if not to:
            return jsonify(error="Klaningiz yo'q"), 400
    with _lock:
        vid = next(_msg_ids)
        _voices.append({"id": vid, "key": player_key(user), "name": user["name"], "mime": mime,
                        "data": data, "t": now, "to": to})
    return jsonify(id=vid)


@bp.get("/api/game/voice/<int:vid>")
@login_required
def api_voice_get(vid: int):
    now = time.time()
    with _lock:
        v = next((v for v in _voices if v["id"] == vid and now - v["t"] < VOICE_TTL), None)
        me_key = player_key(current_user())
        if v is not None and v.get("to") and me_key != v["key"] and me_key not in v["to"]:
            v = None
    if v is None:
        return jsonify(error="Ovozli xabar topilmadi"), 404
    return Response(v["data"], mimetype=v["mime"], headers={"Cache-Control": "no-store"})


# --------------------------------------------------------------------------- #
#  Do'stning mashinasiga yo'lovchi bo'lib o'tirish
# --------------------------------------------------------------------------- #
SEAT_DIST = 120          # mashinaga shuncha yaqin bo'lsa o'tirish mumkin
SEATS_PER_CAR = 3        # haydovchidan tashqari


@bp.post("/api/game/seat")
@login_required
def api_seat():
    key = player_key(current_user())
    driver = (request.get_json(silent=True) or {}).get("driver")
    now = time.time()
    with _lock:
        me, d = _live_pos(key, now), _live_pos(driver, now) if isinstance(driver, str) else None
        if driver == key:
            return jsonify(error="O'z mashinangizga yo'lovchi bo'lib o'tira olmaysiz"), 400
        if not me:
            return jsonify(error="Avval o'yinga kiring"), 400
        if me["car"]:
            return jsonify(error="Avval o'z mashinangizdan tushing (E)"), 400
        if not d or not d["car"] or _seats.get(driver):
            return jsonify(error="Bu odam hozir mashinada emas"), 400
        if math.hypot(d["x"] - me["x"], d["y"] - me["y"]) > SEAT_DIST + 30:
            return jsonify(error="Mashinaga yaqinroq boring"), 400
        if sum(1 for v in _seats.values() if v == driver) >= SEATS_PER_CAR:
            return jsonify(error="Mashinada joy qolmagan"), 409
        _seats[key] = driver
        _rides.pop(key, None)
    return jsonify(seat={"driver": driver, "name": d["name"]})


@bp.post("/api/game/unseat")
@login_required
def api_unseat():
    key = player_key(current_user())
    with _lock:
        _seats.pop(key, None)
    return jsonify(ok=True)


# --------------------------------------------------------------------------- #
#  Odamlar ro'yxati va pul berish
# --------------------------------------------------------------------------- #
_gifts: dict[str, list] = {}  # player_key -> hali ko'rsatilmagan "X sizga Y so'm berdi" xabarlari
MAX_GIFT = 10 ** 18


def _all_people(db) -> list[dict]:
    """Saytdagi hamma odamlar (owner + foydalanuvchilar) — o'yinga kirmagan bo'lsa ham."""
    people = [{"key": "owner", "name": config.OWNER_NAME, "avatar": avatar_url(get_setting("owner_avatar"))}]
    for r in db.execute("SELECT id, name, avatar FROM users ORDER BY name COLLATE NOCASE"):
        people.append({"key": f"u{r['id']}", "name": r["name"], "avatar": avatar_url(r["avatar"])})
    return people


@bp.get("/api/game/people")
@login_required
def api_people():
    me = player_key(current_user())
    db = get_db()
    now = time.time()
    with _lock:
        online = {k for k, p in _live.items() if now - p["t"] < ONLINE_SECONDS}
    import portal
    deco = portal.deco_map(db)
    mine = db.execute("SELECT spouse FROM game_players WHERE player_key = ?", (me,)).fetchone()
    spouse = mine["spouse"] if mine else None
    people = [{**p, "online": p["key"] in online, "me": p["key"] == me, "deco": deco.get(p["key"]),
               "spouse": bool(spouse) and p["key"] == spouse} for p in _all_people(db)]
    people.sort(key=lambda p: (not p["me"], not p["online"], p["name"].lower()))
    return jsonify(people=people)


@bp.post("/api/game/give")
@login_required
def api_give():
    """Boshqa odamga o'z pulingizdan berish."""
    user = current_user()
    me = player_key(user)
    data = request.get_json(silent=True) or {}
    to, amount = data.get("to"), data.get("amount")
    blocked = SECURITY(user, "gift")
    if blocked:
        return blocked
    if isinstance(amount, bool) or not isinstance(amount, int) or not 1 <= amount <= MAX_GIFT:
        return jsonify(error="Qancha berishingizni yozing (butun son)"), 400
    if to == me:
        return jsonify(error="O'zingizga pul berib bo'lmaydi"), 400
    db = get_db()
    target = next((p for p in _all_people(db) if p["key"] == to), None)
    if target is None:
        return jsonify(error="Bunday odam yo'q"), 404
    ensure_player(db, me)
    ensure_player(db, to)
    with _econ_lock:
        now = time.time()
        a = db.execute("SELECT * FROM game_players WHERE player_key = ?", (me,)).fetchone()
        b = db.execute("SELECT * FROM game_players WHERE player_key = ?", (to,)).fetchone()
        a_money = money_now(a, player_rate(db, a), now)
        if a_money < amount:
            return jsonify(error="Pul yetarli emas"), 400
        b_money = money_now(b, player_rate(db, b), now)
        db.execute("UPDATE game_players SET money = ?, income_at = ? WHERE player_key = ?", (a_money - amount, now, me))
        db.execute("UPDATE game_players SET money = ?, income_at = ? WHERE player_key = ?", (b_money + amount, now, to))
        db.commit()
    with _lock:
        inbox = _gifts.setdefault(to, [])
        inbox.append({"from": user["name"], "amount": amount})
        del inbox[:-20]
    row = db.execute("SELECT * FROM game_players WHERE player_key = ?", (me,)).fetchone()
    return jsonify(economy=economy_json(db, row), to=target["name"], amount=amount)


# --------------------------------------------------------------------------- #
#  Taksi
# --------------------------------------------------------------------------- #
@bp.post("/api/game/taxi/pickup")
@login_required
def api_taxi_pickup():
    key = player_key(current_user())
    pid = (request.get_json(silent=True) or {}).get("id")
    now = time.time()
    with _lock:
        me = _live_pos(key, now)
        if not me or not me["car"]:
            return jsonify(error="Taksi uchun mashinada bo'lish kerak"), 400
        if key in _rides:
            return jsonify(error="Sizda allaqachon yo'lovchi bor"), 400
        passenger = _passengers.get(pid) if isinstance(pid, int) else None
        if passenger is None:
            return jsonify(error="Bu yo'lovchini boshqa taksi olib ketdi"), 409
        if math.hypot(passenger["x"] - me["x"], passenger["y"] - me["y"]) > TAXI_PICK_DIST + 30:
            return jsonify(error="Yo'lovchiga yaqinroq boring"), 400
        del _passengers[pid]
        _passenger_respawn.append(now + TAXI_RESPAWN_SECONDS)
        _rides[key] = {"id": pid, **passenger, "t": now}
        ride = _ride_json(key)
    return jsonify(ride=ride)


@bp.post("/api/game/taxi/dropoff")
@login_required
def api_taxi_dropoff():
    key = player_key(current_user())
    now = time.time()
    with _lock:
        ride = _rides.get(key)
        me = _live_pos(key, now)
        if not ride:
            return jsonify(error="Sizda yo'lovchi yo'q"), 400
        if not me or not me["car"]:
            return jsonify(error="Yo'lovchini mashinada olib boring"), 400
        if math.hypot(ride["tx"] - me["x"], ride["ty"] - me["y"]) > TAXI_DROP_DIST + 30:
            return jsonify(error="Manzilga hali yetib kelmadingiz"), 400
        _rides.pop(key, None)
        base = ride["fare"] * CARS_BY_ID[me["car"]]["fare"]
        elapsed = now - ride.get("t", now)
        mult = taxi_multiplier(elapsed, taxi_expected(ride, me["car"]))
        earned = int(base * mult)
    db = get_db()
    ensure_player(db, key)
    row = apply_change(db, key, lambda _row, _money: (earned, None))
    emit(db, key, "taxi")
    return jsonify(earned=earned, base=int(base), mult=mult, seconds=round(elapsed, 1), economy=economy_json(db, row))


@bp.post("/api/game/taxi/cancel")
@login_required
def api_taxi_cancel():
    key = player_key(current_user())
    with _lock:
        _rides.pop(key, None)
    return jsonify(ok=True)


# --------------------------------------------------------------------------- #
#  Yerlar va binolar
# --------------------------------------------------------------------------- #
def _plot_action(plot_id: int, change_for, extra=None):
    """Umumiy: yer ustidagi amal (sotib olish, qurish, sotish)."""
    if not 0 <= plot_id < len(PLOTS):
        return jsonify(error="Bunday yer yo'q"), 404
    key = player_key(current_user())
    db = get_db()
    ensure_player(db, key)
    try:
        row = apply_change(db, key, change_for(db, key))
    except GameError as err:
        return jsonify(error=str(err)), 400
    return jsonify(economy=economy_json(db, row), plots=plots_list(db), **(extra or {}))


def _owned_plot(db, key: str, plot_id: int):
    plot = db.execute("SELECT * FROM game_plots WHERE plot = ?", (plot_id,)).fetchone()
    if plot is None or plot["owner_key"] != key:
        raise GameError("Bu yer sizniki emas")
    return plot


def _buy_listed(db, buyer: str, plot_id: int) -> int:
    """Boshqa o'yinchi sotuvga qo'ygan yerni (binosi bilan) sotib olish: pul sotuvchiga o'tadi."""
    with _econ_lock:
        plot = db.execute("SELECT * FROM game_plots WHERE plot = ?", (plot_id,)).fetchone()
        if plot is None or plot["sale_price"] is None:
            raise GameError("Bu yer sotuvda emas")
        seller = plot["owner_key"]
        if seller == buyer:
            raise GameError("Bu yer o'zingizniki")
        price = plot["sale_price"]
        now = time.time()
        b = db.execute("SELECT * FROM game_players WHERE player_key = ?", (buyer,)).fetchone()
        s = db.execute("SELECT * FROM game_players WHERE player_key = ?", (seller,)).fetchone()
        # Yer egasi almashishidan oldin ikkalasining yig'ilgan daromadini hisoblab qo'yamiz
        b_money = money_now(b, player_rate(db, b), now)
        if b_money < price:
            raise GameError("Pul yetarli emas")
        db.execute("UPDATE game_players SET money = ?, income_at = ? WHERE player_key = ?", (b_money - price, now, buyer))
        if s is not None:
            s_money = money_now(s, player_rate(db, s), now)
            db.execute("UPDATE game_players SET money = ?, income_at = ? WHERE player_key = ?", (s_money + price, now, seller))
        db.execute("UPDATE game_plots SET owner_key = ?, sale_price = NULL, bought_at = ? WHERE plot = ?",
                   (buyer, now, plot_id))
        if s is not None and s["plot"] == plot_id:
            # Sotuvchi Ota hovlisini sotdi — keyingi yeri (bo'lsa) Ota hovli bo'ladi
            nxt = db.execute("SELECT plot FROM game_plots WHERE owner_key = ? ORDER BY bought_at, plot LIMIT 1",
                             (seller,)).fetchone()
            db.execute("UPDATE game_players SET plot = ? WHERE player_key = ?", (nxt[0] if nxt else None, seller))
        if b["plot"] is None:
            db.execute("UPDATE game_players SET plot = ? WHERE player_key = ?", (plot_id, buyer))
        db.commit()
        return price


@bp.post("/api/game/plots/<int:plot_id>/buy")
@login_required
def api_buy_plot(plot_id: int):
    """Bo'sh yerni (LAND_PRICE) yoki boshqa o'yinchi sotuvga qo'ygan yerni sotib olish."""
    if not 0 <= plot_id < len(PLOTS):
        return jsonify(error="Bunday yer yo'q"), 404
    key = player_key(current_user())
    db = get_db()
    ensure_player(db, key)
    listed = db.execute("SELECT owner_key, sale_price FROM game_plots WHERE plot = ?", (plot_id,)).fetchone()
    if listed is not None and listed["sale_price"] is not None and listed["owner_key"] != key:
        try:
            paid = _buy_listed(db, key, plot_id)
        except GameError as err:
            return jsonify(error=str(err)), 400
        row = db.execute("SELECT * FROM game_players WHERE player_key = ?", (key,)).fetchone()
        return jsonify(economy=economy_json(db, row), plots=plots_list(db), paid=paid)

    def change_for(db, key):
        def change(_row, money):
            if db.execute("SELECT 1 FROM game_plots WHERE plot = ?", (plot_id,)).fetchone():
                raise GameError("Bu yer allaqachon sotilgan")
            if money < LAND_PRICE:
                raise GameError("Pul yetarli emas")
            return -LAND_PRICE, lambda: db.execute(
                "INSERT INTO game_plots (plot, owner_key, kind, level, bought_at) VALUES (?, ?, NULL, 0, ?)",
                (plot_id, key, time.time()),
            )
        return change
    return _plot_action(plot_id, change_for)


@bp.post("/api/game/plots/<int:plot_id>/build")
@login_required
def api_build(plot_id: int):
    data = request.get_json(silent=True) or {}
    kind = data.get("kind")
    if kind not in BUILDINGS:
        return jsonify(error="Bino turini tanlang"), 400
    variant = data.get("variant") or VARIANT_IDS[kind][0]
    if variant not in VARIANT_IDS[kind]:
        return jsonify(error="Bunday variant yo'q"), 400

    def change_for(db, key):
        def change(_row, money):
            plot = _owned_plot(db, key, plot_id)
            if plot["level"] > 0:
                raise GameError("Bu yerda bino bor")
            price = level_price(kind, 1)
            if money < price:
                raise GameError("Pul yetarli emas")
            return -price, lambda: db.execute(
                "UPDATE game_plots SET kind = ?, variant = ?, level = 1 WHERE plot = ?", (kind, variant, plot_id))
        return change
    return _plot_action(plot_id, change_for)


def _listing_plot(plot_id: int):
    """Sotuvga qo'yish/olish: yer egasi yoki owner (har kimning yerini) qila oladi."""
    if not 0 <= plot_id < len(PLOTS):
        return None, None, (jsonify(error="Bunday yer yo'q"), 404)
    user = current_user()
    key = player_key(user)
    db = get_db()
    ensure_player(db, key)
    plot = db.execute("SELECT * FROM game_plots WHERE plot = ?", (plot_id,)).fetchone()
    if plot is None:
        return None, None, (jsonify(error="Bu yer hech kimniki emas"), 400)
    if plot["owner_key"] != key and user["role"] != "owner":
        return None, None, (jsonify(error="Bu yer sizniki emas"), 400)
    return db, key, None


def _listing_response(db, key: str):
    row = db.execute("SELECT * FROM game_players WHERE player_key = ?", (key,)).fetchone()
    return jsonify(economy=economy_json(db, row), plots=plots_list(db))


@bp.post("/api/game/plots/<int:plot_id>/list")
@login_required
def api_list_plot(plot_id: int):
    """Uyni (yerni binosi bilan) narx qo'yib sotuvga chiqarish. Uni boshqa o'yinchi sotib oladi."""
    price = (request.get_json(silent=True) or {}).get("price")
    blocked = SECURITY(current_user(), "sell")  # boshqa qurilmadan sotish — himoya chiqarib yuboradi
    if blocked:
        return blocked
    if isinstance(price, bool) or not isinstance(price, int) or not MIN_SALE_PRICE <= price <= MAX_SALE_PRICE:
        return jsonify(error=f"Narx {MIN_SALE_PRICE:,} dan {MAX_SALE_PRICE:,} so'mgacha bo'lsin".replace(",", " ")), 400
    db, key, err = _listing_plot(plot_id)
    if err:
        return err
    db.execute("UPDATE game_plots SET sale_price = ? WHERE plot = ?", (price, plot_id))
    db.commit()
    return _listing_response(db, key)


@bp.post("/api/game/plots/<int:plot_id>/unlist")
@login_required
def api_unlist_plot(plot_id: int):
    """Sotuvdan olib qo'yish."""
    db, key, err = _listing_plot(plot_id)
    if err:
        return err
    db.execute("UPDATE game_plots SET sale_price = NULL WHERE plot = ?", (plot_id,))
    db.commit()
    return _listing_response(db, key)


@bp.post("/api/game/plots/<int:plot_id>/demolish")
@owner_required
def api_owner_demolish(plot_id: int):
    """Owner: istalgan uyni buzadi (mode=building) yoki yerni egasidan olib bo'shatadi (mode=land)."""
    if not 0 <= plot_id < len(PLOTS):
        return jsonify(error="Bunday yer yo'q"), 404
    mode = (request.get_json(silent=True) or {}).get("mode", "building")
    if mode not in ("building", "land"):
        return jsonify(error="Noto'g'ri amal"), 400
    db = get_db()
    ensure_player(db, "owner")
    with _econ_lock:
        plot = db.execute("SELECT * FROM game_plots WHERE plot = ?", (plot_id,)).fetchone()
        if plot is None:
            return jsonify(error="Bu yer hech kimniki emas"), 400
        if mode == "building" and plot["level"] < 1:
            return jsonify(error="Bu yerda bino yo'q"), 400
        victim = db.execute("SELECT * FROM game_players WHERE player_key = ?", (plot["owner_key"],)).fetchone()
        now = time.time()
        if victim is not None:
            # Egasining shu paytgacha yig'ilgan daromadi saqlanib qoladi
            db.execute("UPDATE game_players SET money = ?, income_at = ? WHERE player_key = ?",
                       (money_now(victim, player_rate(db, victim), now), now, victim["player_key"]))
        if mode == "building":
            db.execute("UPDATE game_plots SET kind = NULL, variant = NULL, level = 0, sale_price = NULL WHERE plot = ?",
                       (plot_id,))
        else:
            db.execute("DELETE FROM game_plots WHERE plot = ?", (plot_id,))
            if victim is not None and victim["plot"] == plot_id:
                nxt = db.execute("SELECT plot FROM game_plots WHERE owner_key = ? ORDER BY bought_at, plot LIMIT 1",
                                 (victim["player_key"],)).fetchone()
                db.execute("UPDATE game_players SET plot = ? WHERE player_key = ?",
                           (nxt[0] if nxt else None, victim["player_key"]))
        db.commit()
    row = db.execute("SELECT * FROM game_players WHERE player_key = 'owner'").fetchone()
    return jsonify(economy=economy_json(db, row), plots=plots_list(db))


def _upgrade_check(db, key: str, plot_id: int, money: float) -> int:
    """Yangi qavat qo'shish mumkinmi? Mumkin bo'lsa — narxini qaytaradi, aks holda GameError."""
    plot = _owned_plot(db, key, plot_id)
    if not plot["kind"] or plot["level"] < 1:
        raise GameError("Avval bino quring")
    top = max_level(plot["kind"])
    if plot["level"] >= top:
        raise GameError(f"{BUILDINGS[plot['kind']]['name']} {top} qavatdan baland bo'lmaydi")
    price = level_price(plot["kind"], plot["level"] + 1)
    if money < price:
        raise GameError("Pul yetarli emas")
    return price


HARD_STEP = 10       # "+10 qavat": 2 ta juda qiyin savol
HARD_QUESTIONS = 2


def _step_check(db, key: str, plot_id: int, money: float, count: int) -> tuple[int, int]:
    """count qavat qo'shish mumkinmi: (qo'shiladigan qavatlar, jami narx) yoki GameError."""
    _upgrade_check(db, key, plot_id, money)
    plot = _owned_plot(db, key, plot_id)
    floors = min(count, max_level(plot["kind"]) - plot["level"])
    total = sum(level_price(plot["kind"], lv) for lv in range(plot["level"] + 1, plot["level"] + floors + 1))
    if money < total:
        raise GameError(f"Pul yetarli emas: {floors} qavat uchun {total:,} so'm kerak".replace(",", " "))
    return floors, total


@bp.post("/api/game/plots/<int:plot_id>/quiz")
@login_required
def api_quiz(plot_id: int):
    """Yangi qavat oldidan savol: +1 qavat — 1 ta oddiy HTML/CSS savoli,
    +10 qavat — 2 ta juda qiyin savol (ikkalasi ham to'g'ri bo'lishi kerak)."""
    if not 0 <= plot_id < len(PLOTS):
        return jsonify(error="Bunday yer yo'q"), 404
    count = (request.get_json(silent=True) or {}).get("count", 1)
    if count not in (1, HARD_STEP) or isinstance(count, bool):
        return jsonify(error="Faqat 1 yoki 10 qavat qo'shish mumkin"), 400
    key = player_key(current_user())
    db = get_db()
    row = ensure_player(db, key)
    now = time.time()
    wait = _quiz_cooldown.get(key, 0) - now
    if wait > 0:
        return jsonify(error=f"{math.ceil(wait)} soniyadan keyin yangi savol olasiz", wait=math.ceil(wait)), 429
    try:
        _step_check(db, key, plot_id, money_now(row, player_rate(db, row), now), count)
    except GameError as err:
        return jsonify(error=str(err)), 400

    with _lock:
        recent = _quiz_recent.setdefault(key, [])
        if count == 1:
            items = [quiz.issue(exclude={q for q in recent if isinstance(q, int)})]
        else:
            items = quiz.issue_hard(HARD_QUESTIONS, exclude={q for q in recent if isinstance(q, str)})
        recent.extend(item["qid"] for item in items)
        del recent[:-15]
        token = f"{int(now * 1000)}-{'-'.join(str(i['qid']) for i in items)}"
        first = items[0]
        _quizzes[key] = {**first, "token": token, "plot": plot_id, "t": now, "count": count, "questions": items}
    public = [{"topic": i["topic"], "question": i["question"], "options": i["options"]} for i in items]
    return jsonify(quiz={"token": token, "count": count, "hard": count > 1, "questions": public, **public[0]})


def _owner_upgrade(plot_id: int, data: dict):
    """Owner savolsiz qavat qo'shadi (bir bosishda 10 tagacha)."""
    count = data.get("count", 1)
    if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= OWNER_MAX_STEP:
        return jsonify(error=f"Qavatlar soni 1 dan {OWNER_MAX_STEP} gacha bo'lishi kerak"), 400
    key = "owner"
    db = get_db()
    ensure_player(db, key)
    added = {}

    def change(_row, money):
        _upgrade_check(db, key, plot_id, money)  # bino bormi, 100 qavat emasmi, birinchi qavatga pul yetadimi
        plot = _owned_plot(db, key, plot_id)
        level, total = plot["level"], 0
        while level - plot["level"] < count and level < max_level(plot["kind"]):
            price = level_price(plot["kind"], level + 1)
            if money - total < price:
                break
            total += price
            level += 1
        added["floors"] = level - plot["level"]
        return -total, lambda: db.execute("UPDATE game_plots SET level = ? WHERE plot = ?", (level, plot_id))

    try:
        row = apply_change(db, key, change)
    except GameError as err:
        return jsonify(error=str(err)), 400
    emit(db, key, "floor", added["floors"])
    return jsonify(correct=True, added=added["floors"], economy=economy_json(db, row), plots=plots_list(db))


@bp.post("/api/game/plots/<int:plot_id>/upgrade")
@login_required
def api_upgrade(plot_id: int):
    """Yangi qavat faqat savolga to'g'ri javob berilsa qo'shiladi (owner — savolsiz)."""
    if not 0 <= plot_id < len(PLOTS):
        return jsonify(error="Bunday yer yo'q"), 404
    user = current_user()
    data = request.get_json(silent=True) or {}
    if user["role"] == "owner":
        return _owner_upgrade(plot_id, data)
    key = player_key(user)
    now = time.time()
    with _lock:
        pending = _quizzes.get(key)
        if (not pending or pending["token"] != data.get("quiz") or pending["plot"] != plot_id
                or now - pending["t"] > QUIZ_TTL):
            return jsonify(error="Avval savolga javob bering (savol eskirgan bo'lishi mumkin)"), 400
        _quizzes.pop(key, None)  # har bir savolga bitta urinish

    questions = pending["questions"]
    answers = data.get("answers")
    if answers is None:
        answers = [data.get("answer")]
    if not isinstance(answers, list):
        answers = []
    results = []
    for i, q in enumerate(questions):
        a = answers[i] if i < len(answers) else None
        ok = isinstance(a, int) and not isinstance(a, bool) and a == q["correct"]
        results.append({"correct": ok, "right_index": q["correct"], "right_answer": q["options"][q["correct"]],
                        "explain": q["explain"]})
    if not all(r["correct"] for r in results):
        import learn
        for q, r in zip(questions, results):
            learn.note(get_db(), key, q, r["correct"])  # xatolar daftariga
        get_db().commit()
        _quiz_cooldown[key] = now + QUIZ_COOLDOWN
        wrong = next(r for r in results if not r["correct"])
        return jsonify(correct=False, right_answer=wrong["right_answer"], right_index=results[0]["right_index"],
                       explain=wrong["explain"], results=results, wait=QUIZ_COOLDOWN)

    db = get_db()
    ensure_player(db, key)
    added = {}

    def change(_row, money):
        floors, total = _step_check(db, key, plot_id, money, pending.get("count", 1))
        added["floors"] = floors
        return -total, lambda: db.execute("UPDATE game_plots SET level = level + ? WHERE plot = ?", (floors, plot_id))

    try:
        row = apply_change(db, key, change)
    except GameError as err:
        return jsonify(error=str(err)), 400
    emit(db, key, "floor", added["floors"])
    return jsonify(correct=True, explain=results[0]["explain"], results=results, added=added["floors"],
                   economy=economy_json(db, row), plots=plots_list(db))


# --------------------------------------------------------------------------- #
#  Avtosalon
# --------------------------------------------------------------------------- #
@bp.post("/api/game/cars/<car_id>")
@login_required
def api_buy_car(car_id: str):
    key = player_key(current_user())
    car = CARS_BY_ID.get(car_id)
    if car is None:
        return jsonify(error="Bunday mashina yo'q"), 404
    now = time.time()
    with _lock:
        me = _live_pos(key, now)
        door = SHOP["door"]
        near = me is not None and math.hypot(me["x"] - door["x"], me["y"] - door["y"]) <= SHOP_RADIUS
    if not near:
        return jsonify(error="Mashina faqat Avtosalonda sotiladi — Avtosalonga boring"), 400
    db = get_db()
    ensure_player(db, key)

    def change(row, money):
        cars = json.loads(row["cars"])
        if car_id in cars:
            raise GameError("Bu mashina sizda bor")
        if car["speed"] >= 2.0 and not row["license"] and key != "owner":  # game_life.LICENSE_SPEED
            raise GameError("Bu tez mashina uchun haydovchilik guvohnomasi kerak — Menyu → Haydovchilik testi")
        if money < car["price"]:
            raise GameError("Pul yetarli emas")
        return -car["price"], lambda: db.execute(
            "UPDATE game_players SET cars = ? WHERE player_key = ?", (json.dumps(cars + [car_id]), key))

    try:
        row = apply_change(db, key, change)
    except GameError as err:
        return jsonify(error=str(err)), 400
    return jsonify(economy=economy_json(db, row))
