// Panel: kod muharriri, portfolio, nishonlar, parolni tiklash, ikki bosqichli kirish
(() => {
  const Oyin = window.Oyin;
  const { api, handleAuthError, el, icon, avatarEl, viewLoaders } = Oyin;
  const APP = window.APP || {};
  const isOwner = APP.role === 'owner';
  const $ = (id) => document.getElementById(id);
  const fail = (err) => { if (!handleAuthError(err)) window.alert(err.message); };
  const extra = Oyin.extraLoaders || (Oyin.extraLoaders = {});
  const chain = (name, fn) => {
    const prev = extra[name];
    extra[name] = async (p) => { if (prev) await prev(p); await fn(p); };
  };
  const btn = (text, cls = 'btn btn--ghost', iconName = null) => {
    const b = el('button', cls);
    b.type = 'button';
    if (iconName) b.append(icon(iconName));
    b.append(el('span', '', text));
    return b;
  };
  function card(title, iconName, cls = '') {
    const c = el('section', `card school-card ${cls}`);
    const h = el('div', 'school-card__head');
    const i = el('span', 'card__icon');
    i.append(icon(iconName));
    h.append(i, el('h2', '', title));
    c.append(h);
    return c;
  }

  // ================= Kod muharriri =================
  function preview(html, css) {
    const f = el('iframe', 'code-preview');
    f.setAttribute('sandbox', ''); // skriptlar ishlamaydi — faqat HTML/CSS
    f.title = 'Natija';
    f.srcdoc = `<!doctype html><meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;margin:12px}${css.replace(/<\/style/gi, '')}</style>${html}`;
    return f;
  }
  async function loadCode() {
    const root = $('code-root');
    if (!root) return;
    root.replaceChildren();
    let data = { html: '', css: '' };
    try { data = await api('/api/code'); } catch (err) { handleAuthError(err); }
    const c = card('HTML / CSS muharrir', 'file', 'code-card');
    c.append(el('p', 'muted', "Chapda kod yozing — o'ngda natija darhol ko'rinadi. Kod o'zi saqlanadi."));
    const grid = el('div', 'code-grid');
    const eds = el('div', 'code-eds');
    const mk = (label, val, ph) => {
      const w = el('label', 'code-ed');
      const t = el('textarea', 'code-ed__area');
      t.spellcheck = false;
      t.value = val;
      t.placeholder = ph;
      w.append(el('span', 'code-ed__label', label), t);
      eds.append(w);
      return t;
    };
    const html = mk('HTML', data.html || '', '<h1>Salom dunyo!</h1>\n<p>Birinchi sahifam</p>');
    const css = mk('CSS', data.css || '', 'h1 { color: tomato; }');
    const out = el('div', 'code-out');
    grid.append(eds, out);
    const status = el('small', 'muted', '');
    c.append(grid, status);
    root.append(c);
    let saveT = null;
    const render = () => out.replaceChildren(preview(html.value, css.value));
    const onInput = () => {
      render();
      status.textContent = 'Saqlanmoqda…';
      clearTimeout(saveT);
      saveT = setTimeout(() => api('/api/code', { method: 'POST', body: { html: html.value, css: css.value } })
        .then(() => { status.textContent = 'Saqlandi ✓'; }).catch((err) => { status.textContent = err.message; }), 1200);
    };
    [html, css].forEach((t) => {
      t.addEventListener('input', onInput);
      t.addEventListener('keydown', (e) => { // Tab — bo'sh joy qo'yadi
        if (e.key !== 'Tab') return;
        e.preventDefault();
        const s = t.selectionStart;
        t.setRangeText('  ', s, t.selectionEnd, 'end');
        onInput();
      });
    });
    render();
    if (isOwner) {
      const list = card("O'quvchilarning kodi", 'users');
      try {
        const { items } = await api('/api/code/all');
        if (!items.length) list.append(el('p', 'muted', "Hali hech kim kod yozmagan."));
        items.forEach((it) => {
          const row = el('details', 'code-item');
          const sum = el('summary', '');
          sum.append(avatarEl(it.name, it.avatar, 'avatar avatar--sm'), el('strong', '', it.name), el('small', 'muted', it.updated));
          row.append(sum);
          row.addEventListener('toggle', () => {
            if (!row.open || row.dataset.done) return;
            row.dataset.done = '1';
            const g = el('div', 'code-grid');
            const pre = el('pre', 'code-pre', `${it.html}\n\n/* CSS */\n${it.css}`);
            const o = el('div', 'code-out');
            o.append(preview(it.html, it.css));
            g.append(pre, o);
            row.append(g);
          });
          list.append(row);
        });
      } catch (err) { handleAuthError(err); }
      root.append(list);
    }
  }
  viewLoaders.code = loadCode;

  // ================= Profil: nishonlar, portfolio, parol =================
  chain('profile', async (param) => {
    const root = $('profile-extra2');
    if (!root) return;
    root.replaceChildren();
    const uid = Number(param) || APP.id;
    if (!uid) return;
    const canEdit = isOwner || uid === APP.id;
    try {
      const [{ badges }, port] = await Promise.all([api(`/api/profile/${uid}/badges`), api(`/api/profile/${uid}/portfolio`)]);
      const b = card('Nishonlar', 'medal');
      const grid = el('div', 'badges');
      badges.forEach((x) => {
        const item = el('div', `badge-item${x.got ? ' is-got' : ''}`);
        item.title = x.about;
        item.append(el('span', 'badge-item__icon', x.icon), el('strong', '', x.name), el('small', '', x.about));
        grid.append(item);
      });
      b.append(grid);
      const p = card('Portfolio — eng yaxshi ishlar', 'star');
      const gallery = el('div', 'portfolio');
      if (!port.items.length) p.append(el('p', 'muted', "Hali portfolioda ish yo'q."));
      port.items.forEach((it) => {
        const item = el('article', 'portfolio__item');
        item.append(el('span', 'portfolio__score', `${it.score}/${it.max_score}`), el('strong', '', it.title), el('small', 'muted', it.date));
        if (it.feedback) item.append(el('p', '', it.feedback));
        const files = el('div', 'portfolio__files');
        it.files.forEach((f, i) => {
          const a = el('a', 'chip', f);
          a.href = `/api/submissions/${it.id}/files/${i}`;
          files.append(a);
        });
        item.append(files);
        if (canEdit) {
          const rm = btn('Olib tashlash', 'btn btn--ghost btn--sm');
          rm.addEventListener('click', () => api(`/api/portfolio/${it.id}`, { method: 'POST' }).then(() => extra.profile(param)).catch(fail));
          item.append(rm);
        }
        gallery.append(item);
      });
      p.append(gallery);
      if (canEdit && port.candidates.length) {
        const row = el('div', 'lesson-form');
        const sel = el('select', 'input-plain');
        port.candidates.forEach((cnd) => {
          const o = el('option', '', `${cnd.title} — ${cnd.score} ball`);
          o.value = cnd.id;
          sel.append(o);
        });
        const add = btn("Portfolioga qo'shish", 'btn btn--primary', 'plus');
        add.addEventListener('click', () => api(`/api/portfolio/${sel.value}`, { method: 'POST' }).then(() => extra.profile(param)).catch(fail));
        row.append(sel, add);
        p.append(row);
      }
      root.append(b, p);
      if (isOwner && param) {
        const s = card('Parolni unutgan bo\'lsa', 'lock');
        s.append(el('p', 'muted', "Bir bosishda yangi 6 xonali parol yaratiladi. Eski qurilmalardan chiqib ketadi."));
        const gen = btn('Yangi parol yaratish', 'btn btn--primary', 'refresh');
        const out = el('p', 'pw-out');
        gen.addEventListener('click', async () => {
          if (!window.confirm("Yangi parol yaratilsinmi? Eski parol ishlamay qoladi.")) return;
          try {
            const r = await api(`/api/users/${uid}/password/random`, { method: 'POST' });
            out.textContent = `Yangi parol: ${r.password} — o'quvchiga ayting`;
          } catch (err) { fail(err); }
        });
        s.append(gen, out);
        root.append(s);
      }
    } catch (err) {
      handleAuthError(err);
    }
  });

  // ================= Owner: ikki bosqichli kirish =================
  chain('add-user', async () => {
    if (!isOwner) return;
    const view = document.querySelector('.view[data-view="add-user"]');
    if (!view) return;
    view.querySelector('#twofa-card')?.remove();
    const c = card('Xavfsizlik: ikki bosqichli kirish', 'shield');
    c.id = 'twofa-card';
    view.append(c);
    let st;
    try { st = await api('/api/2fa'); } catch (err) { handleAuthError(err); return; }
    const body = el('div', 'twofa');
    c.append(body);
    if (st.enabled) {
      body.append(el('p', 'twofa__on', "✅ Yoqilgan: owner bo'lib kirishda telefon ilovasidagi kod so'raladi."));
      if (st.bypass) body.append(el('p', 'muted', "Hozir .env dagi OWNER_2FA_OFF=1 tufayli kod so'ralmayapti."));
      const code = el('input', 'input-plain');
      code.placeholder = 'Ilovadagi kod';
      code.inputMode = 'numeric';
      code.maxLength = 6;
      const off = btn("O'chirish", 'btn btn--ghost');
      off.addEventListener('click', () => api('/api/2fa/disable', { method: 'POST', body: { code: code.value } })
        .then(() => extra['add-user']()).catch(fail));
      const row = el('div', 'lesson-form');
      row.append(code, off);
      body.append(row);
      return;
    }
    body.append(el('p', 'muted', "Parolingizni kimdir bilib olsa ham, telefoningizdagi Google Authenticator kodisiz kira olmaydi."));
    const start = btn('Yoqish', 'btn btn--primary', 'shield');
    body.append(start);
    start.addEventListener('click', async () => {
      try {
        const r = await api('/api/2fa/setup', { method: 'POST' });
        body.replaceChildren();
        body.append(el('p', '', "1) Telefonda Google Authenticator (yoki shunga o'xshash) ilovasini oching → «+» → «Kalitni kiritish»."),
          el('p', '', '2) Hisob nomi: O\'yin, kalit:'), el('code', 'twofa__key', r.secret.replace(/(.{4})/g, '$1 ').trim()));
        const link = el('a', 'btn btn--ghost', 'Telefonda ochish (ilovaga qo\'shish)');
        link.href = r.uri;
        body.append(link, el('p', '', "3) Ilova ko'rsatgan 6 xonali kodni yozing:"));
        const code = el('input', 'input-plain');
        code.inputMode = 'numeric';
        code.maxLength = 6;
        code.placeholder = '123456';
        const ok = btn('Tasdiqlash', 'btn btn--primary', 'check');
        ok.addEventListener('click', () => api('/api/2fa/enable', { method: 'POST', body: { code: code.value } })
          .then(() => extra['add-user']()).catch(fail));
        const row = el('div', 'lesson-form');
        row.append(code, ok);
        body.append(row, el('small', 'muted', "Telefon yo'qolsa: serverdagi .env fayliga OWNER_2FA_OFF=1 yozib qayta yoqing."));
      } catch (err) { fail(err); }
    });
  });
})();
