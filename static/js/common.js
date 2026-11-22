// Ikkala sahifa uchun umumiy: mavzu, parolni ko'rsatish, avatar rangi, API va DOM yordamchilari
(() => {
  const root = document.documentElement;

  const store = {
    get(key) {
      try { return localStorage.getItem(key); } catch { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(key, value); } catch { /* xotira yopiq bo'lsa ham ishlayveradi */ }
    },
  };

  // Mavzu (qorong'i / yorug')
  document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = root.dataset.theme === 'light' ? 'dark' : 'light';
      root.dataset.theme = next;
      store.set('theme', next);
    });
  });

  // Parolni ko'rsatish / yashirish
  document.querySelectorAll('[data-toggle-password]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = btn.parentElement.querySelector('input');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.classList.toggle('is-on', show);
      btn.setAttribute('aria-label', show ? 'Parolni yashirish' : "Parolni ko'rsatish");
      input.focus();
    });
  });

  // Ismga qarab doimiy avatar rangi
  const AVATAR_COLORS = ['#ec4899', '#f97316', '#6366f1', '#06b6d4', '#d946ef', '#10b981', '#3b82f6', '#eab308'];
  function avatarColor(name) {
    let hash = 0;
    for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    return AVATAR_COLORS[hash % AVATAR_COLORS.length];
  }
  document.querySelectorAll('[data-avatar]').forEach((node) => {
    node.style.setProperty('--avatar', avatarColor(node.dataset.avatar));
  });

  // So'rov yuborish: body — JSON, form — FormData (fayllar uchun)
  async function api(url, { method = 'GET', body, form } = {}) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: form || (body ? JSON.stringify(body) : undefined),
        credentials: 'same-origin',
      });
    } catch {
      throw new Error("Server bilan aloqa yo'q. Server ishlayaptimi?");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'Xatolik yuz berdi');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // Sessiya tugagan bo'lsa — kirish sahifasiga
  function handleAuthError(err) {
    if (err && err.status === 401) {
      window.location.href = '/';
      return true;
    }
    if (err && err.status === 423 && window.location.pathname === '/game') {
      window.location.reload(); // imtihon kuni — o'yin yopiq
      return true;
    }
    return false;
  }

  // Element yaratish: el('div', 'card', 'matn')
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  // <template id="icons"> dagi SVG ikonkadan nusxa
  // Ilova sifatida o'rnatish va bildirishnoma uchun
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }

  const iconTpl = document.getElementById('icons');
  function icon(name) {
    const svg = iconTpl?.content.querySelector(`[data-icon="${name}"] svg`);
    return svg ? svg.cloneNode(true) : document.createTextNode('');
  }

  function formatDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  }

  // Avatar: rasm bo'lsa — rasm, bo'lmasa — ismning birinchi harfi rangli doirada
  function avatarEl(name, url, className = 'avatar') {
    const node = el('span', className);
    setAvatar(node, name, url);
    return node;
  }

  function setAvatar(node, name, url) {
    node.replaceChildren();
    if (url) {
      const img = el('img');
      img.src = url;
      img.alt = '';
      node.append(img);
      node.style.removeProperty('--avatar');
    } else {
      node.textContent = String(name || '?').charAt(0).toUpperCase();
      node.style.setProperty('--avatar', avatarColor(name));
    }
  }

  // Rasmni kvadrat qilib kesib, kichraytiradi (256x256) — tez yuklanadi va kam joy oladi
  async function resizeImage(file, size = 256) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("Rasmni o'qib bo'lmadi. Boshqa rasm tanlang."));
        image.src = url;
      });
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      canvas.getContext('2d').drawImage(
        img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size,
      );
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
      if (!blob) throw new Error("Rasmni tayyorlab bo'lmadi");
      return blob;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // target: 'me' yoki foydalanuvchi id'si
  async function uploadAvatar(target, file) {
    if (!file.type.startsWith('image/')) throw new Error('Rasm fayl tanlang');
    const blob = await resizeImage(file);
    const form = new FormData();
    form.append('avatar', blob, blob.type === 'image/png' ? 'avatar.png' : 'avatar.webp');
    return api(`/api/avatar/${target}`, { method: 'POST', form });
  }

  const MONTHS = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun',
    'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr'];

  // 12 345 678 ko'rinishida. Juda katta sonlar (1e15 dan katta) ham "100 000 000 ..." bo'lib chiqadi
  function formatNumber(n) {
    const value = Math.floor(Number(n) || 0);
    let digits;
    if (Math.abs(value) < 1e15) {
      digits = String(Math.abs(value));
    } else {
      const [mantissa, exp] = Math.abs(value).toExponential(14).split('e');
      const power = Number(exp);
      digits = mantissa.replace('.', '').replace(/0+$/, '').padEnd(power + 1, '0').slice(0, power + 1);
    }
    return (value < 0 ? '-' : '') + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }

  // "📝 Test boshlandi" — owner test boshlaganda foydalanuvchilarning tepasida (panelda ham, o'yinda ham)
  let bannerExam = null;
  function hideExamBanner() {
    const b = document.getElementById('exam-banner');
    if (b) b.hidden = true;
  }
  function examBannerLoop() {
    const APP = window.APP || {};
    if (APP.role !== 'user') return;
    const banner = document.createElement('div');
    banner.id = 'exam-banner';
    banner.className = 'exam-banner';
    banner.hidden = true;
    banner.setAttribute('role', 'status');
    const text = el('span', 'exam-banner__text');
    const go = el('button', 'exam-banner__go', 'Boshlash');
    go.type = 'button';
    const close = el('button', 'exam-banner__close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Yopish');
    banner.append(text, go, close);
    document.body.append(banner);
    const onPanel = () => window.location.pathname.startsWith('/panel');
    go.addEventListener('click', () => {
      hideExamBanner();
      if (onPanel()) window.location.hash = 'exam';
      else window.location.href = '/panel#exam';
    });
    close.addEventListener('click', () => {
      try { sessionStorage.setItem('exam-dismissed', String(bannerExam)); } catch { /* e'tiborsiz */ }
      hideExamBanner();
    });
    const check = async () => {
      try {
        const res = await fetch('/api/exams/active', { credentials: 'same-origin' });
        if (!res.ok) return;
        const data = await res.json();
        let dismissed = '';
        try { dismissed = sessionStorage.getItem('exam-dismissed') || ''; } catch { /* e'tiborsiz */ }
        const show = data.exam && data.attempt && data.attempt.status !== 'finished'
          && String(data.exam.id) !== dismissed && !(onPanel() && window.location.hash === '#exam');
        bannerExam = data.exam ? data.exam.id : null;
        if (show) text.textContent = `📝 Test boshlandi: «${data.exam.title}». Kiringlar!`;
        banner.hidden = !show;
      } catch { /* tarmoq xatosi — keyingi safar */ }
    };
    check();
    setInterval(check, 8000);
    window.addEventListener('hashchange', check);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', examBannerLoop);
  else examBannerLoop();

  // "📝 Ustoz savol yubordi" — owner «Ball berish» bo'limida «Boshlash» bosganda o'quvchida
  function lessonBannerLoop() {
    const APP = window.APP || {};
    if (APP.role !== 'user') return;
    const banner = document.createElement('div');
    banner.className = 'exam-banner lesson-banner';
    banner.hidden = true;
    banner.setAttribute('role', 'status');
    const text = el('span', 'exam-banner__text', "📝 Ustoz sizga dars savollarini yubordi!");
    const go = el('button', 'exam-banner__go', 'Boshlash');
    go.type = 'button';
    banner.append(text, go);
    document.body.append(banner);
    const onPanel = () => window.location.pathname.startsWith('/panel');
    go.addEventListener('click', () => {
      banner.hidden = true;
      if (onPanel()) window.location.hash = 'lesson';
      else window.location.href = '/panel#lesson';
    });
    const check = async () => {
      try {
        const res = await fetch('/api/lesson-quiz', { credentials: 'same-origin' });
        if (!res.ok) return;
        const data = await res.json();
        banner.hidden = !(data.quiz && data.quiz.status === 'sent') || (onPanel() && window.location.hash === '#lesson');
      } catch { /* tarmoq xatosi — keyingi safar */ }
    };
    check();
    setInterval(check, 10000);
    window.addEventListener('hashchange', check);
    window.Oyin.hideLessonBanner = () => { banner.hidden = true; };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', lessonBannerLoop);
  else lessonBannerLoop();


  // ---------------- Sayt tili: O'zbekcha (lotin), Ўзбекча (kirill), Русский, English ----------------
  // Kirill — butun matn avtomatik o'giriladi. Rus va ingliz — asosiy tugma va sarlavhalar (qolgani o'zbekcha qoladi).
  const LANGS = { uz: "O'zbekcha", cyr: 'Ўзбекча', ru: 'Русский', en: 'English' };
  const DICT = {
    "O'yinlar": ['Игры', 'Games'], 'Uy vazifa': ['Домашнее задание', 'Homework'], 'Test': ['Тест', 'Test'],
    "Odam qo'shish": ['Добавить ученика', 'Add student'], 'Ball berish': ['Баллы', 'Give points'],
    'Reyting': ['Рейтинг', 'Rating'], 'Dars savollari': ['Вопросы урока', 'Lesson questions'],
    "So'rovnoma": ['Опрос', 'Polls'], "Sovg'alar": ['Подарки', 'Rewards'], 'Profil': ['Профиль', 'Profile'],
    'Profilim': ['Мой профиль', 'My profile'], 'Chiqish': ['Выйти', 'Log out'], 'Kirish': ['Войти', 'Enter'],
    'Rasmni almashtirish': ['Сменить фото', 'Change photo'], "Rasmni o'chirish": ['Удалить фото', 'Remove photo'],
    "O'yinchilar": ['Игроки', 'Players'], 'Ballar bo\'yicha': ['По баллам', 'By points'], 'Siz': ['Вы', 'You'],
    'Hammasi': ['Все', 'All'], 'Saqlash': ['Сохранить', 'Save'], "Qo'shish": ['Добавить', 'Add'],
    'Boshlash': ['Начать', 'Start'], 'Yopish': ['Закрыть', 'Close'], "O'chirish": ['Удалить', 'Delete'],
    'Keldi': ['Пришёл', 'Present'], 'Kechikdi': ['Опоздал', 'Late'], 'Kelmadi': ['Не пришёл', 'Absent'],
    'Dars jadvali': ['Расписание', 'Schedule'], "Oy o'quvchisi": ['Ученик месяца', 'Student of the month'],
    'Yutuqlar devori': ['Доска достижений', 'Wall of fame'], 'AI yordamchi': ['AI помощник', 'AI helper'],
    "Maslahat so'rash": ['Спросить подсказку', 'Ask for a hint'], 'Guruhlar': ['Группы', 'Groups'],
    'Bildirishnomalar': ['Уведомления', 'Notifications'], 'Mahalla 3D': ['Махалля 3D', 'Mahalla 3D'],
    "Yangi uy vazifa": ['Новое задание', 'New homework'], 'Vazifa berish': ['Дать задание', 'Give homework'],
    'Yuborish': ['Отправить', 'Send'], 'Olish': ['Получить', 'Get'], 'Berildi': ['Выдано', 'Given'], 'Bekor': ['Отмена', 'Cancel'],
    'Menyu': ['Меню', 'Menu'], 'Bozor': ['Рынок', 'Market'], 'Mulklarim': ['Моё имущество', 'My property'],
    'Avtosalon': ['Автосалон', 'Car shop'], "Mashinaga o'tirish": ['Сесть в машину', 'Get in car'],
    'Piyoda yurish': ['Идти пешком', 'Walk'], 'Signal': ['Сигнал', 'Horn'], 'Bank': ['Банк', 'Bank'],
    'Boylar reytingi': ['Рейтинг богачей', 'Richest players'], 'Klanlar': ['Кланы', 'Clans'],
    "Ko'rinishim": ['Мой вид', 'My look'], 'Poyga': ['Гонка', 'Race'], 'Futbol': ['Футбол', 'Football'],
    'Garaj': ['Гараж', 'Garage'], 'Telefon': ['Телефон', 'Phone'], 'Aeroport': ['Аэропорт', 'Airport'],
    'Login': ['Логин', 'Login'], 'Parol': ['Пароль', 'Password'], 'Ism': ['Имя', 'Name'],
    'Foydalanuvchi': ['Пользователь', 'User'], 'Owner': ['Владелец', 'Owner'],
  };
  const LAT = [["sh", 'ш'], ["ch", 'ч'], ["o'", 'ў'], ['oʻ', 'ў'], ["o‘", 'ў'], ["g'", 'ғ'], ['gʻ', 'ғ'], ["g‘", 'ғ'],
    ['yo', 'ё'], ['yu', 'ю'], ['ya', 'я'], ['ye', 'е'], ['ng', 'нг']];
  const ONE = { a: 'а', b: 'б', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'ҳ', i: 'и', j: 'ж', k: 'к', l: 'л', m: 'м', n: 'н',
    o: 'о', p: 'п', q: 'қ', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', x: 'х', y: 'й', z: 'з', "'": 'ъ', 'ʼ': 'ъ', '’': 'ъ', c: 'с', w: 'в' };
  function toCyr(text) {
    let out = '';
    let i = 0;
    const isLetter = (ch) => /[a-zA-Z]/.test(ch || '');
    while (i < text.length) {
      const two = text.slice(i, i + 2);
      const low2 = two.toLowerCase();
      const pair = LAT.find(([l]) => l === low2);
      if (pair) {
        const up = two[0] !== two[0].toLowerCase();
        out += up ? pair[1].toUpperCase() : pair[1];
        i += 2;
        continue;
      }
      const ch = text[i];
      const low = ch.toLowerCase();
      if (low === 'e' && !isLetter(text[i - 1])) {
        out += ch === 'E' ? 'Э' : 'э'; // so'z boshidagi e — э
      } else if (ONE[low] && (low !== "'" || isLetter(text[i - 1]))) {
        out += ch !== low ? ONE[low].toUpperCase() : ONE[low];
      } else out += ch;
      i += 1;
    }
    return out;
  }
  let lang = store.get('lang') || 'uz';
  const orig = new WeakMap();
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE', 'INPUT', 'SELECT', 'OPTION', 'TEMPLATE', 'CANVAS']);
  function convert(text) {
    if (lang === 'uz' || !text.trim()) return text;
    if (lang === 'cyr') return toCyr(text);
    const hit = DICT[text.trim()];
    return hit ? text.replace(text.trim(), hit[lang === 'ru' ? 0 : 1]) : text;
  }
  function translateNode(node) {
    if (node.nodeType === 3) {
      const p = node.parentElement;
      if (!p || SKIP.has(p.tagName) || p.closest('[data-no-translate]')) return;
      const saved = orig.get(node);
      const base = saved && node.nodeValue === saved.out ? saved.src : node.nodeValue;
      const out = convert(base);
      orig.set(node, { src: base, out });
      if (node.nodeValue !== out) node.nodeValue = out;
      return;
    }
    if (node.nodeType !== 1) return;
    if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') {
      translateAttrs(node);
      return;
    }
    if (SKIP.has(node.tagName) || node.hasAttribute('data-no-translate')) return;
    translateAttrs(node);
    node.childNodes.forEach(translateNode);
  }
  function translateAttrs(node) {
    ['placeholder', 'title', 'aria-label'].forEach((a) => {
      if (!node.hasAttribute || !node.hasAttribute(a)) return;
      const key = `data-orig-${a}`;
      const cur = node.getAttribute(a);
      let src = node.getAttribute(key);
      if (src === null || (cur !== convert(src) && cur !== src)) {
        src = cur;
        node.setAttribute(key, src);
      }
      const out = convert(src);
      if (cur !== out) node.setAttribute(a, out);
    });
  }
  let pending = false;
  const observer = new MutationObserver((list) => {
    if (lang === 'uz' && !document.documentElement.dataset.langWas) return;
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      observer.disconnect();
      list.forEach((m) => {
        if (m.type === 'characterData') translateNode(m.target);
        m.addedNodes.forEach(translateNode);
      });
      start();
    });
  });
  const start = () => observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  function setLang(next) {
    lang = next;
    store.set('lang', next);
    document.documentElement.lang = { uz: 'uz', cyr: 'uz-Cyrl', ru: 'ru', en: 'en' }[next];
    document.documentElement.dataset.langWas = '1';
    observer.disconnect();
    translateNode(document.body);
    start();
    const btn = document.getElementById('lang-btn');
    if (btn) btn.textContent = `🌐 ${{ uz: 'UZ', cyr: 'ЎЗ', ru: 'RU', en: 'EN' }[next]}`;
  }
  function langMenu() {
    const host = document.querySelector('.topbar__actions');
    if (!host) return;
    const wrap = el('div', 'pop');
    const btn = el('button', 'online-chip', '🌐 UZ');
    btn.id = 'lang-btn';
    btn.type = 'button';
    btn.title = 'Til / Язык / Language';
    btn.setAttribute('data-no-translate', '');
    const menu = el('div', 'menu pop__menu lang-menu');
    menu.hidden = true;
    menu.setAttribute('data-no-translate', '');
    Object.entries(LANGS).forEach(([id, name]) => {
      const b = el('button', 'menu__item', name);
      b.type = 'button';
      b.addEventListener('click', () => { menu.hidden = true; setLang(id); });
      menu.append(b);
    });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.pop__menu').forEach((m) => { if (m !== menu) m.hidden = true; });
      menu.hidden = !menu.hidden;
    });
    document.addEventListener('click', (e) => { if (!menu.contains(e.target)) menu.hidden = true; });
    wrap.append(btn, menu);
    host.prepend(wrap);
  }
  function initLang() {
    langMenu();
    if (lang !== 'uz') setLang(lang);
    else start();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initLang);
  else initLang();

  window.Oyin = {
    store, avatarColor, api, handleAuthError, el, icon, formatDate, avatarEl, setAvatar,
    uploadAvatar, MONTHS, formatNumber, viewLoaders: {}, hideExamBanner,
  };
})();
