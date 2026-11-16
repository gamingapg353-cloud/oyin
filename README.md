# O'yin

O'yinlar platformasi: **Python (Flask)** server + **HTML**, **SCSS/CSS**, **JavaScript**.

## Ishga tushirish

**Eng oson yo'li:** `ishga_tushirish.bat` faylini ikki marta bosing. U kutubxonalarni tekshiradi,
serverni ishga tushiradi va brauzerni o'zi ochadi.

Yoki terminalda (loyiha papkasida):

```bash
pip install -r py/requirements.txt
python py/app.py
```

So'ng brauzerda oching: http://127.0.0.1:5000

## Maxfiy sozlamalar (.env)

Parol va kalitlar **`.env`** faylida turadi — u GitHub'ga yuklanmaydi.
GitHub'dan yangi yuklab olgan bo'lsangiz, `.env.example` ni `.env` nomi bilan nusxalang
(`ishga_tushirish.bat` buni o'zi qiladi) va to'ldiring:

```
GEMINI_API_KEY=...
OWNER_LOGIN=...
OWNER_PASSWORD=...
OWNER_NAME=...
```

## AI kalitini qo'yish (.env) — Google Gemini

1. https://aistudio.google.com/apikey saytida API kalit oling.
2. Loyiha papkasidagi **`.env`** faylini oching va yozing:
   ```
   GEMINI_API_KEY=AIza...
   ```
3. Saqlang — server o'zi qayta ishga tushadi.

Kalit bo'lmasa ham sayt ishlaydi — topshiriqlarni owner o'zi baholaydi.
`.env` faylini hech kimga yubormang. Model va "o'ylash darajasi" `py/config.py` da (`AI_MODEL`, `AI_THINKING`).

## Kim qanday kiradi

| Rol | Qayerdan | Login / parol |
| --- | --- | --- |
| **Owner** | Kirish sahifasida «Owner» tugmasi | `.env` dagi `OWNER_LOGIN` / `OWNER_PASSWORD` |
| **Foydalanuvchi** | Kirish sahifasida «Foydalanuvchi» tugmasi | Owner «Odam qo'shish» bo'limida bergan login / parol |

## Bo'limlar

- **O'yinlar** — «Mahalla» o'yini, «Kirish» tugmasi bilan (pastda batafsil).
- **Uy vazifa** — owner vazifa beradi (nomi; tavsif va vazifa fayli — ixtiyoriy).
  Foydalanuvchi bajarib, fayl qilib yuklaydi. AI faylni ochib tekshiradi, 0–5 ball qo'yadi —
  xato qancha ko'p bo'lsa, ball shuncha kam — va **har bir xatoni** aytadi (qaysi faylda, nima
  noto'g'ri, qanday tuzatish kerak). Ish AI yasaganmi — shuni ham baholaydi.
  Owner bahoni qo'lda o'zgartira oladi.
- **Odam qo'shish** (faqat owner) — yangi odam va **Ball berish**.
- **Reyting** — hamma ko'radi. Profil: rasm, reytingdagi o'rni, joriy balans,
  oylik uy vazifa natijasi, o'yindagi mulki.
  - Foydalanuvchi **faqat o'z profilini** ko'radi — boshqa odamni bossa ham o'zinikiga tushadi.
  - **Owner hammaning** profilini ko'radi va **login hamda parolini almashtira oladi**.
- **Yuqori o'ng burchakdagi hisob** — bosilsa menyu: Profilim, Rasmni almashtirish, Rasmni o'chirish, Chiqish.

## «Mahalla» o'yini

- Do'stlar bilan bitta xaritada: kim o'ynayotgani ko'rinadi.
- **Piyoda** yoki **mashinada** yurish: WASD / strelkalar, mashinaga o'tirish-tushish — **E**.
  Telefonda — ekrandagi tugmalar.
- Ko'chadagi **tangalarni** tering (har biri 50 so'm). Kim birinchi yetib borsa — o'shaniki.
- **Ota hovli** — sotib olib 5 darajagacha kuchaytirasiz.
- **Avtosalon** — 4 xil mashina (Jajji, Shamol, Chaqmoq, Bo'ron).
- Hovli va mashinalar **har soatda pul** olib keladi (o'yinda bo'lmasangiz ham, 24 soatgacha).
- Narx va daromadlarni `py/game.py` dagi `HOUSE_LEVELS` va `CARS` ro'yxatlarida o'zgartirasiz.

## Fayllar

```
ishga_tushirish.bat Ikki marta bosib ishga tushirish
.env                Maxfiy: owner paroli, AI kaliti (GitHub'ga yuklanmaydi)
.env.example        .env namunasi
index.html          Kirish sahifasi
panel.html          Panel (O'yinlar, Uy vazifa, Odam qo'shish, Reyting, Profil)
game.html           Mahalla o'yini
py/                 Python qismi
  app.py              Server: sahifalar, kirish, odamlar, ball, reyting
  accounts.py         Profil, rasm (avatar), parol
  game.py             Mahalla o'yini: xarita, pul, hovli, mashinalar, do'stlar
  homework.py         Uy vazifa API
  ai_check.py         AI tekshiruvchi (Google Gemini)
  core.py             Baza (SQLite), sessiya, huquqlar
  config.py           Sozlamalar (.env ni o'qiydi: owner, AI kaliti)
  icons.py            SVG ikonkalar
  build_css.py        SCSS -> CSS (server ishga tushganda avtomatik)
  requirements.txt    Kerakli kutubxonalar
static/
  scss/             SCSS manba fayllari  <- dizaynni shu yerda o'zgartiring
  css/              Kompilyatsiya qilingan main.css
  js/               common.js, login.js, panel.js, homework.js, profile.js, game.js
data/               Baza, yuklangan fayllar, rasmlar (avtomatik yaratiladi)
```

HTML fayllarni server ochib beradi — ularni to'g'ridan-to'g'ri ikki marta bosib ochmang.
