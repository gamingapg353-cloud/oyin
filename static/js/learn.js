// Panel «Mashqlar»: kunlik savol, kod dueli, xatoni top, maket, xatolar daftari, guruh loyihasi, saytlar ko'chasi
(() => {
  const Oyin = window.Oyin;
  const { api, handleAuthError, el, icon, avatarEl, formatNumber, viewLoaders } = Oyin;
  const APP = window.APP || {};
  const isOwner = APP.role === 'owner';
  const view = document.querySelector('.view[data-view="learn"]');
  const root = document.getElementById('learn-root');
  if (!root) return;

  const TABS = [['daily', '🔥', 'Kunlik savol'], ['duel', '⚔️', 'Kod dueli'], ['bugs', '🐞', 'Xatoni top'], ['maket', '🎨', 'Maket'],
    ['mistakes', '📒', 'Xatolar daftari'], ['projects', '👥', 'Guruh loyihasi'], ['sites', '🏪', 'Saytlar ko\'chasi']];
  let tab = 'daily';
  let timer = null;
  let token = 0;      // bo'lim almashsa eski so'rov natijasi chizilmaydi
  let leave = null;   // bo'limdan chiqishda (masalan, faylni bo'shatish)

  const som = (n) => `${formatNumber(n)} so'm`;
  const fail = (err) => { if (!handleAuthError(err)) window.alert(err.message); };
  const btn = (text, cls, fn) => {
    const b = el('button', `btn ${cls || 'btn--primary'}`, text);
    b.type = 'button';
    if (fn) b.addEventListener('click', fn);
    return b;
  };
  function card(title, cls = '') {
    const c = el('section', `card school-card ${cls}`);
    if (title) c.append(el('h2', 'learn-h2', title));
    return c;
  }
  const LEVEL = { 1: 'Oson', 2: "O'rta", 3: 'Qiyin' };
  const level = (n) => el('span', `lvl lvl--${n}`, LEVEL[n] || '');
  function area(value, mode, ph, opts = {}) {
    const t = el('textarea', 'code-ed__area');
    t.value = value || '';
    t.placeholder = ph || '';
    window.CodeHelp.attach(t, { mode, ...opts });
    return t;
  }
  function note(kind, text) {
    const n = el('p', `learn-note learn-note--${kind}`, text);
    n.setAttribute('role', 'status');
    return n;
  }
  function poll(fn, ms) {
    clearInterval(timer);
    const mine = token;
    timer = setInterval(() => {
      if (mine !== token || view.hidden) { clearInterval(timer); return; }
      if (!document.hidden) fn();
    }, ms);
  }
  const alive = (mine) => mine === token && !view.hidden;
  const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  function open(next, sub) {
    token += 1;
    clearInterval(timer);
    if (leave) { leave(); leave = null; }
    tab = TABS.some((t) => t[0] === next) ? next : 'daily';
    root.replaceChildren();
    const nav = el('div', 'learn-tabs');
    nav.setAttribute('role', 'tablist');
    TABS.forEach(([id, ic, name]) => {
      const b = el('a', `learn-tab${id === tab ? ' is-on' : ''}`);
      b.href = `#learn/${id}`;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(id === tab));
      b.append(el('span', '', ic), el('span', '', name));
      nav.append(b);
    });
    const body = el('div', 'school-stack');
    root.append(nav, body);
    nav.querySelector('.is-on')?.scrollIntoView({ block: 'nearest', inline: 'center' });
    VIEWS[tab](body, sub, token).catch(fail);
  }
  viewLoaders.learn = () => {
    const [, t, sub] = window.location.hash.slice(1).split('/');
    open(t, sub);
  };
  window.addEventListener('hashchange', () => { // boshqa bo'limga o'tildi
    if (!window.location.hash.startsWith('#learn') && leave) { leave(); leave = null; token += 1; clearInterval(timer); }
  });

  const VIEWS = {
    // ================= 4. Kunlik savol =================
    async daily(body, _sub, mine) {
      const d = await api('/api/daily-question');
      if (!alive(mine)) return;
      const draw = (x, res) => {
        body.replaceChildren();
        const head = card('', 'fire');
        head.append(el('div', `fire__n${x.streak.cur ? '' : ' is-off'}`, `🔥 ${x.streak.cur}`),
          el('p', 'muted', x.streak.done ? 'Bugungi savolga javob berdingiz. Ertaga yana keling!' : "Har kuni bitta savolga javob bering. Bir kun o'tkazib yuborsangiz — noldan boshlanadi."),
          el('small', 'muted', `Eng yaxshi natijangiz: ${x.streak.best} kun`));
        const c = card(`Bugungi savol · ${x.topic}`);
        c.append(el('p', 'quiz-q', x.question));
        const opts = el('div', 'quiz-opts');
        x.options.forEach((text, i) => {
          const b = el('button', 'quiz-opt');
          b.type = 'button';
          b.append(el('span', 'quiz-opt__l', 'ABCD'[i]), el('span', '', text));
          if (x.answered) {
            b.disabled = true;
            if (i === x.right) b.classList.add('is-right');
            else if (i === x.choice) b.classList.add('is-wrong');
          } else {
            b.addEventListener('click', async () => {
              opts.querySelectorAll('button').forEach((o) => { o.disabled = true; });
              try {
                const r = await api('/api/daily-question', { method: 'POST', body: { choice: i } });
                if (alive(mine)) draw({ ...x, answered: true, choice: i, right: r.right, explain: r.explain, streak: r.streak, top: r.top }, r);
              } catch (err) { fail(err); }
            });
          }
          opts.append(b);
        });
        c.append(opts);
        if (res) c.append(note(res.correct ? 'ok' : 'bad', res.correct ? `To'g'ri! +${som(res.pay)} (o'yin puli)` : "Noto'g'ri — lekin 🔥 saqlandi. Savol xatolar daftariga yozildi."));
        if (x.answered && x.explain) c.append(el('p', 'muted', `💡 ${x.explain}`));
        const t = card('Eng uzun 🔥');
        x.top.forEach((p) => {
          const r = el('div', 'group-row');
          r.append(avatarEl(p.name, p.avatar, 'avatar avatar--sm'), el('span', '', p.name), el('strong', '', `🔥 ${p.cur}`));
          t.append(r);
        });
        if (!x.top.length) t.append(el('p', 'muted', "Hali hech kim boshlamadi — birinchi bo'ling!"));
        body.append(head, c, t);
      };
      draw(d);
    },

    // ================= 1. Kod dueli =================
    async duel(body, sub, mine) {
      if (sub && /^\d+$/.test(sub)) { await duelRoom(body, Number(sub), mine); return; }
      let sig = '';
      const load = async () => {
        const d = await api('/api/duels');
        if (!alive(mine)) return;
        const my = d.active.find((x) => x.side && x.status === 'running');
        if (my) { window.location.hash = `#learn/duel/${my.id}`; return; }
        const s = JSON.stringify([d.active.map((x) => [x.id, x.status]), d.people.map((p) => [p.key, p.online]), d.last.map((x) => x.id)]);
        if (s === sig) return;
        sig = s;
        const keep = body.querySelector('select')?.value;
        body.replaceChildren();
        const invites = d.active.filter((x) => x.status === 'pending');
        invites.forEach((x) => {
          const c = card('', 'duel-invite');
          const mineInvite = x.side === 'a';
          c.append(el('strong', '', mineInvite ? `⚔️ ${x.b.name}ning javobi kutilmoqda…` : `⚔️ ${x.a.name} sizni duelga chaqirdi!`));
          const row = el('div', 'btn-line');
          if (!mineInvite) row.append(btn('Qabul qilish', 'btn--primary', () => api(`/api/duels/${x.id}/accept`, { method: 'POST' }).then(() => { window.location.hash = `#learn/duel/${x.id}`; }).catch(fail)));
          row.append(btn(mineInvite ? 'Bekor qilish' : 'Rad etish', 'btn--ghost', () => api(`/api/duels/${x.id}/cancel`, { method: 'POST' }).then(load).catch(fail)));
          c.append(row);
          body.append(c);
        });
        const c = card('⚔️ Duelga chaqirish');
        c.append(el('p', 'muted', `Ikkalangizga bir xil topshiriq chiqadi. Kim birinchi to'g'ri yozsa — o'sha yutadi: +${som(d.pay)}. Vaqt — ${d.time / 60} daqiqa. Boshqalar jonli kuzatadi.`));
        const who = el('select', 'input-plain');
        who.append(new Option('Raqibni tanlang', ''));
        d.people.forEach((p) => who.append(new Option(`${p.online ? '🟢 ' : ''}${p.name}`, p.key)));
        who.value = keep || '';
        const lv = el('select', 'input-plain');
        [['', 'Har xil'], ['1', 'Oson (HTML)'], ['2', "O'rta (CSS)"], ['3', 'Qiyin (JS)']].forEach(([v, t]) => lv.append(new Option(t, v)));
        const f = el('div', 'lesson-form');
        f.append(who, lv, btn('Chaqirish', 'btn--primary', () => {
          if (!who.value) { who.focus(); return; }
          api('/api/duels', { method: 'POST', body: { to: who.value, level: lv.value ? Number(lv.value) : null } }).then(() => { sig = ''; load(); }).catch(fail);
        }));
        c.append(f);
        body.append(c);
        const live = d.active.filter((x) => x.status === 'running' && !x.side);
        if (live.length) {
          const l = card('🔴 Hozir duel');
          live.forEach((x) => {
            const r = el('div', 'group-row');
            r.append(el('span', '', `${x.a.name} ⚔️ ${x.b.name} — ${x.title}`), btn('Kuzatish', 'btn--ghost', () => { window.location.hash = `#learn/duel/${x.id}`; }));
            l.append(r);
          });
          body.append(l);
        }
        const h = card("So'nggi duellar");
        d.last.forEach((x) => {
          const r = el('div', 'group-row');
          r.append(el('span', '', `${x.a.name} ⚔️ ${x.b.name}`), el('small', 'muted', x.winner ? `🏆 ${x.winner === x.a.key ? x.a.name : x.b.name}` : 'Durang'),
            btn("Ko'rish", 'btn--ghost', () => { window.location.hash = `#learn/duel/${x.id}`; }));
          h.append(r);
        });
        if (!d.last.length) h.append(el('p', 'muted', "Hali duel bo'lmadi"));
        if (d.top.length) h.append(el('p', 'muted', `🏆 Eng ko'p yutgan: ${d.top.map((t) => `${t.name} (${t.wins})`).join(', ')}`));
        body.append(h);
      };
      await load();
      poll(() => load().catch(handleAuthError), 4000);
    },

    // ================= 2. Xatoni top =================
    async bugs(body, sub, mine) {
      const d = await api('/api/bugs');
      if (!alive(mine)) return;
      const item = d.items.find((b) => b.id === sub);
      if (item) {
        const c = card(`🐞 ${item.title}`);
        const top = el('div', 'tag-line');
        top.append(el('span', 'pill', item.lang), level(item.level), el('span', 'pill', item.done ? '✅ Topilgan' : `+${som(item.pay)}`));
        c.append(top, el('p', '', `Bitta xato bor. Kerakli natija: ${item.want}.`));
        const t = area(item.code, item.lang === 'CSS' || item.lang === 'JS' ? 'auto' : 'html');
        const out = el('div', 'learn-out');
        c.append(t, out);
        const line = el('div', 'btn-line');
        line.append(btn('Tekshirish', 'btn--primary', async () => {
          try {
            const r = await api(`/api/bugs/${item.id}`, { method: 'POST', body: { code: t.value } });
            out.replaceChildren(r.ok ? note('ok', r.first ? `Topdingiz! 🎉 +${som(r.pay)}` : "To'g'ri! (puli oldin berilgan)") : note('bad', `Hali emas: ${r.missing.join(' · ')}`));
            item.done = item.done || r.ok;
            if (r.ok) {
              const next = d.items.find((b) => !b.done);
              if (next) out.append(btn('Keyingisi →', 'btn--ghost', () => { window.location.hash = `#learn/bugs/${next.id}`; }));
            }
          } catch (err) { fail(err); }
        }), btn('Boshidan', 'btn--ghost', () => { t.value = item.code; out.replaceChildren(); }));
        const back = el('a', 'btn btn--ghost', "← Ro'yxat");
        back.href = '#learn/bugs';
        line.append(back);
        c.append(line);
        body.append(c);
        return;
      }
      const c = card(`🐞 Xatoni top — ${d.items.filter((b) => b.done).length} / ${d.items.length}`);
      c.append(el('p', 'muted', 'Har bir kodda bitta xato yashiringan. Toping, tuzating — o\'yin puli oling.'));
      const g = el('div', 'task-grid');
      d.items.forEach((b) => {
        const a = el('a', `task-tile${b.done ? ' is-done' : ''}`);
        a.href = `#learn/bugs/${b.id}`;
        a.append(el('strong', '', `${b.done ? '✅ ' : ''}${b.title}`), el('small', 'muted', `${b.lang} · ${LEVEL[b.level]} · ${som(b.pay)}`));
        g.append(a);
      });
      c.append(g);
      if (d.top.length) c.append(el('p', 'muted', `🏆 Ovchilar: ${d.top.map((t) => `${t.name} (${t.n})`).join(', ')}`));
      body.append(c);
    },

    // ================= 3. Maketni takrorla =================
    async maket(body, sub, mine) {
      const d = await api('/api/makets');
      if (!alive(mine)) return;
      const m = d.items.find((x) => x.id === sub);
      if (!m) {
        const c = card(`🎨 Maketni takrorla — ${d.items.filter((x) => x.best >= d.need).length} / ${d.items.length}`);
        c.append(el('p', 'muted', `Rasmdagini faqat HTML va CSS bilan chizing (300×200). ${d.need}% dan oshsa — pul beriladi.`));
        const g = el('div', 'task-grid');
        d.items.forEach((x) => {
          const a = el('a', `task-tile${x.best >= d.need ? ' is-done' : ''}`);
          a.href = `#learn/maket/${x.id}`;
          const img = el('img', 'maket-img');
          img.src = x.image;
          img.alt = x.title;
          img.width = 300;
          img.height = 200;
          a.append(img, el('strong', '', x.title), el('small', 'muted', `${LEVEL[x.level]} · ${som(x.pay)}${x.best ? ` · sizniki ${x.best}%` : ''}`));
          g.append(a);
        });
        c.append(g);
        body.append(c);
        return;
      }
      const c = card(`🎨 ${m.title}`);
      const top = el('div', 'tag-line');
      top.append(level(m.level), el('span', 'pill', m.best >= d.need ? '✅ Bajarilgan' : `${d.need}% → +${som(m.pay)}`));
      m.colors.forEach((hex) => {
        const b = el('button', 'color-chip', hex);
        b.type = 'button';
        b.style.setProperty('--c', hex);
        b.title = 'Nusxa olish';
        b.addEventListener('click', () => { navigator.clipboard?.writeText(hex); b.textContent = 'Olindi ✓'; setTimeout(() => { b.textContent = hex; }, 900); });
        top.append(b);
      });
      c.append(top);
      const pair = el('div', 'maket-pair');
      const fig = (title, node) => { const f = el('figure', ''); f.append(node, el('figcaption', 'muted', title)); pair.append(f); };
      const target = el('img', 'maket-img');
      target.src = m.image;
      target.alt = 'Namuna';
      target.width = 300;
      target.height = 200;
      const frame = el('iframe', 'maket-frame');
      frame.setAttribute('sandbox', '');
      frame.title = 'Sizniki';
      fig('Namuna', target);
      fig('Sizniki', frame);
      const draft = `maket:${APP.id || 'owner'}:${m.id}`;
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(draft) || 'null'); } catch { saved = null; }
      const html = area(saved?.html ?? (m.html || '<div class="a"></div>\n'), 'html', '');
      const css = area(saved?.css ?? (m.css || 'body {\n  background: white;\n}\n\n.a {\n  position: absolute;\n}\n'), 'css', '', { peers: () => html.value });
      const show = () => {
        frame.srcdoc = `<!doctype html><meta charset="utf-8"><style>${window.CodeHelp.SNAP_CSS(300, 200)}${css.value.replace(/<\/style/gi, '')}</style>${html.value}`;
        try { localStorage.setItem(draft, JSON.stringify({ html: html.value, css: css.value })); } catch { /* xotira yopiq */ }
      };
      let t = null;
      [html, css].forEach((x) => x.addEventListener('input', () => { clearTimeout(t); t = setTimeout(show, 300); }));
      show();
      const out = el('div', 'learn-out');
      const check = btn('Solishtirish', 'btn--primary', async () => {
        check.disabled = true;
        try {
          const pct = await compareMaket(html.value, css.value, target);
          const r = await api(`/api/makets/${m.id}`, { method: 'POST', body: { html: html.value, css: css.value, pct } });
          const bar = el('div', 'pct');
          const fill = el('span', '');
          fill.style.width = `${r.pct}%`;
          bar.append(fill);
          out.replaceChildren(bar, note(r.pct >= d.need ? 'ok' : 'bad', `${r.pct}% o'xshash${r.pay ? ` — qoyil! +${som(r.pay)} 🎉` : r.pct >= d.need ? ' ✅' : ` — ${d.need}% kerak`} · eng yaxshingiz ${r.best}%`));
        } catch (err) { fail(err); }
        check.disabled = false;
      });
      const back = el('a', 'btn btn--ghost', '← Maketlar');
      back.href = '#learn/maket';
      const line = el('div', 'btn-line');
      line.append(check, back);
      const eds = el('div', 'maket-eds');
      [['HTML', html], ['CSS', css]].forEach(([n, x]) => { const w = el('label', 'code-ed'); w.append(el('span', 'code-ed__label', n), x); eds.append(w); });
      c.append(pair, eds, line, out);
      if (m.top.length) c.append(el('p', 'muted', `🏆 ${m.top.map((x, i) => `${i + 1}. ${x.name} — ${x.pct}% (${x.size} belgi)`).join('  ·  ')}`));
      body.append(c);
    },

    // ================= 5. Xatolar daftari =================
    async mistakes(body, sub, mine) {
      const d = await api('/api/mistakes');
      if (!alive(mine)) return;
      const c = card(`📒 Xatolar daftari — ${d.items.length} ta`);
      c.append(el('p', 'muted', `Testlarda xato qilgan savollaringiz. Har biriga ${d.items[0]?.need || 2} marta to'g'ri javob bersangiz — daftardan o'chadi. O'rganilgan: ${d.learned} ta.`));
      body.append(c);
      if (!d.items.length) { c.append(note('ok', 'Xatolaringiz yo\'q — zo\'r! 🎉')); return; }
      const box = card('');
      const ask = async (id) => {
        const x = await api(`/api/mistakes/${id}`);
        if (!alive(mine)) return;
        box.replaceChildren(el('span', 'pill', x.topic), el('p', 'quiz-q', x.question));
        const opts = el('div', 'quiz-opts');
        x.options.forEach((text, i) => {
          const b = el('button', 'quiz-opt');
          b.type = 'button';
          b.append(el('span', 'quiz-opt__l', 'ABCD'[i]), el('span', '', text));
          b.addEventListener('click', async () => {
            opts.querySelectorAll('button').forEach((o) => { o.disabled = true; });
            try {
              const r = await api(`/api/mistakes/${id}`, { method: 'POST', body: { answer: text } });
              [...opts.children].forEach((o, k) => { if (x.options[k] === r.right) o.classList.add('is-right'); });
              if (!r.correct) b.classList.add('is-wrong');
              box.append(note(r.correct ? 'ok' : 'bad', r.done ? `O'rgandingiz! Daftardan o'chdi. +${som(r.pay)}` : r.correct ? "To'g'ri! Yana bir marta to'g'ri javob bersangiz — o'chadi." : "Noto'g'ri — yana so'raladi."));
              if (r.explain) box.append(el('p', 'muted', `💡 ${r.explain}`));
              box.append(btn('Keyingi savol →', 'btn--primary', () => open('mistakes')));
            } catch (err) { fail(err); }
          });
          opts.append(b);
        });
        box.append(opts);
      };
      body.append(box);
      await ask(d.items[Math.floor(Math.random() * d.items.length)].id);
      const l = card("Ro'yxat");
      d.items.forEach((x) => {
        const r = el('div', 'group-row');
        r.append(el('span', '', x.question), el('small', 'muted', `${x.topic} · ${x.wrong} marta xato · ${x.good}/${x.need}`));
        l.append(r);
      });
      if (alive(mine)) body.append(l);
    },

    // ================= 6. Guruh loyihasi =================
    async projects(body, sub, mine) {
      if (sub && /^\d+$/.test(sub)) { await projectRoom(body, Number(sub), mine); return; }
      const d = await api('/api/projects');
      if (!alive(mine)) return;
      const c = card('👥 Loyihalar');
      d.items.forEach((p) => {
        const r = el('div', 'group-row');
        const info = el('span', '');
        info.append(el('strong', '', p.title), el('br'), el('small', 'muted', `${p.members.map((m) => `${m.here ? '🟢' : ''}${m.name}`).join(', ')}${p.points !== null ? ` · ${p.points} ball` : ''}`));
        r.append(info, btn('Ochish', 'btn--primary', () => { window.location.hash = `#learn/projects/${p.id}`; }));
        c.append(r);
      });
      if (!d.items.length) c.append(el('p', 'muted', "Hali loyiha yo'q"));
      body.append(c);
      const n = card('Yangi loyiha');
      n.append(el('p', 'muted', `Bitta saytni birga yozasiz: biri HTML, biri CSS, biri JS. ${isOwner ? '2' : "O'zingizdan tashqari 1"}–${isOwner ? d.max : d.max - 1} kishi tanlang.`));
      const title = el('input', 'input-plain');
      title.placeholder = 'Loyiha nomi';
      title.maxLength = 60;
      const about = el('input', 'input-plain');
      about.placeholder = 'Topshiriq (ixtiyoriy)';
      about.maxLength = 300;
      const ppl = el('div', 'pick-list');
      d.people.forEach((p) => {
        const l = el('label', 'pick');
        const cb = el('input', '');
        cb.type = 'checkbox';
        cb.value = p.key;
        l.append(cb, el('span', '', p.name));
        ppl.append(l);
      });
      n.append(title, about, ppl, btn('Yaratish', 'btn--primary', () => {
        const members = [...ppl.querySelectorAll('input:checked')].map((x) => x.value);
        api('/api/projects', { method: 'POST', body: { title: title.value, about: about.value, members } }).then((r) => { window.location.hash = `#learn/projects/${r.id}`; }).catch(fail);
      }));
      body.append(n);
    },

    // ================= 7. Saytlar ko'chasi =================
    async sites(body, sub, mine) {
      const draw = (d) => {
        body.replaceChildren();
        const c = card("🏪 Saytimni ko'chaga chiqarish");
        c.append(el('p', 'muted', "«Kod muharriri»dagi yoki guruh loyihangizdagi sayt o'yindagi istirohat bog'ida do'koncha bo'lib turadi — hamma kirib ko'radi. Eng ko'p yulduz olgan 9 tasi ko'chada."));
        const my = d.items.find((x) => x.mine);
        const title = el('input', 'input-plain');
        title.placeholder = 'Sayt nomi';
        title.maxLength = 40;
        title.value = my ? my.title : '';
        const em = el('select', 'input-plain');
        d.emoji.forEach((x) => em.append(new Option(x, x)));
        if (my) em.value = my.emoji;
        const src = el('select', 'input-plain');
        src.append(new Option('Kod muharriridagi saytim', ''));
        d.projects.forEach((p) => src.append(new Option(`Loyiha: ${p.title}`, p.id)));
        const f = el('div', 'lesson-form');
        f.append(em, title, src, btn(my ? 'Yangilash' : 'Chiqarish', 'btn--primary', () => api('/api/sites', { method: 'POST', body: { title: title.value, emoji: em.value, project: src.value ? Number(src.value) : null } }).then(draw).catch(fail)));
        c.append(f);
        if (my) c.append(btn("Ko'chadan olish", 'btn--ghost', () => window.confirm("Saytingiz ko'chadan olinsinmi?") && api(`/api/sites/${my.key}`, { method: 'DELETE' }).then(draw).catch(fail)));
        body.append(c);
        const g = el('div', 'shop-grid');
        d.items.forEach((x) => {
          const t = el('div', 'card shop-item');
          t.append(el('span', 'shop-item__icon', x.emoji), el('strong', '', x.title), el('small', 'muted', `${x.name}${x.slot !== null ? ` · ${x.slot + 1}-do'koncha` : ''}`), el('span', 'pill', `⭐ ${x.likes}`));
          t.append(btn("Ko'rish", 'btn--primary', () => showSite(x.key)));
          if (isOwner && !x.mine) t.append(btn("O'chirish", 'btn--ghost', () => window.confirm(`${x.name}ning sayti olib tashlansinmi?`) && api(`/api/sites/${x.key}`, { method: 'DELETE' }).then(draw).catch(fail)));
          g.append(t);
        });
        if (!d.items.length) g.append(el('p', 'muted', "Hali hech kim saytini chiqarmadi — birinchi bo'ling!"));
        body.append(g);
      };
      const d = await api('/api/sites');
      if (alive(mine)) draw(d);
    },
  };

  async function showSite(key) {
    let s;
    try { s = await api(`/api/sites/${key}`); } catch (err) { fail(err); return; }
    const dlg = el('dialog', 'dialog site-dialog');
    const box = el('div', 'dialog__body');
    const out = el('div', 'code-out');
    const like = btn('', 'btn--ghost');
    const paint = () => { like.textContent = `${s.liked ? '⭐' : '☆'} ${s.likes}`; like.disabled = s.mine; };
    like.addEventListener('click', () => api(`/api/sites/${key}/like`, { method: 'POST' }).then((r) => { Object.assign(s, r); paint(); }).catch(fail));
    paint();
    const line = el('div', 'btn-line');
    line.append(btn('▶ Ishga tushirish (JS)', 'btn--primary', () => window.CodeHelp.run(out, { html: s.html, css: s.css, js: s.js })), like, btn('Yopish', 'btn--ghost', () => dlg.close()));
    out.append(staticFrame(s.html, s.css));
    box.append(el('h2', '', `${s.emoji} ${s.title}`), el('small', 'muted', s.name), out, line);
    dlg.append(box);
    document.body.append(dlg);
    dlg.addEventListener('close', () => dlg.remove());
    dlg.showModal();
  }
  function staticFrame(html, css) {
    const f = el('iframe', 'code-preview');
    f.setAttribute('sandbox', '');
    f.title = 'Natija';
    f.srcdoc = `<!doctype html><meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;margin:12px}${(css || '').replace(/<\/style/gi, '')}</style>${html || ''}`;
    return f;
  }

  // ---------------- Maketni piksellab solishtirish ----------------
  async function compareMaket(html, css, img) {
    if (!img.complete) await img.decode();
    const c = document.createElement('canvas');
    c.width = 300;
    c.height = 200;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, 300, 200);
    const a = g.getImageData(0, 0, 300, 200).data;
    const mineC = await window.CodeHelp.snap(html, css, 300, 200);
    let b;
    try {
      b = mineC.getContext('2d').getImageData(0, 0, 300, 200).data;
    } catch {
      throw new Error("Bu brauzerda solishtirib bo'lmaydi — Chrome yoki Edge'da oching");
    }
    const bg = [a[0], a[1], a[2]];
    let all = 0;
    let good = 0;
    for (let i = 0; i < a.length; i += 4) {
      const diff = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
      const tBg = Math.max(Math.abs(a[i] - bg[0]), Math.abs(a[i + 1] - bg[1]), Math.abs(a[i + 2] - bg[2])) < 12;
      const mBg = Math.max(Math.abs(b[i] - bg[0]), Math.abs(b[i + 1] - bg[1]), Math.abs(b[i + 2] - bg[2])) < 12;
      if (tBg && mBg) continue; // ikkalasida ham fon — hisobga olinmaydi (bo'sh sahifa 80% chiqmasin)
      all += 1;
      if (diff <= 40) good += 1;
    }
    return Math.round((all ? good / all : 1) * 1000) / 10;
  }

  // ---------------- Duel xonasi ----------------
  async function duelRoom(body, id, mine) {
    let st = null;
    let code = null;
    let sentLen = -1;
    let out = null;
    let built = '';
    const render = () => {
      const d = st;
      const key = `${d.status}|${d.side}`;
      if (built !== key) {
        built = key;
        const keep = code ? code.value : null;
        body.replaceChildren();
        const c = card('');
        c.append(el('div', 'duel-vs'), el('div', 'duel-clock', ''));
        const vs = c.querySelector('.duel-vs');
        [d.a, d.b].forEach((p, i) => {
          if (i) vs.append(el('span', 'duel-vs__x', '⚔️'));
          const w = el('div', `duel-vs__p${d.winner === p.key ? ' is-win' : ''}`);
          w.append(avatarEl(p.name, p.avatar), el('strong', '', `${d.winner === p.key ? '🏆 ' : ''}${p.name}`), el('small', 'muted', ''));
          vs.append(w);
        });
        if (d.task) c.append(el('h2', 'learn-h2', d.title), el('p', 'quiz-q', d.task));
        if (d.status === 'pending') c.append(note('bad', 'Raqib javobi kutilmoqda…'));
        if (d.status === 'cancelled') c.append(note('bad', 'Duel bekor qilindi'));
        if (d.status === 'done') c.append(note(d.winner && d.side && d.winner === d[d.side].key ? 'ok' : 'bad', d.winner ? `G'olib: ${d.winner === d.a.key ? d.a.name : d.b.name} 🏆` : 'Durang — vaqt tugadi'));
        body.append(c);
        out = el('div', 'learn-out');
        if (d.status === 'running' && d.side) {
          const e = card('Sizning kodingiz');
          code = area(keep ?? d[`${d.side}_code`], 'auto', '<!-- shu yerga yozing -->');
          const line = el('div', 'btn-line');
          line.append(btn('Tekshirish ✅', 'btn--primary', submit), btn('Taslim bo\'lish', 'btn--ghost', () => window.confirm('Taslim bo\'lasizmi?') && api(`/api/duels/${id}/cancel`, { method: 'POST' }).then(tick).catch(fail)));
          e.append(code, out, line);
          body.append(e);
          code.focus();
        } else if (d.status === 'running' || d.status === 'done') {
          code = null;
          const g = el('div', 'duel-codes');
          [['a', d.a], ['b', d.b]].forEach(([k, p]) => { const w = card(p.name); w.append(el('pre', 'code-pre', '')); w.lastChild.dataset.side = k; g.append(w); });
          body.append(g);
        }
        const back = el('a', 'btn btn--ghost', '← Duellar');
        back.href = '#learn/duel';
        body.append(back);
      }
      body.querySelectorAll('pre[data-side]').forEach((p) => {
        const text = d[`${p.dataset.side}_code`] || "(hali yozmadi)";
        if (p.textContent !== text) p.textContent = text;
      });
      const small = body.querySelectorAll('.duel-vs__p small');
      [d.a, d.b].forEach((p, i) => { if (small[i]) small[i].textContent = d.status === 'running' ? `${p.len} belgi` : ''; });
      const clock = body.querySelector('.duel-clock');
      if (clock) clock.textContent = d.status === 'running' ? (d.left > 600 ? `Tayyorlaning… ${d.left - 600}` : `⏱ ${mmss(d.left)}`) : '';
    };
    async function submit() {
      try {
        const r = await api(`/api/duels/${id}/submit`, { method: 'POST', body: { code: code.value } });
        if (!alive(mine)) return;
        if (r.ok) { st = r.duel; render(); body.prepend(note('ok', `Siz yutdingiz! 🏆${r.pay ? ` +${som(r.pay)}` : ''}`)); } else out.replaceChildren(note('bad', `Hali emas: ${r.missing.join(' · ')}`));
      } catch (err) {
        if (handleAuthError(err)) return;
        if (out) out.replaceChildren(note('bad', err.message));
        tick();
      }
    }
    const tick = async () => {
      try {
        if (code && st && st.status === 'running' && code.value.length !== sentLen) {
          sentLen = code.value.length;
          await api(`/api/duels/${id}/code`, { method: 'POST', body: { code: code.value } });
        }
        const r = await api(`/api/duels/${id}`);
        if (!alive(mine)) return;
        st = r.duel;
        render();
        if (st.status === 'done' || st.status === 'cancelled') clearInterval(timer);
      } catch (err) {
        if (!handleAuthError(err) && alive(mine) && !st) { clearInterval(timer); body.replaceChildren(note('bad', err.message)); }
      }
    };
    await tick();
    poll(tick, 2000);
  }

  // ---------------- Loyiha xonasi ----------------
  async function projectRoom(body, id, mine) {
    const FILES = [['html', 'HTML'], ['css', 'CSS'], ['js', 'JavaScript']];
    let st = await api(`/api/projects/${id}`);
    if (!alive(mine)) return;
    const vers = {};
    const eds = {};
    let holding = null;
    let dirty = false;
    let saving = null;
    const head = card(`👥 ${st.title}`);
    if (st.about) head.append(el('p', 'muted', st.about));
    const ppl = el('p', 'muted', '');
    const pts = el('p', '', '');
    head.append(ppl, pts);
    const grid = el('div', 'code-grid');
    const left = el('div', 'code-eds');
    const right = el('div', 'code-side');
    const out = el('div', 'code-out');
    const status = el('small', 'muted', '');
    const text = (f) => eds[f].t.value;
    const show = () => out.replaceChildren(staticFrame(text('html'), text('css')));
    FILES.forEach(([f, name]) => {
      const w = el('div', 'code-ed');
      const bar = el('div', 'pj-bar');
      const who = el('small', 'muted', '');
      const b = btn('✍️ Yozish', 'btn--ghost btn--sm', () => (holding === f ? release() : take(f)));
      bar.append(el('span', 'code-ed__label', name), who, b);
      const t = area(st.files[f].content, f, '', { peers: () => FILES.filter((x) => x[0] !== f).map((x) => eds[x[0]]?.t.value || '').join('\n') });
      t.readOnly = true;
      t.addEventListener('input', () => {
        dirty = true;
        show();
        status.textContent = 'Yozilyapti…';
        clearTimeout(saving);
        saving = setTimeout(save, 900);
      });
      w.append(bar, t);
      left.append(w);
      eds[f] = { t, who, b };
      vers[f] = st.files[f].version;
    });
    async function take(f) {
      if (holding) await release();
      try {
        const r = await api(`/api/projects/${id}/lock`, { method: 'POST', body: { file: f, on: true } });
        if (!alive(mine)) return;
        apply(r);
        holding = f;
        eds[f].t.readOnly = false;
        eds[f].t.focus();
        paint(r);
      } catch (err) { fail(err); tick(); }
    }
    async function release() {
      const f = holding;
      if (!f) return;
      clearTimeout(saving);
      if (dirty) await save();
      holding = null;
      eds[f].t.readOnly = true;
      try { paint(await api(`/api/projects/${id}/lock`, { method: 'POST', body: { file: f, on: false } })); } catch (err) { handleAuthError(err); }
    }
    async function save() {
      const f = holding;
      if (!f || !dirty) return;
      dirty = false;
      try {
        const r = await api(`/api/projects/${id}/save`, { method: 'POST', body: { file: f, content: text(f) } });
        vers[f] = r.version;
        status.textContent = 'Saqlandi ✓';
      } catch (err) {
        if (handleAuthError(err)) return;
        status.textContent = err.message;
        if (err.status === 409) { eds[f].t.readOnly = true; holding = null; } else dirty = true;
      }
    }
    function apply(r) { // boshqalar yozgan o'zgarishlar
      let changed = false;
      FILES.forEach(([f]) => {
        const x = r.files[f];
        if (x.content !== undefined && f !== holding) {
          if (eds[f].t.value !== x.content) { eds[f].t.value = x.content; changed = true; }
          vers[f] = x.version;
        }
      });
      if (changed) show();
    }
    const log = el('div', 'pj-log');
    let logSig = '';
    function paint(r) {
      st = r;
      ppl.replaceChildren();
      r.members.forEach((m) => ppl.append(el('span', 'pill', `${m.here ? '🟢 ' : ''}${m.name}`), ' '));
      pts.textContent = r.points !== null ? `⭐ Loyihaga ${r.points} ball qo'yilgan` : '';
      FILES.forEach(([f]) => {
        const x = r.files[f];
        eds[f].who.textContent = x.lock && !x.mine ? `🔒 ${x.lock_name} yozyapti` : holding === f ? '✍️ Siz yozyapsiz' : x.by ? `oxirgi: ${x.by}` : '';
        eds[f].b.textContent = holding === f ? '✓ Tugatdim' : '✍️ Yozish';
        eds[f].b.disabled = Boolean(x.lock && !x.mine);
        eds[f].t.classList.toggle('is-locked', holding !== f);
      });
      const s = JSON.stringify(r.log);
      if (s !== logSig) {
        logSig = s;
        log.replaceChildren(...r.log.map((m) => el('div', `pm${m.me ? ' pm--me' : ''}`, `${m.me ? '' : `${m.name}: `}${m.text}`)));
        log.scrollTop = log.scrollHeight;
      }
    }
    let beat = 0;
    const tick = async () => {
      try {
        beat += 1;
        if (holding && beat % 3 === 0 && !dirty) await api(`/api/projects/${id}/lock`, { method: 'POST', body: { file: holding, on: true } }); // band ekanini bildirib turadi
        const r = await api(`/api/projects/${id}?${FILES.map(([f]) => `${f}=${vers[f]}`).join('&')}`);
        if (!alive(mine)) return;
        apply(r);
        paint(r);
      } catch (err) { if (!handleAuthError(err) && err.status === 404 && alive(mine)) window.location.hash = '#learn/projects'; }
    };
    right.append(out, btn('▶ Ishga tushirish', 'btn--primary', () => window.CodeHelp.run(out, { html: text('html'), css: text('css'), js: text('js'), modals: true })), status);
    grid.append(left, right);
    const work = card('');
    work.append(el('p', 'muted', "«✍️ Yozish»ni bosing — fayl sizniki bo'ladi. Boshqalar shu paytda qolgan fayllarni yozadi, o'zgarish hammada ko'rinadi."), grid);
    const chat = card('💬 Guruh suhbati');
    const inp = el('input', 'input-plain');
    inp.placeholder = 'Xabar…';
    inp.maxLength = 300;
    const send = () => {
      if (!inp.value.trim()) return;
      const t = inp.value;
      inp.value = '';
      api(`/api/projects/${id}/message`, { method: 'POST', body: { text: t } }).then((r) => alive(mine) && paint(r)).catch(fail);
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    const line = el('div', 'btn-line');
    line.append(inp, btn('Yuborish', 'btn--primary', send));
    chat.append(log, line);
    const foot = el('div', 'btn-line');
    const back = el('a', 'btn btn--ghost', '← Loyihalar');
    back.href = '#learn/projects';
    foot.append(back);
    if (isOwner) {
      const sel = el('select', 'input-plain');
      [0, 1, 2, 3, 4, 5].forEach((n) => sel.append(new Option(`${n} ball`, n)));
      sel.value = String(st.points ?? 5);
      foot.append(sel, btn("Hammasiga ball qo'yish", 'btn--primary', () => api(`/api/projects/${id}/grade`, { method: 'POST', body: { points: Number(sel.value) } }).then(tick).catch(fail)));
    }
    if (st.can_delete) foot.append(btn("Loyihani o'chirish", 'btn--ghost', () => window.confirm("Loyiha o'chirilsinmi?") && api(`/api/projects/${id}`, { method: 'DELETE' }).then(() => { window.location.hash = '#learn/projects'; }).catch(fail)));
    body.append(head, work, chat, foot);
    show();
    paint(st);
    leave = () => { release(); };
    poll(tick, 2500);
  }
})();
