"""Uy vazifa: owner vazifa beradi, foydalanuvchi bajarib fayl qilib yuklaydi, AI tekshirib ball qo'yadi."""
import json
import shutil
from pathlib import Path

from flask import Blueprint, jsonify, request, send_file
from werkzeug.utils import secure_filename

import ai_check
import config
from core import UPLOAD_DIR, avatar_url, current_user, get_db, login_required, now_iso, owner_required, text_field

bp = Blueprint("homework", __name__)

MAX_FILES = 10
MAX_TITLE = 120
MAX_DESCRIPTION = 4000


# --------------------------------------------------------------------------- #
#  Yordamchilar
# --------------------------------------------------------------------------- #
def submission_dir(sub_id: int) -> Path:
    return UPLOAD_DIR / str(sub_id)


def homework_dir(hw_id: int) -> Path:
    """Owner biriktirgan vazifa fayllari."""
    return UPLOAD_DIR / f"hw{hw_id}"


def remove_files(sub_ids) -> None:
    for sub_id in sub_ids:
        shutil.rmtree(submission_dir(sub_id), ignore_errors=True)


def safe_name(original: str, index: int, used: set) -> str:
    ext = Path(original).suffix.lower()
    name = secure_filename(original)
    if not name or not name.lower().endswith(ext):
        name = f"fayl{index + 1}{ext}"
    while name.lower() in used:
        name = f"{index + 1}_{name}"
    used.add(name.lower())
    return name


def read_uploads(field: str = "files"):
    """So'rovdagi fayllarni o'qiydi va tekshiradi -> (fayllar, xato javobi)."""
    uploads = [f for f in request.files.getlist(field) if f and f.filename]
    if len(uploads) > MAX_FILES:
        return None, (jsonify(error=f"Ko'pi bilan {MAX_FILES} ta fayl yuboring (ko'p bo'lsa — zip qiling)"), 400)
    used: set = set()
    files = [(safe_name(f.filename, i, used), f.read()) for i, f in enumerate(uploads)]
    if files:
        try:
            ai_check.build_content(files)  # turi va hajmini oldindan tekshiramiz
        except ai_check.FileError as err:
            return None, (jsonify(error=str(err)), 400)
    return files, None


def save_files(folder: Path, files) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    for name, data in files:
        (folder / name).write_bytes(data)


def homework_json(row) -> dict:
    return {"id": row["id"], "title": row["title"], "description": row["description"],
            "files": json.loads(row["files"] or "[]"), "created_at": row["created_at"]}


def submission_json(row, *, for_owner: bool) -> dict:
    probability = row["ai_probability"]
    data = {
        "id": row["id"],
        "homework_id": row["homework_id"],
        "status": row["status"],
        "score": row["score"],
        "max_score": config.HOMEWORK_MAX_SCORE,
        "ai_flagged": probability is not None and probability >= config.AI_THRESHOLD,
        "ai_reason": row["ai_reason"],
        "feedback": row["feedback"],
        "mistakes": json.loads(row["mistakes"] or "[]"),
        "error": row["error"],
        "graded_by": row["graded_by"],
        "files": json.loads(row["files"]),
        "created_at": row["created_at"],
    }
    if for_owner:
        data.update(ai_probability=probability, user_id=row["user_id"], user_name=row["user_name"],
                    user_avatar=avatar_url(row["user_avatar"]))
    return data


def load_submission(sub_id: int):
    return get_db().execute(
        "SELECT s.*, u.name AS user_name, u.avatar AS user_avatar FROM submissions s JOIN users u ON u.id = s.user_id "
        "WHERE s.id = ?", (sub_id,)
    ).fetchone()


def run_check(sub_id: int) -> None:
    """Topshiriqni AI bilan tekshiradi va natijani bazaga yozadi."""
    db = get_db()
    row = db.execute(
        "SELECT s.files, h.id AS hw_id, h.title, h.description, h.files AS hw_files FROM submissions s "
        "JOIN homeworks h ON h.id = s.homework_id WHERE s.id = ?", (sub_id,)
    ).fetchone()
    if row is None:
        return

    if not ai_check.ai_enabled():
        db.execute("UPDATE submissions SET status = 'pending', error = NULL WHERE id = ?", (sub_id,))
        db.commit()
        return

    db.execute("UPDATE submissions SET status = 'checking', error = NULL WHERE id = ?", (sub_id,))
    db.commit()  # AI bilan gaplashayotganda bazani band qilmaymiz

    files = [(name, (submission_dir(sub_id) / name).read_bytes()) for name in json.loads(row["files"])]
    task_files = [(name, (homework_dir(row["hw_id"]) / name).read_bytes())
                  for name in json.loads(row["hw_files"] or "[]")
                  if (homework_dir(row["hw_id"]) / name).is_file()]
    try:
        grade = ai_check.check(row["title"], row["description"], files, task_files)
    except (ai_check.AICheckError, ai_check.FileError) as err:
        db.execute("UPDATE submissions SET status = 'error', error = ? WHERE id = ?", (str(err), sub_id))
        db.commit()
        return

    db.execute(
        "UPDATE submissions SET status = 'checked', score = ?, ai_probability = ?, ai_reason = ?, "
        "feedback = ?, mistakes = ?, error = NULL, graded_by = 'ai' WHERE id = ?",
        (grade.score, grade.ai_probability, grade.ai_reason, grade.feedback,
         json.dumps(grade.mistakes, ensure_ascii=False), sub_id),
    )
    db.commit()


# --------------------------------------------------------------------------- #
#  Vazifalar
# --------------------------------------------------------------------------- #
@bp.get("/api/homeworks")
@login_required
def list_homeworks():
    user = current_user()
    db = get_db()
    rows = db.execute("SELECT * FROM homeworks ORDER BY id DESC").fetchall()
    result = []

    if user["role"] == "owner":
        counts = {r["homework_id"]: r["n"] for r in db.execute(
            "SELECT homework_id, COUNT(*) AS n FROM submissions GROUP BY homework_id")}
        for row in rows:
            result.append({**homework_json(row), "submission_count": counts.get(row["id"], 0)})
    else:
        mine = {r["homework_id"]: r for r in db.execute(
            "SELECT s.*, '' AS user_name, NULL AS user_avatar FROM submissions s WHERE s.user_id = ?", (user["id"],))}
        for row in rows:
            sub = mine.get(row["id"])
            result.append({**homework_json(row),
                           "submission": submission_json(sub, for_owner=False) if sub else None})

    return jsonify(homeworks=result, ai_enabled=ai_check.ai_enabled(),
                   max_score=config.HOMEWORK_MAX_SCORE, accept=ai_check.ACCEPT)


@bp.post("/api/homeworks")
@owner_required
def create_homework():
    # Fayl bilan (multipart) yoki faqat matn (JSON) bo'lishi mumkin
    data = request.form if request.files or request.form else (request.get_json(silent=True) or {})
    title = text_field(data, "title")
    description = text_field(data, "description")
    if not title:
        return jsonify(error="Vazifa nomini yozing"), 400
    if len(title) > MAX_TITLE or len(description) > MAX_DESCRIPTION:
        return jsonify(error=f"Nomi {MAX_TITLE}, tavsifi {MAX_DESCRIPTION} belgidan oshmasin"), 400
    files, error = read_uploads("files")
    if error:
        return error

    db = get_db()
    cur = db.execute(
        "INSERT INTO homeworks (title, description, files, created_at) VALUES (?, ?, ?, ?)",
        (title, description, json.dumps([name for name, _ in files]), now_iso()),
    )
    hw_id = cur.lastrowid
    if files:
        save_files(homework_dir(hw_id), files)
    db.commit()
    row = db.execute("SELECT * FROM homeworks WHERE id = ?", (hw_id,)).fetchone()
    return jsonify(homework={**homework_json(row), "submission_count": 0}), 201


@bp.get("/api/homeworks/<int:hw_id>/files/<int:index>")
@login_required
def download_task_file(hw_id: int, index: int):
    row = get_db().execute("SELECT files FROM homeworks WHERE id = ?", (hw_id,)).fetchone()
    if row is None:
        return jsonify(error="Topilmadi"), 404
    names = json.loads(row["files"] or "[]")
    if not 0 <= index < len(names) or not (homework_dir(hw_id) / names[index]).is_file():
        return jsonify(error="Fayl topilmadi"), 404
    return send_file(homework_dir(hw_id) / names[index], as_attachment=True, download_name=names[index])


@bp.delete("/api/homeworks/<int:hw_id>")
@owner_required
def delete_homework(hw_id: int):
    db = get_db()
    sub_ids = [r["id"] for r in db.execute("SELECT id FROM submissions WHERE homework_id = ?", (hw_id,))]
    cur = db.execute("DELETE FROM homeworks WHERE id = ?", (hw_id,))
    db.commit()
    if cur.rowcount == 0:
        return jsonify(error="Vazifa topilmadi"), 404
    remove_files(sub_ids)
    shutil.rmtree(homework_dir(hw_id), ignore_errors=True)
    return jsonify(ok=True)


# --------------------------------------------------------------------------- #
#  Topshiriqlar
# --------------------------------------------------------------------------- #
@bp.get("/api/homeworks/<int:hw_id>/submissions")
@owner_required
def list_submissions(hw_id: int):
    rows = get_db().execute(
        "SELECT s.*, u.name AS user_name, u.avatar AS user_avatar FROM submissions s JOIN users u ON u.id = s.user_id "
        "WHERE s.homework_id = ? ORDER BY s.id DESC", (hw_id,)
    ).fetchall()
    return jsonify(submissions=[submission_json(r, for_owner=True) for r in rows])


@bp.post("/api/homeworks/<int:hw_id>/submit")
@login_required
def submit(hw_id: int):
    user = current_user()
    if user["role"] != "user":
        return jsonify(error="Uy vazifani foydalanuvchilar topshiradi"), 403

    db = get_db()
    if db.execute("SELECT 1 FROM homeworks WHERE id = ?", (hw_id,)).fetchone() is None:
        return jsonify(error="Vazifa topilmadi"), 404

    existing = db.execute(
        "SELECT id, status FROM submissions WHERE homework_id = ? AND user_id = ?", (hw_id, user["id"])
    ).fetchone()
    if existing and existing["status"] != "error":
        return jsonify(error="Siz bu vazifani allaqachon topshirgansiz"), 409

    files, error = read_uploads("files")
    if error:
        return error
    if not files:
        return jsonify(error="Fayl tanlang"), 400

    if existing:  # avvalgi yuborishda xato bo'lgan — qaytadan
        db.execute("DELETE FROM submissions WHERE id = ?", (existing["id"],))
        remove_files([existing["id"]])

    cur = db.execute(
        "INSERT INTO submissions (homework_id, user_id, files, status, created_at) "
        "VALUES (?, ?, ?, 'checking', ?)",
        (hw_id, user["id"], json.dumps([name for name, _ in files]), now_iso()),
    )
    sub_id = cur.lastrowid
    save_files(submission_dir(sub_id), files)
    db.commit()

    run_check(sub_id)
    return jsonify(submission=submission_json(load_submission(sub_id), for_owner=False)), 201


@bp.get("/api/submissions/<int:sub_id>/files/<int:index>")
@login_required
def download_file(sub_id: int, index: int):
    user = current_user()
    row = load_submission(sub_id)
    if row is None:
        return jsonify(error="Topilmadi"), 404
    if user["role"] != "owner" and row["user_id"] != user.get("id"):
        return jsonify(error="Ruxsat yo'q"), 403
    names = json.loads(row["files"])
    if not 0 <= index < len(names):
        return jsonify(error="Fayl topilmadi"), 404
    path = submission_dir(sub_id) / names[index]
    if not path.is_file():
        return jsonify(error="Fayl topilmadi"), 404
    # Har doim yuklab olish sifatida — HTML fayl saytning o'zida ochilib ketmasligi uchun
    return send_file(path, as_attachment=True, download_name=names[index])


@bp.post("/api/submissions/<int:sub_id>/grade")
@owner_required
def grade_submission(sub_id: int):
    data = request.get_json(silent=True) or {}
    score = data.get("score")
    if isinstance(score, bool) or not isinstance(score, int) or not 0 <= score <= config.HOMEWORK_MAX_SCORE:
        return jsonify(error=f"Ball 0 dan {config.HOMEWORK_MAX_SCORE} gacha bo'lsin"), 400

    db = get_db()
    cur = db.execute(
        "UPDATE submissions SET score = ?, status = 'checked', graded_by = 'owner', error = NULL "
        "WHERE id = ?", (score, sub_id),
    )
    db.commit()
    if cur.rowcount == 0:
        return jsonify(error="Topilmadi"), 404
    return jsonify(submission=submission_json(load_submission(sub_id), for_owner=True))


@bp.post("/api/submissions/<int:sub_id>/recheck")
@owner_required
def recheck_submission(sub_id: int):
    if load_submission(sub_id) is None:
        return jsonify(error="Topilmadi"), 404
    if not ai_check.ai_enabled():
        return jsonify(error="AI kaliti qo'yilmagan (.env faylida GEMINI_API_KEY=...)"), 400
    run_check(sub_id)
    return jsonify(submission=submission_json(load_submission(sub_id), for_owner=True))


@bp.delete("/api/submissions/<int:sub_id>")
@owner_required
def delete_submission(sub_id: int):
    db = get_db()
    cur = db.execute("DELETE FROM submissions WHERE id = ?", (sub_id,))
    db.commit()
    if cur.rowcount == 0:
        return jsonify(error="Topilmadi"), 404
    remove_files([sub_id])
    return jsonify(ok=True)
