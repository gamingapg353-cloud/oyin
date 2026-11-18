// Mahalla — 3D o'yin (Three.js)
// Odam bo'lib yoki mashinada yurish, taksida pul ishlash, do'stlar, yer olish va sotish,
// bino turini tanlash (Uy / Magazin / Kafe / Ofis) va 100 qavatgacha ko'tarish,
// Avtosalon (BMW, Mercedes, Lamborghini, uchadigan Tesla) va mashina ovozlari.
import * as THREE from 'three';

(() => {
  const { api, handleAuthError, el, icon, avatarColor, formatNumber } = window.Oyin;
  const $ = (id) => document.getElementById(id);

  const SYNC_MS = 150;
  const TOUCH = window.matchMedia('(hover: none)').matches;
  const KIND_ICONS = { uy: 'home', magazin: 'store', kafe: 'coffee', ofis: 'building' };
  const FLOOR_H = 10;            // bitta qavat balandligi
  const AUTO_PICK = 70;          // yo'lovchiga shunchalik yaqinlashsangiz — o'zi mashinaga o'tiradi
  const IS_OWNER = Boolean(window.APP && window.APP.role === 'owner'); // owner qavatni savolsiz qo'shadi

  // ---------------- Holat ----------------
  let world;
  let catalog;
  let buildingsById = {};
  let carsById = {};
  let walkSpeed = 190;
  let offlineCap = 24;
  let me = null;
  let economy = null;
  let economyAt = 0;
  let localVersion = 0;          // xarid/taksi bo'lsa oshadi: undan oldin yuborilgan sinxron javobi eskirgan
  const plotsById = new Map();   // yer raqami -> {plot, owner, kind, level, name, home}
  let solids = [];               // to'siqlar: {x, y, w, h, top}
  const passengers = new Map();  // id -> {x, y, fare, view}
  let ride = null;               // mashinadagi yo'lovchi: {id, tx, ty, fare}
  let guide = null;              // yo'l ko'rsatkich: {x, y, label}
  const others = new Map();      // key -> {name, avatar, x, y, tx, ty, dir, car, taxi, rig}
  const held = new Map();        // bosib turilgan harakatlar ('up'...)
  const touch = { up: false, down: false, left: false, right: false };
  const JUMP_SPEED = 330;
  const GRAVITY = 980;
  let selectedCar = null;
  let taxiOn = false;            // "Yandex" bosilganda yoqiladi: yo'lovchilar faqat shunda ko'rinadi
  let sheetState = null;         // {kind: 'plot', id} | {kind: 'quiz', ...} | {kind: 'shop'} | {kind: 'mine'}

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function lerpAngle(a, b, t) {
    let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }

  // ---------------- Kichik yordamchilar ----------------
  let toastTimer = null;
  function toast(text, kind = '') {
    const node = $('toast');
    node.textContent = text;
    node.className = `toast ${kind ? `toast--${kind}` : ''}`;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 3000);
  }

  function showFatal(message) {
    const box = $('loading');
    box.hidden = false;
    box.replaceChildren(el('span', '', message));
  }

  // Pul har soniyada o'sadi (binolar daromadi so'm/soniya)
  function money() {
    if (!economy) return 0;
    return economy.money + (economy.rate * (Date.now() - economyAt)) / 1000;
  }
  function fmtRate(r) {
    const v = Number(r) || 0;
    if (v >= 100) return formatNumber(v);
    return String(Math.round(v * 10) / 10).replace('.', ',');
  }
  const meters = (d) => `${formatNumber(Math.round(d / 10))} m`;

  const plotTitle = (id) => `Yer №${id + 1}`;
  const kindName = (kind) => (buildingsById[kind] ? buildingsById[kind].name : "Bo'sh yer");
  const myPlotIds = () => (economy ? economy.plots.map((p) => p.plot) : []);
  const plotGate = (p) => ({ x: p.x + p.w / 2, y: p.gate === 'bottom' ? p.y + p.h + 40 : p.y - 40 });
  const carInfo = () => (me && me.car ? carsById[me.car] : null);

  // ---------------- Ovozlar (WebAudio — fayl kerak emas) ----------------
  const ENGINE = {
    bmw: { type: 'sawtooth', base: 52, range: 75, cutoff: 520, vol: 0.16 },
    mercedes: { type: 'sawtooth', base: 40, range: 55, cutoff: 420, vol: 0.18 },
    lambo: { type: 'sawtooth', base: 68, range: 150, cutoff: 950, vol: 0.17 },
    tesla: { type: 'sine', base: 170, range: 300, cutoff: 2400, vol: 0.07 },
  };
  // Ovoz bilan qo'shilgan mashinalar — ko'rinishiga mos dvigatel ovozi
  function engineKey(carId) {
    if (!carId || ENGINE[carId]) return carId;
    const style = carsById[carId] ? carsById[carId].style : 'sedan';
    return { sedan: 'bmw', suv: 'mercedes', super: 'lambo', fly: 'tesla' }[style] || 'bmw';
  }
  const sound = (() => {
    let ctx = null;
    let master = null;
    let engine = null;
    let engineCar = null;
    let muted = false;
    try { muted = localStorage.getItem('oyin-sound') === 'off'; } catch { /* brauzer ruxsat bermasa */ }

    function unlock() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = muted ? 0 : 0.6;
        master.connect(ctx.destination);
      }
      if (ctx.state === 'suspended') ctx.resume();
    }

    function tone(freq, start, dur, { type = 'sine', vol = 0.2, slide = 0 } = {}) {
      if (!ctx || muted) return;
      const t = ctx.currentTime + start;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g);
      g.connect(master);
      o.start(t);
      o.stop(t + dur + 0.05);
    }

    // Dvigatel: tezlik oshsa ovoz baland va ingichka bo'ladi. Tesla — elektr g'uvillashi.
    function engineUpdate(carId, throttle, flying) {
      if (!ctx) return;
      const t = ctx.currentTime;
      if (!engine) {
        const o1 = ctx.createOscillator();
        const o2 = ctx.createOscillator();
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        const g = ctx.createGain();
        g.gain.value = 0;
        const g2 = ctx.createGain();
        g2.gain.value = 0.4;
        o1.connect(f);
        o2.connect(g2);
        g2.connect(f);
        f.connect(g);
        g.connect(master);
        o1.start();
        o2.start();
        engine = { o1, o2, f, g };
      }
      const p = ENGINE[carId];
      if (!p) {
        engine.g.gain.setTargetAtTime(0, t, 0.12);
        return;
      }
      if (engineCar !== carId) {
        engine.o1.type = p.type;
        engine.o2.type = p.type === 'sine' ? 'triangle' : 'square';
        engineCar = carId;
      }
      const freq = p.base + p.range * throttle + (flying ? 60 : 0);
      engine.o1.frequency.setTargetAtTime(freq, t, 0.1);
      engine.o2.frequency.setTargetAtTime(flying ? 95 : freq * 0.5, t, 0.1);
      engine.f.frequency.setTargetAtTime(p.cutoff * (1 + throttle), t, 0.1);
      engine.g.gain.setTargetAtTime(p.vol * (0.45 + 0.55 * throttle) * (flying ? 1.4 : 1), t, 0.12);
    }

    return {
      unlock,
      isMuted: () => muted,
      setMuted(value) {
        muted = value;
        try { localStorage.setItem('oyin-sound', value ? 'off' : 'on'); } catch { /* e'tiborsiz */ }
        if (master) master.gain.value = value ? 0 : 0.6;
      },
      pause() { if (ctx && ctx.state === 'running') ctx.suspend(); },
      engine: engineUpdate,
      horn(carId) {
        unlock();
        if (carId === 'tesla') {
          tone(880, 0, 0.18, { type: 'triangle', vol: 0.18 });
          tone(1320, 0.12, 0.25, { type: 'triangle', vol: 0.18 });
          return;
        }
        const low = carId === 'mercedes' ? 300 : carId === 'lambo' ? 460 : 400;
        tone(low, 0, 0.45, { type: 'square', vol: 0.12 });
        tone(low * 1.26, 0, 0.45, { type: 'square', vol: 0.1 });
      },
      cash() { [988, 1319, 1760].forEach((f, i) => tone(f, i * 0.07, 0.22, { type: 'triangle', vol: 0.18 })); },
      ding() { tone(784, 0, 0.25, { vol: 0.2 }); tone(1047, 0.16, 0.35, { vol: 0.2 }); },
      right() { tone(659, 0, 0.15, { type: 'triangle', vol: 0.2 }); tone(988, 0.12, 0.3, { type: 'triangle', vol: 0.2 }); },
      wrong() { tone(196, 0, 0.35, { type: 'sawtooth', vol: 0.1, slide: 0.7 }); },
      door() { tone(140, 0, 0.12, { type: 'square', vol: 0.1, slide: 0.6 }); },
      whoosh(up) { tone(up ? 220 : 520, 0, 0.6, { type: 'sine', vol: 0.15, slide: up ? 3 : 0.4 }); },
    };
  })();

  // ---------------- Three.js sahna ----------------
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: $('world'), antialias: !TOUCH, powerPreference: 'high-performance' });
  } catch {
    showFatal("Brauzeringiz 3D grafikani (WebGL) qo'llamaydi. Chrome yoki Edge'ning yangi versiyasida oching.");
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, TOUCH ? 1.5 : 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const SKY = new THREE.Color('#9fd3f7');
  scene.background = SKY;
  scene.fog = new THREE.Fog(SKY, 1400, 3600);

  scene.add(new THREE.HemisphereLight('#e0f2ff', '#4d7c3a', 1.15));
  const sun = new THREE.DirectionalLight('#fff4d6', 2.3);
  sun.castShadow = true;
  const shadowSize = TOUCH ? 1024 : 2048;
  sun.shadow.mapSize.set(shadowSize, shadowSize);
  Object.assign(sun.shadow.camera, { left: -560, right: 560, top: 560, bottom: -560, near: 10, far: 5000 });
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.8;
  scene.add(sun, sun.target);
  const SUN_DIR = new THREE.Vector3(-320, 700, -220).normalize().multiplyScalar(2200);

  const camera = new THREE.PerspectiveCamera(50, 1, 5, 12000);
  const cam = { yaw: 0, pitch: 0.82, dist: TOUCH ? 560 : 470 };

  // Materiallar keshi
  const materials = new Map();
  function mat(color, opts = {}) {
    const key = `${color}|${JSON.stringify(opts)}`;
    if (!materials.has(key)) {
      materials.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, ...opts }));
    }
    return materials.get(key);
  }
  const GLASS = () => mat('#8fd3ff', { roughness: 0.15, metalness: 0.2, emissive: '#1e3a5f', emissiveIntensity: 0.25 });
  const DARK_GLASS = () => mat('#111827', { roughness: 0.15, metalness: 0.4 });
  const CHROME = () => mat('#e5e7eb', { metalness: 0.9, roughness: 0.2 });
  const glow = (color, intensity = 1) => mat(color, { emissive: color, emissiveIntensity: intensity });

  function mesh(geometry, material, x = 0, y = 0, z = 0, shadow = true) {
    const m = new THREE.Mesh(geometry, material);
    m.position.set(x, y, z);
    m.castShadow = shadow;
    m.receiveShadow = true;
    return m;
  }
  const box = (w, h, d, material, x = 0, y = 0, z = 0) => mesh(new THREE.BoxGeometry(w, h, d), material, x, y, z);
  const cyl = (rt, rb, h, material, x = 0, y = 0, z = 0, seg = 16) =>
    mesh(new THREE.CylinderGeometry(rt, rb, h, seg), material, x, y, z);

  // Matnli lavha (yozuv) — canvas tekstura
  const textTextures = new Map();
  function textTexture(text, bg = '#1e3a8a', fg = '#ffffff', w = 512, h = 128) {
    const key = `${text}|${bg}|${fg}|${w}x${h}`;
    if (textTextures.has(key)) return textTextures.get(key);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.fillStyle = fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const lines = String(text).split('\n');
    const size = Math.min(h * 0.62 / lines.length, (w * 1.6) / Math.max(...lines.map((l) => l.length), 1));
    g.font = `800 ${size}px system-ui, "Segoe UI", sans-serif`;
    lines.forEach((line, i) => g.fillText(line, w / 2, (h / (lines.length + 1)) * (i + 1)));
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    textTextures.set(key, tex);
    return tex;
  }
  function signPlane(text, w, h, bg, fg) {
    return new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ map: textTexture(text, bg, fg), side: THREE.DoubleSide }));
  }

  // Ism yozuvi (sprite): rasm bo'lsa — chap tomonda doira ichida
  const images = new Map();
  function imageFor(url, onLoad) {
    if (!url) return null;
    let img = images.get(url);
    if (!img) {
      img = new Image();
      img.src = url;
      images.set(url, img);
    }
    if (img.complete && img.naturalWidth) return img;
    if (onLoad) img.addEventListener('load', onLoad, { once: true });
    return null;
  }

  // depthTest: true — bino ortida qolsa ko'rinmaydi (yer yozuvlari uchun)
  function makeLabel(text, bg = 'rgba(15,23,42,.82)', avatar = null, depthTest = false) {
    const font = '700 30px system-ui, "Segoe UI", sans-serif';
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = font;
    const pad = 18;
    const face = avatar ? 40 : 0;
    const w = Math.ceil(probe.measureText(text).width + pad * 2 + (face ? face + 10 : 0));
    const h = 54;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = bg;
    g.beginPath();
    g.roundRect(0, 0, w, h, h / 2);
    g.fill();
    let x = pad;
    if (face) {
      g.save();
      g.beginPath();
      g.arc(x + face / 2, h / 2, face / 2, 0, Math.PI * 2);
      g.clip();
      g.drawImage(avatar, x, h / 2 - face / 2, face, face);
      g.restore();
      x += face + 10;
    }
    g.font = font;
    g.fillStyle = '#ffffff';
    g.textBaseline = 'middle';
    g.fillText(text, x, h / 2 + 1);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest, transparent: true }));
    sprite.scale.set(w / 2.6, h / 2.6, 1);
    sprite.renderOrder = depthTest ? 0 : 10;
    return sprite;
  }

  function disposeTree(obj) {
    obj.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.isSprite && o.material.map) {
        o.material.map.dispose();
        o.material.dispose();
      }
    });
  }

  // ---------------- Odam ----------------
  function makeHuman(name, shirtColor) {
    const g = new THREE.Group();
    const skin = mat('#f0c08a');
    const shirt = mat(shirtColor || avatarColor(name));
    const pants = mat('#1f2937');
    const shoe = mat('#111827');

    const leg = (side) => {
      const pivot = new THREE.Group();
      pivot.position.set(side * 5, 24, 0);
      pivot.add(box(7, 22, 7, pants, 0, -11, 0), box(8, 4, 11, shoe, 0, -22, 2));
      g.add(pivot);
      return pivot;
    };
    const arm = (side) => {
      const pivot = new THREE.Group();
      pivot.position.set(side * 12.5, 44, 0);
      pivot.add(box(5.5, 18, 5.5, shirt, 0, -9, 0), box(5, 5, 5, skin, 0, -20, 0));
      g.add(pivot);
      return pivot;
    };
    const legL = leg(-1);
    const legR = leg(1);
    g.add(box(19, 22, 11, shirt, 0, 35, 0));                       // tana
    const armL = arm(-1);
    const armR = arm(1);
    g.add(mesh(new THREE.SphereGeometry(8.5, 18, 14), skin, 0, 55, 0)); // bosh
    g.add(mesh(new THREE.SphereGeometry(9, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2.1), mat('#2b2b2b'), 0, 56.5, -0.6));
    const eye = new THREE.SphereGeometry(1.3, 8, 6);
    g.add(mesh(eye, mat('#111111'), -3, 56, 7.6, false), mesh(eye, mat('#111111'), 3, 56, 7.6, false));
    g.userData = { legL, legR, armL, armR };
    return g;
  }

  function animateHuman(h, walk, moving, airborne = false, wave = null) {
    const { legL, legR, armL, armR } = h.userData;
    armR.rotation.z = 0;
    if (airborne) {
      // Sakrayotganda: qo'llar tepaga, oyoqlar bukilgan
      legL.rotation.x = 0.55;
      legR.rotation.x = -0.35;
      armL.rotation.x = -2.7;
      armR.rotation.x = -2.7;
      h.position.y = 0;
      return;
    }
    const swing = moving ? Math.sin(walk) * 0.75 : 0;
    legL.rotation.x = swing;
    legR.rotation.x = -swing;
    armL.rotation.x = -swing * 0.8;
    armR.rotation.x = swing * 0.8;
    if (wave !== null) {
      // Taksi chaqiryapti — qo'l silkitadi
      armR.rotation.x = -2.9;
      armR.rotation.z = Math.sin(wave) * 0.45;
    }
    h.position.y = moving ? Math.abs(Math.sin(walk)) * 1.5 : 0;
  }

  // ---------------- Mashinalar ----------------
  // Yon ko'rinish (z, y nuqtalari) x bo'ylab qalinlashtiriladi
  function profile(points, width, material) {
    const shape = new THREE.Shape();
    points.forEach(([z, y], i) => (i ? shape.lineTo(z, y) : shape.moveTo(z, y)));
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false });
    geo.translate(0, 0, -width / 2);
    geo.rotateY(-Math.PI / 2);
    return mesh(geo, material);
  }

  function addWheels(g, spots, r, w) {
    const tire = new THREE.CylinderGeometry(r, r, w, 20);
    tire.rotateZ(Math.PI / 2);
    const rim = new THREE.CylinderGeometry(r * 0.58, r * 0.58, w + 0.4, 10);
    rim.rotateZ(Math.PI / 2);
    const wheels = [];
    const pods = [];
    spots.forEach(([x, z]) => {
      const pod = new THREE.Group();
      pod.position.set(x, r, z);
      const spin = new THREE.Group();
      spin.add(mesh(tire, mat('#111827', { roughness: 0.9 })), mesh(rim, CHROME(), 0, 0, 0, false),
        box(w + 0.8, r * 1.15, 1.6, mat('#64748b', { metalness: 0.6, roughness: 0.4 })));
      pod.add(spin);
      g.add(pod);
      wheels.push(spin);
      pods.push(pod);
    });
    return { wheels, pods, r };
  }

  function carBMW(color) {
    const g = new THREE.Group();
    const paint = mat(color, { roughness: 0.3, metalness: 0.5 });
    g.add(profile([[34, 6], [34, 13], [16, 16], [-24, 17], [-34, 16], [-34, 6]], 32, paint));
    g.add(profile([[16, 16], [6, 25], [-12, 25], [-24, 17]], 28, DARK_GLASS()));
    g.add(box(27, 1.2, 17, paint, 0, 25.3, -3));
    [-1, 1].forEach((s) => {
      g.add(box(5.8, 5.4, 0.6, CHROME(), s * 3.4, 11, 34.1), box(5, 4.6, 1, mat('#0f172a'), s * 3.4, 11, 34.3)); // panjara
      g.add(box(8, 2.4, 1, glow('#e0f2fe', 0.9), s * 11, 12.4, 34.3));     // faralar
      g.add(box(9, 2.6, 1, glow('#ef4444', 0.6), s * 10.5, 13.5, -34.3));  // orqa chiroqlar
      g.add(box(3, 2, 3, paint, s * 16.5, 17.5, 10));                      // oynalar
      [6, 9].forEach((x) => {
        const pipe = cyl(1.2, 1.2, 2, CHROME(), s * x, 7, -34.6, 10);
        pipe.rotation.x = Math.PI / 2;
        g.add(pipe);
      });
    });
    g.userData = { ...addWheels(g, [[-16, 21], [16, 21], [-16, -21], [16, -21]], 6.5, 5), roof: 26 };
    return g;
  }

  function carG(color) {
    const g = new THREE.Group();
    const paint = mat(color, { roughness: 0.35, metalness: 0.45 });
    g.add(box(34, 17, 62, paint, 0, 15.5, 0));             // korpus
    g.add(box(32, 13, 36, DARK_GLASS(), 0, 30.5, -7));     // oynalar
    g.add(box(33, 2.2, 38, paint, 0, 38, -7));             // tom
    [[-16, 11], [16, 11], [-16, -25], [16, -25]].forEach(([x, z]) => g.add(box(1.6, 13, 1.6, paint, x, 30.5, z)));
    g.add(box(36, 2, 44, mat('#111827'), 0, 8, 0));         // yon pog'ona
    g.add(box(20, 8, 1, mat('#111827'), 0, 17, 31.3));      // panjara
    [15, 17, 19].forEach((y) => g.add(box(19, 0.8, 0.5, CHROME(), 0, y, 31.9)));
    [-1, 1].forEach((s) => {
      const lamp = cyl(3.2, 3.2, 1.2, glow('#e0f2fe', 0.9), s * 12.5, 18, 31.4, 16);
      lamp.rotation.x = Math.PI / 2;
      g.add(lamp);
      g.add(box(3, 1.5, 3, glow('#f59e0b', 0.5), s * 14, 24.6, 26));
      g.add(box(4, 8, 1, glow('#ef4444', 0.6), s * 14.5, 19, -31.3));
    });
    const spare = cyl(8.5, 8.5, 5, mat('#111827'), 0, 20, -33.5, 20);
    spare.rotation.x = Math.PI / 2;
    const cover = cyl(6, 6, 5.4, paint, 0, 20, -33.6, 20);
    cover.rotation.x = Math.PI / 2;
    g.add(spare, cover);
    g.userData = { ...addWheels(g, [[-16, 20], [16, 20], [-16, -20], [16, -20]], 8, 6), roof: 39 };
    return g;
  }

  function carLambo(color) {
    const g = new THREE.Group();
    const paint = mat(color, { roughness: 0.25, metalness: 0.55 });
    const black = mat('#0f172a', { roughness: 0.4 });
    g.add(profile([[35, 5], [35, 8.5], [14, 13], [-24, 15], [-35, 14], [-35, 5]], 34, paint));
    g.add(profile([[14, 13], [2, 20.5], [-10, 20.5], [-24, 15]], 26, DARK_GLASS()));
    g.add(box(22, 0.8, 9, paint, 0, 20.7, -4));
    g.add(box(32, 1.4, 6, black, 0, 19.5, -31));             // qanot (spoyler)
    g.add(box(32, 1.2, 4, black, 0, 5, 34));                  // old pastki lab
    const pipe = cyl(2.2, 2.2, 2, CHROME(), 0, 9, -35.6, 6);
    pipe.rotation.x = Math.PI / 2;
    g.add(pipe);
    [-1, 1].forEach((s) => {
      g.add(box(1.4, 4, 2, black, s * 10, 17, -31));
      g.add(box(1, 5, 14, black, s * 17.2, 10.5, -10));       // havo olgich
      g.add(box(9, 1.4, 1, glow('#f8fafc', 1), s * 11, 9.4, 34.6));
      g.add(box(11, 1.6, 1, glow('#ef4444', 0.8), s * 10, 12, -35.3));
    });
    g.userData = { ...addWheels(g, [[-17, 21], [17, 21], [-17, -21], [17, -21]], 7, 6), roof: 21 };
    return g;
  }

  // Uchadigan Tesla: po'lat burchakli kuzov, nurli chiziqlar. Uchganda g'ildiraklar
  // gorizontal "dvigatel"ga aylanadi, qanotlar chiqadi, pastdan nur taraladi.
  function carTesla(color) {
    const g = new THREE.Group();
    const steel = mat(color, { roughness: 0.32, metalness: 0.3 }); // kumushrang po'lat
    g.add(profile([[35, 7], [35, 13], [6, 26], [-35, 17], [-35, 7]], 34, steel));
    const shield = box(28, 0.6, 22, DARK_GLASS(), 0, 20, 20.5);
    shield.rotation.x = 0.42;
    g.add(shield);
    const cyan = glow('#22d3ee', 1.4);
    g.add(box(32, 1, 0.8, glow('#e0f2fe', 1.4), 0, 13.2, 35.3));   // old nur chiziq
    g.add(box(32, 1.2, 0.8, glow('#ef4444', 1.2), 0, 16, -35.3));  // orqa nur chiziq
    [-1, 1].forEach((s) => {
      g.add(box(0.6, 6, 30, DARK_GLASS(), s * 17.05, 19, -2));
      g.add(box(0.5, 0.8, 56, cyan, s * 17.25, 8.5, 0));
    });
    const wings = [-1, 1].map((s) => {
      const pivot = new THREE.Group();
      pivot.position.set(s * 17, 12, -6);
      pivot.add(box(16, 1, 18, steel, s * 8, 0, 0), box(1.2, 1.4, 18, cyan, s * 16, 0, 0));
      pivot.scale.x = 0.01;
      g.add(pivot);
      return pivot;
    });
    const under = new THREE.Mesh(new THREE.CircleGeometry(30, 32), new THREE.MeshBasicMaterial({
      color: '#22d3ee', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    under.rotation.x = -Math.PI / 2;
    under.position.y = 0.5;
    g.add(under);
    const set = addWheels(g, [[-17, 21], [17, 21], [-17, -21], [17, -21]], 7, 6);
    const ringMat = new THREE.MeshBasicMaterial({ color: '#22d3ee', transparent: true, opacity: 0.25 });
    set.pods.forEach((pod) => {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(5.5, 0.9, 8, 24), ringMat);
      ring.rotation.y = Math.PI / 2;
      pod.add(ring);
    });
    g.userData = { ...set, roof: 25, flies: true, wings, under, ringMat, fly: 0 };
    return g;
  }

  const CAR_BUILDERS = { bmw: carBMW, mercedes: carG, lambo: carLambo, tesla: carTesla };
  function makeCar(id) {
    const info = carsById[id] || catalog.cars[0];
    const byStyle = { sedan: carBMW, suv: carG, super: carLambo, fly: carTesla };
    return (CAR_BUILDERS[info.id] || byStyle[info.style] || carBMW)(info.color);
  }

  // G'ildiraklar aylanadi; Tesla uchganda qanot va nurlar chiqadi
  function animateCar(car, dt, speed, fly) {
    const u = car.userData;
    if (speed && (u.fly || 0) < 0.5) {
      const a = (speed * dt) / u.r;
      u.wheels.forEach((w) => { w.rotation.x += a; });
    }
    if (!u.flies) return;
    u.fly += (fly - u.fly) * Math.min(1, dt * 4);
    const f = u.fly;
    u.pods.forEach((p) => { p.rotation.z = f * (Math.PI / 2) * Math.sign(p.position.x); });
    u.wings.forEach((w) => { w.scale.x = Math.max(0.01, f); });
    u.under.material.opacity = f * 0.45;
    u.ringMat.opacity = 0.25 + f * 0.7;
  }

  function makeTaxiSign() {
    const g = new THREE.Group();
    g.add(box(14, 5, 7, glow('#facc15', 0.5), 0, 2.5, 0));
    const front = signPlane('TAXI', 12, 4, '#facc15', '#111827');
    front.position.set(0, 2.5, 3.6);
    const back = front.clone();
    back.position.z = -3.6;
    back.rotation.y = Math.PI;
    g.add(front, back);
    return g;
  }

  // O'yinchi (men yoki do'st) — odam + mashina + ism yozuvi
  function makeRig(name, avatar, isMe) {
    const root = new THREE.Group();
    const human = makeHuman(name);
    const holder = new THREE.Group();
    root.add(human, holder);
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(13, 20),
      new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.22, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.6;
    root.add(shadow);
    const rig = {
      root, human, holder, shadow, car: null, carId: null, taxiSign: null, label: null, labelKey: '', heading: 0, walk: 0, isMe,
    };
    setRigLabel(rig, isMe ? 'Siz' : name, avatar);
    scene.add(root);
    return rig;
  }

  function setRigLabel(rig, text, avatarUrl) {
    const img = imageFor(avatarUrl, () => { rig.labelKey = ''; setRigLabel(rig, text, avatarUrl); });
    const key = `${text}|${img ? avatarUrl : ''}`;
    if (key === rig.labelKey) return;
    if (rig.label) {
      rig.root.remove(rig.label);
      rig.label.material.map.dispose();
      rig.label.material.dispose();
    }
    rig.label = makeLabel(text, rig.isMe ? 'rgba(37,99,235,.92)' : 'rgba(15,23,42,.82)', img);
    rig.label.position.y = 82;
    rig.root.add(rig.label);
    rig.labelKey = key;
  }

  function updateRig(rig, p, dt, moving) {
    const car = p.car && carsById[p.car] ? carsById[p.car] : null;
    const flies = Boolean(car && car.flies);
    const height = !car || flies ? Math.max(0, p.h || 0) : 0;
    rig.root.position.set(p.x, height, p.y);
    // Soya yerda qoladi, balandlashgan sari kichrayadi
    rig.shadow.position.y = 0.6 - height;
    rig.shadow.scale.setScalar(Math.max(0.35, 1 - height / (flies ? 700 : 110)) * (car ? 1.9 : 1));
    const target = Math.PI / 2 - (p.dir || 0);
    rig.heading = lerpAngle(rig.heading, target, Math.min(1, dt * 12));
    const carId = car ? car.id : null;
    if (carId !== rig.carId) {
      if (rig.car) {
        rig.holder.remove(rig.car);
        disposeTree(rig.car);
        rig.car = null;
        rig.taxiSign = null;
      }
      if (carId) {
        rig.car = makeCar(carId);
        rig.holder.add(rig.car);
      }
      rig.carId = carId;
    }
    rig.human.visible = !carId;
    rig.holder.rotation.y = rig.heading;
    rig.human.rotation.y = rig.heading;
    if (carId) {
      const u = rig.car.userData;
      const taxi = Boolean(p.taxi);
      if (taxi && !rig.taxiSign) {
        rig.taxiSign = makeTaxiSign();
        rig.taxiSign.position.y = u.roof;
        rig.car.add(rig.taxiSign);
      }
      if (rig.taxiSign) rig.taxiSign.visible = taxi;
      const fly = flies ? clamp(height / 25, 0, 1) : 0;
      animateCar(rig.car, dt, moving ? walkSpeed * car.speed : 0, fly);
      rig.car.position.y = fly ? Math.sin(performance.now() / 280) * 1.6 * fly : 0;
      rig.car.rotation.x = fly && moving ? 0.08 : 0; // uchayotganda biroz oldinga engashadi
      rig.label.position.y = u.roof + 24;
    } else {
      rig.label.position.y = 82;
      if (moving) rig.walk += dt * 11;
      animateHuman(rig.human, rig.walk, moving, height > 1.5);
    }
  }

  function removeRig(rig) {
    scene.remove(rig.root);
    disposeTree(rig.root);
  }

  // ---------------- Binolar ----------------
  // 1-qavat — turiga xos (hovli uy, do'kon, kafe, ofis vestibyuli), qolgan qavatlar — ustidagi minora
  const GROUND_H = { uy: 32, magazin: 40, kafe: 40, ofis: 26 };
  const TOWER = { uy: [110, 70], magazin: [108, 68], kafe: [96, 62], ofis: [100, 80] };
  const WALLS = {
    uy: { wall: '#e8b48f', frame: '#fff7ed', glass: '#8fd3ff' },
    magazin: { wall: '#e5e7eb', frame: '#94a3b8', glass: '#93c5fd' },
    kafe: { wall: '#fde68a', frame: '#92400e', glass: '#7dd3fc' },
    ofis: { wall: '#1e3a5f', frame: '#0f172a', glass: '#8fd3ff', curtain: true },
  };

  // Bino balandligi (uchadigan mashina undan baland uchishi kerak)
  function buildingTop(kind, level) {
    if (!kind || level < 1) return 0;
    if (kind === 'ofis') return GROUND_H.ofis + level * FLOOR_H + 30;
    return GROUND_H[kind] + 4 + (level - 1) * FLOOR_H + 40;
  }

  const windowTextures = {};
  function windowTexture(kind) {
    if (windowTextures[kind]) return windowTextures[kind];
    const s = WALLS[kind];
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const x = c.getContext('2d');
    x.fillStyle = s.wall;
    x.fillRect(0, 0, 64, 64);
    if (s.curtain) {
      x.fillStyle = s.glass;
      x.fillRect(4, 6, 56, 48);
      x.fillStyle = 'rgba(255,255,255,.35)';
      x.fillRect(6, 8, 14, 44);
    } else {
      x.fillStyle = s.frame;
      x.fillRect(14, 12, 36, 38);
      x.fillStyle = s.glass;
      x.fillRect(17, 15, 30, 32);
      x.fillStyle = 'rgba(255,255,255,.4)';
      x.fillRect(19, 17, 8, 28);
      x.fillStyle = 'rgba(0,0,0,.12)';
      x.fillRect(0, 60, 64, 4); // qavatlar orasidagi chiziq
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    windowTextures[kind] = tex;
    return tex;
  }

  const towerMats = new Map();
  function towerMaterial(kind, cols, rows) {
    const key = `${kind}|${cols}|${rows}`;
    if (!towerMats.has(key)) {
      const tex = windowTexture(kind).clone();
      tex.repeat.set(cols, rows);
      tex.needsUpdate = true;
      const glassy = kind === 'ofis';
      towerMats.set(key, new THREE.MeshStandardMaterial({ map: tex, roughness: glassy ? 0.25 : 0.8, metalness: glassy ? 0.3 : 0 }));
    }
    return towerMats.get(key);
  }

  // Qavatlar minorasi: bitta quti, har qavatda deraza qatori
  function tower(kind, w, d, floors, y0) {
    const h = floors * FLOOR_H;
    const front = towerMaterial(kind, Math.max(2, Math.round(w / 18)), floors);
    const side = towerMaterial(kind, Math.max(2, Math.round(d / 18)), floors);
    const top = mat(WALLS[kind].wall);
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [side, side, top, top, front, front]);
    m.position.y = y0 + h / 2;
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }

  function gableRoof(w, d, h, color) {
    const shape = new THREE.Shape();
    shape.moveTo(-d / 2, 0);
    shape.lineTo(d / 2, 0);
    shape.lineTo(0, h);
    shape.lineTo(-d / 2, 0);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: w, bevelEnabled: false });
    geo.translate(0, 0, -w / 2);
    geo.rotateY(Math.PI / 2);
    return mesh(geo, mat(color));
  }

  function windowsRow(g, w, y, zFront, count, skipCenter = false) {
    for (let i = 0; i < count; i += 1) {
      let x = -w / 2 + ((i + 1) * w) / (count + 1);
      if (skipCenter && Math.abs(x) < 16) x += x <= 0 ? -20 : 20;
      g.add(box(16, 14, 1.5, GLASS(), x, y, zFront + 0.8));
    }
  }

  function door(g, zFront, color = '#6b4226') {
    g.add(box(18, 27, 1.6, mat(color), 0, 13.5, zFront + 0.9));
  }

  function stripedAwning(g, w, y, zFront, colorA, colorB) {
    const n = 6;
    for (let i = 0; i < n; i += 1) {
      const seg = box(w / n, 2.5, 18, mat(i % 2 ? colorB : colorA), -w / 2 + (w / n) * (i + 0.5), y, zFront + 8);
      seg.rotation.x = 0.28;
      g.add(seg);
    }
  }

  // Tom bezaklari qavatlar soniga qarab: panjara, suv baki, antenna, vertolyot maydoni, oltin toj
  function roofTop(g, kind, level, w, d, y) {
    const rail = mat('#94a3b8');
    if (level >= 10) {
      g.add(box(w, 4, 1.5, rail, 0, y + 2, d / 2 - 1), box(w, 4, 1.5, rail, 0, y + 2, -d / 2 + 1),
        box(1.5, 4, d, rail, w / 2 - 1, y + 2, 0), box(1.5, 4, d, rail, -w / 2 + 1, y + 2, 0));
      if (kind !== 'ofis') {
        g.add(cyl(9, 9, 16, mat('#64748b'), w * 0.28, y + 8, -d * 0.2), cyl(10, 10, 3, mat('#475569'), w * 0.28, y + 17.5, -d * 0.2));
      }
    }
    if (kind === 'magazin') [[-28, -10], [22, 8]].forEach(([x, z]) => g.add(box(16, 10, 14, mat('#cbd5e1'), x, y + 5, z)));
    const roofSign = (text, bg, fg) => {
      const s = signPlane(text, w * 0.9, 16, bg, fg);
      s.position.set(0, y + 14, d / 2 - 3);
      g.add(s, box(2, 22, 2, rail, -w * 0.4, y + 11, d / 2 - 4), box(2, 22, 2, rail, w * 0.4, y + 11, d / 2 - 4));
    };
    if (kind === 'kafe' && level >= 10) roofSign('MEHMONXONA', '#7c2d12', '#fde68a');
    if (kind === 'magazin' && level >= 20) roofSign('SUPERMARKET', '#15803d', '#ffffff');
    if (level >= 30) {
      g.add(cyl(1.5, 1.5, 60, rail, -w * 0.3, y + 30, -d * 0.25));
      g.add(mesh(new THREE.SphereGeometry(3, 10, 8), glow('#ef4444', 1.2), -w * 0.3, y + 61, -d * 0.25));
    }
    if (kind === 'ofis' && level >= 60) {
      g.add(cyl(30, 30, 2, mat('#111827'), 8, y + 1, 4, 28));
      const h = signPlane('H', 26, 26, '#111827', '#facc15');
      h.rotation.x = -Math.PI / 2;
      h.position.set(8, y + 2.2, 4);
      g.add(h);
    }
    if (level >= kindMax(kind)) {
      const gold = mat('#d4a017', { metalness: 0.7, roughness: 0.3 });
      g.add(box(w + 12, 7, d + 12, gold, 0, y - 1.5, 0), cyl(0.6, 7, 90, gold, w * 0.32, y + 45, -d * 0.3, 8));
      g.add(mesh(new THREE.SphereGeometry(6, 14, 10), glow('#facc15', 0.8), w * 0.32, y + 92, -d * 0.3));
    }
  }

  function buildHouse(level) {
    const g = new THREE.Group();
    if (level === 1) {
      // Bir qavatli hovli uy
      const s = { w: 120, h: 44, d: 76 };
      g.add(box(s.w, s.h, s.d, mat('#d97757'), 0, s.h / 2, 0));
      const roof = gableRoof(s.w + 16, s.d + 14, 32, '#9f2d20');
      roof.position.y = s.h;
      g.add(roof);
      g.add(box(10, 26, 10, mat('#7f1d1d'), s.w * 0.28, s.h + 20, -s.d * 0.15));
      door(g, s.d / 2);
      windowsRow(g, s.w, s.h * 0.58, s.d / 2, 2, true);
      return g;
    }
    // Ko'p qavatli uy: pastda kirish (podyezd), ustida qavatlar
    const G = GROUND_H.uy;
    const [tw, td] = TOWER.uy;
    g.add(box(124, G, 80, mat('#b45309'), 0, G / 2, 0));
    door(g, 40);
    windowsRow(g, 124, G * 0.55, 40, 4, true);
    g.add(box(40, 3, 14, mat('#7c2d12'), 0, 30.5, 47));
    g.add(box(128, 4, 84, mat('#78716c'), 0, G + 2, 0));
    const floors = level - 1;
    g.add(tower('uy', tw, td, floors, G + 4));
    const top = G + 4 + floors * FLOOR_H;
    if (level < 10) {
      const roof = gableRoof(tw + 12, td + 10, 24, '#9f2d20');
      roof.position.y = top;
      g.add(roof);
    } else {
      g.add(box(tw + 4, 3, td + 4, mat('#78716c'), 0, top + 1.5, 0));
      roofTop(g, 'uy', level, tw, td, top + 3);
    }
    return g;
  }

  function buildShopBuilding(level) {
    const g = new THREE.Group();
    const W = 124;
    const D = 78;
    const H = GROUND_H.magazin;
    const front = D / 2;
    g.add(box(W, H, D, mat('#f3f4f6'), 0, H / 2, 0));
    g.add(box(W - 22, 24, 1.5, GLASS(), 0, 13, front + 0.8));
    door(g, front, '#1f2937');
    stripedAwning(g, W - 8, 27, front, '#16a34a', '#f0fdf4');
    const sign = signPlane('MAGAZIN', W * 0.6, 10, '#15803d', '#ffffff');
    sign.position.set(0, 34, front + 1);
    g.add(sign);
    g.add(box(W + 4, 4, D + 4, mat('#9ca3af'), 0, H + 2, 0));
    if (level === 1) {
      roofTop(g, 'magazin', level, W, D, H + 4);
      return g;
    }
    const [tw, td] = TOWER.magazin;
    const floors = level - 1;
    g.add(tower('magazin', tw, td, floors, H + 4));
    const top = H + 4 + floors * FLOOR_H;
    g.add(box(tw + 4, 3, td + 4, mat('#9ca3af'), 0, top + 1.5, 0));
    roofTop(g, 'magazin', level, tw, td, top + 3);
    return g;
  }

  function buildCafe(level) {
    const g = new THREE.Group();
    const W = 104;
    const D = 70;
    const H = GROUND_H.kafe;
    const front = D / 2;
    g.add(box(W, H, D, mat('#fde68a'), 0, H / 2, 0));
    g.add(box(W - 24, 22, 1.5, GLASS(), 0, 13, front + 0.8));
    door(g, front, '#7c2d12');
    stripedAwning(g, W - 6, 27, front, '#dc2626', '#fff7ed');
    const sign = signPlane('KAFE', W * 0.5, 10, '#7c2d12', '#fde68a');
    sign.position.set(0, 34, front + 1);
    g.add(sign);
    g.add(box(W + 6, 4, D + 6, mat('#7c2d12'), 0, H + 2, 0));
    // Tashqaridagi stollar va soyabonlar
    const tables = Math.min(2 + Math.floor(level / 25), 4);
    const xs = [-62, 62, -34, 34];
    for (let i = 0; i < tables; i += 1) {
      const x = xs[i];
      const z = 74;
      g.add(cyl(9, 9, 2, mat('#78350f'), x, 11, z), cyl(1.5, 1.5, 11, mat('#78350f'), x, 5.5, z));
      g.add(cyl(1, 1, 26, mat('#e5e7eb'), x, 13, z));
      g.add(mesh(new THREE.ConeGeometry(17, 9, 10), mat(i % 2 ? '#fff7ed' : '#dc2626'), x, 30, z));
    }
    if (level === 1) return g;
    // Ustida — mehmonxona qavatlari
    const [tw, td] = TOWER.kafe;
    const floors = level - 1;
    g.add(tower('kafe', tw, td, floors, H + 4));
    const top = H + 4 + floors * FLOOR_H;
    g.add(box(tw + 4, 3, td + 4, mat('#7c2d12'), 0, top + 1.5, 0));
    roofTop(g, 'kafe', level, tw, td, top + 3);
    return g;
  }

  function buildOffice(level) {
    const g = new THREE.Group();
    const W = 100;
    const D = 80;
    const G = GROUND_H.ofis;
    const front = D / 2;
    g.add(box(W + 8, G, D + 8, mat('#334155'), 0, G / 2, 0));
    g.add(box(30, 18, 1.6, GLASS(), 0, 9, front + 4.8));
    const sign = signPlane(level >= 50 ? 'BIZNES MARKAZ' : 'OFIS', W * 0.8, 7, '#0f172a', '#93c5fd');
    sign.position.set(0, 22, front + 4.2);
    g.add(sign);
    g.add(tower('ofis', W, D, level, G));
    const top = G + level * FLOOR_H;
    g.add(box(W + 6, 5, D + 6, mat('#1f2937'), 0, top + 2.5, 0));
    roofTop(g, 'ofis', level, W, D, top + 5);
    return g;
  }

  function makeBuilding(kind, level) {
    if (kind === 'magazin') return buildShopBuilding(level);
    if (kind === 'kafe') return buildCafe(level);
    if (kind === 'ofis') return buildOffice(level);
    return buildHouse(level);
  }

  // ---------------- Statik xarita ----------------
  const pickables = [];  // sichqoncha bilan bosiladigan narsalar

  function buildGround() {
    // Katta xarita: tekstura video karta chegarasidan oshmasin
    const maxTex = renderer.capabilities.maxTextureSize || 4096;
    const S = Math.min(TOUCH ? 0.55 : 0.85, maxTex / Math.max(world.w, world.h));
    const c = document.createElement('canvas');
    c.width = Math.round(world.w * S);
    c.height = Math.round(world.h * S);
    const g = c.getContext('2d');
    g.scale(S, S);

    g.fillStyle = '#5c9442';
    g.fillRect(0, 0, world.w, world.h);
    // O't dog'lari (tasodifiy, lekin har safar bir xil)
    let seed = 11;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const spots = Math.round((world.w * world.h) / 1500);
    for (let i = 0; i < spots; i += 1) {
      g.fillStyle = rnd() > 0.5 ? 'rgba(78,128,55,.55)' : 'rgba(108,164,72,.45)';
      g.beginPath();
      g.ellipse(rnd() * world.w, rnd() * world.h, 6 + rnd() * 18, 4 + rnd() * 10, rnd() * 3, 0, Math.PI * 2);
      g.fill();
    }

    // Bog' maydoni, ko'l qirg'og'i, Avtosalon oldi
    const f = world.fountain;
    g.fillStyle = '#d6d3d1';
    g.beginPath();
    g.arc(f.x + f.w / 2, f.y + f.h / 2, 125, 0, Math.PI * 2);
    g.fill();
    const p = world.pond;
    g.fillStyle = '#d9c08c';
    g.beginPath();
    g.ellipse(p.x + p.w / 2, p.y + p.h / 2, p.w / 2 + 14, p.h / 2 + 14, 0, 0, Math.PI * 2);
    g.fill();
    const s = world.shop;
    g.fillStyle = '#cbd5e1';
    g.fillRect(s.x - 10, s.y + s.h, s.w + 20, 70);

    // Yo'llar
    const R = world.road;
    g.fillStyle = '#9ca3af';
    world.h_roads.forEach((y) => g.fillRect(0, y - 8, world.w, R + 16));
    world.v_roads.forEach((x) => g.fillRect(x - 8, 0, R + 16, world.h));
    g.fillStyle = '#3b404c';
    world.h_roads.forEach((y) => g.fillRect(0, y, world.w, R));
    world.v_roads.forEach((x) => g.fillRect(x, 0, R, world.h));
    g.strokeStyle = '#facc15';
    g.lineWidth = 3;
    g.setLineDash([22, 18]);
    g.beginPath();
    world.h_roads.forEach((y) => { g.moveTo(0, y + R / 2); g.lineTo(world.w, y + R / 2); });
    world.v_roads.forEach((x) => { g.moveTo(x + R / 2, 0); g.lineTo(x + R / 2, world.h); });
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = '#3b404c';
    world.h_roads.forEach((y) => world.v_roads.forEach((x) => g.fillRect(x, y, R, R)));
    g.fillStyle = 'rgba(255,255,255,.8)';
    world.h_roads.forEach((y) => world.v_roads.forEach((x) => {
      for (let i = 0; i < 5; i += 1) {
        g.fillRect(x - 20, y + 6 + i * 15, 14, 8);
        g.fillRect(x + R + 6, y + 6 + i * 15, 14, 8);
        g.fillRect(x + 6 + i * 15, y - 20, 8, 14);
        g.fillRect(x + 6 + i * 15, y + R + 6, 8, 14);
      }
    }));

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(world.w, world.h), new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(world.w / 2, 0, world.h / 2);
    ground.receiveShadow = true;
    scene.add(ground);

    // Xarita chetidan tashqari — keng o'tloq
    const outside = new THREE.Mesh(new THREE.PlaneGeometry(world.w * 5, world.h * 5), mat('#4f8a3a', { roughness: 1 }));
    outside.rotation.x = -Math.PI / 2;
    outside.position.set(world.w / 2, -0.5, world.h / 2);
    scene.add(outside);
  }

  function buildTrees() {
    const n = world.trees.length;
    const trunkGeo = new THREE.CylinderGeometry(3.5, 4.5, 22, 7);
    trunkGeo.translate(0, 11, 0);
    const crownGeo = new THREE.IcosahedronGeometry(1, 1);
    const trunks = new THREE.InstancedMesh(trunkGeo, mat('#7c4a21'), n);
    const crowns = new THREE.InstancedMesh(crownGeo, mat('#ffffff'), n);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const color = new THREE.Color();
    world.trees.forEach((t, i) => {
      m.compose(new THREE.Vector3(t.x, 0, t.y), q, new THREE.Vector3(1, 1 + t.r / 60, 1));
      trunks.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(t.x, 20 + t.r * 0.9, t.y), q, new THREE.Vector3(t.r, t.r * 1.15, t.r));
      crowns.setMatrixAt(i, m);
      crowns.setColorAt(i, color.setHSL(0.3 + (i % 5) * 0.012, 0.5, 0.28 + (i % 3) * 0.04));
    });
    trunks.castShadow = true;
    crowns.castShadow = true;
    crowns.receiveShadow = true;
    scene.add(trunks, crowns);
  }

  let fountainSpray = null;
  function buildPark() {
    const f = world.fountain;
    const cx = f.x + f.w / 2;
    const cz = f.y + f.h / 2;
    scene.add(cyl(70, 72, 10, mat('#cbd5e1'), cx, 5, cz, 40));
    scene.add(cyl(60, 60, 2, mat('#3b82f6', { roughness: 0.1, metalness: 0.1 }), cx, 10.2, cz, 40));
    scene.add(cyl(9, 11, 38, mat('#e2e8f0'), cx, 19, cz));
    scene.add(cyl(26, 20, 6, mat('#e2e8f0'), cx, 38, cz, 24));
    fountainSpray = mesh(new THREE.ConeGeometry(10, 30, 16, 1, true),
      new THREE.MeshStandardMaterial({ color: '#bfdbfe', transparent: true, opacity: 0.6, roughness: 0.1 }), cx, 56, cz, false);
    fountainSpray.rotation.x = Math.PI;
    scene.add(fountainSpray);
    // Skameykalar
    [[-1, 0], [1, 0], [0, -1], [0, 1]].forEach(([dx, dz]) => {
      const bench = box(dz ? 44 : 10, 6, dz ? 10 : 44, mat('#92400e'), cx + dx * 105, 9, cz + dz * 105);
      scene.add(bench, box(4, 9, 4, mat('#4b5563'), cx + dx * 105, 4.5, cz + dz * 105));
    });

    const p = world.pond;
    const water = new THREE.Mesh(new THREE.CircleGeometry(1, 48),
      mat('#2f6fbd', { roughness: 0.08, metalness: 0.15 }));
    water.rotation.x = -Math.PI / 2;
    water.scale.set(p.w / 2, p.h / 2, 1);
    water.position.set(p.x + p.w / 2, 0.8, p.y + p.h / 2);
    water.receiveShadow = true;
    scene.add(water);
    [[0.3, 0.4], [0.68, 0.3], [0.58, 0.7]].forEach(([fx, fz]) => {
      const pad = new THREE.Mesh(new THREE.CircleGeometry(10, 14), mat('#4ade80'));
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(p.x + p.w * fx, 1.2, p.y + p.h * fz);
      scene.add(pad);
    });
  }

  // Avtosalon: oldida BMW va Mercedes, tomida aylanadigan Lamborghini va uchib turgan Tesla
  const showroom = [];
  function buildShop() {
    const s = world.shop;
    const cx = s.x + s.w / 2;
    const cz = s.y + s.h / 2;
    const front = s.y + s.h;
    const body = box(s.w, 62, s.h, mat('#e2e8f0'), cx, 31, cz);
    body.userData.shop = true;
    scene.add(body);
    pickables.push(body);
    scene.add(box(s.w + 6, 16, s.h + 6, mat('#1e3a8a'), cx, 70, cz));
    const sign = signPlane('AVTOSALON', s.w * 0.75, 15, '#1e3a8a', '#ffffff');
    sign.position.set(cx, 70, front + 3.2);
    scene.add(sign);
    scene.add(box(s.w - 40, 40, 1.5, GLASS(), cx, 24, front + 0.8));
    scene.add(box(50, 42, 2, mat('#334155'), cx, 21, front + 1.6));
    const show = (id, x, y, z, rot, spin = 0, hover = false) => {
      if (!carsById[id]) return;
      const model = makeCar(id);
      model.position.set(x, y, z);
      model.rotation.y = rot;
      scene.add(model);
      showroom.push({ model, spin, hover, y });
    };
    show('bmw', s.x + 45, 0, front + 32, 0.5);
    show('mercedes', s.x + s.w - 45, 0, front + 32, -0.5);
    scene.add(cyl(38, 38, 3, mat('#1f2937'), cx - 70, 79.5, cz, 32));
    show('lambo', cx - 70, 81, cz, 0, 0.5);
    show('tesla', cx + 70, 104, cz, 0, 0.7, true);
  }

  // ---------------- Yerlar ----------------
  const plotViews = new Map();   // yer raqami -> {group, sig}

  function buildingTransform(id) {
    const r = world.buildings[id];
    const plot = world.plots[id];
    return { x: r.x + r.w / 2, z: r.y + r.h / 2, rot: plot.gate === 'bottom' ? 0 : Math.PI };
  }

  function fence(group, plot, color) {
    const m = mat(color);
    const h = 9;
    const t = 3;
    const gx = plot.x + plot.w / 2;
    const gate = 52;
    const near = plot.gate === 'bottom' ? plot.y + plot.h : plot.y;
    const far = plot.gate === 'bottom' ? plot.y : plot.y + plot.h;
    group.add(box(plot.w, h, t, m, gx, h / 2, far));
    group.add(box(t, h, plot.h, m, plot.x, h / 2, plot.y + plot.h / 2));
    group.add(box(t, h, plot.h, m, plot.x + plot.w, h / 2, plot.y + plot.h / 2));
    const side = (plot.w - gate) / 2;
    group.add(box(side, h, t, m, plot.x + side / 2, h / 2, near));
    group.add(box(side, h, t, m, plot.x + plot.w - side / 2, h / 2, near));
    [[plot.x + side, near], [plot.x + plot.w - side, near]].forEach(([x, z]) => group.add(box(6, 16, 6, m, x, 8, z)));
  }

  function plotSignature(id) {
    const r = plotsById.get(id);
    if (!r) return 'free';
    return `${r.owner}|${r.kind}|${r.level}|${r.name}|${r.home}|${r.owner === me.key}|${r.price}`;
  }

  // "SOTUVDA" taxtachasi darvoza yonida
  function saleBoard(group, gx, near, out, price) {
    const post = box(3, 30, 3, mat('#78350f'), gx + 50, 15, near - out * 18);
    const board = signPlane(`SOTUVDA\n${formatNumber(price)} so'm`, 62, 30, '#b45309', '#ffffff');
    board.position.set(gx + 50, 34, near - out * 18);
    if (out < 0) board.rotation.y = Math.PI;
    group.add(post, board);
  }

  function renderPlot(id) {
    const sig = plotSignature(id);
    const view = plotViews.get(id);
    if (view && view.sig === sig) return;
    if (view) {
      scene.remove(view.group);
      view.group.traverse((o) => { const i = pickables.indexOf(o); if (i >= 0) pickables.splice(i, 1); });
      disposeTree(view.group);
    }

    const plot = world.plots[id];
    const rec = plotsById.get(id);
    const mine = rec && rec.owner === me.key;
    const group = new THREE.Group();
    const gx = plot.x + plot.w / 2;
    const near = plot.gate === 'bottom' ? plot.y + plot.h : plot.y;
    const out = plot.gate === 'bottom' ? 1 : -1;

    const yardColor = !rec ? '#c7a77a' : (rec.level ? '#79ad57' : '#9fb66a');
    const yard = new THREE.Mesh(new THREE.PlaneGeometry(plot.w, plot.h), mat(yardColor, { roughness: 1 }));
    yard.rotation.x = -Math.PI / 2;
    yard.position.set(gx, 0.35, plot.y + plot.h / 2);
    yard.receiveShadow = true;
    yard.userData.plot = id;
    group.add(yard);
    pickables.push(yard);

    let labelText = null;
    let labelBg;
    if (!rec) {
      // Bo'sh yer — taxtacha (ekran yozuvlar bilan to'lib ketmasin)
      saleBoard(group, gx, near, out, catalog.land_price);
    } else {
      if (rec.price) saleBoard(group, gx, near, out, rec.price); // egasi sotuvga qo'ygan
      fence(group, plot, mine ? '#3b82f6' : '#8b5a2b');
      const t = buildingTransform(id);
      if (rec.level > 0) {
        const b = makeBuilding(rec.kind, rec.level);
        b.position.set(t.x, 0, t.z);
        b.rotation.y = t.rot;
        b.traverse((o) => { o.userData.plot = id; });
        group.add(b);
        pickables.push(b);
      } else {
        // Bo'sh yer — poydevor chizig'i
        const base = box(150, 2, 100, mat('#a8a29e'), t.x, 1, t.z);
        base.userData.plot = id;
        group.add(base);
      }
      const who = mine ? 'Siz' : rec.name;
      const what = rec.level ? `${kindName(rec.kind)} · ${rec.level} qavat` : "bo'sh yer";
      labelText = `${who}${rec.home ? ' · Ota hovli' : ''} · ${what}${rec.price ? ' · SOTUVDA' : ''}`;
      labelBg = mine ? 'rgba(37,99,235,.92)' : 'rgba(15,23,42,.82)';
    }
    if (labelText) {
      const label = makeLabel(labelText, labelBg, null, true);
      label.position.set(gx, 34, near + out * 6);
      label.scale.multiplyScalar(0.85);
      group.add(label);
    }

    scene.add(group);
    plotViews.set(id, { group, sig });
  }

  function setPlots(list) {
    plotsById.clear();
    list.forEach((p) => plotsById.set(p.plot, p));
    world.plots.forEach((p) => renderPlot(p.id));
    buildSolids();
  }

  function buildSolids() {
    const s = world.shop;
    solids = [{ ...world.shop, top: 84 }, { ...world.fountain, top: 60 }, { ...world.pond, top: 60 },
      { x: s.x + 20, y: s.y + s.h + 14, w: 50, h: 36, top: 30 },
      { x: s.x + s.w - 70, y: s.y + s.h + 14, w: 50, h: 36, top: 42 }];
    plotsById.forEach((r) => {
      if (r.level > 0) solids.push({ ...world.buildings[r.plot], top: buildingTop(r.kind, r.level) });
    });
  }

  const inside = (x, y, s, r = 0) => x + r > s.x && x - r < s.x + s.w && y + r > s.y && y - r < s.y + s.h;
  // h — balandlik: uchayotgan mashina past binolar ustidan o'tadi
  function blocked(x, y, r, h = 0) {
    if (x < r || y < r || x > world.w - r || y > world.h - r) return true;
    return solids.some((s) => h < s.top && inside(x, y, s, r));
  }
  function topUnder(x, y, r) {
    let top = 0;
    solids.forEach((s) => { if (inside(x, y, s, r)) top = Math.max(top, s.top); });
    return top;
  }

  // ---------------- Taksi: yo'lovchilar va manzil ----------------
  const SHIRTS = ['#ef4444', '#8b5cf6', '#14b8a6', '#f97316', '#ec4899', '#0ea5e9', '#84cc16'];

  function makePassengerView(p) {
    const root = new THREE.Group();
    const human = makeHuman(String(p.id), SHIRTS[p.id % SHIRTS.length]);
    const ring = new THREE.Mesh(new THREE.RingGeometry(20, 26, 32), new THREE.MeshBasicMaterial({
      color: '#facc15', transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide,
    }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.8;
    const label = makeLabel(`Taksi! ${formatNumber(p.fare)} so'm`, 'rgba(202,138,4,.95)', null, true);
    label.position.y = 80;
    label.scale.multiplyScalar(0.8);
    root.add(human, ring, label);
    root.position.set(p.x, 0, p.y);
    root.visible = showPassengers();
    scene.add(root);
    return { root, human, ring, label, wave: (p.id * 1.7) % 6 };
  }

  function removePassenger(id) {
    const p = passengers.get(id);
    if (!p) return;
    scene.remove(p.view.root);
    disposeTree(p.view.root);
    passengers.delete(id);
  }

  function setPassengers(list) {
    const seen = new Set();
    list.forEach((p) => {
      seen.add(p.id);
      if (!passengers.has(p.id)) passengers.set(p.id, { ...p, view: makePassengerView(p) });
    });
    [...passengers.keys()].forEach((id) => { if (!seen.has(id)) removePassenger(id); });
  }

  // Manzil va yo'l ko'rsatkich: yuqoriga ketgan rangli nur + yerdagi halqa
  function makeBeacon(x, y, color, radius) {
    const g = new THREE.Group();
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(30, 30, 1400, 24, 1, true), new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.25, depthWrite: false, side: THREE.DoubleSide, fog: false,
    }));
    beam.position.y = 700;
    const ring = new THREE.Mesh(new THREE.RingGeometry(radius - 12, radius, 48), new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false,
    }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 1;
    g.add(beam, ring);
    g.position.set(x, 0, y);
    g.userData.ring = ring;
    scene.add(g);
    return g;
  }
  function dropBeacon(view) {
    if (!view) return null;
    scene.remove(view);
    disposeTree(view);
    return null;
  }

  let rideView = null;
  let guideView = null;
  function setRide(next) {
    const same = ride && next && ride.id === next.id;
    ride = next || null;
    me.taxi = Boolean(ride);
    if (same) return;
    rideView = dropBeacon(rideView);
    if (ride) rideView = makeBeacon(ride.tx, ride.ty, '#22c55e', catalog.taxi_drop_dist - 20);
    taxiCardKey = '';
  }

  function setGuide(x, y, label) {
    guideView = dropBeacon(guideView);
    guide = x === undefined ? null : { x, y, label };
    if (guide) guideView = makeBeacon(x, y, '#3b82f6', 70);
    taxiCardKey = '';
  }

  // O'yinchi tepasidagi strelka: manzilga / belgilangan joyga / eng yaqin yo'lovchiga
  const arrow = new THREE.Group();
  const ARROW_COLORS = { ride: glow('#22c55e', 0.7), guide: glow('#3b82f6', 0.7), pass: glow('#facc15', 0.7) };
  const arrowCone = mesh(new THREE.ConeGeometry(9, 22, 16), ARROW_COLORS.ride, 0, 0, 14, false);
  arrowCone.rotation.x = Math.PI / 2;
  const arrowTail = mesh(new THREE.BoxGeometry(6, 3, 18), ARROW_COLORS.ride, 0, 0, -4, false);
  arrow.add(arrowCone, arrowTail);
  arrow.visible = false;
  scene.add(arrow);

  function nearestPassenger() {
    let best = null;
    passengers.forEach((p, id) => {
      const d = Math.hypot(p.x - me.x, p.y - me.y);
      if (!best || d < best.d) best = { id, p, d };
    });
    return best;
  }

  function updateArrow() {
    let target = null;
    if (ride) target = { x: ride.tx, y: ride.ty, kind: 'ride' };
    else if (guide) target = { x: guide.x, y: guide.y, kind: 'guide' };
    else if (me.car && taxiOn) {
      const n = nearestPassenger();
      if (n && n.d > 220) target = { x: n.p.x, y: n.p.y, kind: 'pass' };
    }
    const d = target ? Math.hypot(target.x - me.x, target.y - me.y) : 0;
    arrow.visible = Boolean(target) && d > 120;
    if (!arrow.visible) return;
    arrowCone.material = ARROW_COLORS[target.kind];
    arrowTail.material = ARROW_COLORS[target.kind];
    const lift = me.rig.root.position.y;
    arrow.position.set(me.x, lift + (me.car ? 62 : 100), me.y);
    arrow.rotation.y = Math.atan2(target.x - me.x, target.y - me.y);
  }

  // Taksi kartasi (ekranda): masofa, haqi, bekor qilish
  let taxiCardKey = '';
  function updateTaxiCard() {
    let mode = '';
    let title = '';
    let sub = '';
    if (ride) {
      mode = 'ride';
      const car = carInfo();
      title = car ? "Yo'lovchini yashil nurga olib boring" : "Mashinaga o'tiring (E) — yo'lovchi kutyapti";
      sub = `${meters(Math.hypot(ride.tx - me.x, ride.ty - me.y))} · haqi ${formatNumber(Math.floor(ride.fare * (car ? car.fare : 1)))} so'm`;
    } else if (guide) {
      mode = 'guide';
      title = `Yo'l: ${guide.label}`;
      sub = `${meters(Math.hypot(guide.x - me.x, guide.y - me.y))} · ko'k nurga boring`;
    }
    const key = `${mode}|${title}|${sub}`;
    if (key === taxiCardKey) return;
    const modeChanged = taxiCardKey.split('|')[0] !== mode;
    taxiCardKey = key;
    const card = $('taxi');
    card.hidden = !mode;
    if (!mode) return;
    if (modeChanged) {
      card.className = `taxi-card taxi-card--${mode}`;
      $('taxi-icon').replaceChildren(icon(mode === 'ride' ? 'user' : 'navigation'));
      $('taxi-cancel').title = mode === 'ride' ? "Yo'lovchini tushirib yuborish" : "Yo'l ko'rsatkichni o'chirish";
    }
    $('taxi-title').textContent = title;
    $('taxi-sub').textContent = sub;
  }

  let taxiBusyUntil = 0;
  async function pickup(id, manual) {
    if (ride || !me.car || performance.now() < taxiBusyUntil) return;
    taxiBusyUntil = performance.now() + 2000;
    try {
      const data = await api('/api/game/taxi/pickup', { method: 'POST', body: { id } });
      localVersion += 1;
      const fare = passengers.get(id) ? passengers.get(id).fare : data.ride.fare;
      removePassenger(id);
      setRide(data.ride);
      if (guide) setGuide();
      sound.ding();
      const mult = carInfo() ? carInfo().fare : 1;
      toast(`Yo'lovchi o'tirdi! Yashil nurga olib boring — ${formatNumber(fare * mult)} so'm`, 'success');
      taxiBusyUntil = 0;
    } catch (err) {
      if (handleAuthError(err)) return;
      if (err.status === 409) removePassenger(id);
      if (manual || err.status === 409) toast(err.message, 'warn');
      taxiBusyUntil = performance.now() + 800;
    }
  }

  async function dropoff() {
    if (!ride || !me.car || performance.now() < taxiBusyUntil) return;
    taxiBusyUntil = performance.now() + 2000;
    try {
      const data = await api('/api/game/taxi/dropoff', { method: 'POST' });
      localVersion += 1;
      setEconomy(data.economy);
      setRide(null);
      sound.cash();
      floatText(`+${formatNumber(data.earned)} so'm`, me.x, me.y, me.rig.root.position.y);
      toast(`Yo'lovchi manzilga yetdi! +${formatNumber(data.earned)} so'm`, 'success');
      taxiBusyUntil = 0;
    } catch (err) {
      if (handleAuthError(err)) return;
      taxiBusyUntil = performance.now() + 700; // pozitsiya serverga hali yetmagan — birozdan keyin yana
    }
  }

  async function cancelCard() {
    if (ride) {
      if (!window.confirm("Yo'lovchini tushirib yuborasizmi? Bu safar pul olmaysiz.")) return;
      try {
        await api('/api/game/taxi/cancel', { method: 'POST' });
        localVersion += 1;
        setRide(null);
        toast("Yo'lovchi tushib qoldi. Boshqasini toping — sariq halqalar");
      } catch (err) {
        if (!handleAuthError(err)) toast(err.message, 'warn');
      }
    } else if (guide) {
      setGuide();
    }
  }

  // Avtomatik: yo'lovchi yonida — o'tiradi, manzilda — tushadi
  function taxiTick() {
    if (!me.car) return;
    if (ride) {
      if (Math.hypot(ride.tx - me.x, ride.ty - me.y) < catalog.taxi_drop_dist - 25) dropoff();
      return;
    }
    if (!taxiOn) return;
    const n = nearestPassenger();
    if (n && n.d < AUTO_PICK) pickup(n.id, false);
  }

  const floaters = [];
  function floatText(text, x, y, h = 0) {
    const s = makeLabel(text, 'rgba(22,163,74,.95)');
    s.position.set(x, 50 + h, y);
    scene.add(s);
    floaters.push({ sprite: s, t: 0 });
  }

  // ---------------- Boshqa o'yinchilar ----------------
  let friendsSig = '';
  function setPlayers(list) {
    const seen = new Set();
    list.forEach((p) => {
      seen.add(p.key);
      let o = others.get(p.key);
      if (!o) {
        o = { ...p, tx: p.x, ty: p.y, rig: makeRig(p.name, p.avatar, false) };
        others.set(p.key, o);
      }
      Object.assign(o, {
        tx: p.x, ty: p.y, th: p.h || 0, dir: p.dir, car: p.car, taxi: p.taxi, name: p.name, avatar: p.avatar,
        seat: p.seat || null,
      });
    });
    // Mashinadagi yo'lovchilar soni haydovchi ismi yonida: "Jasur (+2)"
    const riders = new Map();
    list.forEach((p) => { if (p.seat) riders.set(p.seat, (riders.get(p.seat) || 0) + 1); });
    if (me.seat) riders.set(me.seat.driver, (riders.get(me.seat.driver) || 0) + 1);
    list.forEach((p) => {
      const n = riders.get(p.key) || 0;
      setRigLabel(others.get(p.key).rig, n ? `${p.name} (+${n})` : p.name, p.avatar);
    });
    const mine = riders.get(me.key) || 0;
    setRigLabel(me.rig, mine ? `Siz (+${mine})` : 'Siz', me.avatar);
    [...others.keys()].forEach((key) => {
      if (!seen.has(key)) {
        removeRig(others.get(key).rig);
        others.delete(key);
      }
    });

    $('online-count').textContent = others.size + 1;
    const sig = [...others.values()].map((p) => `${p.name}|${p.avatar}`).join(',');
    if (sig === friendsSig) return;
    friendsSig = sig;
    const box2 = $('friends');
    box2.replaceChildren();
    box2.hidden = others.size === 0;
    if (!others.size) return;
    box2.append(el('small', '', "Do'stlar o'yinda"));
    [...others.values()].slice(0, 8).forEach((p) => {
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
      box2.append(row);
    });
  }

  // ---------------- Pul, mashina ----------------
  let sheetSig = '';
  function setEconomy(next) {
    economy = next;
    economyAt = Date.now();
    if (me && me.car && !economy.cars.includes(me.car)) me.car = null;
    updateRideButton();
    if (sheetState && sheetSignature() !== sheetSig) renderSheet();
  }

  function bestCar() {
    if (!economy || !economy.cars.length) return null;
    if (selectedCar && economy.cars.includes(selectedCar)) return selectedCar;
    return [...economy.cars].sort((a, b) => carsById[b].price - carsById[a].price)[0];
  }

  function updateRideButton() {
    const inCar = Boolean(me && me.car);
    $('ride-icon').replaceChildren(icon(inCar ? 'footprints' : 'car'));
    $('ride-label').textContent = me && me.seat ? 'Mashinadan tushish' : (inCar ? 'Piyoda yurish' : "Mashinaga o'tirish");
    if (me && me.seat) $('ride-icon').replaceChildren(icon('footprints'));
    $('btn-horn').hidden = !inCar;
    if (!inCar) taxiOn = false;
    const yandex = $('btn-yandex');
    yandex.hidden = !inCar;
    yandex.classList.toggle('is-on', taxiOn);
    yandex.setAttribute('aria-pressed', String(taxiOn));
    $('yandex-state').textContent = taxiOn ? 'Buyurtma qabul qilinmoqda' : "Taksi o'chiq — bosing";
  }

  // "Yandex" — taksi rejimi: yoqilsa yo'lovchilar paydo bo'ladi va pul ishlaysiz
  function toggleTaxi() {
    if (!me || !me.car) {
      toast("Avval mashinaga o'tiring (E)", 'warn');
      return;
    }
    taxiOn = !taxiOn;
    updateRideButton();
    if (taxiOn) {
      sound.ding();
      toast("Yandex yoqildi! Sariq halqadagi yo'lovchilarga boring — o'zi o'tiradi", 'success');
    } else {
      toast(ride ? "Yandex o'chdi. Mashinadagi yo'lovchini manziliga eltib qo'ying" : "Yandex o'chdi");
    }
  }

  function setCar(id) {
    if (me.car && me.h > 5) {
      toast("Avval qo'ning (Probel)", 'warn');
      return false;
    }
    me.car = id;
    me.fly = false;
    me.h = 0;
    me.vh = 0;
    sound.door();
    updateRideButton();
    return true;
  }

  // Do'stning mashinasiga yo'lovchi bo'lib o'tirish / tushish
  async function seatIn(driverKey) {
    try {
      const data = await api('/api/game/seat', { method: 'POST', body: { driver: driverKey } });
      localVersion += 1;
      me.seat = data.seat;
      releaseAll();
      sound.door();
      updateRideButton();
      toast(`${data.seat.name}ning mashinasidasiz. Tushish — E`, 'success');
    } catch (err) {
      if (!handleAuthError(err)) toast(err.message, 'warn');
    }
  }

  async function seatOut() {
    const name = me.seat ? me.seat.name : '';
    me.seat = null;
    localVersion += 1;
    me.x = clamp(me.x + 40, 20, world.w - 20); // mashina yoniga tushamiz
    me.h = 0;
    me.vh = 0;
    sound.door();
    updateRideButton();
    toast(`${name}ning mashinasidan tushdingiz`);
    try {
      await api('/api/game/unseat', { method: 'POST' });
    } catch (err) {
      handleAuthError(err);
    }
  }

  function toggleRide() {
    if (!me) return;
    if (me.seat) {
      seatOut();
      return;
    }
    if (me.car) {
      if (setCar(null)) toast(ride ? "Piyodasiz. Yo'lovchi mashinada kutyapti" : 'Endi piyodasiz');
      return;
    }
    const car = bestCar();
    if (!car) {
      toast('Avval Avtosalondan mashina oling', 'warn');
      if (!guide) setGuide(world.shop.door.x, world.shop.door.y, 'Avtosalon');
      return;
    }
    if (setCar(car)) {
      toast(carsById[car].flies
        ? `${carsById[car].name}dasiz. Probel — uchish!`
        : `${carsById[car].name}dasiz. Taksida pul ishlash uchun tepadagi «Yandex» ni bosing`);
    }
  }

  function toggleFly() {
    const car = carInfo();
    if (!car || !car.flies || sheetState) return;
    me.fly = !me.fly;
    sound.whoosh(me.fly);
    toast(me.fly ? "Uchyapmiz! Baland binolar ustidan o'zi oshib o'tadi. Qo'nish — Probel" : "Qo'nyapmiz…");
  }

  function honk() {
    if (me && me.car) sound.horn(engineKey(me.car));
  }

  // ---------------- Harakat va kamera ----------------
  // Uchish balandligi: oldinda baland bino bo'lsa — undan oshib o'tadi
  function flyTarget() {
    const car = carInfo();
    const ahead = walkSpeed * car.speed * 0.7;
    const ax = me.x + Math.cos(me.dir) * ahead;
    const ay = me.y + Math.sin(me.dir) * ahead;
    let top = 0;
    solids.forEach((s) => {
      if (inside(me.x, me.y, s, 90) || inside(ax, ay, s, 90)) top = Math.max(top, s.top);
    });
    return Math.min(world.fly_height, Math.max(world.fly_cruise, top + 40));
  }

  function step(dt) {
    if (me.seat) {
      // Do'stning mashinasida: haydovchi bilan birga yuramiz, o'zimiz ko'rinmaymiz
      const d = others.get(me.seat.driver);
      if (d) {
        me.x = d.x;
        me.y = d.y;
        me.h = d.h || 0;
        me.dir = d.dir;
      }
      me.moving = false;
      me.throttle = 0;
      me.rig.root.visible = false;
      stepOthers(dt);
      return;
    }
    me.rig.root.visible = true;
    let ix = 0;
    let iy = 0;
    if (!sheetState) {
      const now = performance.now();
      if (isHeld('up', now) || touch.up) iy += 1;
      if (isHeld('down', now) || touch.down) iy -= 1;
      if (isHeld('left', now) || touch.left) ix -= 1;
      if (isHeld('right', now) || touch.right) ix += 1;
    }
    me.moving = Boolean(ix || iy);
    me.throttle += ((me.moving ? 1 : 0) - me.throttle) * Math.min(1, dt * 3);
    const car = carInfo();
    if (me.moving) {
      // Kamera qaragan tomonga nisbatan yurish
      const fx = -Math.sin(cam.yaw);
      const fz = -Math.cos(cam.yaw);
      const rx = Math.cos(cam.yaw);
      const rz = -Math.sin(cam.yaw);
      let dx = rx * ix + fx * iy;
      let dz = rz * ix + fz * iy;
      const len = Math.hypot(dx, dz);
      dx /= len;
      dz /= len;
      const speed = walkSpeed * (car ? car.speed : 1);
      const r = car ? 20 : 12;
      const stuck = blocked(me.x, me.y, r, me.h);
      const nx = me.x + dx * speed * dt;
      const ny = me.y + dz * speed * dt;
      if (stuck || !blocked(nx, me.y, r, me.h)) me.x = clamp(nx, r, world.w - r);
      if (stuck || !blocked(me.x, ny, r, me.h)) me.y = clamp(ny, r, world.h - r);
      me.dir = Math.atan2(dz, dx);
    }
    if (car && car.flies) {
      // Uchish / qo'nish (bino ustida qo'nmaydi — tomi ustida turadi)
      let target = 0;
      if (me.fly) target = flyTarget();
      else if (me.h > 0) {
        const roof = topUnder(me.x, me.y, 20);
        if (roof) target = Math.min(me.h, roof + 10);
      }
      const rate = target > me.h ? 520 : 240;
      me.h = me.h < target ? Math.min(target, me.h + rate * dt) : Math.max(target, me.h - rate * dt);
      me.vh = 0;
    } else if (car) {
      me.h = 0;
      me.vh = 0;
    } else if (me.h > 0 || me.vh > 0) {
      // Sakrash: tepaga tezlik, keyin tortishish pastga tushiradi
      me.vh -= GRAVITY * dt;
      me.h = Math.max(0, me.h + me.vh * dt);
      if (me.h === 0) me.vh = 0;
    }
    updateRig(me.rig, me, dt, me.moving);
    stepOthers(dt);
  }

  // Do'stlar silliq harakatlanadi (yo'lovchi bo'lib o'tirganlar ko'rinmaydi)
  function stepOthers(dt) {
    const k = Math.min(1, dt * 10);
    others.forEach((p) => {
      const ox = p.x;
      const oy = p.y;
      p.x += (p.tx - p.x) * k;
      p.y += (p.ty - p.y) * k;
      p.h = (p.h || 0) + ((p.th || 0) - (p.h || 0)) * Math.min(1, dt * 14);
      p.rig.root.visible = !p.seat;
      updateRig(p.rig, p, dt, Math.hypot(p.x - ox, p.y - oy) > 0.2);
    });
  }

  // Taksi kutayotganlar faqat mashinada (va yo'lovchi yo'q paytda) ko'rinadi
  const showPassengers = () => Boolean(me.car) && taxiOn && !ride;

  // Yo'lovchilar mashinadagi o'yinchiga qarab qo'l silkitadi
  function animatePassengers(dt, now) {
    const show = showPassengers();
    passengers.forEach((p) => {
      const v = p.view;
      v.root.visible = show;
      if (!show) return;
      const d = Math.hypot(me.x - p.x, me.y - p.y);
      v.label.visible = d < 1500;
      v.ring.material.opacity = 0.55 + Math.sin(now / 250 + p.id) * 0.3;
      if (d > 1600) return;
      v.human.rotation.y = Math.atan2(me.x - p.x, me.y - p.y);
      v.wave += dt * 9;
      animateHuman(v.human, 0, false, false, d < 700 ? v.wave : null);
    });
  }

  const camPos = new THREE.Vector3();
  const camLook = new THREE.Vector3();
  let camReady = false;
  function updateCamera(dt) {
    const car = carInfo();
    // uchganda kamera ham ko'tariladi (sakrashda emas); do'stning uchayotgan mashinasida ham
    const lift = (car && car.flies) || me.seat ? me.h : 0;
    const target = new THREE.Vector3(me.x, 24 + lift, me.y);
    const horiz = Math.cos(cam.pitch) * cam.dist;
    const want = new THREE.Vector3(
      me.x + Math.sin(cam.yaw) * horiz,
      lift + Math.sin(cam.pitch) * cam.dist,
      me.y + Math.cos(cam.yaw) * horiz,
    );
    const k = camReady ? 1 - Math.exp(-dt * 8) : 1;
    camPos.lerp(want, k);
    camLook.lerp(target, k);
    camReady = true;
    camera.position.copy(camPos);
    camera.lookAt(camLook);
    // Soya kamerasi o'yinchi atrofida
    sun.position.set(me.x + SUN_DIR.x, SUN_DIR.y, me.y + SUN_DIR.z);
    sun.target.position.set(me.x, 0, me.y);
    scene.fog.near = 1400 + lift;
    scene.fog.far = 3600 + lift * 1.5;
  }

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = w < h ? 68 : 50; // tik ekranda (telefon) kengroq ko'rinsin
    camera.updateProjectionMatrix();
  }

  // ---------------- Yaqin joy va bosish ----------------
  let nearTarget = null;
  let lastNearCheck = 0;
  function nearShop() {
    const d = world.shop.door;
    return Math.hypot(d.x - me.x, d.y - me.y) <= catalog.shop_radius - 20;
  }

  function checkNear(now) {
    if (now - lastNearCheck < 120) return;
    lastNearCheck = now;
    taxiTick();
    if (guide && Math.hypot(guide.x - me.x, guide.y - me.y) < 120) {
      toast(`Yetib keldingiz: ${guide.label}`, 'success');
      setGuide();
    }
    if (me.seat) {
      nearTarget = null;
      $('prompt').hidden = true;
      return;
    }
    let best = null;
    if (!me.car && me.h < 40) {
      // Do'stning mashinasi yonida — unga o'tirish
      others.forEach((p, key) => {
        if (!p.car || p.seat) return;
        const d = Math.hypot(p.x - me.x, p.y - me.y);
        if (d < 110 && (!best || d < best.d)) best = { kind: 'seat', key, name: p.name, d };
      });
    }
    if (!best && me.car && taxiOn && !ride) {
      const n = nearestPassenger();
      if (n && n.d < catalog.taxi_pick_dist) best = { kind: 'passenger', id: n.id, d: n.d };
    }
    if (!best && me.h < 40) {
      const door = world.shop.door;
      const dShop = Math.hypot(door.x - me.x, door.y - me.y);
      if (dShop < 140) best = { kind: 'shop', d: dShop };
      world.plots.forEach((p) => {
        const gate = { x: p.x + p.w / 2, y: p.gate === 'bottom' ? p.y + p.h : p.y };
        const d = Math.min(Math.hypot(gate.x - me.x, gate.y - me.y), Math.hypot(p.x + p.w / 2 - me.x, p.y + p.h / 2 - me.y));
        if (d < 120 && (!best || d < best.d)) best = { kind: 'plot', id: p.id, d };
      });
    }
    nearTarget = best;
    const prompt = $('prompt');
    if (!best || sheetState) {
      prompt.hidden = true;
      return;
    }
    let text = 'Avtosalon — mashina sotib olish';
    if (best.kind === 'seat') {
      text = `${best.name}ning mashinasiga o'tirish`;
    } else if (best.kind === 'passenger') {
      const p = passengers.get(best.id);
      text = `Yo'lovchini olish — ${formatNumber(p.fare * carInfo().fare)} so'm`;
    } else if (best.kind === 'plot') {
      const r = plotsById.get(best.id);
      if (!r) text = `${plotTitle(best.id)} — sotuvda`;
      else if (r.owner === me.key) text = r.level ? `${kindName(r.kind)} · ${r.level} qavat` : `${plotTitle(best.id)} — nima quramiz?`;
      else text = `${r.name}: ${r.level ? `${kindName(r.kind)} · ${r.level} qavat` : "bo'sh yer"}`
        + (r.price ? ` — sotuvda ${formatNumber(r.price)} so'm` : '');
    }
    $('prompt-text').textContent = text;
    prompt.hidden = false;
  }

  function interact() {
    if (!nearTarget) return;
    if (nearTarget.kind === 'seat') seatIn(nearTarget.key);
    else if (nearTarget.kind === 'passenger') pickup(nearTarget.id, true);
    else if (nearTarget.kind === 'shop') openSheet({ kind: 'shop' });
    else openSheet({ kind: 'plot', id: nearTarget.id });
  }

  const raycaster = new THREE.Raycaster();
  function pickAt(clientX, clientY) {
    const v = new THREE.Vector2((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
    raycaster.setFromCamera(v, camera);
    const hits = raycaster.intersectObjects(pickables, true);
    for (const hit of hits) {
      let o = hit.object;
      while (o) {
        if (o.userData.plot !== undefined) return openSheet({ kind: 'plot', id: o.userData.plot });
        if (o.userData.shop) return openSheet({ kind: 'shop' });
        o = o.parent;
      }
    }
    return null;
  }

  // ---------------- Oyna (yer / Avtosalon / Mulklarim) ----------------
  const sheet = $('sheet');
  const sheetBackdrop = $('sheet-backdrop');

  function openSheet(state) {
    sheetState = state;
    releaseAll();
    renderSheet();
    sheet.hidden = false;
    sheetBackdrop.hidden = false;
    $('prompt').hidden = true;
    $('sheet-close').focus();
  }

  function closeSheet() {
    sheetState = null;
    clearTimeout(quizTimer);
    sheet.hidden = true;
    sheetBackdrop.hidden = true;
  }

  function sheetSignature() {
    if (!sheetState) return '';
    // Savol-javob oynasi faqat javob berilganda qayta chiziladi (har sinxronda emas)
    if (sheetState.kind === 'quiz') return `quiz|${sheetState.quiz.token}|${JSON.stringify(sheetState.result)}`;
    // Odamlar va pul berish oynalari sinxronda qayta chizilmaydi (yozilgan summa o'chib ketmasin)
    if (sheetState.kind === 'people') return `people|${sheetState.list ? sheetState.list.length : '-'}`;
    if (sheetState.kind === 'give') return `give|${sheetState.person.key}`;
    if (sheetState.kind === 'market') {
      const m = money();
      const listed = [...plotsById.values()].filter((r) => r.price);
      return `market|${listed.map((r) => `${r.plot}:${r.price}:${r.owner}:${m >= r.price}`).join()}|${plotsById.size}|${m >= catalog.land_price}|${catalog.cars.length}`;
    }
    if (sheetState.kind === 'poll') return `poll|${sheetState.data ? JSON.stringify([sheetState.data.my_vote, sheetState.data.proposals.length]) : '-'}`;
    const m = money();
    const prices = [catalog.land_price, ...catalog.buildings.map((b) => b.first.price),
      ...catalog.cars.map((c) => c.price), ...economy.plots.map((p) => p.next_price || 0)];
    const rec = sheetState.kind === 'plot' ? plotsById.get(sheetState.id) : null;
    return [JSON.stringify(sheetState), JSON.stringify(economy.plots), economy.cars.join(), me.car,
      sheetState.kind === 'shop' ? nearShop() : '', rec ? `${rec.owner}|${rec.kind}|${rec.level}|${rec.price}` : '-',
      rec && rec.price ? m >= rec.price : '',
      ...prices.map((p) => m >= p)].join('|');
  }

  function priceButton(text, price, onClick, extraClass = 'btn--block') {
    const btn = el('button', `btn btn--primary ${extraClass}`);
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

  function floorsBar(level, kind) {
    const top = kindMax(kind);
    const wrap = el('div', 'floors');
    const bar = el('div', 'floors__bar');
    const fill = el('span', 'floors__fill');
    fill.style.width = `${Math.max(1, (level / top) * 100)}%`;
    bar.append(fill);
    wrap.append(bar, el('small', '', `${level} / ${top} qavat`));
    return wrap;
  }

  async function plotAction(id, action, body) {
    const data = await api(`/api/game/plots/${id}/${action}`, { method: 'POST', body });
    localVersion += 1;
    setPlots(data.plots);
    setEconomy(data.economy);
    return data;
  }

  function setHead(iconName, title, sub) {
    $('sheet-icon').replaceChildren(icon(iconName));
    $('sheet-title').textContent = title;
    $('sheet-sub').textContent = sub;
  }

  // Sotuv: egasi (yoki owner) narx qo'yadi, uyni boshqa haqiqiy o'yinchi sotib oladi — pul egasiga tushadi
  function saleBox(id, rec, own) {
    const box2 = el('div', 'sale');
    const forOther = rec.owner !== me.key; // owner boshqaning uyini sotuvga qo'ymoqda
    const thing = rec.level ? `${kindName(rec.kind)} (${rec.level} qavat)` : "Yer";
    if (rec.price) {
      box2.append(el('strong', 'sale__title', `Sotuvda: ${formatNumber(rec.price)} so'm`),
        el('small', '', forOther
          ? `Kimdir sotib olsa, pul ${rec.name}ga tushadi.`
          : "Boshqa o'yinchi sotib olsa, pul sizga tushadi. Ungacha uy sizniki va daromad keladi."));
      const off = el('button', 'btn btn--ghost btn--block');
      off.type = 'button';
      off.append(icon('x'), el('span', '', 'Sotuvdan olish'));
      off.addEventListener('click', async () => {
        off.disabled = true;
        try {
          await plotAction(id, 'unlist');
          toast('Sotuvdan olindi');
        } catch (err) {
          if (!handleAuthError(err)) toast(err.message, 'warn');
          off.disabled = false;
        }
      });
      box2.append(off);
      return box2;
    }
    box2.append(el('strong', 'sale__title', forOther ? `Owner: ${rec.name}ning uyini sotuvga qo'yish` : 'Sotuvga qo\'yish'),
      el('small', '', forOther
        ? `Narxni yozing. Kimdir sotib olsa, pul ${rec.name}ga tushadi.`
        : `${thing} uchun narx qo'ying. Uni boshqa o'yinchi sotib oladi va pul sizga tushadi.`));
    const row = el('div', 'sale__row');
    const input = el('input', 'input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.placeholder = own && own.invested ? `masalan ${formatNumber(own.invested)}` : `kamida ${formatNumber(catalog.min_sale_price)}`;
    input.setAttribute('aria-label', "Narx (so'm)");
    input.value = sheetState.draftPrice || '';
    input.addEventListener('input', () => { sheetState.draftPrice = input.value; });
    const go = el('button', 'btn btn--primary');
    go.type = 'button';
    go.append(icon('coins'), el('span', '', "Sotuvga qo'yish"));
    const submit = async () => {
      const price = Number(String(input.value).replace(/\D/g, ''));
      if (!price || price < catalog.min_sale_price) {
        toast(`Narx kamida ${formatNumber(catalog.min_sale_price)} so'm bo'lsin`, 'warn');
        input.focus();
        return;
      }
      go.disabled = true;
      try {
        sheetState.draftPrice = '';
        await plotAction(id, 'list', { price });
        toast(`Sotuvga qo'yildi: ${formatNumber(price)} so'm. Xaridor kutilmoqda`, 'success');
      } catch (err) {
        if (!handleAuthError(err)) toast(err.message, 'warn');
        go.disabled = false;
      }
    };
    go.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    row.append(input, go);
    box2.append(row);
    return box2;
  }

  // Boshqa o'yinchi sotuvga qo'ygan uyni sotib olish
  function buyListedBox(id, rec) {
    const box2 = el('div', 'offer');
    box2.append(el('small', 'eyebrow', 'Sotuvda'), el('strong', '', `${formatNumber(rec.price)} so'm`),
      el('span', '', `${rec.level ? `${kindName(rec.kind)} (${rec.level} qavat)` : "Bo'sh yer"} binosi bilan sizniki bo'ladi. Pul ${rec.name}ga o'tadi.`),
      priceButton('Sotib olish', rec.price, async () => {
        const data = await plotAction(id, 'buy');
        sound.cash();
        toast(`Tabriklaymiz! ${formatNumber(data.paid)} so'mga sotib oldingiz`, 'success');
      }));
    return box2;
  }

  function renderPlotSheet(body, id) {
    const rec = plotsById.get(id);
    const mine = rec && rec.owner === me.key;
    const owned = myPlotIds().length;

    if (!rec) {
      setHead('map-pin', `${plotTitle(id)} — sotuvda`, "Bo'sh yer: sotib oling va xohlagan binoni quring");
      const box2 = el('div', 'offer');
      box2.append(el('small', 'eyebrow', 'Narxi'), el('strong', '', `${formatNumber(catalog.land_price)} so'm`),
        el('span', '', `Keyin Uy, Magazin, Kafe yoki Ofis qurasiz (${floorLimitsText()})`));
      box2.append(priceButton('Yerni sotib olish', catalog.land_price, async () => {
        await plotAction(id, 'buy');
        sound.cash();
        toast(`Tabriklaymiz! ${plotTitle(id)} endi sizniki`, 'success');
      }));
      body.append(box2, el('p', 'sheet-note', `Sizda ${owned} ta yer bor. Yer olish cheklanmagan.`));
      return;
    }

    if (!mine) {
      setHead(rec.level ? KIND_ICONS[rec.kind] : 'map-pin', `${rec.name}ning yeri`, rec.home ? 'Ota hovli' : plotTitle(id));
      const info = el('div', 'house-now');
      if (rec.level) info.append(floorsBar(rec.level, rec.kind));
      info.append(el('strong', '', rec.level ? kindName(rec.kind) : "Bo'sh yer"),
        el('span', '', rec.level ? `${rec.level} qavat` : 'Hali hech narsa qurilmagan'));
      body.append(info);
      if (rec.price) body.append(buyListedBox(id, rec));
      else body.append(el('p', 'sheet-note', "Bu yer boshqa o'yinchiga tegishli. Egasi sotuvga qo'ysa, sotib olishingiz mumkin."));
      if (IS_OWNER) body.append(saleBox(id, rec, null));
      if (IS_OWNER) body.append(ownerDestroyBox(id, rec));
      return;
    }

    const own = economy.plots.find((p) => p.plot === id);
    const title = rec.home ? 'Ota hovli' : plotTitle(id);
    if (!rec.level) {
      setHead('hammer', `${title} — nima quramiz?`, `Bino turini tanlang: har birining qavat chegarasi bor.`);
      const grid = el('div', 'build-grid');
      catalog.buildings.forEach((b) => {
        const card = el('div', 'build-card');
        card.style.setProperty('--kind', b.color);
        const top = el('div', 'build-card__top');
        const ic = el('span', 'build-card__icon');
        ic.append(icon(KIND_ICONS[b.id]));
        top.append(ic, el('strong', '', b.name));
        card.append(top, el('p', '', b.about),
          el('span', 'build-card__income', `+${fmtRate(b.first.income)} so'm / sek · ${b.max} qavatgacha`),
          priceButton('Qurish', b.first.price, async () => {
            await plotAction(id, 'build', { kind: b.id });
            sound.cash();
            toast(`${b.name} qurildi! Endi har soniyada pul keladi`, 'success');
          }));
        grid.append(card);
      });
      body.append(grid, saleBox(id, rec, own));
      return;
    }

    const b = buildingsById[rec.kind];
    const income = own ? own.income : 0;
    setHead(KIND_ICONS[rec.kind], `${title} — ${b.name}`, `${rec.level} qavat · +${fmtRate(income)} so'm / sek`);
    const now = el('div', 'house-now');
    now.append(floorsBar(rec.level, rec.kind), el('strong', '', `${b.name} · ${rec.level} qavat`),
      el('span', '', `+${fmtRate(income)} so'm / sek`));
    body.append(now);

    if (own && own.next_price && IS_OWNER) {
      // Owner — savolsiz, bir bosishda 1 yoki 10 qavat
      const offer = el('div', 'offer');
      const ten = Math.min(10, kindMax(rec.kind) - rec.level);
      let tenPrice = 0;
      for (let lv = rec.level + 1; lv <= rec.level + ten; lv += 1) tenPrice += levelPrice(rec.kind, lv);
      offer.append(el('small', 'eyebrow', 'Yangi qavat'), el('strong', '', `${rec.level + 1}-qavat`),
        el('span', '', `Daromad: +${fmtRate(own.next_income)} so'm / sek bo'ladi`),
        priceButton('+1 qavat', own.next_price, () => ownerUpgrade(id, 1)));
      if (ten > 1) offer.append(priceButton(`+${ten} qavat`, tenPrice, () => ownerUpgrade(id, ten)));
      offer.append(el('small', 'quiz-note', 'Siz owner — qavatlar savolsiz qo\'shiladi.'));
      body.append(offer);
    } else if (own && own.next_price) {
      const offer = el('div', 'offer');
      offer.append(el('small', 'eyebrow', 'Yangi qavat'), el('strong', '', `${rec.level + 1}-qavat`),
        el('span', '', `Daromad: +${fmtRate(own.next_income)} so'm / sek bo'ladi`),
        priceButton('Yangi qavat', own.next_price, () => startQuiz(id)),
        el('small', 'quiz-note', "Qavat qo'shish uchun HTML/CSS savoliga to'g'ri javob bering. Noto'g'ri bo'lsa — pul yechilmaydi."));
      body.append(offer);
    } else {
      const done = el('div', 'offer offer--done');
      done.append(icon('trophy'), el('strong', '', `${b.max} qavat — ${b.name.toLowerCase()} bundan baland bo'lmaydi!`));
      body.append(done);
    }
    body.append(saleBox(id, rec, own));
  }

  // Bino turining qavat chegarasi (Uy 25, Magazin 40, Kafe 60, Ofis 100)
  function kindMax(kind) {
    return buildingsById[kind] ? buildingsById[kind].max : catalog.max_level;
  }
  const floorLimitsText = () => catalog.buildings.map((b) => `${b.name} — ${b.max}`).join(', ') + ' qavatgacha';

  // Qavat narxi (serverdagi formula: 1-qavatdan tur chegarasigacha teng o'sadi)
  function levelPrice(kind, level) {
    const b = buildingsById[kind];
    const value = b.first.price + ((b.last.price - b.first.price) * (level - 1)) / (b.max - 1);
    return Math.round(value / 100) * 100;
  }

  async function ownerUpgrade(id, count) {
    const data = await api(`/api/game/plots/${id}/upgrade`, { method: 'POST', body: { count } });
    localVersion += 1;
    setPlots(data.plots);
    setEconomy(data.economy);
    sound.right();
    const rec = plotsById.get(id);
    toast(`+${data.added} qavat! ${kindName(rec.kind)} endi ${rec.level} qavat`, 'success');
  }

  // ---------------- Savol-javob (yangi qavat uchun) ----------------
  let quizTimer = null;

  async function startQuiz(id) {
    const data = await api(`/api/game/plots/${id}/quiz`, { method: 'POST' });
    sheetState = { kind: 'quiz', id, quiz: data.quiz, result: null };
    renderSheet();
  }

  async function answerQuiz(index) {
    const st = sheetState;
    if (!st || st.kind !== 'quiz' || st.result) return;
    st.result = { pending: true, chosen: index };
    renderSheet();
    try {
      const data = await api(`/api/game/plots/${st.id}/upgrade`, {
        method: 'POST', body: { quiz: st.quiz.token, answer: index },
      });
      if (data.correct) {
        localVersion += 1;
        setPlots(data.plots);
        setEconomy(data.economy);
      }
      st.result = {
        chosen: index,
        correct: data.correct,
        rightIndex: data.correct ? index : data.right_index,
        explain: data.explain,
        until: data.correct ? 0 : Date.now() + (data.wait || catalog.quiz_cooldown) * 1000,
      };
      if (data.correct) {
        const rec = plotsById.get(st.id);
        sound.right();
        toast(`To'g'ri! ${kindName(rec.kind)} endi ${rec.level} qavat`, 'success');
      } else {
        sound.wrong();
      }
    } catch (err) {
      if (handleAuthError(err)) return;
      toast(err.message, 'warn');
      openSheet({ kind: 'plot', id: st.id });
      return;
    }
    if (sheetState === st) renderSheet();
  }

  function renderQuizSheet(body, st) {
    clearTimeout(quizTimer);
    const rec = plotsById.get(st.id);
    const b = buildingsById[rec.kind];
    const target = st.result && st.result.correct ? rec.level : rec.level + 1;
    setHead('hammer', 'Yangi qavat — savol-javob', `${b.name}: ${target}-qavat uchun`);

    const box2 = el('div', 'quiz');
    box2.append(el('span', `quiz__topic quiz__topic--${st.quiz.topic.toLowerCase()}`, st.quiz.topic),
      el('p', 'quiz__q', st.quiz.question));
    const list = el('div', 'quiz__options');
    st.quiz.options.forEach((text, i) => {
      const opt = el('button', 'quiz__opt');
      opt.type = 'button';
      opt.append(el('span', 'quiz__letter', 'ABCD'[i]), el('code', '', text));
      if (st.result) {
        opt.disabled = true;
        if (st.result.pending && st.result.chosen === i) opt.classList.add('is-chosen');
        if (!st.result.pending && i === st.result.rightIndex) opt.classList.add('is-right');
        if (!st.result.pending && !st.result.correct && i === st.result.chosen) opt.classList.add('is-wrong');
      } else {
        opt.addEventListener('click', () => answerQuiz(i));
      }
      list.append(opt);
    });
    box2.append(list);
    body.append(box2);

    if (!st.result || st.result.pending) {
      body.append(el('p', 'sheet-note', st.result ? 'Tekshirilmoqda…' : "To'g'ri javobni tanlang."));
      return;
    }

    const fb = el('div', st.result.correct ? 'quiz__result is-right' : 'quiz__result is-wrong');
    fb.append(el('strong', '', st.result.correct
      ? `To'g'ri! ${b.name} endi ${rec.level} qavat.`
      : `Noto'g'ri. To'g'ri javob: ${st.quiz.options[st.result.rightIndex]}`));
    if (st.result.explain) fb.append(el('p', '', st.result.explain));
    body.append(fb);

    if (st.result.correct) {
      const next = el('button', 'btn btn--primary btn--block');
      next.type = 'button';
      next.append(icon('check'), el('span', '', 'Davom etish'));
      next.addEventListener('click', () => openSheet({ kind: 'plot', id: st.id }));
      body.append(next);
      return;
    }
    // Noto'g'ri: biroz kutib, yangi savol
    const left = Math.ceil((st.result.until - Date.now()) / 1000);
    const again = el('button', 'btn btn--primary btn--block');
    again.type = 'button';
    again.disabled = left > 0;
    again.append(icon('arrow-up'), el('span', '', left > 0 ? `Yangi savol (${left} s)` : 'Yangi savol'));
    again.addEventListener('click', async () => {
      again.disabled = true;
      try {
        await startQuiz(st.id);
      } catch (err) {
        if (!handleAuthError(err)) toast(err.message, 'warn');
        again.disabled = false;
      }
    });
    body.append(again, el('p', 'sheet-note', "Pul yechilmadi. Javobni o'qib oling — keyingi safar albatta topasiz!"));
    if (left > 0) quizTimer = setTimeout(() => { if (sheetState === st) renderSheet(); }, 1000);
  }

  function renderShopSheet(body) {
    const near = nearShop();
    setHead('car', 'Avtosalon', near
      ? "Tezroq mashina — taksida ko'proq pul"
      : 'Mashinalar faqat Avtosalonda sotiladi');
    if (!near) {
      const door = world.shop.door;
      const box2 = el('div', 'offer');
      box2.append(el('strong', '', 'Avtosalonga boring'),
        el('span', '', `Xaritaning chap tomonida, ${meters(Math.hypot(door.x - me.x, door.y - me.y))} uzoqda`));
      const go = el('button', 'btn btn--primary btn--block');
      go.type = 'button';
      go.append(icon('navigation'), el('span', '', "Yo'l ko'rsatish"));
      go.addEventListener('click', () => {
        setGuide(door.x, door.y, 'Avtosalon');
        closeSheet();
        toast("Ko'k strelka va ko'k nur Avtosalonga olib boradi");
      });
      box2.append(go);
      body.append(box2);
    }
    const list = el('div', 'car-list');
    catalog.cars.forEach((car) => {
      const owned = economy.cars.includes(car.id);
      const row = el('div', owned ? 'car-row is-owned' : 'car-row');
      const swatch = el('span', 'car-row__swatch');
      swatch.style.setProperty('--car', car.color);
      swatch.append(icon(car.flies ? 'plane' : 'car'));
      const info = el('div', 'car-row__info');
      info.append(el('strong', '', car.name),
        el('small', '', `Tezlik ×${car.speed} · Taksi haqi ×${car.fare}${car.flies ? ' · UCHADI!' : ''}`));
      if (car.custom) info.append(el('small', 'car-row__new', `Yangi! Ovoz bilan qo'shildi — ${car.author} taklifi («${car.ability}»)`));
      if (car.custom && IS_OWNER) {
        // Owner: ovoz bilan qo'shilgan mashinani olib tashlash
        const del = el('button', 'link-btn link-btn--danger');
        del.type = 'button';
        del.append(icon('trash'), el('span', '', "Owner: Avtosalondan o'chirish"));
        del.addEventListener('click', async () => {
          if (!window.confirm(`${car.name}ni Avtosalondan o'chirasizmi? Uni sotib olganlarga pullari qaytariladi.`)) return;
          try {
            const data = await api(`/api/poll/cars/${car.id}`, { method: 'DELETE' });
            toast(`${data.name} o'chirildi${data.refunded ? ` — ${data.refunded} kishiga pul qaytarildi` : ''}`, 'success');
            refreshCars();
          } catch (err) {
            if (!handleAuthError(err)) toast(err.message, 'warn');
          }
        });
        info.append(del);
      }
      row.append(swatch, info);
      if (owned) {
        const driving = me.car === car.id;
        const btn = el('button', driving ? 'btn btn--ghost' : 'btn btn--primary');
        btn.type = 'button';
        btn.append(icon(driving ? 'check' : 'car'), el('span', '', driving ? 'Haydayapsiz' : 'Haydash'));
        btn.disabled = driving;
        btn.addEventListener('click', () => {
          if (!setCar(car.id)) return;
          selectedCar = car.id;
          closeSheet();
          toast(`${car.name}dasiz. Tushish uchun — E`);
        });
        row.append(btn);
      } else if (near) {
        row.append(priceButton('Olish', car.price, async () => {
          const data = await api(`/api/game/cars/${car.id}`, { method: 'POST' });
          localVersion += 1;
          setEconomy(data.economy);
          sound.cash();
          toast(`Tabriklaymiz! ${car.name} endi sizniki. O'tirish — E`, 'success');
        }, ''));
      } else {
        const price = el('span', 'car-row__price');
        price.append(icon('lock'), el('span', '', `${formatNumber(car.price)} so'm`));
        row.append(price);
      }
      list.append(row);
    });
    body.append(list, el('p', 'sheet-note',
      "Mashinaga o'tirish/tushish — E, signal — H. Taksi: sariq halqadagi yo'lovchiga boring — o'zi o'tiradi, "
      + 'yashil nurga eltsangiz pul olasiz. Teslada Probel — uchish/qo\'nish.'));
  }


  // ---------------- Haftalik mashina ovozi ----------------
  async function openPoll() {
    const st = { kind: 'poll', data: null, draftName: '', draftAbility: '' };
    openSheet(st);
    try {
      const data = await api('/api/poll');
      if (sheetState !== st) return;
      st.data = data;
      renderSheet();
    } catch (err) {
      if (!handleAuthError(err)) toast(err.message, 'warn');
    }
  }

  function carStatsText(stx) {
    return `Tezlik ×${stx.speed} · Taksi ×${stx.fare}${stx.flies ? ' · UCHADI' : ''} · ${formatNumber(stx.price)} so'm`;
  }

  // Yangi mashina qo'shilsa — Avtosalon ro'yxatini yangilaymiz
  async function refreshCars() {
    try {
      const s2 = await api('/api/game/state');
      catalog.cars = s2.catalog.cars;
      carsById = Object.fromEntries(catalog.cars.map((car) => [car.id, car]));
      if (sheetState && sheetState.kind === 'shop') renderSheet();
    } catch { /* keyingi safar */ }
  }

  function renderPollSheet(body, st) {
    const d = st.data;
    if (!d) {
      setHead('vote', 'Haftalik mashina ovozi', 'Yuklanmoqda…');
      return;
    }
    const left = Math.max(0, d.poll.ends_at - d.poll.now);
    const days = Math.floor(left / 86400);
    const hours = Math.floor((left % 86400) / 3600);
    setHead('vote', 'Haftalik mashina ovozi', `Tugashiga ${days} kun ${hours} soat · g'olib Avtosalonga qo'shiladi`);
    if (d.last_winner) {
      body.append(el('p', 'sheet-note', `O'tgan hafta g'olibi: ${d.last_winner.name} (${d.last_winner.author} taklifi) — Avtosalonda!`));
    }
    // Tepada — variantlar
    const list = el('div', 'votes');
    const max = Math.max(1, ...d.proposals.map((p) => p.votes));
    d.proposals.forEach((p) => {
      const row = el('div', d.my_vote === p.id ? 'vote is-mine' : 'vote');
      const swatch = el('span', 'car-row__swatch');
      swatch.style.setProperty('--car', p.stats.color);
      swatch.append(icon(p.stats.flies ? 'plane' : 'car'));
      const info = el('div', 'vote__info');
      const bar = el('span', 'vote__bar');
      const fill = el('span', 'vote__fill');
      fill.style.width = `${(p.votes / max) * 100}%`;
      bar.append(fill);
      info.append(el('strong', '', `${p.name} — ${p.votes} ovoz`), el('small', '', `«${p.ability}» · ${p.author} taklifi`),
        el('small', 'vote__stats', carStatsText(p.stats)), bar);
      const btn = el('button', d.my_vote === p.id ? 'btn btn--ghost' : 'btn btn--primary');
      btn.type = 'button';
      btn.append(icon('check'), el('span', '', d.my_vote === p.id ? 'Ovozingiz' : 'Ovoz berish'));
      btn.disabled = d.my_vote === p.id;
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          st.data = await api('/api/poll/vote', { method: 'POST', body: { proposal: p.id } });
          sound.ding();
          toast(`${p.name} uchun ovoz berdingiz`, 'success');
          renderSheet();
        } catch (err) {
          if (!handleAuthError(err)) toast(err.message, 'warn');
          btn.disabled = false;
        }
      });
      row.append(swatch, info, btn);
      list.append(row);
    });
    if (!d.proposals.length) list.append(el('p', 'sheet-note', "Bu hafta hali taklif yo'q — birinchi bo'lib taklif qiling!"));
    body.append(list);

    // Pastda — yangi mashina taklif qilish
    const box2 = el('div', 'sale');
    box2.append(el('strong', 'sale__title', 'Yangi mashina taklif qilish'));
    if (d.proposed) {
      box2.append(el('small', '', "Bu hafta siz mashina taklif qildingiz. Do'stlaringizni ovoz berishga chaqiring!"));
    } else {
      const cost = d.my_points === null ? 'owner — bepul' : `${d.cost} ball`;
      box2.append(el('small', '', d.my_points === null
        ? 'Nomini va qobiliyatini yozing.'
        : `Taklif qilish ${d.cost} ball turadi (reytingdan ayiriladi). Sizda ${d.my_points} ball bor.`));
      const name = el('input', 'input');
      name.placeholder = 'Mashina nomi, masalan: Chevrolet';
      name.maxLength = 30;
      name.value = st.draftName;
      name.setAttribute('aria-label', 'Mashina nomi');
      name.addEventListener('input', () => { st.draftName = name.value; });
      const ability = el('input', 'input');
      ability.placeholder = "Qobiliyati, masalan: tez bo'lsin, qizil";
      ability.maxLength = 80;
      ability.value = st.draftAbility;
      ability.setAttribute('aria-label', 'Mashina qobiliyati');
      ability.addEventListener('input', () => { st.draftAbility = ability.value; });
      const go = el('button', 'btn btn--primary btn--block');
      go.type = 'button';
      go.append(icon('sparkles'), el('span', '', `Taklif qilish — ${cost}`));
      go.disabled = d.my_points !== null && d.my_points < d.cost;
      go.addEventListener('click', async () => {
        go.disabled = true;
        try {
          st.data = await api('/api/poll/propose', { method: 'POST', body: { name: name.value, ability: ability.value } });
          st.draftName = '';
          st.draftAbility = '';
          sound.cash();
          toast("Taklifingiz variantlarga qo'shildi!", 'success');
          renderSheet();
        } catch (err) {
          if (!handleAuthError(err)) toast(err.message, 'warn');
          go.disabled = false;
        }
      });
      box2.append(name, ability,
        el('small', 'vote__hint', "So'zlar: tez, juda tez, uchadigan, kuchli/jip, taksi, arzon, qimmat; rang: qizil, ko'k, qora, oq, sariq…"),
        go);
    }
    body.append(box2);

    if (d.is_owner) {
      const fin = el('button', 'link-btn');
      fin.type = 'button';
      fin.append(icon('trophy'), el('span', '', 'Owner: ovozni hozir yakunlash (g\'olib Avtosalonga)'));
      fin.addEventListener('click', async () => {
        if (!window.confirm("Ovoz berishni hozir yakunlaysizmi? Eng ko'p ovoz olgan mashina Avtosalonga qo'shiladi va yangi hafta boshlanadi.")) return;
        try {
          const data = await api('/api/poll/finish', { method: 'POST' });
          st.data = data;
          toast(data.winner ? `${data.winner.name} Avtosalonga qo'shildi!` : "Ovoz olgan mashina yo'q edi — yangi hafta boshlandi", 'success');
          refreshCars();
          renderSheet();
        } catch (err) {
          if (!handleAuthError(err)) toast(err.message, 'warn');
        }
      });
      body.append(fin);
    }
  }

  // Owner: boshqaning uyini buzish yoki yerini bo'shatish
  function ownerDestroyBox(id, rec) {
    const wrap = el('div', 'owner-tools');
    const act = async (mode, question, done) => {
      if (!window.confirm(question)) return;
      try {
        await plotAction(id, 'demolish', { mode });
        toast(done, 'success');
      } catch (err) {
        if (!handleAuthError(err)) toast(err.message, 'warn');
      }
    };
    if (rec.level) {
      const b1 = el('button', 'link-btn link-btn--danger');
      b1.type = 'button';
      b1.append(icon('trash'), el('span', '', 'Owner: uyni yo\'q qilish'));
      b1.addEventListener('click', () => act('building',
        `${rec.name}ning ${kindName(rec.kind).toLowerCase()}ini (${rec.level} qavat) yo'q qilasizmi? Yer egasida qoladi.`,
        "Uy yo'q qilindi"));
      wrap.append(b1);
    }
    const b2 = el('button', 'link-btn link-btn--danger');
    b2.type = 'button';
    b2.append(icon('trash'), el('span', '', 'Owner: yerni bo\'shatish (uy bilan)'));
    b2.addEventListener('click', () => act('land',
      `${rec.name}ning yerini (uyi bilan) tortib olib bo'shatasizmi? Yer yana sotuvga chiqadi.`,
      "Yer bo'shatildi"));
    wrap.append(b2);
    return wrap;
  }


  // ---------------- Bozor: sotuvdagi hamma narsa ----------------
  function marketRow(r) {
    const row = el('div', 'car-row');
    const swatch = el('span', 'car-row__swatch');
    swatch.style.setProperty('--car', r.kind ? buildingsById[r.kind].color : '#a8a29e');
    swatch.append(icon(r.kind ? KIND_ICONS[r.kind] : 'map-pin'));
    const info = el('div', 'car-row__info');
    info.append(el('strong', '', r.level ? `${kindName(r.kind)} · ${r.level} qavat` : "Bo'sh yer"),
      el('small', '', `${r.name} sotyapti · ${r.home ? 'Ota hovli' : plotTitle(r.plot)} · +${fmtRate(levelIncomeOf(r))} so'm / sek`));
    row.append(swatch, info, priceButton('Olish', r.price, async () => {
      const data = await plotAction(r.plot, 'buy');
      sound.cash();
      toast(`Tabriklaymiz! ${formatNumber(data.paid)} so'mga sotib oldingiz`, 'success');
    }, ''), guideButton(r.plot));
    return row;
  }

  // Bino daromadi (serverdagi formula bilan bir xil: har qavat narxi / payback)
  function levelIncomeOf(r) {
    if (!r.kind || !r.level) return 0;
    let sum = 0;
    for (let lv = 1; lv <= Math.min(r.level, kindMax(r.kind)); lv += 1) sum += levelPrice(r.kind, lv);
    return Math.round((sum / buildingsById[r.kind].payback) * 100) / 100;
  }

  function guideButton(plotId) {
    const go = el('button', 'btn btn--ghost');
    go.type = 'button';
    go.title = "Yo'l ko'rsatish";
    go.append(icon('navigation'));
    go.addEventListener('click', () => {
      const gate = plotGate(world.plots[plotId]);
      setGuide(gate.x, gate.y, plotTitle(plotId));
      closeSheet();
    });
    return go;
  }

  function renderMarketSheet(body) {
    const listed = [...plotsById.values()].filter((r) => r.price);
    const forMe = listed.filter((r) => r.owner !== me.key).sort((a, b) => a.price - b.price);
    const myListed = listed.filter((r) => r.owner === me.key);
    const free = world.plots.filter((p) => !plotsById.has(p.id))
      .map((p) => ({ p, d: Math.hypot(plotGate(p).x - me.x, plotGate(p).y - me.y) }))
      .sort((a, b) => a.d - b.d);
    setHead('store', 'Bozor', `Sotuvda: ${forMe.length} ta uy · ${free.length} ta bo'sh yer · ${catalog.cars.length} ta mashina`);
    const box2 = el('div', 'market');

    box2.append(el('h3', 'market__title', "O'yinchilar sotayotgan uylar"));
    if (!forMe.length) box2.append(el('p', 'sheet-note', "Hozir hech kim uy sotmayapti. O'z uyingizni sotish uchun uni oching va narx qo'ying."));
    forMe.forEach((r) => box2.append(marketRow(r)));

    if (myListed.length) {
      box2.append(el('h3', 'market__title', 'Siz sotayotganlar'));
      myListed.forEach((r) => {
        const row = el('div', 'car-row is-owned');
        const info = el('div', 'car-row__info');
        info.append(el('strong', '', `${r.level ? `${kindName(r.kind)} · ${r.level} qavat` : "Bo'sh yer"} — ${formatNumber(r.price)} so'm`),
          el('small', '', 'Xaridor kutilmoqda'));
        const off = el('button', 'btn btn--ghost');
        off.type = 'button';
        off.append(icon('x'), el('span', '', 'Sotuvdan olish'));
        off.addEventListener('click', async () => {
          off.disabled = true;
          try {
            await plotAction(r.plot, 'unlist');
            toast('Sotuvdan olindi');
          } catch (err) {
            if (!handleAuthError(err)) toast(err.message, 'warn');
            off.disabled = false;
          }
        });
        row.append(info, off);
        box2.append(row);
      });
    }

    box2.append(el('h3', 'market__title', `Bo'sh yerlar — ${formatNumber(catalog.land_price)} so'm (sizga eng yaqinlari)`));
    free.slice(0, 6).forEach(({ p, d }) => {
      const row = el('div', 'car-row');
      const swatch = el('span', 'car-row__swatch');
      swatch.style.setProperty('--car', '#b45309');
      swatch.append(icon('map-pin'));
      const info = el('div', 'car-row__info');
      info.append(el('strong', '', plotTitle(p.id)), el('small', '', `${meters(d)} uzoqda`));
      row.append(swatch, info, priceButton('Olish', catalog.land_price, async () => {
        await plotAction(p.id, 'buy');
        sound.cash();
        toast(`Tabriklaymiz! ${plotTitle(p.id)} endi sizniki`, 'success');
      }, ''), guideButton(p.id));
      box2.append(row);
    });
    if (!free.length) box2.append(el('p', 'sheet-note', "Bo'sh yer qolmagan."));

    box2.append(el('h3', 'market__title', 'Mashinalar — Avtosalonda'));
    const carRow = el('div', 'car-row');
    const swatch = el('span', 'car-row__swatch');
    swatch.style.setProperty('--car', '#1e3a8a');
    swatch.append(icon('car'));
    const info = el('div', 'car-row__info');
    info.append(el('strong', '', `${catalog.cars.length} ta mashina`), el('small', '', catalog.cars.map((c) => c.name).join(', ')));
    const shopBtn = el('button', 'btn btn--primary');
    shopBtn.type = 'button';
    shopBtn.append(icon('car'), el('span', '', 'Avtosalon'));
    shopBtn.addEventListener('click', () => { openSheet({ kind: 'shop' }); refreshCars(); });
    carRow.append(swatch, info, shopBtn);
    box2.append(carRow);
    body.append(box2);
  }

  // ---------------- Odamlar: ro'yxat va pul berish ----------------
  function avatarEl(p) {
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
    return av;
  }

  async function openPeople() {
    const st = { kind: 'people', list: null };
    openSheet(st);
    try {
      const data = await api('/api/game/people');
      if (sheetState !== st) return;
      st.list = data.people;
      renderSheet();
    } catch (err) {
      if (!handleAuthError(err)) toast(err.message, 'warn');
    }
  }

  function renderPeopleSheet(body, st) {
    const list = st.list || [];
    const online = list.filter((p) => p.online).length;
    setHead('users', 'Odamlar', st.list ? `${online} ta o'yinda · jami ${list.length} ta` : 'Yuklanmoqda…');
    if (!st.list) return;
    const box2 = el('div', 'people');
    list.forEach((p) => {
      const row = el('div', 'person');
      const info = el('div', 'person__info');
      info.append(el('strong', '', p.me ? `${p.name} (Siz)` : p.name),
        el('small', p.online ? 'person__on' : '', p.online ? "O'yinda" : "O'yinda emas"));
      row.append(avatarEl(p), info);
      if (!p.me) {
        const give = el('button', 'btn btn--primary');
        give.type = 'button';
        give.append(icon('coins'), el('span', '', 'Pul berish'));
        give.addEventListener('click', () => openSheet({ kind: 'give', person: p, draft: '' }));
        row.append(give);
      }
      box2.append(row);
    });
    body.append(box2, el('p', 'sheet-note', "Odamni tanlang va qancha pul berishingizni yozing. Pul sizning hisobingizdan o'tadi."));
  }

  function renderGiveSheet(body, st) {
    const p = st.person;
    setHead('coins', `${p.name}ga pul berish`, `Sizda ${formatNumber(money())} so'm bor`);
    const box2 = el('div', 'sale');
    box2.append(el('strong', 'sale__title', 'Qancha berasiz?'));
    const row = el('div', 'sale__row');
    const input = el('input', 'input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.placeholder = "masalan 10 000";
    input.setAttribute('aria-label', "Summa (so'm)");
    input.value = st.draft || '';
    input.addEventListener('input', () => { st.draft = input.value; });
    const send = el('button', 'btn btn--primary');
    send.type = 'button';
    send.append(icon('check'), el('span', '', 'Berish'));
    const chips = el('div', 'chips');
    [1000, 10000, 100000, 1000000].forEach((v) => {
      const c = el('button', 'chip', formatNumber(v));
      c.type = 'button';
      c.addEventListener('click', () => { input.value = formatNumber(v); st.draft = input.value; input.focus(); });
      chips.append(c);
    });
    const submit = async () => {
      const amount = Number(String(input.value).replace(/\D/g, ''));
      if (!amount) {
        toast('Summani yozing', 'warn');
        input.focus();
        return;
      }
      if (amount > money()) {
        toast('Pul yetarli emas', 'warn');
        return;
      }
      send.disabled = true;
      try {
        const data = await api('/api/game/give', { method: 'POST', body: { to: p.key, amount } });
        localVersion += 1;
        setEconomy(data.economy);
        sound.cash();
        toast(`${data.to}ga ${formatNumber(data.amount)} so'm berdingiz`, 'success');
        openPeople();
      } catch (err) {
        if (!handleAuthError(err)) toast(err.message, 'warn');
        send.disabled = false;
      }
    };
    send.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    row.append(input, send);
    box2.append(row, chips);
    const back = el('button', 'link-btn');
    back.type = 'button';
    back.append(icon('users'), el('span', '', "Odamlar ro'yxatiga qaytish"));
    back.addEventListener('click', openPeople);
    body.append(box2, back);
    setTimeout(() => input.focus(), 0);
  }

  function renderMineSheet(body) {
    setHead('home', 'Mulklarim', `Yerlar: ${economy.plots.length} ta · +${fmtRate(economy.rate)} so'm / sek`);
    const list = el('div', 'car-list');
    economy.plots.forEach((p) => {
      const row = el('div', 'car-row');
      const swatch = el('span', 'car-row__swatch');
      swatch.style.setProperty('--car', p.kind ? buildingsById[p.kind].color : '#a8a29e');
      swatch.append(icon(p.kind ? KIND_ICONS[p.kind] : 'map-pin'));
      const info = el('div', 'car-row__info');
      info.append(el('strong', '', `${p.home ? 'Ota hovli' : plotTitle(p.plot)} — ${p.kind ? `${kindName(p.kind)} · ${p.level} qavat` : "bo'sh yer"}`),
        el('small', '', p.kind ? `+${fmtRate(p.income)} so'm / sek` : 'Hali hech narsa qurilmagan'));
      const open = el('button', 'btn btn--ghost');
      open.type = 'button';
      open.append(icon(p.kind ? 'arrow-up' : 'hammer'), el('span', '', p.kind ? 'Ochish' : 'Qurish'));
      open.addEventListener('click', () => openSheet({ kind: 'plot', id: p.plot }));
      const go = el('button', 'btn btn--ghost');
      go.type = 'button';
      go.title = "Yo'l ko'rsatish";
      go.append(icon('navigation'), el('span', '', "Yo'l"));
      go.addEventListener('click', () => {
        const gate = plotGate(world.plots[p.plot]);
        setGuide(gate.x, gate.y, p.home ? 'Ota hovli' : plotTitle(p.plot));
        closeSheet();
      });
      row.append(swatch, info, open, go);
      list.append(row);
    });
    if (!economy.plots.length) list.append(el('p', 'sheet-note', "Sizda hali yer yo'q."));
    body.append(list);
    body.append(el('p', 'sheet-note',
      `Yana yer olish uchun xaritadagi «Sotuvda» yozuvi bor yerga boring yoki ustiga bosing (${formatNumber(catalog.land_price)} so'm). `
      + `Uyni sotish uchun uni oching va narx qo'ying — boshqa o'yinchi sotib olsa, pul sizga tushadi. `
      + `Daromad o'yinda bo'lmasangiz ham yig'iladi (${offlineCap} soatgacha).`));
  }

  function renderSheet() {
    if (!sheetState) return;
    const body = $('sheet-body');
    sheetSig = sheetSignature();
    body.replaceChildren();
    if (sheetState.kind === 'plot') renderPlotSheet(body, sheetState.id);
    else if (sheetState.kind === 'quiz') renderQuizSheet(body, sheetState);
    else if (sheetState.kind === 'shop') renderShopSheet(body);
    else if (sheetState.kind === 'people') renderPeopleSheet(body, sheetState);
    else if (sheetState.kind === 'give') renderGiveSheet(body, sheetState);
    else if (sheetState.kind === 'poll') renderPollSheet(body, sheetState);
    else if (sheetState.kind === 'market') renderMarketSheet(body);
    else renderMineSheet(body);
  }

  $('btn-mine').addEventListener('click', () => openSheet({ kind: 'mine' }));
  $('btn-online').addEventListener('click', openPeople);
  $('btn-poll').addEventListener('click', openPoll);
  $('btn-market').addEventListener('click', () => openSheet({ kind: 'market' }));
  $('btn-shop').addEventListener('click', () => { openSheet({ kind: 'shop' }); refreshCars(); });
  $('btn-ride').addEventListener('click', toggleRide);
  $('btn-horn').addEventListener('click', honk);
  $('btn-yandex').addEventListener('click', toggleTaxi);
  $('prompt').addEventListener('click', interact);
  $('taxi-cancel').addEventListener('click', cancelCard);
  $('sheet-close').addEventListener('click', closeSheet);
  sheetBackdrop.addEventListener('click', closeSheet);

  function updateSoundButton() {
    const off = sound.isMuted();
    $('btn-sound').replaceChildren(icon(off ? 'volume-x' : 'volume'));
    $('btn-sound').setAttribute('aria-pressed', String(off));
    $('btn-sound').title = off ? 'Ovozni yoqish' : "Ovozni o'chirish";
  }
  $('btn-sound').addEventListener('click', () => {
    sound.unlock();
    sound.setMuted(!sound.isMuted());
    updateSoundButton();
  });

  // ---------------- Boshqaruv ----------------
  // Tugma -> harakat. Kirill klaviaturasida ham ishlaydi (Ц Ф Ы В).
  const CODE_ACTIONS = {
    KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down',
    KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
  };
  const CHAR_ACTIONS = { w: 'up', 'ц': 'up', s: 'down', 'ы': 'down', a: 'left', 'ф': 'left', d: 'right', 'в': 'right' };
  const keyChar = (e) => String(e.key || '').toLowerCase();
  const actionOf = (e) => CODE_ACTIONS[e.code] || CHAR_ACTIONS[keyChar(e)] || null;

  // Tugma qo'yib yuborilguncha (keyup) bosilgan hisoblanadi. Vaqt bo'yicha qo'yib yubormaymiz:
  // ba'zi kompyuterlarda bosib turilgan tugma takror signal bermaydi (yoki boshqa tugma bosilsa
  // to'xtaydi) — shunda personaj yurib turib to'xtab qolardi. Keyup yo'qolsa — fokus yo'qolganda,
  // sahifa yashirilganda va Ctrl/Cmd bosilganda hammasi qo'yib yuboriladi.
  function isHeld(action) {
    return held.has(action);
  }

  function releaseAll() {
    held.clear();
    Object.keys(touch).forEach((k) => { touch[k] = false; });
    document.querySelectorAll('.dpad__btn.is-down').forEach((b) => b.classList.remove('is-down'));
  }

  function jump() {
    if (!me || sheetState || me.seat) return;
    if (me.car) {
      toggleFly(); // Teslada — uchish/qo'nish
      return;
    }
    if (me.h > 0.5) return;
    me.vh = JUMP_SPEED;
  }

  window.addEventListener('pointerdown', () => sound.unlock(), true);
  window.addEventListener('keydown', (e) => {
    sound.unlock();
    if (e.key === 'Escape') {
      if (sheetState) closeSheet();
      else if (mini.classList.contains('is-big')) toggleMap(false);
      return;
    }
    if (sheetState || e.target.closest?.('input, textarea, select')) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      $('chat-input').focus();
      return;
    }
    if (e.code === 'KeyV' || keyChar(e) === 'v' || keyChar(e) === 'м') {
      e.preventDefault();
      if (!e.repeat) micToggle();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) {
      releaseAll(); // Ctrl+W kabi tezkor tugmalardan keyin keyup kelmasligi mumkin
      return;
    }
    const action = actionOf(e);
    if (action) {
      held.set(action, true);
      e.preventDefault();
      return;
    }
    const ch = keyChar(e);
    if (e.code === 'Space' || ch === ' ') {
      e.preventDefault(); // tugma fokusda bo'lsa ham bosilib ketmasin
      if (!e.repeat) jump();
    } else if (e.repeat) {
      // E, F, H, M bir marta ishlasin
    } else if (e.code === 'KeyE' || ch === 'e' || ch === 'у') {
      toggleRide();
    } else if (e.code === 'KeyF' || ch === 'f' || ch === 'а') {
      interact();
    } else if (e.code === 'KeyH' || ch === 'h' || ch === 'р') {
      honk();
    } else if (e.code === 'KeyM' || ch === 'm' || ch === 'ь') {
      toggleMap();
    }
  });
  window.addEventListener('keyup', (e) => {
    const action = actionOf(e);
    if (action) held.delete(action);
    else if (!e.code && !e.key) releaseAll(); // ba'zi qurilmalar tugma nomini bermaydi
    if (e.code === 'Space' && !e.target.closest?.('input, textarea, select')) e.preventDefault();
  });
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      releaseAll();
      if (mic.on) micOff();
      sound.pause();
    }
  });

  document.querySelectorAll('[data-dir]').forEach((btn) => {
    const dir = btn.dataset.dir;
    const on = (e) => { e.preventDefault(); touch[dir] = true; btn.classList.add('is-down'); };
    const off = () => { touch[dir] = false; btn.classList.remove('is-down'); };
    btn.addEventListener('pointerdown', on);
    ['pointerup', 'pointerleave', 'pointercancel', 'lostpointercapture'].forEach((t) => btn.addEventListener(t, off));
  });
  document.querySelectorAll('[data-jump]').forEach((btn) => {
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); jump(); });
  });
  // HUD tugmalari bosilgandan keyin fokusni o'yinga qaytaramiz (Probel tugmani qayta bosmasin)
  document.querySelectorAll('.hud-actions .action-btn, #prompt, #btn-sound, #btn-yandex, #btn-online, #btn-poll, #taxi-cancel').forEach((btn) => {
    btn.addEventListener('click', () => btn.blur());
  });

  // Sichqoncha / barmoq bilan tortish — kamerani aylantirish, bosish — yer/bino oynasi
  const canvas = $('world');
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, id: e.pointerId };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    cam.yaw -= (e.clientX - drag.x) * 0.006;
    cam.pitch = clamp(cam.pitch + (e.clientY - drag.y) * 0.004, 0.35, 1.35);
    drag.x = e.clientX;
    drag.y = e.clientY;
  });
  canvas.addEventListener('pointerup', (e) => {
    if (drag && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 6 && !sheetState) pickAt(e.clientX, e.clientY);
    drag = null;
  });
  canvas.addEventListener('pointercancel', () => { drag = null; });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    cam.dist = clamp(cam.dist * Math.exp(e.deltaY * 0.001), 200, 1600);
  }, { passive: false });

  window.addEventListener('resize', resize);


  // ---------------- Chat ----------------
  let chatSince = 0;
  let voiceSince = 0;
  const chatShown = new Set();

  function chatLine(m, extraClass = '') {
    if (m.id && chatShown.has(m.id)) return;
    if (m.id) chatShown.add(m.id);
    const log = $('chat-log');
    const line = el('div', `chat__line ${extraClass}`.trim());
    const who = el('strong', '', m.key === me.key ? 'Siz' : m.name);
    who.style.color = m.key === me.key ? '#93c5fd' : avatarColor(m.name);
    line.append(who, el('span', '', ` ${m.text}`));
    log.append(line);
    while (log.children.length > 40) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
    $('chat').classList.add('is-active');
    clearTimeout(chatLine.timer);
    chatLine.timer = setTimeout(() => $('chat').classList.remove('is-active'), 9000);
  }

  function addChat(list) {
    (list || []).forEach((m) => {
      chatLine(m);
      chatSince = Math.max(chatSince, m.id);
    });
  }

  $('chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text) {
      input.blur();
      return;
    }
    input.value = '';
    try {
      const data = await api('/api/game/chat', { method: 'POST', body: { text } });
      chatLine(data.message);
    } catch (err) {
      if (!handleAuthError(err)) toast(err.message, 'warn');
    }
  });
  $('chat-input').addEventListener('focus', () => { releaseAll(); $('chat').classList.add('is-open'); });
  $('chat-input').addEventListener('blur', () => $('chat').classList.remove('is-open'));
  $('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.target.blur();
    }
  });

  // ---------------- Mikrofon: bir bosishda yoqiladi, ovoz hammaga jonli eshitiladi ----------------
  // Bepul serverda doimiy ulanish yo'q, shuning uchun ovoz ~1 soniyalik bo'laklarda yuboriladi
  // va boshqalarda ketma-ket o'ynaydi (1–2 soniya kechikish). Jim payt yuborilmaydi.
  const CHUNK_MS = 1000;
  const SILENCE = 0.02;                 // shundan past ovoz — jimlik
  const mic = { on: false, stream: null, rec: null, analyser: null, peak: 0, mime: '', timer: null, meter: null };

  function micUi() {
    const btn = $('btn-mic');
    btn.classList.toggle('is-rec', mic.on);
    btn.setAttribute('aria-pressed', String(mic.on));
    btn.title = mic.on ? "Mikrofon yoniq — hamma eshitadi. O'chirish uchun bosing (V)" : 'Mikrofonni yoqish (V)';
  }

  async function micToggle() {
    if (mic.on) {
      micOff();
      toast("Mikrofon o'chdi");
      return;
    }
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      toast("Brauzeringiz mikrofonni qo'llamaydi", 'warn');
      return;
    }
    try {
      if (!mic.stream) mic.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      toast('Mikrofonga ruxsat berilmadi. Brauzerda mikrofonga ruxsat bering', 'warn');
      return;
    }
    mic.mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
    // Ovoz balandligini o'lchash (jim payt yubormaslik uchun)
    try {
      sound.unlock();
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      const src = ctx.createMediaStreamSource(mic.stream);
      mic.analyser = ctx.createAnalyser();
      mic.analyser.fftSize = 512;
      src.connect(mic.analyser);
      const buf = new Float32Array(mic.analyser.fftSize);
      mic.meter = setInterval(() => {
        mic.analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
        mic.peak = Math.max(mic.peak, Math.sqrt(sum / buf.length));
      }, 80);
    } catch {
      mic.analyser = null; // o'lchab bo'lmasa — hammasini yuboramiz
    }
    mic.on = true;
    micUi();
    toast('Mikrofon yoniq — gapiring, hamma eshitadi. O\'chirish — yana bosing', 'success');
    recordChunk();
  }

  function recordChunk() {
    if (!mic.on) return;
    const chunks = [];
    const rec = new MediaRecorder(mic.stream, mic.mime ? { mimeType: mic.mime } : undefined);
    mic.rec = rec;
    mic.peak = 0;
    rec.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
    rec.onstop = () => {
      const loud = !mic.analyser || mic.peak > SILENCE;
      recordChunk(); // keyingi bo'lak darhol boshlanadi
      if (loud && chunks.length) sendChunk(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
    };
    rec.start();
    mic.timer = setTimeout(() => { if (rec.state === 'recording') rec.stop(); }, CHUNK_MS);
  }

  async function sendChunk(blob) {
    const form = new FormData();
    form.append('audio', blob, 'ovoz.webm');
    try {
      await api('/api/game/voice', { method: 'POST', form });
    } catch (err) {
      if (handleAuthError(err)) return;
    }
  }

  function micOff() {
    mic.on = false;
    clearTimeout(mic.timer);
    clearInterval(mic.meter);
    if (mic.rec && mic.rec.state === 'recording') mic.rec.stop();
    mic.rec = null;
    if (mic.stream) {
      mic.stream.getTracks().forEach((t) => t.stop()); // brauzerdagi "mikrofon ishlayapti" belgisi o'chsin
      mic.stream = null;
    }
    micUi();
  }

  $('btn-mic').addEventListener('click', (e) => {
    e.preventDefault();
    micToggle();
    $('btn-mic').blur();
  });

  // Boshqalarning ovozi: har bir odamning bo'laklari o'z navbatida ketma-ket o'ynaydi
  const voiceQueues = new Map();   // key -> {list, playing, name}
  const speakingUntil = new Map(); // key -> {name, t}

  function addVoices(list) {
    (list || []).forEach((v) => {
      voiceSince = Math.max(voiceSince, v.id);
      let q = voiceQueues.get(v.key);
      if (!q) {
        q = { list: [], playing: false };
        voiceQueues.set(v.key, q);
      }
      q.list.push(v);
      speakingUntil.set(v.key, { name: v.name, t: performance.now() + 2500 });
      playQueue(q);
    });
    updateSpeaking();
  }

  async function playQueue(q) {
    if (q.playing || !q.list.length) return;
    q.playing = true;
    while (q.list.length) {
      const v = q.list.shift();
      if (q.list.length > 4) q.list.splice(0, q.list.length - 2); // juda orqada qolsak — yetib olamiz
      if (sound.isMuted()) continue;
      try {
        const res = await fetch(`/api/game/voice/${v.id}`, { credentials: 'same-origin' });
        if (!res.ok) continue;
        const url = URL.createObjectURL(await res.blob());
        const audio = new Audio(url);
        await new Promise((resolve) => {
          audio.onended = resolve;
          audio.onerror = resolve;
          audio.play().catch(resolve);
        });
        URL.revokeObjectURL(url);
      } catch { /* eskirgan bo'lak — o'tkazib yuboramiz */ }
    }
    q.playing = false;
  }

  // "🔊 Ali gapiryapti" — chat ustida
  function updateSpeaking() {
    const now = performance.now();
    const names = [];
    speakingUntil.forEach((v, key) => {
      if (v.t > now) names.push(v.name);
      else speakingUntil.delete(key);
    });
    const box = $('speaking');
    const text = names.length ? `🔊 ${names.join(', ')} gapiryapti` : '';
    if (box.textContent !== text) box.textContent = text;
    box.hidden = !names.length;
  }
  setInterval(updateSpeaking, 500);

  // ---------------- Xarita (kichik / katta) ----------------
  const mini = $('minimap');
  const mctx = mini.getContext('2d');
  let lastMini = 0;

  function toggleMap(force) {
    const big = force === undefined ? !mini.classList.contains('is-big') : force;
    mini.classList.toggle('is-big', big);
    mini.width = big ? 1200 : 480;
    mini.height = mini.width / 2;
    $('map-backdrop').hidden = !big;
    lastMini = 0;
    if (big) toast("Xaritada joyni bosing — u yerga yo'l ko'rsatiladi");
  }
  // Katta xaritada bosilgan joyga yo'l ko'rsatish
  mini.addEventListener('click', (e) => {
    if (!mini.classList.contains('is-big')) {
      toggleMap(true);
      return;
    }
    const r = mini.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * world.w;
    const y = ((e.clientY - r.top) / r.height) * world.h;
    setGuide(x, y, 'Belgilangan joy');
    toggleMap(false);
  });
  $('map-backdrop').addEventListener('click', () => toggleMap(false));

  function drawMinimap(now) {
    if (now - lastMini < 200) return;
    lastMini = now;
    const s = mini.width / world.w;
    const u = 1 / s; // bitta ekran nuqtasi dunyoda qancha
    mctx.setTransform(s, 0, 0, s, 0, 0);
    mctx.fillStyle = '#5c9442';
    mctx.fillRect(0, 0, world.w, world.h);
    mctx.fillStyle = '#3b404c';
    world.h_roads.forEach((y) => mctx.fillRect(0, y, world.w, world.road));
    world.v_roads.forEach((x) => mctx.fillRect(x, 0, world.road, world.h));
    mctx.fillStyle = '#3b82f6';
    mctx.fillRect(world.pond.x, world.pond.y, world.pond.w, world.pond.h);
    const f = world.fountain;
    mctx.fillStyle = '#d6d3d1';
    mctx.beginPath();
    mctx.arc(f.x + f.w / 2, f.y + f.h / 2, 110, 0, Math.PI * 2);
    mctx.fill();
    world.plots.forEach((plot) => {
      const r = plotsById.get(plot.id);
      if (!r) {
        mctx.strokeStyle = 'rgba(255,255,255,.55)';
        mctx.lineWidth = 10;
        mctx.strokeRect(plot.x + 10, plot.y + 10, plot.w - 20, plot.h - 20);
        return;
      }
      mctx.fillStyle = r.owner === me.key ? '#60a5fa' : (r.level ? buildingsById[r.kind].color : '#b99561');
      mctx.fillRect(plot.x, plot.y, plot.w, plot.h);
      if (r.price) {
        // Sotuvdagi uy — sariq ramka
        mctx.strokeStyle = '#facc15';
        mctx.lineWidth = 3 * u;
        mctx.strokeRect(plot.x, plot.y, plot.w, plot.h);
      }
    });
    mctx.fillStyle = '#1e3a8a';
    mctx.fillRect(world.shop.x, world.shop.y, world.shop.w, world.shop.h);
    if (showPassengers()) {
      mctx.fillStyle = '#facc15';
      passengers.forEach((p) => { mctx.beginPath(); mctx.arc(p.x, p.y, 5 * u, 0, Math.PI * 2); mctx.fill(); });
    }
    const mark = (x, y, color) => {
      mctx.strokeStyle = color;
      mctx.lineWidth = 3 * u;
      mctx.beginPath();
      mctx.arc(x, y, 9 * u, 0, Math.PI * 2);
      mctx.stroke();
      mctx.fillStyle = color;
      mctx.beginPath();
      mctx.arc(x, y, 4 * u, 0, Math.PI * 2);
      mctx.fill();
    };
    if (guide) mark(guide.x, guide.y, '#2563eb');
    if (ride) mark(ride.tx, ride.ty, '#16a34a');
    mctx.fillStyle = '#f472b6';
    others.forEach((p) => { mctx.beginPath(); mctx.arc(p.x, p.y, 5 * u, 0, Math.PI * 2); mctx.fill(); });
    // Men va kamera yo'nalishi
    mctx.fillStyle = '#ffffff';
    mctx.strokeStyle = '#1d4ed8';
    mctx.lineWidth = 2.5 * u;
    mctx.beginPath();
    mctx.arc(me.x, me.y, 6 * u, 0, Math.PI * 2);
    mctx.fill();
    mctx.stroke();
    mctx.beginPath();
    mctx.moveTo(me.x, me.y);
    mctx.lineTo(me.x - Math.sin(cam.yaw) * 22 * u, me.y - Math.cos(cam.yaw) * 22 * u);
    mctx.strokeStyle = '#ffffff';
    mctx.lineWidth = 2 * u;
    mctx.stroke();
  }

  // ---------------- HUD ----------------
  let shownMoney = -1;
  function updateHud() {
    const value = Math.floor(money());
    if (value !== shownMoney) {
      shownMoney = value;
      $('money').textContent = formatNumber(value);
    }
    const rateText = `+${fmtRate(economy.rate)} so'm / sek`;
    if ($('rate').textContent !== rateText) $('rate').textContent = rateText;
  }

  // ---------------- Server bilan almashinuv ----------------
  function applySync(data, fresh) {
    if (data.correct) {
      me.x = data.correct.x;
      me.y = data.correct.y;
    }
    // So'rov ketgandan keyin xarid/taksi bo'lgan bo'lsa — bu javob eskirgan, faqat do'stlarni olamiz
    if (fresh) {
      if (data.plots) setPlots(data.plots);
      setEconomy(data.economy);
      setPassengers(data.passengers);
      setRide(data.ride);
      if (data.seat) me.seat = data.seat;
      else if (me.seat) {
        // Haydovchi mashinadan tushdi yoki o'yindan chiqdi
        toast(`${me.seat.name} mashinadan tushdi — siz ham tushdingiz`);
        me.seat = null;
        updateRideButton();
      }
    }
    setPlayers(data.players);
    // Kimdir pul bergan bo'lsa — xabar
    addChat(data.chat);
    addVoices(data.voices);
    (data.gifts || []).forEach((g) => {
      sound.cash();
      toast(`${g.from} sizga ${formatNumber(g.amount)} so'm berdi!`, 'success');
    });
  }

  async function syncLoop() {
    for (;;) {
      const started = performance.now();
      const version = localVersion;
      try {
        const data = await api('/api/game/sync', {
          method: 'POST',
          body: {
            x: Math.round(me.x), y: Math.round(me.y), h: Math.round(me.h), dir: me.dir, car: me.car,
            chat_since: chatSince, voice_since: voiceSince,
          },
        });
        applySync(data, version === localVersion);
        $('conn').hidden = true;
      } catch (err) {
        if (handleAuthError(err)) return;
        $('conn').hidden = false;
      }
      const wait = Math.max(30, SYNC_MS - (performance.now() - started));
      await new Promise((resolve) => { setTimeout(resolve, wait); });
    }
  }

  // ---------------- Asosiy sikl ----------------
  let last = performance.now();
  let lastSound = 0;
  function loop(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    step(dt);
    animatePassengers(dt, now);
    for (let i = floaters.length - 1; i >= 0; i -= 1) {
      const f = floaters[i];
      f.t += dt;
      f.sprite.position.y += dt * 40;
      f.sprite.material.opacity = Math.max(0, 1 - f.t / 1.6);
      if (f.t > 1.7) {
        scene.remove(f.sprite);
        f.sprite.material.map.dispose();
        f.sprite.material.dispose();
        floaters.splice(i, 1);
      }
    }
    showroom.forEach((sh) => {
      if (sh.spin) sh.model.rotation.y += dt * sh.spin;
      if (sh.hover) {
        sh.model.position.y = sh.y + Math.sin(now / 400) * 4;
        animateCar(sh.model, dt, 0, 1);
      }
    });
    [rideView, guideView].forEach((v) => { if (v) v.userData.ring.material.opacity = 0.6 + Math.sin(now / 200) * 0.3; });
    if (fountainSpray) fountainSpray.scale.y = 1 + Math.sin(now / 180) * 0.12;
    updateCamera(dt);
    checkNear(now);
    updateArrow();
    renderer.render(scene, camera);
    drawMinimap(now);
    updateHud();
    updateTaxiCard();
    if (now - lastSound > 80) {
      lastSound = now;
      sound.engine(engineKey(me.car), me.throttle, me.h > 5);
    }
    requestAnimationFrame(loop);
  }

  async function start() {
    try {
      const s = await api('/api/game/state');
      world = s.world;
      catalog = s.catalog;
      buildingsById = Object.fromEntries(catalog.buildings.map((b) => [b.id, b]));
      carsById = Object.fromEntries(catalog.cars.map((car) => [car.id, car]));
      walkSpeed = s.walk_speed;
      offlineCap = s.offline_cap_hours;
      me = {
        ...s.me, x: s.me.spawn.x, y: s.me.spawn.y, h: 0, vh: 0, dir: -Math.PI / 2, car: null,
        moving: false, fly: false, throttle: 0, taxi: false, seat: null,
      };
      me.rig = makeRig(me.name, me.avatar, true);

      buildGround();
      buildTrees();
      buildPark();
      buildShop();
      setPlots(s.plots);
      setEconomy(s.economy);
      // Kamera yo'l tomonda tursin: baland bino o'yinchini to'sib qo'ymasin
      const homePlot = economy.home != null ? world.plots[economy.home] : null;
      if (homePlot && homePlot.gate === 'top') {
        cam.yaw = Math.PI;
        me.dir = Math.PI / 2;
      }
      setPassengers(s.passengers);
      setRide(s.ride);
      setPlayers(s.players);
      addChat(s.chat);
      voiceSince = s.voice_last || 0;
      updateSoundButton();
      resize();

      $('loading').hidden = true;
      requestAnimationFrame((t) => { last = t; loop(t); });
      syncLoop();
      if (!economy.cars.length) {
        setGuide(world.shop.door.x, world.shop.door.y, 'Avtosalon');
        toast("Xush kelibsiz! Avval Avtosalondan mashina oling (ko'k nur) — taksida pul ishlaysiz.");
      } else if (!economy.plots.some((p) => p.kind)) {
        toast("Xush kelibsiz! Ota hovlingizga bino quring (F) — har soniyada pul keladi.");
      } else {
        toast("Xush kelibsiz! E — mashinaga o'tiring va sariq halqadagi yo'lovchilarni tashing.");
      }
      setTimeout(() => { $('hint').classList.add('is-faded'); }, 12000);
    } catch (err) {
      if (handleAuthError(err)) return;
      showFatal(`Yuklab bo'lmadi: ${err.message}`);
    }
  }

  start();
})();
