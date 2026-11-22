// Panel: baho berish, ovozli izoh, profil bezagi, sozlamalar (Telegram), telefonga o'rnatish
(() => {
  const Oyin = window.Oyin;
  const { api, handleAuthError, el, icon, avatarEl, formatNumber, viewLoaders } = Oyin;
  const APP = window.APP || {};
  const isOwner = APP.role === 'owner';
  const $ = (id) => document.getElementById(id);
  const fail = (err) => { if (!handleAuthError(err)) window.alert(err.message); };
  const btn = (text, cls, fn) => {
    const b = el('button', `btn ${cls || 'btn--primary'}`, text);
    b.type = 'button';
    if (fn) b.addEventListener('click', fn);
    return b;
  };
  function card(title, iconName) {
    const c = el('section', 'card school-card');
    const h = el('div', 'school-card__head');
    const i = el('span', 'card__icon');
    i.append(icon(iconName));
    h.append(i, el('h2', '', title));
    c.append(h);
    return c;
  }

  // ================= Bezak: ism rangi, ramka, unvon =================
  Oyin.applyDeco = (avatar, name, deco) => {
    if (avatar) {
      [...avatar.classList].filter((c) => c.startsWith('avatar--f')).forEach((c) => avatar.classList.remove(c));
      if (deco?.frame) avatar.classList.add('avatar--framed', `avatar--f-${deco.frame}`);
    }
    if (name) name.style.color = deco?.color || '';
  };
  // Tepadagi hisob belgisi (va menyusi) — bezak bilan
  function paintMe(deco) {
    const chip = $('account-btn');
    if (!chip) return;
    Oyin.applyDeco($('my-avatar'), chip.querySelector('strong'), deco);
    Oyin.applyDeco(null, document.querySelector('#account-menu .menu__head strong'), deco);
    const small = chip.querySelector('small');
    small.dataset.role = small.dataset.role || small.textContent;
    small.textContent = deco?.title || small.dataset.role;
  }
  paintMe(APP.deco);

  async function decoCard(root) {
    const c = card('Profil bezagi', 'sparkles');
    const draw = (d) => {
      c.querySelectorAll('.deco-body').forEach((x) => x.remove());
      const now = { frame: d.frame, color: (d.colors.find((x) => x.id === d.color) || {}).hex, title: d.title ? (d.titles.find((x) => x.id === d.title) || {}).name : '' };
      paintMe(now); // tepada darhol ko'rinsin
      const body = el('div', 'deco-body');
      const prev = el('div', 'deco-prev');
      const av = avatarEl(APP.name, APP.avatar, 'avatar avatar--lg');
      const nm = el('strong', '', APP.name);
      Oyin.applyDeco(av, nm, now);
      const info = el('div', '');
      info.append(nm, el('small', 'muted', (d.titles.find((x) => x.id === d.title) || {}).name || 'Unvonsiz'));
      prev.append(av, info);
      body.append(prev, el('p', 'muted', `Profilda, reytingda, chatda va o'yinda ko'rinadi. Hamyoningiz: ${formatNumber(Math.floor(d.money))} so'm`));
      const set = (kind, id, x) => {
        if (!x.own && x.price && !window.confirm(`«${x.name}» — ${formatNumber(x.price)} so'm (o'yin puli). Olasizmi?`)) return;
        api('/api/deco', { method: 'POST', body: { kind, id } }).then(draw).catch(fail);
      };
      const group = (title, kind, list, cur, look) => {
        body.append(el('h3', 'deco-h', title));
        const g = el('div', 'deco-grid');
        list.forEach((x) => {
          const b = el('button', `deco-item${x.id === cur ? ' is-on' : ''}${x.own ? '' : ' is-locked'}`);
          b.type = 'button';
          b.append(look(x), el('span', '', x.name), el('small', 'muted', x.id === cur ? 'Kiyilgan ✓' : x.own ? '' : `${formatNumber(x.price)} so'm`));
          b.addEventListener('click', () => set(kind, x.id, x));
          g.append(b);
        });
        body.append(g);
      };
      group('Ramka', 'frame', d.frames, d.frame, (x) => { const a = avatarEl(APP.name, APP.avatar); if (x.id) a.classList.add('avatar--framed', `avatar--f-${x.id}`); return a; });
      group('Ism rangi', 'color', d.colors, d.color, (x) => { const s = el('strong', '', 'Aa'); if (x.hex) s.style.color = x.hex; return s; });
      body.append(el('h3', 'deco-h', 'Unvon'));
      const tg = el('div', 'deco-grid deco-grid--titles');
      [{ id: '', name: 'Unvonsiz', about: '', own: true }, ...d.titles].forEach((x) => {
        const b = el('button', `deco-item${x.id === d.title ? ' is-on' : ''}${x.own ? '' : ' is-locked'}`);
        b.type = 'button';
        b.disabled = !x.own;
        b.append(el('strong', '', x.name), el('small', 'muted', x.own ? x.about : `🔒 ${x.about}${x.need > 1 ? ` (${x.have}/${x.need})` : ''}`));
        b.addEventListener('click', () => api('/api/deco', { method: 'POST', body: { kind: 'title', id: x.id } }).then(draw).catch(fail));
        tg.append(b);
      });
      body.append(tg);
      c.append(body);
    };
    try {
      draw(await api('/api/deco'));
      root.replaceChildren(c);
    } catch (err) { handleAuthError(err); }
  }

  const extra = Oyin.extraLoaders || (Oyin.extraLoaders = {});
  const prevProfile = extra.profile;
  extra.profile = async (param) => {
    await prevProfile?.(param);
    const root = $('profile-extra3');
    if (!root) return;
    root.replaceChildren();
    const uid = Number(param) || APP.id;
    if (!isOwner && uid === APP.id) {
      const a = el('a', 'btn btn--primary', "👑 Profilimni bezash: ramka, ism rangi, unvon");
      a.href = '#deco';
      root.append(a);
    }
    if (isOwner && uid) {
      const c = card('Ota-ona uchun Telegram', 'send');
      c.append(el('p', 'muted', "Havolani ota-onaga yuboring: botni ochib «Start» bossa, har yakshanba hisobot boradi."));
      const out = el('div', '');
      c.append(btn('Havola olish', 'btn--primary', () => api(`/api/users/${uid}/tg-link`).then((r) => {
        const inp = el('input', 'input-plain');
        inp.readOnly = true;
        inp.value = r.url;
        out.replaceChildren(inp, btn('Nusxa olish', 'btn--ghost', (e) => { navigator.clipboard?.writeText(r.url); e.target.textContent = 'Olindi ✓'; }));
      }).catch(fail)), out);
      root.append(c);
    }
  };

  // ================= 8. Baho berish =================
  const stars = (n) => '★★★★★'.slice(0, Math.round(n)) + '☆☆☆☆☆'.slice(0, 5 - Math.round(n));
  Oyin.peerBox = (hwId, label) => {
    const wrap = el('details', 'peer');
    const sum = el('summary', '', label || "⭐ Boshqalarning ishi — baho berish");
    const body = el('div', 'peer__body');
    wrap.append(sum, body);
    const load = async () => {
      body.replaceChildren(el('p', 'muted', 'Yuklanmoqda…'));
      try {
        const d = await api(`/api/homeworks/${hwId}/peers`);
        body.replaceChildren();
        if (!d.on && !isOwner) { body.append(el('p', 'muted', "Ustoz baho berishni o'chirib qo'ygan")); return; }
        if (d.locked) { body.append(el('p', 'muted', "Avval o'z ishingizni topshirib, tekshirtiring — keyin boshqalarnikini ko'rasiz")); return; }
        if (!d.items.length) body.append(el('p', 'muted', "Hali tekshirilgan ish yo'q"));
        d.items.forEach((x) => {
          const r = el('div', 'peer-row');
          const info = el('div', 'peer-row__info');
          info.append(el('strong', '', `${x.name}${x.mine ? ' (siz)' : ''}`), el('small', 'muted', x.n ? `${stars(x.avg)} ${x.avg} · ${x.n} ta baho` : "Hali baho yo'q"));
          r.append(avatarEl(x.name, x.avatar, 'avatar avatar--sm'), info, btn(x.mine ? 'Izohlar' : x.my ? `${x.my}★ · ochish` : "Ko'rish", 'btn--ghost btn--sm', () => showPeer(x.id, load)));
          body.append(r);
        });
      } catch (err) { if (!handleAuthError(err)) body.replaceChildren(el('p', 'muted', err.message)); }
    };
    wrap.addEventListener('toggle', () => { if (wrap.open) load(); });
    return wrap;
  };

  async function showPeer(id, after) {
    let d;
    try { d = await api(`/api/peers/${id}`); } catch (err) { fail(err); return; }
    const dlg = el('dialog', 'dialog site-dialog');
    const box = el('div', 'dialog__body');
    box.append(el('h2', '', `${d.name}ning ishi`));
    const html = d.files.filter((f) => /\.html?$/i.test(f.name));
    const css = d.files.filter((f) => /\.css$/i.test(f.name)).map((f) => f.text).join('\n');
    if (html.length) {
      const out = el('div', 'code-out');
      const f = el('iframe', 'code-preview');
      f.setAttribute('sandbox', '');
      f.title = 'Natija';
      f.srcdoc = `${html[0].text}<style>${css.replace(/<\/style/gi, '')}</style>`;
      out.append(f);
      box.append(out);
    }
    d.files.forEach((f) => {
      const x = el('details', '');
      x.append(el('summary', '', f.name), el('pre', 'code-pre', f.text));
      box.append(x);
    });
    if (!d.files.length) {
      box.append(el('p', 'muted', "Ko'rish uchun faylni yuklab oling:"));
      d.all_files.forEach((name, i) => { const a = el('a', 'file-chip', name); a.href = `/api/submissions/${id}/files/${i}`; a.setAttribute('download', name); box.append(a); });
    }
    if (!d.mine) {
      const my = d.reviews.find((r) => r.me);
      let val = my ? my.stars : 0;
      const line = el('div', 'star-pick');
      const paint = () => [...line.children].forEach((b, i) => { b.textContent = i < val ? '★' : '☆'; b.setAttribute('aria-pressed', String(i < val)); });
      for (let i = 1; i <= 5; i += 1) {
        const b = el('button', '', '☆');
        b.type = 'button';
        b.setAttribute('aria-label', `${i} yulduz`);
        b.addEventListener('click', () => { val = i; paint(); });
        line.append(b);
      }
      paint();
      const t = el('textarea', 'textarea');
      t.rows = 2;
      t.maxLength = 300;
      t.placeholder = "Nimasi yaxshi, nimani yaxshilash kerak? (10 belgidan ko'p yozsangiz +1 000 so'm)";
      t.value = my ? my.text : '';
      box.append(line, t, btn('Baho berish', 'btn--primary', () => {
        if (!val) { window.alert("Yulduz tanlang"); return; }
        api(`/api/peers/${id}`, { method: 'POST', body: { stars: val, text: t.value } }).then((r) => { dlg.close(); after?.(); if (r.pay) window.alert(`Rahmat! +${formatNumber(r.pay)} so'm`); }).catch(fail);
      }));
    }
    d.reviews.forEach((r) => {
      const row = el('div', 'group-row');
      row.append(el('span', '', `${stars(r.stars)} ${r.name}${r.text ? `: ${r.text}` : ''}`));
      if (isOwner || r.me) row.append(btn("O'chirish", 'btn--ghost btn--sm', () => api(`/api/peer-reviews/${r.id}`, { method: 'DELETE' }).then(() => { dlg.close(); after?.(); }).catch(fail)));
      box.append(row);
    });
    box.append(btn('Yopish', 'btn--ghost', () => dlg.close()));
    dlg.append(box);
    document.body.append(dlg);
    dlg.addEventListener('close', () => dlg.remove());
    dlg.showModal();
  }

  // ================= 13. Ovozli izoh =================
  function player(subId) {
    const a = el('audio', 'voice-player');
    a.controls = true;
    a.preload = 'none';
    a.src = `/api/submissions/${subId}/voice?t=${Date.now()}`;
    return a;
  }
  Oyin.voiceBox = (sub) => {
    const w = el('div', 'voice');
    if (!isOwner) {
      if (!sub.voice) return document.createDocumentFragment();
      w.append(el('strong', '', '🎤 Ustozning ovozli izohi'), player(sub.id));
      return w;
    }
    let rec = null;
    let timer = null;
    const draw = () => {
      w.replaceChildren();
      const b = btn('🎤 Ovozli izoh yozish', 'btn--ghost', start);
      w.append(b);
      if (sub.voice) {
        w.append(player(sub.id), btn("O'chirish", 'btn--ghost btn--sm', () => window.confirm("Ovozli izoh o'chirilsinmi?") && api(`/api/submissions/${sub.id}/voice`, { method: 'DELETE' }).then(() => { sub.voice = false; draw(); }).catch(fail)));
        b.textContent = '🎤 Qayta yozish';
      }
    };
    async function start() {
      if (!navigator.mediaDevices || !window.MediaRecorder) { window.alert("Brauzeringiz ovoz yozishni qo'llamaydi"); return; }
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { window.alert('Mikrofonga ruxsat bering'); return; }
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
      rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 48000 });
      const parts = [];
      let sec = 0;
      let keep = true;
      const stop = btn('⏹ Tugatish', 'btn--primary', () => rec.stop());
      const label = el('strong', 'voice__rec', '🔴 0:00');
      w.replaceChildren(label, stop, btn('Bekor', 'btn--ghost', () => { keep = false; rec.stop(); }));
      rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
      rec.onstop = async () => {
        clearInterval(timer);
        stream.getTracks().forEach((t) => t.stop());
        if (!keep) { draw(); return; }
        const type = (rec.mimeType || mime || 'audio/webm').split(';')[0];
        const form = new FormData();
        form.append('audio', new File([new Blob(parts, { type })], 'izoh', { type }));
        w.replaceChildren(el('span', 'muted', 'Yuborilmoqda…'));
        try {
          await api(`/api/submissions/${sub.id}/voice`, { method: 'POST', form });
          sub.voice = true;
        } catch (err) { fail(err); }
        draw();
      };
      rec.start();
      timer = setInterval(() => {
        sec += 1;
        label.textContent = `🔴 ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')} / 2:00`;
        if (sec >= 120) rec.stop();
      }, 1000);
    }
    draw();
    return w;
  };

  // ================= Sozlamalar (owner) =================
  viewLoaders.settings = async () => {
    const root = $('settings-root');
    if (!root || !isOwner) return;
    root.replaceChildren();
    const c = card('Ota-onalarga Telegram hisobot', 'send');
    const draw = (d) => {
      [...c.children].slice(1).forEach((x) => x.remove());
      if (!d.connected) {
        const ol = el('ol', 'muted steps');
        ["Telegramda @BotFather ni oching va /newbot yozing", 'Botga nom bering — u sizga uzun token beradi', "Tokenni pastga qo'ying va «Ulash»ni bosing"].forEach((t) => ol.append(el('li', '', t)));
        const inp = el('input', 'input-plain');
        inp.type = 'password';
        inp.autocomplete = 'off';
        inp.placeholder = 'Bot tokeni';
        c.append(ol, inp, btn('Ulash', 'btn--primary', (e) => {
          e.target.disabled = true;
          api('/api/telegram', { method: 'POST', body: { token: inp.value } }).then(draw).catch((err) => { e.target.disabled = false; fail(err); });
        }));
        return;
      }
      c.append(el('p', '', `✅ Ulangan: @${d.username}`));
      const l = el('label', 'pick');
      const cb = el('input', '');
      cb.type = 'checkbox';
      cb.checked = d.on;
      cb.addEventListener('change', () => api('/api/telegram/toggle', { method: 'POST', body: { on: cb.checked } }).then(draw).catch(fail));
      l.append(cb, el('span', '', 'Har yakshanba 18:00 da hisobot yuborilsin'));
      c.append(l);
      const line = el('div', 'btn-line');
      line.append(btn('Hozir hammaga yuborish', 'btn--primary', () => window.confirm(`${d.parents.length} ta ota-onaga hozir hisobot yuborilsinmi?`) && api('/api/telegram/send', { method: 'POST' }).then((r) => window.alert(`Yuborildi: ${r.sent} ta`)).catch(fail)),
        btn('Botni uzish', 'btn--ghost', () => window.confirm('Bot uzilsinmi?') && api('/api/telegram', { method: 'DELETE' }).then(draw).catch(fail)));
      c.append(line, el('h3', 'deco-h', "Ota-onaga havola"));
      const sel = el('select', 'input-plain');
      sel.append(new Option("O'quvchini tanlang", ''));
      d.students.forEach((s) => sel.append(new Option(s.name, s.id)));
      const out = el('input', 'input-plain');
      out.readOnly = true;
      out.placeholder = "Havola shu yerda chiqadi — ota-onaga yuboring";
      sel.addEventListener('change', () => sel.value && api(`/api/users/${sel.value}/tg-link`).then((r) => { out.value = r.url; out.select(); }).catch(fail));
      c.append(sel, out, btn('Nusxa olish', 'btn--ghost', (e) => { if (out.value) { navigator.clipboard?.writeText(out.value); e.target.textContent = 'Olindi ✓'; } }));
      c.append(el('h3', 'deco-h', `Ulangan ota-onalar: ${d.parents.length}`));
      d.parents.forEach((p) => {
        const r = el('div', 'group-row');
        r.append(el('span', '', `${p.student} — ${p.name}`), btn('Uzish', 'btn--ghost btn--sm', () => api(`/api/telegram/parents/${p.id}`, { method: 'DELETE' }).then(draw).catch(fail)));
        c.append(r);
      });
    };
    root.append(c);
    try { draw(await api('/api/telegram')); } catch (err) { handleAuthError(err); }
    const p = card('Baho berish', 'star');
    const l = el('label', 'pick');
    const cb = el('input', '');
    cb.type = 'checkbox';
    l.append(cb, el('span', '', "O'quvchilar bir-birining uy ishini ko'rib, baho bersin (o'zi topshirgandan keyin)"));
    p.append(l);
    api('/api/homeworks/0/peers').then((d) => { cb.checked = d.on; }).catch(() => {});
    cb.addEventListener('change', () => api('/api/peer-settings', { method: 'POST', body: { on: cb.checked } }).catch(fail));
    root.append(p);
  };
  viewLoaders.deco = () => decoCard($('deco-root'));

  // ================= 30. Telefonga o'rnatish va bildirishnoma =================
  const canPush = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  let deferred = null;
  const menu = $('account-menu');
  const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; paintInstall(); });
  window.addEventListener('appinstalled', () => { deferred = null; paintInstall(); });
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Mac/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  let installBtn;
  let pushBtn;
  function paintInstall() { if (installBtn) installBtn.hidden = standalone() || !(deferred || ios); }
  if (menu) {
    const sep = menu.querySelector('.menu__sep');
    installBtn = el('button', 'menu__item');
    installBtn.type = 'button';
    installBtn.append(icon('download'), el('span', '', "Telefonga o'rnatish"));
    installBtn.addEventListener('click', async () => {
      if (deferred) { deferred.prompt(); await deferred.userChoice; deferred = null; paintInstall(); } else if (ios) window.alert("Safari'da pastdagi «Ulashish» (⬆️) tugmasini bosing → «Bosh ekranga qo'shish».");
    });
    pushBtn = el('button', 'menu__item');
    pushBtn.type = 'button';
    pushBtn.append(icon('bell'), el('span', '', 'Bildirishnomani yoqish'));
    pushBtn.hidden = true;
    pushBtn.addEventListener('click', togglePush);
    menu.insertBefore(installBtn, sep);
    menu.insertBefore(pushBtn, sep);
    paintInstall();
    initPush();
    // chiqishda bu telefonga boshqa odamning xabari kelmasin
    $('logout-btn')?.addEventListener('click', () => {
      navigator.serviceWorker?.getRegistration().then((r) => r?.pushManager?.getSubscription()).then((s) => {
        if (s) fetch('/api/push/off', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: s.endpoint }), keepalive: true });
      }).catch(() => {});
    }, true);
  }
  async function currentSub() {
    const reg = await navigator.serviceWorker.ready;
    return { reg, sub: await reg.pushManager.getSubscription() };
  }
  async function initPush() {
    if (!canPush()) return;
    try {
      const { sub } = await currentSub();
      if (sub && Notification.permission === 'granted') await api('/api/push', { method: 'POST', body: { endpoint: sub.endpoint } }); // akkaunt almashgan bo'lsa ham to'g'ri odamga
      paintPush(Boolean(sub));
    } catch { paintPush(false); }
  }
  function paintPush(on) {
    pushBtn.hidden = false;
    pushBtn.dataset.on = on ? '1' : '';
    pushBtn.lastChild.textContent = on ? "Bildirishnomani o'chirish" : 'Bildirishnomani yoqish';
  }
  async function togglePush() {
    try {
      const { reg, sub } = await currentSub();
      if (sub) {
        await api('/api/push/off', { method: 'POST', body: { endpoint: sub.endpoint } });
        await sub.unsubscribe();
        paintPush(false);
        return;
      }
      if (await Notification.requestPermission() !== 'granted') { window.alert('Brauzer sozlamasida bildirishnomaga ruxsat bering'); return; }
      const { key } = await api('/api/push');
      const raw = atob(key.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(key.length / 4) * 4, '='));
      const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, (ch) => ch.charCodeAt(0)) });
      await api('/api/push', { method: 'POST', body: { endpoint: s.endpoint } });
      await api('/api/push/test', { method: 'POST' });
      paintPush(true);
    } catch (err) {
      if (!handleAuthError(err)) window.alert(err.message || "Bildirishnomani yoqib bo'lmadi");
    }
  }
})();
