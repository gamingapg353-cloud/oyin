"""Kodni AI'siz, darhol tekshirish: HTML, CSS va JS talablarini qoidalar bilan solishtiradi.

Kod dueli (kim birinchi to'g'ri yozadi) va «Xatoni top» mashqlari shu bilan tekshiriladi.
Tekshiruv — ro'yxat: har biri (tur, ..., talab matni). Bajarilmagan talablar matni qaytariladi.
"""
import re
from html.parser import HTMLParser

VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}


class _Parser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.items: list[dict] = []   # {tag, attrs, text, up: [ota teglar]}
        self.stack: list[dict] = []
        self.styles: list[str] = []
        self.scripts: list[str] = []
        self.errors: list[str] = []

    def handle_starttag(self, tag, attrs):
        if len(self.stack) > 60 or len(self.items) > 1000:   # ataylab buzilgan kod serverni sekinlashtirmasin
            return
        node = {"tag": tag, "attrs": {k: (v or "") for k, v in attrs}, "text": "", "up": [n["tag"] for n in self.stack],
                "closed": tag in VOID}
        self.items.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        n = len(self.items)
        self.handle_starttag(tag, attrs)
        if len(self.items) > n and tag not in VOID and self.stack:
            self.stack.pop()["closed"] = True

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i]["tag"] == tag:
                if i != len(self.stack) - 1:
                    self.errors.append(self.stack[-1]["tag"])
                self.stack[i]["closed"] = True
                del self.stack[i:]
                return
        if tag not in VOID:
            self.errors.append(f"/{tag}")

    def handle_data(self, data):
        for node in self.stack:
            node["text"] += data
        if self.stack and self.stack[-1]["tag"] == "style":
            self.styles.append(data)
        elif self.stack and self.stack[-1]["tag"] == "script":
            self.scripts.append(data)


def _css_rules(css: str) -> list[tuple[str, dict]]:
    css = re.sub(r"/\*.*?\*/", " ", css, flags=re.S)
    rules = []
    for sel, body in re.findall(r"([^{}]+)\{([^{}]*)\}", css):
        decls = {}
        for part in body.split(";"):
            if ":" in part:
                k, v = part.split(":", 1)
                decls[k.strip().lower()] = " ".join(v.split()).lower()
        rules.append((" ".join(sel.split()).lower(), decls))
    return rules


def _strip_js(js: str) -> str:
    return re.sub(r"/\*.*?\*/", " ", re.sub(r"(^|[^:'\"])//[^\n]*", r"\1", js), flags=re.S)


class Doc:
    def __init__(self, code: str, css: str = "", js: str = ""):
        self.code = code
        p = _Parser()
        try:
            p.feed(code if code.count("<") <= 500 else "")   # ataylab buzilgan kod
            p.close()
        except Exception:  # buzuq kod — tekshiruv shunchaki o'tmaydi
            pass
        self.items = p.items
        # hech qaysi tegsiz yozilgan sof CSS / JS ham hisobga olinadi
        plain = code if not p.items else ""
        self.rules = _css_rules("\n".join(p.styles) + "\n" + css + ("\n" + plain if "{" in plain else ""))
        inline = [n["attrs"]["style"] for n in p.items if n["attrs"].get("style")]
        self.rules += [(f"<{n['tag']}>", _css_rules(f"x{{{n['attrs']['style']}}}")[0][1]) for n in p.items
                       if n["attrs"].get("style") and _css_rules(f"x{{{n['attrs']['style']}}}")]
        self.inline = inline
        handlers = [v for n in p.items for k, v in n["attrs"].items() if k.startswith("on")]
        self.js = _strip_js("\n".join(p.scripts + handlers) + "\n" + js + "\n" + plain)
        self.open = [n["tag"] for n in p.items if not n["closed"]]
        self.errors = p.errors

    def tags(self, tag: str) -> list[dict]:
        return [n for n in self.items if n["tag"] == tag]

    def css(self, prop: str, value: str, sel: str = "") -> bool:
        for s, decls in self.rules:
            if sel and not re.search(sel, s):
                continue
            for k, v in decls.items():
                if re.fullmatch(prop, k) and re.search(value, v):
                    return True
        return False


def _ok(doc: Doc, rule: tuple) -> bool:
    kind = rule[0]
    if kind == "count":                       # ("count", "li", 3)
        return len(doc.tags(rule[1])) >= rule[2]
    if kind == "in":                          # ("in", "li", "ul", 3): li lar ul ichida
        return sum(1 for n in doc.tags(rule[1]) if rule[2] in n["up"]) >= rule[3]
    if kind == "text":                        # ("text", "h1", regex)
        return any(re.search(rule[2], " ".join(n["text"].split()), re.I) for n in doc.tags(rule[1]))
    if kind == "attr":                        # ("attr", "img", "alt", regex)
        return any(re.search(rule[3], n["attrs"].get(rule[2], ""), re.I) for n in doc.tags(rule[1]))
    if kind == "css":                         # ("css", "display", "^flex$", selektor?)
        return doc.css(rule[1], rule[2], rule[3] if len(rule) > 4 else "")
    if kind == "js":                          # ("js", regex)
        return re.search(rule[1], doc.js, re.S) is not None
    if kind == "nojs":
        return re.search(rule[1], doc.js, re.S) is None
    if kind == "re":                          # butun kod bo'yicha
        return re.search(rule[1], doc.code, re.S | re.I) is not None
    if kind == "nore":
        return re.search(rule[1], doc.code, re.S | re.I) is None
    if kind == "closed":                      # hamma teglar to'g'ri yopilgan
        return not doc.open and not doc.errors
    raise ValueError(kind)


def check(code: str, rules: list, css: str = "", js: str = "") -> list[str]:
    """Bajarilmagan talablar (bo'sh ro'yxat — hammasi to'g'ri)."""
    doc = Doc(code, css, js)
    return [r[-1] for r in rules if not _ok(doc, r)]


_click = ("re", r"addEventListener\(\s*['\"]click['\"]|\.onclick\s*=|onclick\s*=", "Tugmaga click hodisasini qo'shing")

# --------------------------------------------------------------------------- #
#  Kod dueli topshiriqlari
# --------------------------------------------------------------------------- #
DUEL_TASKS = [
    {"id": "d_list", "level": 1, "title": "Mevalar ro'yxati",
     "task": "Nuqtali ro'yxat (ul) yarating va ichiga 4 ta meva (li) yozing.",
     "checks": [("count", "ul", 1, "<ul> ro'yxat kerak"), ("in", "li", "ul", 4, "<ul> ichida 4 ta <li> bo'lsin"), ("closed", "Hamma teglarni yoping")]},
    {"id": "d_card", "level": 1, "title": "Ism kartasi",
     "task": "div ichida h2 (ismingiz) va p (o'zingiz haqingizda) yozing.",
     "checks": [("in", "h2", "div", 1, "<div> ichida <h2> bo'lsin"), ("in", "p", "div", 1, "<div> ichida <p> bo'lsin"),
                ("text", "h2", r"\w{2,}", "<h2> ichiga ism yozing"), ("text", "p", r"\w{3,}", "<p> ichiga matn yozing"), ("closed", "Hamma teglarni yoping")]},
    {"id": "d_link", "level": 1, "title": "Havola va rasm",
     "task": "Rasm (img, alt bilan) qo'ying va uni havola (a, href bilan) ichiga oling.",
     "checks": [("in", "img", "a", 1, "<img> rasm <a> havola ichida bo'lsin"), ("attr", "img", "src", r".+", "Rasmga src yozing"),
                ("attr", "img", "alt", r".+", "Rasmga alt yozing"), ("attr", "a", "href", r".+", "Havolaga href yozing"), ("closed", "Hamma teglarni yoping")]},
    {"id": "d_form", "level": 1, "title": "Kirish formasi",
     "task": "form ichida email uchun input, parol uchun input va button yarating.",
     "checks": [("in", "input", "form", 2, "<form> ichida 2 ta <input> bo'lsin"), ("attr", "input", "type", r"^email$", "type=\"email\" input kerak"),
                ("attr", "input", "type", r"^password$", "type=\"password\" input kerak"), ("in", "button", "form", 1, "<form> ichida <button> bo'lsin"), ("closed", "Hamma teglarni yoping")]},
    {"id": "d_table", "level": 1, "title": "Jadval",
     "task": "Jadval (table) yarating: 3 ta sarlavha katak (th) va kamida 2 qatorda jami 6 ta katak (td).",
     "checks": [("in", "th", "table", 3, "3 ta <th> kerak"), ("in", "td", "table", 6, "6 ta <td> kerak"), ("in", "tr", "table", 3, "Kamida 3 ta <tr> qator kerak"), ("closed", "Hamma teglarni yoping")]},
    {"id": "d_nav", "level": 1, "title": "Menyu",
     "task": "header ichida nav, nav ichida 3 ta havola (a, href bilan) yarating.",
     "checks": [("in", "nav", "header", 1, "<header> ichida <nav> bo'lsin"), ("in", "a", "nav", 3, "<nav> ichida 3 ta <a> bo'lsin"), ("attr", "a", "href", r".+", "Havolalarga href yozing"), ("closed", "Hamma teglarni yoping")]},
    {"id": "d_select", "level": 1, "title": "Tanlash",
     "task": "label va select yarating: label for orqali select id siga bog'lansin, ichida 3 ta option bo'lsin.",
     "checks": [("in", "option", "select", 3, "<select> ichida 3 ta <option>"), ("attr", "label", "for", r".+", "<label> ga for yozing"),
                ("attr", "select", "id", r".+", "<select> ga id yozing"), ("closed", "Hamma teglarni yoping")]},
    {"id": "d_redbtn", "level": 2, "title": "Yumaloq tugma",
     "task": "Tugma yarating: foni qizil, yozuvi oq, burchaklari yumaloq (border-radius), hover bo'lganda rangi o'zgarsin.",
     "checks": [("count", "button", 1, "<button> kerak"), ("css", r"background(-color)?", r"red|#f00|#ff0000|#e|#d|rgb", "Fon qizil bo'lsin (background)"),
                ("css", "color", r"white|#fff|255", "Yozuv oq bo'lsin (color)"), ("css", "border-radius", r"[1-9]", "border-radius yozing"),
                ("css", r"[a-z-]+", r".+", ":hover", ":hover uchun uslub yozing")]},
    {"id": "d_flex", "level": 2, "title": "Flex qator",
     "task": "3 ta div ni flex bilan bir qatorga qo'ying: oralari bir xil (justify-content: space-between), vertikal markazda (align-items: center).",
     "checks": [("count", "div", 4, "1 ta ota div va 3 ta ichki div"), ("css", "display", r"^flex$", "display: flex"),
                ("css", "justify-content", r"space-between", "justify-content: space-between"), ("css", "align-items", r"center", "align-items: center")]},
    {"id": "d_grid", "level": 2, "title": "Grid 3 ustun",
     "task": "Grid yarating: 3 ta teng ustun (grid-template-columns), oralari 16px (gap), ichida 6 ta element.",
     "checks": [("css", "display", r"^grid$", "display: grid"), ("css", "grid-template-columns", r"repeat\(\s*3|1fr\s+1fr\s+1fr", "3 ta teng ustun"),
                ("css", "(grid-)?gap", r"16px", "gap: 16px"), ("count", "div", 7, "1 ta ota va 6 ta ichki div")]},
    {"id": "d_center", "level": 2, "title": "Aniq markaz",
     "task": "Quti (div) ichidagi matnni ham gorizontal, ham vertikal markazga qo'ying (flex yoki grid). Quti balandligi 200px.",
     "checks": [("css", "height", r"200px", "height: 200px"), ("css", "display", r"^(flex|grid)$", "display: flex yoki grid"),
                ("css", "justify-content|place-items|place-content", r"center", "Gorizontal markaz"), ("css", "align-items|place-items|place-content", r"center", "Vertikal markaz")]},
    {"id": "d_avatar", "level": 2, "title": "Dumaloq avatar",
     "task": "img ni dumaloq qiling: eni va bo'yi 120px, border-radius: 50%, object-fit: cover, 3px chegara (border).",
     "checks": [("count", "img", 1, "<img> kerak"), ("css", "width", r"120px", "width: 120px"), ("css", "height", r"120px", "height: 120px"),
                ("css", "border-radius", r"50%", "border-radius: 50%"), ("css", "object-fit", r"cover", "object-fit: cover"), ("css", "border", r"3px", "3px border")]},
    {"id": "d_sticky", "level": 2, "title": "Yopishqoq header",
     "task": "header ni tepaga yopishtiring (position: sticky, top: 0), z-index bering va soya (box-shadow) qo'shing.",
     "checks": [("count", "header", 1, "<header> kerak"), ("css", "position", r"sticky", "position: sticky"), ("css", "top", r"^0", "top: 0"),
                ("css", "z-index", r"\d", "z-index"), ("css", "box-shadow", r"\d", "box-shadow")]},
    {"id": "d_media", "level": 2, "title": "Telefon uchun",
     "task": "@media (max-width: 600px) yozing: shu ekranda .menu yashirinsin (display: none). Sahifada class=\"menu\" element bo'lsin.",
     "checks": [("re", r"@media[^{]*max-width\s*:\s*600px", "@media (max-width: 600px)"), ("re", r"class\s*=\s*[\"'][^\"']*\bmenu\b", "class=\"menu\" element"),
                ("re", r"@media[^{]*\{[^}]*\.menu\s*\{[^}]*display\s*:\s*none", "Media ichida .menu { display: none }")]},
    {"id": "d_anim", "level": 3, "title": "Aylanuvchi doira",
     "task": "@keyframes bilan elementni 360 gradus aylantiring va animation ni cheksiz (infinite) qiling.",
     "checks": [("re", r"@keyframes\s+\w+", "@keyframes yozing"), ("re", r"rotate\(\s*360deg", "rotate(360deg)"), ("re", r"animation[^;]*infinite", "animation ... infinite")]},
    {"id": "d_jsbtn", "level": 3, "title": "Salom tugmasi",
     "task": "Tugma va h1 yarating. Tugma bosilganda h1 ichidagi yozuv «Salom!» bo'lsin.",
     "checks": [("count", "button", 1, "<button> kerak"), ("count", "h1", 1, "<h1> kerak"), _click,
                ("js", r"(textContent|innerText|innerHTML)\s*=\s*['\"`]Salom!", "h1 yozuvini 'Salom!' ga o'zgartiring")]},
    {"id": "d_jscount", "level": 3, "title": "Hisoblagich",
     "task": "Tugma bosilganda sahifadagi son 1 ga oshsin.",
     "checks": [("count", "button", 1, "<button> kerak"), _click, ("js", r"\+\+|\+=\s*1|\+\s*1", "Sonni 1 ga oshiring"), ("js", r"(textContent|innerText|innerHTML)\s*=", "Sonni sahifaga chiqaring")]},
    {"id": "d_jstoggle", "level": 3, "title": "Ko'rsat / yashir",
     "task": "Tugma bosilganda p elementiga «yashirin» klassi qo'shilsin, yana bosilsa olib tashlansin (classList.toggle). CSS da .yashirin { display: none }.",
     "checks": [("count", "button", 1, "<button> kerak"), ("count", "p", 1, "<p> kerak"), _click, ("js", r"classList\.toggle\(\s*['\"`]yashirin", "classList.toggle('yashirin')"),
                ("css", "display", r"none", r"\.yashirin", ".yashirin { display: none }")]},
    {"id": "d_jsloop", "level": 3, "title": "Ro'yxatni sikl bilan",
     "task": "JavaScript sikli bilan 1 dan 5 gacha sonlarni ul ichiga li qilib qo'shing (createElement yoki innerHTML).",
     "checks": [("count", "ul", 1, "<ul> kerak"), ("js", r"\bfor\s*\(|forEach|while\s*\(", "Sikl yozing"), ("js", r"createElement\(\s*['\"`]li|innerHTML\s*\+=", "li qo'shing"), ("js", r"append|innerHTML", "Ro'yxatga qo'shing")]},
    {"id": "d_jssum", "level": 3, "title": "Yig'indi funksiyasi",
     "task": "Ikki sonni qo'shib qaytaradigan (return) funksiya yozing va natijasini console.log bilan chiqaring.",
     "checks": [("js", r"function\s+\w+\s*\(\s*\w+\s*,\s*\w+\s*\)|\(\s*\w+\s*,\s*\w+\s*\)\s*=>", "2 ta parametrli funksiya"), ("js", r"return\s+\w+\s*\+\s*\w+|=>\s*\w+\s*\+\s*\w+", "Yig'indini qaytaring"), ("js", r"console\.log\(", "console.log bilan chiqaring")]},
    {"id": "d_jsinput", "level": 3, "title": "Ism yozilsa",
     "task": "input ga yozilgan matn darhol p ichida ko'rinsin (input hodisasi, value).",
     "checks": [("count", "input", 1, "<input> kerak"), ("count", "p", 1, "<p> kerak"), ("re", r"addEventListener\(\s*['\"](input|keyup)['\"]|oninput\s*=|onkeyup\s*=", "input hodisasi"), ("js", r"\.value", ".value dan foydalaning"), ("js", r"(textContent|innerText|innerHTML)\s*=", "p ga yozing")]},
]
DUEL_BY_ID = {t["id"]: t for t in DUEL_TASKS}

# --------------------------------------------------------------------------- #
#  Xatoni top: tayyor kodda bitta xato bor
# --------------------------------------------------------------------------- #
BUGS = [
    {"id": "b1", "lang": "HTML", "level": 1, "title": "Yopilmagan teg", "want": "Sarlavha va paragraf alohida ko'rinsin",
     "code": "<h1>Salom\n<p>Bu mening sahifam</p>", "checks": [("closed", "Hamma teglar yopilsin"), ("count", "h1", 1, "<h1> qolsin"), ("count", "p", 1, "<p> qolsin")]},
    {"id": "b2", "lang": "HTML", "level": 1, "title": "Rasm chiqmayapti", "want": "Rasm ko'rinsin",
     "code": "<img href=\"mushuk.png\" alt=\"Mushuk\">", "checks": [("attr", "img", "src", r"mushuk\.png", "Rasm manzili to'g'ri atributda bo'lsin")]},
    {"id": "b3", "lang": "HTML", "level": 1, "title": "Havola ishlamayapti", "want": "Havola google.com ni ochsin",
     "code": "<a src=\"https://google.com\">Google</a>", "checks": [("attr", "a", "href", r"google\.com", "Havola manzili to'g'ri atributda bo'lsin")]},
    {"id": "b4", "lang": "HTML", "level": 1, "title": "Noto'g'ri tartib", "want": "Teglar to'g'ri ketma-ketlikda yopilsin",
     "code": "<p>Men <b>juda <i>kuchli</b></i> dasturchiman</p>", "checks": [("closed", "Ichki teg birinchi yopilsin"), ("count", "b", 1, "<b> qolsin"), ("count", "i", 1, "<i> qolsin")]},
    {"id": "b5", "lang": "HTML", "level": 1, "title": "Ro'yxat buzilgan", "want": "Ro'yxat qatorlari ro'yxat ichida bo'lsin",
     "code": "<ul></ul>\n<li>Olma</li>\n<li>Nok</li>", "checks": [("in", "li", "ul", 2, "<li> lar <ul> ichida bo'lsin"), ("closed", "Teglar yopilsin")]},
    {"id": "b6", "lang": "HTML", "level": 2, "title": "Label bosilmayapti", "want": "Label bosilsa input tanlansin",
     "code": "<label for=\"name\">Ism</label>\n<input id=\"ism\" type=\"text\">", "checks": [("re", r"for\s*=\s*[\"'](\w+)[\"'].*id\s*=\s*[\"']\1[\"']|id\s*=\s*[\"'](\w+)[\"'].*for\s*=\s*[\"']\2[\"']", "for va id bir xil bo'lsin")]},
    {"id": "b7", "lang": "HTML", "level": 2, "title": "Parol ko'rinib qolyapti", "want": "Parol yashirin yozilsin",
     "code": "<input type=\"text\" placeholder=\"Parol\">", "checks": [("attr", "input", "type", r"^password$", "Parol maydoni turi to'g'ri bo'lsin")]},
    {"id": "b8", "lang": "HTML", "level": 2, "title": "Jadval siljigan", "want": "Ikkala qatorda ham 2 tadan katak bo'lsin",
     "code": "<table>\n  <tr><td>1</td><td>2</td></tr>\n  <tr><td>3</td><th4</td></tr>\n</table>", "checks": [("in", "td", "table", 4, "4 ta <td> bo'lsin"), ("closed", "Teglar yopilsin")]},
    {"id": "b9", "lang": "HTML", "level": 1, "title": "Sahifa nomi yo'q", "want": "Brauzer yorlig'ida «Mening saytim» ko'rinsin",
     "code": "<head>\n  <tittle>Mening saytim</tittle>\n</head>", "checks": [("text", "title", r"Mening saytim", "Teg nomi to'g'ri yozilsin")]},
    {"id": "b10", "lang": "HTML", "level": 2, "title": "CSS ulanmayapti", "want": "style.css ulansin",
     "code": "<link rel=\"style\" href=\"style.css\">", "checks": [("attr", "link", "rel", r"^stylesheet$", "rel qiymati to'g'ri bo'lsin"), ("attr", "link", "href", r"style\.css", "href qolsin")]},
    {"id": "b11", "lang": "CSS", "level": 1, "title": "Rang o'zgarmayapti", "want": "h1 qizil bo'lsin",
     "code": "<style>\n  h1 { colour: red; }\n</style>\n<h1>Salom</h1>", "checks": [("css", "color", r"red", "Xossa nomi to'g'ri yozilsin")]},
    {"id": "b12", "lang": "CSS", "level": 1, "title": "Klass ishlamayapti", "want": ".karta klassiga fon berilsin",
     "code": "<style>\n  karta { background: gold; }\n</style>\n<div class=\"karta\">Salom</div>", "checks": [("css", r"background(-color)?", r"gold", r"\.karta", "Klass selektori to'g'ri bo'lsin"), ("attr", "div", "class", "karta", "class qolsin")]},
    {"id": "b13", "lang": "CSS", "level": 1, "title": "Nuqtali vergul", "want": "Ikkala xossa ham ishlasin",
     "code": "<style>\n  p {\n    color: blue\n    font-size: 20px;\n  }\n</style>\n<p>Matn</p>", "checks": [("css", "color", r"^blue$", "color ishlasin"), ("css", "font-size", r"^20px$", "font-size ishlasin")]},
    {"id": "b14", "lang": "CSS", "level": 2, "title": "id uslubi", "want": "#bosh elementga 40px shrift berilsin",
     "code": "<style>\n  .bosh { font-size: 40px; }\n</style>\n<h1 id=\"bosh\">Salom</h1>", "checks": [("re", r"#bosh\s*\{[^}]*font-size\s*:\s*40px|class\s*=\s*[\"']bosh", "Selektor va element mos bo'lsin")]},
    {"id": "b15", "lang": "CSS", "level": 2, "title": "Markazga kelmayapti", "want": "Flex ichidagi quti markazda tursin",
     "code": "<style>\n  .ota { display: flex; justify-content: middle; }\n</style>\n<div class=\"ota\"><div>Quti</div></div>", "checks": [("css", "justify-content", r"^center$", "justify-content qiymati to'g'ri bo'lsin"), ("css", "display", r"flex", "flex qolsin")]},
    {"id": "b16", "lang": "CSS", "level": 2, "title": "Doira emas", "want": "Quti to'liq doira bo'lsin",
     "code": "<style>\n  .doira { width: 100px; height: 100px; background: green; border-radius: 5%; }\n</style>\n<div class=\"doira\"></div>", "checks": [("css", "border-radius", r"^(50%|[5-9]\dpx|\d{3,}px|[6-9]\d%|100%)$", "border-radius to'g'ri bo'lsin")]},
    {"id": "b17", "lang": "CSS", "level": 2, "title": "Birliksiz", "want": "Quti kengligi 200 piksel bo'lsin",
     "code": "<style>\n  div { width: 200; background: skyblue; height: 50px; }\n</style>\n<div></div>", "checks": [("css", "width", r"^200px$", "Birlik yozilsin")]},
    {"id": "b18", "lang": "CSS", "level": 2, "title": "Hover ishlamayapti", "want": "Tugma ustiga kelganda rangi o'zgarsin",
     "code": "<style>\n  button.hover { background: orange; }\n</style>\n<button>Bos</button>", "checks": [("css", r"background(-color)?", r"orange", r"button:hover", "hover to'g'ri yozilsin")]},
    {"id": "b19", "lang": "CSS", "level": 3, "title": "Yopishmayapti", "want": "header tepaga yopishib tursin",
     "code": "<style>\n  header { position: sticky; background: white; }\n</style>\n<header>Menyu</header>", "checks": [("css", "top", r"^0", "sticky uchun chegara kerak"), ("css", "position", r"sticky", "sticky qolsin")]},
    {"id": "b20", "lang": "CSS", "level": 3, "title": "Ustunlar teng emas", "want": "3 ta teng ustun bo'lsin",
     "code": "<style>\n  .g { display: grid; grid-template-columns: repeat(1fr, 3); }\n</style>\n<div class=\"g\"><p>1</p><p>2</p><p>3</p></div>", "checks": [("css", "grid-template-columns", r"repeat\(\s*3\s*,\s*1fr|1fr 1fr 1fr", "repeat tartibi to'g'ri bo'lsin")]},
    {"id": "b21", "lang": "JS", "level": 1, "title": "Konsolga chiqmayapti", "want": "Konsolda Salom chiqsin",
     "code": "<script>\n  console.log(Salom);\n</script>", "checks": [("js", r"console\.log\(\s*['\"`]Salom['\"`]\s*\)", "Matn qo'shtirnoqda bo'lsin")]},
    {"id": "b22", "lang": "JS", "level": 1, "title": "const o'zgarmayapti", "want": "ball 1 ga oshsin",
     "code": "<script>\n  const ball = 5;\n  ball = ball + 1;\n  console.log(ball);\n</script>", "checks": [("js", r"\b(let|var)\s+ball", "O'zgaradigan o'zgaruvchi bo'lsin"), ("js", r"ball\s*=\s*ball\s*\+\s*1|ball\+\+|ball\s*\+=\s*1", "Oshirish qolsin")]},
    {"id": "b23", "lang": "JS", "level": 2, "title": "Solishtirish xatosi", "want": "Yosh 18 bo'lsagina «Xush kelibsiz» chiqsin",
     "code": "<script>\n  let yosh = 15;\n  if (yosh = 18) {\n    console.log('Xush kelibsiz');\n  }\n</script>", "checks": [("js", r"if\s*\(\s*(yosh\s*(={2,3}|>=)\s*18|18\s*(={2,3}|<=)\s*yosh)\s*\)", "Solishtirish belgisi to'g'ri bo'lsin")]},
    {"id": "b24", "lang": "JS", "level": 2, "title": "Tugma ishlamayapti", "want": "Tugma bosilganda salom chiqsin",
     "code": "<button id=\"b\">Bos</button>\n<script>\n  document.getElementById('#b').addEventListener('click', () => alert('salom'));\n</script>", "checks": [("js", r"getElementById\(\s*['\"]b['\"]|querySelector\(\s*['\"](#b|button)['\"]", "Element to'g'ri topilsin"), ("js", r"addEventListener\(\s*['\"]click", "click qolsin")]},
    {"id": "b25", "lang": "JS", "level": 2, "title": "Matn qo'shilib qoldi", "want": "5 + 3 natijasi 8 chiqsin",
     "code": "<script>\n  let a = '5';\n  let b = '3';\n  console.log(a + b);\n</script>", "checks": [("re", r"let a = 5|Number\(\s*a|parseInt\(\s*a|\+a\b|let a = '5' \* 1", "Matnni songa aylantiring"), ("re", r"let b = 3|Number\(\s*b|parseInt\(\s*b|\+\s*\+b\b", "Ikkalasini ham songa aylantiring")]},
    {"id": "b26", "lang": "JS", "level": 2, "title": "Cheksiz sikl", "want": "Sikl 5 marta aylansin",
     "code": "<script>\n  for (let i = 0; i < 5; i--) {\n    console.log(i);\n  }\n</script>", "checks": [("js", r"i\s*<\s*5\s*;\s*(i\+\+|\+\+i|i\s*\+=\s*1)|i\s*<=\s*4\s*;\s*i\+\+", "Sikl oldinga yursin")]},
    {"id": "b27", "lang": "JS", "level": 2, "title": "Oxirgi element", "want": "Massivning oxirgi elementi (nok) chiqsin",
     "code": "<script>\n  const m = ['olma', 'uzum', 'nok'];\n  console.log(m[m.length]);\n</script>", "checks": [("js", r"m\[\s*m\.length\s*-\s*1\s*\]|m\.at\(\s*-1\s*\)|m\[\s*2\s*\]", "Indeks to'g'ri bo'lsin")]},
    {"id": "b28", "lang": "JS", "level": 3, "title": "Funksiya bo'sh qaytaradi", "want": "Konsolda 7 chiqsin",
     "code": "<script>\n  function qosh(a, b) {\n    a + b;\n  }\n  console.log(qosh(3, 4));\n</script>", "checks": [("js", r"return\s+\(?\s*a\s*\+\s*b", "Natija qaytarilsin")]},
    {"id": "b29", "lang": "JS", "level": 3, "title": "Darhol ishlab ketyapti", "want": "salom() faqat bosilganda ishlasin",
     "code": "<button>Bos</button>\n<script>\n  function salom() { alert('salom'); }\n  document.querySelector('button').addEventListener('click', salom());\n</script>", "checks": [("js", r"addEventListener\(\s*['\"]click['\"]\s*,\s*(salom\s*\)|\(\s*\w*\s*\)\s*=>|function)", "Funksiyani chaqirmasdan bering")]},
    {"id": "b30", "lang": "JS", "level": 3, "title": "Skript erta ishlayapti", "want": "Skript h1 ni topsin",
     "code": "<script>\n  document.querySelector('h1').textContent = 'Yangi';\n</script>\n<h1>Eski</h1>", "checks": [("re", r"<h1.*</h1>.*<script|DOMContentLoaded|window\.onload|addEventListener\(\s*['\"]load", "Skript h1 dan keyin ishlasin"), ("js", r"textContent", "O'zgartirish qolsin")]},
]
BUGS_BY_ID = {b["id"]: b for b in BUGS}
BUG_PAY = {1: 4000, 2: 7000, 3: 12000}

# --------------------------------------------------------------------------- #
#  Maketni takrorla: 300x200 rasm (static/makets/<id>.png)
# --------------------------------------------------------------------------- #
MAKETS = [
    {"id": "m1", "title": "Bayroq", "level": 1, "colors": ["#0099b5", "#ffffff", "#1eb53a"], "need": r"background"},
    {"id": "m2", "title": "Quyosh", "level": 1, "colors": ["#38bdf8", "#facc15"], "need": r"border-radius"},
    {"id": "m3", "title": "To'rt quti", "level": 1, "colors": ["#1e293b", "#f43f5e", "#22c55e", "#3b82f6", "#f59e0b"], "need": r"background"},
    {"id": "m4", "title": "Nishon", "level": 1, "colors": ["#f8fafc", "#dc2626"], "need": r"border-radius"},
    {"id": "m5", "title": "Karta", "level": 2, "colors": ["#e2e8f0", "#ffffff", "#6366f1", "#cbd5e1"], "need": r"border-radius"},
    {"id": "m6", "title": "Svetofor", "level": 2, "colors": ["#334155", "#0f172a", "#ef4444", "#eab308", "#22c55e"], "need": r"border-radius"},
    {"id": "m7", "title": "Uy", "level": 2, "colors": ["#bae6fd", "#b45309", "#7f1d1d", "#fde68a", "#16a34a"], "need": r"border|clip-path|transform"},
    {"id": "m8", "title": "Menyu", "level": 2, "colors": ["#f1f5f9", "#1d4ed8", "#ffffff", "#94a3b8"], "need": r"background"},
    {"id": "m9", "title": "Shaxmat", "level": 3, "colors": ["#fef3c7", "#92400e"], "need": r"grid|flex|gradient|float|position"},
    {"id": "m10", "title": "Yarim oy", "level": 3, "colors": ["#1e1b4b", "#fde047"], "need": r"border-radius|box-shadow"},
    {"id": "m11", "title": "Kapalak", "level": 3, "colors": ["#ecfccb", "#a21caf", "#f0abfc", "#1c1917"], "need": r"border-radius"},
    {"id": "m12", "title": "Robot", "level": 3, "colors": ["#0f172a", "#94a3b8", "#22d3ee", "#e11d48"], "need": r"border-radius"},
]
MAKETS_BY_ID = {m["id"]: m for m in MAKETS}
MAKET_PASS = 90
MAKET_PAY = {1: 8000, 2: 15000, 3: 25000}
