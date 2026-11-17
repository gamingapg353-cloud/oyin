// Profil sahifasi (#profile/5): rasm, reytingdagi o'rin, balans, oylik natija, o'yin, parol
(() => {
  const Oyin = window.Oyin;
  const { api, handleAuthError, el, icon, avatarEl, uploadAvatar, formatNumber, viewLoaders } = Oyin;
  const root = document.getElementById('profile-root');
  if (!root) return;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  let currentId = null;

  // ---------------- Kichik bo'laklar ----------------
  function infoChip(iconName, text) {
    const node = el('span', 'info-chip');
    if (iconName) node.append(icon(iconName));
    node.append(el('span', '', text));
    return node;
  }

  function statusOf(percent, given) {
    if (!given) return { kind: 'muted', text: "Vazifa yo'q" };
    if (percent >= 70) return { kind: 'success', text: "A'lo" };
    if (percent >= 50) return { kind: 'warn', text: 'Yaxshi' };
    return { kind: 'danger', text: 'Past' };
  }

  function badge(kind, text) {
    return el('span', `badge badge--${kind}`, text);
  }

  // Aylana ko'rinishidagi foiz
  function ring(percent, kind) {
    const size = 150;
    const stroke = 14;
    const r = (size - stroke) / 2;
    const length = 2 * Math.PI * r;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('class', 'ring__svg');
    const circle = (cls, offset) => {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', size / 2);
      c.setAttribute('cy', size / 2);
      c.setAttribute('r', r);
      c.setAttribute('class', cls);
      c.setAttribute('stroke-width', stroke);
      if (offset !== undefined) {
        c.setAttribute('stroke-dasharray', length);
        c.setAttribute('stroke-dashoffset', offset);
      }
      return c;
    };
    svg.append(circle('ring__track'), circle('ring__value', length * (1 - Math.min(percent, 100) / 100)));
    const wrap = el('div', `ring ring--${kind}`);
    wrap.append(svg);
    return wrap;
  }

  function daysLeftInMonth() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate();
  }

  // ---------------- Bloklar ----------------
  function renderHeader(p) {
    const card = el('section', 'card profile-card');

    const left = el('div', 'profile-card__photo');
    const photo = el('div', 'profile-card__avatar');
    photo.append(avatarEl(p.name, p.avatar, 'avatar avatar--xl'));
    left.append(photo);

    if (p.can_edit) {
      const input = el('input');
      input.type = 'file';
      input.accept = 'image/png,image/jpeg,image/webp,image/gif';
      input.hidden = true;
      const camera = el('button', 'avatar-edit');
      camera.type = 'button';
      camera.title = 'Rasmni almashtirish';
      camera.setAttribute('aria-label', 'Rasmni almashtirish');
      camera.append(icon('camera'));
      camera.addEventListener('click', () => input.click());
      input.addEventListener('change', async () => {
        const file = input.files[0];
        if (!file) return;
        camera.disabled = true;
        try {
          const data = await uploadAvatar(p.is_me ? 'me' : p.id, file);
          if (p.is_me) Oyin.refreshMyAvatar?.(data.avatar);
          load(p.id);
        } catch (err) {
          camera.disabled = false;
          if (!handleAuthError(err)) window.alert(err.message);
        }
      });
      photo.append(camera, input);

      if (p.avatar) {
        const remove = el('button', 'link-btn');
        remove.type = 'button';
        remove.append(icon('trash'), el('span', '', "Rasmni o'chirish"));
        remove.addEventListener('click', async () => {
          if (!window.confirm("Rasmni o'chirasizmi?")) return;
          try {
            await api(`/api/avatar/${p.is_me ? 'me' : p.id}`, { method: 'DELETE' });
            if (p.is_me) Oyin.refreshMyAvatar?.(null);
            load(p.id);
          } catch (err) {
            if (!handleAuthError(err)) window.alert(err.message);
          }
        });
        left.append(remove);
      }
    }

    const main = el('div', 'profile-card__main');
    main.append(el('h2', '', p.name));
    const chips = el('div', 'profile-card__chips');
    chips.append(infoChip('user', 'Foydalanuvchi'));
    if (p.joined_label) chips.append(infoChip('calendar', `${p.joined_label} dan beri`));
    chips.append(infoChip('trophy', `Reytingda #${p.rank}`));
    if (p.login) chips.append(infoChip('lock', `login: ${p.login}`));
    main.append(chips);

    const side = el('div', 'profile-card__side');
    side.append(el('small', 'eyebrow', 'Joriy balans'));
    const balance = el('div', 'balance');
    balance.append(el('strong', '', formatNumber(p.total)), el('span', '', 'ball'));
    side.append(balance);
    if (p.can_edit) {
      const pw = el('button', 'btn btn--ghost');
      pw.type = 'button';
      pw.append(icon('lock'), el('span', '', p.is_me ? 'Parolni almashtirish' : 'Ism, login va parol'));
      pw.addEventListener('click', () => openPasswordDialog(p));
      side.append(pw);
    }

    card.append(left, main, side);
    return card;
  }

  function renderMonth(p) {
    const m = p.month;
    const status = statusOf(m.percent, m.given);
    const needGood = Math.ceil(m.possible * 0.5);
    const needGreat = Math.ceil(m.possible * 0.7);
    const card = el('section', 'card month-card');

    const head = el('div', 'month-card__head');
    const headIcon = el('span', 'card__icon card__icon--solid');
    headIcon.append(icon('target'));
    const titles = el('div', 'month-card__titles');
    titles.append(el('h3', '', `Uy vazifa natijasi — ${m.label}`));
    const sub = el('small');
    sub.append(icon('calendar'), el('span', '', `${m.given} ta vazifa • ${daysLeftInMonth()} kun qoldi`));
    titles.append(sub);
    head.append(headIcon, titles, badge(status.kind, status.text));

    const body = el('div', 'month-card__body');
    const ringWrap = ring(m.percent, status.kind);
    const ringText = el('div', 'ring__text');
    ringText.append(el('strong', '', `${m.percent}%`), el('small', '', `${m.earned} / ${m.possible} ball`));
    ringWrap.append(ringText);

    const right = el('div', 'month-card__right');
    const bar = el('div', 'goal-bar');
    const fill = el('div', `goal-bar__fill goal-bar__fill--${status.kind}`);
    fill.style.width = `${Math.min(m.percent, 100)}%`;
    bar.append(el('span', 'goal-bar__zone goal-bar__zone--low'), el('span', 'goal-bar__zone goal-bar__zone--mid'),
      el('span', 'goal-bar__zone goal-bar__zone--high'), fill);
    const labels = el('div', 'goal-bar__labels');
    labels.append(el('span', '', 'Past • 50% gacha'), el('span', '', 'Yaxshi • 50%+'), el('span', '', "A'lo • 70%+"));

    const stats = el('div', 'stat-row');
    const stat = (label, value, hint) => {
      const s = el('div', 'stat');
      s.append(el('small', '', label), el('strong', '', value), el('span', '', hint));
      return s;
    };
    stats.append(
      stat("Yig'ildi", m.earned, `${m.submitted}/${m.given} topshirildi`),
      stat('Yaxshi uchun', needGood, `yana ${Math.max(0, needGood - m.earned)}`),
      stat("A'lo uchun", needGreat, `yana ${Math.max(0, needGreat - m.earned)}`),
    );
    right.append(bar, labels, stats);
    body.append(ringWrap, right);

    let message;
    if (!m.given) message = "Bu oy hali uy vazifa berilmagan. Vazifa berilganda natija shu yerda chiqadi.";
    else if (m.percent >= 70) message = "Zo'r natija! Shu tarzda davom eting.";
    else if (m.percent >= 50) message = `Yaxshi! «A'lo» bo'lishi uchun yana ${Math.max(0, needGreat - m.earned)} ball kerak.`;
    else message = `Ko'proq harakat qiling: «Yaxshi» uchun yana ${Math.max(0, needGood - m.earned)} ball kerak.`;
    const left = m.given - m.submitted;
    const note = el('div', 'month-card__note');
    note.append(el('p', '', message));
    if (m.given) {
      note.append(el('small', '', left > 0
        ? `Bu oy yana ${left} ta vazifa topshirilmagan. Har bir vazifa — ${p.max_score} ballgacha.`
        : 'Bu oyning hamma vazifalari topshirilgan.'));
    }

    card.append(head, body, note);

    if (p.previous_months.length) {
      const prev = el('div', 'month-card__prev');
      prev.append(el('h4', '', 'Oldingi oylar'));
      const grid = el('div', 'month-grid');
      p.previous_months.forEach((pm) => {
        const st = statusOf(pm.percent, pm.given);
        const item = el('div', 'month-item');
        const top = el('div', 'month-item__top');
        top.append(el('span', '', pm.label), el('strong', `tone-${st.kind}`, `${pm.percent}%`));
        item.append(top, badge(st.kind, `${st.text} · ${pm.earned}/${pm.possible} ball`));
        grid.append(item);
      });
      prev.append(grid);
      card.append(prev);
    }
    return card;
  }

  function renderGame(p) {
    const g = p.game;
    const card = el('section', 'card game-stats');
    const head = el('div', 'card__head');
    const headIcon = el('span', 'card__icon');
    headIcon.append(icon('gamepad'));
    const titles = el('div');
    titles.append(el('h2', '', "Mahalla o'yini"),
      el('p', '', g ? 'Pul, yerlar, binolar va mashinalar' : "Hali o'yinga kirmagan"));
    head.append(headIcon, titles);
    card.append(head);
    if (!g) return card;

    const grid = el('div', 'game-stats__grid');
    const item = (iconName, label, value) => {
      const node = el('div', 'game-stat');
      const ic = el('span', 'game-stat__icon');
      ic.append(icon(iconName));
      const text = el('div');
      text.append(el('small', '', label), el('strong', '', value));
      node.append(ic, text);
      return node;
    };
    grid.append(
      item('coins', 'Pul', `${formatNumber(g.money)} so'm`),
      item('home', `Yerlar va binolar (${g.buildings.length} ta)`, g.buildings.length
        ? g.buildings.map((b) => (b.level ? `${b.name} (${b.level} qavat)` : b.name) + (b.home ? ' — Ota hovli' : '')).join(', ')
        : "Hali yo'q"),
      item('car', 'Mashinalar', g.car_names.length ? g.car_names.join(', ') : "Hali yo'q"),
      item('clock', 'Daromad', `+${String(Math.round(g.rate * 10) / 10).replace('.', ',')} so'm / sek`),
    );
    card.append(grid);
    return card;
  }

  // ---------------- Parol oynasi ----------------
  const dialog = document.getElementById('password-dialog');
  const pwForm = dialog.querySelector('form');
  const pwError = pwForm.querySelector('.form-error');
  const pwDone = pwForm.querySelector('[data-password-done]');
  const pwSubmit = pwForm.querySelector('button[type="submit"]');
  const currentField = pwForm.querySelector('[data-current-field]');
  const loginField = pwForm.querySelector('[data-login-field]');
  const nameField = pwForm.querySelector('[data-name-field]');
  const newLabel = pwForm.querySelector('label[for="pw-new"]');
  let pwTarget = null;

  // O'zi: hozirgi parol + yangi parol. Owner boshqaning: ism + login + yangi parol (eski parol kerak emas).
  function openPasswordDialog(p) {
    pwTarget = p;
    pwForm.reset();
    pwError.hidden = true;
    pwDone.hidden = true;
    pwSubmit.disabled = false;
    currentField.hidden = !p.is_me;
    loginField.hidden = p.is_me;
    nameField.hidden = p.is_me;
    if (!p.is_me) {
      pwForm.elements.name.value = p.name || '';
      pwForm.elements.login.value = p.login || '';
    }
    $title.textContent = p.is_me ? 'Parolni almashtirish' : 'Ism, login va parol';
    newLabel.textContent = p.is_me ? 'Yangi parol' : "Yangi parol (o'zgartirmasangiz — bo'sh qoldiring)";
    pwForm.querySelector('[data-password-for]').textContent = p.is_me
      ? 'Avval hozirgi parolingizni yozing'
      : `${p.name} — kerakli joyini o'zgartiring, eski parol kerak emas`;
    dialog.showModal();
    (p.is_me ? pwForm.elements.current : pwForm.elements.name).focus();
  }
  const $title = document.getElementById('password-title');

  dialog.querySelector('[data-dialog-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  pwForm.addEventListener('input', () => { pwError.hidden = true; });

  pwForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const current = pwForm.elements.current.value.trim();
    const name = pwForm.elements.name.value.trim();
    const login = pwForm.elements.login.value.trim();
    const next = pwForm.elements.new.value.trim();
    const repeat = pwForm.elements.repeat.value.trim();
    const fail = (message) => {
      pwError.textContent = message;
      pwError.hidden = false;
    };
    if (pwTarget.is_me) {
      if (!current) return fail('Hozirgi parolni yozing');
      if (!next) return fail('Yangi parolni yozing');
    } else {
      if (!name) return fail("Ism bo'sh bo'lmasin");
      if (!login) return fail("Login bo'sh bo'lmasin");
      if (name === pwTarget.name && login === pwTarget.login && !next) return fail("Hech narsa o'zgarmadi");
    }
    if (next !== repeat) return fail('Yangi parollar bir xil emas');

    pwSubmit.disabled = true;
    try {
      if (pwTarget.is_me) {
        await api('/api/me/password', { method: 'POST', body: { current, new: next } });
        pwDone.querySelector('span').textContent = 'Parol almashtirildi';
      } else {
        const body = { password: next };
        if (name !== pwTarget.name) body.name = name;
        if (login !== pwTarget.login) body.login = login;
        const data = await api(`/api/users/${pwTarget.id}/credentials`, { method: 'POST', body });
        const parts = [`Ism: ${data.name}`, `Login: ${data.login}`];
        if (next) parts.push(`Parol: ${next}`);
        pwDone.querySelector('span').textContent = `Saqlandi. ${parts.join(', ')}`;
        load(pwTarget.id);
      }
      pwDone.hidden = false;
      setTimeout(() => dialog.close(), pwTarget.is_me ? 1200 : 3500);
    } catch (err) {
      pwSubmit.disabled = false;
      if (!handleAuthError(err)) fail(err.message);
    }
  });

  // ---------------- Yuklash ----------------
  async function load(id) {
    const userId = Number(id);
    if (!Number.isInteger(userId) || userId < 1) {
      window.location.hash = '#rating';
      return;
    }
    if (currentId !== userId) root.replaceChildren(el('p', 'muted', 'Yuklanmoqda…'));
    currentId = userId;
    try {
      const { profile } = await api(`/api/profile/${userId}`);
      if (currentId !== userId) return;
      // Boshqaning profili ochilmaydi — server o'zinikini qaytaradi, manzilni ham to'g'rilaymiz
      if (profile.id !== userId) {
        currentId = profile.id;
        window.history.replaceState(null, '', `#profile/${profile.id}`);
      }
      root.replaceChildren(renderHeader(profile), renderMonth(profile), renderGame(profile));
      document.title = `${profile.name} — O'yin`;
    } catch (err) {
      if (!handleAuthError(err)) root.replaceChildren(el('p', 'form-error', err.message));
    }
  }

  viewLoaders.profile = load;
})();
