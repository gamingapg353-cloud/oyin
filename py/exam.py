"""Panel testlari.

Owner test tuzadi: mavzu (nomi), bo'limlar (HTML / CSS / JS), savollar bazasidan tanlaydi
yoki o'zi yozadi — jami 5 ta savol. "Testni boshlash" bosilgach, foydalanuvchilarda
"Test boshlandi" xabari chiqadi. Har kim testni bir marta yechadi: nechta to'g'ri
javob bersa, shuncha ball reytingga qo'shiladi. Har javob darhol tekshiriladi va saqlanadi —
uni o'zgartirib bo'lmaydi, to'g'ri javob faqat javob berilgandan keyin ko'rsatiladi.
"""
import json
import random
import time

from flask import Blueprint, jsonify, request

import quiz
from core import current_user, get_db, login_required, owner_required

bp = Blueprint("exam", __name__)

EXAM_SIZE = 5
TOPICS = ("HTML", "CSS", "JS")
TITLE_MAX = 80
Q_MAX = 300
OPT_MAX = 150


def _active(db):
    return db.execute("SELECT * FROM exams WHERE active = 1 ORDER BY id DESC LIMIT 1").fetchone()


def _public(exam) -> dict:
    """Testning ochiq ma'lumoti (savollarsiz)."""
    return {"id": exam["id"], "title": exam["title"], "topics": json.loads(exam["topics"]),
            "count": len(json.loads(exam["questions"])), "created_at": exam["created_at"],
            "active": bool(exam["active"])}


def _results(db, exam_id: int) -> list:
    rows = db.execute(
        "SELECT a.*, u.name FROM exam_attempts a JOIN users u ON u.id = a.user_id "
        "WHERE a.exam_id = ? ORDER BY a.score IS NULL, a.score DESC, a.finished_at", (exam_id,),
    ).fetchall()
    return [{"name": r["name"], "score": r["score"], "finished": r["finished_at"] is not None} for r in rows]


def _review(questions: list, answers: list) -> list:
    return [{"topic": q["topic"], "question": q["question"], "options": q["options"],
             "correct": q["correct"], "chosen": answers[i] if i < len(answers) else None, "explain": q.get("explain", "")}
            for i, q in enumerate(questions)]


@bp.get("/api/exams/bank")
@owner_required
def api_bank():
    """Savollar bazasi (owner tanlashi uchun; to'g'ri javob — birinchi variant)."""
    return jsonify(questions=[
        {"qid": i, "topic": q["topic"], "question": q["q"], "answer": q["options"][0]}
        for i, q in enumerate(quiz.QUESTIONS)
    ], size=EXAM_SIZE, topics=TOPICS)


@bp.get("/api/exams/active")
@login_required
def api_active():
    user = current_user()
    db = get_db()
    exam = _active(db)
    if exam is None:
        return jsonify(exam=None)
    data = {"exam": _public(exam)}
    if user["role"] == "owner":
        data["results"] = _results(db, exam["id"])
    else:
        a = db.execute("SELECT * FROM exam_attempts WHERE exam_id = ? AND user_id = ?",
                       (exam["id"], user["id"])).fetchone()
        if a is None:
            data["attempt"] = {"status": "none"}
        elif a["finished_at"] is None:
            data["attempt"] = {"status": "started"}
        else:
            data["attempt"] = {"status": "finished", "score": a["score"],
                               "review": _review(json.loads(exam["questions"]), json.loads(a["answers"] or "[]"))}
    return jsonify(data)


@bp.post("/api/exams")
@owner_required
def api_create():
    """Yangi test: bank (savol raqamlari) + o'zi yozgan savollar = 5 ta. Oldingi test yakunlanadi."""
    data = request.get_json(silent=True) or {}
    title = " ".join(str(data.get("title") or "").split())[:TITLE_MAX]
    if not title:
        return jsonify(error="Test mavzusini yozing (masalan: HTML teglar)"), 400
    topics = [t for t in TOPICS if t in (data.get("topics") or [])]
    bank = data.get("bank") or []
    custom = data.get("custom") or []
    if not isinstance(bank, list) or not isinstance(custom, list):
        return jsonify(error="Noto'g'ri savollar"), 400
    questions = []
    rng = random.Random()
    for qid in bank:
        if isinstance(qid, bool) or not isinstance(qid, int) or not 0 <= qid < len(quiz.QUESTIONS):
            return jsonify(error="Bunday savol yo'q"), 400
        if qid in [q.get("qid") for q in questions]:
            return jsonify(error="Bitta savol ikki marta tanlangan"), 400
        item = quiz.shuffled(qid, rng)
        questions.append({"qid": qid, "topic": item["topic"], "question": item["question"],
                          "options": item["options"], "correct": item["correct"], "explain": item["explain"]})
    for c in custom:
        if not isinstance(c, dict):
            return jsonify(error="Noto'g'ri savol"), 400
        text = " ".join(str(c.get("question") or "").split())[:Q_MAX]
        options = [" ".join(str(o or "").split())[:OPT_MAX] for o in (c.get("options") or [])]
        correct = c.get("correct")
        if not text:
            return jsonify(error="O'zingiz yozgan savolning matni bo'sh"), 400
        if len(options) != 4 or not all(options):
            return jsonify(error=f"«{text[:40]}» savolida 4 ta javob varianti bo'lishi kerak"), 400
        if len(set(options)) != 4:
            return jsonify(error=f"«{text[:40]}» savolida bir xil variantlar bor"), 400
        if isinstance(correct, bool) or not isinstance(correct, int) or not 0 <= correct < 4:
            return jsonify(error=f"«{text[:40]}» savolida to'g'ri javobni belgilang"), 400
        topic = c.get("topic") if c.get("topic") in TOPICS else (topics[0] if topics else "HTML")
        questions.append({"qid": None, "topic": topic, "question": text, "options": options, "correct": correct,
                          "explain": " ".join(str(c.get("explain") or "").split())[:Q_MAX]})
    if len(questions) != EXAM_SIZE:
        return jsonify(error=f"Testda {EXAM_SIZE} ta savol bo'lishi kerak (hozir {len(questions)} ta)"), 400
    if not topics:
        topics = sorted({q["topic"] for q in questions}, key=TOPICS.index)
    db = get_db()
    now = time.time()
    db.execute("UPDATE exams SET active = 0, ended_at = ? WHERE active = 1", (now,))
    cur = db.execute("INSERT INTO exams (title, topics, questions, created_at) VALUES (?, ?, ?, ?)",
                     (title, json.dumps(topics), json.dumps(questions, ensure_ascii=False), now))
    db.commit()
    exam = db.execute("SELECT * FROM exams WHERE id = ?", (cur.lastrowid,)).fetchone()
    import classroom
    classroom.notify_all_users(f"📝 Test boshlandi: «{title}». Kiring!", "/panel#exam")
    return jsonify(exam=_public(exam), results=[]), 201


@bp.post("/api/exams/<int:exam_id>/end")
@owner_required
def api_end(exam_id: int):
    db = get_db()
    cur = db.execute("UPDATE exams SET active = 0, ended_at = ? WHERE id = ? AND active = 1", (time.time(), exam_id))
    db.commit()
    if cur.rowcount == 0:
        return jsonify(error="Bu test allaqachon tugagan"), 400
    return jsonify(ok=True, results=_results(db, exam_id))


def _user_exam(exam_id: int):
    user = current_user()
    if user["role"] != "user":
        return None, None, (jsonify(error="Testni foydalanuvchilar yechadi"), 403)
    db = get_db()
    exam = db.execute("SELECT * FROM exams WHERE id = ?", (exam_id,)).fetchone()
    if exam is None or not exam["active"]:
        return None, None, (jsonify(error="Bu test tugagan"), 400)
    return user, exam, None


@bp.post("/api/exams/<int:exam_id>/begin")
@login_required
def api_begin(exam_id: int):
    """Testni boshlash: savollar (to'g'ri javobsiz)."""
    user, exam, err = _user_exam(exam_id)
    if err:
        return err
    db = get_db()
    a = db.execute("SELECT * FROM exam_attempts WHERE exam_id = ? AND user_id = ?", (exam_id, user["id"])).fetchone()
    if a is not None and a["finished_at"] is not None:
        return jsonify(error="Siz bu testni allaqachon yechgansiz"), 400
    if a is None:
        db.execute("INSERT INTO exam_attempts (exam_id, user_id, started_at) VALUES (?, ?, ?)",
                   (exam_id, user["id"], time.time()))
        db.commit()
    questions = json.loads(exam["questions"])
    answers = json.loads(a["answers"] or "[]") if a is not None else []
    return jsonify(exam=_public(exam), questions=[
        {"topic": q["topic"], "question": q["question"], "options": q["options"]} for q in questions],
        done=[_checked(questions[i], ans) for i, ans in enumerate(answers)])  # sahifa yangilansa — davom etadi


def _checked(q: dict, answer: int) -> dict:
    return {"answer": answer, "correct": answer == q["correct"], "right": q["correct"]}


@bp.post("/api/exams/<int:exam_id>/answer")
@login_required
def api_answer(exam_id: int):
    """Bitta savolga javob: darhol to'g'ri/xato aytiladi va saqlanadi (o'zgartirib bo'lmaydi).
    Oxirgi savoldan keyin test yakunlanadi: nechta to'g'ri bo'lsa, shuncha ball reytingga qo'shiladi."""
    user, exam, err = _user_exam(exam_id)
    if err:
        return err
    data = request.get_json(silent=True) or {}
    index, answer = data.get("index"), data.get("answer")
    if isinstance(answer, bool) or not isinstance(answer, int) or not 0 <= answer < 4:
        return jsonify(error="Javobni tanlang"), 400
    questions = json.loads(exam["questions"])
    db = get_db()
    a = db.execute("SELECT * FROM exam_attempts WHERE exam_id = ? AND user_id = ?", (exam_id, user["id"])).fetchone()
    if a is None:
        return jsonify(error="Avval testni boshlang"), 400
    if a["finished_at"] is not None:
        return jsonify(error="Siz bu testni allaqachon yechgansiz"), 400
    answers = json.loads(a["answers"] or "[]")
    if index != len(answers):
        return jsonify(error="Bu savolga javob berilgan — keyingisiga o'ting"), 409
    answers.append(answer)
    result = _checked(questions[index], answer)
    import learn
    learn.note(db, user["key"], questions[index], result["correct"])  # xato bo'lsa — xatolar daftariga
    if len(answers) < len(questions):
        db.execute("UPDATE exam_attempts SET answers = ? WHERE exam_id = ? AND user_id = ?",
                   (json.dumps(answers), exam_id, user["id"]))
        db.commit()
        return jsonify(result)
    score = sum(1 for i, q in enumerate(questions) if answers[i] == q["correct"])
    cur = db.execute("UPDATE exam_attempts SET finished_at = ?, answers = ?, score = ? "
                     "WHERE exam_id = ? AND user_id = ? AND finished_at IS NULL",
                     (time.time(), json.dumps(answers), score, exam_id, user["id"]))
    if cur.rowcount:
        db.execute("UPDATE users SET score = score + ? WHERE id = ?", (score, user["id"]))
    db.commit()
    return jsonify(**result, finished=True, score=score, total=len(questions), review=_review(questions, answers))
