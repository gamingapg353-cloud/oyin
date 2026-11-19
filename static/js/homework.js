// Uy vazifa: owner vazifa beradi va topshiriqlarni ko'radi, foydalanuvchi fayl yuboradi
(() => {
  const { api, avatarEl, handleAuthError, el, icon, formatDate, viewLoaders } = window.Oyin;
  const APP = window.APP || {};
  const isOwner = APP.role === 'owner';
  const maxScore = APP.maxScore || 5;

  const listEl = document.getElementById('hw-list');
  const emptyEl = document.getElementById('hw-empty');
  if (!listEl) return;

  const openHomeworks = new Set(); // owner: qaysi vazifaning topshiriqlari ochiq

  // ---------------- Kichik bo'laklar ----------------
  function badge(kind, iconName, text) {
    const node = el('span', `badge badge--${kind}`);
    node.append(icon(iconName), el('span', '', text));
    return node;
  }

  function statusBadge(sub) {
    if (!sub) return badge('muted', 'clock', 'Topshirilmagan');
    if (sub.status === 'checking') return badge('info', 'clock', 'Tekshirilmoqda');
    if (sub.status === 'pending') return badge('warn', 'clock', 'Owner tekshiradi');
    if (sub.status === 'error') return badge('danger', 'alert', 'Xato');
    if (sub.ai_flagged && sub.graded_by === 'ai') return badge('danger', 'bot', `AI ishlatgan — ${sub.score} ball`);
    return badge('success', 'check', sub.graded_by === 'owner' ? 'Owner baholadi' : 'Tekshirildi');
  }

  function iconButton(iconName, label, extraClass = '') {
    const btn = el('button', `icon-btn ${extraClass}`.trim());
    btn.type = 'button';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.append(icon(iconName));
    return btn;
  }

  function textButton(iconName, label, className) {
    const btn = el('button', className);
    btn.type = 'button';
    btn.append(icon(iconName), el('span', '', label));
    return btn;
  }

  function sizeText(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function fileChips(sub) {
    const wrap = el('div', 'file-chips');
    sub.files.forEach((name, index) => {
      const link = el('a', 'file-chip');
      link.href = `/api/submissions/${sub.id}/files/${index}`;
      link.setAttribute('download', name);
      link.title = 'Yuklab olish';
      link.append(icon('download'), el('span', '', name));
      wrap.append(link);
    });
    return wrap;
  }

  // Owner biriktirgan vazifa fayllari
  // Brauzer papkani 0 baytli "fayl" qilib beradi va uni yubora olmaydi ("Server bilan aloqa yo'q").
  // Shuning uchun oldindan tushunarli xabar ko'rsatamiz.
  function folderProblem(files) {
    const bad = [...files].find((file) => file.size === 0);
    if (!bad) return '';
    return `«${bad.name}» — papka yoki bo'sh fayl. Papkani yuborib bo'lmaydi: uni ZIP qiling `
      + "(papka ustida o'ng tugma → «Отправить» / «Send to» → «Сжатая ZIP-папка») yoki ichidagi fayllarni tanlang.";
  }

  // Vazifa havolasi (masalan, Figma maketi) — yangi oynada ochiladi
  function taskLink(hw) {
    if (!hw.link || !/^https?:\/\//i.test(hw.link)) return document.createDocumentFragment();
    const a = el('a', 'btn btn--ghost hw__link');
    a.href = hw.link;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    let host = '';
    try { host = new URL(hw.link).hostname.replace(/^www\./, ''); } catch { /* e'tiborsiz */ }
    a.append(icon('link'), el('span', '', host.includes('figma.com') ? 'Figma maketini ochish' : `Havolani ochish (${host})`));
    return a;
  }

    function taskFiles(hw) {
    if (!hw.files || !hw.files.length) return document.createDocumentFragment();
    const wrap = el('div', 'task-files');
    wrap.append(el('small', '', 'Vazifa fayli:'));
    const chips = el('div', 'file-chips');
    hw.files.forEach((name, index) => {
      const link = el('a', 'file-chip file-chip--task');
      link.href = `/api/homeworks/${hw.id}/files/${index}`;
      link.setAttribute('download', name);
      link.title = 'Yuklab olish';
      link.append(icon('download'), el('span', '', name));
      chips.append(link);
    });
    wrap.append(chips);
    return wrap;
  }

  // AI fikri, AI ehtimoli, xato yoki kutish xabari
  function details(sub) {
    const frag = document.createDocumentFragment();

    if (sub.status === 'error') {
      const msg = el('p', 'sub__msg sub__msg--error');
      msg.append(icon('alert'), el('span', '', isOwner
        ? `AI tekshira olmadi: ${sub.error || 'noma’lum xato'}`
        : `Tekshirishda xato bo'ldi: ${sub.error || 'noma’lum xato'}`));
      frag.append(msg);
      if (!isOwner && APP.aiEnabled) {
        // Fayl saqlangan — qayta yuklamasdan qayta tekshirish
        const retry = textButton('refresh', 'Qayta tekshirish', 'btn btn--primary');
        retry.addEventListener('click', async () => {
          retry.disabled = true;
          retry.querySelector('span').textContent = 'AI tekshirmoqda… (1–3 daqiqa)';
          try {
            await api(`/api/submissions/${sub.id}/retry`, { method: 'POST' });
          } catch (err) {
            if (handleAuthError(err)) return;
          }
          await load();
        });
        frag.append(retry);
      }
      return frag;
    }
    if (sub.status === 'pending') {
      const msg = el('p', 'sub__msg');
      msg.append(icon('clock'), el('span', '', isOwner
        ? 'AI kaliti yo’q — ballni o’zingiz qo’ying.'
        : 'Ishingiz qabul qilindi. Owner tekshirib ball qo’yadi.'));
      frag.append(msg);
    }
    if (sub.feedback) frag.append(el('p', 'sub__feedback', sub.feedback));
    if (sub.mistakes && sub.mistakes.length) {
      const box = el('div', 'mistakes');
      const title = el('strong', 'mistakes__title');
      title.append(icon('alert'), el('span', '', `Topilgan xatolar: ${sub.mistakes.length} ta`));
      const list = el('ol', 'mistakes__list');
      sub.mistakes.forEach((text) => list.append(el('li', '', text)));
      box.append(title, list);
      frag.append(box);
    } else if (sub.status === 'checked' && sub.graded_by === 'ai' && !sub.ai_flagged) {
      const ok = el('p', 'sub__msg sub__msg--ok');
      ok.append(icon('check'), el('span', '', 'AI xato topmadi'));
      frag.append(ok);
    }
    if (sub.ai_reason) {
      const note = el('p', sub.ai_flagged ? 'ai-note ai-note--flag' : 'ai-note');
      const label = isOwner && sub.ai_probability !== null && sub.ai_probability !== undefined
        ? `AI yasagan bo'lish ehtimoli: ${sub.ai_probability}%. `
        : (sub.ai_flagged ? "AI ishlatilgan — reytingdan 5 ball ayirildi. " : 'AI tekshiruvi: ');
      note.append(icon('bot'), el('span', '', label + sub.ai_reason));
      frag.append(note);
    }
    return frag;
  }

  function scoreBox(sub) {
    const box = el('div', 'score-box');
    box.append(el('strong', '', sub.score), el('span', '', `/ ${maxScore} ball`));
    return box;
  }

  // ---------------- Foydalanuvchi: fayl yuborish ----------------
  function uploadForm(hw) {
    const form = el('form', 'upload');
    form.noValidate = true;

    const drop = el('label', 'dropzone');
    const input = el('input', 'dropzone__input');
    input.type = 'file';
    input.name = 'files';
    input.multiple = true;
    if (APP.accept) input.accept = APP.accept;
    const dropIcon = el('span', 'dropzone__icon');
    dropIcon.append(icon('upload'));
    drop.append(input, dropIcon,
      el('strong', '', 'Fayllarni tanlang yoki shu yerga tashlang'),
      el('small', '', 'HTML, CSS, JS, rasm, PDF yoki ZIP · 10 tagacha · jami 25 MB gacha'));

    const picked = el('ul', 'picked');
    const error = el('p', 'form-error');
    error.hidden = true;
    error.setAttribute('role', 'alert');
    const submitBtn = textButton('send', 'Yuborish', 'btn btn--primary');
    submitBtn.type = 'submit';
    const submitLabel = submitBtn.querySelector('span');

    function showPicked() {
      picked.replaceChildren();
      [...input.files].forEach((file) => {
        const li = el('li');
        li.append(icon('file'), el('span', '', file.name), el('small', '', sizeText(file.size)));
        picked.append(li);
      });
      error.hidden = true;
    }

    input.addEventListener('change', showPicked);
    ['dragenter', 'dragover'].forEach((type) => drop.addEventListener(type, (e) => {
      e.preventDefault();
      drop.classList.add('is-over');
    }));
    ['dragleave', 'drop'].forEach((type) => drop.addEventListener(type, (e) => {
      e.preventDefault();
      drop.classList.remove('is-over');
    }));
    drop.addEventListener('drop', (e) => {
      if (e.dataTransfer?.files?.length) {
        input.files = e.dataTransfer.files;
        showPicked();
      }
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!input.files.length) {
        error.textContent = 'Avval fayl tanlang';
        error.hidden = false;
        return;
      }
      const bad = folderProblem(input.files);
      if (bad) {
        error.textContent = bad;
        error.hidden = false;
        return;
      }
      const data = new FormData();
      [...input.files].forEach((file) => data.append('files', file));

      form.classList.add('is-busy');
      submitBtn.disabled = true;
      input.disabled = true;
      submitLabel.textContent = APP.aiEnabled ? 'AI faylni ochib tekshirmoqda… (1–3 daqiqa)' : 'Yuborilmoqda…';
      try {
        await api(`/api/homeworks/${hw.id}/submit`, { method: 'POST', form: data });
        await load();
      } catch (err) {
        if (handleAuthError(err)) return;
        error.textContent = err.message;
        error.hidden = false;
        form.classList.remove('is-busy');
        submitBtn.disabled = false;
        input.disabled = false;
        submitLabel.textContent = 'Yuborish';
      }
    });

    form.append(drop, picked, error, submitBtn);
    return form;
  }

  function homeworkHead(hw, subtitle, right) {
    const head = el('header', 'hw__head');
    const headIcon = el('span', 'card__icon');
    headIcon.append(icon('book'));
    const titles = el('div', 'hw__titles');
    titles.append(el('h3', '', hw.title), el('small', '', subtitle));
    if (hw.deadline) {
      const dl = new Date(hw.deadline);
      const late = dl < new Date();
      const pad = (n) => String(n).padStart(2, '0');
      titles.append(el('small', `hw__deadline${late ? ' is-late' : ''}`,
        `⏰ Muddat: ${pad(dl.getDate())}.${pad(dl.getMonth() + 1)} ${pad(dl.getHours())}:${pad(dl.getMinutes())}${late ? " — o'tgan (topshirsa −1)" : ' (vaqtida topshirsa +1)'}`));
    }
    head.append(headIcon, titles, right);
    return head;
  }

  function renderUserHomework(hw) {
    const sub = hw.submission;
    const card = el('article', 'card hw');
    card.append(homeworkHead(hw, formatDate(hw.created_at), statusBadge(sub)));
    if (hw.description) card.append(el('p', 'hw__desc', hw.description));
    card.append(taskLink(hw), taskFiles(hw));

    if (sub && sub.status !== 'error') {
      const result = el('div', 'result');
      if (sub.status === 'checked') result.append(scoreBox(sub));
      const body = el('div', 'result__body');
      body.append(details(sub), fileChips(sub));
      result.append(body);
      card.append(result);
    } else {
      if (sub) card.append(details(sub));
      card.append(uploadForm(hw));
    }
    return card;
  }

  // ---------------- Owner: topshiriqlarni ko'rish va baholash ----------------
  function renderOwnerSub(sub, hw, wrap) {
    const row = el('div', 'sub');

    const top = el('div', 'sub__top');
    const avatar = avatarEl(sub.user_name, sub.user_avatar);
    const who = el('div', 'sub__who');
    who.append(el('strong', '', sub.user_name), el('small', '', formatDate(sub.created_at)));
    top.append(avatar, who, statusBadge(sub));
    if (sub.status === 'checked') top.append(el('span', 'pill score', `${sub.score}/${maxScore}`));
    if (sub.copy_score) {
      top.append(el('span', 'badge badge--danger', `⚠ ${sub.copy_score}% o'xshash: ${sub.copy_of}`));
    }
    row.append(top, details(sub), fileChips(sub));

    // Amallar: bahoni qo'lda qo'yish, AI qayta tekshirsin, o'chirish
    const actions = el('div', 'sub__actions');
    const select = el('select', 'mini-select');
    select.setAttribute('aria-label', 'Ball');
    // Xato ish uchun minus ball ham qo'yish mumkin
    for (let i = maxScore; i >= (APP.minScore ?? -maxScore); i -= 1) select.append(new Option(`${i > 0 ? '+' : ''}${i} ball`, i));
    select.value = String(sub.score);
    const saveBtn = textButton('check', 'Bahoni saqlash', 'btn btn--ghost');
    actions.append(select, saveBtn);

    let recheckBtn = null;
    if (APP.aiEnabled) {
      recheckBtn = textButton('refresh', 'AI qayta tekshirsin', 'btn btn--ghost');
      actions.append(recheckBtn);
    }
    const deleteBtn = iconButton('trash', "Topshiriqni o'chirish", 'icon-btn--sm icon-btn--danger');
    actions.append(deleteBtn);
    row.append(actions);

    const buttons = [saveBtn, recheckBtn, deleteBtn].filter(Boolean);
    const busy = (on) => buttons.forEach((b) => { b.disabled = on; });
    const replaceWith = (fresh) => row.replaceWith(renderOwnerSub(fresh, hw, wrap));

    saveBtn.addEventListener('click', async () => {
      busy(true);
      try {
        const data = await api(`/api/submissions/${sub.id}/grade`, { method: 'POST', body: { score: Number(select.value) } });
        replaceWith(data.submission);
      } catch (err) {
        busy(false);
        if (!handleAuthError(err)) window.alert(err.message);
      }
    });

    recheckBtn?.addEventListener('click', async () => {
      busy(true);
      recheckBtn.querySelector('span').textContent = 'Tekshirilmoqda… (1–3 daqiqa)';
      try {
        const data = await api(`/api/submissions/${sub.id}/recheck`, { method: 'POST' });
        replaceWith(data.submission);
      } catch (err) {
        busy(false);
        recheckBtn.querySelector('span').textContent = 'AI qayta tekshirsin';
        if (!handleAuthError(err)) window.alert(err.message);
      }
    });

    deleteBtn.addEventListener('click', async () => {
      if (!window.confirm(`${sub.user_name} topshirig'ini o'chirasizmi? Ball ham o'chadi, u qaytadan topshira oladi.`)) return;
      busy(true);
      try {
        await api(`/api/submissions/${sub.id}`, { method: 'DELETE' });
        await load();
      } catch (err) {
        busy(false);
        if (!handleAuthError(err)) window.alert(err.message);
      }
    });

    return row;
  }

  async function loadSubmissions(hw, wrap) {
    wrap.replaceChildren(el('p', 'subs__empty', 'Yuklanmoqda…'));
    try {
      const { submissions } = await api(`/api/homeworks/${hw.id}/submissions`);
      wrap.replaceChildren();
      if (!submissions.length) wrap.append(el('p', 'subs__empty', 'Hali hech kim topshirmagan'));
      submissions.forEach((sub) => wrap.append(renderOwnerSub(sub, hw, wrap)));
    } catch (err) {
      if (!handleAuthError(err)) wrap.replaceChildren(el('p', 'subs__empty', err.message));
    }
  }

  function renderOwnerHomework(hw) {
    const card = el('article', 'card hw');
    const del = iconButton('trash', "Vazifani o'chirish", 'icon-btn--sm icon-btn--danger');
    card.append(homeworkHead(hw, `${formatDate(hw.created_at)} · ${hw.submission_count} ta topshirildi`, del));
    if (hw.description) card.append(el('p', 'hw__desc', hw.description));
    card.append(taskLink(hw), taskFiles(hw));

    const toggle = textButton('chevron-down', `Topshiriqlar (${hw.submission_count})`, 'btn btn--ghost hw__toggle');
    const subs = el('div', 'subs');
    const setOpen = (open) => {
      subs.hidden = !open;
      toggle.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      if (open) {
        openHomeworks.add(hw.id);
        loadSubmissions(hw, subs);
      } else {
        openHomeworks.delete(hw.id);
      }
    };
    toggle.addEventListener('click', () => setOpen(subs.hidden));
    setOpen(openHomeworks.has(hw.id));
    card.append(toggle, subs);

    del.addEventListener('click', async () => {
      if (!window.confirm(`«${hw.title}» vazifasini o'chirasizmi? Barcha topshiriqlar va ulardan olingan ballar ham o'chadi.`)) return;
      del.disabled = true;
      try {
        await api(`/api/homeworks/${hw.id}`, { method: 'DELETE' });
        openHomeworks.delete(hw.id);
        await load();
      } catch (err) {
        del.disabled = false;
        if (!handleAuthError(err)) window.alert(err.message);
      }
    });
    return card;
  }

  // ---------------- Ro'yxatni yuklash ----------------
  async function load() {
    try {
      const { homeworks } = await api('/api/homeworks');
      listEl.replaceChildren(...homeworks.map((hw) => (isOwner ? renderOwnerHomework(hw) : renderUserHomework(hw))));
      emptyEl.hidden = homeworks.length > 0;
    } catch (err) {
      if (!handleAuthError(err)) listEl.replaceChildren(el('p', 'form-error', err.message));
    }
  }

  // ---------------- Owner: yangi vazifa ----------------
  if (isOwner) {
    const form = document.getElementById('hw-form');
    const errorEl = form.querySelector('.form-error');
    const submitBtn = form.querySelector('button[type="submit"]');
    const fileInput = form.elements.files;
    const picked = form.querySelector('[data-hw-picked]');
    form.addEventListener('input', () => { errorEl.hidden = true; });

    function showPicked() {
      picked.replaceChildren();
      [...fileInput.files].forEach((file) => {
        const li = el('li');
        li.append(icon('file'), el('span', '', file.name), el('small', '', sizeText(file.size)));
        picked.append(li);
      });
    }
    fileInput.addEventListener('change', showPicked);
    const drop = fileInput.closest('.dropzone');
    ['dragenter', 'dragover'].forEach((type) => drop.addEventListener(type, (e) => {
      e.preventDefault();
      drop.classList.add('is-over');
    }));
    ['dragleave', 'drop'].forEach((type) => drop.addEventListener(type, (e) => {
      e.preventDefault();
      drop.classList.remove('is-over');
    }));
    drop.addEventListener('drop', (e) => {
      if (e.dataTransfer?.files?.length) {
        fileInput.files = e.dataTransfer.files;
        showPicked();
      }
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const title = form.elements.title.value.trim();
      const description = form.elements.description.value.trim();
      if (!title) {
        errorEl.textContent = 'Vazifa nomini yozing';
        errorEl.hidden = false;
        form.elements.title.focus();
        return;
      }
      const bad = folderProblem(fileInput.files);
      if (bad) {
        errorEl.textContent = bad;
        errorEl.hidden = false;
        return;
      }
      const data = new FormData();
      data.append('title', title);
      data.append('description', description);
      const link = form.elements.link ? form.elements.link.value.trim() : '';
      if (link && !/^https?:\/\/\S+$/i.test(link)) {
        errorEl.textContent = "Havola https:// bilan boshlansin (masalan, Figma linki)";
        errorEl.hidden = false;
        form.elements.link.focus();
        return;
      }
      if (link) data.append('link', link);
      const deadline = form.elements.deadline ? form.elements.deadline.value : '';
      if (deadline) data.append('deadline', deadline);
      [...fileInput.files].forEach((file) => data.append('files', file));
      submitBtn.disabled = true;
      try {
        await api('/api/homeworks', { method: 'POST', form: data });
        form.reset();
        picked.replaceChildren();
        await load();
      } catch (err) {
        if (!handleAuthError(err)) {
          errorEl.textContent = err.message;
          errorEl.hidden = false;
        }
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  viewLoaders.homework = load;
})();
