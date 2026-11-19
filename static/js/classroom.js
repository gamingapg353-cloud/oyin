// Panel: qo'ng'iroq (bildirishnomalar), kim kirgani (owner), ball sovg'asi,
// «Ball berish» (davomat + dars savollari, owner) va «Dars savollari» (o'quvchi)
(() => {
  const Oyin = window.Oyin;
  const { api, handleAuthError, el, icon, avatarEl, viewLoaders } = Oyin;
  const APP = window.APP || {};
  const isOwner = APP.role === 'owner';
  const $ = (id) => document.getElementById(id);

  function ago(t) {
    const s = Math.max(0, Math.floor(Date.now() / 1000 - t));
    if (s < 60) return 'hozirgina';
    if (s < 3600) return `${Math.floor(s / 60)} daqiqa oldin`;
    if (s < 86400) return `${Math.floor(s / 3600)} soat oldin`;
    return `${Math.floor(s / 86400)} kun oldin`;
  }

  // Tepadagi ochiladigan oynachalar (qo'ng'iroq, kirganlar)
  function popup(btn, menuEl, onOpen) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = menuEl.hidden;
      document.querySelectorAll('.pop__menu').forEach((m) => { m.hidden = true; });
      menuEl.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      if (open) onOpen();
    });
    document.addEventListener('click', (e) => {
      if (!menuEl.hidden && !menuEl.contains(e.target)) {
        menuEl.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // ---------------- Qo'ng'iroq ----------------
  const bellBtn = $('bell-btn');
  const bellMenu = $('bell-menu');
  const bellBadge = $('bell-badge');
  let bellItems = [];

  function renderBell() {
    bellMenu.replaceChildren(el('div', 'menu__head'));
    bellMenu.firstChild.append(el('strong', '', 'Bildirishnomalar'),
      el('small', '', "O'yinda @ismingiz yozilsa, test yoki savollar boshlansa — shu yerga keladi"));
    if (!bellItems.length) bellMenu.append(el('p', 'bell__empty', "Hozircha xabar yo'q"));
    bellItems.forEach((n) => {
      const item = el(n.link ? 'a' : 'div', `bell__item${n.seen ? '' : ' is-new'}`);
      if (n.link) item.href = n.link;
      item.append(el('span', '', n.text), el('small', '', ago(n.t)));
      item.addEventListener('click', () => { bellMenu.hidden = true; });
      bellMenu.append(item);
    });
  }

  async function loadBell(markRead = false) {
    try {
      const d = await api('/api/notifications');
      bellItems = d.items;
      bellBadge.hidden = !d.unread;
      bellBadge.textContent = d.unread > 9 ? '9+' : String(d.unread);
      if (markRead && d.unread) {
        await api('/api/notifications/read', { method: 'POST' });
        bellBadge.hidden = true;
      }
      if (!bellMenu.hidden) renderBell();
    } catch (err) {
      handleAuthError(err);
    }
  }
  if (bellBtn) {
    popup(bellBtn, bellMenu, () => { renderBell(); loadBell(true); });
    loadBell();
    setInterval(() => loadBell(), 20000);
  }

  // ---------------- Kim kirgan (owner) ----------------
  if (isOwner && $('online-btn')) {
    const menuEl = $('online-menu');
    let data = null;
    const render = () => {
      menuEl.replaceChildren(el('div', 'menu__head'));
      menuEl.firstChild.append(el('strong', '', `Hozir kirganlar: ${data ? data.accounts.length : 0}`),
        el('small', '', "Birinchi kirgan qurilma — asosiy. Boshqa qurilmadan uy sotsa yoki sovg'a qilsa — himoya chiqarib yuboradi"));
      if (!data) return;
      if (!data.accounts.length) menuEl.append(el('p', 'bell__empty', "Hozir hech kim kirmagan"));
      data.accounts.forEach((a) => {
        const row = el('div', `online-acc${a.shared ? ' is-shared' : ''}`);
        const head = el('div', 'online-acc__head');
        head.append(el('strong', '', a.name), el('span', 'pill', `${a.devices.length} qurilma`));
        row.append(head);
        a.devices.forEach((d) => {
          const ok = d.primary || d.trusted;
          row.append(el('small', ok ? '' : 'online-acc__other',
            `${d.primary ? '✓ Asosiy' : d.trusted ? "✓ O'zining akkaunti" : '⚠ Boshqa qurilma'} · ${d.label} · ${ago(Date.now() / 1000 - d.ago)}`));
          if (d.primary) return;
          // Owner tasdiqlasa — bu qurilmaga ham hamma narsa ruxsat (uy sotish, sovg'a, ball)
          const b = el('button', d.trusted ? 'link-btn' : 'btn btn--primary btn--sm online-acc__trust',
            d.trusted ? 'Tasdiqni bekor qilish' : "✓ O'zining akkaunti");
          b.type = 'button';
          b.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
              await api('/api/devices/trust', { method: 'POST', body: { id: d.id, trusted: !d.trusted } });
            } catch (err) {
              if (!handleAuthError(err)) window.alert(err.message);
            }
            load();
          });
          row.append(b);
        });
        if (a.shared) {
          const reset = el('button', 'link-btn', "Qurilmalarni tozalash (yangi telefon bo'lsa)");
          reset.type = 'button';
          reset.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!window.confirm(`${a.name}: qurilmalar tozalansinmi? Keyingi kirgan qurilma asosiy bo'ladi.`)) return;
            await api('/api/devices/reset', { method: 'POST', body: { key: a.key } }).catch(() => null);
            load();
          });
          row.append(reset);
        }
        menuEl.append(row);
      });
      if (data.log.length) {
        menuEl.append(el('div', 'menu__sep'), el('small', 'online-log__title', 'Himoya tarixi'));
        const names = { sell: 'uy sotmoqchi bo\'ldi', gift: "sovg'a qilmoqchi bo'ldi", points: 'ball bermoqchi bo\'ldi' };
        data.log.forEach((l) => menuEl.append(el('small', 'online-log', `🛡️ ${l.name} — ${names[l.action] || l.action} · ${ago(l.t)}`)));
      }
    };
    async function load() {
      try {
        data = await api('/api/online-accounts');
        $('online-count').textContent = data.accounts.length;
        $('online-warn').hidden = !data.accounts.some((a) => a.shared);
        if (!menuEl.hidden) render();
      } catch (err) {
        handleAuthError(err);
      }
    }
    popup($('online-btn'), menuEl, () => { render(); load(); });
    load();
    setInterval(load, 30000);
  }

  // ---------------- Ball sovg'asi (reytingda) ----------------
  Oyin.giftPoints = async (user, reload) => {
    const raw = window.prompt(`${user.name}ga necha ball sovg'a qilasiz? (o'z ballingizdan, 1–100)`, '1');
    if (raw === null) return;
    const amount = Math.trunc(Number(raw));
    if (!Number.isFinite(amount) || amount < 1 || amount > 100) {
      window.alert("1 dan 100 gacha son yozing");
      return;
    }
    try {
      const d = await api('/api/points/gift', { method: 'POST', body: { to: user.id, amount } });
      window.alert(`${d.to}ga ${d.amount} ball sovg'a qildingiz! Sizda qoldi: ${d.my_total} ball`);
      reload();
    } catch (err) {
      if (!handleAuthError(err)) window.alert(err.message);
    }
  };

  // ---------------- Ball berish: davomat (owner) ----------------
  const WEEK = ['Du', 'Se', 'Ch', 'Pa', 'Ju', 'Sh', 'Ya'];
  // Holatlar rasm bilan: keldi — yashil belgi, kechikdi — soat, kelmadi — qizil xoch
  const STATUS = [['keldi', 'Keldi', '✅'], ['kechikdi', 'Kechikdi', '⏰'], ['kelmadi', 'Kelmadi', '❌']];
  const att = { day: null, month: null, data: null, step: 'date' };
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  async function loadAttendance(day) {
    att.day = day || att.day || iso(new Date());
    if (!att.month) att.month = att.day.slice(0, 7);
    try {
      att.data = await api(`/api/attendance?day=${att.day}`);
      // Boshqa oy ko'rilayotgan bo'lsa — o'sha oyning belgilangan kunlarini ham olamiz
      if (att.month !== att.day.slice(0, 7)) {
        const other = await api(`/api/attendance?day=${att.month}-01`);
        att.monthRecorded = other.recorded;
      } else att.monthRecorded = att.data.recorded;
      renderAttendance();
    } catch (err) {
      if (!handleAuthError(err)) window.alert(err.message);
    }
  }

  function calendar() {
    const d = att.data;
    const [y, m] = att.month.split('-').map(Number);
    const first = new Date(y, m - 1, 1);
    const days = new Date(y, m, 0).getDate();
    const box = el('div', 'card att-cal');
    const head = el('div', 'att-cal__head');
    const nav = (delta) => {
      const b = el('button', 'icon-btn');
      b.type = 'button';
      b.append(icon(delta < 0 ? 'chevron-left' : 'chevron-right'));
      b.addEventListener('click', () => {
        const nd = new Date(y, m - 1 + delta, 1);
        att.month = iso(nd).slice(0, 7);
        loadAttendance(att.day);
      });
      return b;
    };
    head.append(nav(-1), el('strong', '', `${Oyin.MONTHS[m - 1]} ${y}`), nav(1));
    const grid = el('div', 'att-cal__grid');
    WEEK.forEach((w) => grid.append(el('span', 'att-cal__wd', w)));
    const offset = (first.getDay() + 6) % 7;
    for (let i = 0; i < offset; i += 1) grid.append(el('span', ''));
    const recorded = new Set(att.monthRecorded || []);
    for (let n = 1; n <= days; n += 1) {
      const dayIso = `${att.month}-${String(n).padStart(2, '0')}`;
      const wd = (new Date(y, m - 1, n).getDay() + 6) % 7;
      const past = dayIso <= d.today;
      let cls = 'att-cal__day';
      if (recorded.has(dayIso)) cls += ' is-done';                                    // dars o'tilgan — ko'k
      else if (past && d.lesson_days.includes(wd) && dayIso !== d.today) cls += ' is-missed'; // dars kuni, belgilanmagan — qizil
      if (dayIso === att.day) cls += ' is-selected';
      if (dayIso === d.today) cls += ' is-today';
      const b = el('button', cls, String(n));
      b.type = 'button';
      b.disabled = !past;
      b.addEventListener('click', () => { att.step = 'date'; loadAttendance(dayIso); });
      grid.append(b);
    }
    const legend = el('div', 'att-cal__legend');
    legend.append(el('span', 'is-done', 'Dars bo\'lgan'), el('span', 'is-missed', 'Belgilanmay qolgan dars kuni'));
    const days2 = el('div', 'att-days');
    days2.append(el('small', '', 'Dars kunlari:'));
    WEEK.forEach((w, i) => {
      const c = el('button', `chip${d.lesson_days.includes(i) ? ' is-on' : ''}`, w);
      c.type = 'button';
      c.addEventListener('click', async () => {
        const set = new Set(d.lesson_days);
        if (set.has(i)) set.delete(i); else set.add(i);
        await api('/api/attendance/settings', { method: 'POST', body: { days: [...set] } }).catch(() => null);
        loadAttendance(att.day);
      });
      days2.append(c);
    });
    box.append(head, grid, legend, days2);
    return box;
  }

  async function saveMark(u, status, points) {
    try {
      const r = await api('/api/attendance', { method: 'POST', body: { day: att.day, user_id: u.id, status, points } });
      u.status = status;
      u.points = r.points;
      if (!att.monthRecorded.includes(att.day) && status) att.monthRecorded.push(att.day);
      renderAttendance();
    } catch (err) {
      if (!handleAuthError(err)) window.alert(err.message);
    }
  }

  function homeworkCell(h) {
    const cell = el('div', 'att-hw');
    if (!h) {
      cell.append(el('small', 'muted', "Uy vazifa topshirmagan"));
      return cell;
    }
    const label = h.status === 'checked'
      ? `${h.by === 'ai' ? '🤖 AI tekshirdi' : '👤 Owner baholadi'}: ${h.score > 0 ? '+' : ''}${h.score}`
      : (h.status === 'checking' ? '⏳ AI tekshiryapti' : (h.status === 'error' ? '⚠ Tekshirib bo\'lmadi' : '⏳ Kutilmoqda'));
    cell.append(el('strong', h.status === 'checked' && h.score < 0 ? 'att-hw__bad' : '', label), el('small', 'muted', h.title));
    return cell;
  }

  const dayTitle = (dayIso) => {
    const [y, m, dd] = dayIso.split('-').map(Number);
    return `${dd}-${Oyin.MONTHS[m - 1].toLowerCase()} ${y}`;
  };

  function renderAttendance() {
    const root = $('att-root');
    const d = att.data;
    $('att-extra').hidden = att.step !== 'date';
    if (att.step === 'date') {
      // 1-qadam: sana tanlanadi, pastda — «Ball berish» tugmasi
      const go = el('button', 'btn btn--primary btn--lg att-start');
      go.type = 'button';
      go.append(icon('star'), el('span', '', `${dayTitle(att.day)} — ball berishni boshlash`));
      go.addEventListener('click', () => {
        att.step = 'mark';
        renderAttendance();
        window.scrollTo(0, 0);
      });
      root.replaceChildren(calendar(), go);
      return;
    }
    // 2-qadam: kalendar yo'qoladi, ball berish ochiladi
    const bar = el('div', 'att-bar');
    const back = el('button', 'btn btn--ghost');
    back.type = 'button';
    back.append(icon('arrow-left'), el('span', '', "Sanani o'zgartirish"));
    back.addEventListener('click', () => { att.step = 'date'; renderAttendance(); });
    bar.append(back, el('strong', 'att-bar__day', `📅 ${dayTitle(att.day)}`));
    root.replaceChildren(bar);
    const card = el('div', 'card att-table');
    const head = el('div', 'list-card__head');
    head.append(el('h2', '', 'Davomat va ball'),
      el('span', 'list-card__hint', `✅ Keldi / ⏰ Kechikdi — 0…${d.max} ball · ❌ Kelmadi — −1 · «Boshlash» — o'quvchiga 5 ta HTML/CSS savol`));
    card.append(head);
    // Bitta bosishda — kelgan va hali savol olmaganlarning hammasiga
    const waiting = d.users.filter((u) => (u.status === 'keldi' || u.status === 'kechikdi') && !u.quiz).length;
    const all = el('button', 'btn btn--primary att-go-all');
    all.type = 'button';
    all.disabled = !waiting;
    all.append(icon('target'), el('span', '', waiting ? `Kelganlarning hammasiga boshlash (${waiting})` : 'Kelganlarning hammasiga yuborilgan'));
    all.title = "Kelgan (✅/⏰) va hali savol olmagan har bir o'quvchiga 5 ta HTML/CSS savol yuboriladi";
    all.addEventListener('click', async () => {
      all.disabled = true;
      try {
        const r = await api('/api/attendance/quiz-all', { method: 'POST', body: { day: att.day } });
        await loadAttendance(att.day);
        window.alert(`${r.sent} ta o'quvchiga savollar yuborildi 📝`);
      } catch (err) {
        all.disabled = false;
        if (!handleAuthError(err)) window.alert(err.message);
      }
    });
    card.append(all);
    if (!d.users.length) card.append(el('p', 'empty empty--inline', "Hali o'quvchi yo'q"));
    d.users.forEach((u) => {
      const row = el('div', 'att-row');
      const who = el('div', 'att-row__who');
      who.append(avatarEl(u.name, u.avatar), el('strong', '', u.name));
      const st = el('div', 'att-status');
      STATUS.forEach(([id, label, pic]) => {
        const b = el('button', `att-status__btn att-status__btn--${id}${u.status === id ? ' is-on' : ''}`);
        b.append(el('span', 'att-status__pic', pic), el('small', '', label));
        b.title = label;
        b.setAttribute('aria-label', label);
        b.type = 'button';
        b.addEventListener('click', () => saveMark(u, u.status === id ? null : id, u.status === id ? 0 : Math.max(0, u.points || 0)));
        st.append(b);
      });
      const pts = el('div', 'att-points');
      if (u.status === 'kelmadi') pts.append(el('strong', 'att-points__minus', '−1 ball'));
      else {
        // Ball — kalendar kunlariga o'xshash tugmalar (0…5), tanlangani sariq hoshiyali
        const scale = el('div', 'att-pts');
        for (let i = 0; i <= d.max; i += 1) {
          const b = el('button', `att-pt${Math.max(0, u.points || 0) === i && u.status ? ' is-selected' : ''}${i > 0 && i <= (u.points || 0) && u.status ? ' is-filled' : ''}`, String(i));
          b.type = 'button';
          b.disabled = !u.status;
          b.title = u.status ? `${i} ball` : 'Avval ✅ yoki ⏰ ni bosing';
          b.addEventListener('click', () => saveMark(u, u.status, i));
          scale.append(b);
        }
        pts.append(scale);
        const go = el('button', 'btn btn--primary att-go');
        go.type = 'button';
        go.disabled = !u.status;
        const q = u.quiz;
        go.append(icon('target'), el('span', '', q && q.status !== 'done' ? 'Yuborilgan' : 'Boshlash'));
        go.title = "O'quvchiga 5 ta HTML/CSS savol yuboriladi — to'g'ri javoblar soni ball bo'ladi";
        go.addEventListener('click', async () => {
          try {
            await api('/api/attendance/quiz', { method: 'POST', body: { day: att.day, user_id: u.id } });
            loadAttendance(att.day);
          } catch (err) {
            if (!handleAuthError(err)) window.alert(err.message);
          }
        });
        pts.append(go);
        if (q) {
          const marks = el('span', 'att-marks');
          q.marks.forEach((mk) => marks.append(el('span', mk === null ? '' : (mk ? 'is-ok' : 'is-bad'), mk === null ? '·' : (mk ? '✓' : '✗'))));
          pts.append(marks);
        }
      }
      row.append(who, st, pts, homeworkCell(u.homework));
      card.append(row);
    });
    root.append(card);
  }

  if (isOwner) {
    viewLoaders.attendance = () => {
      loadAttendance();
      Oyin.loadPeople?.();
    };
    // O'quvchi savollarga javob berayotgan bo'lsa — ✓/✗ va ball o'zi yangilanib turadi
    setInterval(async () => {
      const view = document.querySelector('.view[data-view="attendance"]');
      if (!view || view.hidden || document.hidden || att.step !== 'mark' || !att.data) return;
      if (!att.data.users.some((u) => u.quiz && u.quiz.status !== 'done')) return;
      try {
        const fresh = await api(`/api/attendance?day=${att.day}`);
        if (JSON.stringify(fresh.users) === JSON.stringify(att.data.users)) return;
        att.data = fresh;
        renderAttendance();
      } catch { /* keyingi safar */ }
    }, 4000);
  }

  // ---------------- Dars savollari (o'quvchi) ----------------
  const lesson = { quiz: null, last: null };
  async function loadLesson() {
    try {
      lesson.quiz = (await api('/api/lesson-quiz')).quiz;
      renderLesson();
    } catch (err) {
      handleAuthError(err);
    }
  }
  function renderLesson() {
    const root = $('lesson-root');
    if (!root) return;
    root.replaceChildren();
    const card = el('div', 'card lesson-card');
    const q = lesson.quiz;
    if (lesson.last && lesson.last.done) {
      card.append(el('h2', '', 'Savollar tugadi! 🎉'),
        el('p', '', `${lesson.last.score} / ${lesson.last.total} to'g'ri — shuncha ball reytingga qo'shildi.`));
      root.append(card);
      return;
    }
    if (!q) {
      card.append(el('h2', '', 'Hozircha savol yo\'q'), el('p', 'muted', "Ustoz «Boshlash» ni bosganda shu yerda 5 ta HTML/CSS savol chiqadi."));
      root.append(card);
      return;
    }
    if (q.status === 'sent') {
      card.append(el('span', 'badge badge--info', '📝 Dars savollari'), el('h2', '', `Ustoz sizga ${q.count} ta savol yubordi`),
        el('p', '', `HTML va CSS bo'yicha ${q.count} ta savol. Har bir to'g'ri javob — 1 ball (bugungi darsga yoziladi). Javobni o'zgartirib bo'lmaydi.`));
      const go = el('button', 'btn btn--primary btn--lg', 'Boshlash');
      go.type = 'button';
      go.addEventListener('click', async () => {
        try {
          lesson.quiz = (await api(`/api/lesson-quiz/${q.id}/begin`, { method: 'POST' })).quiz;
          Oyin.hideLessonBanner?.();
          renderLesson();
        } catch (err) {
          if (!handleAuthError(err)) window.alert(err.message);
        }
      });
      card.append(go);
      root.append(card);
      return;
    }
    const cur = q.question;
    card.append(el('small', 'muted', `${q.index + 1} / ${q.count} · ${cur.topic}`), el('h2', 'lesson-q', cur.question));
    if (lesson.last && !lesson.last.done) {
      card.prepend(el('p', lesson.last.correct ? 'lesson-res is-ok' : 'lesson-res is-bad',
        lesson.last.correct ? "✓ To'g'ri! +1 ball" : `✗ Noto'g'ri. ${lesson.last.explain || ''}`));
    }
    const opts = el('div', 'lesson-opts');
    cur.options.forEach((o, i) => {
      const b = el('button', 'lesson-opt', o);
      b.type = 'button';
      b.addEventListener('click', async () => {
        opts.querySelectorAll('button').forEach((x) => { x.disabled = true; });
        try {
          const r = await api(`/api/lesson-quiz/${q.id}/answer`, { method: 'POST', body: { choice: i } });
          lesson.last = r;
          lesson.quiz = r.quiz;
          renderLesson();
        } catch (err) {
          if (!handleAuthError(err)) window.alert(err.message);
        }
      });
      opts.append(b);
    });
    card.append(opts);
    root.append(card);
  }
  if (!isOwner) viewLoaders.lesson = () => { lesson.last = null; loadLesson(); };
})();
