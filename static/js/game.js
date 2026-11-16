// Mahalla — xarita, yurish (piyoda / mashinada), tangalar, do'stlar, Ota hovli va Avtosalon
(() => {
  const { api, handleAuthError, el, icon, avatarColor, formatNumber } = window.Oyin;

  const $ = (id) => document.getElementById(id);
  const canvas = $('world');
  const ctx = canvas.getContext('2d');
  const mini = $('minimap');
  const mctx = mini.getContext('2d');

  const SYNC_MS = 150;
  const PICK_DIST = 34;
  const C = {
    grass: '#5c9442', grass2: '#57903e', road: '#3b404c', curb: '#a3aab6', line: '#facc15',
    yard: '#7aad59', fence: '#8b5a2b', dirt: '#b99561', water: '#3b82f6', waterLight: '#93c5fd',
  };
  const HOUSE_STYLES = [
    null,
    { w: 96, h: 50, wall: '#c9a676', roof: '#7c5a3a', flat: true, windows: 1 },
    { w: 112, h: 54, wall: '#d97757', roof: '#9f2d20', windows: 2 },
    { w: 126, h: 58, wall: '#f1ece2', roof: '#2f5d9c', windows: 3, chimney: true },
    { w: 136, h: 78, wall: '#f5deb3', roof: '#4b3a2f', windows: 3, floors: 2 },
    { w: 140, h: 82, wall: '#fffaf0', roof: '#b8860b', windows: 3, floors: 2, pool: true, gold: true },
  ];

  // ---------------- Holat ----------------
  let world;
  let catalog;
  let carsById = {};
  let walkSpeed = 190;
  let coinValue = 50;
  let offlineCap = 24;
  let me = null;
  let economy = null;
  let economyAt = 0;
  let houses = [];
  let solids = [];
  let myPlot = null;
  const coins = new Map();     // id -> {x, y}
  const pending = new Set();   // terilgan, server hali tasdiqlamagan tangalar
  const others = new Map();    // key -> {name, avatar, x, y, tx, ty, dir, car}
  const floaters = [];
  const keys = new Set();
  const touch = { up: false, down: false, left: false, right: false };
  let selectedCar = null;
  let zoom = 1;
  let viewW = 0;
  let viewH = 0;
  let dpr = 1;
  let sheetKind = null;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---------------- Rasmlar (avatarlar) ----------------
  const images = new Map();
  function imageFor(url) {
    if (!url) return null;
    let img = images.get(url);
    if (!img) {
      img = new Image();
      img.src = url;
      images.set(url, img);
    }
    return img.complete && img.naturalWidth ? img : null;
  }

  // ---------------- Yordamchilar ----------------
  let toastTimer = null;
  function toast(text, kind = '') {
    const node = $('toast');
    node.textContent = text;
    node.className = `toast ${kind ? `toast--${kind}` : ''}`;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 2600);
  }

  function money() {
    if (!economy) return 0;
    return economy.money + (economy.rate * (Date.now() - economyAt)) / 3600000;
  }

  // Oyna faqat haqiqatan nimadir o'zgarganda qayta chiziladi (aks holda tugmalar "qochib" ketadi)
  let sheetSig = '';
  function sheetSignature() {
    const m = money();
    const prices = sheetKind === 'house'
      ? [economy.next_house ? economy.next_house.price : 0]
      : catalog.cars.map((car) => car.price);
    return [sheetKind, economy.house_level, economy.cars.join(), me && me.car, ...prices.map((p) => m >= p)].join('|');
  }

  function setEconomy(next) {
    economy = next;
    economyAt = Date.now();
    if (me && me.car && !economy.cars.includes(me.car)) me.car = null;
    updateRideButton();
    if (sheetKind && sheetSignature() !== sheetSig) renderSheet();
  }

  function houseRect(plot) {
    const y = plot.gate === 'bottom' ? plot.y + 16 : plot.y + 64;
    return { x: plot.x + 40, y, w: 140, h: 90 };
  }

  function buildSolids() {
    solids = [world.shop, world.fountain, world.pond];
    houses.forEach((h) => {
      if (h.level > 0 && world.plots[h.plot]) solids.push(houseRect(world.plots[h.plot]));
    });
  }

  const inside = (x, y, s, r = 0) => x + r > s.x && x - r < s.x + s.w && y + r > s.y && y - r < s.y + s.h;

  function blocked(x, y, r) {
    if (x < r || y < r || x > world.w - r || y > world.h - r) return true;
    return solids.some((s) => inside(x, y, s, r));
  }

  function bestCar() {
    if (!economy || !economy.cars.length) return null;
    if (selectedCar && economy.cars.includes(selectedCar)) return selectedCar;
    return [...economy.cars].sort((a, b) => carsById[b].price - carsById[a].price)[0];
  }

  // ---------------- Mashinaga o'tirish / tushish ----------------
  function updateRideButton() {
    const label = $('ride-label');
    const iconBox = $('ride-icon');
    iconBox.replaceChildren(icon(me && me.car ? 'footprints' : 'car'));
    label.textContent = me && me.car ? 'Piyoda yurish' : "Mashinaga o'tirish";
  }

  function toggleRide() {
    if (!me) return;
    if (me.car) {
      me.car = null;
      toast('Endi piyodasiz');
    } else {
      const car = bestCar();
      if (!car) {
        toast('Avval Avtosalondan mashina oling', 'warn');
        return;
      }
      me.car = car;
      toast(`${carsById[car].name} mashinasidasiz`);
    }
    updateRideButton();
  }

  // ---------------- Harakat ----------------
  function step(dt) {
    let dx = 0;
    let dy = 0;
    if (!sheetKind) {
      if (keys.has('ArrowUp') || keys.has('KeyW') || touch.up) dy -= 1;
      if (keys.has('ArrowDown') || keys.has('KeyS') || touch.down) dy += 1;
      if (keys.has('ArrowLeft') || keys.has('KeyA') || touch.left) dx -= 1;
      if (keys.has('ArrowRight') || keys.has('KeyD') || touch.right) dx += 1;
    }
    me.moving = Boolean(dx || dy);
    if (me.moving) {
      const len = Math.hypot(dx, dy);
      dx /= len;
      dy /= len;
      const speed = walkSpeed * (me.car ? carsById[me.car].speed : 1);
      const r = me.car ? 20 : 13;
      const stuck = blocked(me.x, me.y, r); // yangi uy ustida qolsa — chiqib keta olsin
      const nx = me.x + dx * speed * dt;
      const ny = me.y + dy * speed * dt;
      if (stuck || !blocked(nx, me.y, r)) me.x = clamp(nx, r, world.w - r);
      if (stuck || !blocked(me.x, ny, r)) me.y = clamp(ny, r, world.h - r);
      me.dir = Math.atan2(dy, dx);
      me.walk += dt * 12;
    }

    // Tanga terish
    for (const [id, coin] of coins) {
      if (Math.hypot(coin.x - me.x, coin.y - me.y) < PICK_DIST) {
        pending.add(id);
        coins.delete(id);
        floaters.push({ x: coin.x, y: coin.y - 10, t: 0, text: `+${coinValue}` });
      }
    }

    // Boshqalar silliq harakatlansin
    const k = Math.min(1, dt * 10);
    others.forEach((p) => {
      const ox = p.x;
      const oy = p.y;
      p.x += (p.tx - p.x) * k;
      p.y += (p.ty - p.y) * k;
      p.moving = Math.hypot(p.x - ox, p.y - oy) > 0.3;
      if (p.moving) p.walk = (p.walk || 0) + dt * 12;
    });

    for (let i = floaters.length - 1; i >= 0; i -= 1) {
      floaters[i].t += dt;
      if (floaters[i].t > 1.1) floaters.splice(i, 1);
    }
  }

  // ---------------- Chizish ----------------
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    viewW = window.innerWidth;
    viewH = window.innerHeight;
    canvas.width = Math.round(viewW * dpr);
    canvas.height = Math.round(viewH * dpr);
    canvas.style.width = `${viewW}px`;
    canvas.style.height = `${viewH}px`;
    zoom = Math.min(viewW, viewH) < 600 ? 0.72 : 1;
  }

  function camera() {
    const w = viewW / zoom;
    const h = viewH / zoom;
    const x = w >= world.w ? (world.w - w) / 2 : clamp(me.x - w / 2, 0, world.w - w);
    const y = h >= world.h ? (world.h - h) / 2 : clamp(me.y - h / 2, 0, world.h - h);
    return { x, y, w, h };
  }

  const visible = (x, y, pad, cam) => x > cam.x - pad && x < cam.x + cam.w + pad && y > cam.y - pad && y < cam.y + cam.h + pad;

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }

  function drawGround(cam) {
    ctx.fillStyle = '#0a1020';
    ctx.fillRect(cam.x - 2, cam.y - 2, cam.w + 4, cam.h + 4);
    ctx.fillStyle = C.grass;
    ctx.fillRect(0, 0, world.w, world.h);
    // Yengil "katak" naqsh
    ctx.fillStyle = C.grass2;
    const size = 80;
    const x0 = Math.max(0, Math.floor(cam.x / size) * size);
    const y0 = Math.max(0, Math.floor(cam.y / size) * size);
    for (let x = x0; x < Math.min(world.w, cam.x + cam.w); x += size) {
      for (let y = y0; y < Math.min(world.h, cam.y + cam.h); y += size) {
        if (((x + y) / size) % 2 === 0) ctx.fillRect(x, y, size, size);
      }
    }
  }

  function drawRoads() {
    const R = world.road;
    ctx.fillStyle = C.road;
    world.h_roads.forEach((y) => ctx.fillRect(0, y, world.w, R));
    world.v_roads.forEach((x) => ctx.fillRect(x, 0, R, world.h));

    // O'rta chiziq
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 3;
    ctx.setLineDash([22, 18]);
    ctx.beginPath();
    world.h_roads.forEach((y) => { ctx.moveTo(0, y + R / 2); ctx.lineTo(world.w, y + R / 2); });
    world.v_roads.forEach((x) => { ctx.moveTo(x + R / 2, 0); ctx.lineTo(x + R / 2, world.h); });
    ctx.stroke();
    ctx.setLineDash([]);

    // Chorrahalar (chiziqsiz) va yo'l chetlari
    ctx.fillStyle = C.road;
    world.h_roads.forEach((y) => world.v_roads.forEach((x) => ctx.fillRect(x, y, R, R)));
    ctx.strokeStyle = C.curb;
    ctx.lineWidth = 3;
    ctx.beginPath();
    world.h_roads.forEach((y) => {
      ctx.moveTo(0, y); ctx.lineTo(world.w, y);
      ctx.moveTo(0, y + R); ctx.lineTo(world.w, y + R);
    });
    world.v_roads.forEach((x) => {
      ctx.moveTo(x, 0); ctx.lineTo(x, world.h);
      ctx.moveTo(x + R, 0); ctx.lineTo(x + R, world.h);
    });
    ctx.stroke();
    // Piyodalar yo'lagi (zebra)
    ctx.fillStyle = 'rgba(255,255,255,.75)';
    world.h_roads.forEach((y) => world.v_roads.forEach((x) => {
      for (let i = 0; i < 5; i += 1) {
        ctx.fillRect(x - 18, y + 6 + i * 15, 14, 8);
        ctx.fillRect(x + R + 4, y + 6 + i * 15, 14, 8);
      }
    }));
  }

  function drawPond(now) {
    const p = world.pond;
    ctx.fillStyle = '#2f6fbd';
    ctx.beginPath();
    ctx.ellipse(p.x + p.w / 2, p.y + p.h / 2, p.w / 2, p.h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = C.dirt;
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.35)';
    ctx.lineWidth = 2;
    const wave = (now / 900) % 1;
    for (let i = 0; i < 3; i += 1) {
      const s = 0.3 + ((wave + i / 3) % 1) * 0.6;
      ctx.beginPath();
      ctx.ellipse(p.x + p.w / 2, p.y + p.h / 2, (p.w / 2) * s, (p.h / 2) * s, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = '#4ade80';
    [[0.25, 0.4], [0.7, 0.3], [0.6, 0.72]].forEach(([fx, fy]) => {
      ctx.beginPath();
      ctx.arc(p.x + p.w * fx, p.y + p.h * fy, 9, 0.3, Math.PI * 2);
      ctx.fill();
    });
  }

  function drawFountain(now) {
    const f = world.fountain;
    const cx = f.x + f.w / 2;
    const cy = f.y + f.h / 2;
    ctx.fillStyle = '#cbd5e1';
    ctx.beginPath(); ctx.arc(cx, cy, f.w / 2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.water;
    ctx.beginPath(); ctx.arc(cx, cy, f.w / 2 - 12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#e2e8f0';
    ctx.beginPath(); ctx.arc(cx, cy, 16, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.waterLight;
    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * Math.PI * 2 + now / 700;
      ctx.beginPath(); ctx.arc(cx + Math.cos(a) * 34, cy + Math.sin(a) * 34, 4, 0, Math.PI * 2); ctx.fill();
    }
    label('Bog‘', cx, f.y - 14, 'rgba(15,23,42,.65)');
  }

  function drawWindow(x, y, w, h) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
    ctx.fillStyle = '#9bd3ff';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = 'rgba(255,255,255,.6)';
    ctx.fillRect(x + 2, y + 2, w / 3, h - 4);
  }

  function drawHouse(rect, level) {
    const s = HOUSE_STYLES[level];
    const baseY = rect.y + rect.h;
    const x = rect.x + (rect.w - s.w) / 2;
    const top = baseY - s.h;

    ctx.fillStyle = 'rgba(0,0,0,.2)';
    ctx.fillRect(x + 8, baseY - 4, s.w, 10);

    // Tom (devor orqasida)
    ctx.fillStyle = s.roof;
    if (s.flat) {
      ctx.fillRect(x - 6, top - 10, s.w + 12, 14);
    } else {
      ctx.beginPath();
      ctx.moveTo(x - 12, top + 4);
      ctx.lineTo(x + 18, top - 34);
      ctx.lineTo(x + s.w - 18, top - 34);
      ctx.lineTo(x + s.w + 12, top + 4);
      ctx.closePath();
      ctx.fill();
    }
    if (s.chimney) {
      ctx.fillStyle = '#7f1d1d';
      ctx.fillRect(x + s.w - 34, top - 40, 14, 22);
    }

    // Devor
    ctx.fillStyle = s.wall;
    ctx.fillRect(x, top, s.w, s.h);
    if (s.gold) {
      ctx.fillStyle = '#d4a017';
      ctx.fillRect(x, top, s.w, 5);
      ctx.fillRect(x, top + s.h / 2 - 2, s.w, 4);
    }
    if (s.floors === 2) {
      ctx.fillStyle = 'rgba(0,0,0,.12)';
      ctx.fillRect(x, top + s.h / 2 - 1, s.w, 3);
      // Balkon
      ctx.fillStyle = '#a16207';
      ctx.fillRect(x + s.w / 2 - 24, top + s.h / 2 - 4, 48, 5);
    }

    // Eshik
    ctx.fillStyle = '#6b4226';
    ctx.fillRect(x + s.w / 2 - 9, baseY - 26, 18, 26);
    ctx.fillStyle = '#facc15';
    ctx.fillRect(x + s.w / 2 + 4, baseY - 14, 3, 3);

    // Derazalar
    const rows = s.floors === 2 ? [top + 9, top + s.h / 2 + 8] : [top + 12];
    rows.forEach((wy, rowIndex) => {
      const lower = rowIndex === rows.length - 1;
      const count = s.windows;
      for (let i = 0; i < count; i += 1) {
        let wx = x + ((i + 1) * s.w) / (count + 1) - 9;
        if (lower && Math.abs(wx + 9 - (x + s.w / 2)) < 20) wx += count === 1 ? 30 : (wx + 9 < x + s.w / 2 ? -14 : 14);
        drawWindow(wx, wy, 18, 14);
      }
    });
  }

  function label(text, x, y, bg = 'rgba(15,23,42,.72)', color = '#ffffff') {
    ctx.font = '600 12px "Plus Jakarta Sans", system-ui, sans-serif';
    const w = ctx.measureText(text).width + 14;
    ctx.fillStyle = bg;
    roundRect(x - w / 2, y - 10, w, 20, 10);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 1);
  }

  function drawPlots() {
    world.plots.forEach((plot, index) => {
      const owner = houses.find((h) => h.plot === index);
      const mine = index === myPlot;
      const gateX = plot.x + plot.w / 2;
      const gateY = plot.gate === 'bottom' ? plot.y + plot.h : plot.y;

      if (!owner) {
        ctx.strokeStyle = 'rgba(255,255,255,.25)';
        ctx.setLineDash([8, 8]);
        ctx.lineWidth = 2;
        ctx.strokeRect(plot.x + 6, plot.y + 6, plot.w - 12, plot.h - 12);
        ctx.setLineDash([]);
        return;
      }

      // Hovli yeri
      ctx.fillStyle = owner.level ? C.yard : C.dirt;
      ctx.fillRect(plot.x, plot.y, plot.w, plot.h);
      if (owner.level >= 5) {
        // Hovuz
        const px = plot.x + 14;
        const py = plot.gate === 'bottom' ? plot.y + plot.h - 52 : plot.y + 14;
        ctx.fillStyle = '#38bdf8';
        roundRect(px, py, 52, 34, 8);
        ctx.fill();
        ctx.strokeStyle = '#e0f2fe';
        ctx.lineWidth = 3;
        ctx.stroke();
      }

      // Devor (darvoza joyi ochiq)
      ctx.strokeStyle = mine ? '#60a5fa' : C.fence;
      ctx.lineWidth = mine ? 5 : 4;
      ctx.beginPath();
      if (plot.gate === 'bottom') {
        ctx.moveTo(gateX - 24, plot.y + plot.h);
        ctx.lineTo(plot.x, plot.y + plot.h);
        ctx.lineTo(plot.x, plot.y);
        ctx.lineTo(plot.x + plot.w, plot.y);
        ctx.lineTo(plot.x + plot.w, plot.y + plot.h);
        ctx.lineTo(gateX + 24, plot.y + plot.h);
      } else {
        ctx.moveTo(gateX - 24, plot.y);
        ctx.lineTo(plot.x, plot.y);
        ctx.lineTo(plot.x, plot.y + plot.h);
        ctx.lineTo(plot.x + plot.w, plot.y + plot.h);
        ctx.lineTo(plot.x + plot.w, plot.y);
        ctx.lineTo(gateX + 24, plot.y);
      }
      ctx.stroke();

      if (owner.level) {
        drawHouse(houseRect(plot), owner.level);
      } else {
        // Hali sotib olinmagan — poydevor va "Sotuvda" taxtachasi
        const r = houseRect(plot);
        ctx.strokeStyle = 'rgba(0,0,0,.25)';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 6]);
        ctx.strokeRect(r.x + 10, r.y + 20, r.w - 20, r.h - 30);
        ctx.setLineDash([]);
        label('Sotuvda', r.x + r.w / 2, r.y + r.h / 2 + 4, '#b45309');
      }

      const signY = plot.gate === 'bottom' ? gateY + 2 : gateY - 2;
      const text = mine ? 'Sizning Ota hovlingiz' : `${owner.name} hovlisi`;
      label(owner.level ? `${text} · ${owner.level}` : text, gateX, signY, mine ? '#2563eb' : 'rgba(15,23,42,.72)');
    });
  }

  function drawMiniCar(x, y, color, dir = 0, scale = 1) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(dir);
    ctx.scale(scale, scale);
    ctx.fillStyle = 'rgba(0,0,0,.25)';
    roundRect(-27, -13, 58, 32, 9);
    ctx.fill();
    ctx.fillStyle = '#111827';
    [[-18, -17], [12, -17], [-18, 13], [12, 13]].forEach(([wx, wy]) => ctx.fillRect(wx, wy, 10, 5));
    ctx.fillStyle = color;
    roundRect(-28, -15, 56, 30, 8);
    ctx.fill();
    ctx.fillStyle = 'rgba(15,23,42,.75)';
    roundRect(-6, -11, 20, 22, 4);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.35)';
    ctx.fillRect(-22, -11, 10, 22);
    ctx.fillStyle = '#fde68a';
    ctx.fillRect(25, -12, 3, 6);
    ctx.fillRect(25, 6, 3, 6);
    ctx.restore();
  }

  function drawShop() {
    const s = world.shop;
    ctx.fillStyle = 'rgba(0,0,0,.2)';
    ctx.fillRect(s.x + 10, s.y + s.h - 4, s.w, 12);
    ctx.fillStyle = '#e2e8f0';
    ctx.fillRect(s.x, s.y, s.w, s.h);
    ctx.fillStyle = '#1e3a8a';
    ctx.fillRect(s.x, s.y, s.w, 34);
    ctx.font = '700 18px "Plus Jakarta Sans", system-ui, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('AVTOSALON', s.x + s.w / 2, s.y + 18);
    // Vitrina
    ctx.fillStyle = '#93c5fd';
    ctx.fillRect(s.x + 14, s.y + 46, s.w - 28, s.h - 92);
    catalog.cars.slice(0, 3).forEach((car, i) => drawMiniCar(s.x + 62 + i * 88, s.y + 92, car.color, 0, 0.8));
    // Eshik
    ctx.fillStyle = '#334155';
    ctx.fillRect(s.x + s.w / 2 - 26, s.y + s.h - 40, 52, 40);
    ctx.fillStyle = '#7dd3fc';
    ctx.fillRect(s.x + s.w / 2 - 22, s.y + s.h - 36, 20, 36);
    ctx.fillRect(s.x + s.w / 2 + 2, s.y + s.h - 36, 20, 36);
  }

  function drawTree(t) {
    ctx.fillStyle = 'rgba(0,0,0,.2)';
    ctx.beginPath();
    ctx.ellipse(t.x + 6, t.y + t.r * 0.7, t.r, t.r * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#7c4a21';
    ctx.fillRect(t.x - 4, t.y, 8, t.r * 0.7);
    ctx.fillStyle = '#2f6b2a';
    ctx.beginPath(); ctx.arc(t.x, t.y - t.r * 0.3, t.r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#3f8a37';
    ctx.beginPath(); ctx.arc(t.x - t.r * 0.3, t.y - t.r * 0.55, t.r * 0.55, 0, Math.PI * 2); ctx.fill();
  }

  function drawCoins(now, cam) {
    coins.forEach((c, id) => {
      if (!visible(c.x, c.y, 30, cam)) return;
      const bob = Math.sin(now / 280 + id) * 3;
      ctx.fillStyle = 'rgba(0,0,0,.2)';
      ctx.beginPath(); ctx.ellipse(c.x, c.y + 10, 8, 3, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#f59e0b';
      ctx.beginPath(); ctx.arc(c.x, c.y + bob, 11, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fcd34d';
      ctx.beginPath(); ctx.arc(c.x, c.y + bob, 8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#b45309';
      ctx.font = '700 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('$', c.x, c.y + bob + 1);
    });
  }

  function drawFace(p, x, y, r) {
    const img = imageFor(p.avatar);
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.clip();
    if (img) {
      ctx.drawImage(img, x - r, y - r, r * 2, r * 2);
    } else {
      ctx.fillStyle = avatarColor(p.name);
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
      ctx.fillStyle = '#ffffff';
      ctx.font = `700 ${Math.round(r * 1.05)}px "Plus Jakarta Sans", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(p.name || '?').charAt(0).toUpperCase(), x, y + 1);
    }
    ctx.restore();
  }

  function drawPlayer(p, isMe) {
    const { x, y } = p;
    if (p.car && carsById[p.car]) {
      drawMiniCar(x, y, carsById[p.car].color, p.dir || 0);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      drawFace(p, x, y, 9);
      ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke();
      label(isMe ? 'Siz' : p.name, x, y - 32, isMe ? '#2563eb' : 'rgba(15,23,42,.72)');
      return;
    }
    const bob = p.moving ? Math.abs(Math.sin(p.walk || 0)) * 3 : 0;
    // Oyoqlar
    ctx.fillStyle = '#1f2937';
    const swing = p.moving ? Math.sin(p.walk || 0) * 4 : 0;
    ctx.fillRect(x - 7 + swing, y + 10, 5, 8);
    ctx.fillRect(x + 2 - swing, y + 10, 5, 8);
    // Soya
    ctx.fillStyle = 'rgba(0,0,0,.25)';
    ctx.beginPath(); ctx.ellipse(x, y + 18, 13, 5, 0, 0, Math.PI * 2); ctx.fill();
    // Bosh (avatar)
    const r = 15;
    drawFace(p, x, y - bob, r);
    ctx.strokeStyle = isMe ? '#ffffff' : avatarColor(p.name);
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(x, y - bob, r, 0, Math.PI * 2); ctx.stroke();
    label(isMe ? 'Siz' : p.name, x, y - 32 - bob, isMe ? '#2563eb' : 'rgba(15,23,42,.72)');
  }

  function drawFloaters() {
    floaters.forEach((f) => {
      ctx.globalAlpha = Math.max(0, 1 - f.t);
      ctx.font = '800 16px "Plus Jakarta Sans", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#7c2d12';
      ctx.fillText(f.text, f.x + 1, f.y - f.t * 40 + 1);
      ctx.fillStyle = '#fde047';
      ctx.fillText(f.text, f.x, f.y - f.t * 40);
      ctx.globalAlpha = 1;
    });
  }

  function draw(now) {
    const cam = camera();
    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, -cam.x * dpr * zoom, -cam.y * dpr * zoom);
    drawGround(cam);
    drawRoads();
    drawPond(now);
    drawFountain(now);
    drawPlots();
    drawShop();
    drawCoins(now, cam);

    // Chuqurlik: pastdagilar oldinda
    const sprites = [];
    world.trees.forEach((t) => { if (visible(t.x, t.y, 60, cam)) sprites.push([t.y + t.r * 0.6, () => drawTree(t)]); });
    others.forEach((p) => sprites.push([p.y, () => drawPlayer(p, false)]));
    sprites.push([me.y, () => drawPlayer(me, true)]);
    sprites.sort((a, b) => a[0] - b[0]).forEach(([, fn]) => fn());
    drawFloaters();
  }

  let lastMini = 0;
  function drawMinimap(now) {
    if (now - lastMini < 200) return;
    lastMini = now;
    const s = mini.width / world.w;
    mctx.setTransform(s, 0, 0, s, 0, 0);
    mctx.fillStyle = C.grass;
    mctx.fillRect(0, 0, world.w, world.h);
    mctx.fillStyle = C.road;
    world.h_roads.forEach((y) => mctx.fillRect(0, y, world.w, world.road));
    world.v_roads.forEach((x) => mctx.fillRect(x, 0, world.road, world.h));
    mctx.fillStyle = '#3b82f6';
    mctx.fillRect(world.pond.x, world.pond.y, world.pond.w, world.pond.h);
    world.plots.forEach((plot, i) => {
      const h = houses.find((item) => item.plot === i);
      if (!h) return;
      mctx.fillStyle = i === myPlot ? '#60a5fa' : (h.level ? '#d97757' : C.dirt);
      mctx.fillRect(plot.x, plot.y, plot.w, plot.h);
    });
    mctx.fillStyle = '#f59e0b';
    mctx.fillRect(world.shop.x, world.shop.y, world.shop.w, world.shop.h);
    mctx.fillStyle = '#fde047';
    coins.forEach((c) => mctx.fillRect(c.x - 12, c.y - 12, 24, 24));
    mctx.fillStyle = '#f472b6';
    others.forEach((p) => { mctx.beginPath(); mctx.arc(p.x, p.y, 45, 0, Math.PI * 2); mctx.fill(); });
    mctx.fillStyle = '#ffffff';
    mctx.strokeStyle = '#1d4ed8';
    mctx.lineWidth = 20;
    mctx.beginPath(); mctx.arc(me.x, me.y, 55, 0, Math.PI * 2); mctx.fill(); mctx.stroke();
  }

  // ---------------- HUD ----------------
  let shownMoney = -1;
  function updateHud() {
    const value = Math.floor(money());
    if (value !== shownMoney) {
      shownMoney = value;
      $('money').textContent = formatNumber(value);
    }
    const rateText = `+${formatNumber(economy.rate)} so'm / soat`;
    if ($('rate').textContent !== rateText) $('rate').textContent = rateText;
  }

  let friendsSig = '';
  function renderFriends() {
    const list = [...others.values()];
    $('online-count').textContent = list.length + 1;
    const sig = list.map((p) => `${p.name}|${p.avatar}`).join(',');
    if (sig === friendsSig) return;
    friendsSig = sig;
    const box = $('friends');
    box.replaceChildren();
    box.hidden = list.length === 0;
    if (!list.length) return;
    box.append(el('small', '', "Do'stlar o'yinda"));
    list.slice(0, 8).forEach((p) => {
      const row = el('div', 'friend');
      const av = el('span', 'avatar');
      if (p.avatar) {
        const img = el('img');
        img.src = p.avatar;
        img.alt = '';
        av.append(img);
      } else {
        av.textContent = p.name.charAt(0).toUpperCase();
        av.style.setProperty('--avatar', avatarColor(p.name));
      }
      row.append(av, el('span', '', p.name));
      box.append(row);
    });
  }

  // ---------------- Ota hovli va Avtosalon oynasi ----------------
  const sheet = $('sheet');
  const sheetBackdrop = $('sheet-backdrop');

  function openSheet(kind) {
    sheetKind = kind;
    keys.clear();
    renderSheet();
    sheet.hidden = false;
    sheetBackdrop.hidden = false;
    $('sheet-close').focus();
  }

  function closeSheet() {
    sheetKind = null;
    sheet.hidden = true;
    sheetBackdrop.hidden = true;
  }

  function priceButton(text, price, onClick) {
    const btn = el('button', 'btn btn--primary btn--block');
    btn.type = 'button';
    const enough = money() >= price;
    btn.disabled = !enough;
    btn.append(icon(enough ? 'coins' : 'lock'), el('span', '', enough
      ? `${text} — ${formatNumber(price)} so'm`
      : `Yana ${formatNumber(price - money())} so'm kerak`));
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await onClick();
      } catch (err) {
        if (!handleAuthError(err)) toast(err.message, 'warn');
        renderSheet();
      }
    });
    return btn;
  }

  function renderSheet() {
    const body = $('sheet-body');
    const headIcon = $('sheet-icon');
    sheetSig = sheetSignature();
    body.replaceChildren();

    if (sheetKind === 'house') {
      headIcon.replaceChildren(icon('home'));
      $('sheet-title').textContent = 'Ota hovli';
      $('sheet-sub').textContent = 'Kuchaytirgan sari ko‘proq pul olib keladi';
      const level = economy.house_level;

      const now = el('div', 'house-now');
      const dots = el('div', 'level-dots');
      catalog.houses.forEach((h) => dots.append(el('span', h.level <= level ? 'is-on' : '')));
      now.append(dots);
      if (level) {
        now.append(el('strong', '', `${economy.house.name}`),
          el('span', '', `${level}-daraja · +${formatNumber(economy.house.income)} so'm / soat`));
      } else {
        now.append(el('strong', '', "Sizda hali Ota hovli yo'q"),
          el('span', '', 'Sotib oling — har soatda pul keladi'));
      }
      body.append(now);

      const next = economy.next_house;
      if (next) {
        const box = el('div', 'offer');
        box.append(el('small', 'eyebrow', level ? 'Keyingi daraja' : 'Birinchi qadam'),
          el('strong', '', next.name),
          el('span', '', `+${formatNumber(next.income)} so'm / soat`));
        box.append(priceButton(level ? 'Kuchaytirish' : 'Sotib olish', next.price, async () => {
          const data = await api('/api/game/house', { method: 'POST' });
          houses = data.houses;
          buildSolids();
          setEconomy(data.economy);
          toast(`Tabriklaymiz! ${data.economy.house.name}`, 'success');
        }));
        body.append(box);
      } else {
        const done = el('div', 'offer offer--done');
        done.append(icon('trophy'), el('strong', '', "Eng yuqori daraja! Ota hovlingiz mahallada eng zo'ri."));
        body.append(done);
      }

      const list = el('ol', 'level-list');
      catalog.houses.forEach((h) => {
        const li = el('li', h.level <= level ? 'is-done' : '');
        li.append(el('span', '', `${h.level}. ${h.name}`), el('small', '', `${formatNumber(h.price)} so'm · +${formatNumber(h.income)}/soat`));
        list.append(li);
      });
      body.append(list);
      body.append(el('p', 'sheet-note', `Daromad o'yinda bo'lmasangiz ham yig'iladi (${offlineCap} soatgacha).`));
      return;
    }

    // Avtosalon
    headIcon.replaceChildren(icon('car'));
    $('sheet-title').textContent = 'Avtosalon';
    $('sheet-sub').textContent = 'Mashina tez yuradi va har soatda pul olib keladi';
    const list = el('div', 'car-list');
    catalog.cars.forEach((car) => {
      const owned = economy.cars.includes(car.id);
      const row = el('div', owned ? 'car-row is-owned' : 'car-row');
      const swatch = el('span', 'car-row__swatch');
      swatch.style.setProperty('--car', car.color);
      swatch.append(icon('car'));
      const info = el('div', 'car-row__info');
      info.append(el('strong', '', car.name),
        el('small', '', `Tezlik ×${car.speed} · +${formatNumber(car.income)} so'm / soat`));
      row.append(swatch, info);

      if (owned) {
        const driving = me.car === car.id;
        const btn = el('button', driving ? 'btn btn--ghost' : 'btn btn--primary');
        btn.type = 'button';
        btn.append(icon(driving ? 'check' : 'car'), el('span', '', driving ? 'Haydayapsiz' : 'Haydash'));
        btn.disabled = driving;
        btn.addEventListener('click', () => {
          selectedCar = car.id;
          me.car = car.id;
          updateRideButton();
          closeSheet();
          toast(`${car.name} mashinasidasiz. Tushish uchun — E`);
        });
        row.append(btn);
      } else {
        const buy = priceButton('Olish', car.price, async () => {
          const data = await api(`/api/game/cars/${car.id}`, { method: 'POST' });
          setEconomy(data.economy);
          toast(`Tabriklaymiz! ${car.name} endi sizniki`, 'success');
        });
        buy.classList.remove('btn--block');
        row.append(buy);
      }
      list.append(row);
    });
    body.append(list);
    body.append(el('p', 'sheet-note', "Mashinaga o'tirish va tushish — E tugmasi yoki pastdagi tugma."));
  }

  $('btn-house').addEventListener('click', () => openSheet('house'));
  $('btn-shop').addEventListener('click', () => openSheet('shop'));
  $('btn-ride').addEventListener('click', toggleRide);
  $('sheet-close').addEventListener('click', closeSheet);
  sheetBackdrop.addEventListener('click', closeSheet);

  // ---------------- Boshqaruv ----------------
  const MOVE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD']);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sheetKind) {
      closeSheet();
      return;
    }
    if (sheetKind) return;
    if (MOVE_KEYS.has(e.code)) {
      keys.add(e.code);
      e.preventDefault();
    } else if (e.code === 'KeyE' && !e.repeat) {
      toggleRide();
    }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());

  document.querySelectorAll('[data-dir]').forEach((btn) => {
    const dir = btn.dataset.dir;
    const on = (e) => { e.preventDefault(); touch[dir] = true; btn.classList.add('is-down'); };
    const off = () => { touch[dir] = false; btn.classList.remove('is-down'); };
    btn.addEventListener('pointerdown', on);
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((t) => btn.addEventListener(t, off));
  });

  window.addEventListener('resize', resize);

  // ---------------- Server bilan almashinuv ----------------
  function applySync(data) {
    if (data.correct) {
      me.x = data.correct.x;
      me.y = data.correct.y;
    }
    if (data.houses) {
      houses = data.houses;
      buildSolids();
    }
    setEconomy(data.economy);

    coins.clear();
    data.coins.forEach((c) => { if (!pending.has(c.id)) coins.set(c.id, c); });

    const seen = new Set();
    data.players.forEach((p) => {
      seen.add(p.key);
      const known = others.get(p.key);
      if (known) Object.assign(known, { tx: p.x, ty: p.y, dir: p.dir, car: p.car, name: p.name, avatar: p.avatar });
      else others.set(p.key, { ...p, tx: p.x, ty: p.y, walk: 0 });
    });
    [...others.keys()].forEach((key) => { if (!seen.has(key)) others.delete(key); });
    renderFriends();
  }

  async function syncLoop() {
    for (;;) {
      const started = performance.now();
      const pick = [...pending];
      try {
        const data = await api('/api/game/sync', {
          method: 'POST',
          body: { x: Math.round(me.x), y: Math.round(me.y), dir: me.dir, car: me.car, pick },
        });
        pick.forEach((id) => pending.delete(id));
        applySync(data);
        $('conn').hidden = true;
      } catch (err) {
        if (handleAuthError(err)) return;
        $('conn').hidden = false;
      }
      const wait = Math.max(30, SYNC_MS - (performance.now() - started));
      await new Promise((resolve) => { setTimeout(resolve, wait); });
    }
  }

  // ---------------- Boshlash ----------------
  let last = performance.now();
  function loop(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    step(dt);
    draw(now);
    drawMinimap(now);
    updateHud();
    requestAnimationFrame(loop);
  }

  async function start() {
    try {
      const s = await api('/api/game/state');
      world = s.world;
      catalog = s.catalog;
      carsById = Object.fromEntries(catalog.cars.map((car) => [car.id, car]));
      walkSpeed = s.walk_speed;
      coinValue = s.coin_value;
      offlineCap = s.offline_cap_hours;
      me = { ...s.me, x: s.me.spawn.x, y: s.me.spawn.y, dir: Math.PI / 2, car: null, walk: 0, moving: false };
      myPlot = s.economy.plot;
      houses = s.houses;
      buildSolids();
      setEconomy(s.economy);
      s.coins.forEach((c) => coins.set(c.id, c));
      s.players.forEach((p) => others.set(p.key, { ...p, tx: p.x, ty: p.y, walk: 0 }));
      renderFriends();
      resize();
      $('loading').hidden = true;
      requestAnimationFrame((t) => { last = t; loop(t); });
      syncLoop();
      toast(s.economy.house_level
        ? 'Xush kelibsiz! Tangalarni tering va hovlingizni kuchaytiring.'
        : 'Xush kelibsiz! Tangalarni tering va Ota hovlingizni sotib oling.');
      setTimeout(() => { $('hint').classList.add('is-faded'); }, 9000);
    } catch (err) {
      if (handleAuthError(err)) return;
      const box = $('loading');
      box.replaceChildren(el('span', '', `Yuklab bo'lmadi: ${err.message}`));
    }
  }

  start();
})();
