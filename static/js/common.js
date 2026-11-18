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

  window.Oyin = {
    store, avatarColor, api, handleAuthError, el, icon, formatDate, avatarEl, setAvatar,
    uploadAvatar, MONTHS, formatNumber, viewLoaders: {}, hideExamBanner,
  };
})();
