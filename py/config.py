"""Sozlamalar. Maxfiy narsalar (API kalit) loyiha papkasidagi .env faylida turadi."""
import os
from pathlib import Path

ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


def _load_env(path: Path) -> None:
    """.env faylidagi KALIT=qiymat qatorlarini o'qiydi (qo'shimcha kutubxonasiz)."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip('"').strip("'")
        if value:  # bo'sh qiymat tizimdagi o'zgaruvchini o'chirib yubormasin
            os.environ[key.strip()] = value


_load_env(ENV_FILE)

# Owner (sayt egasi) ma'lumotlari .env faylida turadi (GitHub'ga yuklanmaydi):
#   OWNER_LOGIN=...   OWNER_PASSWORD=...   OWNER_NAME=...
# Kirish sahifasida "Owner" bo'limini tanlab, shu login va parol bilan kiriladi.
OWNER_LOGIN = os.environ.get("OWNER_LOGIN", "")
OWNER_PASSWORD = os.environ.get("OWNER_PASSWORD", "")
OWNER_NAME = os.environ.get("OWNER_NAME", "Owner")

# Server sozlamalari
HOST = "127.0.0.1"
PORT = 5000

# --------------------------------------------------------------------------
#  AI (Google Gemini) — uy vazifalarni tekshiradi
# --------------------------------------------------------------------------
# API kalit .env faylidan olinadi:  GEMINI_API_KEY=...
# Kalit bo'lmasa ham sayt ishlaydi — topshiriqlarni owner o'zi baholaydi.
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")

AI_MODEL = "gemini-3.8-flash"
# Asosiy model band (503) yoki topilmasa — navbat bilan shular sinaladi
AI_FALLBACK_MODELS = ["gemini-3.7-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]
AI_THINKING = "low"        # qanchalik chuqur o'ylaydi: minimal | low | medium | high (past = tezroq)
AI_THRESHOLD = 70          # "AI yasagan" ehtimoli shu foizdan yuqori bo'lsa — jarima
AI_PENALTY = 10            # AI ishlatgan o'quvchidan shuncha ball ayiriladi (ball = -10)
HOMEWORK_MAX_SCORE = 5     # bitta uy vazifa uchun eng ko'p ball
HOMEWORK_MIN_SCORE = -10   # vazifaga aloqasiz ish (tasodifiy rasm va h.k.) yoki AI — eng past ball
