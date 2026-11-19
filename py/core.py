"""Umumiy yordamchilar: yo'llar, baza (SQLite), sessiya va huquqlar."""
import json
import sqlite3
from datetime import datetime
from functools import wraps
from pathlib import Path

from flask import g, jsonify, session

import config

PY_DIR = Path(__file__).resolve().parent
ROOT_DIR = PY_DIR.parent  # loyiha papkasi: index.html, panel.html, static/
DATA_DIR = ROOT_DIR / "data"
DB_PATH = DATA_DIR / "oyin.db"
UPLOAD_DIR = DATA_DIR / "uploads"
AVATAR_DIR = DATA_DIR / "avatars"

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    login         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    score         INTEGER NOT NULL DEFAULT 0,   -- owner bergan ballar
    avatar        TEXT,                         -- data/avatars/ dagi rasm nomi
    session_version INTEGER NOT NULL DEFAULT 0, -- parol/login almashsa oshadi -> eski sessiyalar bekor
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS game_players (
    player_key  TEXT PRIMARY KEY,              -- 'u<id>' yoki 'owner'
    money       REAL NOT NULL,
    income_at   REAL NOT NULL,                 -- daromad shu vaqtgacha hisoblangan (unix soniya)
    house_level INTEGER NOT NULL DEFAULT 0,    -- eski (game_plots ga ko'chirilgan)
    cars        TEXT NOT NULL DEFAULT '[]',    -- JSON: sotib olingan mashinalar
    plot        INTEGER,                       -- Ota hovli — bepul berilgan birinchi yer
    bank        REAL NOT NULL DEFAULT 0,       -- bankdagi omonat (foiz bilan o'sadi)
    bank_at     REAL NOT NULL DEFAULT 0,
    loan        REAL NOT NULL DEFAULT 0,       -- kredit qarzi (foiz bilan o'sadi)
    loan_at     REAL NOT NULL DEFAULT 0,
    loan_due    REAL NOT NULL DEFAULT 0,       -- shu vaqtdan keyin qarz puldan o'zi yechiladi
    looks       TEXT NOT NULL DEFAULT '{}',    -- JSON: soch, kiyim, shapka ranglari
    tuning      TEXT NOT NULL DEFAULT '{}',    -- JSON: mashina -> {rang, tezlik darajasi, neon}
    daily       TEXT NOT NULL DEFAULT '{}',    -- JSON: kunlik vazifalar holati
    spin_day    TEXT,                          -- omad g'ildiragi oxirgi aylantirilgan kun
    stocks      TEXT NOT NULL DEFAULT '{}',    -- JSON: aksiyalar {belgi: {qty, cost}}
    spouse      TEXT,                          -- turmush o'rtog'i (to'y qilgan)
    week_id     TEXT,                          -- haftalik turnir: qaysi hafta
    week_start  REAL,                          -- hafta boshidagi boylik
    pet         TEXT,                          -- uy hayvoni: dog | cat | parrot
    license     INTEGER NOT NULL DEFAULT 0,    -- haydovchilik guvohnomasi (tez mashinalar uchun)
    license_try REAL NOT NULL DEFAULT 0,       -- oxirgi yiqilgan imtihon vaqti
    clan        INTEGER                        -- game_clans.id
);

-- O'yindagi kod chellenjlari: kim qaysi topshiriqni bajargan
CREATE TABLE IF NOT EXISTS game_challenges (
    player_key  TEXT NOT NULL,
    challenge   TEXT NOT NULL,
    solved_at   REAL NOT NULL,
    PRIMARY KEY (player_key, challenge)
);

-- Guruhlar (sinflar)
CREATE TABLE IF NOT EXISTS groups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE
);

-- Dars jadvali
CREATE TABLE IF NOT EXISTS lessons (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    starts_at   TEXT NOT NULL,                 -- 2026-11-21T14:00
    topic       TEXT NOT NULL,
    group_id    INTEGER
);

-- Saytda necha daqiqa bo'lgan (kun bo'yicha)
CREATE TABLE IF NOT EXISTS activity (
    user_key    TEXT NOT NULL,
    day         TEXT NOT NULL,
    minutes     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_key, day)
);

-- AI yordamchidan foydalanish (kunlik cheklov)
CREATE TABLE IF NOT EXISTS ai_hint_use (
    user_key    TEXT NOT NULL,
    day         TEXT NOT NULL,
    n           INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_key, day)
);

-- So'rovnomalar (panel)
CREATE TABLE IF NOT EXISTS polls2 (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    question    TEXT NOT NULL,
    options     TEXT NOT NULL,
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS poll_votes2 (
    poll_id     INTEGER NOT NULL REFERENCES polls2(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    choice      INTEGER NOT NULL,
    PRIMARY KEY (poll_id, user_id)
);

-- Sovg'alar do'koni: ballni sovg'aga almashtirish
CREATE TABLE IF NOT EXISTS rewards (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    cost        INTEGER NOT NULL,
    stock       INTEGER NOT NULL DEFAULT 0,
    active      INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS reward_orders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    reward_id   INTEGER NOT NULL,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cost        INTEGER NOT NULL,
    status      TEXT NOT NULL,                 -- pending | given | cancelled
    t           REAL NOT NULL
);

-- Qurilmalar: akkauntga birinchi kirgan qurilma — asosiy (himoya uchun)
CREATE TABLE IF NOT EXISTS devices (
    user_key    TEXT NOT NULL,
    device      TEXT NOT NULL,
    ua          TEXT,
    first_at    REAL NOT NULL,
    last_at     REAL NOT NULL,
    PRIMARY KEY (user_key, device)
);

CREATE TABLE IF NOT EXISTS security_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_key    TEXT NOT NULL,
    device      TEXT NOT NULL,
    action      TEXT NOT NULL,
    t           REAL NOT NULL
);

-- Bildirishnomalar (qo'ng'iroq): @eslatish, test boshlandi, savollar yuborildi
CREATE TABLE IF NOT EXISTS notifications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_key    TEXT NOT NULL,
    text        TEXT NOT NULL,
    link        TEXT NOT NULL DEFAULT '',
    t           REAL NOT NULL,
    seen        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications (user_key, id);

-- Reytingda ball sovg'a qilish tarixi
CREATE TABLE IF NOT EXISTS point_gifts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id     INTEGER NOT NULL,
    to_id       INTEGER NOT NULL,
    amount      INTEGER NOT NULL,
    t           REAL NOT NULL
);

-- Davomat: kun bo'yicha keldi / kechikdi / kelmadi va ball (kelmadi = -1)
CREATE TABLE IF NOT EXISTS attendance (
    day         TEXT NOT NULL,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status      TEXT NOT NULL,
    points      INTEGER NOT NULL DEFAULT 0,
    updated_at  REAL NOT NULL,
    PRIMARY KEY (day, user_id)
);

-- Darsdagi savollar: owner «Boshlash» bosadi, o'quvchi 5 ta savolga javob beradi
CREATE TABLE IF NOT EXISTS lesson_quiz (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day         TEXT NOT NULL,
    questions   TEXT NOT NULL,
    answers     TEXT NOT NULL DEFAULT '[]',
    status      TEXT NOT NULL,
    created_at  REAL NOT NULL
);

-- Do'stlar: a — so'rov yuborgan, b — qabul qiluvchi
CREATE TABLE IF NOT EXISTS game_friends (
    a           TEXT NOT NULL,
    b           TEXT NOT NULL,
    status      TEXT NOT NULL,                 -- pending | ok
    created_at  REAL NOT NULL,
    PRIMARY KEY (a, b)
);

-- Telefon: shaxsiy xabarlar
CREATE TABLE IF NOT EXISTS game_pm (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    a           TEXT NOT NULL,                 -- kimdan
    b           TEXT NOT NULL,                 -- kimga
    text        TEXT NOT NULL,
    t           REAL NOT NULL
);

-- Haftalik turnir: qaysi hafta mukofotlari berilgan
CREATE TABLE IF NOT EXISTS game_weekly (
    week        TEXT PRIMARY KEY,
    paid_at     REAL NOT NULL,
    winners     TEXT NOT NULL
);

-- Klanlar (jamoalar): umumiy xazina va bayroq
CREATE TABLE IF NOT EXISTS game_clans (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    tag         TEXT NOT NULL,
    color       TEXT NOT NULL,
    leader      TEXT NOT NULL,
    money       REAL NOT NULL DEFAULT 0,
    created_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS game_plots (
    plot        INTEGER PRIMARY KEY,           -- xaritadagi yer raqami
    owner_key   TEXT NOT NULL,                 -- 'u<id>' yoki 'owner'
    kind        TEXT,                          -- uy | magazin | kafe | ofis (NULL = bo'sh yer)
    level       INTEGER NOT NULL DEFAULT 0,
    bought_at   REAL NOT NULL,
    sale_price  INTEGER,                       -- sotuvga qo'yilgan narx (NULL = sotuvda emas)
    variant     TEXT,                          -- bino varianti (gadjet, pizza, bank ...)
    furniture   TEXT NOT NULL DEFAULT '[]'     -- JSON: bino ichidagi mebel
);

-- Haftalik mashina ovozi: o'yinchilar mashina taklif qiladi, g'olib Avtosalonga qo'shiladi
CREATE TABLE IF NOT EXISTS car_polls (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at  REAL NOT NULL,
    ends_at     REAL NOT NULL,
    closed      INTEGER NOT NULL DEFAULT 0,
    winner      INTEGER                        -- g'olib taklif (car_proposals.id)
);

CREATE TABLE IF NOT EXISTS car_proposals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id     INTEGER NOT NULL REFERENCES car_polls(id),
    name        TEXT NOT NULL,
    ability     TEXT NOT NULL,
    author_key  TEXT NOT NULL,
    author_name TEXT NOT NULL,
    stats       TEXT NOT NULL,                 -- JSON: tezlik, taksi haqi, uchadimi, ko'rinish, rang, narx
    created_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS car_votes (
    poll_id     INTEGER NOT NULL,
    voter_key   TEXT NOT NULL,
    proposal_id INTEGER NOT NULL,
    PRIMARY KEY (poll_id, voter_key)
);

CREATE TABLE IF NOT EXISTS custom_cars (
    id          TEXT PRIMARY KEY,              -- 'c_<taklif id>'
    name        TEXT NOT NULL,
    ability     TEXT NOT NULL,
    author_name TEXT NOT NULL,
    stats       TEXT NOT NULL,
    added_at    REAL NOT NULL
);

-- Panel testlari: owner tuzib boshlaydi, foydalanuvchilar bir marta yechadi
CREATE TABLE IF NOT EXISTS exams (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    topics      TEXT NOT NULL,                 -- JSON: ["HTML", "CSS", "JS"]
    questions   TEXT NOT NULL,                 -- JSON: [{topic, question, options, correct, explain}]
    created_at  REAL NOT NULL,
    active      INTEGER NOT NULL DEFAULT 1,
    ended_at    REAL
);

CREATE TABLE IF NOT EXISTS exam_attempts (
    exam_id     INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    started_at  REAL NOT NULL,
    finished_at REAL,
    answers     TEXT,
    score       INTEGER,
    PRIMARY KEY (exam_id, user_id)
);

CREATE TABLE IF NOT EXISTS homeworks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    files       TEXT NOT NULL DEFAULT '[]',   -- JSON: owner biriktirgan vazifa fayllari
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS submissions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    homework_id    INTEGER NOT NULL REFERENCES homeworks(id) ON DELETE CASCADE,
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    files          TEXT NOT NULL,                -- JSON: saqlangan fayl nomlari
    status         TEXT NOT NULL,                -- checking | checked | pending | error
    score          INTEGER NOT NULL DEFAULT 0,   -- reytingga qo'shiladigan ball
    ai_probability INTEGER,                      -- AI yasagan bo'lish ehtimoli, %
    ai_reason      TEXT,
    feedback       TEXT,
    mistakes       TEXT,                         -- JSON: AI topgan xatolar ro'yxati
    game_bonus     INTEGER NOT NULL DEFAULT 0,   -- shu ish uchun o'yinda berilgan pul (so'm)
    error          TEXT,
    graded_by      TEXT,                         -- ai | owner
    created_at     TEXT NOT NULL,
    UNIQUE (homework_id, user_id)
);
"""


RATING_SQL = (
    "SELECT u.id, u.name, u.login, u.avatar, u.created_at, u.group_id, "
    "u.score + COALESCE((SELECT SUM(s.score) FROM submissions s WHERE s.user_id = u.id), 0) "
    "+ COALESCE((SELECT SUM(a.points) FROM attendance a WHERE a.user_id = u.id), 0) AS total "
    "FROM users u ORDER BY total DESC, u.id ASC"
)


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def avatar_url(filename: str | None) -> str | None:
    return f"/avatars/{filename}" if filename else None


def get_setting(key: str) -> str | None:
    row = get_db().execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def set_setting(key: str, value: str | None) -> None:
    db = get_db()
    if value is None:
        db.execute("DELETE FROM settings WHERE key = ?", (key,))
    else:
        db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, value))
    db.commit()


# --------------------------------------------------------------------------- #
#  Baza
# --------------------------------------------------------------------------- #
def init_db() -> None:
    DATA_DIR.mkdir(exist_ok=True)
    UPLOAD_DIR.mkdir(exist_ok=True)
    AVATAR_DIR.mkdir(exist_ok=True)
    db = sqlite3.connect(DB_PATH)
    try:
        db.executescript(SCHEMA)
        import extras, game_life  # panel qo'shimchalari va o'yindagi yangi jadvallar
        db.executescript(extras.SCHEMA + game_life.SCHEMA)
        # Eski bazada yangi ustunlar bo'lmasa — qo'shamiz
        columns = {row[1] for row in db.execute("PRAGMA table_info(users)")}
        if "score" not in columns:
            db.execute("ALTER TABLE users ADD COLUMN score INTEGER NOT NULL DEFAULT 0")
        if "avatar" not in columns:
            db.execute("ALTER TABLE users ADD COLUMN avatar TEXT")
        if "session_version" not in columns:
            db.execute("ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0")
        for name, ddl in (("group_id", "INTEGER"), ("report_token", "TEXT"), ("birthday", "TEXT"), ("bday_paid", "TEXT")):
            if name not in columns:  # guruh, ota-ona hisoboti havolasi, tug'ilgan kun
                db.execute(f"ALTER TABLE users ADD COLUMN {name} {ddl}")
        hw_columns = {row[1] for row in db.execute("PRAGMA table_info(homeworks)")}
        if "files" not in hw_columns:
            db.execute("ALTER TABLE homeworks ADD COLUMN files TEXT NOT NULL DEFAULT '[]'")
        if "deadline" not in hw_columns:  # topshirish muddati (vaqtida +1, kechiksa -1)
            db.execute("ALTER TABLE homeworks ADD COLUMN deadline TEXT")
        if "link" not in hw_columns:  # vazifa havolasi (masalan, Figma maketi)
            db.execute("ALTER TABLE homeworks ADD COLUMN link TEXT NOT NULL DEFAULT ''")
        sub_columns = {row[1] for row in db.execute("PRAGMA table_info(submissions)")}
        if "mistakes" not in sub_columns:
            db.execute("ALTER TABLE submissions ADD COLUMN mistakes TEXT")
        for name in ("copy_of", "copy_score"):
            if name not in sub_columns:  # ko'chirish ehtimoli: kimning ishiga o'xshash va necha foiz
                db.execute(f"ALTER TABLE submissions ADD COLUMN {name} {'TEXT' if name == 'copy_of' else 'INTEGER'}")
        if "game_bonus" not in sub_columns:  # uy vazifasi uchun o'yinda berilgan pul
            db.execute("ALTER TABLE submissions ADD COLUMN game_bonus INTEGER NOT NULL DEFAULT 0")
        plot_columns = {row[1] for row in db.execute("PRAGMA table_info(game_plots)")}
        if "sale_price" not in plot_columns:
            db.execute("ALTER TABLE game_plots ADD COLUMN sale_price INTEGER")
        if "variant" not in plot_columns:  # bino varianti: gadjet do'kon, pitsa, bank ...
            db.execute("ALTER TABLE game_plots ADD COLUMN variant TEXT")
        if "furniture" not in plot_columns:  # bino ichidagi mebel
            db.execute("ALTER TABLE game_plots ADD COLUMN furniture TEXT NOT NULL DEFAULT '[]'")
        player_columns = {row[1] for row in db.execute("PRAGMA table_info(game_players)")}
        for name, ddl in (("bank", "REAL NOT NULL DEFAULT 0"), ("bank_at", "REAL NOT NULL DEFAULT 0"),
                          ("loan", "REAL NOT NULL DEFAULT 0"), ("loan_at", "REAL NOT NULL DEFAULT 0"),
                          ("loan_due", "REAL NOT NULL DEFAULT 0"), ("looks", "TEXT NOT NULL DEFAULT '{}'"),
                          ("clan", "INTEGER"), ("tuning", "TEXT NOT NULL DEFAULT '{}'"),
                          ("daily", "TEXT NOT NULL DEFAULT '{}'"), ("spin_day", "TEXT"),
                          ("stocks", "TEXT NOT NULL DEFAULT '{}'"), ("spouse", "TEXT"),
                          ("week_id", "TEXT"), ("week_start", "REAL"), ("pet", "TEXT"),
                          ("license", "INTEGER NOT NULL DEFAULT 0"), ("license_try", "REAL NOT NULL DEFAULT 0")):
            if name not in player_columns:  # bank, kredit, ko'rinish, klan
                db.execute(f"ALTER TABLE game_players ADD COLUMN {name} {ddl}")
        # Eski "Ota hovli" (game_players.plot + house_level) -> yangi yerlar jadvali (bino turi: uy)
        db.execute(
            "INSERT OR IGNORE INTO game_plots (plot, owner_key, kind, level, bought_at) "
            "SELECT plot, player_key, CASE WHEN house_level > 0 THEN 'uy' END, house_level, income_at "
            "FROM game_players WHERE plot IS NOT NULL"
        )
        db.execute("UPDATE game_players SET house_level = 0 WHERE house_level != 0")
        # Har bino turining qavat chegarasi (game.BUILDINGS dagi "max" bilan bir xil)
        for kind, top in {"uy": 25, "magazin": 40, "kafe": 60, "ofis": 100}.items():
            db.execute("UPDATE game_plots SET level = ? WHERE kind = ? AND level > ?", (top, kind, top))
        # Eski mashinalar (Jajji, Shamol, Chaqmoq, Bo'ron) -> yangilari (BMW, Mercedes, Lamborghini)
        old_cars = {"jajji": "bmw", "shamol": "mercedes", "chaqmoq": "lambo", "boron": "lambo"}
        known = {"bmw", "mercedes", "lambo", "tesla", "jiguli", "damas", "range", "porsche", "bugatti", "plane", "bus", "bike", "skate"}
        for key, cars_json in db.execute("SELECT player_key, cars FROM game_players").fetchall():
            cars = json.loads(cars_json or "[]")
            new = []
            for car in cars:
                car = old_cars.get(car, car)
                if (car in known or car.startswith("c_")) and car not in new:  # c_ — ovoz bilan qo'shilgan
                    new.append(car)
            if new != cars:
                db.execute("UPDATE game_players SET cars = ? WHERE player_key = ?", (json.dumps(new), key))
        db.commit()
    finally:
        db.close()


def get_db() -> sqlite3.Connection:
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH, timeout=10)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


def close_db(_exc=None) -> None:
    db = g.pop("db", None)
    if db is not None:
        db.close()


# --------------------------------------------------------------------------- #
#  Sessiya / huquqlar
# --------------------------------------------------------------------------- #
def current_user() -> dict | None:
    """Hozir kirgan odam: {'role': 'owner' | 'user', 'name', 'login', 'avatar', 'key'} yoki None."""
    role = session.get("role")
    user = None

    if role == "owner" and session.get("login") == config.OWNER_LOGIN:
        user = {"role": "owner", "name": config.OWNER_NAME, "login": config.OWNER_LOGIN,
                "avatar": avatar_url(get_setting("owner_avatar")), "key": "owner"}
    elif role == "user":
        row = get_db().execute(
            "SELECT id, name, login, avatar, session_version FROM users WHERE id = ?", (session.get("uid"),)
        ).fetchone()
        # Owner o'chirib yuborgan yoki parol/login almashgan bo'lsa — sessiya bekor bo'ladi
        if row and session.get("sv", 0) == row["session_version"]:
            user = {"role": "user", "id": row["id"], "name": row["name"], "login": row["login"],
                    "avatar": avatar_url(row["avatar"]), "key": f"u{row['id']}"}

    if user is None and role:
        session.clear()
    return user


def bump_session_version(user_id: int) -> int:
    """Foydalanuvchining hamma qurilmadagi sessiyalarini bekor qiladi (parol/login almashganda)."""
    db = get_db()
    db.execute("UPDATE users SET session_version = session_version + 1 WHERE id = ?", (user_id,))
    row = db.execute("SELECT session_version FROM users WHERE id = ?", (user_id,)).fetchone()
    return row["session_version"] if row else 0


def login_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        if not current_user():
            return jsonify(error="Avval tizimga kiring"), 401
        return view(*args, **kwargs)

    return wrapper


def owner_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        user = current_user()
        if not user:
            return jsonify(error="Avval tizimga kiring"), 401
        if user["role"] != "owner":
            return jsonify(error="Bu amal faqat owner uchun"), 403
        return view(*args, **kwargs)

    return wrapper


def text_field(data: dict, key: str) -> str:
    value = data.get(key, "")
    return value.strip() if isinstance(value, str) else ""
