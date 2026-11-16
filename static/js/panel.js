// Panel: bo'limlar, chap menyu, hisob menyusi, "O'yinlar", "Reyting", "Odam qo'shish" va "Ball berish"
(() => {
  const Oyin = window.Oyin;
  const { api, handleAuthError, el, icon, avatarEl, setAvatar, uploadAvatar, viewLoaders } = Oyin;
  const APP = window.APP || {};
  const isOwner = APP.role === 'owner';

  const views = [...document.querySelectorAll('.view')];
  const links = [...document.querySelectorAll('.nav__link')];
  const titleEl = document.getElementById('view-title');

  // ---------------- Chap menyu (telefonda) ----------------
  const openSidebar = () => document.body.classList.add('sidebar-open');
  const closeSidebar = () => document.body.classList.remove('sidebar-open');
  document.querySelector('[data-open-sidebar]').addEventListener('click', openSidebar);
  document.querySelector('[data-close-sidebar]').addEventListener('click', closeSidebar);

  // ---------------- Bo'limlar: #games, #homework, #add-user, #rating, #profile/5 ----------------
  function showView(hash) {
    const [name, param] = hash.split('/');
    const view = views.find((v) => v.dataset.view === name) || views[0];
    views.forEach((v) => { v.hidden = v !== view; });
    links.forEach((link) => {
      const active = link.dataset.view === view.dataset.view;
      link.classList.toggle('is-active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    titleEl.textContent = view.dataset.title;
    document.title = `${view.dataset.title} — O'yin`;
    closeSidebar();
    closeMenu();
    window.scrollTo(0, 0);
    viewLoaders[view.dataset.view]?.(param);
  }

  // ---------------- Hisob menyusi (yuqori o'ng burchak) ----------------
  const accountBtn = document.getElementById('account-btn');
  const menu = document.getElementById('account-menu');
  const avatarInput = document.getElementById('avatar-input');
  const removeAvatarBtn = menu.querySelector('[data-avatar-remove]');
  const myAvatar = document.getElementById('my-avatar');

  function openMenu() {
    menu.hidden = false;
    accountBtn.setAttribute('aria-expanded', 'true');
    menu.querySelector('.menu__item')?.focus();
  }
  function closeMenu() {
    if (menu.hidden) return;
    menu.hidden = true;
    accountBtn.setAttribute('aria-expanded', 'false');
  }
  accountBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) openMenu(); else closeMenu();
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!menu.hidden) {
      closeMenu();
      accountBtn.focus();
    }
    closeSidebar();
  });
  menu.querySelectorAll('a.menu__item').forEach((a) => a.addEventListener('click', closeMenu));

  // O'zimning rasmimni hamma joyda yangilash
  Oyin.refreshMyAvatar = (url) => {
    APP.avatar = url;
    setAvatar(myAvatar, APP.name, url);
    removeAvatarBtn.hidden = !url;
  };

  menu.querySelector('[data-avatar-change]').addEventListener('click', () => {
    closeMenu();
    avatarInput.click();
  });
  avatarInput.addEventListener('change', async () => {
    const file = avatarInput.files[0];
    avatarInput.value = '';
    if (!file) return;
    try {
      const data = await uploadAvatar('me', file);
      Oyin.refreshMyAvatar(data.avatar);
      refreshCurrentView();
    } catch (err) {
      if (!handleAuthError(err)) window.alert(err.message);
    }
  });
  removeAvatarBtn.addEventListener('click', async () => {
    closeMenu();
    if (!window.confirm("Rasmingizni o'chirasizmi?")) return;
    try {
      await api('/api/avatar/me', { method: 'DELETE' });
      Oyin.refreshMyAvatar(null);
      refreshCurrentView();
    } catch (err) {
      if (!handleAuthError(err)) window.alert(err.message);
    }
  });

  function refreshCurrentView() {
    const [name, param] = window.location.hash.slice(1).split('/');
    if (name === 'rating' || name === 'profile') viewLoaders[name]?.(param);
  }

  // ---------------- Chiqish ----------------
  document.getElementById('logout-btn').addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST' }); } finally { window.location.href = '/'; }
  });

  // ---------------- O'yinlar: nechta odam o'ynayapti ----------------
  const onlineEl = document.getElementById('game-online');
  viewLoaders.games = async () => {
    try {
      const { online } = await api('/api/game/online');
      onlineEl.textContent = online ? `O'yinda hozir: ${online} kishi` : "Hozir o'yinda hech kim yo'q";
      onlineEl.classList.toggle('is-live', online > 0);
    } catch (err) {
      handleAuthError(err);
    }
  };

  // ---------------- Reyting (hamma uchun) ----------------
  const ratingList = document.getElementById('rating-list');
  const ratingEmpty = document.getElementById('rating-empty');
  const ratingCount = document.getElementById('rating-count');

  function renderRating(users) {
    ratingList.replaceChildren();
    ratingCount.textContent = users.length;
    ratingEmpty.hidden = users.length > 0;

    users.forEach((user, index) => {
      const place = index + 1;
      const li = el('li', user.me ? 'user-row is-me' : 'user-row');

      // O'rin: 1-3 o'rin (ball bo'lsa) — medal, qolganlari — raqam
      const rank = el('span', 'rank');
      if (place <= 3 && user.score > 0) {
        rank.classList.add(`rank--${place}`);
        rank.append(icon('medal'));
        rank.title = `${place}-o'rin`;
      } else {
        rank.textContent = place;
      }

      // Ism ustiga bosilsa — profil ochiladi. Oddiy foydalanuvchi faqat o'z profiliga kiradi.
      const link = el('a', 'user-row__link');
      link.href = `#profile/${isOwner ? user.id : APP.id}`;
      link.title = isOwner || user.me ? 'Profilni ochish' : "O'z profilingizni ochish";
      const info = el('span', 'user-row__info');
      const nameLine = el('span', 'user-row__name');
      nameLine.append(el('strong', '', user.name));
      if (user.me) nameLine.append(el('span', 'me-tag', 'Siz'));
      info.append(nameLine);
      if (isOwner && user.login) info.append(el('small', '', `login: ${user.login}`));
      link.append(avatarEl(user.name, user.avatar), info, el('span', 'pill score', `${user.score} ball`));

      li.append(rank, link);

      if (isOwner) {
        const del = el('button', 'icon-btn user-row__delete');
        del.type = 'button';
        del.title = "O'chirish";
        del.setAttribute('aria-label', `${user.name} — o'chirish`);
        del.append(icon('trash'));
        del.addEventListener('click', () => deleteUser(user, del));
        li.append(del);
      }

      ratingList.append(li);
    });
  }

  async function loadRating() {
    try {
      const data = await api('/api/rating');
      renderRating(data.users);
      return data.users;
    } catch (err) {
      if (!handleAuthError(err)) window.alert(err.message);
      return [];
    }
  }

  async function deleteUser(user, button) {
    if (!window.confirm(`«${user.name}» ni o'chirasizmi? U endi tizimga kira olmaydi, topshiriqlari va o'yindagi mulki ham o'chadi.`)) return;
    button.disabled = true;
    try {
      await api(`/api/users/${user.id}`, { method: 'DELETE' });
      await loadRating();
    } catch (err) {
      button.disabled = false;
      if (!handleAuthError(err)) window.alert(err.message);
    }
  }

  viewLoaders.rating = loadRating;

  // ---------------- Odam qo'shish + Ball berish (faqat owner) ----------------
  if (isOwner) {
    // ----- Odam qo'shish -----
    const form = document.getElementById('add-user-form');
    const nameInput = form.elements.name;
    const loginInput = form.elements.login;
    const passwordInput = form.elements.password;
    const errorEl = form.querySelector('.form-error');
    const submitBtn = form.querySelector('button[type="submit"]');
    const resultEl = document.getElementById('add-result');
    const copyBtn = resultEl.querySelector('[data-copy-result]');

    // Login va parol foydalanuvchi o'zi o'zgartirmaguncha ismdan avtomatik olinadi
    const touched = { login: false, password: false };
    nameInput.addEventListener('input', () => {
      const name = nameInput.value.trim();
      if (!touched.login) loginInput.value = name;
      if (!touched.password) passwordInput.value = name;
      errorEl.hidden = true;
    });
    loginInput.addEventListener('input', () => { touched.login = loginInput.value !== ''; errorEl.hidden = true; });
    passwordInput.addEventListener('input', () => { touched.password = passwordInput.value !== ''; errorEl.hidden = true; });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = nameInput.value.trim();
      const login = loginInput.value.trim() || name;
      const password = passwordInput.value.trim() || name;

      if (!name) {
        errorEl.textContent = 'Ismni kiriting';
        errorEl.hidden = false;
        nameInput.focus();
        return;
      }

      submitBtn.disabled = true;
      try {
        const data = await api('/api/users', { method: 'POST', body: { name, login, password } });
        resultEl.querySelector('[data-result-title]').textContent = `${data.user.name} qo'shildi`;
        resultEl.querySelector('[data-result-login]').textContent = data.user.login;
        resultEl.querySelector('[data-result-password]').textContent = password;
        resultEl.hidden = false;
        copyBtn.querySelector('span').textContent = 'Nusxa olish';

        form.reset();
        touched.login = false;
        touched.password = false;
        nameInput.focus();
        loadPeople(data.user.id);
      } catch (err) {
        if (!handleAuthError(err)) {
          errorEl.textContent = err.message;
          errorEl.hidden = false;
        }
      } finally {
        submitBtn.disabled = false;
      }
    });

    copyBtn.addEventListener('click', async () => {
      const login = resultEl.querySelector('[data-result-login]').textContent;
      const password = resultEl.querySelector('[data-result-password]').textContent;
      const label = copyBtn.querySelector('span');
      try {
        await navigator.clipboard.writeText(`Login: ${login}\nParol: ${password}`);
        label.textContent = 'Nusxa olindi';
      } catch {
        label.textContent = "Nusxa olib bo'lmadi";
      }
    });

    // ----- Ball berish -----
    const pointsForm = document.getElementById('points-form');
    const userSelect = pointsForm.elements.user;
    const amountInput = pointsForm.elements.amount;
    const pointsError = pointsForm.querySelector('.form-error');
    const pointsButtons = pointsForm.querySelectorAll('.btn-row .btn');
    const resetBtn = pointsForm.querySelector('[data-reset-points]');
    const pointsResult = document.getElementById('points-result');

    async function loadPeople(selectId) {
      try {
        const { users } = await api('/api/rating');
        const keep = String(selectId ?? userSelect.value ?? '');
        userSelect.replaceChildren(new Option(users.length ? 'Odamni tanlang' : "Avval odam qo'shing", ''));
        users.forEach((u) => userSelect.append(new Option(`${u.name} — ${u.score} ball`, u.id)));
        userSelect.value = keep;
        if (userSelect.value !== keep) userSelect.value = '';
      } catch (err) {
        handleAuthError(err);
      }
    }

    pointsForm.querySelectorAll('[data-amount]').forEach((chip) => {
      chip.addEventListener('click', () => {
        amountInput.value = chip.dataset.amount;
        pointsError.hidden = true;
      });
    });
    [userSelect, amountInput].forEach((input) => input.addEventListener('input', () => { pointsError.hidden = true; }));

    pointsForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const sign = Number(event.submitter?.dataset.sign || 1);
      const userId = userSelect.value;
      const amount = Math.trunc(Number(amountInput.value));

      const fail = (message, input) => {
        pointsError.textContent = message;
        pointsError.hidden = false;
        input?.focus();
      };
      if (!userId) return fail('Kimga berishni tanlang', userSelect);
      if (!Number.isFinite(amount) || amount < 1 || amount > 1000) return fail("Ball 1 dan 1000 gacha bo'lsin", amountInput);

      pointsButtons.forEach((b) => { b.disabled = true; });
      try {
        const data = await api(`/api/users/${userId}/points`, { method: 'POST', body: { amount: sign * amount } });
        const verb = sign > 0 ? `+${amount} ball berildi` : `${amount} ball ayirildi`;
        pointsResult.querySelector('[data-points-text]').textContent =
          `${data.user.name}: ${verb}. Jami: ${data.user.score} ball`;
        pointsResult.hidden = false;
        loadPeople(data.user.id);
      } catch (err) {
        if (!handleAuthError(err)) fail(err.message);
      } finally {
        pointsButtons.forEach((b) => { b.disabled = false; });
      }
    });

    // Hamma ballini ayirib tashlash — jami ball 0 bo'ladi
    resetBtn.addEventListener('click', async () => {
      const userId = userSelect.value;
      if (!userId) {
        pointsError.textContent = 'Kimning ballini ayirishni tanlang';
        pointsError.hidden = false;
        userSelect.focus();
        return;
      }
      const label = userSelect.selectedOptions[0]?.textContent || '';
      if (!window.confirm(`${label}\n\nHamma ballini ayirib tashlaysizmi? Ball 0 bo'ladi.`)) return;

      pointsButtons.forEach((b) => { b.disabled = true; });
      try {
        const data = await api(`/api/users/${userId}/points/reset`, { method: 'POST' });
        pointsResult.querySelector('[data-points-text]').textContent =
          `${data.user.name}: ${data.removed} ball ayirib tashlandi. Jami: ${data.user.score} ball`;
        pointsResult.hidden = false;
        pointsError.hidden = true;
        loadPeople(data.user.id);
      } catch (err) {
        if (!handleAuthError(err)) {
          pointsError.textContent = err.message;
          pointsError.hidden = false;
        }
      } finally {
        pointsButtons.forEach((b) => { b.disabled = false; });
      }
    });

    viewLoaders['add-user'] = () => loadPeople();
  }

  window.addEventListener('hashchange', () => showView(window.location.hash.slice(1)));
  showView(window.location.hash.slice(1));
})();
