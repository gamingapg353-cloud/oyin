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
  noto'g'ri, qanday tuzatish kerak). Ish AI yasaganmi — shuni ham baholaydi: AI ishlatilgan bo'lsa,
  o'quvchidan **5 ball ayiriladi** (−5).
  Owner bahoni qo'lda o'zgartira oladi.
- **Odam qo'shish** (faqat owner) — yangi odam va **Ball berish**.
- **Reyting** — hamma ko'radi. Profil: rasm, reytingdagi o'rni, joriy balans,
  oylik uy vazifa natijasi, o'yindagi mulki.
  - Foydalanuvchi **faqat o'z profilini** ko'radi — boshqa odamni bossa ham o'zinikiga tushadi.
  - **Owner hammaning** profilini ko'radi va **login hamda parolini almashtira oladi**.
- **Yuqori o'ng burchakdagi hisob** — bosilsa menyu: Profilim, Rasmni almashtirish, Rasmni o'chirish, Chiqish.

## «Mahalla» o'yini (3D)

- **3D** shahar (Three.js), **katta xarita** (4800 × 2400, 84 ta yer): yo'llar, daraxtlar, bog', ko'l, Avtosalon.
- Do'stlar bilan bitta xaritada: kim o'ynayotgani ko'rinadi.
- **Odam bo'lib** (qo'l-oyog'i qimirlaydi) yoki **mashinada** yurasiz:
  WASD / strelkalar — yurish, **Probel — sakrash** (Teslada — uchish/qo'nish), sichqoncha bilan tortish — kamera,
  g'ildirak — yaqin/uzoq, **E** — mashinaga o'tirish/tushish, **F** — yaqindagi yer/bino/yo'lovchi,
  **H** — signal, **M** — katta xarita (bosilgan joyga yo'l ko'rsatiladi).
  Telefonda — ekrandagi tugmalar (o'rtadagisi — sakrash/uchish) va barmoq bilan tortish.
- Yangi o'yinchiga 75 000 so'm beriladi (BMW + birinchi uyga yetadi).
- **Taksi**: mashinada tepadagi **«Yandex»** tugmasini bosing — yo'lovchilar paydo bo'ladi. Sariq halqadagi
  yo'lovchiga boring — o'zi o'tiradi; yashil nurga eltsangiz pul olasiz
  (uzoqroq manzil — ko'proq pul, qimmat mashina — haqi ko'proq).
- Har kimga bitta yer — **Ota hovli** — bepul. Qo'shimcha **bo'sh yerlarni sotib olish** mumkin
  (25 000 so'm, **cheklov yo'q** — xohlagancha yer olish mumkin).
- Har bir yerga **nima qurishni o'zingiz tanlaysiz**: **Uy, Magazin, Kafe yoki Ofis**.
  Har bino turining o'z qavat chegarasi bor: **Uy — 25, Magazin — 40, Kafe — 60, Ofis — 100 qavat**.
  Qavat narxi **40 000 so'mdan** boshlanadi, eng yuqori qavat — **300 000 so'm**.
  10, 30, 60 va 100 qavatda tomida yangi bezaklar paydo bo'ladi (antenna, vertolyot maydoni, oltin toj).
- **Yangi qavat qo'shish uchun HTML/CSS savoliga to'g'ri javob berish kerak** (50 ta savol, `py/quiz.py`).
  Noto'g'ri javob bo'lsa pul yechilmaydi, to'g'ri javob va tushuntirish ko'rsatiladi, 15 soniyadan keyin yangi savol.
- **Sotish**: uyingizga narx qo'yib sotuvga chiqarasiz — uni boshqa o'yinchi sotib oladi va pul sizga tushadi.
  Owner istalgan uyni sotuvga qo'ya oladi (pul uy egasiga tushadi). Owner qavatlarni savolsiz qo'shadi.
- **Avtosalon** — mashinalar faqat Avtosalonning o'zida sotiladi: BMW M5, Mercedes G-Class,
  Lamborghini Aventador va eng qimmati — **uchadigan Tesla** (baland binolar ustidan o'zi oshib o'tadi).
  Mashinalarning ovozi bor (dvigatel, signal), ovozni yuqoridagi tugma bilan o'chirish mumkin.
- Binolar **har soniyada pul** olib keladi (o'yinda bo'lmasangiz ham, 24 soatgacha).
- Narx va daromadlarni `py/game.py` dagi `BUILDINGS`, `CARS`, `LAND_PRICE`, `MAX_PLOTS`, `TAXI_*` da o'zgartirasiz.

## Fayllar

```
ishga_tushirish.bat Ikki marta bosib ishga tushirish
.env                Maxfiy: owner paroli, AI kaliti (GitHub'ga yuklanmaydi)
.env.example        .env namunasi
index.html          Kirish sahifasi
panel.html          Panel (O'yinlar, Uy vazifa, Odam qo'shish, Reyting, Profil)
game.html           Mahalla o'yini (3D)
py/                 Python qismi
  app.py              Server: sahifalar, kirish, odamlar, ball, reyting
  accounts.py         Profil, rasm (avatar), parol
  game.py             Mahalla o'yini: xarita, pul, yerlar, binolar, mashinalar, do'stlar
  quiz.py             HTML/CSS savollari (yangi qavat uchun)
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
  vendor/three/     Three.js 0.187 (3D kutubxona, MIT litsenziya)
data/               Baza, yuklangan fayllar, rasmlar (avtomatik yaratiladi)
```

HTML fayllarni server ochib beradi — ularni to'g'ridan-to'g'ri ikki marta bosib ochmang.
