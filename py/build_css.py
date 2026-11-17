"""SCSS -> CSS kompilyatsiya (libsass).

Qo'lda ishga tushirish:  python py/build_css.py
Server (py/app.py) ishga tushganda ham avtomatik kompilyatsiya qilinadi.
"""
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
SCSS_FILE = ROOT_DIR / "static" / "scss" / "main.scss"
CSS_FILE = ROOT_DIR / "static" / "css" / "main.css"


def build_css() -> bool:
    try:
        import sass
    except ImportError:
        print("[css] libsass o'rnatilmagan - tayyor static/css/main.css ishlatiladi (pip install libsass)")
        return False

    try:
        css = sass.compile(filename=str(SCSS_FILE), output_style="expanded")
    except sass.CompileError as err:
        print(f"[css] SCSS xatosi:\n{err}")
        return False

    CSS_FILE.parent.mkdir(parents=True, exist_ok=True)
    try:
        if CSS_FILE.exists() and CSS_FILE.read_text(encoding="utf-8") == css:
            return True  # o'zgarmagan — qayta yozmaymiz (Windows faylni band qilib turishi mumkin)
        CSS_FILE.write_text(css, encoding="utf-8")
    except OSError as err:
        # Fayl boshqa dastur (antivirus va h.k.) tomonidan band — server yiqilmasin, tayyor CSS ishlatiladi
        print(f"[css] main.css ni yozib bo'lmadi ({err}) — tayyor static/css/main.css ishlatiladi")
        return False
    print("[css] static/scss/main.scss -> static/css/main.css")
    return True


if __name__ == "__main__":
    build_css()
