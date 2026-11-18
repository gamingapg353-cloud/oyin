// Test bo'limi: owner test tuzib boshlaydi (HTML / CSS / JS, bazadan tanlash yoki o'zi yozish, 5 ta savol),
// foydalanuvchi ma'lumotni o'qib "Boshlash"ni bosadi, 5 ta savolga javob beradi — to'g'rilari soni ball bo'ladi.
(() => {
  const { api, handleAuthError, el, icon, viewLoaders } = window.Oyin;
  const APP = window.APP || {};
  const isOwner = APP.role === 'owner';
  const root = document.getElementById('exam-root');
  if (!root) return;

  const TOPICS = ['HTML', 'CSS', 'JS'];
  const SIZE = 5;
  let bank = null;               // owner: savollar bazasi
  const draft = { title: '', topics: new Set(['HTML']), picked: [], custom: [], editing: null };
  let run = null;                // foydalanuvchi: {exam, questions, index, answers}

  const card = (cls = '') => el('div', `card exam-card ${cls}`.trim());
  const btn = (text, iconName, cls = 'btn btn--primary') => {
    const b = el('button', cls);
    b.type = 'button';
    if (iconName) b.append(icon(iconName));
    b.append(el('span', '', text));
    return b;
  };
  const topicBadge = (t) => el('span', `exam-topic exam-topic--${t.toLowerCase()}`, t);
  function fail(err) {
    if (handleAuthError(err)) return;
    const msg = el('p', 'form-error', err.message);
    root.prepend(msg);
    setTimeout(() => msg.remove(), 5000);
  }

  // ---------------- Owner ----------------
  async function loadOwner() {
    root.replaceChildren(el('p', 'exam-muted', 'Yuklanmoqda…'));
    try {
      const [active, b] = await Promise.all([api('/api/exams/active'), bank ? null : api('/api/exams/bank')]);
      if (b) bank = b.questions;
      renderOwner(active);
    } catch (err) {
      fail(err);
    }
  }

  function renderOwner(active) {
    root.replaceChildren();
    if (active.exam) root.append(activeCard(active));
    root.append(builderCard());
  }

  function activeCard(active) {
    const c = card('exam-card--live');
    const head = el('div', 'exam-head');
    head.append(el('span', 'exam-live', 'Hozir davom etyapti'), el('h2', '', active.exam.title));
    const tags = el('div', 'exam-tags');
    active.exam.topics.forEach((t) => tags.append(topicBadge(t)));
    tags.append(el('span', 'exam-muted', `${active.exam.count} ta savol`));
    c.append(head, tags);
    const list = el('ol', 'exam-results');
    if (!active.results.length) list.append(el('li', 'exam-muted', "Hali hech kim boshlamadi — o'quvchilarga xabar ketdi."));
    active.results.forEach((r) => {
      const li = el('li');
      li.append(el('span', '', r.name), el('strong', '', r.finished ? `${r.score} / ${active.exam.count}` : 'yechmoqda…'));
      list.append(li);
    });
    const refresh = btn('Yangilash', 'refresh', 'btn btn--ghost');
    refresh.addEventListener('click', loadOwner);
    const end = btn('Testni tugatish', 'x', 'btn btn--ghost');
    end.addEventListener('click', async () => {
      if (!window.confirm("Testni tugatasizmi? Endi hech kim yecha olmaydi.")) return;
      try {
        await api(`/api/exams/${active.exam.id}/end`, { method: 'POST' });
        loadOwner();
      } catch (err) {
        fail(err);
      }
    });
    const actions = el('div', 'exam-actions');
    actions.append(refresh, end);
    c.append(el('h3', 'exam-sub', 'Natijalar'), list, actions);
    return c;
  }

  function total() {
    return draft.picked.length + draft.custom.length;
  }

  function builderCard() {
    const c = card();
    const head = el('div', 'card__head');
    const ic = el('span', 'card__icon');
    ic.append(icon('target'));
    const ht = el('div');
    ht.append(el('h2', '', 'Yangi test'), el('p', '', `Mavzuni yozing, bo'limlarni tanlang va ${SIZE} ta savol yig'ing. Har to'g'ri javob — 1 ball.`));
    head.append(ic, ht);
    c.append(head);

    // Mavzu
    const title = el('input', 'exam-input');
    title.placeholder = 'Mavzu, masalan: HTML teglar';
    title.maxLength = 80;
    title.value = draft.title;
    title.addEventListener('input', () => { draft.title = title.value; });
    c.append(el('label', 'field__label', 'Test mavzusi'), title);

    // Bo'limlar
    const chips = el('div', 'chips');
    TOPICS.forEach((t) => {
      const chip = el('button', draft.topics.has(t) ? 'chip is-on' : 'chip', t);
      chip.type = 'button';
      chip.setAttribute('aria-pressed', String(draft.topics.has(t)));
      chip.addEventListener('click', () => {
        if (draft.topics.has(t)) draft.topics.delete(t);
        else draft.topics.add(t);
        rerender();
      });
      chips.append(chip);
    });
    c.append(el('label', 'field__label', "Bo'limlar"), chips);

    // Tanlangan savollar
    const counter = el('div', total() === SIZE ? 'exam-counter is-full' : 'exam-counter', `Tanlandi: ${total()} / ${SIZE}`);
    c.append(counter);
    const chosen = el('ol', 'exam-chosen');
    draft.picked.forEach((qid) => {
      const q = bank[qid];
      const li = el('li');
      const rm = btn('', 'x', 'icon-btn icon-btn--sm');
      rm.title = 'Olib tashlash';
      rm.addEventListener('click', () => { draft.picked = draft.picked.filter((x) => x !== qid); rerender(); });
      li.append(topicBadge(q.topic), el('span', '', q.question), rm);
      chosen.append(li);
    });
    draft.custom.forEach((q, i) => {
      const li = el('li');
      const rm = btn('', 'x', 'icon-btn icon-btn--sm');
      rm.title = 'Olib tashlash';
      rm.addEventListener('click', () => { draft.custom.splice(i, 1); rerender(); });
      li.append(topicBadge(q.topic), el('span', '', `${q.question} (o'zim yozdim)`), rm);
      chosen.append(li);
    });
    if (total()) c.append(chosen);

    const actions = el('div', 'exam-actions');
    const fill = btn("Tasodifiy to'ldirish", 'sparkles', 'btn btn--ghost');
    fill.disabled = total() >= SIZE || !draft.topics.size;
    fill.addEventListener('click', () => {
      const pool = bank.filter((q) => draft.topics.has(q.topic) && !draft.picked.includes(q.qid));
      while (total() < SIZE && pool.length) {
        const [q] = pool.splice(Math.floor(Math.random() * pool.length), 1);
        draft.picked.push(q.qid);
      }
      rerender();
    });
    const write = btn("O'zim savol yozaman", 'plus', 'btn btn--ghost');
    write.disabled = total() >= SIZE;
    write.addEventListener('click', () => {
      draft.editing = { question: '', options: ['', '', '', ''], correct: 0, topic: [...draft.topics][0] || 'HTML' };
      rerender();
    });
    actions.append(fill, write);
    c.append(actions);

    if (draft.editing) c.append(editorBox());

    // Savollar bazasi
    if (draft.topics.size) {
      const list = el('div', 'exam-bank');
      bank.filter((q) => draft.topics.has(q.topic)).forEach((q) => {
        const row = el('label', 'exam-bank__row');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = draft.picked.includes(q.qid);
        cb.disabled = !cb.checked && total() >= SIZE;
        cb.addEventListener('change', () => {
          if (cb.checked) draft.picked.push(q.qid);
          else draft.picked = draft.picked.filter((x) => x !== q.qid);
          rerender();
        });
        const text = el('span', 'exam-bank__text');
        text.append(el('span', '', q.question), el('small', '', `To'g'ri javob: ${q.answer}`));
        row.append(cb, topicBadge(q.topic), text);
        list.append(row);
      });
      c.append(el('h3', 'exam-sub', `Savollar bazasi (${bank.filter((q) => draft.topics.has(q.topic)).length} ta) — belgilang`), list);
    } else {
      c.append(el('p', 'exam-muted', "Savollar bazasini ko'rish uchun bo'lim tanlang."));
    }

    const start = btn(`Testni boshlash (${total()}/${SIZE})`, 'check', 'btn btn--primary btn--lg');
    start.disabled = total() !== SIZE || !draft.title.trim();
    title.addEventListener('input', () => { start.disabled = total() !== SIZE || !draft.title.trim(); });
    start.addEventListener('click', async () => {
      start.disabled = true;
      try {
        await api('/api/exams', {
          method: 'POST',
          body: { title: draft.title, topics: [...draft.topics], bank: draft.picked, custom: draft.custom },
        });
        draft.title = '';
        draft.picked = [];
        draft.custom = [];
        loadOwner();
      } catch (err) {
        fail(err);
        start.disabled = false;
      }
    });
    c.append(el('p', 'exam-muted', "Boshlaganingizda o'quvchilarning ekranida «Test boshlandi» xabari chiqadi."), start);
    return c;
  }

  function editorBox() {
    const e = draft.editing;
    const box = el('div', 'exam-editor');
    box.append(el('strong', '', 'Yangi savol'));
    const topic = el('div', 'chips');
    TOPICS.forEach((t) => {
      const chip = el('button', e.topic === t ? 'chip is-on' : 'chip', t);
      chip.type = 'button';
      chip.addEventListener('click', () => { e.topic = t; rerender(); });
      topic.append(chip);
    });
    const q = el('textarea', 'textarea');
    q.rows = 2;
    q.maxLength = 300;
    q.placeholder = 'Savol matni, masalan: Havola qaysi teg bilan yoziladi?';
    q.value = e.question;
    q.addEventListener('input', () => { e.question = q.value; });
    box.append(topic, q, el('small', 'exam-muted', "4 ta variant yozing va to'g'risini belgilang:"));
    e.options.forEach((opt, i) => {
      const row = el('label', 'exam-opt');
      const radio = el('input');
      radio.type = 'radio';
      radio.name = 'exam-correct';
      radio.checked = e.correct === i;
      radio.addEventListener('change', () => { e.correct = i; });
      const input = el('input', 'exam-input');
      input.placeholder = `${'ABCD'[i]} variant`;
      input.maxLength = 150;
      input.value = opt;
      input.addEventListener('input', () => { e.options[i] = input.value; });
      row.append(radio, input);
      box.append(row);
    });
    const actions = el('div', 'exam-actions');
    const add = btn("Savolni qo'shish", 'check');
    add.addEventListener('click', () => {
      const opts = e.options.map((o) => o.trim());
      if (!e.question.trim() || opts.some((o) => !o)) {
        window.alert("Savol matni va 4 ta variantni to'ldiring");
        return;
      }
      if (new Set(opts).size !== 4) {
        window.alert("Variantlar bir xil bo'lmasin");
        return;
      }
      draft.custom.push({ topic: e.topic, question: e.question.trim(), options: opts, correct: e.correct });
      draft.editing = null;
      rerender();
    });
    const cancel = btn('Bekor qilish', 'x', 'btn btn--ghost');
    cancel.addEventListener('click', () => { draft.editing = null; rerender(); });
    actions.append(add, cancel);
    box.append(actions);
    return box;
  }

  let lastActive = null;
  function rerender() {
    if (lastActive) renderOwner(lastActive);
  }

  // ---------------- Foydalanuvchi ----------------
  async function loadUser() {
    if (run) {
      renderQuestion();
      return;
    }
    root.replaceChildren(el('p', 'exam-muted', 'Yuklanmoqda…'));
    try {
      renderUser(await api('/api/exams/active'));
    } catch (err) {
      fail(err);
    }
  }

  function renderUser(data) {
    root.replaceChildren();
    if (!data.exam) {
      const c = card('empty');
      const ic = el('span', 'empty__icon');
      ic.append(icon('target'));
      c.append(ic, el('h3', '', "Hozir test yo'q"), el('p', '', "Owner test boshlaganda ekraningiz tepasida xabar chiqadi."));
      root.append(c);
      return;
    }
    if (data.attempt.status === 'finished') {
      root.append(resultCard(data.exam, data.attempt.score, data.exam.count, data.attempt.review));
      return;
    }
    // Birinchi — ma'lumot, pastida "Boshlash"
    const c = card('exam-card--intro');
    const tags = el('div', 'exam-tags');
    data.exam.topics.forEach((t) => tags.append(topicBadge(t)));
    const info = el('ul', 'exam-info');
    [`${data.exam.count} ta savol`, "Har bir to'g'ri javob — 1 ball (reytingga qo'shiladi)",
      'Har savolda 4 ta variant, bittasi to\'g\'ri', 'Testni faqat bir marta yechasiz'].forEach((t) => {
      const li = el('li');
      li.append(icon('check'), el('span', '', t));
      info.append(li);
    });
    const start = btn('Boshlash', 'target', 'btn btn--primary btn--lg btn--block');
    start.addEventListener('click', async () => {
      start.disabled = true;
      try {
        const d = await api(`/api/exams/${data.exam.id}/begin`, { method: 'POST' });
        run = { exam: d.exam, questions: d.questions, index: 0, answers: d.questions.map(() => null) };
        renderQuestion();
      } catch (err) {
        fail(err);
        start.disabled = false;
      }
    });
    c.append(el('span', 'exam-live', 'Test boshlandi'), el('h2', '', data.exam.title), tags, info, start);
    root.append(c);
  }

  function renderQuestion() {
    const q = run.questions[run.index];
    root.replaceChildren();
    const c = card();
    const progress = el('div', 'exam-progress');
    run.questions.forEach((_, i) => progress.append(el('span', i < run.index ? 'is-done' : (i === run.index ? 'is-now' : ''))));
    c.append(el('div', 'exam-step', `Savol ${run.index + 1} / ${run.questions.length}`), progress, topicBadge(q.topic),
      el('p', 'exam-q', q.question));
    const opts = el('div', 'quiz__options');
    q.options.forEach((text, i) => {
      const o = el('button', run.answers[run.index] === i ? 'quiz__opt is-chosen' : 'quiz__opt');
      o.type = 'button';
      o.append(el('span', 'quiz__letter', 'ABCD'[i]), el('code', '', text));
      o.addEventListener('click', () => { run.answers[run.index] = i; renderQuestion(); });
      opts.append(o);
    });
    c.append(opts);
    const last = run.index === run.questions.length - 1;
    const actions = el('div', 'exam-actions');
    if (run.index > 0) {
      const back = btn('Orqaga', 'arrow-left', 'btn btn--ghost');
      back.addEventListener('click', () => { run.index -= 1; renderQuestion(); });
      actions.append(back);
    }
    const next = btn(last ? 'Yakunlash' : 'Keyingi', last ? 'check' : null);
    next.disabled = run.answers[run.index] === null;
    next.addEventListener('click', async () => {
      if (!last) {
        run.index += 1;
        renderQuestion();
        return;
      }
      next.disabled = true;
      try {
        const res = await api(`/api/exams/${run.exam.id}/submit`, { method: 'POST', body: { answers: run.answers } });
        const exam = run.exam;
        run = null;
        root.replaceChildren(resultCard(exam, res.score, res.total, res.review));
        window.Oyin.hideExamBanner?.();
      } catch (err) {
        fail(err);
        next.disabled = false;
      }
    });
    actions.append(next);
    c.append(actions);
    root.append(c);
  }

  function resultCard(exam, score, totalCount, review) {
    const c = card('exam-card--result');
    c.append(el('span', 'exam-live', 'Natija'), el('h2', '', exam.title),
      el('div', 'exam-score', `${score} / ${totalCount}`),
      el('p', '', `${totalCount} tadan ${score} ta to'g'ri — reytingga +${score} ball qo'shildi.`));
    const list = el('ol', 'exam-review');
    (review || []).forEach((r) => {
      const ok = r.chosen === r.correct;
      const li = el('li', ok ? 'is-right' : 'is-wrong');
      li.append(el('strong', '', r.question),
        el('span', '', ok ? `✓ ${r.options[r.correct]}` : `✗ Siz: ${r.chosen === null ? '—' : r.options[r.chosen]} · To'g'ri: ${r.options[r.correct]}`));
      if (r.explain) li.append(el('small', '', r.explain));
      list.append(li);
    });
    c.append(list);
    return c;
  }

  // Oxirgi holatni eslab qolamiz: bo'lim yoki savol tanlanganda shu holat bilan qayta chiziladi
  const drawOwner = renderOwner;
  renderOwner = (active) => {
    lastActive = active;
    drawOwner(active);
  };

  viewLoaders.exam = () => (isOwner ? loadOwner() : loadUser());
})();
