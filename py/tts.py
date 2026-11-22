"""Uy vazifa natijasini ovoz chiqarib o'qib berish (ElevenLabs).

Kalit owner tomonidan panelda (Sozlamalar) yoki .env da (ELEVENLABS_API_KEY=...) qo'yiladi va hech qachon
brauzerga qaytarilmaydi. Har bir natija bir marta o'qiladi va saqlanadi — qayta tinglash bepul.
"""
import base64
import hashlib
import json
import os
import re
import urllib.error
import urllib.request

from flask import Blueprint, jsonify, request, send_file

import config
import homework
import learn
from core import UPLOAD_DIR, current_user, get_db, get_setting, login_required, owner_required, set_setting

bp = Blueprint("tts", __name__)

API = "https://api.elevenlabs.io"
MODELS = ["eleven_v4", "eleven_v3"]          # ikkalasi ham o'zbekchani (uz) biladi; birinchisi ishlamasa — ikkinchisi
DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb"
MAX_TEXT = 2500                               # bitta natija uchun eng ko'p belgi
MAX_AUDIO = 8 * 1024 * 1024
PER_DAY = 6                                   # o'quvchi kuniga nechta yangi natijani o'qitadi (qayta tinglash cheksiz)
_busy: set = set()


class TTSError(Exception):
    pass


def _key() -> str:
    return os.environ.get("ELEVENLABS_API_KEY", "").strip() or get_setting("el_key") or ""


def enabled() -> bool:
    return bool(_key())


def _voice() -> str:
    return get_setting("el_voice") or DEFAULT_VOICE


# --------------------------------------------------------------------------- #
#  Matn: kodli izohni quloqqa tushunarli qilish
# --------------------------------------------------------------------------- #
ORDINALS = ["Birinchi", "Ikkinchi", "Uchinchi", "To'rtinchi", "Beshinchi", "Oltinchi", "Yettinchi", "Sakkizinchi", "To'qqizinchi", "O'ninchi"]
UNITS = {"px": "piksel", "%": "foiz", "em": "em", "rem": "rem", "vh": "vi ech", "vw": "vi dabl yu"}


def speakable(text: str) -> str:
    """«<p>» -> «p tegi», «margin-left: 999px» -> «margin left, 999 piksel»."""
    s = str(text or "").replace("ʻ", "'").replace("‘", "'").replace("’", "'").replace("`", "'").replace("ʼ", "'")
    s = re.sub(r"['\"]([a-z-]+)\s*:\s*([^'\";]+);?['\"]", r" \1 \2 ", s)               # 'display: flex'
    s = re.sub(r"\(?\bline\s+(\d+)\)?", r" \1 qator", s, flags=re.I)
    s = re.sub(r"(^|[\s('\"])\.([a-zA-Z][\w-]*)(?=[\s,;.)'\"]|$)", r"\1\2 klassi", s)           # .img-left
    s = re.sub(r"(^|[\s(])#([a-zA-Z][\w-]*)(\s+id(si)?\b)?", r"\1\2 id", s)             # #menu
    s = re.sub(r"</\s*([a-zA-Z][\w-]*)\s*>", r" yopuvchi \1 tegi ", s)
    s = re.sub(r"<\s*([a-zA-Z][\w-]*)[^<>]*>", r" \1 tegi ", s)
    s = re.sub(r"\b(yopuvchi|yopiluvchi)\s+yopuvchi\b", r"\1", s)
    s = re.sub(r"\btegi\s*['\"]?\s+teg(i|lari|lar|ini|idan|ida)?\b", lambda m: "teg" + (m.group(1) or "i"), s)
    s = re.sub(r"(\d+)\s*[–—-]\s*(qator|satr)", r"\1 \2", s)
    s = re.sub(r"(\d+(?:\.\d+)?)\s*(px|%|rem|em|vh|vw)(?![a-zA-Z])", lambda m: f"{m.group(1)} {UNITS[m.group(2)]}", s)
    # xossa: qiymat; -> vergul bilan; fayl nomlari
    s = re.sub(r"([a-z])-([a-z])", r"\1 \2", s)
    s = re.sub(r"\b([\w-]+)\.(html|css|js|png|jpg|svg)\b", r"\1 nuqta \2", s)
    s = re.sub(r"([a-z])\s*:\s*(?=\S)", r"\1, ", s)
    s = re.sub(r"=\s*[\"']+", " ", s)
    # so'z chetidagi qo'shtirnoqlar (o', g' ichidagilari qoladi)
    s = re.sub(r"(?<!\w)['\"«»]+|[\"«»]+|(?<![oOgG])'+(?!\w)", " ", s)
    s = re.sub(r"[;{}*_|\\<>]+", ", ", s)
    s = re.sub(r"\s+([,.!?])", r"\1", s)
    s = re.sub(r",(\s*,)+", ",", s)
    s = re.sub(r",\s*([.!?])", r"\1", s)
    return " ".join(s.split()).strip(" ,")


def result_text(sub) -> str:
    score, top = sub["score"], config.HOMEWORK_MAX_SCORE
    parts = [f"Uy vazifangiz tekshirildi. Baho: {top} balldan {score} ball." if score >= 0 else f"Uy vazifangiz tekshirildi. Baho: minus {abs(score)} ball."]
    if sub["feedback"]:
        parts.append(speakable(sub["feedback"]))
    mistakes = [m for m in json.loads(sub["mistakes"] or "[]") if str(m).strip()]
    if mistakes:
        parts.append(f"Endi xatolarni ko'ramiz. Jami {len(mistakes)} ta.")
        for i, m in enumerate(mistakes[:10]):
            parts.append(f"{ORDINALS[i]} xato. {speakable(m)}")
        parts.append("Shu xatolarni tuzating, albatta uddalaysiz!")
    elif sub["status"] == "checked" and score > 0:
        parts.append("Xato topilmadi. Juda yaxshi!")
    out = ""
    for p in parts:
        p = p.strip()
        if p and p[-1] not in ".!?":
            p += "."
        if len(out) + len(p) + 1 > MAX_TEXT:
            break
        out += ("\n" if out else "") + p
    return out


# --------------------------------------------------------------------------- #
#  ElevenLabs
# --------------------------------------------------------------------------- #
def _http(method: str, path: str, key: str, body: dict | None = None, timeout: float = 45):
    """-> (status, bytes). Tarmoq xatosida status 0."""
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"xi-api-key": key, "Content-Type": "application/json", "Accept": "*/*"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, res.read(MAX_AUDIO + 1)
    except urllib.error.HTTPError as err:
        return err.code, err.read(4000)
    except (OSError, ValueError):
        return 0, b""


def _reason(raw: bytes) -> str:
    try:
        d = json.loads(raw).get("detail")
    except (ValueError, AttributeError):
        return ""
    if isinstance(d, dict):
        return f"{d.get('status') or d.get('code') or ''} {d.get('message') or ''}".strip()
    return d if isinstance(d, str) else ""


def synth(text: str, key: str, voice: str) -> tuple[bytes, str]:
    """Matnni ovozga aylantiradi -> (mp3, model). Muammo bo'lsa TTSError (kalitsiz, tushunarli matn)."""
    models = list(MODELS)
    last = get_setting("el_model")
    if last in models:
        models.remove(last)
        models.insert(0, last)
    why = ""
    for model in models:
        for lang in ("uz", None):
            body = {"text": text, "model_id": model}
            if lang:
                body["language_code"] = lang
            code, raw = _http("POST", f"/v1/text-to-speech/{voice}?output_format=mp3_44100_64", key, body)
            if code == 200 and raw:
                if len(raw) > MAX_AUDIO:
                    raise TTSError("Ovoz juda katta chiqdi")
                if last != model:
                    set_setting("el_model", model)
                return raw, model
            why = _reason(raw)
            low = why.lower()
            if code == 0:
                raise TTSError("ElevenLabs bilan aloqa yo'q — birozdan keyin urinib ko'ring")
            if code == 402 or "quota" in low or "credit" in low:
                raise TTSError("Ovoz limiti tugagan (ElevenLabs hisobida kredit qolmagan yoki bu ovoz pullik)")
            if code == 429:
                raise TTSError("ElevenLabs hozir band — bir daqiqadan keyin urinib ko'ring")
            if code == 401 or "missing_permissions" in low or "permission" in low:
                raise TTSError("ElevenLabs kaliti noto'g'ri yoki unga «Text to Speech» ruxsati berilmagan")
            if "voice" in low and code in (400, 403, 404):
                raise TTSError("Bu ovozni ishlatib bo'lmaydi — Sozlamalarda boshqa ovoz tanlang")
            if code >= 500:
                break
            if "language" not in low:
                break      # til sabab emas — keyingi model
    raise TTSError("ElevenLabs ovoz yaratmadi" + (f" ({why[:120]})" if why and current_user() and current_user()["role"] == "owner" else ""))


# --------------------------------------------------------------------------- #
#  Natijani tinglash
# --------------------------------------------------------------------------- #
def _dir():
    return UPLOAD_DIR / "tts"


def _file(sub_id: int, text: str):
    mark = hashlib.sha1(f"{_voice()}|{text}".encode()).hexdigest()[:16]
    return _dir() / f"{sub_id}-{mark}.mp3"


def drop(sub_ids, keep=None) -> None:
    for i in sub_ids:
        for f in _dir().glob(f"{int(i)}-*.mp3"):
            if f != keep:
                try:
                    f.unlink(missing_ok=True)
                except OSError:
                    pass


def _allowed(sub_id: int):
    user = current_user()
    sub = homework.load_submission(sub_id)
    if sub is None or (user["role"] != "owner" and sub["user_id"] != user.get("id")):
        return None, None
    return user, sub


@bp.post("/api/submissions/<int:sub_id>/speech")
@login_required
def api_speech(sub_id: int):
    user, sub = _allowed(sub_id)
    if sub is None:
        return jsonify(error="Topilmadi"), 404
    if sub["status"] != "checked" or not (sub["feedback"] or sub["mistakes"]):
        return jsonify(error="Hali o'qib beradigan izoh yo'q"), 400
    text = result_text(sub)
    if not enabled():
        return jsonify(url=None, text=text)     # brauzerning o'z o'zbekcha ovozi bo'lsa — shu o'qiydi
    path = _file(sub_id, text)
    url = f"/api/submissions/{sub_id}/speech?v={path.stem.split('-')[1]}"
    if path.is_file():
        return jsonify(url=url)
    db = get_db()
    if user["role"] != "owner" and learn._count_today(db, user["key"], "tts") >= PER_DAY:
        return jsonify(error=f"Bugun {PER_DAY} ta natija o'qildi — ertaga yana. Oldingilarini qayta tinglash mumkin."), 429
    if sub_id in _busy:
        return jsonify(error="Ovoz tayyorlanyapti, kuting…"), 429
    _busy.add(sub_id)
    try:
        audio, _ = synth(text, _key(), _voice())
    except TTSError as err:
        return jsonify(error=str(err)), 503
    finally:
        _busy.discard(sub_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(audio)
    tmp.replace(path)
    drop([sub_id], keep=path)
    if user["role"] != "owner":
        learn._bump_today(db, user["key"], "tts")
        db.commit()
    return jsonify(url=url)


@bp.get("/api/submissions/<int:sub_id>/speech")
@login_required
def api_speech_file(sub_id: int):
    _, sub = _allowed(sub_id)
    mark = request.args.get("v", "")
    if sub is None or not re.fullmatch(r"[0-9a-f]{16}", mark):
        return jsonify(error="Topilmadi"), 404
    path = _dir() / f"{sub_id}-{mark}.mp3"
    if not path.is_file():
        return jsonify(error="Topilmadi"), 404
    res = send_file(path, mimetype="audio/mpeg", conditional=True, max_age=0)
    res.headers["Cache-Control"] = "private, max-age=86400"
    return res


# --------------------------------------------------------------------------- #
#  Owner sozlamasi
# --------------------------------------------------------------------------- #
def _state(extra: bool = False) -> dict:
    out = {"connected": enabled(), "env": bool(os.environ.get("ELEVENLABS_API_KEY", "").strip()), "voice": _voice(), "voices": [], "usage": None, "per_day": PER_DAY}
    if extra and enabled():
        code, raw = _http("GET", "/v2/voices?page_size=60", _key(), timeout=10)
        if code == 200:
            try:
                out["voices"] = [{"id": v["voice_id"], "name": str(v.get("name") or "")[:60]} for v in json.loads(raw).get("voices", []) if isinstance(v, dict) and v.get("voice_id")]
            except (ValueError, AttributeError):
                pass
        code, raw = _http("GET", "/v1/user/subscription", _key(), timeout=10)
        if code == 200:
            try:
                d = json.loads(raw)
                out["usage"] = {"used": int(d["character_count"]), "limit": int(d["character_limit"])}
            except (ValueError, KeyError, TypeError):
                pass
    return out


@bp.get("/api/tts")
@owner_required
def api_tts():
    return jsonify(_state(True))


@bp.post("/api/tts")
@owner_required
def api_tts_save():
    """Kalit va/yoki ovoz. Yangi kalit qisqa gap bilan sinab ko'riladi — ishlasa saqlanadi."""
    data = request.get_json(silent=True)
    data = data if isinstance(data, dict) else {}
    key, voice = str(data.get("key") or "").strip(), str(data.get("voice") or "").strip()
    if key and not re.fullmatch(r"[A-Za-z0-9_-]{20,120}", key):
        return jsonify(error="Kalit noto'g'ri. ElevenLabs → API Keys dan to'liq nusxa oling"), 400
    if voice and not re.fullmatch(r"[A-Za-z0-9]{10,40}", voice):
        return jsonify(error="Ovoz ID si noto'g'ri"), 400
    if not key and not voice:
        return jsonify(error="Kalitni qo'ying"), 400
    use = key or _key()
    if not use:
        return jsonify(error="Avval kalitni qo'ying"), 400
    try:
        audio, model = synth("Salom! Uy vazifangiz natijasini endi men o'qib beraman.", use, voice or _voice())
    except TTSError as err:
        return jsonify(error=str(err)), 400
    if key:
        set_setting("el_key", key)
    if voice:
        set_setting("el_voice", voice)
    return jsonify(**_state(True), model=model, audio="data:audio/mpeg;base64," + base64.b64encode(audio).decode())


@bp.delete("/api/tts")
@owner_required
def api_tts_remove():
    for k in ("el_key", "el_model"):
        set_setting(k, None)
    return jsonify(_state())
