// Panel: bosh sahifa qo'shimchalari (tug'ilgan kun, dars jadvali, oy o'quvchisi, yutuqlar devori),
// guruhlar, AI yordamchi, so'rovnoma, sovg'alar do'koni, profil qo'shimchalari
(() => {
  const Oyin = window.Oyin;
  const { api, handleAuthError, el, icon, avatarEl, viewLoaders } = Oyin;
  const APP = window.APP || {};
  const isOwner = APP.role === 'owner';
  const $ = (id) => document.getElementById(id);
  const extra = {};
  Oyin.extraLoaders = extra;
  const fail = (err) => { if (!handleAuthError(err)) window.alert(err.message); };

  function card(title, iconName, cls = '') {
    const c = el('section', `card school-card ${cls}`);
    const h = el('div', 'school-card__head');
    const i = el('span', 'card__icon');
    i.append(icon(iconName));
    h.append(i, el('h2', '', title));
    c.append(h);
    return c;
  }
  const fmtLesson = (iso) => {
    const d = new Date(iso);
    return `${d.getDate()}-${Oyin.MONTHS[d.getMonth()].toLowerCase()}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  function countdown(iso) {
    const ms = new Date(iso) - Date.now();
    if (ms <= 0) return 'boshlandi';
    const h = Math.floor(ms / 3600000);
    const dd = Math.floor(h / 24);
    return dd ? `${dd} kun ${h % 24} soatdan keyin` : `${h} soat ${Math.floor((ms % 3600000) / 60000)} daqiqadan keyin`;
  }

  // ---------------- Bosh sahifa ----------------
  extra.games = async () => {
    const root = $('home-extra');
    if (!root) return;
    try {
      const [bd, lessons, best, wall, groups] = await Promise.all([api('/api/birthdays/today'), api('/api/lessons'),
        api('/api/best-month'), api('/api/wall'), isOwner ? api('/api/groups') : Promise.resolve({ groups: [] })]);
      root.replaceChildren();
      if (bd.people.length) {
        const b = el('div', 'bday-banner');
        b.append(el('span', 'bday-banner__cake', '🎂'), el('strong', '', `Bugun ${bd.people.map((p) => p.name).join(', ')}ning tug'ilgan kuni! Tabriklang! 🎉`));
        root.append(b);
      }
      // Dars jadvali
      const sch = card('Dars jadvali', 'calendar');
      sch.append(el('p', 'muted', "Dars boshlanishiga 10 daqiqa qolganda hammaga eslatma boradi (vaqt — Toshkent bo'yicha)"));
      if (!lessons.lessons.length) sch.append(el('p', 'muted', isOwner ? "Hali dars qo'shilmagan" : "Keyingi dars hali belgilanmagan"));
      lessons.lessons.slice(0, 6).forEach((l, i) => {
        const row = el('div', `lesson-row${i === 0 ? ' is-next' : ''}`);
        const info = el('div', '');
        info.append(el('strong', '', l.topic), el('small', 'muted', `${fmtLesson(l.starts_at)}${l.group ? ` · ${l.group}` : ''}${l.weekly ? ' · har hafta' : ''} · ${countdown(l.starts_at)}`));
        row.append(el('span', 'lesson-row__dot', i === 0 ? '⏰' : '📅'), info);
        if (isOwner) {
          const del = el('button', 'icon-btn');
          del.type = 'button';
          del.title = "O'chirish";
          del.append(icon('trash'));
          del.addEventListener('click', () => api(`/api/lessons/${l.id}`, { method: 'DELETE' }).then(extra.games).catch(fail));
          row.append(del);
        }
        sch.append(row);
      });
      if (isOwner) {
        const f = el('form', 'lesson-form');
        const when = el('input', 'input-plain');
        when.type = 'datetime-local';
        when.required = true;
        const topic = el('input', 'input-plain');
        topic.placeholder = 'Mavzu (masalan: Flexbox)';
        topic.maxLength = 120;
        const grp = el('select', 'input-plain');
        grp.append(new Option('Hamma guruh', ''));
        groups.groups.forEach((g) => grp.append(new Option(g.name, g.id)));
        const add = el('button', 'btn btn--primary', "Qo'shish");
        add.type = 'submit';
        const wk = el('label', 'pick');
        const wkBox = el('input', '');
        wkBox.type = 'checkbox';
        wk.append(wkBox, el('span', '', 'Har hafta'));
        f.append(when, topic, grp, wk, add);
        f.addEventListener('submit', (e) => {
          e.preventDefault();
          api('/api/lessons', { method: 'POST', body: { starts_at: when.value, topic: topic.value, group_id: grp.value ? Number(grp.value) : null, weekly: wkBox.checked } })
            .then(extra.games).catch(fail);
        });
        sch.append(f);
      }
      root.append(sch);
      // Oy o'quvchisi
      const bm = card("Oy o'quvchisi", 'crown');
      if (best.prev) {
        const r = el('div', 'best-row');
        r.append(avatarEl(best.prev.name, best.prev.avatar), el('div', ''));
        r.lastChild.append(el('strong', '', `👑 ${best.prev.name}`), el('small', 'muted', `O'tgan oy (${best.prev.month}) — ${best.prev.score} ball`));
        bm.append(r);
      } else bm.append(el('p', 'muted', "O'tgan oy natijalari yo'q"));
      if (best.current) bm.append(el('p', 'muted', `Shu oy hozircha yetakchi: ${best.current.name} (${best.current.score} ball)`));
      root.append(bm);
      // Yutuqlar devori
      const w = card('Yutuqlar devori', 'trophy', 'wall');
      const grid = el('div', 'wall__grid');
      wall.items.forEach((it) => {
        const t = el('div', 'wall__item');
        t.append(el('span', 'wall__icon', it.icon), el('small', 'muted', it.title), el('strong', '', it.name), el('span', 'pill', it.value));
        grid.append(t);
      });
      if (!wall.items.length) grid.append(el('p', 'muted', "Hali yutuqlar yo'q — birinchi bo'ling!"));
      w.append(grid);
      root.append(w);
    } catch (err) {
      handleAuthError(err);
    }
  };

  // ---------------- Reyting: guruh bo'yicha va oy o'quvchisi tojisi ----------------
  let groupFilter = '';
  extra.rating = async () => {
    const bar = $('rating-groups');
    if (!bar) return;
    try {
      const [{ groups }, best] = await Promise.all([api('/api/groups'), api('/api/best-month')]);
      const apply = () => {
        document.querySelectorAll('#rating-list .user-row').forEach((li) => {
          li.hidden = Boolean(groupFilter) && li.dataset.group !== groupFilter;
          if (best.prev && li.dataset.uid === String(best.prev.id) && !li.querySelector('.crown-tag')) {
            li.querySelector('.user-row__name')?.append(el('span', 'crown-tag', "👑 Oy o'quvchisi"));
          }
        });
      };
      bar.replaceChildren();
      bar.hidden = !groups.length;
      [{ id: '', name: 'Hammasi' }, ...groups].forEach((g) => {
        const b = el('button', `chip${String(g.id) === groupFilter ? ' is-on' : ''}`, g.name);
        b.type = 'button';
        b.addEventListener('click', () => { groupFilter = String(g.id); extra.rating(); });
        bar.append(b);
      });
      apply();
    } catch (err) {
      handleAuthError(err);
    }
  };

  // ---------------- Guruhlarni boshqarish (owner, «Odam qo'shish» bo'limida) ----------------
  extra['add-user'] = async () => {
    const root = $('groups-card');
    if (!root || !isOwner) return;
    try {
      const [{ groups }, { users }] = await Promise.all([api('/api/groups'), api('/api/rating')]);
      root.replaceChildren();
      const head = el('div', 'card__head');
      const i = el('span', 'card__icon');
      i.append(icon('users'));
      head.append(i, el('div', ''));
      head.lastChild.append(el('h2', '', 'Guruhlar'), el('p', '', "Guruh tuzing va o'quvchilarni guruhlarga bo'ling — reyting va davomat guruh bo'yicha ko'rinadi."));
      const f = el('form', 'lesson-form');
      const name = el('input', 'input-plain');
      name.placeholder = 'Yangi guruh nomi';
      name.maxLength = 40;
      const add = el('button', 'btn btn--primary', "Qo'shish");
      add.type = 'submit';
      f.append(name, add);
      f.addEventListener('submit', (e) => {
        e.preventDefault();
        api('/api/groups', { method: 'POST', body: { name: name.value } }).then(extra['add-user']).catch(fail);
      });
      const list = el('div', 'group-list');
      groups.forEach((g) => {
        const row = el('div', 'group-row');
        row.append(el('strong', '', g.name), el('span', 'pill', `${g.count} kishi`));
        const del = el('button', 'icon-btn');
        del.type = 'button';
        del.append(icon('trash'));
        del.addEventListener('click', () => {
          if (window.confirm(`«${g.name}» guruhini o'chirasizmi? O'quvchilar o'chmaydi.`)) {
            api(`/api/groups/${g.id}`, { method: 'DELETE' }).then(extra['add-user']).catch(fail);
          }
        });
        row.append(del);
        list.append(row);
      });
      const assign = el('div', 'group-assign');
      users.forEach((u) => {
        const row = el('div', 'group-row');
        const sel = el('select', 'input-plain');
        sel.append(new Option('Guruhsiz', ''));
        groups.forEach((g) => sel.append(new Option(g.name, g.id)));
        sel.value = u.group_id ? String(u.group_id) : '';
        sel.addEventListener('change', () => api(`/api/users/${u.id}/group`, { method: 'POST', body: { group_id: sel.value ? Number(sel.value) : null } })
          .then(extra['add-user']).catch(fail));
        row.append(el('span', '', u.name), sel);
        assign.append(row);
      });
      root.append(head, f, list, groups.length ? el('strong', 'group-assign__title', "O'quvchilarni guruhga qo'shish") : '', groups.length ? assign : '');
    } catch (err) {
      handleAuthError(err);
    }
  };

  // ---------------- AI yordamchi (Uy vazifa bo'limida) ----------------
  extra.homework = () => {
    const root = $('ai-helper');
    if (!root || root.dataset.ready) return;
    root.dataset.ready = '1';
    const c = card('AI yordamchi', 'bot', 'ai-helper');
    c.append(el('p', 'muted', "Kodingizni qo'ying va savol bering — AI javobni emas, maslahat beradi, xatoni o'zingiz topasiz. Kuniga 15 ta savol."));
    const code = el('textarea', 'code-input');
    code.placeholder = '<h1>Salom</h1> ...';
    window.CodeHelp.attach(code, { mode: 'auto' });
    code.spellcheck = false;
    const q = el('input', 'input-plain');
    q.placeholder = 'Savolingiz: masalan, nega sarlavha markazda emas?';
    q.maxLength = 400;
    const go = el('button', 'btn btn--primary');
    go.type = 'button';
    go.append(icon('bot'), el('span', '', "Maslahat so'rash"));
    const out = el('div', 'ai-answer');
    out.hidden = true;
    go.addEventListener('click', async () => {
      go.disabled = true;
      out.hidden = false;
      out.textContent = 'AI o\'ylayapti…';
      try {
        const d = await api('/api/ai/hint', { method: 'POST', body: { code: code.value, question: q.value } });
        out.textContent = d.hint;
        out.append(el('small', 'muted', `Bugun yana ${d.left} ta savol bera olasiz`));
      } catch (err) {
        if (!handleAuthError(err)) out.textContent = err.message;
      }
      go.disabled = false;
    });
    c.append(code, q, go, out);
    root.append(c);
  };

  // ---------------- So'rovnoma ----------------
  async function loadPolls() {
    const root = $('polls-root');
    try {
      const d = await api('/api/polls');
      root.replaceChildren();
      if (isOwner) {
        const c = card("O'quvchilarga savol", 'message');
        const f = el('form', 'poll-form');
        const qq = el('textarea', 'input-plain');
        qq.rows = 3;
        qq.placeholder = "Savol yoki xabar yozing: masalan, keyingi darsda nimani o'rganmoqchisiz?";
        qq.maxLength = 300;
        const b = el('button', 'btn btn--primary', 'Yuborish');
        b.type = 'submit';
        f.append(qq, b, el('small', 'muted', "Hamma o'quvchiga boradi. Ular pastda javob yozadi — javoblarni faqat siz ko'rasiz."));
        f.addEventListener('submit', (e) => {
          e.preventDefault();
          api('/api/polls', { method: 'POST', body: { question: qq.value } }).then(loadPolls).catch(fail);
        });
        c.append(f);
        root.append(c);
      }
      if (!d.polls.length) root.append(el('p', 'muted', "Hali savol yo'q"));
      d.polls.forEach((p) => {
        const c = card(p.question, 'vote', p.active ? '' : 'is-closed');
        p.options.forEach((o, i) => {
          const pct = p.total ? Math.round((p.counts[i] / p.total) * 100) : 0;
          const b = el('button', `poll-opt${p.mine === i ? ' is-mine' : ''}`);
          b.type = 'button';
          b.disabled = !p.active || isOwner;
          b.style.setProperty('--pct', `${pct}%`);
          b.append(el('span', '', `${p.mine === i ? '✓ ' : ''}${o}`), el('strong', '', `${pct}% · ${p.counts[i]}`));
          b.addEventListener('click', () => api(`/api/polls/${p.id}/vote`, { method: 'POST', body: { choice: i } }).then(loadPolls).catch(fail));
          c.append(b);
        });
        if (p.options.length) c.append(el('small', 'muted', `${p.total} ta ovoz${p.active ? '' : ' · yopilgan'}`));
        else if (!isOwner) {
          // O'quvchi: pastda ustozga javob yozadi
          if (p.my_answer) c.append(el('p', 'poll-mine', `Sizning javobingiz: ${p.my_answer}`));
          if (p.active) {
            const f = el('form', 'poll-form');
            const t = el('textarea', 'input-plain');
            t.rows = 2;
            t.maxLength = 1000;
            t.placeholder = p.my_answer ? "Javobni o'zgartirish…" : 'Ustozga javob yozing…';
            const send = el('button', 'btn btn--primary', p.my_answer ? 'Yangilash' : 'Yuborish');
            send.type = 'submit';
            f.append(t, send);
            f.addEventListener('submit', (e) => {
              e.preventDefault();
              api(`/api/polls/${p.id}/answer`, { method: 'POST', body: { text: t.value } }).then(loadPolls).catch(fail);
            });
            c.append(f);
          } else c.append(el('small', 'muted', 'Savol yopilgan'));
        } else {
          // Owner: o'quvchilarning javoblari
          c.append(el('small', 'muted', `${p.answer_count} ta javob${p.active ? '' : ' · yopilgan'}`));
          const list = el('div', 'poll-answers');
          (p.answers || []).forEach((a) => {
            const r = el('div', 'poll-answer');
            const head = el('div', 'poll-answer__head');
            head.append(avatarEl(a.name, a.avatar), el('strong', '', a.name), el('small', 'muted', a.at));
            r.append(head, el('p', '', a.text));
            list.append(r);
          });
          if (!(p.answers || []).length) list.append(el('p', 'muted', "Hali hech kim javob yozmagan"));
          c.append(list);
        }
        if (isOwner) {
          const row = el('div', 'lesson-form');
          if (p.active) {
            const close = el('button', 'btn btn--ghost', 'Yopish');
            close.type = 'button';
            close.addEventListener('click', () => api(`/api/polls/${p.id}/close`, { method: 'POST' }).then(loadPolls).catch(fail));
            row.append(close);
          }
          const del = el('button', 'btn btn--ghost', "O'chirish");
          del.type = 'button';
          del.addEventListener('click', () => {
            if (window.confirm("Savol va javoblar o'chirilsinmi?")) api(`/api/polls/${p.id}`, { method: 'DELETE' }).then(loadPolls).catch(fail);
          });
          row.append(del);
          c.append(row);
        }
        root.append(c);
      });
    } catch (err) {
      handleAuthError(err);
    }
  }
  viewLoaders.polls = loadPolls;

  // ---------------- Sovg'alar do'koni ----------------
  const ORDER = { pending: '⏳ Kutilmoqda', given: '✅ Olindi', cancelled: '↩ Bekor qilindi' };
  async function loadShop() {
    const root = $('shop-root');
    try {
      const d = await api('/api/rewards');
      root.replaceChildren();
      if (!isOwner) root.append(el('p', 'shop-balance', `Sizda: ${d.my_total} ball`));
      if (isOwner) {
        const c = card("Yangi sovg'a", 'plus');
        const f = el('form', 'lesson-form');
        const name = el('input', 'input-plain');
        name.placeholder = "Sovg'a nomi (masalan: Shokolad)";
        const cost = el('input', 'input-plain');
        cost.type = 'number';
        cost.min = 0;
        cost.placeholder = 'Narxi (ball)';
        const stock = el('input', 'input-plain');
        stock.type = 'number';
        stock.min = 0;
        stock.placeholder = 'Nechta bor';
        const bonus = el('input', 'input-plain');
        bonus.type = 'number';
        bonus.min = 0;
        bonus.placeholder = 'Beriladigan ball (ixtiyoriy)';
        bonus.title = "O'quvchi sovg'ani olganda shuncha ball o'zi qo'shiladi";
        const b = el('button', 'btn btn--primary', "Qo'shish");
        b.type = 'submit';
        f.append(name, cost, stock, bonus, b);
        f.addEventListener('submit', (e) => {
          e.preventDefault();
          api('/api/rewards', { method: 'POST', body: { name: name.value, cost: Number(cost.value), stock: Number(stock.value), bonus: Number(bonus.value) || 0 } }).then(loadShop).catch(fail);
        });
        c.append(f, el('p', 'muted', "Siz tasdiqlashingiz shart emas: o'quvchi «Olish»ni bosishi bilan narxi yechiladi va «Beriladigan ball» o'zi qo'shiladi."));
        root.append(c);
      }
      const grid = el('div', 'shop-grid');
      d.rewards.forEach((r) => {
        const t = el('div', 'card shop-item');
        t.append(el('span', 'shop-item__icon', '🎁'), el('strong', '', r.name), el('span', 'pill', r.cost ? `${r.cost} ball` : 'Bepul'),
          ...(r.bonus ? [el('span', 'pill', `+${r.bonus} ball beradi`)] : []), el('small', 'muted', `Qoldi: ${r.stock} ta`));
        if (isOwner) {
          const del = el('button', 'btn btn--ghost', "O'chirish");
          del.type = 'button';
          del.addEventListener('click', () => api(`/api/rewards/${r.id}`, { method: 'DELETE' }).then(loadShop).catch(fail));
          t.append(del);
        } else {
          const get = el('button', 'btn btn--primary', r.taken ? 'Olingan ✓' : 'Olish');
          get.type = 'button';
          get.disabled = r.taken || r.stock <= 0 || d.my_total < r.cost;
          get.addEventListener('click', () => {
            if (window.confirm(r.cost ? `«${r.name}» uchun ${r.cost} ball sarflaysizmi?` : `«${r.name}» sovg'asini olasizmi?`)) {
              api(`/api/rewards/${r.id}/redeem`, { method: 'POST' }).then(() => { window.alert(r.bonus ? `Olindi! Sizga +${r.bonus} ball berildi 🎉` : 'Olindi! 🎉'); loadShop(); }).catch(fail);
            }
          });
          t.append(get);
        }
        grid.append(t);
      });
      if (!d.rewards.length) grid.append(el('p', 'muted', isOwner ? "Sovg'a qo'shing — o'quvchilar ballini almashtiradi" : "Hozircha sovg'a yo'q"));
      root.append(grid);
      const oc = card(isOwner ? 'Buyurtmalar' : 'Mening sovg\'alarim', 'gift');
      d.orders.forEach((o) => {
        const row = el('div', 'group-row');
        row.append(el('span', '', `${isOwner ? `${o.user}: ` : ''}${o.reward} (${o.cost} ball${o.bonus ? `, +${o.bonus} berildi` : ''})`), el('small', 'muted', ORDER[o.status]));
        if (isOwner && o.status !== 'cancelled') {
          (o.status === 'pending' ? ['given', 'cancelled'] : ['cancelled']).forEach((st) => {
            const b = el('button', st === 'given' ? 'btn btn--primary' : 'btn btn--ghost', st === 'given' ? 'Berildi' : 'Bekor');
            b.type = 'button';
            b.addEventListener('click', () => (st === 'given' || window.confirm("Bekor qilinsinmi? Ball va sovg'a qaytadi.")) && api(`/api/orders/${o.id}`, { method: 'POST', body: { status: st } }).then(loadShop).catch(fail));
            row.append(b);
          });
        }
        oc.append(row);
      });
      if (!d.orders.length) oc.append(el('p', 'muted', "Hali yo'q"));
      root.append(oc);
    } catch (err) {
      handleAuthError(err);
    }
  }
  viewLoaders.shop = loadShop;

  // ---------------- Profil: tug'ilgan kun, guruh, oy o'quvchisi, faollik, ota-ona hisoboti ----------------
  extra.profile = async (param) => {
    const root = $('profile-extra');
    if (!root) return;
    const uid = Number(param) || APP.id;
    root.replaceChildren();
    try {
      const d = await api(`/api/profile/${uid}/extra`);
      const c = card("Qo'shimcha", 'user');
      if (d.best) c.append(el('p', 'crown-tag crown-tag--big', `👑 ${d.best.month} oyning eng yaxshi o'quvchisi!`));
      c.append(el('p', '', `Shu oy: ${d.month_score} ball${d.group ? ` · Guruh: ${d.group}` : ''}`));
      const bd = el('div', 'lesson-form');
      const inp = el('input', 'input-plain');
      inp.type = 'date';
      if (d.birthday) inp.value = `2000-${d.birthday}`;
      const save = el('button', 'btn btn--ghost', "Tug'ilgan kunni saqlash");
      save.type = 'button';
      save.addEventListener('click', () => api('/api/birthday', { method: 'POST', body: { date: inp.value ? inp.value.slice(5) : '', user_id: uid } })
        .then(() => window.alert('Saqlandi 🎂')).catch(fail));
      bd.append(el('span', '', "🎂 Tug'ilgan kun:"), inp, save);
      c.append(bd);
      if (isOwner) {
        const act = await api(`/api/activity/${uid}`);
        const max = Math.max(30, ...act.days.map((x) => x.minutes));
        const chart = el('div', 'act-chart');
        act.days.forEach((x) => {
          const col = el('div', 'act-chart__col');
          const bar = el('span', 'act-chart__bar');
          bar.style.height = `${Math.round((x.minutes / max) * 100)}%`;
          col.title = `${x.day}: ${x.minutes} daqiqa`;
          col.append(bar, el('small', '', x.day.slice(8)));
          chart.append(col);
        });
        const total = act.days.reduce((a, x) => a + x.minutes, 0);
        c.append(el('strong', '', `Saytdagi faollik (14 kun): jami ${Math.floor(total / 60)} soat ${total % 60} daqiqa`), chart);
        const rep = el('button', 'btn btn--primary');
        rep.type = 'button';
        rep.append(icon('link'), el('span', '', 'Ota-ona uchun hisobot havolasi'));
        rep.addEventListener('click', async () => {
          try {
            const r = await api(`/api/users/${uid}/report-link`, { method: 'POST' });
            try { await navigator.clipboard.writeText(r.url); } catch { /* e'tiborsiz */ }
            window.prompt("Havola nusxalandi — ota-onaga yuboring:", r.url);
          } catch (err) {
            fail(err);
          }
        });
        c.append(rep);
      }
      root.append(c);
    } catch (err) {
      handleAuthError(err);
    }
  };
})();
