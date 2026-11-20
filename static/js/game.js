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
  // Bino nomi: variant bo'lsa — uning nomi (Gadjet do'kon), bo'lmasa — tur nomi (Magazin)
  function bName(kind, variant) {
    const b = buildingsById[kind];
    if (!b) return "Bo'sh yer";
    const v = (b.variants || []).find((x) => x.id === variant);
    return v ? v.name : b.name;
  }
  const myPlotIds = () => (economy ? economy.plots.map((p) => p.plot) : []);
  const plotGate = (p) => ({ x: p.x + p.w / 2, y: p.gate === 'bottom' ? p.y + p.h + 40 : p.y - 40 });
  const carInfo = () => (me && me.car ? carsById[me.car] : null);

  // ---------------- Ovozlar (WebAudio — fayl kerak emas) ----------------
  const ENGINE = {
    bmw: { type: 'sawtooth', base: 52, range: 75, cutoff: 520, vol: 0.16 },
    mercedes: { type: 'sawtooth', base: 40, range: 55, cutoff: 420, vol: 0.18 },
    lambo: { type: 'sawtooth', base: 68, range: 150, cutoff: 950, vol: 0.17 },
    tesla: { type: 'sine', base: 170, range: 300, cutoff: 2400, vol: 0.07 },
    plane: { type: 'sawtooth', base: 88, range: 170, cutoff: 1300, vol: 0.12 },
  };
  // Ovoz bilan qo'shilgan mashinalar — ko'rinishiga mos dvigatel ovozi
  function engineKey(carId) {
    if (!carId || ENGINE[carId]) return carId;
    const style = carsById[carId] ? carsById[carId].style : 'sedan';
    return { sedan: 'bmw', suv: 'mercedes', super: 'lambo', fly: 'tesla', van: 'mercedes', plane: 'plane', bus: 'mercedes', bike: 'none', skate: 'none' }[style] || 'bmw';
  }
  const sound = (() => {
    let ctx = null;
    let master = null;
    let engine = null;
    let engineCar = null;
    let rainNode = null;
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
      horn(carId, kind) {
        unlock();
        if (kind === 'melody') {
          [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.12, 0.16, { type: 'triangle', vol: 0.16 }));
          return;
        }
        if (kind === 'truck') {
          tone(160, 0, 0.9, { type: 'sawtooth', vol: 0.12 });
          tone(200, 0, 0.9, { type: 'square', vol: 0.08 });
          return;
        }
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
      // Yomg'ir shovqini (oq shovqin, past chastotalar) — level 0..1
      rain(level) {
        if (!ctx) return;
        if (!rainNode) {
          if (level <= 0.01) return;
          const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
          const d = buf.getChannelData(0);
          for (let i = 0; i < d.length; i += 1) d[i] = Math.random() * 2 - 1;
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.loop = true;
          const f = ctx.createBiquadFilter();
          f.type = 'lowpass';
          f.frequency.value = 1600;
          const g = ctx.createGain();
          g.gain.value = 0;
          src.connect(f);
          f.connect(g);
          g.connect(master);
          src.start();
          rainNode = { src, f, g };
        }
        rainNode.g.gain.setTargetAtTime(level * 0.07, ctx.currentTime, 0.6);
      },
      thunder() {
        tone(60, 0, 1.6, { type: 'sawtooth', vol: 0.14, slide: 0.45 });
        tone(42, 0.15, 1.8, { type: 'square', vol: 0.08, slide: 0.6 });
      },
      screech() { tone(1400 + Math.random() * 300, 0, 0.18, { type: 'sawtooth', vol: 0.035, slide: 0.85 }); },
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

  const hemi = new THREE.HemisphereLight('#e0f2ff', '#4d7c3a', 1.15);
  scene.add(hemi);
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
  // Shapka: kepka, shlyapa, do'ppi (beanie) yoki toj
  function makeHat(kind) {
    const g = new THREE.Group();
    if (kind === 'cap') {
      g.add(mesh(new THREE.SphereGeometry(9.4, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2.3), mat('#dc2626'), 0, 57.5, 0));
      g.add(box(11, 1.4, 8, mat('#dc2626'), 0, 59.5, 8));
    } else if (kind === 'hat') {
      g.add(cyl(15, 15, 1.4, mat('#78350f'), 0, 61, 0, 24), cyl(8.6, 9.2, 10, mat('#78350f'), 0, 66.5, 0, 20));
      g.add(cyl(9.3, 9.3, 2.4, mat('#111827'), 0, 63, 0, 20));
    } else if (kind === 'beanie') {
      const top = mesh(new THREE.SphereGeometry(9.7, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), mat('#2563eb'), 0, 57, 0);
      top.scale.y = 1.25;
      g.add(top, mesh(new THREE.SphereGeometry(3, 10, 8), mat('#f8fafc'), 0, 69.5, 0));
    } else if (kind === 'crown') {
      const gold = mat('#facc15', { metalness: 0.8, roughness: 0.25 });
      g.add(cyl(8.6, 8.6, 5, gold, 0, 64, 0, 20));
      for (let i = 0; i < 6; i += 1) {
        const a = (i / 6) * Math.PI * 2;
        const spike = mesh(new THREE.ConeGeometry(2, 5, 6), gold, Math.sin(a) * 8, 69, Math.cos(a) * 8);
        g.add(spike, mesh(new THREE.SphereGeometry(1.1, 8, 6), glow(i % 2 ? '#ef4444' : '#22d3ee', 0.6), Math.sin(a) * 8.7, 64, Math.cos(a) * 8.7, false));
      }
    }
    return g;
  }

  function makeHuman(name, shirtColor, looks = null) {
    const L = looks || {};
    const g = new THREE.Group();
    const skin = mat(L.skin || '#f0c08a');
    const shirt = mat(L.shirt || shirtColor || avatarColor(name));
    const pants = mat(L.pants || '#1f2937');
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
    if (L.hat !== 'beanie' && L.hat !== 'cap') {
      g.add(mesh(new THREE.SphereGeometry(9, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2.1), mat(L.hair || '#2b2b2b'), 0, 56.5, -0.6));
    }
    if (L.hat) g.add(makeHat(L.hat));
    const eye = new THREE.SphereGeometry(1.3, 8, 6);
    g.add(mesh(eye, mat('#111111'), -3, 56, 7.6, false), mesh(eye, mat('#111111'), 3, 56, 7.6, false));
    g.userData = { legL, legR, armL, armR };
    return g;
  }

  function animateHuman(h, walk, moving, airborne = false, wave = null, sit = false, dance = null) {
    const { legL, legR, armL, armR } = h.userData;
    armR.rotation.z = 0;
    armL.rotation.z = 0;
    if (dance !== null) {
      // Raqs: qo'llar tepada silkinadi, oyoqlar navbat bilan, tana chayqaladi
      const t = dance / 170;
      armL.rotation.x = -2.5 + Math.sin(t) * 0.5;
      armR.rotation.x = -2.5 - Math.sin(t) * 0.5;
      armL.rotation.z = -0.3;
      armR.rotation.z = 0.3;
      legL.rotation.x = Math.max(0, Math.sin(t)) * 0.6;
      legR.rotation.x = Math.max(0, -Math.sin(t)) * 0.6;
      h.position.y = Math.abs(Math.sin(t)) * 4;
      h.rotation.y += Math.sin(t / 2) * 0.7;
      return;
    }
    if (sit) {
      // Skameykada o'tiribdi: oyoqlar oldinga, tana pastroqda
      legL.rotation.x = -1.45;
      legR.rotation.x = -1.45;
      armL.rotation.x = -0.5;
      armR.rotation.x = -0.5;
      h.position.y = -10;
      return;
    }
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

  // Damas: kichkina quti-mikroavtobus
  function carVan(color) {
    const g = new THREE.Group();
    const paint = mat(color, { roughness: 0.4, metalness: 0.3 });
    g.add(box(30, 24, 58, paint, 0, 18, 0));
    g.add(box(30.6, 8, 40, DARK_GLASS(), 0, 24, -6));
    const front = box(28, 10, 2, DARK_GLASS(), 0, 23, 28.6);
    front.rotation.x = -0.25;
    g.add(front, box(31, 3, 59, mat('#2563eb'), 0, 13, 0)); // yon chiziq
    [-1, 1].forEach((s2) => {
      g.add(box(6, 3, 1, glow('#e0f2fe', 0.9), s2 * 10, 12, 29.2));
      g.add(box(5, 5, 1, glow('#ef4444', 0.6), s2 * 11, 16, -29.2));
    });
    g.add(box(20, 2, 30, mat('#334155'), 0, 31, -4)); // tom bagaji
    g.userData = { ...addWheels(g, [[-14, 19], [14, 19], [-14, -19], [14, -19]], 5.5, 4), roof: 32 };
    return g;
  }

  // Samolyot: uchganda g'ildiraklar yig'iladi, parrak aylanadi
  function carPlane(color) {
    const g = new THREE.Group();
    const paint = mat(color, { roughness: 0.3, metalness: 0.4 });
    const stripe = mat('#dc2626', { roughness: 0.4 });
    const body = cyl(8, 6, 76, paint, 0, 16, -2, 18);
    body.rotation.x = Math.PI / 2;
    const nose = mesh(new THREE.ConeGeometry(8, 14, 18), paint, 0, 16, 43);
    nose.rotation.x = Math.PI / 2;
    const tailCone = mesh(new THREE.ConeGeometry(6, 16, 16), paint, 0, 17, -47);
    tailCone.rotation.x = -Math.PI / 2;
    g.add(body, nose, tailCone);
    g.add(box(118, 2, 18, paint, 0, 15, 4), box(118.5, 2.2, 3, stripe, 0, 15, -4)); // qanotlar
    g.add(box(40, 1.5, 10, paint, 0, 19, -46), box(1.6, 18, 12, stripe, 0, 27, -47)); // dum
    const glass = mesh(new THREE.SphereGeometry(6, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), DARK_GLASS(), 0, 22, 18);
    glass.scale.z = 1.8;
    g.add(glass);
    [-1, 1].forEach((s2) => {
      g.add(box(4, 1.2, 1, glow('#22c55e', 1), s2 * 59, 15, 4)); // qanot uchidagi chiroqlar
      g.add(box(1, 12, 1, glow('#ef4444', 0.8), 0, 27, -53));
    });
    const prop = new THREE.Group();
    prop.position.set(0, 16, 51);
    prop.add(box(3, 34, 1.2, mat('#111827')), box(34, 3, 1.2, mat('#111827')), cyl(2.5, 2.5, 3, CHROME(), 0, 0, 0, 10));
    g.add(prop);
    const set = addWheels(g, [[-12, 12], [12, 12], [0, -36]], 4.5, 3);
    const under = new THREE.Mesh(new THREE.CircleGeometry(1, 8), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 }));
    under.visible = false;
    g.add(under);
    g.userData = { ...set, roof: 30, flies: true, wings: [], under, ringMat: new THREE.MeshBasicMaterial(), fly: 0, prop };
    return g;
  }

  // Shahar avtobusi
  function carBus(color) {
    const g = new THREE.Group();
    const paint = mat(color, { roughness: 0.4, metalness: 0.3 });
    g.add(box(34, 32, 100, paint, 0, 23, 0));
    g.add(box(34.6, 11, 84, DARK_GLASS(), 0, 30, -4));
    g.add(box(30, 16, 1, DARK_GLASS(), 0, 29, 50.3));
    g.add(box(34.8, 3, 100.4, mat('#2563eb'), 0, 14, 0));
    const sign = signPlane('AVTOBUS', 24, 5, '#111827', '#f97316');
    sign.position.set(0, 35, 50.6);
    g.add(sign);
    [-1, 1].forEach((s2) => {
      g.add(box(6, 3, 1, glow('#e0f2fe', 0.9), s2 * 12, 12, 50.4));
      g.add(box(5, 5, 1, glow('#ef4444', 0.6), s2 * 13, 14, -50.4));
    });
    g.userData = { ...addWheels(g, [[-16, 34], [16, 34], [-16, -32], [16, -32]], 7, 5), roof: 40 };
    return g;
  }

  const CAR_BUILDERS = { bmw: carBMW, mercedes: carG, lambo: carLambo, tesla: carTesla, damas: carVan, plane: carPlane, bus: carBus };
  // tune — garajdagi o'zgarishlar: rang va neon chiroq
  function makeCar(id, tune = null) {
    const info = carsById[id] || catalog.cars[0];
    const byStyle = { sedan: carBMW, suv: carG, super: carLambo, fly: carTesla, van: carVan, plane: carPlane, bus: carBus };
    const car = (CAR_BUILDERS[info.id] || byStyle[info.style] || carBMW)((tune && tune.color) || info.color);
    if (tune && tune.neon) {
      const neon = new THREE.Mesh(new THREE.PlaneGeometry(46, info.style === 'bus' ? 112 : 82), new THREE.MeshBasicMaterial({
        color: tune.neon, transparent: true, opacity: 0.65, depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      neon.rotation.x = -Math.PI / 2;
      neon.position.y = 1.4;
      car.add(neon);
    }
    return car;
  }

  // G'ildiraklar aylanadi; Tesla uchganda qanot va nurlar chiqadi
  function animateCar(car, dt, speed, fly) {
    const u = car.userData;
    if (u.prop) u.prop.rotation.z += dt * (6 + speed * 0.12 + fly * 30); // samolyot parragi
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
      name, looksKey: '{}',
    };
    setRigLabel(rig, isMe ? 'Siz' : name, avatar);
    scene.add(root);
    return rig;
  }

  // Ko'rinish (soch, kiyim, shapka) o'zgarsa — odamchani qaytadan yasaymiz
  function setRigLooks(rig, looks) {
    const key = JSON.stringify(looks || {});
    if (key === rig.looksKey) return;
    rig.looksKey = key;
    const old = rig.human;
    rig.human = makeHuman(rig.name, null, looks);
    rig.human.visible = old.visible;
    rig.human.rotation.y = old.rotation.y;
    rig.root.remove(old);
    disposeTree(old);
    rig.root.add(rig.human);
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
    const carKey = carId ? `${carId}|${p.tune ? `${p.tune.color || ''}|${p.tune.neon || ''}` : ''}` : null;
    if (carKey !== rig.carKey) {
      if (rig.car) {
        rig.holder.remove(rig.car);
        disposeTree(rig.car);
        rig.car = null;
        rig.taxiSign = null;
      }
      if (carId) {
        rig.car = makeCar(carId, p.tune);
        rig.holder.add(rig.car);
      }
      rig.dirtMesh = null;
      rig.carId = carId;
      rig.carKey = carKey;
    }
    const rider = isRider(car);
    rig.human.visible = !carId || rider;
    rig.holder.rotation.y = rig.heading;
    rig.human.rotation.y = rig.heading;
    if (carId) {
      const u = rig.car.userData;
      townCarKit(rig, p);
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
      if (rider) {
        // Velosiped / skeytbord: odam ustida turadi
        if (moving) rig.walk += dt * 9;
        const { legL, legR, armL, armR } = rig.human.userData;
        const bike = car.style === 'bike';
        const sw = bike ? Math.sin(rig.walk) * 0.5 : 0;
        legL.rotation.x = bike ? -0.9 + sw : -0.15;
        legR.rotation.x = bike ? -0.9 - sw : 0.25;
        armL.rotation.x = bike ? -0.9 : -0.3;
        armR.rotation.x = bike ? -0.9 : 0.3;
        armL.rotation.z = bike ? 0 : -0.6;
        armR.rotation.z = bike ? 0 : 0.6;
        rig.human.position.y = bike ? 9 : 5;
        if (car.style === 'horse') { // otda: oyoqlar ikki yonda
          legL.rotation.x = -0.4;
          legR.rotation.x = -0.4;
          legL.rotation.z = 0.5;
          legR.rotation.z = -0.5;
          armL.rotation.x = -0.9;
          armR.rotation.x = -0.9;
          armL.rotation.z = 0;
          armR.rotation.z = 0;
          rig.human.position.y = 24;
          const hl = rig.car.userData.legs;
          if (hl) hl.forEach((l, i) => { l.rotation.x = moving ? Math.sin(rig.walk + (i % 2) * Math.PI) * 0.6 : 0; });
        } else if (car.style === 'carpet') { // gilamda chordana qurib o'tiradi
          legL.rotation.x = -1.45;
          legR.rotation.x = -1.45;
          armL.rotation.x = -0.4;
          armR.rotation.x = -0.4;
          armL.rotation.z = 0;
          armR.rotation.z = 0;
          rig.human.position.y = -6;
        }
        rig.label.position.y = 96;
      } else applyDirt(rig, rig.isMe ? dirtOf(me.car) : (p.dirt || 0));
    } else {
      rig.label.position.y = 82;
      if (moving) rig.walk += dt * 11;
      animateHuman(rig.human, rig.walk, moving, height > 1.5, p.act === 'wave' && !moving ? performance.now() / 150 : null, p.pose === 'sit' && !moving,
        (p.pose === 'dance' || p.act === 'dance') && !moving ? performance.now() : null);
      if (p.act) townAct(rig, p, moving);
      else rig.human.rotation.x = 0;
      if (inPool(p.x, p.y) && height < 2) {
        // Suzish: suvga botib turadi, qo'llar eshkak eshadi
        rig.human.position.y = -18;
        rig.human.userData.armL.rotation.x = -2.6 + Math.sin(rig.walk) * 1.2;
        rig.human.userData.armR.rotation.x = -2.6 - Math.sin(rig.walk) * 1.2;
      }
    }
    const emote = rig.isMe ? (me.emote && performance.now() < me.emote.until ? me.emote.e : null) : p.emote;
    setEmote(rig, emote);
    if (rig.emoteSprite) rig.emoteSprite.position.y = rig.label.position.y + 34;
    updateBoat(rig, p);
    updatePet(rig, p, dt);
  }

  function removeRig(rig) {
    dropPet(rig);
    scene.remove(rig.root);
    disposeTree(rig.root);
  }

  // ---------------- Binolar ----------------
  // 1-qavat — turiga xos (hovli uy, do'kon, kafe, ofis vestibyuli), qolgan qavatlar — ustidagi minora
  const GROUND_H = { uy: 32, magazin: 40, kafe: 40, ofis: 26 };
  const TOWER = { uy: [110, 70], magazin: [108, 68], kafe: [96, 62], ofis: [100, 80] };
  // Har bir variantning ko'rinishi: devor, tom, minora (qavatlar) ranglari, peshtaxta yozuvi
  const STYLES = {
    uy: {
      hovli: { wall: '#d97757', roof: '#9f2d20', base: '#b45309', tower: '#e8b48f', frame: '#fff7ed', glass: '#8fd3ff' },
      kottej: { wall: '#a16207', roof: '#3f2a14', base: '#854d0e', tower: '#c08a4f', frame: '#fef3c7', glass: '#a5f3fc' },
      villa: { wall: '#f8fafc', roof: '#0ea5e9', base: '#e2e8f0', tower: '#f1f5f9', frame: '#cbd5e1', glass: '#7dd3fc' },
      zamonaviy: { wall: '#6b7280', roof: '#1f2937', base: '#4b5563', tower: '#9ca3af', frame: '#111827', glass: '#bae6fd' },
    },
    magazin: {
      gadjet: { wall: '#1e293b', sign: 'GADJET', signBg: '#2563eb', signFg: '#ffffff', awnA: '#2563eb', awnB: '#0f172a', tower: '#334155', frame: '#0f172a', glass: '#60a5fa' },
      oziq: { wall: '#f3f4f6', sign: 'OZIQ-OVQAT', signBg: '#15803d', signFg: '#ffffff', awnA: '#16a34a', awnB: '#f0fdf4', tower: '#e5e7eb', frame: '#94a3b8', glass: '#93c5fd' },
      kiyim: { wall: '#fdf2f8', sign: 'KIYIM', signBg: '#db2777', signFg: '#ffffff', awnA: '#db2777', awnB: '#fdf2f8', tower: '#fce7f3', frame: '#be185d', glass: '#f9a8d4' },
      gul: { wall: '#faf5ff', sign: 'GULLAR', signBg: '#7c3aed', signFg: '#ffffff', awnA: '#7c3aed', awnB: '#f5f3ff', tower: '#ede9fe', frame: '#6d28d9', glass: '#c4b5fd', flowers: true },
    },
    kafe: {
      kofe: { wall: '#fde68a', sign: 'KOFE', signBg: '#7c2d12', signFg: '#fde68a', awnA: '#dc2626', awnB: '#fff7ed', tower: '#fde68a', frame: '#92400e', glass: '#7dd3fc', umbrella: '#dc2626' },
      pizza: { wall: '#fef2f2', sign: 'PIZZA', signBg: '#b91c1c', signFg: '#ffffff', awnA: '#16a34a', awnB: '#ffffff', tower: '#fecaca', frame: '#991b1b', glass: '#fca5a5', umbrella: '#16a34a' },
      burger: { wall: '#fff7ed', sign: 'BURGER', signBg: '#ea580c', signFg: '#ffffff', awnA: '#facc15', awnB: '#ea580c', tower: '#fed7aa', frame: '#c2410c', glass: '#fdba74', umbrella: '#facc15' },
      choyxona: { wall: '#ecfeff', sign: 'CHOYXONA', signBg: '#0f766e', signFg: '#ffffff', awnA: '#0f766e', awnB: '#ffffff', tower: '#ccfbf1', frame: '#115e59', glass: '#5eead4', umbrella: '#0f766e' },
    },
    ofis: {
      it: { lobby: '#334155', sign: 'IT PARK', bigSign: 'BIZNES MARKAZ', signBg: '#0f172a', signFg: '#93c5fd', tower: '#1e3a5f', frame: '#0f172a', glass: '#8fd3ff', curtain: true },
      bank: { lobby: '#422006', sign: 'BANK', signBg: '#1e3a8a', signFg: '#facc15', tower: '#1e3a8a', frame: '#0f172a', glass: '#fde68a', curtain: true },
      klinika: { lobby: '#e2e8f0', sign: 'KLINIKA', signBg: '#ffffff', signFg: '#dc2626', tower: '#f1f5f9', frame: '#cbd5e1', glass: '#bae6fd', curtain: true, cross: true },
      markaz: { lobby: '#14532d', sign: "O'QUV MARKAZI", signBg: '#166534', signFg: '#ffffff', tower: '#14532d', frame: '#052e16', glass: '#bbf7d0', curtain: true },
    },
  };
  function styleOf(kind, variant) {
    const set = STYLES[kind] || STYLES.uy;
    return set[variant] || set[Object.keys(set)[0]];
  }

  // Bino balandligi (uchadigan mashina undan baland uchishi kerak)
  function buildingTop(kind, level) {
    if (!kind || level < 1) return 0;
    if (kind === 'ofis') return GROUND_H.ofis + level * FLOOR_H + 30;
    return GROUND_H[kind] + 4 + (level - 1) * FLOOR_H + 40;
  }

  const windowTextures = new Map();
  function windowTexture(st) {
    const key = `${st.tower}|${st.frame}|${st.glass}|${st.curtain ? 1 : 0}`;
    if (windowTextures.has(key)) return windowTextures.get(key);
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const x = c.getContext('2d');
    x.fillStyle = st.tower;
    x.fillRect(0, 0, 64, 64);
    if (st.curtain) {
      x.fillStyle = st.glass;
      x.fillRect(4, 6, 56, 48);
      x.fillStyle = 'rgba(255,255,255,.35)';
      x.fillRect(6, 8, 14, 44);
    } else {
      x.fillStyle = st.frame;
      x.fillRect(14, 12, 36, 38);
      x.fillStyle = st.glass;
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
    windowTextures.set(key, tex);
    return tex;
  }

  // Kechasi derazalar yonadi: deraza joyi och, devor qora (emissiveMap)
  const litMaterials = [];
  let nightGlow = 0;
  const windowLights = new Map();
  function windowLightTexture(st) {
    const key = `${st.curtain ? 1 : 0}`;
    if (windowLights.has(key)) return windowLights.get(key);
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const x = c.getContext('2d');
    x.fillStyle = '#000000';
    x.fillRect(0, 0, 64, 64);
    x.fillStyle = '#ffffff';
    if (st.curtain) x.fillRect(4, 6, 56, 48);
    else x.fillRect(17, 15, 30, 32);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    windowLights.set(key, tex);
    return tex;
  }

  const towerMats = new Map();
  function towerMaterial(st, cols, rows) {
    const key = `${st.tower}|${st.frame}|${st.glass}|${st.curtain ? 1 : 0}|${cols}|${rows}`;
    if (!towerMats.has(key)) {
      const tex = windowTexture(st).clone();
      tex.repeat.set(cols, rows);
      tex.needsUpdate = true;
      const lit = windowLightTexture(st).clone();
      lit.repeat.set(cols, rows);
      lit.needsUpdate = true;
      const m = new THREE.MeshStandardMaterial({
        map: tex, roughness: st.curtain ? 0.25 : 0.8, metalness: st.curtain ? 0.3 : 0,
        emissive: '#ffd58a', emissiveMap: lit, emissiveIntensity: nightGlow,
      });
      litMaterials.push(m);
      towerMats.set(key, m);
    }
    return towerMats.get(key);
  }

  // Qavatlar minorasi: bitta quti, har qavatda deraza qatori
  function tower(st, w, d, floors, y0) {
    const h = floors * FLOOR_H;
    const front = towerMaterial(st, Math.max(2, Math.round(w / 18)), floors);
    const side = towerMaterial(st, Math.max(2, Math.round(d / 18)), floors);
    const top = mat(st.tower);
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
  function roofTop(g, kind, level, w, d, y, st = {}) {
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
    if (kind === 'magazin' && level >= 20) roofSign(st.sign || 'MAGAZIN', st.signBg || '#15803d', st.signFg || '#ffffff');
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

  function buildHouse(level, st) {
    const g = new THREE.Group();
    if (level === 1) {
      // Bir qavatli uy
      const s = { w: 120, h: 44, d: 76 };
      g.add(box(s.w, s.h, s.d, mat(st.wall), 0, s.h / 2, 0));
      const roof = gableRoof(s.w + 16, s.d + 14, 32, st.roof);
      roof.position.y = s.h;
      g.add(roof);
      g.add(box(10, 26, 10, mat(st.base), s.w * 0.28, s.h + 20, -s.d * 0.15));
      door(g, s.d / 2);
      windowsRow(g, s.w, s.h * 0.58, s.d / 2, 2, true);
      return g;
    }
    // Ko'p qavatli uy: pastda kirish (podyezd), ustida qavatlar
    const G = GROUND_H.uy;
    const [tw, td] = TOWER.uy;
    g.add(box(124, G, 80, mat(st.base), 0, G / 2, 0));
    door(g, 40);
    windowsRow(g, 124, G * 0.55, 40, 4, true);
    g.add(box(40, 3, 14, mat(st.roof), 0, 30.5, 47));
    g.add(box(128, 4, 84, mat('#78716c'), 0, G + 2, 0));
    const floors = level - 1;
    g.add(tower(st, tw, td, floors, G + 4));
    const top = G + 4 + floors * FLOOR_H;
    if (level < 10) {
      const roof = gableRoof(tw + 12, td + 10, 24, st.roof);
      roof.position.y = top;
      g.add(roof);
    } else {
      g.add(box(tw + 4, 3, td + 4, mat('#78716c'), 0, top + 1.5, 0));
      roofTop(g, 'uy', level, tw, td, top + 3, st);
    }
    return g;
  }

  function buildShopBuilding(level, st) {
    const g = new THREE.Group();
    const W = 124;
    const D = 78;
    const H = GROUND_H.magazin;
    const front = D / 2;
    g.add(box(W, H, D, mat(st.wall), 0, H / 2, 0));
    g.add(box(W - 22, 24, 1.5, GLASS(), 0, 13, front + 0.8));
    door(g, front, '#1f2937');
    stripedAwning(g, W - 8, 27, front, st.awnA, st.awnB);
    const sign = signPlane(st.sign, W * 0.6, 10, st.signBg, st.signFg);
    sign.position.set(0, 34, front + 1);
    g.add(sign);
    g.add(box(W + 4, 4, D + 4, mat('#9ca3af'), 0, H + 2, 0));
    if (st.flowers) {
      // Gul do'koni: oldida rang-barang gul tuvaklari
      const colors = ['#ef4444', '#f59e0b', '#ec4899', '#a855f7', '#22c55e'];
      for (let i = 0; i < 5; i += 1) {
        const x = -48 + i * 24;
        g.add(cyl(5, 4, 8, mat('#92400e'), x, 4, front + 16));
        g.add(mesh(new THREE.SphereGeometry(6, 10, 8), mat(colors[i]), x, 12, front + 16));
      }
    }
    if (level === 1) {
      roofTop(g, 'magazin', level, W, D, H + 4, st);
      return g;
    }
    const [tw, td] = TOWER.magazin;
    const floors = level - 1;
    g.add(tower(st, tw, td, floors, H + 4));
    const top = H + 4 + floors * FLOOR_H;
    g.add(box(tw + 4, 3, td + 4, mat('#9ca3af'), 0, top + 1.5, 0));
    roofTop(g, 'magazin', level, tw, td, top + 3, st);
    return g;
  }

  function buildCafe(level, st) {
    const g = new THREE.Group();
    const W = 104;
    const D = 70;
    const H = GROUND_H.kafe;
    const front = D / 2;
    g.add(box(W, H, D, mat(st.wall), 0, H / 2, 0));
    g.add(box(W - 24, 22, 1.5, GLASS(), 0, 13, front + 0.8));
    door(g, front, st.frame);
    stripedAwning(g, W - 6, 27, front, st.awnA, st.awnB);
    const sign = signPlane(st.sign, W * 0.5, 10, st.signBg, st.signFg);
    sign.position.set(0, 34, front + 1);
    g.add(sign);
    g.add(box(W + 6, 4, D + 6, mat(st.frame), 0, H + 2, 0));
    // Tashqaridagi stollar va soyabonlar
    const tables = Math.min(2 + Math.floor(level / 25), 4);
    const xs = [-62, 62, -34, 34];
    for (let i = 0; i < tables; i += 1) {
      const x = xs[i];
      const z = 74;
      g.add(cyl(9, 9, 2, mat('#78350f'), x, 11, z), cyl(1.5, 1.5, 11, mat('#78350f'), x, 5.5, z));
      g.add(cyl(1, 1, 26, mat('#e5e7eb'), x, 13, z));
      g.add(mesh(new THREE.ConeGeometry(17, 9, 10), mat(i % 2 ? '#fff7ed' : st.umbrella), x, 30, z));
    }
    if (level === 1) return g;
    // Ustida — mehmonxona qavatlari
    const [tw, td] = TOWER.kafe;
    const floors = level - 1;
    g.add(tower(st, tw, td, floors, H + 4));
    const top = H + 4 + floors * FLOOR_H;
    g.add(box(tw + 4, 3, td + 4, mat(st.frame), 0, top + 1.5, 0));
    roofTop(g, 'kafe', level, tw, td, top + 3, st);
    return g;
  }

  function buildOffice(level, st) {
    const g = new THREE.Group();
    const W = 100;
    const D = 80;
    const G = GROUND_H.ofis;
    const front = D / 2;
    g.add(box(W + 8, G, D + 8, mat(st.lobby), 0, G / 2, 0));
    g.add(box(30, 18, 1.6, GLASS(), 0, 9, front + 4.8));
    const text = level >= 50 && st.bigSign ? st.bigSign : st.sign;
    const sign = signPlane(text, W * 0.8, 7, st.signBg, st.signFg);
    sign.position.set(0, 22, front + 4.2);
    g.add(sign);
    g.add(tower(st, W, D, level, G));
    const top = G + level * FLOOR_H;
    g.add(box(W + 6, 5, D + 6, mat('#1f2937'), 0, top + 2.5, 0));
    if (st.cross) {
      // Klinika: tomida qizil xoch
      const red = glow('#dc2626', 0.4);
      g.add(box(36, 12, 4, red, 0, top + 14, front - 6), box(12, 36, 4, red, 0, top + 14, front - 6));
    }
    roofTop(g, 'ofis', level, W, D, top + 5, st);
    return g;
  }

  function makeBuilding(kind, level, variant) {
    const st = styleOf(kind, variant);
    if (kind === 'magazin') return buildShopBuilding(level, st);
    if (kind === 'kafe') return buildCafe(level, st);
    if (kind === 'ofis') return buildOffice(level, st);
    return buildHouse(level, st);
  }

  // ---------------- Statik xarita ----------------
  const pickables = [];  // sichqoncha bilan bosiladigan narsalar

  // Takrorlanadigan kichik tekstura (katta xaritada ham xotira kam ketadi, yo'llar aniq chiqadi)
  function tileTexture(size, draw, repeatX, repeatY) {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    draw(c.getContext('2d'), size);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeatX, repeatY);
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tex;
  }

  // Yerga yotqizilgan tekislik (x, z — markazi)
  function flat(w, d, material, x, z, y) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), material);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, y, z);
    m.receiveShadow = true;
    return m;
  }

  function buildGround() {
    const W = world.w;
    const H = world.h;
    const R = world.road;

    // O't — 256px rasm har 320 birlikda takrorlanadi
    let seed = 11;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const grass = tileTexture(256, (g, n) => {
      g.fillStyle = '#5c9442';
      g.fillRect(0, 0, n, n);
      for (let i = 0; i < 70; i += 1) {
        g.fillStyle = rnd() > 0.5 ? 'rgba(78,128,55,.55)' : 'rgba(108,164,72,.45)';
        g.beginPath();
        g.ellipse(rnd() * n, rnd() * n, 5 + rnd() * 14, 3 + rnd() * 8, rnd() * 3, 0, Math.PI * 2);
        g.fill();
      }
    }, W / 320, H / 320);
    scene.add(flat(W, H, new THREE.MeshStandardMaterial({ map: grass, roughness: 1 }), W / 2, H / 2, 0));

    // Bog' maydoni, ko'l qirg'og'i, Avtosalon oldi
    const f = world.fountain;
    const plaza = new THREE.Mesh(new THREE.CircleGeometry(125, 48), mat('#d6d3d1', { roughness: 1 }));
    plaza.rotation.x = -Math.PI / 2;
    plaza.position.set(f.x + f.w / 2, 0.2, f.y + f.h / 2);
    plaza.receiveShadow = true;
    const pd = world.pond;
    const shore = new THREE.Mesh(new THREE.CircleGeometry(1, 48), mat('#d9c08c', { roughness: 1 }));
    shore.rotation.x = -Math.PI / 2;
    shore.scale.set(pd.w / 2 + 14, pd.h / 2 + 14, 1);
    shore.position.set(pd.x + pd.w / 2, 0.2, pd.y + pd.h / 2);
    const sh = world.shop;
    scene.add(plaza, shore, flat(sh.w + 20, 70, mat('#cbd5e1', { roughness: 1 }), sh.x + sh.w / 2, sh.y + sh.h + 35, 0.2));

    // Yo'llar: trotuar, asfalt, sariq uzuq chiziq; chorrahalar chiziqni yopadi
    const sidewalk = mat('#9ca3af', { roughness: 1 });
    const asphalt = mat('#3b404c', { roughness: 0.95 });
    const dashTex = (len) => tileTexture(64, (g, n) => {
      g.clearRect(0, 0, n, n);
      g.fillStyle = '#facc15';
      g.fillRect(0, 0, n * 0.55, n);
    }, len / 40, 1);
    const dashMat = (len) => new THREE.MeshBasicMaterial({ map: dashTex(len), transparent: true, alphaTest: 0.5, depthWrite: false });
    world.h_roads.forEach((y) => {
      scene.add(flat(W, R + 16, sidewalk, W / 2, y + R / 2, 0.25), flat(W, R, asphalt, W / 2, y + R / 2, 0.45));
      scene.add(flat(W, 3, dashMat(W), W / 2, y + R / 2, 0.6));
    });
    world.v_roads.forEach((x) => {
      scene.add(flat(R + 16, H, sidewalk, x + R / 2, H / 2, 0.25), flat(R, H, asphalt, x + R / 2, H / 2, 0.45));
      const line = flat(H, 3, dashMat(H), x + R / 2, H / 2, 0.6);
      line.rotation.z = Math.PI / 2;
      scene.add(line);
    });
    // Chorrahalar va piyodalar o'tish joylari (bitta InstancedMesh — tez)
    const crossings = [];
    world.h_roads.forEach((y) => world.v_roads.forEach((x) => crossings.push([x, y])));
    crossings.forEach(([x, y]) => scene.add(flat(R, R, asphalt, x + R / 2, y + R / 2, 0.75)));
    const stripes = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat('#f8fafc', { roughness: 1 }), crossings.length * 20);
    const m4 = new THREE.Matrix4();
    const rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    let k = 0;
    const stripe = (cx, cz, w, d) => {
      m4.compose(new THREE.Vector3(cx, 0.8, cz), rot, new THREE.Vector3(w, d, 1));
      stripes.setMatrixAt(k, m4);
      k += 1;
    };
    crossings.forEach(([x, y]) => {
      for (let i = 0; i < 5; i += 1) {
        stripe(x - 13, y + 10 + i * 15, 14, 8);
        stripe(x + R + 13, y + 10 + i * 15, 14, 8);
        stripe(x + 10 + i * 15, y - 13, 8, 14);
        stripe(x + 10 + i * 15, y + R + 13, 8, 14);
      }
    });
    stripes.receiveShadow = true;
    scene.add(stripes);

    // Xarita chetidan tashqari — keng o'tloq, o'rmon va tepaliklar (dunyo "tugab qolgandek" ko'rinmasin)
    const outside = flat(W * 6, H * 6, mat('#4f8a3a', { roughness: 1 }), W / 2, H / 2, -0.5);
    outside.receiveShadow = false;
    scene.add(outside);
    buildBorderForest();
  }

  function buildBorderForest() {
    const W = world.w;
    const H = world.h;
    let seed = 99;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    // Chetida zich daraxtlar (xarita ichiga kirmaydi)
    const spots = [];
    for (let i = 0; i < 900; i += 1) {
      const side = i % 4;
      const depth = 60 + rnd() * 900;
      let x;
      let y;
      if (side === 0) { x = rnd() * (W + 2000) - 1000; y = -depth; }
      else if (side === 1) { x = rnd() * (W + 2000) - 1000; y = H + depth; }
      else if (side === 2) { x = -depth; y = rnd() * H; }
      else { x = W + depth; y = rnd() * H; }
      spots.push([x, y, 26 + rnd() * 22]);
    }
    const trunkGeo = new THREE.CylinderGeometry(4, 5, 26, 6);
    trunkGeo.translate(0, 13, 0);
    const crownGeo = new THREE.ConeGeometry(1, 2.2, 7);
    crownGeo.translate(0, 1.1, 0);
    // Poyga trassasi joyidagi archalar alohida: poyga paytida yashiriladi
    const TR = world.track ? world.track.rect : null;
    const onTrack = ([x, y]) => TR && x > TR.x - 40 && x < TR.x + TR.w + 40 && y > TR.y - 40 && y < TR.y + TR.h + 40;
    const AR = world.airport ? world.airport.rect : null;
    const onAirport = ([x, y]) => AR && x > AR.x - 60 && x < AR.x + AR.w + 60 && y > AR.y - 60 && y < AR.y + AR.h + 60;
    const QR = world.aqua ? world.aqua.rect : null;
    const onAqua = ([x, y]) => QR && x > QR.x - 60 && x < QR.x + QR.w + 60 && y > QR.y - 60 && y < QR.y + QR.h + 60;
    const inR = (r, [x, y]) => r && x > r.x - 60 && x < r.x + r.w + 60 && y > r.y - 60 && y < r.y + r.h + 60;
    const onZooPort = (sp) => inR(world.zoo && world.zoo.rect, sp) || inR(world.port && world.port.rect, sp)
      || inR(world.river && world.river.rect, sp) || inR(world.maze && world.maze.rect, sp) || inR(world.craft, sp) || townAreas().some((r) => inR(r, sp)) || (world.rocket && Math.hypot(sp[0] - world.rocket.x, sp[1] - world.rocket.y) < 160);
    const groups = [spots.filter((sp) => !onTrack(sp) && !onAirport(sp) && !onAqua(sp) && !onZooPort(sp)), spots.filter((sp) => onTrack(sp) && !onAirport(sp))];
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const color = new THREE.Color();
    groups.forEach((list, gi) => {
      if (!list.length) return;
      const trunks = new THREE.InstancedMesh(trunkGeo, mat('#6b3f1d'), list.length);
      const crowns = new THREE.InstancedMesh(crownGeo, mat('#ffffff'), list.length);
      list.forEach(([x, y, r], i) => {
        m4.compose(new THREE.Vector3(x, 0, y), q, new THREE.Vector3(1, 1, 1));
        trunks.setMatrixAt(i, m4);
        m4.compose(new THREE.Vector3(x, 18, y), q, new THREE.Vector3(r, r * 1.3, r));
        crowns.setMatrixAt(i, m4);
        crowns.setColorAt(i, color.setHSL(0.31 + (i % 7) * 0.01, 0.45, 0.22 + (i % 4) * 0.03));
      });
      if (gi === 1) {
        trackForest = new THREE.Group();
        trackForest.add(trunks, crowns);
        scene.add(trackForest);
      } else scene.add(trunks, crowns);
    });
    // Uzoqdagi tepaliklar
    const hillMat = mat('#4a7c35', { roughness: 1, flatShading: true });
    for (let i = 0; i < 26; i += 1) {
      const a = (i / 26) * Math.PI * 2;
      const rx = W / 2 + Math.cos(a) * (W * 0.5 + 1700 + rnd() * 600);
      const rz = H / 2 + Math.sin(a) * (H * 0.5 + 1700 + rnd() * 600);
      const hill = new THREE.Mesh(new THREE.ConeGeometry(500 + rnd() * 500, 300 + rnd() * 500, 7), hillMat);
      hill.position.set(rx, 120, rz);
      hill.rotation.y = rnd() * Math.PI;
      scene.add(hill);
    }
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
      crowns.setColorAt(i, seasonCrown(color, i)); // fasl: kuzda sariq, qishda oq, bahorda gulli
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
    // Skameykalar (o'tirish mumkin — F)
    world.benches.forEach((b) => {
      const g = new THREE.Group();
      const wood = mat('#92400e');
      const iron = mat('#374151');
      g.add(box(44, 3, 13, wood, 0, 12, 0), box(44, 11, 3, wood, 0, 21, -6.5));
      [-18, 18].forEach((x) => g.add(box(3, 12, 12, iron, x, 6, 0), box(3, 14, 3, iron, x, 18, -6.5)));
      g.position.set(b.x, 0, b.y);
      g.rotation.y = Math.PI / 2 - b.dir;
      scene.add(g);
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
    const f = r.flag ? `${r.flag.tag}:${r.flag.color}` : '';
    return `${r.owner}|${r.kind}|${r.variant}|${r.level}|${r.name}|${r.home}|${r.owner === me.key}|${r.price}|${f}`;
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
        const b = makeBuilding(rec.kind, rec.level, rec.variant);
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
      if (rec.flag) {
        // Klan bayrog'i Ota hovli darvozasi yonida
        const fx = plot.x + 16;
        const fz = near - out * 16;
        group.add(cyl(1.6, 1.6, 78, mat('#d1d5db', { metalness: 0.6, roughness: 0.3 }), fx, 39, fz, 8));
        const cloth = signPlane(rec.flag.tag, 36, 22, rec.flag.color, '#ffffff');
        cloth.position.set(fx + 18, 66, fz);
        group.add(cloth);
      }
      const who = mine ? 'Siz' : rec.name;
      const what = rec.level ? `${bName(rec.kind, rec.variant)} · ${rec.level} qavat` : "bo'sh yer";
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
    const t = world.airport.terminal;
    solids.push({ ...t, top: 70 }, { x: t.x + 110, y: t.y + 560, w: 60, h: 60, top: 150 }, ...placeSolids(), ...riverSolids(), ...citySolids(), ...townSolids());
  }

  const inside = (x, y, s, r = 0) => x + r > s.x && x - r < s.x + s.w && y + r > s.y && y - r < s.y + s.h;
  // h — balandlik: uchayotgan mashina past binolar ustidan o'tadi
  // Yurish mumkin bo'lgan joy: odatda shahar, poyga paytida — o'rmondagi trassa
  function areas() {
    if (trackOn()) return [world.track.rect];
    if (me && me.boat) return [world.port.sea]; // qayiqda — faqat dengizda
    return [{ x: 0, y: 0, w: world.w, h: world.h }, world.airport.rect, world.aqua.rect, world.zoo.rect, world.port.rect,
      ...(world.river ? [world.river.rect] : []), ...(world.maze ? [world.maze.rect] : []), ...(world.craft ? [world.craft] : []), ...townAreas()];
  }
  function area() {
    return areas()[0];
  }
  const inAreas = (x, y, r) => areas().some((a) => x >= a.x + r && y >= a.y + r && x <= a.x + a.w - r && y <= a.y + a.h - r);
  function insideInfield(x, y, r) {
    const T = world.track;
    const dx = Math.abs(x - T.cx);
    const dy = y - T.cy;
    const inner = T.r - T.w / 2 - r;
    return dx <= T.half ? Math.abs(dy) < inner : Math.hypot(dx - T.half, dy) < inner;
  }
  function blocked(x, y, r, h = 0) {
    if (!inAreas(x, y, r)) return true;
    if (trackOn() && h < 40 && insideInfield(x, y, r)) return true;
    if (me && me.spider && !me.car) return false; // o'rgimchak odam devordan tomga chiqadi
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
    const t0 = same ? ride.t0 : null;
    ride = next || null;
    if (ride) ride.t0 = t0 || performance.now() - (ride.elapsed || 0) * 1000;
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
  const ARROW_COLORS = { ride: glow('#22c55e', 0.7), guide: glow('#3b82f6', 0.7), pass: glow('#facc15', 0.7), bus: glow('#f97316', 0.7), job: glow('#a855f7', 0.7) };
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
    else if (busJob && me.car) target = { x: busJob.stop.x, y: busJob.stop.y, kind: 'bus' };
    else if (job) target = { x: job.x, y: job.y, kind: 'job' };
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
      const secs = (performance.now() - ride.t0) / 1000;
      const mult = taxiMult(secs);
      const pay = Math.floor(ride.fare * (car ? car.fare : 1) * mult);
      sub = `${meters(Math.hypot(ride.tx - me.x, ride.ty - me.y))} · ${Math.floor(secs)} s · ${formatNumber(pay)} so'm`
        + (mult >= 1.95 ? ' · tez: ×2!' : ` · ×${String(mult).replace('.', ',')}`);
    } else if (job) {
      mode = 'job';
      const name = job.kind === 'post' ? 'Posilka' : 'Pitsa';
      if (job.phase === 'pickup') title = { post: 'Pochtaga boring (binafsha nur)', pizza: 'Pitsaxonaga boring (binafsha nur)', build: 'Qurilish bazasiga boring (binafsha nur)' }[job.kind];
      else if (job.kind === 'build') title = `Qurilish ${job.total - job.left + 1}/${job.total} — binoga materiallarni olib boring`;
      else if (job.kind === 'pizza') {
        const left = Math.ceil(((job.deadlineAt || 0) - performance.now()) / 1000);
        title = left > 0 ? `Pitsani yetkazing — ${left} s qoldi (choychaqa!)` : 'Pitsa sovib qoldi — baribir yetkazing';
      } else title = `${name} ${job.total - job.left + 1}/${job.total} — manzilga boring`;
      sub = `${meters(Math.hypot(job.x - me.x, job.y - me.y))}${job.earned ? ` · ishladingiz: ${formatNumber(job.earned)} so'm` : ''}`;
    } else if (busJob) {
      mode = 'bus';
      title = `Avtobus: ${busJob.next + 1}-bekatga boring (to'q sariq nur)`;
      sub = `${meters(Math.hypot(busJob.stop.x - me.x, busJob.stop.y - me.y))} · kutayotganlar: ${busJob.waiting} kishi · bekat ${busJob.done % busJob.total}/${busJob.total}`;
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
      $('taxi-icon').replaceChildren(icon(mode === 'ride' ? 'user' : (mode === 'bus' ? 'users' : (mode === 'job' ? 'map-pin' : 'navigation'))));
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
      const m = String(data.mult).replace('.', ',');
      toast(data.mult >= 1.95
        ? `Juda tez yetkazdingiz (${data.seconds} s)! ×2 — +${formatNumber(data.earned)} so'm`
        : (data.mult >= 1
          ? `Yo'lovchi manzilga yetdi (${data.seconds} s, ×${m}) — +${formatNumber(data.earned)} so'm`
          : `Kech qoldingiz (${data.seconds} s, ×${m}) — +${formatNumber(data.earned)} so'm. Tezroq yursangiz ko'proq beradi!`), 'success');
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
    } else if (job) {
      endJob();
    } else if (busJob) {
      toggleBus();
    } else if (guide) {
      setGuide();
    }
  }

  // Avtomatik: yo'lovchi yonida — o'tiradi, manzilda — tushadi
  function taxiTick() {
    if (!me.car) return;
    busTick();
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
        seat: p.seat || null, pose: p.pose || null, clan: p.clan || null, drift: Boolean(p.drift), tune: p.tune || null,
        emote: p.emote || null, para: Boolean(p.para), ring: Boolean(p.ring), dirt: p.dirt || 0, pet: p.pet || null, boat: Boolean(p.boat),
        act: p.act || null, spoiler: Boolean(p.spoiler), horn: p.horn || null,
      });
      setRigLooks(o.rig, suitLooks(p.looks, p.spider));
    });
    // Mashinadagi yo'lovchilar soni haydovchi ismi yonida: "Jasur (+2)"
    const riders = new Map();
    list.forEach((p) => { if (p.seat) riders.set(p.seat, (riders.get(p.seat) || 0) + 1); });
    if (me.seat) riders.set(me.seat.driver, (riders.get(me.seat.driver) || 0) + 1);
    list.forEach((p) => {
      const n = riders.get(p.key) || 0;
      const tag = p.clan ? `[${p.clan.tag}] ` : '';
      setRigLabel(others.get(p.key).rig, `${mayorKey === p.key ? '👑 ' : ''}${p.spider ? '🕷️ ' : ''}${tag}${p.ring ? '💍 ' : ''}${p.name}${n ? ` (+${n})` : ''}`, p.avatar);
    });
    const mine = riders.get(me.key) || 0;
    setRigLabel(me.rig, `${mayorKey === me.key ? '👑 ' : ''}${mine ? `Siz (+${mine})` : 'Siz'}`, me.avatar);
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
    if (me && me.car && !economy.cars.includes(me.car) && !(me.car === 'bike' && me.rentBike)) me.car = null;
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
    $('btn-drift').hidden = !inCar;
    const inBus = Boolean(inCar && carInfo() && carInfo().style === 'bus');
    $('btn-bus').hidden = !inBus && !busJob;
    $('btn-bus').classList.toggle('is-on', Boolean(busJob));
    if (!inCar) {
      taxiOn = false;
      driftOn = false;
    }
    $('btn-drift').classList.toggle('is-on', driftOn);
    $('btn-drift').setAttribute('aria-pressed', String(driftOn));
    const yandex = $('btn-yandex');
    yandex.hidden = !inCar || !(carInfo() && carInfo().fare > 0);
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
    if (!me || room.on || me.para || slide) return;
    me.dance = false;
    if (me.sit) standUp();
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
    if (me && me.car) {
      sound.horn(engineKey(me.car), town.me.kit.horn);
      api('/api/game/honk', { method: 'POST' }).catch(() => {});
    }
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
    return Math.min(world.fly_height, Math.max(car.cruise || world.fly_cruise, top + 40));
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
    if (ix || iy) me.dance = false;
    if (slide && stepSlide(performance.now())) {
      me.moving = true;
      updateRig(me.rig, me, dt, true);
      stepOthers(dt);
      return;
    }
    if (raceFrozen() || flight || mgFrozen() || movie || hoop.on) {
      ix = 0; // poyga boshlanishini kutyapmiz / reysda uchyapmiz
      iy = 0;
    }
    me.tune = tuneOf(me.car);
    if (me.sit) {
      if (ix || iy) standUp();
      else {
        me.moving = false;
        me.throttle = 0;
        me.x = me.sit.x;
        me.y = me.sit.y;
        me.dir = me.sit.dir;
        me.pose = 'sit';
        updateRig(me.rig, me, dt, false);
        stepOthers(dt);
        return;
      }
    }
    me.pose = me.dance && !me.car ? 'dance' : null;
    me.moving = Boolean(ix || iy);
    me.throttle += ((me.moving ? 1 : 0) - me.throttle) * Math.min(1, dt * 3);
    const car = carInfo();
    // Tezlik: odatda darhol, drift paytida — sirpanib (inersiya bilan)
    let wantX = 0;
    let wantZ = 0;
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
      const speed = walkSpeed * (car ? car.speed * tuneSpeed(me.car) : 1) * (car && drifting() ? 1.08 : 1)
        * (!car && inPool(me.x, me.y) ? 0.55 : 1) * (me.para ? 1.3 : 1) * (me.boat ? 2 : 1) * townSpeed(car);
      wantX = dx * speed;
      wantZ = dz * speed;
      me.dir = Math.atan2(dz, dx);
    }
    // Yomg'ir/qorda yo'l sirpanchiq: mashina doim biroz sirpanadi, drift esa ancha oson
    const grip = roadGrip();
    if (car && me.h < 5 && (drifting() || grip.base)) {
      const k = Math.min(1, dt * (drifting() ? grip.drift : grip.base));
      me.vx += (wantX - me.vx) * k;
      me.vz += (wantZ - me.vz) * k;
    } else {
      me.vx = wantX;
      me.vz = wantZ;
    }
    if (Math.abs(me.vx) + Math.abs(me.vz) > 1) {
      const r = car ? 20 : 12;
      const stuck = blocked(me.x, me.y, r, me.h);
      const nx = me.x + me.vx * dt;
      const ny = me.y + me.vz * dt;
      // Binoga tiqilib qolgan bo'lsa — chiqib ketishiga ruxsat (lekin xarita chegarasidan emas)
      if ((stuck && inAreas(nx, me.y, r)) || !blocked(nx, me.y, r, me.h)) me.x = nx;
      else me.vx *= -0.2;
      if ((stuck && inAreas(me.x, ny, r)) || !blocked(me.x, ny, r, me.h)) me.y = ny;
      else me.vz *= -0.2;
      me.moving = true;
    }
    driftFx(dt, car);
    if (me.para) {
      // Parashyut: sekin tushadi
      me.h = Math.max(0, me.h - 75 * dt);
      me.vh = 0;
      if (me.h === 0) landParachute();
    } else if (car && car.flies) {
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
    } else if (me.spider && !zip && !me.seat) {
      // O'rgimchak odam: tagidagi tomga tez chiqadi, chetdan yiqilib tushadi
      const floor = topUnder(me.x, me.y, 10);
      if (me.h < floor - 0.5 && me.vh <= 0) {
        me.h = Math.min(floor, me.h + 420 * dt);
        me.vh = 0;
      } else {
        me.vh -= GRAVITY * dt;
        me.h = Math.max(floor, me.h + me.vh * dt);
        if (me.h === floor) me.vh = 0;
      }
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
      const moved = Math.hypot(p.x - ox, p.y - oy);
      updateRig(p.rig, p, dt, moved > 0.2);
      if (p.drift && p.car && moved > dt * 120 && Math.random() < 0.6) smokeAt(p.x, p.y, p.dir);
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
    if (townCam(dt)) return;
    const car = carInfo();
    // uchganda kamera ham ko'tariladi (sakrashda emas); do'stning uchayotgan mashinasida ham
    // parashyutda va o'rgimchak odam tomda yurganda ham kamera odamni kuzatadi
    const lift = (car && car.flies) || me.seat || me.para || me.spider ? me.h : 0;
    const target = new THREE.Vector3(me.x, 24 + lift, me.y);
    const pitch = droneOn ? 1.25 : cam.pitch; // dron: shahar tepadan
    const dist = droneOn ? Math.max(1300, cam.dist) : cam.dist;
    const horiz = Math.cos(pitch) * dist;
    const want = new THREE.Vector3(
      me.x + Math.sin(cam.yaw) * horiz,
      lift + Math.sin(pitch) * dist,
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
    scene.fog.near = (1400 + lift) * weatherFog();
    scene.fog.far = (3600 + lift * 1.5) * weatherFog();
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
    jobTick();
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
    if (me.sit) best = { kind: 'stand', d: 0 };
    if (!best && !me.car && me.h < 20) {
      const nb = nearestBench();
      if (nb && nb.d < 50) best = { kind: 'bench', bench: nb.b, d: nb.d };
    }
    if (!best && !me.car && me.h < 40) {
      // Do'stning mashinasi yonida — unga o'tirish
      others.forEach((p, key) => {
        if (!p.car || p.seat) return;
        const d = Math.hypot(p.x - me.x, p.y - me.y);
        if (d < 110 && (!best || d < best.d)) best = { kind: 'seat', key, name: p.name, d };
      });
    }
    if (!best && me.car && carInfo() && carInfo().style === 'plane' && !flight) {
      const gate = world.airport.gate;
      const dGate = Math.hypot(gate.x - me.x, gate.y - me.y);
      if (dGate < 260) best = { kind: 'gate', d: dGate };
    }
    if (!best && me.car && taxiOn && !ride) {
      const n = nearestPassenger();
      if (n && n.d < catalog.taxi_pick_dist) best = { kind: 'passenger', id: n.id, d: n.d };
    }
    if ((!best || best.kind === 'bench') && !me.sit) {
      const f = funSpot(); // joylar (bank, sahna…) skameykadan ustun
      if (f) best = f;
    }
    if ((!best || best.kind === 'bench') && me.h < 40 && !me.sit) {
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
    if (best.kind === 'fun') {
      text = best.text;
    } else if (best.kind === 'gate') {
      text = 'Reyslar — boshqa shaharga uchish';
    } else if (best.kind === 'bench') {
      text = "Skameykaga o'tirish";
    } else if (best.kind === 'stand') {
      text = "O'rningizdan turish";
    } else if (best.kind === 'seat') {
      text = `${best.name}ning mashinasiga o'tirish`;
    } else if (best.kind === 'passenger') {
      const p = passengers.get(best.id);
      text = `Yo'lovchini olish — ${formatNumber(p.fare * carInfo().fare)} so'm`;
    } else if (best.kind === 'plot') {
      const r = plotsById.get(best.id);
      if (!r) text = `${plotTitle(best.id)} — sotuvda`;
      else if (r.owner === me.key) text = r.level ? `${bName(r.kind, r.variant)} · ${r.level} qavat` : `${plotTitle(best.id)} — nima quramiz?`;
      else text = `${r.name}: ${r.level ? `${bName(r.kind, r.variant)} · ${r.level} qavat` : "bo'sh yer"}`
        + (r.price ? ` — sotuvda ${formatNumber(r.price)} so'm` : '');
    }
    $('prompt-text').textContent = text;
    prompt.hidden = false;
  }

  function interact() {
    if (!nearTarget || room.on) return;
    if (nearTarget.kind === 'fun') nearTarget.act();
    else if (nearTarget.kind === 'gate') openFlights();
    else if (nearTarget.kind === 'bench') sitDown(nearTarget.bench);
    else if (nearTarget.kind === 'stand') standUp();
    else if (nearTarget.kind === 'seat') seatIn(nearTarget.key);
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
    if (sheetState && sheetState.kind === 'looks' && me) setRigLooks(me.rig, suitLooks(me.looks, me.spider));
    sheetState = null;
    clearTimeout(quizTimer);
    sheet.hidden = true;
    sheetBackdrop.hidden = true;
  }

  function sheetSignature() {
    if (!sheetState) return '';
    // Savol-javob oynasi faqat javob berilganda qayta chiziladi (har sinxronda emas)
    if (sheetState.kind === 'quiz') return `quiz|${sheetState.quiz.token}|${sheetState.step}|${JSON.stringify(sheetState.result)}`;
    // Odamlar va pul berish oynalari sinxronda qayta chizilmaydi (yozilgan summa o'chib ketmasin)
    if (sheetState.kind === 'people') return `people|${sheetState.list ? sheetState.list.length : '-'}`;
    if (sheetState.kind === 'give') return `give|${sheetState.person.key}`;
    if (['bank', 'top', 'clans', 'looks', 'race', 'hub', 'code', 'daily', 'spin', 'garage', 'flights', 'festadmin', 'metro', 'phone', 'chat', 'stocks', 'tour', 'pets', 'farm', 'kitchen', 'election', 'license', 'cup', 'spider', 'drone', 'school', 'work', 'bakery', 'barber', 'market2', 'mail', 'invest', 'list2', 'tw'].includes(sheetState.kind)) return `${sheetState.kind}|${sheetState.v || 0}`;
    if (sheetState.kind === 'gift') return `gift|${sheetState.person.key}|${economy.cars.join()}|${economy.plots.map((x) => x.plot).join()}`;
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
    const thing = rec.level ? `${bName(rec.kind, rec.variant)} (${rec.level} qavat)` : "Yer";
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
      el('span', '', `${rec.level ? `${bName(rec.kind, rec.variant)} (${rec.level} qavat)` : "Bo'sh yer"} binosi bilan sizniki bo'ladi. Pul ${rec.name}ga o'tadi.`),
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
      info.append(el('strong', '', rec.level ? bName(rec.kind, rec.variant) : "Bo'sh yer"),
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
      // Tanlangan turning 4 ta varianti (bosilgan kartaning darhol tagida chiqadi)
      const variantsBox = (kind) => {
        const wrap = el('div', 'variants');
        wrap.id = 'build-variants';
        wrap.append(el('h3', 'variants__title', `${kind.name}: qaysi biri bo'lsin?`));
        const list = el('div', 'variants__grid');
        kind.variants.forEach((v) => {
          const st = styleOf(kind.id, v.id);
          const vc = el('div', 'variant');
          const sw = el('span', 'variant__swatch');
          sw.style.background = st.signBg || st.roof || st.tower;
          sw.style.color = st.signFg || '#ffffff';
          sw.append(icon(KIND_ICONS[kind.id]));
          const info = el('div', 'variant__info');
          info.append(el('strong', '', v.name), el('small', '', v.about));
          vc.append(sw, info, priceButton('Qurish', kind.first.price, async () => {
            await plotAction(id, 'build', { kind: kind.id, variant: v.id });
            sound.cash();
            toast(`${v.name} qurildi! Endi har soniyada pul keladi`, 'success');
          }, ''));
          list.append(vc);
        });
        wrap.append(list);
        return wrap;
      };
      const grid = el('div', 'build-grid');
      catalog.buildings.forEach((b) => {
        const picked = sheetState.pickKind === b.id;
        const card = el('div', picked ? 'build-card is-picked' : 'build-card');
        card.style.setProperty('--kind', b.color);
        const top = el('div', 'build-card__top');
        const ic = el('span', 'build-card__icon');
        ic.append(icon(KIND_ICONS[b.id]));
        top.append(ic, el('strong', '', b.name));
        const choose = el('button', picked ? 'btn btn--ghost btn--block' : 'btn btn--primary btn--block');
        choose.type = 'button';
        choose.append(icon(picked ? 'check' : 'arrow-up'), el('span', '', picked ? 'Tanlandi — pastdan variant tanlang' : "4 ta variantni ko'rish"));
        choose.addEventListener('click', () => {
          sheetState.pickKind = picked ? null : b.id;
          renderSheet();
          if (sheetState.pickKind) $('build-variants')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        card.append(top, el('p', '', b.about),
          el('span', 'build-card__income', `+${fmtRate(b.first.income)} so'm / sek · ${b.max} qavatgacha · ${formatNumber(b.first.price)} so'm`),
          choose);
        grid.append(card);
        if (picked) grid.append(variantsBox(b));
      });
      body.append(actionBtn('home', "Bino o'rniga ekin ekish 🌱", () => openFarm(id), 'btn btn--ghost btn--block'), grid, saleBox(id, rec, own));
      return;
    }

    const b = buildingsById[rec.kind];
    const income = own ? own.income : 0;
    setHead(KIND_ICONS[rec.kind], `${title} — ${bName(rec.kind, rec.variant)}`, `${rec.level} qavat · +${fmtRate(income)} so'm / sek`);
    const now = el('div', 'house-now');
    now.append(floorsBar(rec.level, rec.kind), el('strong', '', `${bName(rec.kind, rec.variant)} · ${rec.level} qavat`),
      el('span', '', `+${fmtRate(income)} so'm / sek`));
    body.append(now);
    if (rec.owner === me.key) {
      body.append(actionBtn('home', "Ichkariga kirish — mebel qo'yish", () => enterRoom(id), 'btn btn--ghost btn--block'));
      if (rec.kind === 'kafe') body.append(actionBtn('coffee', 'Oshxona — taom tayyorlab pul ishlash 🍳', openKitchen, 'btn btn--primary btn--block'));
      if (rec.kind === 'uy') body.append(actionBtn('coins', "Ijara haqini olish (kuniga bir marta) 🏠", claimRent, 'btn btn--ghost btn--block'));
    }

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
      // +1 qavat — 1 ta oddiy savol, +10 qavat — 2 ta juda qiyin savol
      const offer = el('div', 'offer');
      const ten = Math.min(10, kindMax(rec.kind) - rec.level);
      let tenPrice = 0;
      for (let lv = rec.level + 1; lv <= rec.level + ten; lv += 1) tenPrice += levelPrice(rec.kind, lv);
      offer.append(el('small', 'eyebrow', 'Yangi qavat'), el('strong', '', `${rec.level + 1}-qavat`),
        el('span', '', `Daromad: +${fmtRate(own.next_income)} so'm / sek bo'ladi`),
        priceButton('+1 qavat', own.next_price, () => startQuiz(id, 1)));
      if (ten > 1) {
        const hard = priceButton(`+${ten} qavat`, tenPrice, () => startQuiz(id, 10));
        hard.classList.add('btn--hard');
        offer.append(hard);
      }
      offer.append(el('small', 'quiz-note', ten > 1
        ? `+1 — 1 ta HTML/CSS savoli. +${ten} — 2 ta JUDA QIYIN savol: ikkalasi ham to'g'ri bo'lsa ${ten} qavat qo'shiladi. Xato bo'lsa — pul yechilmaydi.`
        : "Qavat qo'shish uchun HTML/CSS savoliga to'g'ri javob bering. Noto'g'ri bo'lsa — pul yechilmaydi."));
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
    toast(`+${data.added} qavat! ${bName(rec.kind, rec.variant)} endi ${rec.level} qavat`, 'success');
  }

  // ---------------- Savol-javob (yangi qavat uchun) ----------------
  let quizTimer = null;

  async function startQuiz(id, count = 1) {
    const data = await api(`/api/game/plots/${id}/quiz`, { method: 'POST', body: { count } });
    sheetState = { kind: 'quiz', id, count, quiz: data.quiz, step: 0, answers: [], result: null };
    renderSheet();
  }

  // Javob: +10 da 2 ta savol ketma-ket, oxirgisidan keyin serverga yuboriladi
  async function answerQuiz(index) {
    const st = sheetState;
    if (!st || st.kind !== 'quiz' || st.result) return;
    const questions = st.quiz.questions;
    st.answers[st.step] = index;
    if (st.step < questions.length - 1) {
      st.step += 1;
      renderSheet();
      return;
    }
    st.result = { pending: true };
    renderSheet();
    try {
      const data = await api(`/api/game/plots/${st.id}/upgrade`, {
        method: 'POST', body: { quiz: st.quiz.token, answers: st.answers },
      });
      if (data.correct) {
        localVersion += 1;
        setPlots(data.plots);
        setEconomy(data.economy);
      }
      st.result = {
        correct: data.correct,
        results: data.results || [],
        added: data.added || 1,
        until: data.correct ? 0 : Date.now() + (data.wait || catalog.quiz_cooldown) * 1000,
      };
      if (data.correct) {
        const rec = plotsById.get(st.id);
        sound.right();
        toast(`To'g'ri! +${st.result.added} qavat — ${bName(rec.kind, rec.variant)} endi ${rec.level} qavat`, 'success');
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

  function quizOptions(q, chosen, result, clickable) {
    const list = el('div', 'quiz__options');
    q.options.forEach((text, i) => {
      const opt = el('button', 'quiz__opt');
      opt.type = 'button';
      opt.append(el('span', 'quiz__letter', 'ABCD'[i]), el('code', '', text));
      if (clickable) {
        opt.addEventListener('click', () => answerQuiz(i));
      } else {
        opt.disabled = true;
        if (!result && chosen === i) opt.classList.add('is-chosen');
        if (result && i === result.right_index) opt.classList.add('is-right');
        if (result && !result.correct && i === chosen) opt.classList.add('is-wrong');
      }
      list.append(opt);
    });
    return list;
  }

  function renderQuizSheet(body, st) {
    clearTimeout(quizTimer);
    const rec = plotsById.get(st.id);
    const b = buildingsById[rec.kind];
    const questions = st.quiz.questions;
    const hard = questions.length > 1;
    setHead('hammer', hard ? `+${st.count} qavat — juda qiyin savollar` : 'Yangi qavat — savol-javob',
      st.result && st.result.correct ? `${b.name}: endi ${rec.level} qavat` : `${b.name}: hozir ${rec.level} qavat`);

    // Savollar: javob kutilayotgan bittasi yoki natijadan keyin hammasi
    const shown = st.result && !st.result.pending ? questions.map((_, i) => i) : [st.step];
    shown.forEach((qi) => {
      const q = questions[qi];
      const box2 = el('div', 'quiz');
      const head = el('div', 'quiz__head');
      head.append(el('span', `quiz__topic quiz__topic--${q.topic.toLowerCase()}`, q.topic));
      if (hard) head.append(el('span', 'quiz__hard', `JUDA QIYIN · ${qi + 1} / ${questions.length}`));
      box2.append(head, el('p', 'quiz__q', q.question));
      const result = st.result && !st.result.pending ? st.result.results[qi] : null;
      const waiting = !st.result;
      box2.append(quizOptions(q, st.answers[qi], result, waiting));
      if (result && result.explain) box2.append(el('p', 'quiz__explain', `${result.correct ? '✓' : '✗'} ${result.explain}`));
      body.append(box2);
    });

    if (!st.result || st.result.pending) {
      body.append(el('p', 'sheet-note', st.result ? 'Tekshirilmoqda…'
        : (hard ? `Ikkala savolga ham to'g'ri javob bering — shunda ${st.count} qavat qo'shiladi.` : "To'g'ri javobni tanlang.")));
      return;
    }

    const fb = el('div', st.result.correct ? 'quiz__result is-right' : 'quiz__result is-wrong');
    const wrongCount = st.result.results.filter((r) => !r.correct).length;
    fb.append(el('strong', '', st.result.correct
      ? `To'g'ri! +${st.result.added} qavat — ${b.name} endi ${rec.level} qavat.`
      : (hard ? `${questions.length} tadan ${wrongCount} ta xato — qavat qo'shilmadi.` : 'Noto\'g\'ri — qavat qo\'shilmadi.')));
    body.append(fb);

    if (st.result.correct) {
      const next = el('button', 'btn btn--primary btn--block');
      next.type = 'button';
      next.append(icon('check'), el('span', '', 'Davom etish'));
      next.addEventListener('click', () => openSheet({ kind: 'plot', id: st.id }));
      body.append(next);
      return;
    }
    // Noto'g'ri: biroz kutib, yangi savol (xuddi shu turdagi)
    const left = Math.ceil((st.result.until - Date.now()) / 1000);
    const again = el('button', 'btn btn--primary btn--block');
    again.type = 'button';
    again.disabled = left > 0;
    again.append(icon('arrow-up'), el('span', '', left > 0 ? `Yangi savol (${left} s)` : 'Yangi savol'));
    again.addEventListener('click', async () => {
      again.disabled = true;
      try {
        await startQuiz(st.id, st.count);
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
        `${rec.name}ning ${bName(rec.kind, rec.variant).toLowerCase()}ini (${rec.level} qavat) yo'q qilasizmi? Yer egasida qoladi.`,
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
    info.append(el('strong', '', r.level ? `${bName(r.kind, r.variant)} · ${r.level} qavat` : "Bo'sh yer"),
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
        info.append(el('strong', '', `${r.level ? `${bName(r.kind, r.variant)} · ${r.level} qavat` : "Bo'sh yer"} — ${formatNumber(r.price)} so'm`),
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
        const gift = el('button', 'btn btn--ghost btn--icon');
        gift.type = 'button';
        gift.title = "Sovg'a qilish (mashina yoki uy)";
        gift.setAttribute('aria-label', gift.title);
        gift.append(icon('sparkles'));
        gift.addEventListener('click', () => openSheet({ kind: 'gift', person: p }));
        row.append(give, gift);
        const ring = el('button', 'btn btn--ghost btn--icon', '💍');
        ring.type = 'button';
        ring.title = "To'y taklif qilish";
        ring.addEventListener('click', () => propose(p));
        const write = el('button', 'btn btn--ghost btn--icon');
        write.type = 'button';
        write.title = 'Xabar yozish';
        write.append(icon('message'));
        write.addEventListener('click', () => openChat(p));
        row.append(write, ring);
        if (p.online) {
          const duel = el('button', 'btn btn--ghost btn--icon');
          duel.type = 'button';
          duel.title = 'Poygaga chaqirish';
          duel.setAttribute('aria-label', duel.title);
          duel.append(icon('car'));
          duel.addEventListener('click', () => openSheet({ kind: 'race', person: p, draft: '', v: 0 }));
          row.append(duel);
        }
      }
      box2.append(row);
    });
    body.append(box2, el('p', 'sheet-note', "Pul berish, sovg'a qilish (yulduzcha) yoki o'yindagi odamni poygaga chaqirish (mashina belgisi)."));
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
      info.append(el('strong', '', `${p.home ? 'Ota hovli' : plotTitle(p.plot)} — ${p.kind ? `${bName(p.kind, p.variant)} · ${p.level} qavat` : "bo'sh yer"}`),
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
    else if (sheetState.kind === 'hub') renderHubSheet(body);
    else if (sheetState.kind === 'tw') renderTw(body, sheetState);
    else if (sheetState.kind === 'bank') renderBankSheet(body, sheetState);
    else if (sheetState.kind === 'top') renderTopSheet(body, sheetState);
    else if (sheetState.kind === 'clans') renderClansSheet(body, sheetState);
    else if (sheetState.kind === 'looks') renderLooksSheet(body, sheetState);
    else if (sheetState.kind === 'gift') renderGiftSheet(body, sheetState);
    else if (sheetState.kind === 'race') renderRaceSheet(body, sheetState);
    else if (sheetState.kind === 'code') renderCodeSheet(body, sheetState);
    else if (sheetState.kind === 'daily') renderDailySheet(body, sheetState);
    else if (sheetState.kind === 'spin') renderSpinSheet(body, sheetState);
    else if (sheetState.kind === 'garage') renderGarageSheet(body, sheetState);
    else if (sheetState.kind === 'flights') renderFlightsSheet(body, sheetState);
    else if (sheetState.kind === 'festadmin') renderFestAdminSheet(body, sheetState);
    else if (sheetState.kind === 'metro') renderMetroSheet(body, sheetState);
    else if (sheetState.kind === 'phone') renderPhoneSheet(body, sheetState);
    else if (sheetState.kind === 'chat') renderChatSheet(body, sheetState);
    else if (sheetState.kind === 'stocks') renderStocksSheet(body, sheetState);
    else if (sheetState.kind === 'tour') renderTourSheet(body, sheetState);
    else if (sheetState.kind === 'pets') renderPetsSheet(body, sheetState);
    else if (sheetState.kind === 'farm') renderFarmSheet(body, sheetState);
    else if (sheetState.kind === 'kitchen') renderKitchenSheet(body, sheetState);
    else if (sheetState.kind === 'election') renderElectionSheet(body, sheetState);
    else if (sheetState.kind === 'license') renderLicenseSheet(body, sheetState);
    else if (sheetState.kind === 'cup') renderCupSheet(body, sheetState);
    else if (sheetState.kind === 'spider') renderSpiderSheet(body, sheetState);
    else if (sheetState.kind === 'drone') renderDroneSheet(body, sheetState);
    else if (sheetState.kind === 'work') renderWorkSheet(body, sheetState);
    else if (sheetState.kind === 'market2') renderMarket2Sheet(body, sheetState);
    else if (sheetState.kind === 'mail') renderMailSheet(body, sheetState);
    else if (sheetState.kind === 'invest') renderInvestSheet(body, sheetState);
    else if (sheetState.kind === 'list2') renderList2Sheet(body, sheetState);
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
    driftHeld = false;
    Object.keys(touch).forEach((k) => { touch[k] = false; });
    document.querySelectorAll('.dpad__btn.is-down').forEach((b) => b.classList.remove('is-down'));
  }

  function jump() {
    if (!me || sheetState || me.seat || me.para || slide) return;
    if (me.car) {
      toggleFly(); // Teslada — uchish/qo'nish
      return;
    }
    if (me.h - (me.spider ? topUnder(me.x, me.y, 10) : 0) > 0.5) return;
    me.vh = JUMP_SPEED;
  }

  window.addEventListener('pointerdown', () => sound.unlock(), true);
  window.addEventListener('keydown', (e) => {
    sound.unlock();
    if (room.on) {
      if (e.target.closest?.('input, textarea, select')) return;
      if (e.key === 'Escape') {
        if (room.placing) {
          room.placing = null;
          setGhost();
          renderRoomUI();
        } else exitRoom();
      } else if (e.code === 'KeyR' || keyChar(e) === 'r' || keyChar(e) === 'к') rotateGhost();
      return;
    }
    if (e.key === 'Escape') {
      if (movie) closeMovie();
      else if (sheetState) closeSheet();
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
    if (e.key === 'Shift') {
      driftHeld = true;
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
    } else if (e.code === 'KeyG' || ch === 'g' || ch === 'п') {
      toggleDance();
    } else if (e.code === 'KeyP' || ch === 'p' || ch === 'з') {
      jumpParachute();
    } else if (e.code === 'KeyT' || ch === 't' || ch === 'е') {
      shootWeb();
    } else if (e.code === 'KeyQ' || ch === 'q' || ch === 'й') {
      throwSnow();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Shift') driftHeld = false;
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
  document.querySelectorAll('.hud-actions .action-btn, #prompt, #btn-sound, #btn-yandex, #btn-online, #btn-poll, #taxi-cancel, #race-yes, #race-no').forEach((btn) => {
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
    if (!drag || drag.id !== e.pointerId) {
      if (room.on) roomHover(e.clientX, e.clientY);
      return;
    }
    const c = room.on ? room.cam : cam;
    c.yaw -= (e.clientX - drag.x) * 0.006;
    c.pitch = clamp(c.pitch + (e.clientY - drag.y) * 0.004, room.on ? 0.45 : 0.35, room.on ? 1.4 : 1.35);
    drag.x = e.clientX;
    drag.y = e.clientY;
  });
  canvas.addEventListener('pointerup', (e) => {
    if (drag && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 6 && !sheetState) {
      if (room.on) roomClick(e.clientX, e.clientY);
      else pickAt(e.clientX, e.clientY);
    }
    drag = null;
  });
  canvas.addEventListener('pointercancel', () => { drag = null; });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (room.on) room.cam.dist = clamp(room.cam.dist * Math.exp(e.deltaY * 0.001), 160, 800);
    else cam.dist = clamp(cam.dist * Math.exp(e.deltaY * 0.001), 200, 1600);
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
    if (m.channel && m.channel !== 'all') line.append(el('em', 'chat__chan', m.channel === 'clan' ? '[Klan] ' : "[Do'st] "));
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
      const data = await api('/api/game/chat', { method: 'POST', body: { text, channel: $('chat-channel').value } });
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
    form.append('channel', $('chat-channel').value === 'clan' ? 'clan' : 'all'); // klan ovozli xonasi
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
    mini.height = Math.round((mini.width * world.h) / world.w); // xarita nisbati bilan bir xil
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
    others.forEach((p, key) => {
      if (mgHiddenKey(key)) return; // yashirinmachoqda qidiruvchi xaritada ko'rmaydi
      mctx.beginPath();
      mctx.arc(p.x, p.y, 5 * u, 0, Math.PI * 2);
      mctx.fill();
    });
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

  // ---------------- Drift ----------------
  let driftOn = false;     // tugma bilan yoqiladi
  let driftHeld = false;   // Shift bosib turilganda
  let driftTime = 0;
  let screechAt = 0;
  const drifting = () => driftOn || driftHeld;
  const smoke = [];
  const smokeGeo = new THREE.SphereGeometry(6, 8, 6);

  function smokeAt(x, y, dir) {
    if (smoke.length > 140) return;
    [-1, 1].forEach((side) => {
      const px = x - Math.cos(dir) * 24 + Math.cos(dir + Math.PI / 2) * side * 13;
      const pz = y - Math.sin(dir) * 24 + Math.sin(dir + Math.PI / 2) * side * 13;
      const m = new THREE.Mesh(smokeGeo, new THREE.MeshBasicMaterial({ color: '#d1d5db', transparent: true, opacity: 0.5, depthWrite: false }));
      m.position.set(px + (Math.random() - 0.5) * 6, 5, pz + (Math.random() - 0.5) * 6);
      scene.add(m);
      smoke.push({ m, t: 0 });
    });
  }

  function stepSmoke(dt) {
    for (let i = smoke.length - 1; i >= 0; i -= 1) {
      const s2 = smoke[i];
      s2.t += dt;
      s2.m.position.y += dt * 14;
      s2.m.scale.setScalar(1 + s2.t * 2.2);
      s2.m.material.opacity = Math.max(0, 0.5 - s2.t * 0.55);
      if (s2.t > 0.9) {
        scene.remove(s2.m);
        s2.m.material.dispose();
        smoke.splice(i, 1);
      }
    }
  }

  // Mashina qaragan tomon va haqiqiy harakat yo'nalishi farq qilsa — bu drift: tutun, g'ichirlash, ochko
  function driftFx(dt, car) {
    const speed = Math.hypot(me.vx, me.vz);
    let slip = 0;
    if (car && drifting() && speed > 120 && me.h < 5) {
      const moveDir = Math.atan2(me.vz, me.vx);
      slip = Math.abs(Math.atan2(Math.sin(me.dir - moveDir), Math.cos(me.dir - moveDir)));
    }
    if (slip > 0.25) {
      driftTime += dt;
      if (Math.random() < 0.7) smokeAt(me.x, me.y, me.dir);
      const now = performance.now();
      if (now - screechAt > 180) {
        screechAt = now;
        sound.screech();
      }
    } else if (driftTime > 0) {
      if (driftTime > 1.2) floatText(`DRIFT ${driftTime.toFixed(1).replace('.', ',')} s!`, me.x, me.y, me.rig.root.position.y + 20);
      driftTime = 0;
    }
  }

  function toggleDrift() {
    if (!me || !me.car) {
      toast("Avval mashinaga o'tiring (E)", 'warn');
      return;
    }
    driftOn = !driftOn;
    updateRideButton();
    toast(driftOn
      ? "Drift yoqildi! Tez yurib turib keskin buriling — mashina sirpanadi. (Shift — bosib turib ham bo'ladi)"
      : "Drift o'chdi");
  }
  $('btn-drift').addEventListener('click', toggleDrift);
  $('btn-para').addEventListener('click', jumpParachute);
  $('btn-web').addEventListener('click', shootWeb);
  $('btn-drone').addEventListener('click', toggleDrone);
  $('btn-photo').addEventListener('click', takePhoto);

  // ---------------- Poyga trassasi (o'rmonda, faqat poyga paytida) ----------------
  let trackGroup = null;
  let trackForest = null;
  const trackOn = () => Boolean(race && !race.result && world.track);

  function stadiumShape(half, rad) {
    const sh = new THREE.Shape();
    sh.moveTo(-half, -rad);
    sh.lineTo(half, -rad);
    sh.absarc(half, 0, rad, -Math.PI / 2, Math.PI / 2, false);
    sh.lineTo(-half, rad);
    sh.absarc(-half, 0, rad, Math.PI / 2, Math.PI * 1.5, false);
    return sh;
  }
  function stadiumRing(half, rOut, rIn, material, y) {
    const sh = stadiumShape(half, rOut);
    const hole = stadiumShape(half, rIn);
    sh.holes.push(new THREE.Path(hole.getPoints(48)));
    const m = new THREE.Mesh(new THREE.ShapeGeometry(sh, 48), material);
    m.rotation.x = -Math.PI / 2;
    m.position.y = y;
    m.receiveShadow = true;
    return m;
  }

  function buildTrack() {
    const T = world.track;
    if (!T) return;
    const g = new THREE.Group();
    g.position.set(T.cx, 0, T.cy);
    const outer = T.r + T.w / 2;
    const inner = T.r - T.w / 2;
    // Tashqi o't, asfalt, oq va qizil chetlar
    g.add(stadiumRing(T.half, outer + 120, outer, mat('#4d8a3a', { roughness: 1 }), 0.3));
    g.add(stadiumRing(T.half, outer, inner, mat('#2f3440', { roughness: 0.9 }), 0.6));
    g.add(stadiumRing(T.half, outer, outer - 6, mat('#f8fafc', { roughness: 1 }), 0.9));
    g.add(stadiumRing(T.half, inner + 6, inner, mat('#f8fafc', { roughness: 1 }), 0.9));
    g.add(stadiumRing(T.half, inner, inner - 12, mat('#dc2626', { roughness: 1 }), 0.8));
    const infield = new THREE.Mesh(new THREE.ShapeGeometry(stadiumShape(T.half, inner - 12), 32), mat('#5fa04a', { roughness: 1 }));
    infield.rotation.x = -Math.PI / 2;
    infield.position.y = 0.7;
    g.add(infield);
    // O'rtadagi uzuq chiziq
    const dash = stadiumRing(T.half, T.r + 2, T.r - 2, new THREE.MeshBasicMaterial({ color: '#facc15' }), 1);
    g.add(dash);
    // Start/marra chizig'i — shaxmat katakli
    const fx = -T.half + 200;
    const check = tileTexture(64, (c, n) => {
      c.fillStyle = '#ffffff';
      c.fillRect(0, 0, n, n);
      c.fillStyle = '#111827';
      c.fillRect(0, 0, n / 2, n / 2);
      c.fillRect(n / 2, n / 2, n / 2, n / 2);
    }, 2, 10);
    const line = new THREE.Mesh(new THREE.PlaneGeometry(24, T.w), new THREE.MeshStandardMaterial({ map: check, roughness: 1 }));
    line.rotation.x = -Math.PI / 2;
    line.position.set(fx, 1.1, -T.r);
    g.add(line);
    // Marra darvozasi va yozuv
    const post = mat('#e5e7eb', { metalness: 0.5, roughness: 0.3 });
    g.add(cyl(3, 3, 70, post, fx, 35, -T.r - T.w / 2 - 8, 10), cyl(3, 3, 70, post, fx, 35, -T.r + T.w / 2 + 8, 10));
    [1, -1].forEach((side) => {
      // Ikki tomondan ham to'g'ri o'qiladi (orqa tomoni ko'zgudagidek teskari chiqmasin)
      const banner = signPlane('MAHALLA GRAND PRIX', T.w + 30, 22, '#dc2626', '#ffffff');
      banner.material.side = THREE.FrontSide;
      banner.position.set(fx + side * 0.6, 70, -T.r);
      banner.rotation.y = (side * Math.PI) / 2;
      g.add(banner);
    });
    // Tribunalar (tomoshabin o'rindiqlari) tashqi tomonda
    const seatCols = ['#2563eb', '#dc2626', '#f59e0b', '#16a34a'];
    [-1, 1].forEach((side) => {
      for (let i = -2; i <= 2; i += 1) {
        const stand = new THREE.Group();
        for (let row = 0; row < 4; row += 1) {
          stand.add(box(240, 8, 16, mat('#9ca3af'), 0, 4 + row * 8, -row * 16));
          stand.add(box(236, 3, 10, mat(seatCols[(row + i + 4) % 4]), 0, 9.5 + row * 8, -row * 16 + 2));
        }
        stand.add(box(250, 3, 80, mat('#334155'), 0, 66, -26));
        [-120, 120].forEach((x) => stand.add(box(4, 66, 4, mat('#334155'), x, 33, -60)));
        stand.position.set(i * 290, 0, side * (outer + 40));
        stand.rotation.y = side < 0 ? 0 : Math.PI;
        g.add(stand);
      }
    });
    // Burchaklardagi shina to'siqlari
    [-1, 1].forEach((sx) => {
      for (let k = 0; k < 14; k += 1) {
        const a = -Math.PI / 2 + (k / 13) * Math.PI;
        const tire = cyl(9, 9, 10, mat(k % 2 ? '#111827' : '#f8fafc'), sx * (T.half + Math.cos(a) * (outer + 30)), 5, Math.sin(a) * (outer + 30) * sx, 12);
        g.add(tire);
      }
    });
    g.visible = false;
    scene.add(g);
    trackGroup = g;
  }

  function updateTrackVisibility() {
    if (!trackGroup) return;
    const on = trackOn() || inside(me.x, me.y, world.track.rect);
    if (trackGroup.visible !== on) {
      trackGroup.visible = on;
      if (trackForest) trackForest.visible = !on;
    }
  }

  async function quitRace() {
    if (!window.confirm("Poygadan chiqasizmi? Raqib yutadi va tikilgan pulni oladi.")) return;
    try {
      await api('/api/game/race/quit', { method: 'POST' });
      toast('Poygadan chiqdingiz');
    } catch (err) {
      if (!handleAuthError(err)) toast(err.message, 'warn');
    }
  }
  $('race-quit').addEventListener('click', quitRace);

  // Taksi: tez yetkazsangiz ko'proq (server bilan bir xil formula)
  function taxiMult(secs) {
    if (!ride || !ride.expected) return 1;
    const ratio = secs / ride.expected;
    if (ratio <= 1.3) return 2;
    if (ratio >= 4) return 0.6;
    return Math.round((2 + (0.6 - 2) * ((ratio - 1.3) / 2.7)) * 100) / 100;
  }

  // ---------------- Garaj: rang, tezlik, neon ----------------
  let myTuning = {};
  const tuneOf = (id) => (id && myTuning[id] && (myTuning[id].color || myTuning[id].neon)
    ? { color: myTuning[id].color || null, neon: myTuning[id].neon || null } : null);
  const tuneSpeed = (id) => 1 + 0.08 * Math.min(3, (id && myTuning[id] && myTuning[id].speed) || 0);

  async function loadTuning() {
    try {
      const d = await api('/api/game/garage');
      myTuning = d.tuning || {};
    } catch (err) {
      handleAuthError(err);
    }
  }

  function openGarage() {
    const st = { kind: 'garage', data: null, v: 0, car: me.car };
    openSheet(st);
    loadInto(st, '/api/game/garage', (d) => {
      st.data = d;
      myTuning = d.tuning || {};
      if (!st.car || !d.cars.some((c) => c.id === st.car)) st.car = d.cars.length ? d.cars[0].id : null;
    });
  }

  async function garageCall(st, body, okText) {
    try {
      const d = await api('/api/game/garage', { method: 'POST', body: { car: st.car, ...body } });
      localVersion += 1;
      st.data = d;
      st.v += 1;
      myTuning = d.tuning || {};
      setEconomy(d.economy);
      sound.cash();
      toast(okText, 'success');
    } catch (err) {
      if (!handleAuthError(err)) toast(err.message, 'warn');
    }
    renderSheet();
    return null;
  }

  function renderGarageSheet(body, st) {
    const d = st.data;
    setHead('hammer', 'Garaj', d ? "Mashinangizni o'zgartiring — hamma shunday ko'radi" : 'Yuklanmoqda…');
    if (!d) return;
    if (!d.cars.length) {
      body.append(el('p', 'sheet-note', "Sizda hali mashina yo'q — avval Avtosalondan oling."));
      return;
    }
    const chips = el('div', 'garage-cars');
    d.cars.forEach((c) => {
      const b = el('button', `chip${c.id === st.car ? ' is-on' : ''}`, c.name);
      b.type = 'button';
      b.addEventListener('click', () => { st.car = c.id; st.v += 1; renderSheet(); });
      chips.append(b);
    });
    body.append(chips);
    const car = d.cars.find((c) => c.id === st.car);
    // Rang
    const paint = el('div', 'looks-row');
    paint.append(el('strong', '', `Bo'yash — ${formatNumber(d.paint_price)} so'm`));
    const sw = el('div', 'swatches');
    d.colors.forEach((col) => {
      const b = el('button', `swatch${car.color === col ? ' is-on' : ''}`);
      b.type = 'button';
      b.style.setProperty('--sw', col);
      b.setAttribute('aria-label', `Rang ${col}`);
      b.addEventListener('click', () => garageCall(st, { action: 'paint', value: col }, `${car.name} bo'yaldi!`));
      sw.append(b);
    });
    paint.append(sw);
    // Neon
    const neon = el('div', 'looks-row');
    neon.append(el('strong', '', `Neon chiroq (pastdan) — ${formatNumber(d.neon_price)} so'm`));
    const nw = el('div', 'swatches');
    d.neons.forEach((col) => {
      const b = el('button', `swatch${car.neon === col ? ' is-on' : ''}`);
      b.type = 'button';
      b.style.setProperty('--sw', col);
      b.style.boxShadow = `0 0 10px ${col}`;
      b.setAttribute('aria-label', `Neon ${col}`);
      b.addEventListener('click', () => garageCall(st, { action: 'neon', value: col }, 'Neon chiroq yoqildi!'));
      nw.append(b);
    });
    if (car.neon) {
      const off = el('button', 'chip', "O'chirish");
      off.type = 'button';
      off.addEventListener('click', () => garageCall(st, { action: 'neon', value: '' }, "Neon olib tashlandi"));
      nw.append(off);
    }
    neon.append(nw);
    // Tezlik
    const speed = el('div', 'looks-row');
    speed.append(el('strong', '', `Dvigatel: +${Math.round(car.speed * d.step * 100)}% tezlik`));
    const steps = el('div', 'speed-steps');
    for (let i = 1; i <= d.max; i += 1) steps.append(el('span', i <= car.speed ? 'is-on' : ''));
    speed.append(steps);
    if (car.next_price) {
      speed.append(priceButton(`+${Math.round(d.step * 100)}% tezlik`, car.next_price,
        () => garageCall(st, { action: 'speed' }, 'Dvigatel kuchaytirildi!')));
    } else speed.append(el('small', '', 'Eng yuqori daraja'));
    body.append(paint, neon, speed);
  }

  // ---------------- Avtobus ishi ----------------
  let busJob = null;
  let busView = null;
  let busBusyUntil = 0;

  function setBus(b) {
    const prev = busJob ? busJob.next : null;
    busJob = b;
    if (!b) busView = dropBeacon(busView);
    else if (b.next !== prev || !busView) {
      busView = dropBeacon(busView);
      busView = makeBeacon(b.stop.x, b.stop.y, '#f97316', 110);
    }
    taxiCardKey = '';
    updateRideButton();
  }

  async function toggleBus() {
    try {
      if (busJob) {
        await api('/api/game/bus/end', { method: 'POST' });
        localVersion += 1;
        setBus(null);
        toast('Avtobus ishi tugadi');
        return;
      }
      const d = await api('/api/game/bus/start', { method: 'POST' });
      localVersion += 1;
      setBus(d.bus);
      if (ride) toast('Diqqat: taksidagi yo\'lovchi ham kutyapti');
      toast(`Avtobus ishi boshlandi! To'q sariq nurdagi ${d.bus.next + 1}-bekatga boring — ${d.bus.waiting} kishi kutyapti`, 'success');
    } catch (err) {
      if (!handleAuthError(err)) toast(err.message, 'warn');
    }
  }
  $('btn-bus').addEventListener('click', toggleBus);

  async function busTick() {
    if (!busJob || !me.car || performance.now() < busBusyUntil) return;
    if (Math.hypot(busJob.stop.x - me.x, busJob.stop.y - me.y) > 130) return;
    busBusyUntil = performance.now() + 1500;
    try {
      const d = await api('/api/game/bus/stop', { method: 'POST' });
      localVersion += 1;
      setEconomy(d.economy);
      setBus(d.bus);
      sound.cash();
      floatText(`+${formatNumber(d.earned + d.bonus)} so'm`, me.x, me.y, me.rig.root.position.y);
      toast(d.bonus
        ? `Aylana tugadi! ${d.people} yo'lovchi: +${formatNumber(d.earned)} va bonus +${formatNumber(d.bonus)} so'm`
        : `Bekat: ${d.people} yo'lovchi tushdi — +${formatNumber(d.earned)} so'm. Keyingi bekatga!`, 'success');
    } catch (err) {
      if (!handleAuthError(err)) busBusyUntil = performance.now() + 800;
    }
  }

  // Bekatlar: soyabon, skameyka va «BEKAT» belgisi
  function buildBusStops() {
    world.bus_stops.forEach((b, i) => {
      const g = new THREE.Group();
      const frame = mat('#1e3a8a', { metalness: 0.4, roughness: 0.4 });
      g.add(box(64, 30, 2, GLASS(), 0, 17, -14), box(70, 2.5, 30, frame, 0, 33, -2));
      [-32, 32].forEach((x) => g.add(box(2.5, 32, 2.5, frame, x, 16, -14), box(2.5, 32, 2.5, frame, x, 16, 10)));
      g.add(box(50, 3, 10, mat('#92400e'), 0, 11, -8));
      g.add(cyl(1.4, 1.4, 50, mat('#64748b'), 42, 25, 6, 8));
      const sign = signPlane(`BEKAT ${i + 1}`, 26, 10, '#2563eb', '#ffffff');
      sign.position.set(42, 48, 6);
      g.add(sign);
      g.position.set(b.x, 0, b.y);
      scene.add(g);
    });
  }

  // ---------------- Aeroport ----------------
  function buildAirport() {
    const A = world.airport;
    const R = A.rect;
    const g = new THREE.Group();
    const concrete = mat('#a8a29e', { roughness: 1 });
    const white = mat('#f8fafc', { roughness: 1 });
    // Ko'cha (1900-yo'l davomi) va beton maydon
    g.add(flat(R.x + R.w - world.w, 96, mat('#9ca3af', { roughness: 1 }), (world.w + R.x + R.w) / 2, 1940, 0.25));
    g.add(flat(R.x + R.w - world.w, 80, mat('#3b404c', { roughness: 0.95 }), (world.w + R.x + R.w) / 2, 1940, 0.45));
    g.add(flat(R.x + R.w - 6900, R.h - 120, concrete, (6900 + R.x + R.w) / 2, R.y + R.h / 2, 0.3));
    // Uchish yo'lagi
    const W = A.runway;
    const cx = W.x + W.w / 2;
    g.add(flat(W.w, W.h, mat('#1f2937', { roughness: 0.9 }), cx, W.y + W.h / 2, 0.5));
    g.add(flat(4, W.h, white, W.x + 6, W.y + W.h / 2, 0.6), flat(4, W.h, white, W.x + W.w - 6, W.y + W.h / 2, 0.6));
    for (let y = W.y + 160; y < W.y + W.h - 160; y += 110) g.add(flat(5, 55, white, cx, y, 0.6));
    [W.y + 40, W.y + W.h - 40].forEach((y) => {
      for (let i = 0; i < 6; i += 1) g.add(flat(8, 50, white, W.x + 18 + i * 22, y, 0.6));
    });
    // Terminal
    const T = A.terminal;
    const term = box(T.w, 60, T.h, mat('#e2e8f0'), T.x + T.w / 2, 30, T.y + T.h / 2);
    g.add(term, box(T.w - 30, 36, 2, GLASS(), T.x + T.w / 2, 26, T.y + T.h + 0.8));
    g.add(box(T.w + 20, 6, T.h + 20, mat('#1e3a8a'), T.x + T.w / 2, 63, T.y + T.h / 2));
    const sign = signPlane('AEROPORT', 180, 22, '#1e3a8a', '#ffffff');
    sign.position.set(T.x + T.w / 2, 78, T.y + T.h + 2);
    g.add(sign);
    // Reyslar joyi (gate)
    const gate = A.gate;
    [0, Math.PI].forEach((rot) => {
      // Ikki tomondan ham to'g'ri o'qiladi
      const gs = signPlane('REYSLAR · F', 70, 16, '#16a34a', '#ffffff');
      gs.material.side = THREE.FrontSide;
      gs.position.set(gate.x, 46, gate.y - 60 + (rot ? -0.6 : 0.6));
      gs.rotation.y = rot;
      g.add(gs);
    });
    g.add(cyl(1.6, 1.6, 40, mat('#64748b'), gate.x - 38, 20, gate.y - 60, 8), cyl(1.6, 1.6, 40, mat('#64748b'), gate.x + 38, 20, gate.y - 60, 8));
    const ring = new THREE.Mesh(new THREE.RingGeometry(120, 130, 48), new THREE.MeshBasicMaterial({ color: '#22c55e', transparent: true, opacity: 0.6, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(gate.x, 0.8, gate.y);
    g.add(ring);
    // Boshqaruv minorasi
    const tx = T.x + 140;
    const tz = T.y + 590;
    g.add(cyl(14, 18, 140, mat('#e5e7eb'), tx, 70, tz, 16), cyl(30, 26, 22, GLASS(), tx, 150, tz, 16), cyl(32, 32, 4, mat('#1e3a8a'), tx, 163, tz, 16));
    // Turgan samolyotlar (bezak)
    [[W.x - 170, R.y + 260, 0.3], [W.x - 170, R.y + R.h - 300, -0.3]].forEach(([x, z, rot]) => {
      const pl = carPlane('#f8fafc');
      pl.scale.setScalar(2.2);
      pl.position.set(x, 0, z);
      pl.rotation.y = Math.PI / 2 + rot;
      g.add(pl);
    });
    // Shamol yo'nalishi ko'rsatkichi
    g.add(cyl(1.2, 1.2, 40, mat('#64748b'), W.x + W.w + 60, 20, W.y + 120, 6));
    const sock = mesh(new THREE.ConeGeometry(6, 26, 10, 1, true), mat('#f97316'), W.x + W.w + 72, 38, W.y + 120);
    sock.rotation.z = Math.PI / 2;
    g.add(sock);
    scene.add(g);
  }

  // ---------------- Reys (boshqa shaharga) ----------------
  let flight = null;

  function setFlight(f) {
    if (!f) {
      flight = null;
      $('flight').hidden = true;
      return;
    }
    flight = { ...f, endsAt: performance.now() + f.left * 1000, landing: false };
    me.fly = true;
    $('flight').hidden = false;
    $('flight-title').textContent = `${f.name}ga uchyapsiz ✈️`;
  }

  async function landFlight() {
    flight.landing = true;
    try {
      const d = await api('/api/game/flight/land', { method: 'POST' });
      localVersion += 1;
      setEconomy(d.economy);
      sound.cash();
      toast(`${d.name}ga yetib bordingiz va qaytdingiz! Yo'lovchilar to'ladi: +${formatNumber(d.reward)} so'm`, 'success');
      setFlight(null);
      me.fly = false;
    } catch (err) {
      if (handleAuthError(err)) return;
      flight.landing = false;
      flight.endsAt = performance.now() + 1500;
    }
  }

  function updateFlight(now) {
    if (!flight) return;
    const left = Math.max(0, (flight.endsAt - now) / 1000);
    $('flight-fill').style.width = `${Math.min(100, (1 - left / flight.seconds) * 100)}%`;
    $('flight-sub').textContent = left > 0
      ? `Qo'nishga ${Math.ceil(left)} soniya · mukofot ${formatNumber(flight.reward)} so'm`
      : "Qo'nyapmiz…";
    if (left <= 0 && !flight.landing) landFlight();
  }

  function openFlights() {
    const st = { kind: 'flights', data: null, v: 0 };
    openSheet(st);
    loadInto(st, '/api/game/flights', (d) => { st.data = d; });
  }

  function renderFlightsSheet(body, st) {
    setHead('plane', 'Reyslar', 'Yo\'lovchilarni boshqa shaharga olib boring');
    if (!st.data) return;
    const list = el('div', 'car-list');
    st.data.flights.forEach((f) => {
      const r = el('div', 'car-row');
      const sw = el('span', 'car-row__swatch');
      sw.style.setProperty('--car', '#0ea5e9');
      sw.append(icon('plane'));
      const info = el('div', 'car-row__info');
      info.append(el('strong', '', f.name), el('small', '', `${f.seconds} soniya uchish · +${formatNumber(f.reward)} so'm`));
      r.append(sw, info, actionBtn('plane', 'Uchish', async () => {
        try {
          const d = await api('/api/game/flight/start', { method: 'POST', body: { dest: f.id } });
          localVersion += 1;
          closeSheet();
          setFlight(d.flight);
          sound.whoosh(true);
        } catch (err) {
          if (!handleAuthError(err)) toast(err.message, 'warn');
        }
      }));
      list.append(r);
    });
    body.append(list, el('p', 'sheet-note', "Uchish paytida samolyot boshqarilmaydi. Qo'ngandan keyin yana aeroportdasiz."));
  }

  // ---------------- Kunlik vazifalar ----------------
  function openDaily() {
    const st = { kind: 'daily', data: null, v: 0 };
    openSheet(st);
    loadInto(st, '/api/game/daily', (d) => { st.data = d; setEconomy(d.economy); });
  }

  async function claimDaily(st, id) {
    try {
      const d = await api('/api/game/daily/claim', { method: 'POST', body: { id } });
      localVersion += 1;
      st.data = d;
      st.v += 1;
      setEconomy(d.economy);
      sound.cash();
      toast('Mukofot olindi!', 'success');
    } catch (err) {
      if (!handleAuthError(err)) toast(err.message, 'warn');
    }
    renderSheet();
    return null;
  }

  function renderDailySheet(body, st) {
    const d = st.data;
    setHead('check', 'Kunlik vazifalar', d ? `Bugun (${d.day}) · ertaga yangilari chiqadi` : 'Yuklanmoqda…');
    if (!d) return;
    d.tasks.forEach((t) => {
      const done = t.done >= t.need;
      const row = el('div', `daily-row${done ? ' is-done' : ''}`);
      const top = el('div', 'daily-row__top');
      top.append(el('strong', '', t.text));
      if (t.claimed) top.append(el('small', '', 'Olindi ✓'));
      else if (done) top.append(actionBtn('coins', `+${formatNumber(t.reward)} so'm olish`, () => claimDaily(st, t.id)));
      else top.append(el('small', '', `+${formatNumber(t.reward)} so'm`));
      const bar = el('div', 'floors__bar');
      const fill = el('span', 'floors__fill');
      fill.style.width = `${Math.max(2, (t.done / t.need) * 100)}%`;
      bar.append(fill);
      row.append(top, bar, el('small', '', `${t.done} / ${t.need}`));
      body.append(row);
    });
    const all = d.tasks.every((t) => t.claimed);
    const bonus = el('div', `daily-row${d.bonus_claimed ? ' is-done' : ''}`);
    const top = el('div', 'daily-row__top');
    top.append(el('strong', '', `Hammasini bajarsangiz — bonus ${formatNumber(d.bonus)} so'm`));
    if (d.bonus_claimed) top.append(el('small', '', 'Olindi ✓'));
    else {
      const b = actionBtn('trophy', 'Bonusni olish', () => claimDaily(st, 'bonus'));
      b.disabled = !all;
      top.append(b);
    }
    bonus.append(top);
    body.append(bonus);
  }

  // ---------------- Omad g'ildiragi ----------------
  const WHEEL_COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#facc15'];
  const shortSum = (v) => (v >= 1000000 ? `${v / 1000000} mln` : `${v / 1000} ming`);

  function openSpin() {
    const st = { kind: 'spin', data: null, v: 0, angle: 0, spinning: false };
    openSheet(st);
    loadInto(st, '/api/game/spin', (d) => { st.data = d; });
  }

  function drawWheel(canvas, prizes) {
    const g = canvas.getContext('2d');
    const n = prizes.length;
    const c = canvas.width / 2;
    const seg = (Math.PI * 2) / n;
    prizes.forEach((p, i) => {
      // i-bo'lak markazi tepada (-90°) bo'lishi uchun
      const a0 = -Math.PI / 2 + i * seg - seg / 2;
      g.beginPath();
      g.moveTo(c, c);
      g.arc(c, c, c - 4, a0, a0 + seg);
      g.closePath();
      g.fillStyle = WHEEL_COLORS[i % WHEEL_COLORS.length];
      g.fill();
      g.save();
      g.translate(c, c);
      g.rotate(a0 + seg / 2);
      g.fillStyle = '#ffffff';
      g.font = '700 22px system-ui, sans-serif';
      g.textAlign = 'right';
      g.textBaseline = 'middle';
      g.fillText(shortSum(p), c - 18, 0);
      g.restore();
    });
    g.beginPath();
    g.arc(c, c, 26, 0, Math.PI * 2);
    g.fillStyle = '#ffffff';
    g.fill();
  }

  function renderSpinSheet(body, st) {
    const d = st.data;
    setHead('rotate', "Omad g'ildiragi", d ? (d.ready ? 'Kuniga 1 marta bepul aylantiring!' : 'Bugun aylantirdingiz — ertaga yana keling') : 'Yuklanmoqda…');
    if (!d) return;
    const wrap = el('div', 'wheel');
    const canvas = el('canvas');
    canvas.width = 560;
    canvas.height = 560;
    canvas.style.transform = `rotate(${st.angle}deg)`;
    drawWheel(canvas, d.prizes);
    wrap.append(canvas, el('span', 'wheel__pin'));
    const btn = actionBtn('rotate', st.spinning ? 'Aylanmoqda…' : 'Aylantirish', async () => {
      btn.disabled = true;
      try {
        const r = await api('/api/game/spin', { method: 'POST' });
        localVersion += 1;
        st.spinning = true;
        const seg = 360 / d.prizes.length;
        // Yutgan bo'lak tepadagi ko'rsatkich tagiga keladi
        st.angle = Math.ceil(st.angle / 360) * 360 + 360 * 6 - r.index * seg;
        canvas.style.transform = `rotate(${st.angle}deg)`;
        setTimeout(() => {
          st.spinning = false;
          d.ready = false;
          st.v += 1;
          setEconomy(r.economy);
          sound.cash();
          toast(`Tabriklaymiz! +${formatNumber(r.prize)} so'm`, 'success');
          if (sheetState === st) renderSheet();
        }, 4300);
      } catch (err) {
        if (!handleAuthError(err)) toast(err.message, 'warn');
        btn.disabled = false;
      }
    }, 'btn btn--primary btn--block');
    btn.disabled = !d.ready || st.spinning;
    body.append(wrap, btn);
  }

  // ---------------- Mahalla bayrami ----------------
  let fest = null;
  let festCardSig = '';
  let fireworkAt = 0;
  const sparks = [];
  const sparkGeo = new THREE.SphereGeometry(2.6, 6, 4);

  function setFest(f) {
    if (!f) {
      fest = null;
      return;
    }
    fest = { ...f, endsAt: performance.now() + f.left * 1000 };
  }

  function updateFestCard() {
    let sig = '';
    if (fest) {
      const left = Math.max(0, Math.ceil((fest.endsAt - performance.now()) / 1000));
      const mm = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      sig = `${fest.name}|${mm}|${fest.claimed}|${fest.count}`;
      if (sig !== festCardSig) {
        $('fest-title').textContent = `🎉 Mahalla bayrami — ${fest.name}`;
        $('fest-sub').textContent = fest.claimed
          ? `Sovg'a olindi ✓ · ${mm} · keldi: ${fest.count} kishi`
          : `${mm} ichida keling — har kimga ${formatNumber(fest.prize)} so'm!`;
      }
    }
    if (sig === festCardSig) return;
    festCardSig = sig;
    $('fest-card').hidden = !fest;
  }
  $('fest-go').addEventListener('click', () => {
    if (fest) setGuide(fest.x, fest.y, 'Bayram');
  });

  function stepFireworks(dt, now) {
    const fw = fest || weddings[0] || null;
    if (fw && now > fireworkAt && Math.hypot(fw.x - me.x, fw.y - me.y) < 2500) {
      fireworkAt = now + 500 + Math.random() * 500;
      const color = WHEEL_COLORS[Math.floor(Math.random() * WHEEL_COLORS.length)];
      const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, fog: false });
      const ox = fw.x + (Math.random() - 0.5) * 300;
      const oz = fw.y + (Math.random() - 0.5) * 300;
      const oy = 180 + Math.random() * 120;
      for (let i = 0; i < 28; i += 1) {
        const a = Math.random() * Math.PI * 2;
        const b = Math.acos(Math.random() * 2 - 1);
        const sp = 90 + Math.random() * 60;
        const p2 = new THREE.Mesh(sparkGeo, m);
        p2.position.set(ox, oy, oz);
        scene.add(p2);
        sparks.push({ m: p2, mat: m, t: 0, vx: Math.sin(b) * Math.cos(a) * sp, vy: Math.cos(b) * sp, vz: Math.sin(b) * Math.sin(a) * sp });
      }
    }
    for (let i = sparks.length - 1; i >= 0; i -= 1) {
      const s2 = sparks[i];
      s2.t += dt;
      s2.vy -= 70 * dt;
      s2.m.position.x += s2.vx * dt;
      s2.m.position.y += s2.vy * dt;
      s2.m.position.z += s2.vz * dt;
      s2.mat.opacity = Math.max(0, 1 - s2.t / 1.6);
      if (s2.t > 1.6) {
        scene.remove(s2.m);
        sparks.splice(i, 1);
        if (!sparks.some((o) => o.mat === s2.mat)) s2.mat.dispose();
      }
    }
  }

  function openFestAdmin() {
    const st = { kind: 'festadmin', data: null, v: 0, place: 'fountain', prize: '50 000', minutes: 5 };
    openSheet(st);
    loadInto(st, '/api/game/fest', (d) => { st.data = d; });
  }

  function renderFestAdminSheet(body, st) {
    setHead('megaphone', 'Mahalla bayrami', "Hammani bir joyga yig'ing — kelganlar sovg'a oladi");
    const d = st.data;
    if (!d) return;
    if (d.fest) {
      const box2 = el('div', 'offer');
      box2.append(el('strong', '', `Bayram davom etyapti: ${d.fest.name}`),
        el('span', '', `Kelganlar: ${d.fest.count} · sovg'a ${formatNumber(d.fest.prize)} so'm · ${Math.ceil(d.fest.left / 60)} daqiqa qoldi`),
        actionBtn('x', 'Bayramni tugatish', async () => {
          await api('/api/game/fest/stop', { method: 'POST' }).catch(() => null);
          toast('Bayram tugadi');
          loadInto(st, '/api/game/fest', (x) => { st.data = x; });
        }, 'btn btn--ghost btn--block'));
      body.append(box2);
      return;
    }
    const where = el('div', 'looks-row');
    where.append(el('strong', '', 'Qayerda?'));
    const chips = el('div', 'chips');
    d.places.forEach((p2) => {
      const b = el('button', `chip${st.place === p2.id ? ' is-on' : ''}`, p2.name);
      b.type = 'button';
      b.addEventListener('click', () => { st.place = p2.id; st.v += 1; renderSheet(); });
      chips.append(b);
    });
    where.append(chips);
    const prize = el('div', 'sale');
    const input = amountInput({ draft: st.prize }, "Har kimga sovg'a (so'm)");
    input.addEventListener('input', () => { st.prize = input.value; });
    prize.append(el('strong', 'sale__title', "Har bir kelganga sovg'a"), input);
    const mins = el('div', 'looks-row');
    mins.append(el('strong', '', 'Davomiyligi'));
    const mc = el('div', 'chips');
    [2, 5, 10, 15, 30].forEach((m2) => {
      const b = el('button', `chip${st.minutes === m2 ? ' is-on' : ''}`, `${m2} daqiqa`);
      b.type = 'button';
      b.addEventListener('click', () => { st.minutes = m2; st.v += 1; renderSheet(); });
      mc.append(b);
    });
    mins.append(mc);
    body.append(where, prize, mins, actionBtn('megaphone', 'Bayramni boshlash', async () => {
      const amount = parseAmount(st.prize);
      if (!amount) return toast("Sovg'a summasini yozing", 'warn');
      try {
        const r = await api('/api/game/fest/start', { method: 'POST', body: { place: st.place, prize: amount, minutes: st.minutes } });
        setFest(r.fest);
        toast("Bayram boshlandi! Hammaga xabar ketdi", 'success');
        closeSheet();
      } catch (err) {
        if (!handleAuthError(err)) toast(err.message, 'warn');
      }
      return null;
    }, 'btn btn--primary btn--block'));
  }

  // ---------------- Ob-havo: quyosh, yomg'ir, qor ----------------
  // Hamma bir xil ob-havoni ko'radi: u vaqtga bog'liq (har 5 daqiqada o'zgarishi mumkin)
  const WEATHER_MS = 5 * 60 * 1000;
  const WEATHER = {
    clear: { name: 'Ochiq havo', cloud: 0, fog: 1, grip: { base: 0, drift: 1.7 } },
    rain: { name: "Yomg'ir", cloud: 0.75, fog: 0.62, grip: { base: 4.5, drift: 1.15 } },
    snow: { name: 'Qor', cloud: 0.6, fog: 0.5, grip: { base: 2.8, drift: 0.85 } },
    storm: { name: "Bo'ron", cloud: 0.95, fog: 0.45, grip: { base: 5, drift: 1.1 } },
  };
  const STORM_SKY = new THREE.Color('#7b8794');
  const NIGHT_STORM = new THREE.Color('#141a26');
  const forcedWeather = new URLSearchParams(window.location.search).get('weather');
  const weather = { kind: 'clear', level: 0, cover: 0, flashUntil: 0, nextBolt: 0, announced: null };
  let rainView = null;
  let snowView = null;
  let snowCover = null;
  const RAIN_N = TOUCH ? 1200 : 2600;
  const SNOW_N = TOUCH ? 900 : 1800;
  const BOX = { w: 1700, h: 760 };

  function weatherAt(t) {
    if (WEATHER[forcedWeather]) return forcedWeather;
    const block = Math.floor(t / WEATHER_MS);
    const h = Math.abs(Math.sin(block * 12.9898 + 78.233) * 43758.5453) % 1;
    const m = new Date(t).getMonth() + 1;
    if (m === 12 || m <= 2) return h < 0.4 ? 'clear' : (h < 0.5 ? 'storm' : 'snow');      // qish: ko'proq qor
    if (m >= 6 && m <= 8) return h < 0.6 ? 'clear' : (h < 0.85 ? 'rain' : 'storm');      // yoz: qor yo'q
    return h < 0.45 ? 'clear' : (h < 0.7 ? 'rain' : (h < 0.85 ? 'storm' : 'snow'));
  }
  function weatherLeftText() {
    if (WEATHER[forcedWeather]) return 'doimiy';
    const left = WEATHER_MS - (Date.now() % WEATHER_MS);
    return `${Math.ceil(left / 60000)} daqiqadan keyin o'zgarishi mumkin`;
  }
  const weatherCloud = () => (weather.kind === 'clear' ? 0 : WEATHER[weather.kind].cloud * weather.level);
  const weatherFog = () => 1 - (1 - WEATHER[weather.kind].fog) * weather.level;
  function roadGrip() {
    const g = WEATHER[weather.kind].grip;
    const l = weather.level;
    return { base: g.base && l > 0.3 ? g.base : 0, drift: 1.7 + (g.drift - 1.7) * l };
  }

  function buildWeather() {
    // Yomg'ir — qisqa tik chiziqlar, qor — oq nuqtalar; ikkalasi ham o'yinchi atrofida aylanib turadi
    const rp = new Float32Array(RAIN_N * 6);
    for (let i = 0; i < RAIN_N; i += 1) {
      const x = (Math.random() - 0.5) * BOX.w;
      const y = Math.random() * BOX.h;
      const z = (Math.random() - 0.5) * BOX.w;
      rp.set([x, y, z, x + 1.5, y + 22, z], i * 6);
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(rp, 3));
    rainView = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: '#c7d7ea', transparent: true, opacity: 0.55, depthWrite: false }));
    rainView.frustumCulled = false;
    rainView.visible = false;
    const sp = new Float32Array(SNOW_N * 3);
    for (let i = 0; i < SNOW_N; i += 1) sp.set([(Math.random() - 0.5) * BOX.w, Math.random() * BOX.h, (Math.random() - 0.5) * BOX.w], i * 3);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    snowView = new THREE.Points(sg, new THREE.PointsMaterial({ color: '#ffffff', size: 5, transparent: true, opacity: 0.9, depthWrite: false }));
    snowView.frustumCulled = false;
    snowView.visible = false;
    // Qor qoplami: yo'llar ostida, o't va hovlilar ustida
    snowCover = flat(world.w + 400, world.h + 400, new THREE.MeshStandardMaterial({
      color: '#f8fafc', transparent: true, opacity: 0, roughness: 1, depthWrite: false,
    }), world.w / 2, world.h / 2, 0.4);
    snowCover.visible = false;
    scene.add(rainView, snowView, snowCover);
  }

  function stepWeather(dt, now) {
    if (!rainView) return;
    const want = weatherAt(Date.now());
    // Almashish: avval eskisi to'xtaydi, keyin yangisi asta boshlanadi
    if (want !== weather.kind) {
      weather.level = Math.max(0, weather.level - dt / 6);
      if (weather.level === 0) weather.kind = want;
    } else weather.level = Math.min(1, weather.level + dt / 8);
    if (weather.kind !== weather.announced && weather.level > 0.15) {
      if (weather.announced !== null) {
        if (weather.kind === 'rain') toast("Yomg'ir yog'yapti — yo'l sirpanchiq, drift oson! 🌧️");
        else if (weather.kind === 'storm') toast("Bo'ron! Kuchli yomg'ir va chaqmoq ⛈️ — tugagach kamalak chiqadi");
        else if (weather.kind === 'snow') toast("Qor yog'yapti — yo'l muz, ehtiyot bo'ling (yoki drift qiling) ❄️");
        else toast('Havo ochildi ☀️');
      }
      weather.announced = weather.kind;
    }
    if (weather.announced === null) weather.announced = weather.kind;
    const cx = camera.position.x;
    const cz = camera.position.z;
    const base = Math.max(0, camera.position.y - BOX.h * 0.75);
    // Yomg'ir
    const rainOn = (weather.kind === 'rain' || weather.kind === 'storm') && weather.level > 0.02;
    rainView.visible = rainOn;
    if (rainOn) {
      rainView.material.opacity = 0.55 * weather.level;
      rainView.position.set(cx, base, cz);
      const a = rainView.geometry.attributes.position.array;
      const fall = 900 * dt;
      for (let i = 0; i < a.length; i += 6) {
        a[i + 1] -= fall;
        a[i + 4] -= fall;
        if (a[i + 1] < 0) {
          a[i + 1] += BOX.h;
          a[i + 4] += BOX.h;
        }
      }
      rainView.geometry.attributes.position.needsUpdate = true;
      // Chaqmoq va momaqaldiroq
      if (weather.level > 0.8 && now > weather.nextBolt) {
        weather.nextBolt = now + (weather.kind === 'storm' ? 3000 + Math.random() * 5000 : 18000 + Math.random() * 25000);
        if (weather.nextBolt - now < 60000 && Math.random() < 0.8) {
          weather.flashUntil = now + 160;
          setTimeout(() => sound.thunder(), 600 + Math.random() * 1200);
        }
      }
    }
    renderer.toneMappingExposure = now < weather.flashUntil ? 2.6 : 1.05;
    sound.rain(rainOn ? weather.level : 0);
    // Qor
    const snowOn = weather.kind === 'snow' && weather.level > 0.02;
    snowView.visible = snowOn;
    if (snowOn) {
      snowView.material.opacity = 0.9 * weather.level;
      snowView.position.set(cx, base, cz);
      const a = snowView.geometry.attributes.position.array;
      const t = now / 1000;
      for (let i = 0; i < a.length; i += 3) {
        a[i + 1] -= 70 * dt;
        a[i] += Math.sin(t + i) * 12 * dt;
        if (a[i + 1] < 0) a[i + 1] += BOX.h;
      }
      snowView.geometry.attributes.position.needsUpdate = true;
    }
    // Qor asta yerni qoplaydi, havo ochilsa — eriydi
    weather.cover = clamp(weather.cover + (snowOn ? dt / 50 : -dt / 40) * (snowOn ? weather.level : 1), 0, 1);
    snowCover.visible = weather.cover > 0.01;
    snowCover.material.opacity = weather.cover * 0.8;
  }

  // =====================================================================
  //  Ishlar, joylar, o'yinlar va do'stlar (game_fun.py bilan ishlaydi)
  // =====================================================================
  const isRider = (car) => Boolean(car && ['bike', 'skate', 'carpet', 'horse'].includes(car.style));
  const inPool = (x, y) => Boolean(world.aqua && inside(x, y, world.aqua.pool)) || Boolean(world.town && inside(x, y, world.town.sea));

  // ---------------- Velosiped va skeytbord ----------------
  function carBike(color) {
    const g = new THREE.Group();
    const frame = mat(color, { metalness: 0.5, roughness: 0.35 });
    const dark = mat('#111827');
    [-14, 14].forEach((z) => {
      const tire = mesh(new THREE.TorusGeometry(7, 1.3, 8, 20), dark, 0, 7.5, z);
      tire.rotation.y = Math.PI / 2;
      g.add(tire);
    });
    const bar = (len, x, y, z, rx) => { const b = box(1.6, len, 1.6, frame, x, y, z); b.rotation.x = rx; g.add(b); };
    bar(26, 0, 13, 0, Math.PI / 2.6);
    bar(16, 0, 12, -8, -0.4);
    bar(14, 0, 13, 9, 0.35);
    g.add(box(4, 1.5, 7, dark, 0, 19, -6), box(14, 1.4, 1.4, dark, 0, 21, 12));
    const wheels = [];
    g.userData = { wheels, pods: [], r: 7, roof: 20 };
    return g;
  }
  function carSkate(color) {
    const g = new THREE.Group();
    g.add(box(10, 1.6, 30, mat(color, { roughness: 0.6 }), 0, 4, 0));
    [-10, 10].forEach((z) => [-4, 4].forEach((x) => g.add(cyl(1.6, 1.6, 2, mat('#f8fafc'), x, 1.8, z, 8))));
    g.userData = { wheels: [], pods: [], r: 2, roof: 8 };
    return g;
  }
  CAR_BUILDERS.bike = carBike;
  CAR_BUILDERS.skate = carSkate;

  // ---------------- Kir mashina va avtoyuvish ----------------
  let dirt = {};
  try { dirt = JSON.parse(localStorage.getItem('oyin-dirt') || '{}') || {}; } catch { dirt = {}; }
  let dirtSaveAt = 0;
  const dirtOf = (id) => (id ? Math.min(1, dirt[id] || 0) : 0);

  function stepDirt(dt, now) {
    if (!me.car || isRider(carInfo()) || !me.moving || weather.kind === 'clear') return;
    dirt[me.car] = Math.min(1, (dirt[me.car] || 0) + dt * 0.012 * weather.level);
    if (now - dirtSaveAt > 3000) {
      dirtSaveAt = now;
      try { localStorage.setItem('oyin-dirt', JSON.stringify(dirt)); } catch { /* e'tiborsiz */ }
    }
  }

  function applyDirt(rig, level) {
    if (!rig.car) return;
    if (!rig.dirtMesh && level > 0.04) {
      const bb = new THREE.Box3().setFromObject(rig.car);
      const size = bb.getSize(new THREE.Vector3());
      const c = bb.getCenter(new THREE.Vector3());
      rig.dirtMesh = new THREE.Mesh(new THREE.BoxGeometry(size.x * 1.02, size.y * 0.7, size.z * 1.02),
        new THREE.MeshStandardMaterial({ color: '#6b4f2a', transparent: true, opacity: 0, roughness: 1, depthWrite: false }));
      rig.dirtMesh.position.set(0, c.y - rig.car.position.y - size.y * 0.12, 0);
      rig.car.add(rig.dirtMesh);
    }
    if (rig.dirtMesh) rig.dirtMesh.material.opacity = level * 0.45;
  }

  async function washCar() {
    try {
      const d = await api('/api/game/wash', { method: 'POST' });
      localVersion += 1;
      setEconomy(d.economy);
      dirt[me.car] = 0;
      try { localStorage.setItem('oyin-dirt', JSON.stringify(dirt)); } catch { /* e'tiborsiz */ }
      for (let i = 0; i < 40; i += 1) smokeAt(me.x + (Math.random() - 0.5) * 60, me.y + (Math.random() - 0.5) * 60, Math.random() * 6);
      sound.whoosh(true);
      toast("Mashina yap-yangi bo'ldi! ✨", 'success');
    } catch (err) {
      if (!handleAuthError(err)) toast(err.message, 'warn');
    }
  }

  // ---------------- Raqs va emojilar ----------------
  const EMOJIS = ['😂', '👍', '🔥', '❤️', '😮', '😎', '👋', '🎉'];
  const emojiTextures = new Map();
  function emojiSprite(e) {
    if (!emojiTextures.has(e)) {
      const c = document.createElement('canvas');
      c.width = 128;
      c.height = 128;
      const g = c.getContext('2d');
      g.fillStyle = 'rgba(255,255,255,.92)';
      g.beginPath();
      g.arc(64, 60, 54, 0, Math.PI * 2);
      g.fill();
      g.font = '72px "Segoe UI Emoji", "Apple Color Emoji", sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(e, 64, 64);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      emojiTextures.set(e, tex);
    }
    const s2 = new THREE.Sprite(new THREE.SpriteMaterial({ map: emojiTextures.get(e), depthTest: false, transparent: true }));
    s2.scale.set(30, 30, 1);
    s2.renderOrder = 11;
    return s2;
  }

  function setEmote(rig, e) {
    if ((rig.emoteKey || null) === (e || null)) return;
    rig.emoteKey = e || null;
    if (rig.emoteSprite) {
      rig.root.remove(rig.emoteSprite);
      rig.emoteSprite.material.dispose();
      rig.emoteSprite = null;
    }
    if (e) {
      rig.emoteSprite = emojiSprite(e);
      rig.root.add(rig.emoteSprite);
    }
  }

  async function sendEmote(e) {
    me.emote = { e, until: performance.now() + 4000 };
    $('emoji-bar').hidden = true;
    try {
      await api('/api/game/emote', { method: 'POST', body: { e } });
    } catch (err) {
      handleAuthError(err);
    }
  }

  function toggleDance() {
    if (me.car || me.seat) {
      toast('Raqs uchun piyoda bo\'ling', 'warn');
      return;
    }
    me.dance = !me.dance;
    $('emoji-bar').hidden = true;
    if (me.dance) toast('Raqs! 💃 Yursangiz to\'xtaydi. (G)');
  }

  (() => {
    const bar = $('emoji-bar');
    EMOJIS.forEach((e) => {
      const b = el('button', 'emoji-bar__btn', e);
      b.type = 'button';
      b.addEventListener('click', () => sendEmote(e));
      bar.append(b);
    });
    const d = el('button', 'emoji-bar__btn emoji-bar__dance', '💃');
    d.type = 'button';
    d.title = 'Raqs (G)';
    d.addEventListener('click', toggleDance);
    bar.append(d);
    $('btn-emoji').addEventListener('click', () => { bar.hidden = !bar.hidden; });
  })();

  // ---------------- Ishlar: pochtachi va pitsa ----------------
  let job = null;
  let jobView = null;
  let jobBusyUntil = 0;
  const JOB_NAMES = { post: 'Pochtachi', pizza: 'Pitsa yetkazish', build: 'Qurilish ishi' };

  function setJob(j) {
    const key = j ? `${j.phase}|${j.x}|${j.y}` : '';
    const prevKey = job ? `${job.phase}|${job.x}|${job.y}` : '';
    job = j ? { ...j, deadlineAt: j.deadline != null ? performance.now() + j.deadline * 1000 : null } : null;
    if (key !== prevKey) {
      jobView = dropBeacon(jobView);
      if (job) jobView = makeBeacon(job.x, job.y, '#a855f7', 90);
    }
    taxiCardKey = '';
  }

  async function startJob(kind) {
    try {
      const d = await api('/api/game/job/start', { method: 'POST', body: { kind } });
      localVersion += 1;
      setJob(d.job);
      closeSheet();
      toast({ post: "Pochtaga boring (binafsha nur) — 3 ta posilka olasiz", pizza: "Pitsaxonaga boring (binafsha nur) — pitsani olib, issiqligida yetkazing",
        build: "Qurilish bazasiga boring (binafsha nur) — materiallarni olib, 3 ta binoni qurib bering" }[kind], 'success');
    } catch (err) {
      if (!handleAuthError(err)) toast(err.message, 'warn');
    }
  }

  async function endJob() {
    try {
      await api('/api/game/job/end', { method: 'POST' });
    } catch (err) {
      handleAuthError(err);
    }
    localVersion += 1;
    setJob(null);
    toast('Ish tugatildi');
  }

  async function jobTick() {
    if (!job || performance.now() < jobBusyUntil) return;
    if (Math.hypot(job.x - me.x, job.y - me.y) > 100) return;
    jobBusyUntil = performance.now() + 1500;
    try {
      const d = await api('/api/game/job/step', { method: 'POST' });
      localVersion += 1;
      setEconomy(d.economy);
      setJob(d.job);
      if (d.pay) {
        sound.cash();
        floatText(`+${formatNumber(d.pay)} so'm`, me.x, me.y, me.rig.root.position.y);
      } else sound.ding();
      toast(d.message, 'success');
    } catch (err) {
      if (!handleAuthError(err)) jobBusyUntil = performance.now() + 700;
    }
  }

  // ---------------- Baliq ovlash ----------------
  const fish = { on: false, biteAt: 0, view: null };
  function nearPondEdge() {
    const pd = world.pond;
    const cx = pd.x + pd.w / 2;
    const cy = pd.y + pd.h / 2;
    const k = Math.hypot((me.x - cx) / (pd.w / 2), (me.y - cy) / (pd.h / 2));
    return (k >= 0.85 && k <= 1.5) || onBridge();
  }
  function dropBobber() {
    if (fish.view) {
      scene.remove(fish.view);
      disposeTree(fish.view);
      fish.view = null;
    }
  }
  async function castLine() {
    try {
      const d = await api('/api/game/fish/cast', { method: 'POST' });
      fish.on = true;
      fish.biteAt = performance.now() + d.bite_in * 1000;
      const pd = world.pond;
      const cx = pd.x + pd.w / 2;
      const cy = pd.y + pd.h / 2;
      let bx = me.x + (cx - me.x) * 0.35;
      let by = me.y + (cy - me.y) * 0.35;
      if (onBridge()) { // ko'prikdan — yon tomondagi daryoga
        bx = me.x + 95;
        by = me.y;
      }
      dropBobber();
      fish.view = new THREE.Group();
      fish.view.add(mesh(new THREE.SphereGeometry(3, 10, 8), mat('#ef4444'), 0, 2, 0), mesh(new THREE.SphereGeometry(2.6, 10, 8), mat('#f8fafc'), 0, 0, 0));
      fish.view.position.set(bx, 1, by);
      scene.add(fish.view);
      sound.whoosh(false);
      toast("Qarmoq tashlandi... po'kak cho'kkanda F ni bosing!");
    } catch (err) {
      if (!handleAuthError(err)) toast(err.message, 'warn');
    }
  }
  async function pullLine() {
    fish.on = false;
    dropBobber();
    try {
      const d = await api('/api/game/fish/pull', { method: 'POST' });
      if (d.caught) {
        localVersion += 1;
        setEconomy(d.economy);
        sound.cash();
        toast(`🎣 ${d.caught.name} — ${String(d.caught.kg).replace('.', ',')} kg! Sotildi: +${formatNumber(d.caught.price)} so'm`, 'success');
      } else toast(d.message, 'warn');
    } catch (err) {
      if (!handleAuthError(err)) toast(err.message, 'warn');
    }
  }
  function stepFishing(now) {
    if (!fish.on || !fish.view) return;
    const biting = now >= fish.biteAt && now <= fish.biteAt + 2000;
    fish.view.position.y = biting ? -2 + Math.sin(now / 60) * 1.5 : 1 + Math.sin(now / 400) * 0.6;
    if (biting && !fish.rang) {
      fish.rang = true;
      sound.ding();
    }
    if (!biting) fish.rang = false;
    if (now > fish.biteAt + 2600) {
      fish.on = false;
      dropBobber();
      toast('Baliq xo\'rakni yeb qochdi. Yana urinib ko\'ring', 'warn');
      api('/api/game/fish/pull', { method: 'POST' }).catch(() => null);
    }
    if (Math.hypot(fish.view.position.x - me.x, fish.view.position.z - me.y) > 260) {
      fish.on = false;
      dropBobber();
    }
  }

  // ---------------- Parashyut ----------------
  let canopy = null;
  function jumpParachute() {
    if (!me.car || !carInfo().flies || me.h < 200) return;
    me.car = null; // samolyot sizniki bo'lib qoladi
    me.fly = false;
    me.para = true;
    me.vh = 0;
    me.dance = false;
    sound.door();
    updateRideButton();
    toast('Parashyut ochildi! 🪂 Futbol maydonidagi nishonga qo\'ning — 5 000 so\'m', 'success');
  }
  async function landParachute() {
    me.para = false;
    try {
      const d = await api('/api/game/para/land', { method: 'POST' });
      localVersion += 1;
      setEconomy(d.economy);
      if (d.hit) {
        sound.cash();
        toast(`Nishonga aniq qo'ndingiz! +${formatNumber(d.reward)} so'm 🎯`, 'success');
      } else toast("Yerga qo'ndingiz. Nishon — futbol maydonining o'rtasida");
    } catch (err) {
      handleAuthError(err);
    }
  }
  function stepParachuteVisual() {
    const show = Boolean(me.para && me.h > 0);
    if (show && !canopy) {
      canopy = new THREE.Group();
      const dome = mesh(new THREE.SphereGeometry(38, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2.4), mat('#f97316', { side: THREE.DoubleSide }), 0, 118, 0, false);
      canopy.add(dome);
      [[-26, -10], [26, -10], [-26, 10], [26, 10]].forEach(([x, z]) => {
        const line = box(0.6, 62, 0.6, mat('#e5e7eb'), x * 0.6, 88, z * 0.6);
        line.rotation.z = x > 0 ? -0.35 : 0.35;
        canopy.add(line);
      });
      me.rig.root.add(canopy);
    }
    if (canopy) canopy.visible = show;
    $('btn-para').hidden = !(me.car && carInfo() && carInfo().flies && me.h > 200);
  }

  // ---------------- Basketbol ----------------
  const hoop = { on: false, t0: 0, ball: null };
  function startShot() {
    hoop.on = true;
    hoop.t0 = performance.now();
    $('shot').hidden = false;
  }
  async function releaseShot() {
    if (!hoop.on) return;
    hoop.on = false;
    $('shot').hidden = true;
    const pos = shotPos(performance.now());
    const good = pos > 0.42 && pos < 0.58;
    flyBall(good);
    try {
      const d = await api('/api/game/hoop', { method: 'POST', body: { good } });
      setTimeout(() => {
        if (d.good) {
          setEconomy(d.economy);
          sound.cash();
          toast(`Savat! 🏀 +${formatNumber(d.reward)} so'm`, 'success');
        } else toast("Tegmadi... yashil joyda bosing", 'warn');
      }, 900);
    } catch (err) {
      if (!handleAuthError(err)) toast(err.message, 'warn');
    }
  }
  const shotPos = (now) => (Math.sin((now - hoop.t0) / 260) + 1) / 2;
  function stepShot(now) {
    if (hoop.on) $('shot-marker').style.left = `${shotPos(now) * 100}%`;
    if (hoop.ball) {
      const b = hoop.ball;
      b.t += 1 / 60;
      const k = Math.min(1, b.t / 0.9);
      b.m.position.set(b.x0 + (b.x1 - b.x0) * k, 30 + Math.sin(k * Math.PI) * 70 + (b.good ? (1 - k) * 10 : -k * 25), b.z0 + (b.z1 - b.z0) * k);
      if (b.t > 1.4) {
        scene.remove(b.m);
        hoop.ball = null;
      }
    }
  }
  function flyBall(good) {
    const h = world.places.court.hoop;
    const m = mesh(new THREE.SphereGeometry(6, 12, 10), mat('#ea580c'), me.x, 30, me.y);
    scene.add(m);
    hoop.ball = { m, t: 0, good, x0: me.x, z0: me.y, x1: good ? h.x + 10 : h.x + 30, z1: good ? h.y : h.y + 30 };
  }

  // ---------------- Kinoteatr ----------------
  let movie = null;
  async function watchMovie() {
    try {
      const d = await api('/api/game/cinema', { method: 'POST' });
      localVersion += 1;
      setEconomy(d.economy);
      const mv = await api('/api/game/movie').catch(() => ({}));
      if (mv.movie) { // owner YouTube kino qo'ygan — hamma birga ko'radi
        openTw('movie', { data: mv.movie });
        return;
      }
      movie = { t0: performance.now() };
      $('movie').hidden = false;
      releaseAll();
    } catch (err) {
      if (!handleAuthError(err)) toast(err.message, 'warn');
    }
  }
  function closeMovie() {
    movie = null;
    $('movie').hidden = true;
  }
  $('movie-close').addEventListener('click', closeMovie);

  // 25 soniyalik multfilm: shahar, mashina, sakrash, salyut
  function drawMovie(now) {
    if (!movie) return;
    const c = $('movie-canvas');
    const g = c.getContext('2d');
    const W = c.width;
    const H = c.height;
    const t = (now - movie.t0) / 1000;
    const sky = g.createLinearGradient(0, 0, 0, H);
    const night = clamp((t - 14) / 4, 0, 1);
    sky.addColorStop(0, night ? '#0b1430' : '#7dd3fc');
    sky.addColorStop(1, night ? '#312e81' : '#fde68a');
    g.fillStyle = sky;
    g.fillRect(0, 0, W, H);
    // Quyosh / oy
    g.fillStyle = night ? '#f8fafc' : '#facc15';
    g.beginPath();
    g.arc(W * 0.8, H * 0.2, 34, 0, Math.PI * 2);
    g.fill();
    // Uzoqdagi binolar
    for (let i = 0; i < 14; i += 1) {
      const bx = ((i * 97 - t * 40) % (W + 120) + W + 120) % (W + 120) - 60;
      const bh = 80 + (i * 53) % 140;
      g.fillStyle = night ? '#1e293b' : '#64748b';
      g.fillRect(bx, H * 0.75 - bh, 70, bh);
      g.fillStyle = night ? '#fde68a' : '#cbd5e1';
      for (let wy = H * 0.75 - bh + 12; wy < H * 0.75 - 10; wy += 22) for (let wx = bx + 10; wx < bx + 60; wx += 20) g.fillRect(wx, wy, 8, 10);
    }
    g.fillStyle = '#334155';
    g.fillRect(0, H * 0.75, W, H * 0.25);
    g.fillStyle = '#facc15';
    for (let x = (-t * 300) % 80; x < W; x += 80) g.fillRect(x, H * 0.86, 40, 6);
    // Mashina: yuradi, rampadan sakraydi
    const jump = t > 7 && t < 10 ? Math.sin(((t - 7) / 3) * Math.PI) * 140 : 0;
    const cx = W * 0.35;
    const cy = H * 0.8 - jump;
    g.save();
    g.translate(cx, cy);
    g.rotate(t > 7 && t < 10 ? -0.2 + ((t - 7) / 3) * 0.4 : 0);
    g.fillStyle = '#dc2626';
    g.fillRect(-60, -30, 120, 30);
    g.fillRect(-35, -55, 70, 27);
    g.fillStyle = '#93c5fd';
    g.fillRect(-28, -50, 26, 18);
    g.fillRect(4, -50, 26, 18);
    g.fillStyle = '#111827';
    [-35, 35].forEach((wx) => { g.beginPath(); g.arc(wx, 0, 14, 0, Math.PI * 2); g.fill(); });
    g.restore();
    // Salyut
    if (night) {
      for (let k = 0; k < 4; k += 1) {
        const ft = (t * 0.7 + k * 0.37) % 1;
        const fx = W * (0.2 + k * 0.2);
        const fy = H * 0.3;
        g.strokeStyle = WHEEL_COLORS[k * 2];
        for (let a = 0; a < 12; a += 1) {
          const ang = (a / 12) * Math.PI * 2;
          g.globalAlpha = 1 - ft;
          g.beginPath();
          g.moveTo(fx + Math.cos(ang) * ft * 20, fy + Math.sin(ang) * ft * 20);
          g.lineTo(fx + Math.cos(ang) * ft * 80, fy + Math.sin(ang) * ft * 80);
          g.stroke();
        }
        g.globalAlpha = 1;
      }
    }
    // Yozuvlar
    g.fillStyle = '#ffffff';
    g.font = '800 34px system-ui, sans-serif';
    g.textAlign = 'center';
    const title = t < 4 ? 'MAHALLA SARGUZASHTI' : (t < 7 ? 'Bir kuni Jasur yangi mashina oldi…' : (t < 11 ? 'U sakrab ketdi!' : (t < 14 ? 'Do\'stlari bilan shahar aylandi…' : (t < 22 ? 'Kechqurun — bayram!' : 'OXIRI · Rahmat!'))));
    g.strokeStyle = 'rgba(0,0,0,.5)';
    g.lineWidth = 6;
    g.strokeText(title, W / 2, 60);
    g.fillText(title, W / 2, 60);
    if (t > 25) closeMovie();
  }

  // ---------------- Metro ----------------
  function nearestMetro() {
    let best = null;
    world.metro.forEach((m) => {
      const d = Math.hypot(m.x - me.x, m.y - me.y);
      if (!best || d < best.d) best = { m, d };
    });
    return best;
  }
  function openMetro() {
    const n = nearestMetro();
    openSheet({ kind: 'metro', from: n ? n.m.id : null, v: 0 });
  }
  function renderMetroSheet(body, st) {
    setHead('navigation', 'Metro', "Bir bekatdan boshqasiga bir zumda — 500 so'm");
    const list = el('div', 'car-list');
    world.metro.forEach((m) => {
      const r = el('div', 'car-row');
      const sw = el('span', 'car-row__swatch', 'M');
      sw.style.setProperty('--car', '#dc2626');
      const info = el('div', 'car-row__info');
      info.append(el('strong', '', m.name), el('small', '', m.id === st.from ? 'Siz shu yerdasiz' : `${meters(Math.hypot(m.x - me.x, m.y - me.y))} uzoqda`));
      r.append(sw, info);
      if (m.id !== st.from) {
        r.append(actionBtn('navigation', 'Borish', async () => {
          try {
            const d = await api('/api/game/metro', { method: 'POST', body: { to: m.id } });
            setEconomy(d.economy);
            closeSheet();
            if (me.car) setCar(null);
            document.body.classList.add('is-fade');
            setTimeout(() => document.body.classList.remove('is-fade'), 900);
            sound.whoosh(true);
            toast(`Metro: ${m.name} bekatiga keldingiz 🚇`, 'success');
          } catch (err) {
            if (!handleAuthError(err)) toast(err.message, 'warn');
          }
        }));
      }
      list.append(r);
    });
    body.append(list);
  }

  // ---------------- Akvapark: suv tepaliklari ----------------
  let slide = null;
  function startSlide(s0) {
    slide = { t0: performance.now(), x: s0.x, y: s0.y };
    me.dance = false;
    toast('Uuuuu! 🌊');
    sound.whoosh(false);
  }
  function stepSlide(now) {
    if (!slide) return false;
    const k = Math.min(1, (now - slide.t0) / 3200);
    const a = k * Math.PI * 4;
    const r = 60;
    const endY = world.aqua.pool.y + 140;
    if (k < 0.8) {
      const q = k / 0.8;
      me.x = slide.x + Math.cos(a) * r;
      me.y = slide.y + Math.sin(a) * r + q * (endY - slide.y) * 0.5;
      me.h = 100 * (1 - q);
    } else {
      const q = (k - 0.8) / 0.2;
      me.x = slide.x + r;
      me.y = slide.y + (endY - slide.y) * (0.5 + q * 0.5);
      me.h = 0;
    }
    me.dir = a + Math.PI / 2;
    if (k >= 1) {
      slide = null;
      for (let i = 0; i < 20; i += 1) smokeAt(me.x + (Math.random() - 0.5) * 40, me.y + (Math.random() - 0.5) * 40, Math.random() * 6);
      toast('Shalop! 💦');
    }
    return true;
  }

  // ---------------- Yashirinmachoq va quvlashmachoq ----------------
  let mg = null;
  let mgCardSig = '';
  let itMarker = null;
  const MG_NAMES = { hide: 'Yashirinmachoq', tag: 'Quvlashmachoq' };

  function setMg(m) {
    const prev = mg;
    mg = m;
    if (m && prev && prev.phase !== m.phase && m.joined) {
      if (m.phase === 'hiding') toast(m.role === 'seeker' ? "Siz qidiruvchisiz! Ko'zingizni yumdingiz — 25 soniya" : 'Yashiring! 25 soniya', 'success');
      if (m.phase === 'play') toast(m.type === 'hide' ? (m.role === 'seeker' ? 'Qidiring! Odamlarga yaqin boring' : 'Qidiruv boshlandi — topilmang!') : `Quvlashmachoq! Quvlovchi: ${m.it_name}`, 'success');
    }
    if (m && m.phase === 'done' && (!prev || prev.phase !== 'done') && m.joined) {
      toast(m.cancelled ? "O'yin bekor qilindi (odam yetmadi)" : (m.result ? `O'yin tugadi! Mukofot: +${formatNumber(m.result)} so'm` : "O'yin tugadi"), m.result ? 'success' : '');
    }
  }
  const mgFrozen = () => Boolean(mg && mg.joined && mg.phase === 'hiding' && mg.role === 'seeker');
  const mgHiddenKey = (key) => Boolean(mg && mg.joined && mg.type === 'hide' && mg.role === 'seeker'
    && (mg.phase === 'play' || mg.phase === 'hiding') && mg.keys.includes(key) && !mg.found.includes(key));

  function updateMgCard() {
    let title = '';
    let sub = '';
    let join = false;
    if (mg) {
      const name = MG_NAMES[mg.type];
      const t = `${Math.floor(mg.left / 60)}:${String(mg.left % 60).padStart(2, '0')}`;
      if (mg.phase === 'lobby') {
        title = `${name}: ${mg.host} boshlayapti`;
        sub = mg.joined ? `Qo'shildingiz · ${mg.players} kishi · ${mg.left} s` : `${mg.players} kishi · ${mg.left} s ichida qo'shiling`;
        join = !mg.joined;
      } else if (!mg.joined) {
        title = `${name} ketyapti`;
        sub = `${mg.players} kishi o'ynayapti`;
      } else if (mg.phase === 'hiding') {
        title = mg.role === 'seeker' ? "Ko'zingizni yumdingiz…" : 'Tez yashiring!';
        sub = `${mg.left} s`;
      } else if (mg.phase === 'play') {
        if (mg.type === 'hide') {
          title = mg.role === 'seeker' ? `Qidiring! Topildi: ${mg.found.length}/${mg.players - 1}` : (mg.role === 'found' ? 'Sizni topishdi' : 'Sizni qidiryapti!');
        } else title = mg.role === 'it' ? 'Siz quvlovchisiz! Birovga tegining' : `Quvlovchi: ${mg.it_name} — qoching!`;
        sub = t;
      } else {
        title = `${name} tugadi`;
        sub = mg.result ? `Mukofot: +${formatNumber(mg.result)} so'm` : '';
      }
    }
    const sig = `${title}|${sub}|${join}`;
    $('mg-blind').hidden = !mgFrozen();
    if (mgFrozen()) $('mg-blind-text').textContent = `Ko'zingizni yumdingiz… ${mg.left}`;
    if (sig === mgCardSig) return;
    mgCardSig = sig;
    $('mg-card').hidden = !title;
    $('mg-title').textContent = title;
    $('mg-sub').textContent = sub;
    $('mg-join').hidden = !join;
  }
  $('mg-join').addEventListener('click', async () => {
    try {
      const d = await api('/api/game/mg/join', { method: 'POST' });
      setMg(d.mg);
      toast("Qo'shildingiz!", 'success');
    } catch (err) {
      if (!handleAuthError(err)) toast(err.message, 'warn');
    }
  });

  async function startMg(type) {
    try {
      const d = await api('/api/game/mg/start', { method: 'POST', body: { type } });
      setMg(d.mg);
      closeSheet();
      toast(`${MG_NAMES[type]} e'lon qilindi — boshqalar 20 soniyada qo'shiladi`, 'success');
    } catch (err) {
      if (!handleAuthError(err)) toast(err.message, 'warn');
    }
  }

  function stepMgVisual() {
    // Quvlashmachoqda "quvlovchi" ustida qizil belgi
    const itKey = mg && mg.type === 'tag' && mg.phase === 'play' ? mg.it : null;
    const rig = itKey === me.key ? me.rig : (itKey && others.get(itKey) ? others.get(itKey).rig : null);
    if (!itMarker) {
      itMarker = mesh(new THREE.ConeGeometry(8, 16, 12), glow('#ef4444', 1), 0, 0, 0, false);
      itMarker.rotation.x = Math.PI;
      scene.add(itMarker);
    }
    itMarker.visible = Boolean(rig);
    if (rig) itMarker.position.set(rig.root.position.x, rig.root.position.y + 110 + Math.sin(performance.now() / 200) * 5, rig.root.position.z);
    // Qidiruvchi yashiringanlarning ismini ko'rmaydi
    others.forEach((p, key) => { if (p.rig.label) p.rig.label.visible = !mgHiddenKey(key); });
  }

  // ---------------- To'y ----------------
  let proposal = null;
  let weddings = [];
  async function propose(p) {
    try {
      const d = await api('/api/game/wedding/propose', { method: 'POST', body: { to: p.key } });
      toast(`${d.to}ga to'y taklif qilindi 💍 Javobini kuting`, 'success');
    } catch (err) {
      if (!handleAuthError(err)) toast(err.message, 'warn');
    }
  }
  function updateWedCard() {
    $('wed-card').hidden = !proposal;
    if (proposal) $('wed-title').textContent = `${proposal.name} sizga to'y taklif qildi! 💍`;
  }
  async function answerWedding(yes) {
    const p = proposal;
    proposal = null;
    localVersion += 1;
    updateWedCard();
    if (!p) return;
    try {
      const d = await api(`/api/game/wedding/${yes ? 'accept' : 'decline'}`, { method: 'POST' });
      if (yes) {
        setEconomy(d.economy);
        sound.cash();
        toast("Tabriklaymiz! To'y boshlandi — favvora yoniga boring 💍🎉", 'success');
      }
    } catch (err) {
      if (!handleAuthError(err)) toast(err.message, 'warn');
    }
  }
  $('wed-yes').addEventListener('click', () => answerWedding(true));
  $('wed-no').addEventListener('click', () => answerWedding(false));

  // ---------------- Telefon: do'stlar va xabarlar ----------------
  let pmSince = null;
  let unread = 0;
  function setUnread(n) {
    unread = n;
    const b = $('phone-badge');
    b.hidden = !n;
    b.textContent = n > 9 ? '9+' : String(n);
  }
  async function initPhone() {
    try {
      const d = await api('/api/game/friends');
      pmSince = d.pm_last;
    } catch (err) {
      handleAuthError(err);
      pmSince = 0;
    }
  }
  function onPm(list) {
    (list || []).forEach((m) => {
      pmSince = Math.max(pmSince || 0, m.id);
      if (sheetState && sheetState.kind === 'chat' && sheetState.person.key === m.from) {
        sheetState.messages.push({ id: m.id, me: false, text: m.text });
        sheetState.v += 1;
        renderSheet();
        return;
      }
      setUnread(unread + 1);
      sound.ding();
      toast(`📱 ${m.name}: ${m.text}`, 'success');
    });
  }

  function openPhone(tab = 'friends') {
    setUnread(0);
    const st = { kind: 'phone', tab, data: null, people: null, v: 0 };
    openSheet(st);
    loadInto(st, '/api/game/friends', (d) => { st.data = d; });
  }

  async function friendCall(st, action, key, okText) {
    try {
      st.data = await api(`/api/game/friends/${action}`, { method: 'POST', body: { key } });
      st.v += 1;
      if (okText) toast(okText, 'success');
      renderSheet();
    } catch (err) {
      if (!handleAuthError(err)) toast(err.message, 'warn');
    }
    return null;
  }

  function renderPhoneSheet(body, st) {
    setHead('message', 'Telefon', "Do'stlar va shaxsiy xabarlar");
    const tabs = el('div', 'chips');
    [['friends', "Do'stlar"], ['add', "Do'st qo'shish"]].forEach(([id, name]) => {
      const b = el('button', `chip${st.tab === id ? ' is-on' : ''}`, name);
      b.type = 'button';
      b.addEventListener('click', async () => {
        st.tab = id;
        st.v += 1;
        if (id === 'add' && !st.people) {
          try { st.people = (await api('/api/game/people')).people; } catch (err) { handleAuthError(err); }
        }
        renderSheet();
      });
      tabs.append(b);
    });
    body.append(tabs);
    const d = st.data;
    if (!d) return;
    const list = el('div', 'people');
    if (st.tab === 'friends') {
      d.incoming.forEach((p) => {
        const r = el('div', 'person');
        const info = el('div', 'person__info');
        info.append(el('strong', '', p.name), el('small', '', "Do'stlikka so'rov yubordi"));
        r.append(avatarEl(p), info, actionBtn('check', 'Qabul', () => friendCall(st, 'accept', p.key, `${p.name} bilan do'st bo'ldingiz!`)));
        list.append(r);
      });
      d.friends.forEach((p) => {
        const r = el('div', 'person');
        const info = el('div', 'person__info');
        info.append(el('strong', '', p.name), el('small', p.online ? 'person__on' : '', p.online ? "O'yinda" : "O'yinda emas"));
        r.append(avatarEl(p), info, actionBtn('message', 'Yozish', () => openChat(p), 'btn btn--primary'));
        if (p.online) {
          r.append(actionBtn('navigation', '', () => {
            const o = others.get(p.key);
            if (!o) return toast("Hozir ko'rinmayapti", 'warn');
            setGuide(o.x, o.y, p.name);
            closeSheet();
            return null;
          }, 'btn btn--ghost btn--icon'));
        }
        r.append(actionBtn('x', '', () => friendCall(st, 'remove', p.key, null), 'btn btn--ghost btn--icon'));
        list.append(r);
      });
      if (!d.friends.length && !d.incoming.length) list.append(el('p', 'sheet-note', "Hali do'stingiz yo'q — «Do'st qo'shish» bo'limiga o'ting."));
      d.outgoing.forEach((p) => list.append(el('p', 'sheet-note', `${p.name} — so'rov yuborilgan, javob kutilmoqda`)));
    } else {
      const known = new Set([...d.friends, ...d.outgoing, ...d.incoming].map((p) => p.key));
      (st.people || []).filter((p) => !p.me).forEach((p) => {
        const r = el('div', 'person');
        const info = el('div', 'person__info');
        info.append(el('strong', '', p.name), el('small', p.online ? 'person__on' : '', p.online ? "O'yinda" : "O'yinda emas"));
        r.append(avatarEl(p), info);
        r.append(actionBtn('message', '', () => openChat(p), 'btn btn--ghost btn--icon'));
        if (!known.has(p.key)) r.append(actionBtn('user-plus', "Qo'shish", () => friendCall(st, 'request', p.key, `${p.name}ga so'rov yuborildi`)));
        list.append(r);
      });
    }
    body.append(list);
  }

  async function openChat(p) {
    const st = { kind: 'chat', person: p, messages: [], v: 0, draft: '' };
    openSheet(st);
    try {
      st.messages = (await api(`/api/game/pm/${encodeURIComponent(p.key)}`)).messages;
      st.v += 1;
      if (sheetState === st) renderSheet();
    } catch (err) {
      handleAuthError(err);
    }
  }

  function renderChatSheet(body, st) {
    setHead('message', st.person.name, 'Shaxsiy xabarlar');
    const log = el('div', 'pm-log');
    st.messages.forEach((m) => log.append(el('div', `pm ${m.me ? 'pm--me' : ''}`, m.text)));
    if (!st.messages.length) log.append(el('p', 'sheet-note', 'Birinchi bo\'lib yozing!'));
    const row = el('div', 'sale__row');
    const input = el('input', 'input');
    input.placeholder = 'Xabar…';
    input.maxLength = 300;
    input.value = st.draft;
    input.addEventListener('input', () => { st.draft = input.value; });
    const send = async () => {
      const text = input.value.trim();
      if (!text) return;
      try {
        const d = await api('/api/game/pm', { method: 'POST', body: { to: st.person.key, text } });
        st.messages.push(d.message);
        st.draft = '';
        st.v += 1;
        renderSheet();
      } catch (err) {
        if (!handleAuthError(err)) toast(err.message, 'warn');
      }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    row.append(input, actionBtn('send', '', send, 'btn btn--primary btn--icon'));
    body.append(log, row, backLink('Telefonga qaytish', () => openPhone()));
    setTimeout(() => { log.scrollTop = log.scrollHeight; input.focus(); }, 0);
  }
  $('btn-phone').addEventListener('click', () => openPhone());

  // ---------------- Aksiya birjasi ----------------
  function openStocks() {
    const st = { kind: 'stocks', data: null, v: 0, qty: {} };
    openSheet(st);
    loadInto(st, '/api/game/stocks', (d) => { st.data = d; setEconomy(d.economy); });
  }
  function sparkline(hist, up) {
    const c = el('canvas', 'spark');
    c.width = 120;
    c.height = 36;
    const g = c.getContext('2d');
    const lo = Math.min(...hist);
    const hi = Math.max(...hist);
    g.strokeStyle = up ? '#16a34a' : '#dc2626';
    g.lineWidth = 2;
    g.beginPath();
    hist.forEach((v, i) => {
      const x = (i / (hist.length - 1)) * 118 + 1;
      const y = 34 - ((v - lo) / Math.max(1, hi - lo)) * 32;
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    });
    g.stroke();
    return c;
  }
  function renderStocksSheet(body, st) {
    const d = st.data;
    setHead('trophy', 'Aksiya birjasi', d ? `Narxlar har daqiqada o'zgaradi · keyingisi ${d.next_in} s da` : 'Yuklanmoqda…');
    if (!d) return;
    let total = 0;
    d.stocks.forEach((s2) => {
      total += s2.qty * s2.price;
      const up = s2.price >= s2.prev;
      const pct = ((s2.price - s2.prev) / s2.prev) * 100;
      const r = el('div', 'stock');
      const info = el('div', 'person__info');
      info.append(el('strong', '', `${s2.sym} · ${s2.name}`),
        el('small', up ? 'stock__up' : 'stock__down', `${formatNumber(s2.price)} so'm ${up ? '▲' : '▼'} ${Math.abs(pct).toFixed(1)}%`),
        el('small', '', s2.qty ? `Sizda: ${formatNumber(s2.qty)} ta · ${formatNumber(s2.qty * s2.price)} so'm (${s2.qty * s2.price >= s2.cost ? 'foyda' : 'zarar'} ${formatNumber(Math.abs(s2.qty * s2.price - s2.cost))})` : 'Sizda yo\'q'));
      const qty = el('input', 'input stock__qty');
      qty.inputMode = 'numeric';
      qty.value = st.qty[s2.sym] || '10';
      qty.addEventListener('input', () => { st.qty[s2.sym] = qty.value; });
      const trade = (action) => async () => {
        const n = parseAmount(qty.value);
        if (!n) return toast('Nechta?', 'warn');
        try {
          st.data = await api('/api/game/stocks', { method: 'POST', body: { sym: s2.sym, action, qty: n } });
          localVersion += 1;
          setEconomy(st.data.economy);
          st.v += 1;
          sound.cash();
          toast(`${action === 'buy' ? 'Sotib olindi' : 'Sotildi'}: ${n} ta ${s2.sym}`, 'success');
          renderSheet();
        } catch (err) {
          if (!handleAuthError(err)) toast(err.message, 'warn');
        }
        return null;
      };
      const btns = el('div', 'stock__btns');
      btns.append(qty, actionBtn('plus', 'Olish', trade('buy')), actionBtn('coins', 'Sotish', trade('sell'), 'btn btn--ghost'));
      r.append(info, sparkline(s2.history, up), btns);
      body.append(r);
    });
    body.append(el('p', 'sheet-note', `Aksiyalaringiz qiymati: ${formatNumber(total)} so'm. Arzonida olib, qimmatida soting! (o'yin puli)`),
      actionBtn('refresh', 'Yangilash', () => loadInto(st, '/api/game/stocks', (x) => { st.data = x; }), 'btn btn--ghost btn--block'));
  }

  // ---------------- Haftalik turnir ----------------
  function openTournament() {
    const st = { kind: 'tour', data: null, v: 0 };
    openSheet(st);
    loadInto(st, '/api/game/tournament', (d) => { st.data = d; });
  }
  function renderTourSheet(body, st) {
    const d = st.data;
    setHead('trophy', 'Haftalik turnir', d ? `Tugashiga ${Math.floor(d.left / 86400)} kun ${Math.floor((d.left % 86400) / 3600)} soat` : 'Yuklanmoqda…');
    if (!d) return;
    body.append(el('p', 'sheet-note', `Shu hafta eng ko'p boyigan 3 kishi mukofot oladi: 🥇 ${formatNumber(d.prizes[0])} · 🥈 ${formatNumber(d.prizes[1])} · 🥉 ${formatNumber(d.prizes[2])} so'm`));
    const list = el('div', 'people');
    d.top.forEach((t) => list.append(topRow({ ...t, wealth: t.score, money: t.score, property: 0, clan: null })));
    if (!d.top.length) list.append(el('p', 'sheet-note', 'Hali hech kim yo\'q'));
    if (d.me && d.me.place > 10) list.append(el('div', 'top-gap', '…'), topRow({ ...d.me, wealth: d.me.score, money: d.me.score, property: 0, clan: null }));
    body.append(list);
  }

  // ---------------- Yangi joylar (3D) ----------------
  // Yozuv ikki tomondan ham to'g'ri o'qiladi (orqadan teskari chiqmasin)
  function placeSign(text, w, h, bg, x, y, z, rotY = 0) {
    const g = new THREE.Group();
    [0, Math.PI].forEach((r) => {
      const s2 = signPlane(text, w, h, bg, '#ffffff');
      s2.material.side = THREE.FrontSide;
      s2.rotation.y = r;
      s2.position.z = r ? -0.3 : 0.3;
      g.add(s2);
    });
    g.position.set(x, y, z);
    g.rotation.y = rotY;
    return g;
  }

  function buildPlaces() {
    const P = world.places;
    // Pochta va pitsaxona — kichik do'konchalar
    [['post', 'POCHTA', '#1d4ed8', '#e0e7ff'], ['pizza', 'PITSA', '#dc2626', '#fef3c7']].forEach(([id, label, color, wall]) => {
      const r = P[id];
      const cx = r.x + r.w / 2;
      const cz = r.y + r.h / 2;
      scene.add(box(r.w, 40, r.h, mat(wall), cx, 20, cz), box(r.w + 10, 5, r.h + 10, mat(color), cx, 42, cz));
      scene.add(box(40, 26, 1.5, GLASS(), cx, 15, r.y + r.h + 0.8), placeSign(label, r.w - 10, 16, color, cx, 54, r.y + r.h + 2));
    });
    // Basketbol maydoni
    const c = P.court;
    scene.add(flat(c.w, c.h, mat('#c2410c', { roughness: 0.9 }), c.x + c.w / 2, c.y + c.h / 2, 0.42));
    const line = mat('#f8fafc', { roughness: 1 });
    scene.add(flat(c.w, 2, line, c.x + c.w / 2, c.y + 2, 0.5), flat(c.w, 2, line, c.x + c.w / 2, c.y + c.h - 2, 0.5),
      flat(2, c.h, line, c.x + 2, c.y + c.h / 2, 0.5), flat(2, c.h, line, c.x + c.w - 2, c.y + c.h / 2, 0.5),
      flat(2, 70, line, c.spot.x, c.spot.y, 0.5));
    const h = c.hoop;
    scene.add(cyl(2, 2, 70, mat('#475569'), h.x - 12, 35, h.y, 8), box(2, 28, 40, mat('#f8fafc'), h.x - 8, 66, h.y));
    const rim = new THREE.Mesh(new THREE.TorusGeometry(9, 1, 8, 20), mat('#ea580c'));
    rim.rotation.x = Math.PI / 2;
    rim.position.set(h.x + 4, 58, h.y);
    scene.add(rim);
    // Kinoteatr
    const k = P.cinema;
    scene.add(box(k.w, 70, k.h, mat('#312e81'), k.x + k.w / 2, 35, k.y + k.h / 2), placeSign('KINO', 90, 24, '#be123c', k.x + k.w / 2, 82, k.y + k.h + 1));
    scene.add(placeSign('MAHALLA\nSARGUZASHTI', 50, 34, '#0f172a', k.x + 30, 32, k.y + k.h + 1.5), box(36, 40, 2, mat('#111827'), k.x + k.w / 2 + 30, 20, k.y + k.h + 1));
    // Avtoyuvish: ochiq ark
    const wsh = P.wash;
    const wx = wsh.x + wsh.w / 2;
    const wz = wsh.y + wsh.h / 2;
    scene.add(flat(wsh.w, wsh.h, mat('#94a3b8'), wx, wz, 0.42));
    [-1, 1].forEach((s2) => scene.add(box(10, 60, wsh.h - 40, mat('#38bdf8'), wx + s2 * 70, 30, wz)));
    scene.add(box(150, 8, wsh.h - 40, mat('#0ea5e9'), wx, 64, wz), placeSign('AVTOYUVISH', 130, 18, '#0369a1', wx, 80, wsh.y + wsh.h - 18));
    // Metro kirishlari
    world.metro.forEach((m) => {
      scene.add(box(50, 4, 40, mat('#334155'), m.x, 2, m.y), box(4, 30, 40, mat('#64748b'), m.x - 25, 15, m.y), box(4, 30, 40, mat('#64748b'), m.x + 25, 15, m.y));
      scene.add(cyl(1.6, 1.6, 60, mat('#64748b'), m.x + 34, 30, m.y - 20, 8), placeSign('M', 18, 18, '#dc2626', m.x + 34, 62, m.y - 20));
    });
    // Parashyut nishoni (futbol maydoni o'rtasida)
    const f = world.field;
    const target = new THREE.Mesh(new THREE.RingGeometry(120, 140, 48), new THREE.MeshBasicMaterial({ color: '#f97316', transparent: true, opacity: 0.6, depthWrite: false }));
    target.rotation.x = -Math.PI / 2;
    target.position.set(f.x + f.w / 2, 0.7, f.y + f.h / 2);
    scene.add(target);
  }

  function buildAqua() {
    const A = world.aqua;
    const R = A.rect;
    const g = new THREE.Group();
    // Ko'cha (1140-yo'l davomi) va plitkali maydon
    g.add(flat(-R.x + 20, 96, mat('#9ca3af', { roughness: 1 }), R.x / 2, 1180, 0.25), flat(-R.x + 20, 80, mat('#3b404c'), R.x / 2, 1180, 0.45));
    g.add(flat(R.w - 300, R.h - 260, mat('#e7e5e4', { roughness: 1 }), R.x + (R.w - 300) / 2 + 40, 1500 + 50, 0.3));
    const p = A.pool;
    g.add(box(p.w + 16, 4, p.h + 16, mat('#f8fafc'), p.x + p.w / 2, 2, p.y + p.h / 2));
    const water = new THREE.Mesh(new THREE.PlaneGeometry(p.w, p.h), new THREE.MeshStandardMaterial({ color: '#22d3ee', roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.85 }));
    water.rotation.x = -Math.PI / 2;
    water.position.set(p.x + p.w / 2, 4.5, p.y + p.h / 2);
    g.add(water);
    const colors = ['#f97316', '#a855f7', '#22c55e'];
    A.slides.forEach((s2, i) => {
      g.add(cyl(14, 18, 110, mat('#64748b'), s2.x, 55, s2.y, 10), box(40, 4, 40, mat('#475569'), s2.x, 110, s2.y));
      const pts = [];
      for (let k = 0; k <= 40; k += 1) {
        const q = k / 40;
        const a = q * Math.PI * 4;
        pts.push(new THREE.Vector3(s2.x + Math.cos(a) * 60, 105 * (1 - q) + 6, s2.y + Math.sin(a) * 60 + q * (p.y + 140 - s2.y) * 0.5));
      }
      const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 80, 7, 8, false), mat(colors[i], { roughness: 0.3 }));
      g.add(tube);
    });
    // Soyabonlar va yozuv
    for (let i = 0; i < 6; i += 1) {
      const x = p.x + 60 + i * 120;
      const z = p.y + p.h + 70;
      g.add(cyl(1.2, 1.2, 30, mat('#64748b'), x, 15, z, 6));
      g.add(mesh(new THREE.ConeGeometry(26, 10, 12), mat(colors[i % 3]), x, 32, z));
    }
    g.add(placeSign('AKVAPARK', 200, 34, '#0891b2', -150, 70, 1330, Math.PI / 2));
    scene.add(g);
  }

  // Yaqin turgan joy (F bilan ishlaydi)
  function funSpot() {
    const P = world.places;
    const car = carInfo();
    const d = (x, y) => Math.hypot(x - me.x, y - me.y);
    if (fish.on) {
      const biting = performance.now() >= fish.biteAt;
      return { kind: 'fun', d: 0, text: biting ? 'TORT! 🎣' : "Kuting… po'kakni kuzating (F — tortish)", act: pullLine };
    }
    if (!car && me.h < 5 && nearPondEdge()) return { kind: 'fun', d: 1, text: 'Baliq ovlash 🎣', act: castLine };
    if (!car && !me.spider && spiderBug && d(spiderBug.x, spiderBug.y) < 75) {
      return { kind: 'fun', d: 0, text: "O'rgimchakni ushlash 🕷️", act: catchSpider };
    }
    const townF = townSpot(car);
    if (townF) return townF;
    const cityF = citySpot(car);
    if (cityF) return cityF;
    if (!car && nearRocket()) return { kind: 'fun', d: 1, text: `Oyga uchish 🚀 — ${formatNumber(world.rocket.price)} so'm`, act: flyToMoon };
    const life = lifeSpot(car);
    if (life) return life;
    const pier = world.port.pier;
    if (!car && (me.boat ? d(pier.x, pier.y) < 220 : d(pier.x, pier.y) < 120)) {
      return { kind: 'fun', d: 1, text: me.boat ? "Qirg'oqqa chiqish" : 'Qayiqqa o\'tirish ⛵', act: toggleBoat };
    }
    const stg = world.places.stage.spot;
    if (!car && d(stg.x, stg.y) < 80) {
      return { kind: 'fun', d: 1, text: stage && stage.me ? 'Sahnadan tushish' : 'Sahnaga chiqish 🎤', act: stageToggle };
    }
    const m = nearestMetro();
    if (m && m.d < 110) return { kind: 'fun', d: m.d, text: `Metro: ${m.m.name} — boshqa bekatga (500 so'm)`, act: openMetro };
    if (car && !isRider(car) && d(P.wash.door.x, P.wash.door.y) < 150) {
      return { kind: 'fun', d: 1, text: `Avtoyuvish — 2 000 so'm (iflos: ${Math.round(dirtOf(me.car) * 100)}%)`, act: washCar };
    }
    if (!car && d(P.cinema.door.x, P.cinema.door.y) < 140) return { kind: 'fun', d: 1, text: 'Kino ko\'rish — 1 000 so\'m 🎬', act: watchMovie };
    if (!car && d(P.court.spot.x, P.court.spot.y) < 80) return { kind: 'fun', d: 1, text: hoop.on ? 'Otish! (F)' : 'Basketbol — to\'p otish 🏀', act: hoop.on ? releaseShot : startShot };
    if (!car && world.aqua) {
      const s2 = world.aqua.slides.find((x) => d(x.x, x.y) < 70);
      if (s2) return { kind: 'fun', d: 1, text: 'Suv tepaligidan tushish 🌊', act: () => startSlide(s2) };
    }
    return null;
  }

  // Bog'dagi binolar to'siq bo'ladi
  function placeSolids() {
    const P = world.places;
    return [{ ...P.post, top: 45 }, { ...P.pizza, top: 45 }, { ...P.cinema, top: 75 }];
  }

  // =====================================================================
  //  Uy hayvoni, hayvonot bog'i, port va qayiq, konsert sahnasi, qurilish bazasi
  // =====================================================================
  const PET_NAMES = { dog: 'Kuchukcha', cat: 'Mushuk', parrot: "To'tiqush" };

  function petModel(kind) {
    const g = new THREE.Group();
    if (kind === 'dog' || kind === 'cat') {
      const fur = mat(kind === 'dog' ? '#a16207' : '#9ca3af');
      const dark = mat('#1f2937');
      const big = kind === 'dog' ? 1 : 0.8;
      g.add(box(8 * big, 7 * big, 16 * big, fur, 0, 8 * big, 0));
      g.add(box(7 * big, 7 * big, 7 * big, fur, 0, 13 * big, 9 * big));
      g.add(box(2, 3, 2, dark, -2.4 * big, 17 * big, 9 * big), box(2, 3, 2, dark, 2.4 * big, 17 * big, 9 * big)); // quloqlar
      const legs = [];
      [[-3, -5], [3, -5], [-3, 5], [3, 5]].forEach(([x, z]) => {
        const l = box(2.2 * big, 6 * big, 2.2 * big, fur, x * big, 3 * big, z * big);
        legs.push(l);
        g.add(l);
      });
      const tail = box(1.5, 1.5, 8 * big, fur, 0, 11 * big, -11 * big);
      tail.rotation.x = kind === 'cat' ? -0.9 : -0.4;
      g.add(tail, mesh(new THREE.SphereGeometry(0.9, 6, 4), dark, -1.8 * big, 14 * big, 12.6 * big, false),
        mesh(new THREE.SphereGeometry(0.9, 6, 4), dark, 1.8 * big, 14 * big, 12.6 * big, false));
      g.userData = { legs, tail };
    } else {
      const body = mesh(new THREE.SphereGeometry(4, 10, 8), mat('#16a34a'), 0, 0, 0);
      body.scale.set(1, 1.3, 1);
      const wings = [-1, 1].map((s2) => {
        const w = box(7, 1, 4, mat('#ef4444'), s2 * 5, 1, 0);
        g.add(w);
        return w;
      });
      g.add(body, mesh(new THREE.ConeGeometry(1.4, 3, 6), mat('#facc15'), 0, 2, 4.2));
      g.userData = { wings };
    }
    return g;
  }

  function updatePet(rig, p, dt) {
    const kind = p.pet || null;
    if ((rig.petKind || null) !== kind) {
      if (rig.petView) {
        scene.remove(rig.petView);
        disposeTree(rig.petView);
        rig.petView = null;
      }
      rig.petKind = kind;
      if (kind) {
        rig.petView = petModel(kind);
        rig.petView.position.copy(rig.root.position);
        scene.add(rig.petView);
      }
    }
    if (!rig.petView) return;
    rig.petView.visible = rig.root.visible && !p.car && !p.boat;
    const back = rig.heading - Math.PI;
    const side = kind === 'parrot' ? 0 : 18;
    const tx = rig.root.position.x + Math.sin(back) * 26 + Math.cos(back) * side;
    const tz = rig.root.position.z + Math.cos(back) * 26 - Math.sin(back) * side;
    const pv = rig.petView.position;
    const moved = Math.hypot(tx - pv.x, tz - pv.z);
    const k = Math.min(1, dt * 4);
    pv.x += (tx - pv.x) * k;
    pv.z += (tz - pv.z) * k;
    pv.y = kind === 'parrot' ? rig.root.position.y + 62 + Math.sin(performance.now() / 300) * 4 : rig.root.position.y;
    if (moved > 3) rig.petView.rotation.y = Math.atan2(tx - pv.x, tz - pv.z);
    const t = performance.now() / 90;
    const u = rig.petView.userData;
    if (u.legs) u.legs.forEach((l, i) => { l.rotation.x = moved > 3 ? Math.sin(t + i * Math.PI) * 0.6 : 0; });
    if (u.tail) u.tail.rotation.y = Math.sin(t / 2) * 0.5;
    if (u.wings) u.wings.forEach((w, i) => { w.rotation.z = Math.sin(t * 2) * 0.6 * (i ? 1 : -1); });
  }

  function dropPet(rig) {
    if (rig.petView) {
      scene.remove(rig.petView);
      disposeTree(rig.petView);
      rig.petView = null;
    }
  }

  async function loadPet() {
    try {
      me.pet = (await api('/api/game/pet')).pet;
    } catch (err) {
      handleAuthError(err);
    }
  }

  function openPets() {
    const st = { kind: 'pets', v: 0, data: null };
    openSheet(st);
    loadInto(st, '/api/game/pet', (d) => { st.data = d; });
  }
  function renderPetsSheet(body, st) {
    setHead('home', 'Uy hayvoni', "Orqangizdan yuradi — hamma ko'radi");
    if (!st.data) return;
    const list = el('div', 'car-list');
    Object.entries(st.data.prices).forEach(([kind, price]) => {
      const r = el('div', 'car-row');
      const sw = el('span', 'car-row__swatch', { dog: '🐕', cat: '🐈', parrot: '🦜' }[kind]);
      sw.style.setProperty('--car', '#fef3c7');
      const info = el('div', 'car-row__info');
      info.append(el('strong', '', PET_NAMES[kind]), el('small', '', st.data.pet === kind ? 'Sizniki' : `${formatNumber(price)} so'm`));
      r.append(sw, info);
      if (st.data.pet !== kind) {
        r.append(priceButton('Olish', price, async () => {
          const d = await api('/api/game/pet', { method: 'POST', body: { kind } });
          localVersion += 1;
          me.pet = d.pet;
          setEconomy(d.economy);
          st.data.pet = d.pet;
          st.v += 1;
          sound.cash();
          toast(`${PET_NAMES[kind]} endi siz bilan! 🐾`, 'success');
          renderSheet();
        }, 'btn--sm'));
      }
      list.append(r);
    });
    body.append(list);
    if (st.data.pet) {
      body.append(actionBtn('x', "Hayvonni qo'yib yuborish", async () => {
        await api('/api/game/pet', { method: 'POST', body: { kind: '' } }).catch(() => null);
        me.pet = null;
        st.data.pet = null;
        st.v += 1;
        renderSheet();
      }, 'btn btn--ghost btn--block'));
    }
  }

  // ---------------- Hayvonot bog'i ----------------
  const zooAnimals = [];
  function animalModel(kind) {
    const g = new THREE.Group();
    if (kind === 'elephant') {
      const s2 = mat('#9ca3af');
      g.add(box(30, 24, 46, s2, 0, 30, 0), box(22, 20, 18, s2, 0, 40, 28), box(5, 26, 5, s2, 0, 26, 38));
      [[-10, -14], [10, -14], [-10, 14], [10, 14]].forEach(([x, z]) => g.add(box(8, 20, 8, s2, x, 10, z)));
      [-1, 1].forEach((k) => g.add(box(2, 18, 14, s2, k * 12, 42, 24)));
    } else if (kind === 'giraffe') {
      const s2 = mat('#f59e0b');
      g.add(box(16, 16, 30, s2, 0, 34, 0), box(6, 44, 6, s2, 0, 62, 12), box(8, 8, 14, s2, 0, 86, 16));
      [[-6, -11], [6, -11], [-6, 11], [6, 11]].forEach(([x, z]) => g.add(box(4, 28, 4, s2, x, 14, z)));
      for (let i = 0; i < 6; i += 1) g.add(box(3, 3, 0.5, mat('#78350f'), (i % 2 ? 4 : -4), 34 + (i % 3) * 4, 15.3));
    } else if (kind === 'lion') {
      const s2 = mat('#d97706');
      g.add(box(16, 14, 30, s2, 0, 16, 0), mesh(new THREE.SphereGeometry(11, 10, 8), mat('#78350f'), 0, 24, 15), box(9, 9, 9, s2, 0, 24, 21));
      [[-6, -10], [6, -10], [-6, 10], [6, 10]].forEach(([x, z]) => g.add(box(4, 10, 4, s2, x, 5, z)));
    } else if (kind === 'zebra') {
      const s2 = mat('#f8fafc');
      g.add(box(14, 14, 30, s2, 0, 22, 0), box(6, 14, 8, s2, 0, 32, 16));
      for (let i = 0; i < 6; i += 1) g.add(box(14.4, 14.4, 1.6, mat('#111827'), 0, 22, -12 + i * 5));
      [[-5, -10], [5, -10], [-5, 10], [5, 10]].forEach(([x, z]) => g.add(box(3.5, 16, 3.5, s2, x, 8, z)));
    } else if (kind === 'monkey') {
      const s2 = mat('#92400e');
      g.add(mesh(new THREE.SphereGeometry(7, 10, 8), s2, 0, 12, 0), mesh(new THREE.SphereGeometry(5, 10, 8), mat('#fcd34d'), 0, 22, 2));
      g.add(box(2, 12, 2, s2, -7, 12, 0), box(2, 12, 2, s2, 7, 12, 0));
    } else {
      g.add(mesh(new THREE.SphereGeometry(6, 10, 8), mat('#111827'), 0, 8, 0), mesh(new THREE.SphereGeometry(4.6, 10, 8), mat('#f8fafc'), 0, 8, 2.5),
        mesh(new THREE.ConeGeometry(1.5, 3, 6), mat('#f97316'), 0, 14, 5));
    }
    return g;
  }

  function buildZoo() {
    const Z = world.zoo;
    const R = Z.rect;
    scene.add(flat(R.w, R.h, mat('#65a30d', { roughness: 1 }), R.x + R.w / 2, R.y + R.h / 2, 0.2));
    scene.add(flat(80, R.h, mat('#3b404c'), 1980, R.y + R.h / 2, 0.45), flat(R.w, 80, mat('#d6d3d1', { roughness: 1 }), R.x + R.w / 2, -880, 0.4));
    const fence = mat('#78350f');
    Z.pens.forEach((p) => {
      const cx = p.x + p.w / 2;
      const cz = p.y + p.h / 2;
      scene.add(flat(p.w, p.h, mat(p.kind === 'penguin' ? '#bae6fd' : '#a3a35c', { roughness: 1 }), cx, cz, 0.3));
      scene.add(box(p.w, 16, 3, fence, cx, 8, p.y), box(p.w, 16, 3, fence, cx, 8, p.y + p.h),
        box(3, 16, p.h, fence, p.x, 8, cz), box(3, 16, p.h, fence, p.x + p.w, 8, cz));
      const names = { lion: 'SHER', elephant: 'FIL', giraffe: 'JIRAFA', zebra: 'ZEBRA', monkey: 'MAYMUN', penguin: 'PINGVIN' };
      scene.add(placeSign(names[p.kind], 60, 16, '#166534', cx, 30, p.y + p.h + 8));
      const n = p.kind === 'penguin' || p.kind === 'monkey' ? 4 : 2;
      for (let i = 0; i < n; i += 1) {
        const m = animalModel(p.kind);
        m.position.set(cx + (i - n / 2) * 50, 0, cz);
        scene.add(m);
        zooAnimals.push({ m, pen: p, tx: cx, tz: cz, wait: Math.random() * 3 });
      }
    });
    scene.add(placeSign("HAYVONOT BOG'I", 160, 30, '#166534', 1980, 70, -20), cyl(3, 3, 80, mat('#166534'), 1900, 40, -20, 8), cyl(3, 3, 80, mat('#166534'), 2060, 40, -20, 8));
  }

  function stepZoo(dt) {
    zooAnimals.forEach((a) => {
      if (Math.hypot(a.m.position.x - me.x, a.m.position.z - me.y) > 2200) return;
      if (a.wait > 0) {
        a.wait -= dt;
        return;
      }
      const dx = a.tx - a.m.position.x;
      const dz = a.tz - a.m.position.z;
      const d = Math.hypot(dx, dz);
      if (d < 4) {
        a.wait = 1 + Math.random() * 3;
        a.tx = a.pen.x + 40 + Math.random() * (a.pen.w - 80);
        a.tz = a.pen.y + 40 + Math.random() * (a.pen.h - 80);
        return;
      }
      const sp = Math.min(d, 40 * dt);
      a.m.position.x += (dx / d) * sp;
      a.m.position.z += (dz / d) * sp;
      a.m.rotation.y = Math.atan2(dx, dz);
    });
  }

  // ---------------- Port: dengiz, iskala, kemalar, qayiq ----------------
  let seaMesh = null;
  function buildPort() {
    const P = world.port;
    const R = P.rect;
    const S = P.sea;
    scene.add(flat(S.x - R.x, R.h, mat('#e7d7a8', { roughness: 1 }), (R.x + S.x) / 2, R.y + R.h / 2, 0.2));
    scene.add(flat(S.x - world.w + 40, 80, mat('#3b404c'), (world.w + S.x) / 2 - 20, 3460, 0.45));
    seaMesh = flat(S.w + 600, S.h + 400, new THREE.MeshStandardMaterial({ color: '#1d4ed8', roughness: 0.15, metalness: 0.2, transparent: true, opacity: 0.92 }),
      S.x + S.w / 2 + 300, S.y + S.h / 2, 0.6);
    scene.add(seaMesh);
    const wood = mat('#92400e');
    scene.add(box(260, 4, 60, wood, P.pier.x + 100, 6, P.pier.y));
    for (let i = 0; i < 6; i += 1) scene.add(cyl(3, 3, 14, wood, P.pier.x + i * 50, 3, P.pier.y + 28, 6));
    scene.add(placeSign('PORT · QAYIQ (F)', 100, 18, '#1d4ed8', P.pier.x, 40, P.pier.y - 40));
    // Kemalar va mayoq
    [[S.x + 400, S.y + 250, 0.2], [S.x + 800, S.y + 900, -0.5]].forEach(([x, z, r]) => {
      const ship = new THREE.Group();
      ship.add(box(70, 30, 260, mat('#dc2626'), 0, 15, 0), box(64, 26, 120, mat('#f8fafc'), 0, 43, -40), cyl(6, 6, 40, mat('#111827'), 0, 70, -40, 10));
      ship.position.set(x, 0, z);
      ship.rotation.y = r;
      scene.add(ship);
    });
    scene.add(cyl(18, 24, 160, mat('#f8fafc'), S.x + 60, 80, S.y + 60, 12), cyl(20, 20, 20, glow('#facc15', 1.2), S.x + 60, 170, S.y + 60, 12));
  }

  function boatModel() {
    const g = new THREE.Group();
    g.add(box(30, 10, 60, mat('#f8fafc'), 0, 5, 0), box(26, 2, 50, mat('#92400e'), 0, 10, 0), box(2, 30, 2, mat('#64748b'), 0, 24, -6));
    const sail = mesh(new THREE.PlaneGeometry(22, 24), mat('#facc15', { side: THREE.DoubleSide }), 0, 26, 2);
    sail.rotation.y = Math.PI / 2;
    g.add(sail);
    return g;
  }
  function updateBoat(rig, p) {
    const on = Boolean(p.boat) && !p.car;
    if (on && !rig.boatView) {
      rig.boatView = boatModel();
      rig.holder.add(rig.boatView);
    }
    if (rig.boatView) rig.boatView.visible = on;
    if (on) {
      rig.human.position.y = 2;
      rig.boatView.position.y = Math.sin(performance.now() / 400) * 1.5;
    }
  }
  function toggleBoat() {
    const P = world.port;
    if (me.boat) {
      me.boat = false;
      me.x = P.pier.x - 20;
      me.y = P.pier.y;
      toast("Qirg'oqqa chiqdingiz");
      return;
    }
    me.boat = true;
    me.x = P.sea.x + 60;
    me.y = P.pier.y;
    me.dance = false;
    toast("Qayiqdasiz! ⛵ Dengizda suzing. Iskala yonida F — qirg'oqqa chiqish", 'success');
  }

  // ---------------- Konsert sahnasi ----------------
  let stage = null;
  let stageSig = '';
  function buildStage() {
    const S = world.places.stage;
    const cx = S.x + S.w / 2;
    const cz = S.y + S.h / 2;
    scene.add(box(S.w, 10, S.h, mat('#1f2937'), cx, 5, cz), box(S.w, 70, 4, mat('#4c1d95'), cx, 40, S.y));
    scene.add(placeSign('🎤 SAHNA', 90, 20, '#7c3aed', cx, 84, S.y + 3));
    [-1, 1].forEach((k) => {
      scene.add(cyl(2, 2, 90, mat('#334155'), cx + k * (S.w / 2 - 6), 45, S.y + 8, 8));
      scene.add(mesh(new THREE.SphereGeometry(6, 10, 8), glow(k > 0 ? '#ec4899' : '#22d3ee', 1.6), cx + k * (S.w / 2 - 6), 90, S.y + 12, false));
    });
  }
  function setStage(s2) {
    const before = stage;
    stage = s2;
    if (s2 && (!before || before.key !== s2.key) && !s2.me) toast(`🎤 ${s2.name} sahnaga chiqdi! Bog'dagi sahnaga keling`, 'success');
  }
  function updateStageUi() {
    const sp = world.places.stage.spot;
    const near = stage && !stage.me && Math.hypot(sp.x - me.x, sp.y - me.y) < 650;
    $('btn-clap').hidden = !near;
    const text = stage ? (stage.me ? `🎤 Siz sahnadasiz · 👏 ${stage.claps} · +${formatNumber(stage.earned)} so'm · ${stage.left} s`
      : `🎤 ${stage.name} sahnada · 👏 ${stage.claps}`) : '';
    if (text === stageSig) return;
    stageSig = text;
    $('stage-card').hidden = !text;
    $('stage-text').textContent = text;
  }
  $('btn-clap').addEventListener('click', async () => {
    try {
      await api('/api/game/stage/clap', { method: 'POST' });
      me.emote = { e: '👏', until: performance.now() + 2000 };
    } catch (err) {
      if (!handleAuthError(err)) toast(err.message, 'warn');
    }
  });
  async function stageToggle() {
    try {
      if (stage && stage.me) {
        await api('/api/game/stage/down', { method: 'POST' });
        stage = null;
        toast('Sahnadan tushdingiz. Rahmat! 👏');
      } else {
        const d = await api('/api/game/stage/up', { method: 'POST' });
        setStage(d.stage);
        toast("Sahnadasiz! Mikrofonni yoqing (V) va qo'shiq ayting — har qarsak +200 so'm", 'success');
      }
    } catch (err) {
      if (!handleAuthError(err)) toast(err.message, 'warn');
    }
  }

  // ---------------- Qurilish bazasi ----------------
  function buildDepot() {
    const D = world.places.depot;
    const cx = D.x + D.w / 2;
    const cz = D.y + D.h / 2;
    for (let i = 0; i < 6; i += 1) scene.add(box(24, 18, 24, mat(i % 2 ? '#b45309' : '#a16207'), D.x + 16 + (i % 3) * 30, 9 + Math.floor(i / 3) * 18, D.y + 20));
    scene.add(cyl(3, 3, 120, mat('#f59e0b'), cx + 40, 60, cz, 8), box(110, 5, 5, mat('#f59e0b'), cx + 5, 118, cz));
    scene.add(placeSign('QURILISH BAZASI', 110, 16, '#b45309', cx, 40, D.y + D.h + 4));
  }

  // ---------------- Mahalla raisi, guvohnoma, ferma, oshxona, avtopoyga kubogi ----------------
  let mayorKey = null;
  let farmList = [];
  const farmMeshes = new Map();
  const CROP_INFO = { wheat: ['🌾', "Bug'doy", '#eab308'], tomato: ['🍅', 'Pomidor', '#ef4444'], melon: ['🍈', 'Qovun', '#facc15'] };
  const plotMid = (id) => { const p = world.plots[id]; return { x: p.x + p.w / 2, y: p.y + p.h / 2 }; };

  function cropModel(crop, stage) {
    const g = new THREE.Group();
    const leaf = mat(stage === 'ripe' && crop === 'wheat' ? '#d4a017' : '#22c55e');
    const fruit = mat(CROP_INFO[crop][2]);
    const s = stage === 'sprout' ? 0.4 : stage === 'grow' ? 0.75 : 1;
    if (crop === 'wheat') {
      const stem = new THREE.Mesh(new THREE.ConeGeometry(4, 26 * s, 5), leaf);
      stem.position.y = 13 * s;
      g.add(stem);
    } else {
      const bush = new THREE.Mesh(new THREE.SphereGeometry(8 * s, 7, 5), leaf);
      bush.position.y = 6 * s;
      g.add(bush);
      if (stage === 'ripe') {
        const f = new THREE.Mesh(new THREE.SphereGeometry(crop === 'melon' ? 6 : 3.5, 8, 6), fruit);
        f.position.set(5, crop === 'melon' ? 4 : 9, 3);
        g.add(f);
      }
    }
    return g;
  }

  function setFarm(list) {
    farmList = list || [];
    const seen = new Set();
    farmList.forEach((f) => {
      seen.add(f.plot);
      const stage = f.progress >= 1 ? 'ripe' : f.progress >= 0.34 ? 'grow' : 'sprout';
      const key = `${f.crop}|${stage}|${f.owner === me.key}`;
      const old = farmMeshes.get(f.plot);
      if (old && old.key === key) return;
      if (old) { scene.remove(old.group); disposeTree(old.group); }
      const p = world.plots[f.plot];
      if (!p) return;
      const group = new THREE.Group();
      group.add(flat(p.w - 30, p.h - 30, mat('#7c4a2d', { roughness: 1 }), p.x + p.w / 2, p.y + p.h / 2, 1.2));
      for (let r = 0; r < 4; r += 1) {
        for (let c = 0; c < 6; c += 1) {
          const m = cropModel(f.crop, stage);
          m.position.set(p.x + 35 + c * ((p.w - 70) / 5), 1.2, p.y + 35 + r * ((p.h - 70) / 3));
          group.add(m);
        }
      }
      if (stage === 'ripe' && f.owner === me.key) {
        const lb = makeLabel(`${CROP_INFO[f.crop][0]} Hosil tayyor — F`, 'rgba(22,163,74,.92)', null, true);
        lb.position.set(p.x + p.w / 2, 60, p.y + p.h / 2);
        group.add(lb);
      }
      scene.add(group);
      farmMeshes.set(f.plot, { group, key });
    });
    [...farmMeshes.keys()].forEach((plot) => {
      if (!seen.has(plot)) {
        scene.remove(farmMeshes.get(plot).group);
        disposeTree(farmMeshes.get(plot).group);
        farmMeshes.delete(plot);
      }
    });
  }

  // F tugmasi: ekin ekish / hosil yig'ish / oshxona
  function lifeSpot(car) {
    if (car) return null;
    const near = (id, r) => { const c = plotMid(id); return Math.hypot(c.x - me.x, c.y - me.y) < r; };
    for (const f of farmList) {
      if (f.owner === me.key && near(f.plot, 200)) {
        if (f.progress >= 1) return { kind: 'fun', d: 1, text: `Hosilni yig'ish ${CROP_INFO[f.crop][0]}`, act: () => harvest(f.plot) };
      }
    }
    return null;
  }

  async function harvest(plot) {
    try {
      const d = await api('/api/game/farm/harvest', { method: 'POST', body: { plot } });
      localVersion += 1;
      setEconomy(d.economy);
      setFarm(d.farm);
      sound.cash();
      toast(`Hosil sotildi: +${formatNumber(d.pay)} so'm 🌾`, 'success');
    } catch (err) {
      if (!handleAuthError(err)) toast(err.message, 'warn');
    }
  }

  // ---- Ferma oynasi ----
  function openFarm(plot) {
    const st = { kind: 'farm', v: 0, data: null, plot };
    openSheet(st);
    loadInto(st, '/api/game/farm', (d) => { st.data = d; });
  }
  function renderFarmSheet(body, st) {
    setHead('home', 'Ferma', "Bo'sh yeringizga ekin eking, pishgach soting");
    const d = st.data;
    if (!d) return;
    if (st.plot !== null && st.plot !== undefined && !d.mine.some((f) => f.plot === st.plot)) {
      body.append(el('p', 'sheet-note', `${st.plot + 1}-yer: urug' tanlang`));
      const list = el('div', 'car-list');
      Object.entries(d.crops).forEach(([id, c]) => {
        const r = el('div', 'car-row');
        const sw = el('span', 'car-row__swatch', c.icon);
        sw.style.setProperty('--car', '#dcfce7');
        const info = el('div', 'car-row__info');
        info.append(el('strong', '', c.name), el('small', '', `${Math.round(c.grow / 60)} daqiqada pishadi · sotiladi ${formatNumber(c.sell)} so'm`));
        r.append(sw, info, priceButton('Ekish', c.seed, async () => {
          const res = await api('/api/game/farm/plant', { method: 'POST', body: { plot: st.plot, crop: id } });
          localVersion += 1;
          setEconomy(res.economy);
          setFarm(res.farm);
          sound.cash();
          toast(`${c.name} ekildi 🌱 — ${Math.round(c.grow / 60)} daqiqadan keyin keling`, 'success');
          closeSheet();
        }, 'btn--sm'));
        list.append(r);
      });
      body.append(list);
    }
    body.append(el('h3', 'life-h3', 'Ekinlaringiz'));
    if (!d.mine.length) body.append(el('p', 'sheet-note', "Hali ekin yo'q. Bo'sh yeringiz yoniga boring va F bosing."));
    d.mine.forEach((f) => {
      const c = d.crops[f.crop];
      const r = el('div', 'car-row');
      const info = el('div', 'car-row__info');
      info.append(el('strong', '', `${c.icon} ${c.name} — ${f.plot + 1}-yer`),
        el('small', '', f.progress >= 1 ? "Tayyor! Borib F bosing" : `${Math.round(f.progress * 100)}% · ${Math.ceil(f.left / 60)} daqiqa qoldi`));
      r.append(info, actionBtn('map-pin', "Yo'l", () => { const m = plotMid(f.plot); setGuide(m.x, m.y, 'Ferma'); closeSheet(); }, 'btn btn--ghost btn--sm'));
      body.append(r);
    });
    if (!d.empty.length && !d.mine.length) body.append(el('p', 'sheet-note', "Bo'sh yeringiz yo'q — Bozordan yer sotib oling."));
    else if (d.empty.length) {
      const free = d.empty.filter((id) => !d.mine.some((f) => f.plot === id));
      if (free.length) body.append(el('p', 'sheet-note', `Bo'sh yerlaringiz: ${free.map((x) => x + 1).join(', ')}`));
    }
  }

  // ---- Oshxona (kafe egasi uchun) ----
  async function openKitchen() {
    const st = { kind: 'kitchen', v: 0, order: null, picked: [], result: null, ingredients: [] };
    openSheet(st);
    await newOrder(st);
  }
  async function newOrder(st) {
    try {
      const d = await api('/api/game/kitchen/order', { method: 'POST' });
      if (sheetState !== st) return;
      st.order = d.order;
      st.ingredients = [...d.ingredients].sort(() => Math.random() - 0.5);
      st.picked = [];
      st.result = null;
      st.fast = d.fast;
      st.v += 1;
      renderSheet();
    } catch (err) {
      closeSheet();
      if (!handleAuthError(err)) toast(err.message, 'warn');
    }
  }
  function renderKitchenSheet(body, st) {
    setHead('coffee', 'Oshxona', 'Retsept bo\'yicha tez tayyorlang — tez bo\'lsa ko\'proq pul');
    if (!st.order) return;
    const o = st.order;
    body.append(el('p', 'kitchen__dish', `${o.icon} ${o.name}`),
      el('p', 'sheet-note', `Retsept: ${o.recipe.join(' → ')} · ${st.fast} soniya ichida to'liq haq`));
    const plate = el('div', 'kitchen__plate');
    st.picked.forEach((x) => plate.append(el('span', 'chip', x)));
    if (!st.picked.length) plate.append(el('small', '', 'Masalliqlarni tartib bilan bosing…'));
    body.append(plate);
    if (st.result) {
      body.append(el('p', st.result.ok ? 'kitchen__ok' : 'kitchen__bad', st.result.msg),
        actionBtn('refresh', 'Keyingi buyurtma', () => newOrder(st), 'btn btn--primary btn--block'));
      return;
    }
    const grid = el('div', 'kitchen__grid');
    st.ingredients.forEach((ing) => {
      const b = el('button', 'btn btn--ghost', ing);
      b.type = 'button';
      b.addEventListener('click', async () => {
        st.picked.push(ing);
        st.v += 1;
        if (st.picked.length >= o.recipe.length) {
          try {
            const r = await api('/api/game/kitchen/serve', { method: 'POST', body: { id: o.id, items: st.picked } });
            st.result = r;
            if (r.economy) { localVersion += 1; setEconomy(r.economy); }
            if (r.ok) sound.cash();
          } catch (err) {
            st.result = { ok: false, msg: err.message };
          }
          st.v += 1;
        }
        renderSheet();
      });
      grid.append(b);
    });
    body.append(grid, actionBtn('x', 'Tozalash', () => { st.picked = []; st.v += 1; renderSheet(); }, 'btn btn--ghost btn--block'));
  }

  // ---- Saylov ----
  function openElection() {
    const st = { kind: 'election', v: 0, data: null };
    openSheet(st);
    loadInto(st, '/api/game/election', (d) => { st.data = d; });
  }
  function renderElectionSheet(body, st) {
    const d = st.data;
    setHead('vote', 'Mahalla raisi saylovi', d ? `${d.month} · ovoz berishga ${d.days_left} kun qoldi` : 'Yuklanmoqda…');
    if (!d) return;
    const post = async (url, b) => {
      try {
        st.data = await api(url, { method: 'POST', body: b });
        localVersion += 1;
        st.v += 1;
        renderSheet();
      } catch (err) {
        if (!handleAuthError(err)) toast(err.message, 'warn');
      }
    };
    body.append(el('p', 'sheet-note', d.mayor ? `👑 Hozirgi rais: ${d.mayor.name} (o'tgan oy g'olibi)` : "Hozircha rais yo'q — shu oy saylovida g'olib bo'lgan keyingi oy rais bo'ladi."),
      el('p', 'sheet-note', `Rais imtiyozi: ismi yonida 👑 toj va har kuni ${formatNumber(d.salary)} so'm maosh.`));
    if (d.can_salary) {
      body.append(actionBtn('coins', `Kunlik maoshni olish (+${formatNumber(d.salary)})`, async () => {
        try {
          const r = await api('/api/game/election/salary', { method: 'POST' });
          localVersion += 1;
          setEconomy(r.economy);
          sound.cash();
          toast(`Rais maoshi: +${formatNumber(r.paid)} so'm 👑`, 'success');
          loadInto(st, '/api/game/election', (x) => { st.data = x; });
        } catch (err) { toast(err.message, 'warn'); }
      }, 'btn btn--primary btn--block'));
    }
    body.append(el('h3', 'life-h3', 'Nomzodlar'));
    if (!d.candidates.length) body.append(el('p', 'sheet-note', "Hali nomzod yo'q. Birinchi bo'ling!"));
    d.candidates.forEach((c) => {
      const r = el('div', 'car-row');
      const info = el('div', 'car-row__info');
      info.append(el('strong', '', `${c.name}${c.me ? ' (siz)' : ''}`), el('small', '', `${c.votes} ovoz`));
      r.append(info);
      if (d.my_vote === c.key) r.append(el('span', 'chip', '✓ Ovozingiz'));
      else if (!d.my_vote && !c.me) r.append(actionBtn('vote', 'Ovoz berish', () => post('/api/game/election/vote', { key: c.key }), 'btn btn--primary btn--sm'));
      body.append(r);
    });
    if (!d.running && !IS_OWNER) {
      body.append(priceButton("Nomzod bo'lish", d.fee, () => post('/api/game/election/run')));
    }
  }

  // ---- Haydovchilik guvohnomasi ----
  function openLicense() {
    const st = { kind: 'license', v: 0, data: null, answers: {}, result: null };
    openSheet(st);
    loadInto(st, '/api/game/license', (d) => { st.data = d; });
  }
  function renderLicenseSheet(body, st) {
    setHead('car', "Yo'l harakati qoidalari testi", 'Tez mashinalar uchun haydovchilik guvohnomasi');
    const d = st.data;
    if (!d) return;
    if (d.has) {
      body.append(el('p', 'kitchen__ok', '🪪 Haydovchilik guvohnomangiz bor — hamma mashinani sotib olishingiz mumkin.'));
      return;
    }
    body.append(el('p', 'sheet-note', `Guvohnomasiz sotib bo'lmaydigan mashinalar: ${d.cars.join(', ')}. ${d.questions.length} ta savoldan kamida ${d.pass_n} tasiga to'g'ri javob bering.`));
    if (st.result) {
      body.append(el('p', st.result.passed ? 'kitchen__ok' : 'kitchen__bad', st.result.passed
        ? `Tabriklaymiz! ${st.result.right}/${st.result.total} — guvohnoma berildi 🪪`
        : `${st.result.right}/${st.result.total} — yetmadi. 1 daqiqadan keyin qayta urinib ko'ring.`));
      if (!st.result.passed) body.append(actionBtn('refresh', 'Qaytadan', () => { st.result = null; st.answers = {}; loadInto(st, '/api/game/license', (x) => { st.data = x; }); }, 'btn btn--ghost btn--block'));
      return;
    }
    if (d.wait > 0) {
      body.append(el('p', 'sheet-note', `Qayta topshirish uchun ${d.wait} soniya kuting.`));
      return;
    }
    d.questions.forEach((q, n) => {
      const box = el('div', 'lic-q');
      box.append(el('strong', '', `${n + 1}. ${q.q}`));
      const opts = el('div', 'lic-opts');
      q.options.forEach((o, i) => {
        const b = el('button', `btn ${st.answers[q.id] === i ? 'btn--primary' : 'btn--ghost'} btn--sm`, o);
        b.type = 'button';
        b.addEventListener('click', () => { st.answers[q.id] = i; st.v += 1; renderSheet(); });
        opts.append(b);
      });
      box.append(opts);
      body.append(box);
    });
    const done = Object.keys(st.answers).length === d.questions.length;
    const send = actionBtn('check', 'Javoblarni yuborish', async () => {
      try {
        st.result = await api('/api/game/license', { method: 'POST', body: { answers: st.answers } });
        if (st.result.passed) sound.cash();
      } catch (err) { toast(err.message, 'warn'); }
      st.v += 1;
      renderSheet();
    }, 'btn btn--primary btn--block');
    send.disabled = !done;
    body.append(send);
  }

  // ---- Avtopoyga chempionati ----
  function openCup() {
    const st = { kind: 'cup', v: 0, data: null };
    openSheet(st);
    loadInto(st, '/api/game/cup', (d) => { st.data = d; });
  }
  function renderCupSheet(body, st) {
    const d = st.data;
    setHead('trophy', 'Avtopoyga chempionati', d ? `${d.week} · siz ${d.my_wins} marta yutdingiz` : 'Yuklanmoqda…');
    if (!d) return;
    body.append(el('p', 'sheet-note', `Hafta oxirida eng ko'p poyga yutgan 3 kishi kubok oladi: 🥇 ${formatNumber(d.prizes[0])} · 🥈 ${formatNumber(d.prizes[1])} · 🥉 ${formatNumber(d.prizes[2])} so'm. Poyga — Menyu → Poyga yoki boshqa o'yinchini chaqiring.`));
    if (d.last.length) body.append(el('p', 'sheet-note', `O'tgan hafta chempionlari: ${d.last.map((n, i) => `${['🥇', '🥈', '🥉'][i]} ${n}`).join('  ')}`));
    if (!d.top.length) body.append(el('p', 'sheet-note', "Bu hafta hali hech kim yutmagan."));
    d.top.forEach((t) => {
      const r = el('div', `car-row${t.me ? ' is-me' : ''}`);
      const info = el('div', 'car-row__info');
      info.append(el('strong', '', `${t.place <= 3 ? ['🥇', '🥈', '🥉'][t.place - 1] : `${t.place}.`} ${t.name}`), el('small', '', `${t.wins} g'alaba`));
      r.append(info);
      body.append(r);
    });
  }

  // ---------------- O'rgimchak odam ----------------
  // Shaharda kichkina o'rgimchak yashiringan. Topsangiz — chaqadi va siz tomlarga chiqib,
  // to'r otib uchadigan bo'lasiz. Kostyum — qizil va qora.
  const SPIDER_SUIT = { shirt: '#dc2626', pants: '#111111', skin: '#b91c1c', hat: null };
  const WEB_RANGE = 460;
  const WEB_TIME = 0.7;
  let spiderBug = null;
  let bugView = null;
  let zip = null;
  const webLines = new Map();

  function suitLooks(looks, on) {
    return on ? { ...(looks || {}), ...SPIDER_SUIT } : (looks || {});
  }

  function setSpiderMe(on) {
    if (Boolean(me.spider) === Boolean(on)) return;
    me.spider = Boolean(on);
    setRigLooks(me.rig, suitLooks(me.looks, me.spider));
    $('btn-web').hidden = !me.spider;
    if (!me.spider) { zip = null; me.web = null; }
  }

  function spiderModel() {
    const g = new THREE.Group();
    const black = mat('#0b0b0b');
    const body = new THREE.Mesh(new THREE.SphereGeometry(4.5, 10, 8), black);
    body.position.y = 4;
    const head = new THREE.Mesh(new THREE.SphereGeometry(2.6, 8, 6), black);
    head.position.set(5, 3.5, 0);
    const mark = new THREE.Mesh(new THREE.SphereGeometry(1.4, 6, 4), mat('#dc2626'));
    mark.position.set(-1, 8, 0);
    g.add(body, head, mark);
    for (let i = 0; i < 8; i += 1) {
      const side = i < 4 ? 1 : -1;
      const leg = box(9, 0.8, 0.8, black, 0, 3, 0);
      leg.position.set((i % 4) * 2.4 - 3, 2.5, side * 5);
      leg.rotation.y = side * (0.6 - (i % 4) * 0.35);
      leg.rotation.z = -0.35;
      g.add(leg);
    }
    g.scale.setScalar(1.2);
    return g;
  }

  function setSpiderBug(pos) {
    spiderBug = pos || null;
    if (!spiderBug) {
      if (bugView) bugView.visible = false;
      return;
    }
    if (!bugView) {
      bugView = spiderModel();
      scene.add(bugView);
    }
    bugView.visible = true;
  }

  function stepSpider(dt) {
    if (bugView && bugView.visible && spiderBug) {
      // biroz u yoq-bu yoqqa yuguradi
      const t = performance.now() / 1000;
      bugView.position.set(spiderBug.x + Math.sin(t * 1.7) * 6, 0.5, spiderBug.y + Math.cos(t * 1.3) * 6);
      bugView.rotation.y = t * 0.8;
    }
    // to'r bilan uchish
    if (zip) {
      zip.t += dt / WEB_TIME;
      const k = Math.min(1, zip.t);
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      me.x = zip.x0 + (zip.x1 - zip.x0) * e;
      me.y = zip.y0 + (zip.y1 - zip.y0) * e;
      me.h = zip.h0 + (zip.h1 - zip.h0) * e + Math.sin(Math.PI * k) * 140;
      me.vh = 0;
      me.moving = true;
      if (k >= 1) {
        zip = null;
        me.web = null;
      }
    }
    drawWeb('me', me.rig, zip ? me.web : null, me.h);
  }

  function shootWeb() {
    if (!me.spider || carInfo() || me.seat || me.para || zip || sheetState) return;
    // Oldingi tomonga: yaqinroq bino bo'lsa — uning tomiga, bo'lmasa — yerga
    let best = null;
    for (let d = WEB_RANGE; d >= 120; d -= 30) {
      const x = me.x + Math.cos(me.dir) * d;
      const y = me.y + Math.sin(me.dir) * d;
      if (!inAreas(x, y, 14)) continue;
      const top = topUnder(x, y, 14);
      if (!best || top > best.h) best = { x, y, h: top };
    }
    if (!best) {
      toast("To'r yetmaydi — boshqa tomonga qarang", 'warn');
      return;
    }
    zip = { t: 0, x0: me.x, y0: me.y, h0: me.h, x1: best.x, y1: best.y, h1: best.h };
    me.web = { x: Math.round(best.x), y: Math.round(best.y), h: Math.round(best.h + 60) };
    sound.door();
  }

  // To'r chizig'i: qo'ldan to'r yopishgan joygacha
  function drawWeb(id, rig, web, h) {
    let line = webLines.get(id);
    if (!web) {
      if (line) line.visible = false;
      return;
    }
    if (!line) {
      line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
        new THREE.LineBasicMaterial({ color: '#f8fafc' }));
      line.frustumCulled = false;
      scene.add(line);
      webLines.set(id, line);
    }
    const p = rig.root.position;
    line.geometry.setFromPoints([new THREE.Vector3(p.x, p.y + 52, p.z), new THREE.Vector3(web.x, web.h, web.y)]);
    line.visible = true;
  }

  function webOthers(list) {
    const seen = new Set();
    list.forEach((p) => {
      const o = others.get(p.key);
      if (!o) return;
      seen.add(p.key);
      drawWeb(p.key, o.rig, p.spider ? p.web : null, p.h || 0);
    });
    [...webLines.keys()].forEach((k) => {
      if (k !== 'me' && !seen.has(k)) {
        scene.remove(webLines.get(k));
        webLines.get(k).geometry.dispose();
        webLines.delete(k);
      }
    });
  }

  async function catchSpider() {
    try {
      await api('/api/game/spider/catch', { method: 'POST' });
      localVersion += 1;
      setSpiderMe(true);
      setSpiderBug(null);
      sound.ding();
      toast("Voy! O'rgimchak chaqdi 🕷️ Endi siz o'rgimchak odamsiz: binoga yursangiz — tomga chiqasiz, T — to'r otib uchish", 'success');
    } catch (err) {
      if (!handleAuthError(err)) toast(err.message, 'warn');
    }
  }

  function openSpider() {
    const st = { kind: 'spider', v: 0 };
    openSheet(st);
  }
  function renderSpiderSheet(body) {
    setHead('target', "O'rgimchak odam", me.spider ? 'Siz o\'rgimchak odamsiz 🕷️' : "O'rgimchakni toping");
    if (me.spider) {
      body.append(el('p', 'sheet-note', "• Binoga qarab yuring — devoridan chiqib tomida yurasiz."),
        el('p', 'sheet-note', "• T tugmasi (yoki 🕸️ To'r) — oldingizdagi eng baland tomga to'r otib uchib borasiz."),
        el('p', 'sheet-note', "• Tomdan chetga yursangiz — pastga sakraysiz."),
        actionBtn('x', "Oddiy odamga qaytish", async () => {
          await api('/api/game/spider/off', { method: 'POST' }).catch(() => null);
          localVersion += 1;
          setSpiderMe(false);
          me.h = 0;
          closeSheet();
        }, 'btn btn--ghost btn--block'));
      return;
    }
    body.append(el('p', 'sheet-note', "Shaharda kichkina qora o'rgimchak yashiringan. U odamlar kam boradigan burchaklarda o'tiradi — juda yaqin kelsangizgina ko'rinadi."),
      el('p', 'sheet-note', "Topsangiz F bosing — o'rgimchak sizni chaqadi va siz o'rgimchak odamga aylanasiz! Keyin u boshqa joyga qochib yashirinadi."),
      el('p', 'sheet-note', "Maslahat: xaritaning chekkalari, o'rmon va port tomonlarni qidiring 🔍"),
      el('p', 'sheet-note', "Tomlar ustida to'r otib uchib yurgan 🕷️ O'rgimchak odamni ko'ryapsizmi? Siz ham shunday bo'lasiz!"));

  }

  // ---------------- Uchar gilam, dron, kosmik raketa, daryo va ko'prik ----------------
  function carCarpet(color) {
    const g = new THREE.Group();
    const rug = mat(color, { roughness: 0.9 });
    g.add(box(34, 1.6, 58, rug, 0, 3, 0));
    // naqsh: o'rtada oltin romb, chetida hoshiya
    const gold = mat('#facc15', { roughness: 0.7 });
    g.add(box(30, 1.8, 3, gold, 0, 3.1, 25), box(30, 1.8, 3, gold, 0, 3.1, -25), box(3, 1.8, 50, gold, 15, 3.1, 0), box(3, 1.8, 50, gold, -15, 3.1, 0));
    const dia = box(12, 2, 12, mat('#1e3a8a'), 0, 3.2, 0);
    dia.rotation.y = Math.PI / 4;
    g.add(dia);
    for (let i = -14; i <= 14; i += 4) g.add(box(1, 0.8, 4, gold, i, 2.6, 31), box(1, 0.8, 4, gold, i, 2.6, -31));
    const under = new THREE.Mesh(new THREE.CircleGeometry(30, 24), new THREE.MeshBasicMaterial({ color: '#fde68a', transparent: true, opacity: 0, depthWrite: false }));
    under.rotation.x = -Math.PI / 2;
    under.position.y = 0.6;
    g.add(under);
    g.userData = { wheels: [], pods: [], r: 2, roof: 10, flies: true, wings: [], under, ringMat: new THREE.MeshBasicMaterial(), fly: 0 };
    return g;
  }
  CAR_BUILDERS.carpet = carCarpet;

  // ---- Dron ----
  let droneOn = false;
  let droneView = null;
  function setDroneOwned(has) {
    me.drone = Boolean(has);
    $('btn-drone').hidden = !me.drone;
    if (!me.drone && droneOn) toggleDrone();
  }
  function toggleDrone() {
    droneOn = !droneOn;
    $('btn-photo').hidden = !droneOn;
    $('btn-drone').classList.toggle('is-on', droneOn);
    if (droneOn && !droneView) {
      droneView = new THREE.Group();
      const dark = mat('#1f2937');
      droneView.add(box(16, 4, 16, dark, 0, 0, 0));
      [[-12, -12], [12, -12], [-12, 12], [12, 12]].forEach(([x, z]) => {
        droneView.add(box(14, 1, 2, dark, x / 2, 0, z / 2));
        const rotor = cyl(7, 7, 0.6, mat('#94a3b8', { transparent: true, opacity: 0.7 }), x, 2.5, z, 12);
        rotor.userData.rotor = true;
        droneView.add(rotor);
      });
      droneView.add(mesh(new THREE.SphereGeometry(2.4, 8, 6), mat('#ef4444'), 0, -2.5, 8));
      scene.add(droneView);
    }
    if (droneView) droneView.visible = droneOn;
    toast(droneOn ? "Dron uchdi 🚁 — shahar tepadan. 📸 tugmasi bilan surat oling" : 'Dron qaytib keldi');
  }
  function stepDrone(dt) {
    if (!droneOn || !droneView) return;
    const t = performance.now() / 1000;
    droneView.position.set(me.x + Math.sin(t * 0.6) * 30, (me.h || 0) + 170 + Math.sin(t * 2) * 6, me.y + Math.cos(t * 0.6) * 30);
    droneView.children.forEach((c) => { if (c.userData.rotor) c.rotation.y += dt * 40; });
  }
  function takePhoto() {
    try {
      renderer.render(scene, camera);
      const url = renderer.domElement.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = `mahalla-${Date.now()}.png`;
      document.body.append(a);
      a.click();
      a.remove();
      sound.ding();
      toast('Surat saqlandi 📸', 'success');
    } catch {
      toast("Suratni saqlab bo'lmadi", 'warn');
    }
  }
  function openDrone() {
    const st = { kind: 'drone', v: 0 };
    openSheet(st);
  }
  function renderDroneSheet(body, st) {
    setHead('navigation', 'Dron', 'Shaharni tepadan ko\'ring va surat oling');
    if (me.drone) {
      body.append(actionBtn('navigation', 'Dron kuryer ishi — posilka yetkazish 📦', droneDelivery, 'btn btn--ghost btn--block'));
      body.append(el('p', 'sheet-note', '🚁 Dron sizda bor. Pastdagi «Dron» tugmasi — tepadan ko\'rish, «📸» — surat (rasm sifatida saqlanadi).'),
        actionBtn('navigation', droneOn ? 'Dronni qaytarish' : 'Dronni uchirish', () => { toggleDrone(); closeSheet(); }, 'btn btn--primary btn--block'));
      return;
    }
    body.append(el('p', 'sheet-note', "Dron bilan shahar tepadan ko'rinadi va chiroyli surat olasiz."),
      priceButton('Dron sotib olish', 50000, async () => {
        const d = await api('/api/game/drone', { method: 'POST' });
        localVersion += 1;
        setEconomy(d.economy);
        setDroneOwned(true);
        sound.cash();
        st.v += 1;
        renderSheet();
      }));
  }

  // ---- Kosmik raketa ----
  let rocketView = null;
  function buildRocket() {
    const R = world.rocket;
    if (!R) return;
    const g = new THREE.Group();
    g.add(cyl(70, 80, 8, mat('#6b7280'), 0, 4, 0, 24));
    const white = mat('#f8fafc', { metalness: 0.2, roughness: 0.4 });
    g.add(cyl(16, 16, 150, white, 0, 84, 0, 20), cyl(0.5, 16, 40, mat('#dc2626'), 0, 179, 0, 20));
    [0, 1, 2, 3].forEach((i) => {
      const fin = box(2, 34, 26, mat('#dc2626'), 0, 26, 0);
      fin.position.set(Math.cos(i * Math.PI / 2) * 18, 26, Math.sin(i * Math.PI / 2) * 18);
      fin.rotation.y = -i * Math.PI / 2;
      g.add(fin);
    });
    g.add(mesh(new THREE.SphereGeometry(6, 12, 8), mat('#38bdf8', { metalness: 0.4 }), 0, 120, 15.5));
    g.add(placeSign("🚀 OYGA SAYOHAT", 150, 30, '#1e3a8a', 0, 230, 0));
    g.position.set(R.x, 0, R.y);
    scene.add(g);
    rocketView = g;
  }
  function nearRocket() {
    const R = world.rocket;
    return R && Math.hypot(R.x - me.x, R.y - me.y) < 150;
  }
  async function flyToMoon() {
    if (!window.confirm(`Oyga uchasizmi? Narxi ${formatNumber(world.rocket.price)} so'm 🚀`)) return;
    try {
      const d = await api('/api/game/rocket', { method: 'POST' });
      localVersion += 1;
      setEconomy(d.economy);
      moonTrip(d.times);
    } catch (err) {
      if (!handleAuthError(err)) toast(err.message, 'warn');
    }
  }
  function moonTrip(times) {
    const ov = document.createElement('div');
    ov.className = 'moon-trip';
    ov.innerHTML = '<div class="moon-trip__stars"></div><div class="moon-trip__moon">🌕</div><div class="moon-trip__rocket">🚀</div><p class="moon-trip__text">Uchyapmiz… 3, 2, 1!</p>';
    document.body.append(ov);
    sound.whoosh(true);
    const text = ov.querySelector('.moon-trip__text');
    setTimeout(() => { text.textContent = 'Kosmosdamiz! Yer juda kichkina ko\'rinadi 🌍'; }, 2500);
    setTimeout(() => { text.textContent = `Oyga qo'ndingiz! 🌕 (${times}-marta) Yerga qaytamiz…`; ov.classList.add('is-landed'); }, 5000);
    setTimeout(() => {
      text.textContent = `Oydasiz! 🌕 (${times}-marta) Pastdagi oynada: baza, kislorod, Mars, stansiya`;
      spaceArrive(ov);
    }, 8000);
  }

  // ---- Daryo va ko'prik ----
  function buildRiver() {
    const R = world.river;
    if (!R) return;
    const r = R.rect;
    const w = R.water;
    const b = R.bridge;
    scene.add(flat(r.w, r.h, mat('#4d7c0f', { roughness: 1 }), r.x + r.w / 2, r.y + r.h / 2, 0.15));
    const water = mat('#2563eb', { roughness: 0.15, metalness: 0.2, transparent: true, opacity: 0.88 });
    scene.add(flat(w.w, w.h, water, w.x + w.w / 2, w.y + w.h / 2, 0.5));
    scene.add(flat(w.w, 10, mat('#a16207', { roughness: 1 }), w.x + w.w / 2, w.y - 5, 0.6), flat(w.w, 10, mat('#a16207', { roughness: 1 }), w.x + w.w / 2, w.y + w.h + 5, 0.6));
    // Ko'prik: yog'och yo'lak va panjaralar
    const wood = mat('#92400e', { roughness: 0.9 });
    scene.add(box(b.w, 4, b.h, wood, b.x + b.w / 2, 8, b.y + b.h / 2));
    [b.x + 4, b.x + b.w - 4].forEach((x) => {
      scene.add(box(3, 14, b.h, wood, x, 17, b.y + b.h / 2));
      for (let z = b.y; z <= b.y + b.h; z += 30) scene.add(box(4, 22, 4, wood, x, 11, z));
    });
    // Narigi qirg'oqda daraxtlar va o'rindiq
    for (let i = 0; i < 9; i += 1) {
      const x = 80 + i * 140;
      if (Math.abs(x - (b.x + b.w / 2)) < 120) continue;
      scene.add(cyl(5, 6, 34, mat('#713f12'), x, 17, r.y + r.h - 90), mesh(new THREE.SphereGeometry(26, 10, 8), mat('#15803d'), x, 50, r.y + r.h - 90));
    }
    scene.add(placeSign("🌉 DARYO · ko'prikdan baliq tuting", 210, 30, '#0f766e', b.x + b.w / 2, 60, b.y - 40));
  }
  function riverSolids() {
    const R = world.river;
    if (!R) return [];
    const w = R.water;
    const b = R.bridge;
    return [{ x: w.x, y: w.y, w: b.x - w.x, h: w.h, top: 40 }, { x: b.x + b.w, y: w.y, w: w.x + w.w - (b.x + b.w), h: w.h, top: 40 }];
  }
  const onBridge = () => Boolean(world.river && inside(me.x, me.y, world.river.bridge));

  // ---- Shaharning o'rgimchak odami (hamma ko'radi): tomdan tomga to'r otib uchib yuradi ----
  const NPC_HOP = 2.6;   // bir sakrash soniyasi
  const npc = { route: [], key: '', root: null, human: null, line: null, label: null };
  function npcRoute() {
    // Baland binolar tomlari — eng yaqinidan keyingisiga (yo'l uzilmasin)
    const roofs = [];
    plotsById.forEach((r) => {
      if (r.level > 0 && world.buildings[r.plot]) {
        const b = world.buildings[r.plot];
        roofs.push({ id: r.plot, x: b.x + b.w / 2, y: b.y + b.h / 2, top: buildingTop(r.kind, r.level) });
      }
    });
    roofs.sort((a, b) => a.id - b.id);
    const pool = roofs.filter((r) => r.top >= 60);
    const pts = pool.length >= 3 ? pool : [{ x: 1200, y: 700, top: 0 }, { x: 1700, y: 900, top: 0 }, { x: 2300, y: 800, top: 0 }, { x: 1700, y: 1150, top: 0 }];
    const route = [pts[0]];
    const left = pts.slice(1);
    while (left.length && route.length < 40) {
      const last = route[route.length - 1];
      let bi = 0;
      left.forEach((p, i) => { if (Math.hypot(p.x - last.x, p.y - last.y) < Math.hypot(left[bi].x - last.x, left[bi].y - last.y)) bi = i; });
      route.push(left.splice(bi, 1)[0]);
    }
    return route;
  }
  function stepNpcSpider() {
    if (!world || !plotsById) return;
    const key = [...plotsById.values()].filter((r) => r.level > 0).map((r) => `${r.plot}:${r.level}`).join(',');
    if (key !== npc.key) {
      npc.key = key;
      npc.route = npcRoute();
    }
    const R = npc.route;
    if (R.length < 2) return;
    if (!npc.root) {
      npc.root = new THREE.Group();
      npc.human = makeHuman("O'rgimchak odam", null, SPIDER_SUIT);
      npc.root.add(npc.human);
      npc.label = makeLabel("🕷️ O'rgimchak odam", 'rgba(127,29,29,.9)');
      npc.label.position.y = 82;
      npc.root.add(npc.label);
      scene.add(npc.root);
      npc.line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
        new THREE.LineBasicMaterial({ color: '#f8fafc' }));
      npc.line.frustumCulled = false;
      scene.add(npc.line);
    }
    // Hamma o'yinchida bir xil: soatga qarab (yo'l oldinga, keyin orqaga qaytadi)
    const n = R.length;
    const cyc = (n - 1) * 2;
    const tt = Date.now() / 1000 / NPC_HOP;
    let step = Math.floor(tt) % cyc;
    const k = tt - Math.floor(tt);
    let ai = step < n - 1 ? step : cyc - step;
    let bi = step < n - 1 ? step + 1 : cyc - step - 1;
    const A = R[ai];
    const B = R[bi];
    const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    const x = A.x + (B.x - A.x) * e;
    const y = A.y + (B.y - A.y) * e;
    const h = A.top + (B.top - A.top) * e + Math.sin(Math.PI * k) * 170;
    npc.root.position.set(x, h, y);
    const dir = Math.atan2(B.y - A.y, B.x - A.x);
    npc.human.rotation.y = Math.PI / 2 - dir;
    // qo'llar tepada (to'rni ushlab turibdi)
    const { armL, armR, legL, legR } = npc.human.userData;
    const swing = k < 0.85;
    armR.rotation.x = swing ? -2.8 : 0;
    armL.rotation.x = swing ? -0.6 : 0;
    legL.rotation.x = swing ? -0.5 : 0;
    legR.rotation.x = swing ? 0.3 : 0;
    if (swing) {
      const ax = (A.x + B.x) / 2;
      const ay = (A.y + B.y) / 2;
      const top = Math.max(A.top, B.top) + 320;
      npc.line.geometry.setFromPoints([new THREE.Vector3(x, h + 60, y), new THREE.Vector3(ax, top, ay)]);
    }
    npc.line.visible = swing;
  }

  // =====================================================================
  //  Shahar hayoti: bank, maktab, kutubxona, ustaxonalar, bozor, pochta, sarmoya,
  //  reklama, bayroq, labirint, poygalar, tramvay, soat, svetofor, fasllar,
  //  bo'ron va kamalak, kometa, suv osti, qor jangi, ot (game_city.py bilan ishlaydi)
  // =====================================================================
  const CITY_SIGNS = {
    bank: ['🏦 BANK', '#a16207', 70],
  };
  const city = { flag: null, flagView: null, comet: null, cometView: null, board: null, boardKey: '', boardView: null,
    clockView: null, clockMin: -1, race: null, raceBeacon: null, raceBusy: false, tramView: null, tram: false,
    lights: [], lastFine: 0, wasStorm: false, rainbow: null, rainbowUntil: 0, droneJob: null, mazeSolids: [] };
  const P_ = () => world.places;
  const near = (pt, r) => pt && Math.hypot(pt.x - me.x, pt.y - me.y) < r;
  const said = (err) => { if (!handleAuthError(err)) toast(err.message, 'warn'); };

  function cityBuilding(id) {
    const r = P_()[id];
    const [label, color, h] = CITY_SIGNS[id];
    const cx = r.x + r.w / 2;
    const cz = r.y + r.h / 2;
    const front = r.door.y < r.y ? r.y - 0.6 : r.y + r.h + 0.6;
    const g = new THREE.Group();
    g.add(box(r.w, h, r.h, mat(id === 'bank' ? '#e7e5e4' : '#f8fafc', { roughness: 0.8 }), cx, h / 2, cz));
    g.add(box(r.w + 12, 7, r.h + 12, mat(color), cx, h + 3.5, cz));
    g.add(box(26, 32, 2, mat('#78350f'), r.door.x, 16, front));
    [-1, 1].forEach((s) => g.add(box(22, 16, 2, mat('#bae6fd', { roughness: 0.1 }), cx + s * (r.w / 3.2), h * 0.6, front)));
    if (id === 'bank') [-60, -30, 30, 60].forEach((dx) => g.add(cyl(5, 5, h - 6, mat('#f5f5f4'), cx + dx, (h - 6) / 2, front + (front > cz ? 10 : -10), 10)));
    g.add(placeSign(label, Math.max(r.w, 150), 30, color, cx, h + 30, front));
    scene.add(g);
  }

  function buildCity() {
    const P = P_();
    if (!P.bank) return;
    Object.keys(CITY_SIGNS).forEach((id) => P[id] && cityBuilding(id));
    // Muzqaymoq aravachasi
    const ic = P.icecream;
    scene.add(box(ic.w, 24, ic.h, mat('#f9a8d4'), ic.x + ic.w / 2, 18, ic.y + ic.h / 2),
      cyl(30, 30, 2, mat('#fde047'), ic.x + ic.w / 2, 52, ic.y + ic.h / 2, 16), cyl(1.5, 1.5, 26, mat('#94a3b8'), ic.x + ic.w / 2, 40, ic.y + ic.h / 2, 6));
    scene.add(placeSign('🍦', 30, 24, '#ec4899', ic.x + ic.w / 2, 70, ic.y + ic.h + 1));
    // Shahar soati
    const ck = P.clock;
    scene.add(box(ck.w, 150, ck.h, mat('#a8a29e'), ck.x + ck.w / 2, 75, ck.y + ck.h / 2),
      mesh(new THREE.ConeGeometry(44, 40, 4), mat('#7c2d12'), ck.x + ck.w / 2, 170, ck.y + ck.h / 2));
    buildMaze();
    buildTram();
    buildLights();
    buildWreck();
  }
  function citySolids() {
    const P = P_();
    if (!P.bank) return [];
    const out = Object.keys(CITY_SIGNS).map((id) => ({ ...P[id], top: CITY_SIGNS[id][2] }));
    out.push({ ...P.clock, top: 190 });
    return out.concat(city.mazeSolids);
  }

  // ---- Soat: haqiqiy vaqt, har soatda qo'ng'iroq ----
  function stepClock() {
    const ck = P_().clock;
    if (!ck) return;
    const d = new Date();
    const min = d.getHours() * 60 + d.getMinutes();
    if (min === city.clockMin) return;
    const first = city.clockMin < 0;
    city.clockMin = min;
    if (city.clockView) { scene.remove(city.clockView); disposeTree(city.clockView); }
    const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    city.clockView = placeSign(`🕐 ${t}`, 58, 26, '#1e293b', ck.x + ck.w / 2, 120, ck.y + ck.h / 2 + 31);
    scene.add(city.clockView);
    if (!first && d.getMinutes() === 0) {
      sound.ding();
      toast(`🔔 Shahar soati: ${t}`);
    }
  }

  // ---- Bayroqni olish ----
  function setFlag(f) {
    city.flag = f || null;
    if (!city.flag) {
      if (city.flagView) city.flagView.visible = false;
      return;
    }
    if (!city.flagView) {
      const g = new THREE.Group();
      g.add(cyl(1.6, 1.6, 70, mat('#e5e7eb'), 0, 35, 0, 8), box(34, 20, 1, mat('#dc2626'), 17, 58, 0));
      scene.add(g);
      city.flagView = g;
    }
    city.flagView.visible = true;
    const h = f.holder === me.key ? me.h : 0;
    city.flagView.position.set(f.holder === me.key ? me.x : f.x, h + (f.holder ? 30 : 0), f.holder === me.key ? me.y : f.y);
  }
  function homeGate() {
    const id = economy.home;
    if (id === null || id === undefined || !world.plots[id]) return null;
    const p = world.plots[id];
    return { x: p.x + p.w / 2, y: p.gate === 'bottom' ? p.y + p.h + 40 : p.y - 40 };
  }

  // ---- Labirint (devorlar — hamma o'yinchida bir xil) ----
  function buildMaze() {
    const M = world.maze;
    if (!M) return;
    const r = M.rect;
    const n = M.cells;
    const cw = r.w / n;
    const ch = r.h / n;
    let seed = M.seed;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const right = Array.from({ length: n }, () => Array(n).fill(true));
    const down = Array.from({ length: n }, () => Array(n).fill(true));
    const seen = Array.from({ length: n }, () => Array(n).fill(false));
    const stack = [[0, 0]];
    seen[0][0] = true;
    while (stack.length) {
      const [cx, cy] = stack[stack.length - 1];
      const opts = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => {
        const x = cx + dx;
        const y = cy + dy;
        return x >= 0 && y >= 0 && x < n && y < n && !seen[y][x];
      });
      if (!opts.length) { stack.pop(); continue; }
      const [dx, dy] = opts[Math.floor(rnd() * opts.length)];
      const x = cx + dx;
      const y = cy + dy;
      if (dx === 1) right[cy][cx] = false; else if (dx === -1) right[cy][x] = false;
      else if (dy === 1) down[cy][cx] = false; else down[y][cx] = false;
      seen[y][x] = true;
      stack.push([x, y]);
    }
    const hedge = mat('#166534', { roughness: 1 });
    const T = 12;
    const H = 46;
    const walls = [];
    const add = (x, y, w, h) => { walls.push({ x, y, w, h, top: 60 }); scene.add(box(w, H, h, hedge, x + w / 2, H / 2, y + h / 2)); };
    scene.add(flat(r.w, r.h, mat('#4d7c0f', { roughness: 1 }), r.x + r.w / 2, r.y + r.h / 2, 0.15));
    const mid = Math.floor(n / 2);
    for (let i = 0; i < n; i += 1) {
      if (i !== mid) add(r.x + i * cw, r.y - T / 2, cw, T);            // tepa (chiqish — o'rtada)
      if (i !== mid) add(r.x + i * cw, r.y + r.h - T / 2, cw, T);      // past (kirish — o'rtada)
      add(r.x - T / 2, r.y + i * ch, T, ch);
      add(r.x + r.w - T / 2, r.y + i * ch, T, ch);
    }
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        if (x < n - 1 && right[y][x]) add(r.x + (x + 1) * cw - T / 2, r.y + y * ch, T, ch);
        if (y < n - 1 && down[y][x]) add(r.x + x * cw, r.y + (y + 1) * ch - T / 2, cw, T);
      }
    }
    city.mazeSolids = walls;
    scene.add(placeSign('🌿 LABIRINT — kirish', 170, 28, '#166534', M.start.x, 70, M.start.y + 40));
    scene.add(placeSign('🏁 CHIQISH', 120, 28, '#b91c1c', M.finish.x, 70, M.finish.y - 30));
  }

  // ---- Velosiped va qayiq poygalari (nazorat nuqtalari) ----
  function raceVehicleOk(id) {
    if (id === 'boat') return Boolean(me.boat);
    if (id === 'ski') return !carInfo() && !me.boat;
    const c = carInfo();
    return Boolean(c && (c.style === 'bike' || c.style === 'skate'));
  }
  async function startRace(id) {
    try {
      const d = await api(`/api/game/cprace/${id}/start`, { method: 'POST' });
      city.race = { id, next: d.next, points: d.points, t0: performance.now() };
      showRaceBeacon();
      sound.ding();
      toast(`${world.cpraces[id].name} boshlandi! Ko'k nurlarni ketma-ket bosib o'ting 🏁`, 'success');
    } catch (err) { said(err); }
  }
  function showRaceBeacon() {
    city.raceBeacon = dropBeacon(city.raceBeacon);
    if (!city.race) return;
    const p = city.race.points[city.race.next];
    city.raceBeacon = makeBeacon(p.x, p.y, '#22c55e', 60);
  }
  async function stepRace() {
    const R = city.race;
    if (!R || city.raceBusy) return;
    const p = R.points[R.next];
    if (!near(p, 110)) return;
    city.raceBusy = true;
    try {
      const d = await api(`/api/game/cprace/${R.id}/check`, { method: 'POST' });
      if (d.done) {
        city.race = null;
        showRaceBeacon();
        sound.cash();
        toast(`Marra! ${d.time} soniya${d.best ? ' — haftalik rekordingiz!' : ''} +${formatNumber(d.pay)} so'm 🏆`, 'success');
        localVersion += 1;
        setEconomy(d.economy);
      } else {
        R.next = d.next;
        showRaceBeacon();
        sound.ding();
      }
    } catch (err) {
      if (/boshlanmagan/.test(err.message)) { city.race = null; showRaceBeacon(); }
    }
    city.raceBusy = false;
  }

  // ---- Tramvay: 1900-ko'chada borib-keladi, bekatlarda to'xtaydi ----
  const TRAM_STOPS = [800, 2400, 4000, 5600];
  const TRAM_Y = 1940;
  const TRAM_V = 260;
  const TRAM_WAIT = 6;
  function tramAt(t) {
    const legs = [];
    for (let i = 0; i < TRAM_STOPS.length - 1; i += 1) legs.push([TRAM_STOPS[i], TRAM_STOPS[i + 1]]);
    for (let i = TRAM_STOPS.length - 1; i > 0; i -= 1) legs.push([TRAM_STOPS[i], TRAM_STOPS[i - 1]]);
    const durs = legs.map(([a, b]) => TRAM_WAIT + Math.abs(b - a) / TRAM_V);
    const total = durs.reduce((s, d) => s + d, 0);
    let k = t % total;
    for (let i = 0; i < legs.length; i += 1) {
      if (k < durs[i]) {
        const [a, b] = legs[i];
        if (k < TRAM_WAIT) return { x: a, dir: Math.sign(b - a), stopped: true };
        return { x: a + Math.sign(b - a) * (k - TRAM_WAIT) * TRAM_V, dir: Math.sign(b - a), stopped: false };
      }
      k -= durs[i];
    }
    return { x: TRAM_STOPS[0], dir: 1, stopped: true };
  }
  function buildTram() {
    const g = new THREE.Group();
    g.add(box(150, 44, 46, mat('#dc2626'), 0, 30, 0), box(152, 8, 48, mat('#fde047'), 0, 6, 0));
    for (let i = -2; i <= 2; i += 1) g.add(box(20, 14, 47, mat('#bae6fd', { roughness: 0.1 }), i * 28, 38, 0));
    g.add(cyl(1, 1, 24, mat('#111827'), 0, 64, 0, 6));
    scene.add(g);
    city.tramView = g;
    const rail = mat('#64748b');
    scene.add(box(TRAM_STOPS[3] - TRAM_STOPS[0] + 200, 1.5, 3, rail, (TRAM_STOPS[0] + TRAM_STOPS[3]) / 2, 0.9, TRAM_Y - 14),
      box(TRAM_STOPS[3] - TRAM_STOPS[0] + 200, 1.5, 3, rail, (TRAM_STOPS[0] + TRAM_STOPS[3]) / 2, 0.9, TRAM_Y + 14));
    TRAM_STOPS.forEach((x) => scene.add(placeSign('🚋 Tramvay', 90, 22, '#dc2626', x, 60, TRAM_Y - 60)));
  }
  function stepTram() {
    if (!city.tramView) return;
    const s = tramAt(Date.now() / 1000);
    city.tramView.position.set(s.x, 0, TRAM_Y);
    if (city.tram) {
      me.x = s.x;
      me.y = TRAM_Y;
      me.h = 0;
      me.vx = 0;
      me.vz = 0;
      me.dir = s.dir > 0 ? 0 : Math.PI;
    }
  }
  function toggleTram() {
    if (city.tram) {
      city.tram = false;
      me.y = TRAM_Y - 70;
      me.rig.root.visible = true;
      toast('Tramvaydan tushdingiz');
      return;
    }
    city.tram = true;
    toast('Tramvaydasiz 🚋 — F bosib istalgan joyda tushing');
  }

  // ---- Svetoforlar: qizilda o'tsa — jarima ----
  const LIGHT_CROSS = [[1940, 1140], [2720, 1140], [1940, 1900], [3500, 1900]];
  function lightPhase(t) {
    const k = t % 26;
    return k < 11 ? 'ew' : (k < 13 ? 'yellow' : (k < 24 ? 'ns' : 'yellow'));
  }
  function buildLights() {
    LIGHT_CROSS.forEach(([x, y]) => {
      const g = new THREE.Group();
      g.add(cyl(2, 2, 60, mat('#334155'), 0, 30, 0, 6), box(12, 30, 10, mat('#111827'), 0, 66, 0));
      const lamps = ['#ef4444', '#facc15', '#22c55e'].map((c, i) => {
        const m = new THREE.Mesh(new THREE.SphereGeometry(3.6, 10, 8), new THREE.MeshBasicMaterial({ color: c }));
        m.position.set(0, 76 - i * 9.5, 5.5);
        g.add(m);
        return m;
      });
      g.position.set(x - 8, 0, y - 8);
      scene.add(g);
      city.lights.push({ x, y, lamps });
    });
  }
  function stepLights() {
    const ph = lightPhase(Date.now() / 1000);
    city.lights.forEach((L) => {
      L.lamps[0].material.color.set(ph === 'ns' ? '#ef4444' : '#3f1d1d');
      L.lamps[1].material.color.set(ph === 'yellow' ? '#facc15' : '#3a3410');
      L.lamps[2].material.color.set(ph === 'ew' ? '#22c55e' : '#123020');
    });
    const car = carInfo();
    if (!car || car.flies || me.h > 5 || Math.abs(me.vx) + Math.abs(me.vz) < 60) return;
    const ew = Math.abs(me.vx) > Math.abs(me.vz);
    for (const L of city.lights) {
      if (me.x > L.x && me.x < L.x + 80 && me.y > L.y && me.y < L.y + 80) {
        const red = ph === 'yellow' ? false : (ew ? ph === 'ns' : ph === 'ew');
        if (red && performance.now() - city.lastFine > 20000) {
          city.lastFine = performance.now();
          api('/api/game/fine', { method: 'POST' }).then((d) => {
            if (d.fine) {
              localVersion += 1;
              if (d.economy) setEconomy(d.economy);
              toast(`🚦 Qizil chiroqda o'tdingiz — ${formatNumber(d.fine)} so'm jarima`, 'warn');
            }
          }).catch(() => null);
        }
      }
    }
  }

  // ---- Fasllar ----
  function season() {
    const m = new Date().getMonth() + 1;
    return m === 12 || m <= 2 ? 'winter' : m <= 5 ? 'spring' : m <= 8 ? 'summer' : 'autumn';
  }
  function seasonCrown(color, i) {
    const s = season();
    if (s === 'autumn') return color.setHSL(0.07 + (i % 5) * 0.015, 0.75, 0.42 + (i % 3) * 0.04);
    if (s === 'winter') return color.setHSL(0.58, 0.15, 0.82 + (i % 3) * 0.04);
    if (s === 'spring' && i % 6 === 0) return color.setHSL(0.92, 0.6, 0.75);
    return color.setHSL(0.3 + (i % 5) * 0.012, 0.5, 0.28 + (i % 3) * 0.04);
  }

  // ---- Bo'rondan keyin kamalak ----
  function stepRainbow(now) {
    const storm = weather.kind === 'storm' && weather.level > 0.5;
    if (city.wasStorm && !storm && weather.kind !== 'storm') {
      city.rainbowUntil = now + 90000;
      toast("Bo'ron tugadi — osmonda kamalak! 🌈");
    }
    city.wasStorm = storm;
    const on = now < city.rainbowUntil;
    if (on && !city.rainbow) {
      const g = new THREE.Group();
      ['#ef4444', '#f97316', '#facc15', '#22c55e', '#3b82f6', '#6366f1', '#a855f7'].forEach((c, i) => {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(900 - i * 22, 11, 6, 64, Math.PI),
          new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.55, depthWrite: false, fog: false }));
        g.add(ring);
      });
      scene.add(g);
      city.rainbow = g;
    }
    if (city.rainbow) {
      city.rainbow.visible = on;
      if (on) city.rainbow.position.set(me.x, 0, me.y - 2200);
    }
  }

  // ---- Kometa ----
  function setComet(c) {
    const was = city.comet;
    city.comet = c || null;
    if (c && (!was || was.id !== c.id)) toast('☄️ Osmonda kometa! F bosib tilak tiling — birinchisi 10 000 so\'m oladi', 'success');
    if (!city.cometView) {
      const g = new THREE.Group();
      g.add(mesh(new THREE.SphereGeometry(18, 12, 8), new THREE.MeshBasicMaterial({ color: '#fef9c3', fog: false }), 0, 0, 0, false));
      const tail = new THREE.Mesh(new THREE.ConeGeometry(14, 260, 12, 1, true), new THREE.MeshBasicMaterial({ color: '#fde68a', transparent: true, opacity: 0.5, fog: false, depthWrite: false }));
      tail.rotation.z = Math.PI / 2;
      tail.position.x = 135;
      g.add(tail);
      g.visible = false;
      scene.add(g);
      city.cometView = g;
    }
    city.cometView.visible = Boolean(c);
  }
  function stepComet() {
    if (!city.comet || !city.cometView) return;
    const k = 1 - city.comet.left / 30;
    city.cometView.position.set(me.x - 1800 + k * 3600, 1300 - k * 250, me.y - 1500);
  }
  function wish() {
    api('/api/game/comet/wish', { method: 'POST' }).then((d) => {
      localVersion += 1;
      setEconomy(d.economy);
      sound.cash();
      toast(d.first ? `Birinchi bo'lib tilak tiladingiz! +${formatNumber(d.pay)} so'm ✨` : `Tilagingiz qabul bo'ldi ✨ +${formatNumber(d.pay)} so'm`, 'success');
    }).catch(said);
  }

  // ---- Suv osti: cho'kkan kema xazinasi ----
  function buildWreck() {
    const w = world.wreck;
    if (!w) return;
    const g = new THREE.Group();
    const wood = mat('#713f12');
    g.add(box(140, 30, 50, wood, 0, -6, 0), box(4, 70, 4, wood, 10, 20, 0));
    g.rotation.z = 0.25;
    g.position.set(w.x, 0, w.y);
    scene.add(g);
    scene.add(placeSign("⚓ Cho'kkan kema", 130, 24, '#0e7490', w.x, 60, w.y));
  }
  async function dive() {
    const ov = document.createElement('div');
    ov.className = 'dive';
    ov.innerHTML = '<p>🤿 Sho\'ng\'iyapmiz… 🐠 🐟 🐡</p>';
    document.body.append(ov);
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const d = await api('/api/game/wreck', { method: 'POST' });
      localVersion += 1;
      setEconomy(d.economy);
      sound.cash();
      ov.querySelector('p').textContent = `💰 Xazina sandig'i! +${formatNumber(d.pay)} so'm`;
    } catch (err) {
      ov.querySelector('p').textContent = err.message;
    }
    setTimeout(() => ov.remove(), 2200);
  }

  // ---- Qor jangi (Q) ----
  function throwSnow() {
    const m = new Date().getMonth() + 1;
    if (![11, 12, 1, 2, 3].includes(m)) { toast('Qor jangi faqat qishda ❄️', 'warn'); return; }
    let best = null;
    others.forEach((o, key) => {
      const p = o.rig.root.position;
      const dd = Math.hypot(p.x - me.x, p.z - me.y);
      if (dd < 380 && (!best || dd < best.d)) best = { key, d: dd, p };
    });
    if (!best) { toast("Yaqinda hech kim yo'q — kimgadir yaqinlashing", 'warn'); return; }
    const ball = mesh(new THREE.SphereGeometry(5, 8, 6), mat('#f8fafc'), me.x, 50, me.y, false);
    scene.add(ball);
    const t0 = performance.now();
    const from = { x: me.x, y: me.y };
    const to = { x: best.p.x, y: best.p.z };
    const fly = () => {
      const k = Math.min(1, (performance.now() - t0) / 450);
      ball.position.set(from.x + (to.x - from.x) * k, 50 + Math.sin(Math.PI * k) * 60, from.y + (to.y - from.y) * k);
      if (k < 1) requestAnimationFrame(fly);
      else { scene.remove(ball); ball.geometry.dispose(); }
    };
    fly();
    api('/api/game/snowball', { method: 'POST', body: { key: best.key } })
      .then((d) => toast(`❄️ Tegdi! Bugun: ${d.hits} ta`, 'success')).catch(said);
  }

  // ---- Ot ----
  function carHorse(color) {
    const g = new THREE.Group();
    const body = mat(color, { roughness: 0.8 });
    const dark = mat('#1c1917');
    g.add(box(14, 16, 40, body, 0, 26, 0));
    const neck = box(9, 20, 10, body, 0, 38, 20);
    neck.rotation.x = -0.5;
    g.add(neck, box(9, 9, 16, body, 0, 48, 28), box(3, 14, 18, dark, 0, 42, 16));
    const legs = [];
    [[-5, 14], [5, 14], [-5, -14], [5, -14]].forEach(([x, z]) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, 18, z);
      pivot.add(box(4, 18, 4, body, 0, -9, 0));
      g.add(pivot);
      legs.push(pivot);
    });
    g.add(box(2, 16, 3, dark, 0, 28, -21));
    g.userData = { wheels: [], pods: [], r: 4, roof: 40, legs };
    return g;
  }
  CAR_BUILDERS.horse = carHorse;

  // ---- F tugmasi: shahar joylari ----
  function citySpot(car) {
    if (!world.places.bank) return null;
    if (city.comet) return { kind: 'fun', d: 0, text: 'Tilak tilash ☄️', act: wish };
    if (city.tram) return { kind: 'fun', d: 0, text: 'Tramvaydan tushish 🚋', act: toggleTram };
    if (me.boat && world.wreck && near(world.wreck, 150)) return { kind: 'fun', d: 0, text: "Sho'ng'ish — cho'kkan kema 🤿", act: dive };
    const f = city.flag;
    if (f && !car) {
      if (f.holder === me.key) {
        const g = homeGate();
        if (g && near(g, 170)) return { kind: 'fun', d: 0, text: 'Bayroqni uyga topshirish 🚩', act: deliverFlag };
      } else if (near(f, f.holder ? 75 : 60)) {
        return { kind: 'fun', d: 0, text: f.holder ? `Bayroqni tortib olish (${f.name}) 🚩` : 'Bayroqni olish 🚩', act: grabFlag };
      }
    }
    if (world.cpraces) {
      for (const [id, r] of Object.entries(world.cpraces)) {
        if (!city.race && raceVehicleOk(id) && near(r.points[0], 130)) return { kind: 'fun', d: 1, text: `${r.name} — boshlash 🏁`, act: () => startRace(id) };
      }
    }
    if (car) return null;
    const ts = tramAt(Date.now() / 1000);
    if (ts.stopped && Math.hypot(ts.x - me.x, TRAM_Y - me.y) < 110) return { kind: 'fun', d: 1, text: "Tramvayga chiqish 🚋", act: toggleTram };
    const M = world.maze;
    if (M && near(M.start, 110)) return { kind: 'fun', d: 1, text: 'Labirint — boshlash 🌿', act: () => api('/api/game/maze/start', { method: 'POST' }).then(() => toast('Vaqt ketdi! Chiqishni toping 🏁', 'success')).catch(said) };
    if (M && near(M.finish, 110)) {
      return { kind: 'fun', d: 1, text: 'Labirintdan chiqish 🏁', act: () => api('/api/game/maze/finish', { method: 'POST' }).then((d) => {
        localVersion += 1;
        setEconomy(d.economy);
        sound.cash();
        toast(`Labirint: ${d.time} soniya${d.best ? ' — rekord!' : ''} +${formatNumber(d.pay)} so'm 🏆`, 'success');
      }).catch(said) };
    }
    const doors = [['bank', 'Bank — omonat va kredit 🏦', openBank], ['icecream', 'Muzqaymoq sotish 🍦', () => openWork('icecream')]];
    for (const [id, text, act] of doors) {
      const pl = world.places[id];
      const pt = pl && (pl.door || pl.spot);
      if (near(pt, 90)) return { kind: 'fun', d: 1, text, act };
    }
    return null;
  }
  function grabFlag() {
    api('/api/game/flag/grab', { method: 'POST' }).then(() => toast("Bayroq sizda! Uyingiz darvozasiga olib boring 🚩 Boshqalar tegib tortib olishi mumkin", 'success')).catch(said);
  }
  function deliverFlag() {
    api('/api/game/flag/deliver', { method: 'POST' }).then((d) => {
      localVersion += 1;
      setEconomy(d.economy);
      sound.cash();
      toast(`Bayroq uyda! +${formatNumber(d.pay)} so'm 🚩`, 'success');
    }).catch(said);
  }

  // ---- Ustaxonalar (buyurtma) ----
  const WORK_TITLES = { icecream: ['🍦', 'Muzqaymoq'] };
  async function openWork(job) {
    const st = { kind: 'work', v: 0, job, order: null, picked: [], result: null };
    openSheet(st);
    try {
      const d = await api(`/api/game/work/${job}/order`, { method: 'POST' });
      if (sheetState !== st) return;
      st.order = d.order;
      st.v += 1;
      renderSheet();
    } catch (err) { closeSheet(); said(err); }
  }
  function renderWorkSheet(body, st) {
    const [ic, title] = WORK_TITLES[st.job];
    setHead('hammer', `${ic} ${title}`, "Buyurtmani tez va to'g'ri bajaring — tez bo'lsa ko'proq pul");
    const o = st.order;
    if (!o) return;
    body.append(el('p', 'kitchen__dish', o.text));
    if (st.result) {
      body.append(el('p', st.result.ok ? 'kitchen__ok' : 'kitchen__bad', st.result.msg),
        actionBtn('refresh', 'Keyingi buyurtma', () => openWork(st.job), 'btn btn--primary btn--block'));
      return;
    }
    const grid = el('div', 'kitchen__grid');
    o.options.forEach((opt) => {
      const on = st.picked.includes(opt);
      const b = el('button', `btn ${on ? 'btn--primary' : 'btn--ghost'}`, opt);
      b.type = 'button';
      b.addEventListener('click', async () => {
        st.picked = on ? st.picked.filter((x) => x !== opt) : [...st.picked, opt];
        st.v += 1;
        if (st.picked.length >= o.need) {
          try {
            st.result = await api(`/api/game/work/${st.job}/done`, { method: 'POST', body: { id: o.id, answer: st.picked } });
            if (st.result.economy) { localVersion += 1; setEconomy(st.result.economy); }
            if (st.result.ok) sound.cash();
          } catch (err) { st.result = { ok: false, msg: err.message }; }
          st.v += 1;
        }
        renderSheet();
      });
      grid.append(b);
    });
    body.append(el('p', 'sheet-note', `${o.need} ta tanlang`), grid);
  }

  // ---- Bozor va narsalar ----
  function openMarket() {
    const st = { kind: 'market2', v: 0, data: null };
    openSheet(st);
    loadInto(st, '/api/game/stall', (d) => { st.data = d; });
  }
  function renderMarket2Sheet(body, st) {
    setHead('store', '🛒 Bozor rastasi', "O'yinchilar bir-biriga sotadi");
    const d = st.data;
    if (!d) return;
    const reload = (x) => { st.data = x; st.v += 1; renderSheet(); };
    body.append(el('h3', 'life-h3', 'Sizdagi narsalar'));
    const mine = Object.entries(d.items);
    if (!mine.length) body.append(el('p', 'sheet-note', "Hali narsa yo'q: bog'da meva eking, tungi bozordan oling, g'or va sandiqlardan toping."));
    mine.forEach(([id, qty]) => {
      const c = d.catalog[id];
      const r = el('div', 'car-row');
      const info = el('div', 'car-row__info');
      info.append(el('strong', '', `${c.icon} ${c.name} × ${qty}`), el('small', '', `Bozorga sotish: ${formatNumber(c.sell)} so'm`));
      r.append(info,
        actionBtn('coins', 'Sotish', () => api('/api/game/items/sell', { method: 'POST', body: { item: id, qty: 1 } }).then((x) => {
          localVersion += 1; setEconomy(x.economy); sound.cash();
          loadInto(st, '/api/game/stall', (y) => { st.data = y; });
        }).catch(said), 'btn btn--ghost btn--sm'),
        actionBtn('plus', 'Rastaga', () => {
          const price = Number(window.prompt(`${c.name} narxi (so'm):`, String(c.sell * 2)));
          if (!price) return;
          api('/api/game/stall', { method: 'POST', body: { item: id, price: Math.round(price) } }).then(reload).catch(said);
        }, 'btn btn--primary btn--sm'));
      body.append(r);
    });
    body.append(el('h3', 'life-h3', 'Rastadagi narsalar'));
    if (!d.listings.length) body.append(el('p', 'sheet-note', "Rasta bo'sh"));
    d.listings.forEach((l) => {
      const c = d.catalog[l.item];
      const r = el('div', 'car-row');
      const info = el('div', 'car-row__info');
      info.append(el('strong', '', `${c.icon} ${c.name}`), el('small', '', `${l.seller} · ${formatNumber(l.price)} so'm`));
      r.append(info, l.mine
        ? actionBtn('x', 'Olib qo\'yish', () => api(`/api/game/stall/${l.id}`, { method: 'DELETE' }).then(reload).catch(said), 'btn btn--ghost btn--sm')
        : priceButton('Olish', l.price, async () => { reload(await api(`/api/game/stall/${l.id}/buy`, { method: 'POST' })); localVersion += 1; sound.cash(); }, 'btn--sm'));
      body.append(r);
    });
  }

  // ---- Pochta qutisi ----
  function openMail() {
    const st = { kind: 'mail', v: 0, data: null };
    openSheet(st);
    loadInto(st, '/api/game/mail', (d) => { st.data = d; });
  }
  function renderMailSheet(body, st) {
    setHead('message', '📮 Pochta qutisi', "Do'stlarga xat va sovg'a");
    const d = st.data;
    if (!d) return;
    const f = el('div', 'sale');
    const to = el('select', 'input-plain');
    d.people.forEach((p) => { const o = el('option', '', p.name); o.value = p.key; to.append(o); });
    const text = el('input', 'input-plain');
    text.maxLength = 300;
    text.placeholder = 'Xat matni…';
    const item = el('select', 'input-plain');
    item.append(el('option', '', "Sovg'asiz"));
    item.firstChild.value = '';
    Object.entries(d.items).forEach(([id, q]) => { const o = el('option', '', `${d.catalog[id].icon} ${d.catalog[id].name} (${q})`); o.value = id; item.append(o); });
    f.append(to, text, item, actionBtn('send', 'Yuborish', () => api('/api/game/mail', { method: 'POST', body: { to: to.value, text: text.value, item: item.value || null } })
      .then(() => { toast('Xat yuborildi 📮', 'success'); loadInto(st, '/api/game/mail', (x) => { st.data = x; }); }).catch(said), 'btn btn--primary btn--block'));
    body.append(f, el('h3', 'life-h3', 'Kelgan xatlar'));
    if (!d.mail.length) body.append(el('p', 'sheet-note', "Hali xat yo'q"));
    d.mail.forEach((m) => {
      const r = el('div', 'car-row');
      const info = el('div', 'car-row__info');
      info.append(el('strong', '', `${m.new ? '🆕 ' : ''}${m.from}${m.item ? ` · ${d.catalog[m.item]?.icon || '🎁'}` : ''}`), el('small', '', `${m.text || "(sovg'a)"} · ${m.at}`));
      r.append(info);
      body.append(r);
    });
  }

  // ---- Sarmoya ----
  function openInvest() {
    const st = { kind: 'invest', v: 0, data: null };
    openSheet(st);
    loadInto(st, '/api/game/invest', (d) => { st.data = d; });
  }
  function renderInvestSheet(body, st) {
    setHead('coins', '💼 Sarmoya', "Boshqalarning biznesiga pul tiking — 30 kun har kuni 2%");
    const d = st.data;
    if (!d) return;
    const total = d.mine.reduce((s, x) => s + x.claim, 0);
    body.append(actionBtn('coins', `Dividend olish (${formatNumber(total)} so'm)`, () => api('/api/game/invest/claim', { method: 'POST' }).then((x) => {
      localVersion += 1; setEconomy(x.economy); sound.cash(); toast(`Dividend: +${formatNumber(x.pay)} so'm`, 'success');
      loadInto(st, '/api/game/invest', (y) => { st.data = y; });
    }).catch(said), 'btn btn--primary btn--block'));
    d.mine.forEach((x) => body.append(el('p', 'sheet-note', `${x.owner}ning biznesi (${x.plot + 1}-yer): ${formatNumber(x.amount)} so'm · ${x.days_left} kun qoldi`)));
    body.append(el('h3', 'life-h3', 'Bizneslar'));
    d.targets.forEach((t) => {
      const r = el('div', 'car-row');
      const info = el('div', 'car-row__info');
      info.append(el('strong', '', `${t.owner} — ${t.kind} (${t.level} qavat)`), el('small', '', `${t.plot + 1}-yer`));
      r.append(info, actionBtn('plus', 'Tikish', () => {
        const amount = Math.round(Number(window.prompt("Qancha sarmoya? (10 000 — 5 000 000)", '50000')));
        if (!amount) return;
        api('/api/game/invest', { method: 'POST', body: { plot: t.plot, amount } }).then((y) => {
          localVersion += 1; sound.cash(); st.data = y; st.v += 1; renderSheet(); toast('Sarmoya kiritildi 💼', 'success');
        }).catch(said);
      }, 'btn btn--primary btn--sm'));
      body.append(r);
    });
    if (!d.targets.length) body.append(el('p', 'sheet-note', "Hozircha kafe, magazin yoki ofisi bor o'yinchi yo'q"));
  }

  // ---- Ro'yxatlar: futbol kubogi, rekordlar, qor jangi ----
  function openList(title, url, line) {
    const st = { kind: 'list2', v: 0, title, data: null, line };
    openSheet(st);
    loadInto(st, url, (d) => { st.data = d; });
  }
  function renderList2Sheet(body, st) {
    setHead('trophy', st.title, '');
    if (!st.data) return;
    const items = st.data.top || [];
    if (!items.length) body.append(el('p', 'sheet-note', "Hali hech kim yo'q"));
    items.forEach((t, i) => body.append(el('p', 'sheet-note', `${['🥇', '🥈', '🥉'][i] || `${i + 1}.`} ${st.line(t)}`)));
  }

  // ---- Dron kuryer ----
  async function droneDelivery() {
    try {
      const d = await api('/api/game/dronejob/start', { method: 'POST' });
      if (!droneOn) toggleDrone();
      closeSheet();
      setGuide(d.target.x, d.target.y, 'Posilka manzili');
      toast(`Dron posilkani olib uchdi 🚁 ${Math.round(d.eta)} soniyada yetadi`, 'success');
      setTimeout(async () => {
        try {
          const r = await api('/api/game/dronejob/finish', { method: 'POST' });
          localVersion += 1;
          setEconomy(r.economy);
          sound.cash();
          toast(`Posilka yetkazildi! +${formatNumber(r.pay)} so'm 📦`, 'success');
        } catch (err) { said(err); }
        setGuide();
      }, d.eta * 1000 + 300);
    } catch (err) { said(err); }
  }

  function claimRent() {
    api('/api/game/rent/claim', { method: 'POST' }).then((d) => {
      localVersion += 1;
      setEconomy(d.economy);
      sound.cash();
      toast(`Ijara haqi: ${d.homes} ta uydan +${formatNumber(d.pay)} so'm 🏠`, 'success');
    }).catch(said);
  }

  function stepCity(now) {
    stepClock();
    stepLights();
    stepTram();
    stepRainbow(now);
    stepComet();
    if (city.race) stepRace();
    if (city.flag) setFlag(city.flag);
  }

  // =====================================================================
  //  Yangi shahar (game_town.py bilan ishlaydi): xizmat mahallasi, istirohat bog'i, tog', plyaj, orol;
  //  uy hayoti, mini-o'yinlar, ijtimoiy, dars bilan bog'liq va transport yangiliklari
  // =====================================================================
  const town = {
    me: { energy: 100, strength: 0, fuel: 100, hurt: false, jail: 0, x2: false, rent: 0, kit: {} },
    state: null, wheel: null, carousel: null, words: new Map(), boss: null, bossView: null, uloq: null, uloqView: null,
    castles: '', castleViews: [], zoneViews: new Map(), houseViews: [], houseSig: '', decorViews: [], decorSig: '',
    statueView: null, statueSig: '', boardView: null, boardSig: '', cam: null, fallTop: 0, fuelSent: 100, fuelAt: 0,
    honks: new Map(), hunt: null, tableSeen: 0, invSeen: '', tug: null, tugTaps: 0, gardenViews: [], heliRotors: [],
    zone: null, lastTown: 0, rentWarned: false, wasX2: null,
  };
  const TW = () => world.town;
  const twNear = (pt, r) => pt && Math.hypot(pt.x - me.x, pt.y - me.y) < r;
  const FREE_FUEL = ['bike', 'skate', 'horse', 'carpet'];
  const CLUE_IDS = ['cave', 'nightmarket', 'bank', 'clock', 'icecream', 'cinema', 'post', 'pizza', 'wash', 'court', 'stage'];

  function twBuilding(id, r) {
    const cx = r.x + r.w / 2;
    const cz = r.y + r.h / 2;
    const front = r.door.y < r.y + r.h / 2 ? r.y - 0.6 : r.y + r.h + 0.6;
    const g = new THREE.Group();
    const h = r.hgt;
    if (id === 'tower') {
      g.add(cyl(r.w / 2.6, r.w / 2, h, mat('#cbd5e1', { metalness: 0.3 }), cx, h / 2, cz, 12));
      g.add(cyl(48, 48, 18, GLASS(), cx, h + 9, cz, 16), cyl(54, 54, 4, mat(r.color), cx, h + 20, cz, 16));
      g.add(mesh(new THREE.ConeGeometry(10, 60, 8), mat('#e5e7eb'), cx, h + 52, cz));
      g.add(box(22, 30, 2, mat('#78350f'), r.door.x, 15, front));
      g.add(placeSign(r.label, 120, 26, r.color, cx, 70, front + (front > cz ? 2 : -2)));
      scene.add(g);
      return;
    }
    if (id === 'cave') {
      g.add(mesh(new THREE.DodecahedronGeometry(r.w * 0.75, 1), mat('#78716c', { roughness: 1 }), cx, 20, cz));
      g.add(box(60, 56, 6, mat('#0c0a09'), r.door.x, 28, r.y + r.h + 2));
      g.add(placeSign(r.label, 110, 26, r.color, cx, 150, r.y + r.h + 10));
      scene.add(g);
      return;
    }
    if (id === 'nightmarket') {
      for (let i = 0; i < 4; i += 1) {
        const x = r.x + 45 + i * 90;
        g.add(box(70, 20, 40, mat('#312e81'), x, 10, r.y + 45), box(78, 4, 50, mat(['#f43f5e', '#f59e0b', '#22c55e', '#38bdf8'][i]), x, 46, r.y + 45),
          box(3, 44, 3, mat('#1e1b4b'), x - 36, 22, r.y + 22), box(3, 44, 3, mat('#1e1b4b'), x + 36, 22, r.y + 22));
        g.add(mesh(new THREE.SphereGeometry(5, 10, 8), glow('#fbbf24', 1.4), x, 40, r.y + 70));
      }
      g.add(placeSign(r.label, 200, 28, r.color, cx, 80, r.y + r.h + 4));
      scene.add(g);
      return;
    }
    g.add(box(r.w, h, r.h, mat('#f8fafc', { roughness: 0.8 }), cx, h / 2, cz));
    g.add(box(r.w + 12, 7, r.h + 12, mat(r.color), cx, h + 3.5, cz));
    g.add(box(26, 32, 2, mat('#78350f'), r.door.x, 16, front));
    [-1, 1].forEach((s) => g.add(box(24, 16, 2, mat('#bae6fd', { roughness: 0.1 }), cx + s * (r.w / 3.2), h * 0.6, front)));
    if (id === 'hospital') g.add(box(40, 12, 2, glow('#ef4444', 0.8), cx, h + 18, front), box(12, 40, 2, glow('#ef4444', 0.8), cx, h + 18, front));
    if (id === 'museum') [-80, -40, 40, 80].forEach((dx) => g.add(cyl(6, 6, h - 6, mat('#f5f5f4'), cx + dx, (h - 6) / 2, front + 10, 10)));
    if (id === 'arcade') g.add(box(r.w - 30, 10, 2, glow('#e879f9', 1.2), cx, h - 10, front + (front > cz ? 0.6 : -0.6)));
    g.add(placeSign(r.label, Math.max(r.w, 160), 30, r.color, cx, h + 30, front));
    scene.add(g);
  }

  function buildTown() {
    const T = TW();
    if (!T) return;
    const ground = (r, color, y = 0.25) => scene.add(flat(r.w, r.h, mat(color, { roughness: 1 }), r.x + r.w / 2, r.y + r.h / 2, y));
    ground(T.park, '#4ade80');
    ground(T.mount, '#65a30d');
    ground({ x: T.beach.x, y: T.beach.y, w: T.beach.w, h: T.sea.y - T.beach.y }, '#fde68a');
    scene.add(flat(T.sea.w, T.sea.h, mat('#0ea5e9', { roughness: 0.15, metalness: 0.2, transparent: true, opacity: 0.85 }), T.sea.x + T.sea.w / 2, T.sea.y + T.sea.h / 2, 0.5));
    ground(T.island, '#fcd34d');
    scene.add(flat(2600, 2600, mat('#0284c7', { roughness: 0.2, transparent: true, opacity: 0.9 }), T.island.x + T.island.w / 2, T.island.y + T.island.h / 2, 0.1));
    scene.add(placeSign("🎡 ISTIROHAT BOG'I", 260, 34, '#15803d', 60, 80, 420, Math.PI / 2));
    scene.add(placeSign("⛰️ TOG' VA KO'PKARI", 260, 34, '#4d7c0f', 60, 80, 2700, Math.PI / 2));
    scene.add(placeSign('🏖️ PLYAJ', 200, 34, '#0369a1', 5880, 80, 3760));
    Object.entries(T.places).forEach(([id, r]) => twBuilding(id, r));
    // Attraksionlar: charxpalak va karusel
    const S = T.spots;
    const wg = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.TorusGeometry(120, 3, 8, 48), mat('#e11d48', { metalness: 0.4 }));
    wg.add(ring);
    const cabins = [];
    for (let i = 0; i < 12; i += 1) {
      const a = (i / 12) * Math.PI * 2;
      const sp = box(2, 120, 2, mat('#94a3b8'), Math.cos(a) * 60, Math.sin(a) * 60, 0);
      sp.rotation.z = a - Math.PI / 2;
      wg.add(sp);
      const c = box(18, 16, 14, mat(['#f59e0b', '#22c55e', '#3b82f6', '#a855f7'][i % 4]), Math.cos(a) * 120, Math.sin(a) * 120 - 10, 0);
      cabins.push(c);
      wg.add(c);
    }
    wg.position.set(S.wheel.x, 140, S.wheel.y - 120);
    scene.add(wg, box(6, 150, 6, mat('#475569'), S.wheel.x - 40, 70, S.wheel.y - 120), box(6, 150, 6, mat('#475569'), S.wheel.x + 40, 70, S.wheel.y - 120));
    scene.add(placeSign('🎡 CHARXPALAK', 150, 26, '#e11d48', S.wheel.x, 30, S.wheel.y - 30));
    town.wheel = { g: wg, cabins };
    const cg = new THREE.Group();
    cg.add(cyl(70, 70, 4, mat('#fde68a'), 0, 4, 0, 24), mesh(new THREE.ConeGeometry(80, 40, 24), mat('#db2777'), 0, 70, 0), cyl(4, 4, 70, mat('#e5e7eb'), 0, 35, 0, 8));
    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * Math.PI * 2;
      cg.add(box(10, 18, 22, mat(['#f97316', '#38bdf8', '#a3e635', '#f472b6'][i % 4]), Math.cos(a) * 52, 22, Math.sin(a) * 52), cyl(1, 1, 40, mat('#fbbf24'), Math.cos(a) * 52, 42, Math.sin(a) * 52, 6));
    }
    cg.position.set(S.carousel.x, 0, S.carousel.y - 100);
    scene.add(cg, placeSign('🎠 KARUSEL', 110, 24, '#db2777', S.carousel.x, 26, S.carousel.y - 10));
    town.carousel = cg;
    // Arqon
    const rope = cyl(2.5, 2.5, 300, mat('#a16207'), S.rope.x, 14, S.rope.y, 8);
    rope.rotation.z = Math.PI / 2;
    scene.add(rope, box(4, 40, 4, mat('#dc2626'), S.rope.x, 20, S.rope.y), placeSign('🪢 ARQON TORTISH', 160, 24, '#a16207', S.rope.x, 60, S.rope.y - 40));
    // Ko'pkari maydoni va qozon
    const K = T.kopkari;
    scene.add(flat(K.w, K.h, mat('#a16207', { roughness: 1 }), K.x + K.w / 2, K.y + K.h / 2, 0.35));
    const goal = new THREE.Mesh(new THREE.TorusGeometry(70, 8, 8, 32), mat('#f5f5f4'));
    goal.rotation.x = -Math.PI / 2;
    goal.position.set(S.kopkari_goal.x, 6, S.kopkari_goal.y);
    scene.add(goal, placeSign("🐎 KO'PKARI — uloqni qozonga!", 230, 28, '#92400e', K.x + K.w / 2, 70, K.y - 10));
    // Tog'lar va chang'i yo'li
    [[-1250, 3700, 260, 420], [-900, 3760, 220, 340], [-450, 3740, 300, 460], [-1450, 3300, 240, 380]].forEach(([x, z, r, h]) => {
      scene.add(mesh(new THREE.ConeGeometry(r, h, 7), mat('#57534e', { roughness: 1 }), x, h / 2, z), mesh(new THREE.ConeGeometry(r * 0.38, h * 0.38, 7), mat('#f8fafc'), x, h * 0.81, z));
    });
    scene.add(flat(500, 620, mat('#f1f5f9', { roughness: 0.6 }), -1050, 3350, 0.4));
    const ski = world.cpraces && world.cpraces.ski;
    if (ski) ski.points.forEach((p, i) => scene.add(cyl(2, 2, 40, mat(i % 2 ? '#2563eb' : '#dc2626'), p.x, 20, p.y, 6), box(16, 10, 1, mat(i % 2 ? '#2563eb' : '#dc2626'), p.x + 8, 35, p.y)));
    scene.add(placeSign("⛷️ CHANG'I", 120, 26, '#0369a1', -1050, 60, 3040));
    // Plyaj: soyabonlar, qayiq bekati
    for (let i = 0; i < 6; i += 1) {
      const x = 5560 + i * 170;
      const z = 3960 + (i % 2) * 120;
      scene.add(cyl(1.5, 1.5, 50, mat('#e5e7eb'), x, 25, z, 6), mesh(new THREE.ConeGeometry(42, 16, 12), mat(['#ef4444', '#facc15', '#3b82f6'][i % 3]), x, 54, z),
        box(40, 3, 70, mat('#f8fafc'), x + 40, 4, z));
    }
    scene.add(box(30, 6, 140, mat('#92400e'), S.sub.x, 6, S.sub.y + 40), placeSign('🚢 SUV OSTI KEMASI', 170, 26, '#0e7490', S.sub.x, 50, S.sub.y - 40));
    scene.add(placeSign('🏰 QUM QASR', 120, 24, '#ca8a04', S.castle.x, 40, S.castle.y - 60));
    // Orol: palmalar va sandiq
    const I = T.island;
    for (let i = 0; i < 9; i += 1) {
      const a = (i / 9) * Math.PI * 2;
      const x = I.x + I.w / 2 + Math.cos(a) * 300;
      const z = I.y + I.h / 2 + Math.sin(a) * 300;
      scene.add(cyl(4, 6, 90, mat('#92400e'), x, 45, z, 8));
      for (let k = 0; k < 5; k += 1) {
        const leaf = box(60, 2, 14, mat('#16a34a'), x + Math.cos(k * 1.26) * 26, 92, z + Math.sin(k * 1.26) * 26);
        leaf.rotation.y = -k * 1.26;
        leaf.rotation.z = -0.3;
        scene.add(leaf);
      }
    }
    scene.add(box(40, 24, 26, mat('#a16207'), S.coconut.x, 12, S.coconut.y), box(42, 6, 28, mat('#facc15', { metalness: 0.6 }), S.coconut.x, 26, S.coconut.y));
    scene.add(placeSign("🏝️ OROL · 🛫 aeroportga qaytish", 260, 30, '#0369a1', S.island_land.x, 60, S.island_land.y - 60));
    // Yoqilg'i shoxobchalari va velosiped ijarasi
    T.fuel.forEach((f) => {
      scene.add(box(120, 6, 70, mat('#f8fafc'), f.x, 60, f.y), box(6, 60, 6, mat('#e5e7eb'), f.x - 50, 30, f.y), box(6, 60, 6, mat('#e5e7eb'), f.x + 50, 30, f.y),
        box(14, 30, 10, mat('#dc2626'), f.x - 20, 15, f.y), box(14, 30, 10, mat('#16a34a'), f.x + 20, 15, f.y), placeSign('⛽ BENZIN', 100, 22, '#dc2626', f.x, 78, f.y + 36));
    });
    T.bikes.forEach((b) => {
      scene.add(box(70, 4, 20, mat('#64748b'), b.x, 12, b.y), placeSign('🚲 IJARA', 70, 20, '#16a34a', b.x, 40, b.y));
      [-20, 0, 20].forEach((dx) => scene.add(box(3, 18, 22, mat('#16a34a'), b.x + dx, 9, b.y + 4)));
    });
    // Haykal postamenti, reyting taxtasi, hudud bayroqlari
    scene.add(box(50, 20, 50, mat('#a8a29e'), S.statue.x, 10, S.statue.y));
    scene.add(box(6, 70, 6, mat('#475569'), S.board.x - 70, 35, S.board.y), box(6, 70, 6, mat('#475569'), S.board.x + 70, 35, S.board.y));
    Object.entries(T.zones).forEach(([id, z]) => {
      const g = new THREE.Group();
      g.add(cyl(2, 2, 90, mat('#e5e7eb'), 0, 45, 0, 8));
      const flag = box(40, 24, 1, mat('#94a3b8'), 20, 76, 0);
      g.add(flag);
      const ringZ = new THREE.Mesh(new THREE.RingGeometry(125, 132, 40), new THREE.MeshBasicMaterial({ color: '#f8fafc', transparent: true, opacity: 0.5, side: THREE.DoubleSide }));
      ringZ.rotation.x = -Math.PI / 2;
      ringZ.position.y = 0.8;
      g.add(ringZ);
      g.position.set(z.x, 0, z.y);
      scene.add(g);
      town.zoneViews.set(id, { g, flag, label: null, sig: '' });
    });
    loadTown();
  }
  function townSolids() {
    const T = TW();
    if (!T) return [];
    return Object.entries(T.places).filter(([id]) => id !== 'nightmarket').map(([, r]) => ({ x: r.x, y: r.y, w: r.w, h: r.h, top: r.hgt + 10 }));
  }
  const townAreas = () => {
    const T = TW();
    return T ? [T.park, T.mount, T.beach, T.island] : [];
  };

  // ---- Shahar holati (haykal, reyting, klan uylari, bezaklar, hududlar) — har daqiqada ----
  async function loadTown() {
    try {
      const d = await api('/api/game/town');
      town.state = d;
      town.lastTown = performance.now();
      setStatue(d.statue);
      setBoards(d.boards);
      setHouses(d.houses);
      setDecor(d.decor);
      setZones(d.zones);
    } catch { /* keyingi safar */ }
  }
  function setStatue(name) {
    const sig = name || '';
    if (sig === town.statueSig) return;
    town.statueSig = sig;
    if (town.statueView) { scene.remove(town.statueView); disposeTree(town.statueView); }
    const S = TW().spots.statue;
    const g = new THREE.Group();
    const gold = mat('#d4a017', { metalness: 0.8, roughness: 0.3 });
    g.add(box(18, 34, 12, gold, 0, 37, 0), mesh(new THREE.SphereGeometry(9, 14, 12), gold, 0, 62, 0), box(6, 26, 6, gold, -6, 7, 0), box(6, 26, 6, gold, 6, 7, 0));
    const arm = box(5, 26, 5, gold, 14, 58, 0);
    arm.rotation.z = 2.6;
    g.add(arm, box(5, 22, 5, gold, -12, 40, 0));
    g.add(placeSign(name ? `⭐ Hafta a'lochisi: ${name}` : "⭐ Hafta a'lochisi — siz bo'lishingiz mumkin!", 230, 26, '#a16207', 0, 100, 30));
    g.position.set(S.x, 20, S.y);
    scene.add(g);
    town.statueView = g;
  }
  function setBoards(b) {
    if (!b) return;
    const lines = [`💰 ${b.rich[0] || '—'}`, `🌿 ${b.fast[0] || '—'}`, `🧠 ${b.smart[0] || '—'}`];
    const sig = lines.join('|');
    if (sig === town.boardSig) return;
    town.boardSig = sig;
    if (town.boardView) { scene.remove(town.boardView); disposeTree(town.boardView); }
    const S = TW().spots.board;
    const g = new THREE.Group();
    g.add(placeSign('🏆 MAHALLA REYTINGI', 150, 18, '#7c3aed', 0, 70, 0));
    lines.forEach((l, i) => g.add(placeSign(l, 150, 14, '#1e293b', 0, 52 - i * 15, 0)));
    g.position.set(S.x, 0, S.y);
    scene.add(g);
    town.boardView = g;
  }
  function setHouses(list) {
    const sig = JSON.stringify(list || []);
    if (sig === town.houseSig) return;
    town.houseSig = sig;
    town.houseViews.forEach((v) => { scene.remove(v); disposeTree(v); });
    town.houseViews = [];
    const slots = TW().clan_slots;
    slots.forEach((s) => {
      const h = (list || []).find((x) => x.slot === s.id);
      const g = new THREE.Group();
      if (h) {
        g.add(box(s.w, 60, s.h, mat('#f8fafc'), s.x + s.w / 2, 30, s.y + s.h / 2), box(s.w + 10, 10, s.h + 10, mat(h.color), s.x + s.w / 2, 65, s.y + s.h / 2),
          box(24, 30, 2, mat('#78350f'), s.door.x, 15, s.y + s.h + 0.6), placeSign(`[${h.tag}] ${h.name}`, 140, 24, h.color, s.x + s.w / 2, 92, s.y + s.h + 2));
      } else {
        g.add(flat(s.w, s.h, mat('#a3a3a3', { roughness: 1 }), s.x + s.w / 2, s.y + s.h / 2, 0.4), placeSign('🏰 Klan uyi uchun joy', 120, 20, '#525252', s.x + s.w / 2, 30, s.y + s.h + 2));
      }
      scene.add(g);
      town.houseViews.push(g);
    });
  }
  const DECOR_MAKERS = {
    fonar: (x, z) => [cyl(1.5, 1.5, 40, mat('#1f2937'), x - 60, 20, z, 6), mesh(new THREE.SphereGeometry(6, 10, 8), glow('#f97316', 1.5), x - 60, 44, z),
      cyl(1.5, 1.5, 40, mat('#1f2937'), x + 60, 20, z, 6), mesh(new THREE.SphereGeometry(6, 10, 8), glow('#f97316', 1.5), x + 60, 44, z)],
    gullar: (x, z) => [box(70, 6, 14, mat('#78350f'), x - 95, 3, z), ...[0, 1, 2, 3, 4].map((i) => mesh(new THREE.SphereGeometry(5, 8, 6), mat(['#f43f5e', '#facc15', '#a855f7', '#fb923c', '#ec4899'][i]), x - 123 + i * 14, 10, z))],
    bayroq: (x, z) => [cyl(1.5, 1.5, 80, mat('#e5e7eb'), x + 100, 40, z, 6), box(34, 20, 1, mat('#0ea5e9'), x + 117, 68, z), box(34, 4, 1.2, mat('#ffffff'), x + 117, 68, z)],
    neon: (x, z) => [box(70, 18, 2, glow('#22d3ee', 1.6), x, 56, z)],
    favvora: (x, z) => [cyl(18, 20, 8, mat('#cbd5e1'), x + 140, 4, z, 16), cyl(14, 14, 2, mat('#38bdf8', { transparent: true, opacity: 0.85 }), x + 140, 8.5, z, 16), cyl(2, 2, 18, mat('#94a3b8'), x + 140, 12, z, 6)],
  };
  function setDecor(map) {
    const sig = JSON.stringify(map || {});
    if (sig === town.decorSig) return;
    town.decorSig = sig;
    town.decorViews.forEach((v) => { scene.remove(v); disposeTree(v); });
    town.decorViews = [];
    Object.entries(map || {}).forEach(([pid, list]) => {
      const p = world.plots[Number(pid)];
      if (!p) return;
      const z = p.gate === 'bottom' ? p.y + p.h - 8 : p.y + 8;
      const g = new THREE.Group();
      list.forEach((d) => { if (DECOR_MAKERS[d]) DECOR_MAKERS[d](p.x + p.w / 2, z).forEach((m) => g.add(m)); });
      scene.add(g);
      town.decorViews.push(g);
    });
  }
  function setZones(list) {
    (list || []).forEach((z) => {
      const v = town.zoneViews.get(z.id);
      if (!v) return;
      const sig = z.clan ? `${z.clan.tag}|${z.clan.color}` : '-';
      if (sig === v.sig) return;
      v.sig = sig;
      v.flag.material = mat(z.clan ? z.clan.color : '#94a3b8');
      if (v.label) { v.g.remove(v.label); disposeTree(v.label); }
      v.label = placeSign(z.clan ? `🚩 ${z.name}: [${z.clan.tag}]` : `🚩 ${z.name}: egasiz`, 150, 20, z.clan ? z.clan.color : '#475569', 0, 104, 0);
      v.g.add(v.label);
    });
  }
  function setGarden(trees) {
    town.gardenViews.forEach((v) => { scene.remove(v); disposeTree(v); });
    town.gardenViews = [];
    const g0 = homeGate();
    if (!g0 || !trees) return;
    const p = world.plots[economy.home];
    const z = p.gate === 'bottom' ? p.y + p.h - 30 : p.y + 30;
    trees.forEach((t, i) => {
      const x = p.x + 20 + i * 18;
      const ripe = t.left <= 0;
      const g = new THREE.Group();
      g.add(cyl(2, 3, 18, mat('#78350f'), x, 9, z, 6), mesh(new THREE.SphereGeometry(10, 8, 6), mat(t.kind === 'uzum' ? '#4d7c0f' : '#16a34a'), x, 24, z));
      if (ripe) g.add(mesh(new THREE.SphereGeometry(3, 6, 5), mat({ olma: '#dc2626', uzum: '#7c3aed', anor: '#be123c' }[t.kind]), x + 6, 24, z + 6));
      scene.add(g);
      town.gardenViews.push(g);
    });
  }

  // ---- Sinxron ----
  function townSync(data, fresh) {
    if (data.town) {
      const t = data.town;
      if (town.wasX2 === null && t.x2) toast("📚 Bugun darsga keldingiz — binolar daromadi x2! 🎉", 'success');
      town.wasX2 = t.x2;
      if (fresh) town.me.fuel = Math.min(town.me.fuel, t.fuel);
      Object.assign(town.me, { x2: t.x2, rent: t.rent, kit: t.kit || {} });
      if (fresh && !town.fuelInit) { town.me.fuel = t.fuel; town.fuelSent = t.fuel; town.fuelInit = true; }
      if (!t.rent && town.hadRent) me.rentBike = false;
      if (me.car === 'bike' && !economy.cars.includes('bike') && !t.rent && town.hadRent) {
        me.car = null;
        updateRideButton();
        toast('🚲 Velosiped ijarasi tugadi', 'warn');
      }
      town.hadRent = t.rent > 0;
    }
    setWords(data.words || []);
    setBoss(data.boss || null);
    setUloq(data.uloq || null);
    setCastles(data.castles || []);
    town.zone = data.zone || null;
    setTug(data.tug || null);
    town.math = data.math || null;
    (data.players || []).forEach((p) => {
      if (p.honk && p.honk !== town.honks.get(p.key)) {
        town.honks.set(p.key, p.honk);
        if (Math.hypot(p.x - me.x, p.y - me.y) < 700) sound.horn(p.car || 'bmw', p.horn);
      }
    });
    if (fresh && data.invites) {
      const inv = data.invites;
      const sig = `${inv.home || ''}|${inv.table ? inv.table.name + inv.table.game : ''}`;
      if (sig !== town.invSeen) {
        town.invSeen = sig;
        if (inv.table || inv.home) {
          sound.ding();
          if (!sheetState) openTw('invites');
        }
      }
    }
    if (fresh && data.table && !data.table.over && data.table.id !== town.tableSeen) {
      town.tableSeen = data.table.id;
      if (!sheetState || sheetState.view !== 'table') openTw('table');
    }
  }
  function setWords(list) {
    const seen = new Set();
    list.forEach((w) => {
      seen.add(w.id);
      if (town.words.has(w.id)) return;
      const s = placeSign(`🔤 ${w.en}`, 80, 22, '#0f766e', w.x, 40, w.y);
      scene.add(s);
      town.words.set(w.id, { ...w, view: s });
    });
    town.words.forEach((w, id) => {
      if (!seen.has(id)) { scene.remove(w.view); disposeTree(w.view); town.words.delete(id); }
    });
  }
  function setBoss(b) {
    town.boss = b;
    if (!b) {
      if (town.bossView) town.bossView.visible = false;
      return;
    }
    if (!town.bossView) {
      const g = new THREE.Group();
      const red = mat('#b91c1c', { emissive: '#450a0a', emissiveIntensity: 0.6 });
      g.add(box(60, 90, 36, red, 0, 110, 0), mesh(new THREE.SphereGeometry(28, 16, 12), mat('#fca5a5'), 0, 180, 0),
        box(20, 70, 20, red, -18, 35, 0), box(20, 70, 20, red, 18, 35, 0), box(16, 70, 16, red, -44, 120, 0), box(16, 70, 16, red, 44, 120, 0));
      g.add(mesh(new THREE.CylinderGeometry(22, 26, 18, 6), mat('#facc15', { metalness: 0.8 }), 0, 212, 0));
      [-10, 10].forEach((dx) => g.add(mesh(new THREE.SphereGeometry(5, 8, 6), glow('#ef4444', 2), dx, 184, 24)));
      scene.add(g);
      town.bossView = g;
      town.bossHp = -1;
    }
    town.bossView.visible = true;
    town.bossView.position.set(b.x, 0, b.y);
    if (b.hp !== town.bossHp) {
      town.bossHp = b.hp;
      if (town.bossBar) { town.bossView.remove(town.bossBar); disposeTree(town.bossBar); }
      town.bossBar = placeSign(b.hp > 0 ? `👾 OWNER BOSS ❤️ ${b.hp}/${b.max}` : '👾 BOSS YENGILDI! 🎉', 200, 30, b.hp > 0 ? '#7f1d1d' : '#15803d', 0, 250, 0);
      town.bossView.add(town.bossBar);
    }
  }
  function setUloq(u) {
    town.uloq = u;
    if (!u) {
      if (town.uloqView) town.uloqView.visible = false;
      return;
    }
    if (!town.uloqView) {
      const g = new THREE.Group();
      g.add(box(30, 14, 14, mat('#a16207'), 0, 0, 0), box(6, 14, 6, mat('#78350f'), 14, 8, 0));
      scene.add(g);
      town.uloqView = g;
    }
    town.uloqView.visible = true;
    const mine = u.holder === me.key;
    town.uloqView.position.set(mine ? me.x : u.x, u.holder ? 45 : 8, mine ? me.y : u.y);
  }
  function setCastles(list) {
    const sig = list.map((c) => `${c.x},${c.y}`).join('|');
    if (sig === town.castles) return;
    town.castles = sig;
    town.castleViews.forEach((v) => { scene.remove(v); disposeTree(v); });
    town.castleViews = list.map((c) => {
      const g = new THREE.Group();
      const sand = mat('#eab308', { roughness: 1 });
      g.add(box(30, 14, 30, sand, 0, 7, 0), cyl(6, 7, 26, sand, -13, 13, -13, 8), cyl(6, 7, 26, sand, 13, 13, -13, 8), cyl(6, 7, 26, sand, -13, 13, 13, 8), cyl(6, 7, 26, sand, 13, 13, 13, 8),
        cyl(7, 8, 34, sand, 0, 24, 0, 8), placeSign(c.name, 60, 12, '#a16207', 0, 52, 0));
      g.scale.setScalar(c.size || 1);
      g.position.set(c.x, 0, c.y);
      scene.add(g);
      return g;
    });
  }
  function setTug(t) {
    const was = town.tug;
    town.tug = t;
    if (t && t.phase === 'play' && t.side && (!was || was.phase !== 'play') && (!sheetState || sheetState.view !== 'tug')) openTw('tug');
    if (t && t.phase === 'done' && was && was.phase === 'play') toast(`🪢 ${t.result}`, t.win && t.win === t.side ? 'success' : '');
    if (sheetState && sheetState.view === 'tug') { sheetState.v += 1; renderSheet(); }
  }

  // ---- Har kadrda ----
  function stepTown(dt) {
    if (!TW()) return;
    const now = performance.now();
    if (town.wheel) town.wheel.g.rotation.z += dt * 0.12;
    if (town.wheel) town.wheel.cabins.forEach((c) => { c.rotation.z = -town.wheel.g.rotation.z; });
    if (town.carousel) town.carousel.rotation.y += dt * 0.6;
    town.words.forEach((w) => { w.view.position.y = 40 + Math.sin(now / 400 + w.id) * 5; w.view.rotation.y += dt * 0.8; });
    if (town.bossView && town.bossView.visible) town.bossView.rotation.y = Math.sin(now / 900) * 0.5;
    // vertolyot parragi (o'zimniki va boshqalarniki)
    [me.rig, ...[...others.values()].map((o) => o.rig)].forEach((rig) => {
      const u = rig && rig.car && rig.car.userData;
      if (u && u.rotor) u.rotor.rotation.y += dt * 30;
    });
    // benzin
    const car = carInfo();
    if (car && !FREE_FUEL.includes(car.style) && !FREE_FUEL.includes(car.id) && me.moving !== false) {
      const sp = Math.hypot(me.vx || 0, me.vz || 0);
      if (sp > 5) {
        const before = town.me.fuel;
        town.me.fuel = Math.max(0, town.me.fuel - (sp * dt) / 420);
        if (before > 15 && town.me.fuel <= 15) toast("⛽ Benzin kam qoldi! Eng yaqin shoxobcha: Menyu → Yangi shahar → Benzin", 'warn');
        if (before > 0 && town.me.fuel <= 0) toast("⛽ Benzin tugadi! Mashina juda sekin yuradi — shoxobchaga boring", 'warn');
      }
    }
    if (now - town.fuelAt > 15000 && Math.abs(town.fuelSent - town.me.fuel) > 0.5) {
      town.fuelAt = now;
      town.fuelSent = town.me.fuel;
      api('/api/game/fuel', { method: 'POST', body: { fuel: Math.round(town.me.fuel * 10) / 10 } }).catch(() => {});
    }
    if (now - town.lastTown > 60000) { town.lastTown = now; loadTown(); }
    updateTownHud();
  }
  function townSpeed(car) {
    if (!car) return 1;
    if (!FREE_FUEL.includes(car.style) && !FREE_FUEL.includes(car.id) && town.me.fuel <= 0) return 0.18;
    return 1;
  }

  // ---- Kamera: attraksion, minora, selfi ----
  function townCam(dt) {
    const c = town.cam;
    if (!c) return false;
    const now = performance.now();
    if (now > c.until) {
      town.cam = null;
      camReady = false;
      if (c.done) c.done();
      return false;
    }
    const S = TW().spots;
    let pos;
    let look;
    if (c.kind === 'wheel') {
      const a = town.wheel.g.rotation.z + (c.cabin / 12) * Math.PI * 2;
      pos = new THREE.Vector3(S.wheel.x + Math.cos(a) * 120, 140 + Math.sin(a) * 120 + 4, S.wheel.y - 120);
      look = new THREE.Vector3(S.wheel.x + 600, 60, S.wheel.y + 600);
    } else if (c.kind === 'carousel') {
      const a = town.carousel.rotation.y + c.cabin;
      pos = new THREE.Vector3(S.carousel.x + Math.cos(a) * 52, 34, S.carousel.y - 100 - Math.sin(a) * 52);
      look = new THREE.Vector3(S.carousel.x + Math.cos(a + 1.2) * 300, 20, S.carousel.y - 100 - Math.sin(a + 1.2) * 300);
    } else if (c.kind === 'tower') {
      const t = TW().places.tower;
      const a = (now - c.t0) / 4000;
      pos = new THREE.Vector3(t.x + 40, 440, t.y + 40);
      look = new THREE.Vector3(t.x + 40 + Math.cos(a) * 1600, 0, t.y + 40 + Math.sin(a) * 1600);
    } else if (c.kind === 'selfie') {
      const d = c.dist;
      pos = new THREE.Vector3(me.x + Math.cos(me.dir) * d, 40 + d * 0.2, me.y + Math.sin(me.dir) * d);
      look = new THREE.Vector3(me.x, 30, me.y);
    } else return false;
    camera.position.copy(pos);
    camera.lookAt(look);
    return true;
  }
  function selfie(group) {
    closeSheet();
    me.act = 'wave';
    town.cam = { kind: 'selfie', dist: group ? 190 : 90, until: performance.now() + 3600, t0: performance.now(), done: () => { me.act = null; } };
    toast('📸 3… 2… 1…');
    setTimeout(() => { takePhoto(); }, 3000);
  }

  // ---- HUD ----
  function updateTownHud() {
    let hud = $('town-hud');
    if (!hud) {
      hud = el('div', 'town-hud');
      hud.id = 'town-hud';
      document.body.append(hud);
    }
    const car = carInfo();
    const parts = [];
    if (town.me.x2) parts.push('📚 x2');
    if (car && !FREE_FUEL.includes(car.style) && !FREE_FUEL.includes(car.id)) parts.push(`⛽ ${Math.round(town.me.fuel)}%`);
    if (town.me.rent) parts.push(`🚲 ${Math.ceil(town.me.rent / 60)} daq`);
    if (town.hunt) parts.push(`🗺️ ${town.hunt}`);
    if (town.zone) parts.push(`🚩 ${town.zone.mine}/${town.zone.need} s`);
    const text = parts.join(' · ');
    if (hud.textContent !== text) hud.textContent = text;
  }

  // ---- F tugmasi ----
  function townSpot(car) {
    const T = TW();
    if (!T) return null;
    const S = T.spots;
    if (town.cam && town.cam.kind !== 'selfie') return { kind: 'fun', d: 0, text: 'Tushish ✋', act: () => { town.cam = null; camReady = false; } };
    if (town.boss && town.boss.hp > 0 && twNear(town.boss, 420)) return { kind: 'fun', d: 0, text: '👾 Bossga hujum (savol)', act: () => openTw('boss') };
    const u = town.uloq;
    if (u && car && car.id === 'horse') {
      if (u.holder === me.key && twNear(S.kopkari_goal, 100)) return { kind: 'fun', d: 0, text: 'Uloqni qozonga tashlash! 🐎', act: () => twPost('/api/game/kopkari/score', {}, (d) => { sound.cash(); toast(`Uloq qozonda! +${formatNumber(d.pay)} so'm 🏆`, 'success'); }) };
      if (u.holder !== me.key && !u.wait && twNear(u, u.holder ? 85 : 75)) return { kind: 'fun', d: 0, text: u.holder ? `Uloqni tortib olish (${u.name}) 🐎` : 'Uloqni ilib olish 🐎', act: () => twPost('/api/game/kopkari/grab', {}, () => toast("Uloq sizda! Qozonga olib boring 🐎", 'success')) };
    }
    for (const w of town.words.values()) {
      if (twNear(w, 90)) return { kind: 'fun', d: 0, text: `🔤 «${w.en}» — tarjima qilish`, act: () => openTw('word', { id: w.id }) };
    }
    if (town.tug && town.tug.phase === 'lobby' && !town.tug.side && twNear(S.rope, 300)) return { kind: 'fun', d: 0, text: "Arqon tortishga qo'shilish 🪢", act: () => twPost('/api/game/tug/join', {}, () => toast("Qo'shildingiz! Boshlanishini kuting 🪢", 'success')) };
    if (town.hunt && !car) {
      for (const id of CLUE_IDS) {
        const pl = T.places[id] || world.places[id];
        const pt = pl && (pl.door || pl.spot);
        if (twNear(pt, 140)) return { kind: 'fun', d: 0, text: '🔍 Xazinani shu yerdan qidirish', act: treasureCheck };
      }
    }
    if (twNear(S.island_land, 160) && !car) return { kind: 'fun', d: 1, text: '🛫 Aeroportga qaytish', act: () => twPost('/api/game/island/back', {}, () => toast('Aeroportga qaytdingiz ✈️')) };
    if (!car && twNear(world.airport.gate, 200)) return { kind: 'fun', d: 1, text: `🏝️ Orolga uchish (${formatNumber(3000)} so'm)`, act: () => twPost('/api/game/island/go', {}, () => toast("Orolga uchdingiz! 🏝️ Palma tagida kokos bor", 'success')) };
    for (const f of T.fuel) if (twNear(f, 130)) return { kind: 'fun', d: 1, text: `⛽ Benzin quyish (${Math.round(town.me.fuel)}%)`, act: fillFuel };
    for (const b of T.bikes) if (!car && twNear(b, 120)) return { kind: 'fun', d: 1, text: `🚲 Velosiped ijarasi — ${formatNumber(500)} so'm / 10 daqiqa`, act: rentBike };
    if (car) return null;
    const P = T.places;
    const doors = [['nightmarket', '🌙 Tungi bozor', () => openTw('night')], ['cave', "🕳️ G'orga kirish — xazina", cave]];
    for (const [id, text, act] of doors) if (twNear(P[id].door, 95)) return { kind: 'fun', d: 1, text, act };
    if (twNear(S.wheel, 120)) return { kind: 'fun', d: 1, text: `🎡 Charxpalak (${formatNumber(1000)} so'm)`, act: () => twRide('wheel') };
    if (twNear(S.carousel, 110)) return { kind: 'fun', d: 1, text: `🎠 Karusel (${formatNumber(700)} so'm)`, act: () => twRide('carousel') };
    if (twNear(S.rope, 200) && (!town.tug || town.tug.phase === 'done')) return { kind: 'fun', d: 1, text: '🪢 Arqon tortishni boshlash', act: () => twPost('/api/game/tug/start', {}, () => toast("Boshlandi! 20 soniyada hamma qo'shilsin 🪢", 'success')) };
    if (twNear(S.sun, 200)) return { kind: 'fun', d: 1, text: '☀️ Quyoshda toblanish', act: () => twPost('/api/game/beach/sun', {}, (d) => toast(d.text, 'success')) };
    if (twNear(S.castle, 200)) return { kind: 'fun', d: 1, text: '🏰 Qumdan qasr qurish', act: () => twPost('/api/game/beach/castle', {}, (d) => toast(d.text, 'success')) };
    if (twNear(S.sub, 160)) return { kind: 'fun', d: 1, text: '🚢 Suv osti kemasi — marvarid yig\'ish', act: () => openTw('play', { game: 'sub' }) };
    if (twNear(S.coconut, 150)) return { kind: 'fun', d: 1, text: '🥥 Palma — kokos va sandiq', act: () => twPost('/api/game/island/coconut', {}, (d) => { sound.cash(); toast(d.text, 'success'); }) };
    for (const s of T.clan_slots) if (twNear(s.door, 80)) return { kind: 'fun', d: 1, text: '🏰 Klan uyi — kunlik bonus', act: () => twPost('/api/game/clanhouse/bonus', {}, (d) => { sound.cash(); toast(`Klan bonusi: +${formatNumber(d.pay)} so'm`, 'success'); }) };
    const hg = homeGate();
    if (hg && twNear(hg, 120)) return { kind: 'fun', d: 2, text: "🏡 Hovli: bog', uyqu, mehmon", act: () => openTw('home') };
    return null;
  }

  // ---- Yordamchilar ----
  function twPost(url, body, ok) {
    return api(url, { method: 'POST', body }).then((d) => {
      if (d.economy) { localVersion += 1; setEconomy(d.economy); }
      if (ok) ok(d);
      return d;
    }).catch(said);
  }
  function openTw(view, extra = {}) {
    if (sheetState && sheetState.timer) clearInterval(sheetState.timer);
    const st = { kind: 'tw', view, v: 0, data: null, ...extra };
    openSheet(st);
    const loader = TW_LOAD[view];
    if (loader) loader(st);
    return st;
  }
  function twLoad(st, url, map = (d) => d) {
    loadInto(st, url, (d) => { st.data = map(d); });
  }
  function twPoll(st, fn, ms) {
    st.timer = setInterval(() => {
      if (sheetState !== st) { clearInterval(st.timer); return; }
      fn();
    }, ms);
  }
  const twRe = (st) => { if (sheetState === st) { st.v += 1; renderSheet(); } };
  const row2 = (title, sub, ...btns) => {
    const r = el('div', 'car-row');
    const info = el('div', 'car-row__info');
    info.append(el('strong', '', title), el('small', '', sub || ''));
    r.append(info, ...btns);
    return r;
  };
  const sm = (ic, text, fn, primary = true) => actionBtn(ic, text, fn, `btn ${primary ? 'btn--primary' : 'btn--ghost'} btn--sm`);
  function onlinePeople() {
    return [...others.entries()].map(([key, o]) => ({ key, name: o.name }));
  }
  function pickPerson(list, label) {
    const s = el('select', 'input-plain');
    s.append(Object.assign(el('option', '', label), { value: '' }));
    list.forEach((p) => { const o = el('option', '', p.name); o.value = p.key; s.append(o); });
    return s;
  }

  function fillFuel() {
    twPost('/api/game/fuel/fill', {}, (d) => {
      town.me.fuel = 100;
      town.fuelSent = 100;
      sound.cash();
      toast(`⛽ Bak to'ldi — ${formatNumber(d.price)} so'm`, 'success');
    });
  }
  function rentBike() {
    twPost('/api/game/rentbike', {}, () => {
      me.rentBike = true;
      setCar('bike');
      town.hadRent = true;
      toast('🚲 Velosiped 10 daqiqaga sizda! Tushish — E', 'success');
    });
  }
  function twRide(kind) {
    twPost('/api/game/ride', { ride: kind }, (d) => {
      town.cam = { kind, cabin: kind === 'wheel' ? 3 : Math.random() * 6, t0: performance.now(), until: performance.now() + d.secs * 1000 };
      toast(kind === 'wheel' ? '🎡 Charxpalakdasiz! Atrofga qarang' : '🎠 Karuselda aylanyapsiz!', 'success');
    });
  }
  function cave() {
    const ov = el('div', 'dive');
    ov.append(el('p', '', "🔦 G'or ichida… qorong'i… nimadir yaltirayapti…"));
    document.body.append(ov);
    setTimeout(() => {
      api('/api/game/cave', { method: 'POST' }).then((d) => {
        localVersion += 1;
        setEconomy(d.economy);
        sound.cash();
        ov.firstChild.textContent = `💰 Xazina: ${formatNumber(d.pay)} so'm${d.gem ? ' va 💎 olmos!' : ''}`;
      }).catch((err) => { ov.firstChild.textContent = err.message; }).finally(() => setTimeout(() => ov.remove(), 2200));
    }, 1500);
  }
  function treasureStart() {
    twPost('/api/game/treasure/start', {}, (d) => {
      town.hunt = `${d.step}/${d.total}: ${d.clue}`;
      closeSheet();
      toast(`🗺️ Maslahat: ${d.clue}`, 'success');
    });
  }
  function treasureCheck() {
    twPost('/api/game/treasure/check', {}, (d) => {
      if (d.done) {
        town.hunt = null;
        sound.cash();
        toast(`💰 Xazina topildi! +${formatNumber(d.pay)} so'm`, 'success');
      } else {
        town.hunt = `${d.step}/${d.total}: ${d.clue}`;
        sound.right();
        toast(`✅ To'g'ri! Keyingi maslahat: ${d.clue}`, 'success');
      }
    });
  }
  function doAct(a) {
    api('/api/game/act', { method: 'POST', body: { a } }).catch(() => {});
    me.act = a;
    clearTimeout(town.actT);
    town.actT = setTimeout(() => { me.act = null; }, 4000);
    closeSheet();
  }
  // Harakatlar animatsiyasi (o'zim va boshqalar uchun)
  function townAct(rig, p, moving) {
    const a = p.act;
    if (!a || moving) return;
    const { legL, legR, armL, armR } = rig.human.userData;
    const t = performance.now() / 120;
    if (a === 'clap') {
      armL.rotation.x = -1.4; armR.rotation.x = -1.4;
      armL.rotation.z = -0.5 + Math.abs(Math.sin(t)) * 0.45; armR.rotation.z = 0.5 - Math.abs(Math.sin(t)) * 0.45;
    } else if (a === 'laugh') {
      rig.human.position.y = Math.abs(Math.sin(t * 1.5)) * 3;
      armL.rotation.x = -0.6; armR.rotation.x = -0.6; armL.rotation.z = -0.9; armR.rotation.z = 0.9;
    } else if (a === 'jump') {
      rig.human.position.y = Math.abs(Math.sin(t / 2)) * 18;
      armL.rotation.x = -2.8; armR.rotation.x = -2.8;
      legL.rotation.x = 0.4; legR.rotation.x = -0.3;
    } else if (a === 'bow') {
      rig.human.rotation.x = 0.5;
      armL.rotation.x = 0.4; armR.rotation.x = 0.4;
      return;
    }
    rig.human.rotation.x = 0;
  }
  // Spoyler
  function townCarKit(rig, p) {
    const want = Boolean(rig.isMe ? town.me.kit.spoiler : p.spoiler) && rig.car && !isRider(carsById[rig.carId]);
    const u = rig.car && rig.car.userData;
    if (!u) return;
    if (want && !u.spoiler) {
      const g = new THREE.Group();
      g.add(box(40, 2.5, 9, mat('#111827'), 0, 26, 0), box(3, 8, 3, mat('#111827'), -14, 21, 0), box(3, 8, 3, mat('#111827'), 14, 21, 0));
      g.position.z = -38;
      rig.car.add(g);
      u.spoiler = g;
    } else if (!want && u.spoiler) {
      rig.car.remove(u.spoiler);
      disposeTree(u.spoiler);
      u.spoiler = null;
    }
  }
  // Vertolyot
  function carHeli(color) {
    const g = new THREE.Group();
    const body = mat(color, { metalness: 0.4, roughness: 0.4 });
    g.add(mesh(new THREE.SphereGeometry(20, 16, 12), body, 0, 24, 6));
    g.children[0].scale.set(1, 0.85, 1.35);
    g.add(mesh(new THREE.SphereGeometry(14, 14, 10), GLASS(), 0, 28, 20));
    const tail = box(6, 6, 50, body, 0, 28, -36);
    g.add(tail, box(2, 16, 10, body, 0, 34, -60));
    [-14, 14].forEach((x) => g.add(box(3, 3, 50, mat('#374151'), x, 4, 4), box(3, 14, 3, mat('#374151'), x, 10, 14), box(3, 14, 3, mat('#374151'), x, 10, -6)));
    const rotor = new THREE.Group();
    rotor.add(box(110, 1.5, 6, mat('#111827'), 0, 0, 0), box(6, 1.5, 110, mat('#111827'), 0, 0, 0));
    rotor.position.set(0, 46, 4);
    g.add(rotor, cyl(2, 2, 10, mat('#374151'), 0, 41, 4, 6));
    g.userData = { wheels: [], pods: [], r: 4, roof: 50, rotor, flies: false };
    return g;
  }
  CAR_BUILDERS.heli = carHeli;

  // ---- Kosmos ----
  function spaceArrive(ov) {
    api('/api/game/space/arrive', { method: 'POST' }).then((d) => {
      town.spaceOv = ov;
      const st = openTw('space');
      st.data = d.space;
      twRe(st);
    }).catch(() => { ov.remove(); });
  }

  // =====================================================================
  //  Oynalar
  // =====================================================================
  const TW_LOAD = {
    home: (st) => { twLoad(st, '/api/game/garden'); api('/api/game/chests').then((d) => { st.chests = d.available; twRe(st); }).catch(() => {}); },
    diary: (st) => twLoad(st, '/api/game/diary'),
    night: (st) => twLoad(st, '/api/game/nightmarket'),
    meeting: (st) => twLoad(st, '/api/game/meeting'),
    mentor: (st) => { twLoad(st, '/api/game/mentor'); api('/api/game/friends').then((d) => { st.friends = d.friends || []; twRe(st); }).catch(() => {}); },
    friends: (st) => twLoad(st, '/api/game/friends'),
    clans2: (st) => twLoad(st, '/api/game/town'),
    reports: (st) => twLoad(st, '/api/game/reports'),
    report: (st) => twLoad(st, '/api/game/people'),
    codetasks: (st) => twLoad(st, '/api/game/codetasks'),
    books: (st) => twLoad(st, '/api/game/books'),
    bets: (st) => { twLoad(st, '/api/game/bets'); twPoll(st, () => api('/api/game/bets').then((d) => { st.data = d; twRe(st); }).catch(() => {}), 3000); },
    kit: (st) => twLoad(st, '/api/game/me2'),
    me2: (st) => twLoad(st, '/api/game/me2'),
    owner: (st) => { twLoad(st, '/api/game/town'); api('/api/game/movie').then((d) => { st.movie = d.movie; twRe(st); }).catch(() => {}); },
    word: (st) => { api(`/api/game/word/${st.id}`).then((d) => { st.data = d; twRe(st); }).catch((err) => { closeSheet(); said(err); }); },
    boss: (st) => { api('/api/game/boss/q').then((d) => { st.data = d; twRe(st); }).catch((err) => { closeSheet(); said(err); }); },
    table: (st) => {
      const pull = () => api('/api/game/table').then((d) => { st.data = d.table; twRe(st); }).catch(() => {});
      pull();
      twPoll(st, pull, 1000);
    },
    math: (st) => {
      const pull = () => api('/api/game/math').then((d) => { if (!st.typing) { st.data = d.math; twRe(st); } }).catch(() => {});
      pull();
      twPoll(st, pull, 1000);
    },
    space: (st) => { if (!st.data) twLoad(st, '/api/game/space', (d) => d.space); },
    invites: (st) => {
      Promise.all([api('/api/game/table/invites'), api('/api/game/home/invites')]).then(([a, b]) => {
        st.data = { table: a.invite, home: b.invite };
        twRe(st);
      }).catch(() => {});
    },
  };

  function renderTw(body, st) {
    const fn = TW_VIEWS[st.view];
    if (fn) fn(body, st);
  }

  const TW_VIEWS = {
    hub(body) {
      setHead('sparkles', 'Yangi shahar', "Joylar, o'yinlar, do'stlar, darslar va transport");
      const sec = (title, tiles) => {
        body.append(el('h3', 'life-h3', title));
        const grid = el('div', 'hub');
        tiles.forEach(([ic, t, sub, fn]) => {
          const b = el('button', 'hub__tile');
          b.type = 'button';
          const i = el('span', 'hub__icon');
          i.append(icon(ic));
          b.append(i, el('strong', '', t), el('small', '', sub));
          b.addEventListener('click', fn);
          grid.append(b);
        });
        body.append(grid);
      };
      const go = (pt, label) => () => { setGuide(pt.x, pt.y, label); closeSheet(); };
      const T = TW();
      const S = T.spots;
      const nearestFuel = () => T.fuel.reduce((a, f) => (Math.hypot(f.x - me.x, f.y - me.y) < Math.hypot(a.x - me.x, a.y - me.y) ? f : a));
      sec('🏡 Uy', [
        ['home', "Hovli: bog' va uyqu", "Daraxt eking, uxlang 😴", () => openTw('home')],
        ['store', 'Bozor rastasi', "Meva va narsalarni sotish 🛒", openMarket],
        ['book', 'Kundalik', "O'yindagi kunlaringiz 📔", () => openTw('diary')],
        ['star', 'Holatim', 'Benzin, ochko, sertifikatlar', () => openTw('me2')],
      ]);
      sec('🏙️ Joylar', [
        ['map-pin', "Istirohat bog'i", 'Charxpalak, karusel, tungi bozor', go(S.wheel, "Istirohat bog'i")],
        ['map-pin', "Tog' va g'or", "Chang'i, ko'pkari, xazina", go(T.places.cave.door, "G'or")],
        ['map-pin', 'Plyaj', 'Dengiz, qasr, suv osti kemasi', go(S.sun, 'Plyaj')],
        ['plane', 'Orol', 'Aeroportdan samolyotda 🏝️', go(world.airport.gate, 'Aeroport (orolga)')],
        ['map-pin', 'Benzin', "Eng yaqin shoxobcha ⛽", () => { const f = nearestFuel(); setGuide(f.x, f.y, 'Benzin'); closeSheet(); }],
      ]);
      sec("🎲 O'yinlar", [
        ['target', 'Shaxmat', "Do'st bilan ♟️", () => openTw('invite', { game: 'chess' })],
        ['target', 'Domino', "Do'st bilan 🁫", () => openTw('invite', { game: 'domino' })],
        ['book', 'Bilim jangi', "Do'st bilan 5 savol 🧠", () => openTw('invite', { game: 'duel' })],
        ['target', 'Kurash', "Do'st bilan 🤼", () => openTw('invite', { game: 'kurash' })],
        ['star', "O'yinlar markazi", 'Tennis, bouling, darts, ritm, xotira', () => openTw('arcade')],
        ['map', 'Xazina xaritasi', 'Kuniga bitta sandiq 🗺️', treasureStart],
        ['plus', 'Matematik poyga', 'Hamma birga ➗', () => openTw('math')],
        ['users', 'Arqon tortish', "Bog'da 🪢", go(S.rope, 'Arqon')],
        ['target', "Ko'pkari", 'Otda, tog\' etagida 🐎', go(S.kopkari_goal, "Ko'pkari")],
        ['trophy', 'Rekordlar', "O'yinlar markazi va chang'i", () => openTw('records')],
      ]);
      sec('👥 Ijtimoiy', [
        ['users', "Do'stga teleport", `${formatNumber(2000)} so'm ✨`, () => openTw('friends')],
        ['sparkles', 'Harakatlar va selfi', "Raqs, qo'l silkitish, 📸", () => openTw('acts')],
        ['message', "Mahalla yig'ini", 'Masala va ovoz berish 🏢', () => openTw('meeting')],
        ['user', 'Ustoz', 'Birga o\'ynab bonus olish 🎓', () => openTw('mentor')],
        ['users', 'Klan uyi va hududlar', 'Klanlar ko\'chasi 🏰🚩', () => openTw('clans2')],
        ['message', 'Takliflar', "Menga kelgan takliflar", () => openTw('invites')],
        ['x', 'Shikoyat', "Yomon xulq haqida owner'ga", () => openTw('report')],
      ]);
      sec('📚 Dars', [
        ['star', 'Sandiqlar', 'Uy vazifasi uchun 📦', () => openTw('home')],
        ['file', 'Kod topshiriqlari', 'Uyingizga bezak 🏮', () => openTw('codetasks')],
        ['book', 'Kitob va sertifikat', 'O\'qing va test yeching 📜', () => openTw('books')],
      ]);
      sec('🚗 Transport', [
        ['hammer', 'Tuning', 'Spoyler va signal', () => openTw('kit')],
        ['target', 'Ochko tikish', 'Poygalarga (pul emas) 🎯', () => openTw('bets')],
        ['plane', 'Kosmos', 'Oy bazasi, Mars, stansiya 🚀', () => openTw('space')],
      ]);
      if (town.state && town.state.owner) sec('👑 Owner', [['crown', 'Owner asboblari', 'Kino, boss, haykal, imtihon kuni', () => openTw('owner')]]);
    },

    home(body, st) {
      setHead('home', "🏡 Hovli", "Bog', uyqu, mehmon va sandiqlar");
      const d = st.data;
      body.append(actionBtn('star', 'Uxlash 😴 (kuniga bonus)', () => {
        twPost('/api/game/sleep', {}, (x) => {
          closeSheet();
          const ov = el('div', 'dive');
          ov.append(el('p', '', '😴 Zzz… Zzz…'));
          document.body.append(ov);
          setTimeout(() => ov.remove(), 2500);
          toast(`Yaxshi uxladingiz! 😴${x.pay ? ` +${formatNumber(x.pay)} so'm` : ''}`, 'success');
        });
      }, 'btn btn--primary btn--block'));
      body.append(el('h3', 'life-h3', `📦 Uy vazifasi sandiqlari: ${st.chests ?? '…'}`));
      if (st.chests) body.append(actionBtn('star', 'Sandiqni ochish', () => twPost('/api/game/chests/open', {}, (x) => { sound.cash(); toast(x.text, 'success'); st.chests = x.available; twRe(st); }), 'btn btn--primary btn--block'));
      else body.append(el('p', 'sheet-note', 'Har topshirilgan uy vazifasi uchun bitta sandiq keladi'));
      body.append(el('h3', 'life-h3', "🌳 Bog'"));
      if (d) {
        setGarden(d.trees);
        d.trees.forEach((t) => body.append(el('p', 'sheet-note', `${{ olma: '🍎 Olma', uzum: '🍇 Uzum', anor: '🍑 Anor' }[t.kind]} — ${t.left ? `${Math.ceil(t.left / 60)} daqiqada pishadi` : 'pishdi! ✅'}`)));
        if (d.trees.length) body.append(actionBtn('check', 'Hosilni terish', () => twPost('/api/game/garden/harvest', {}, (x) => { sound.cash(); toast("Hosil terildi! Bozorda soting 🧺", 'success'); st.data.trees = x.trees; twRe(st); }), 'btn btn--ghost btn--block'));
        if (d.trees.length < d.max) {
          Object.entries(d.catalog).forEach(([k, c]) => body.append(priceButton(`${{ olma: '🍎 Olma', uzum: '🍇 Uzum', anor: '🍑 Anor' }[k]} ekish (${Math.round(c.grow / 3600 * 10) / 10} soat)`, c.price,
            () => twPost('/api/game/garden/plant', { kind: k }, (x) => { st.data.trees = x.trees; twRe(st); }))));
        }
      }
      body.append(el('h3', 'life-h3', '🏠 Mehmonga chaqirish'));
      const who = pickPerson(onlinePeople(), "Kimni chaqirasiz?");
      body.append(who, actionBtn('send', 'Taklif yuborish', () => {
        if (!who.value) return;
        twPost('/api/game/home/invite', { to: who.value }, () => toast('Taklif yuborildi 🏠', 'success'));
      }, 'btn btn--ghost btn--block'));
    },

    diary(body, st) {
      setHead('book', '📔 Kundalik', "O'yindagi kunlaringiz");
      const inp = el('input', 'input-plain');
      inp.maxLength = 300;
      inp.placeholder = 'Bugun nima qildingiz?';
      body.append(inp, actionBtn('plus', 'Yozish', () => {
        api('/api/game/diary', { method: 'POST', body: { text: inp.value } }).then((d) => { st.data = d; twRe(st); }).catch(said);
      }, 'btn btn--primary btn--block'));
      (st.data ? st.data.items : []).forEach((i) => body.append(el('p', 'sheet-note', `${i.auto ? '🤖' : '✍️'} ${i.at} — ${i.text}`)));
    },

    me2(body, st) {
      setHead('star', 'Holatim', '');
      const d = st.data;
      if (!d) return;
      [[`⛽ Benzin: ${Math.round(town.me.fuel)}%`, 'Shoxobchalarda quyiladi (velosiped, ot, gilam — benzinsiz)'],
        [`🎯 Ochko: ${d.points}`, 'Poygalarga tikish uchun, har kuni +100'],
        [`📜 Sertifikatlar: ${d.certs.length}`, 'Kutubxonada kitob o\'qib oling'],
        [`🏮 Uy bezaklari: ${d.decor.length}`, 'Kod topshiriqlari uchun'],
        [`🚀 Oy bazasi: ${d.base ? 'bor' : "yo'q"} · Mars: ${d.mars} marta`, ''],
        [town.me.x2 ? '📚 Bugun darsga keldingiz: daromad x2!' : '📚 Darsga kelgan kuningiz daromad x2 bo\'ladi', '']].forEach(([a, b]) => body.append(row2(a, b)));
    },

    night(body, st) {
      setHead('star', '🌙 Tungi bozor', '20:00 — 06:00 ochiq');
      const d = st.data;
      if (!d) return;
      if (!d.open) { body.append(el('p', 'sheet-note', 'Hozir yopiq. Kechqurun soat 20:00 da ochiladi 🌙')); return; }
      Object.entries(d.prices).forEach(([k, price]) => body.append(priceButton(`${d.catalog[k].icon} ${d.catalog[k].name}`, price, () => twPost('/api/game/nightmarket', { item: k }, (x) => { sound.cash(); toast(x.text, 'success'); }))));
      body.append(actionBtn('sparkles', '🔮 Folbinga fol ochtirish (bepul)', () => twPost('/api/game/nightmarket', { fortune: true }, (x) => toast(x.text, 'success')), 'btn btn--ghost btn--block'));
    },

    invite(body, st) {
      const names = { chess: '♟️ Shaxmat', domino: '🁫 Domino', duel: '🧠 Bilim jangi', kurash: '🤼 Kurash' };
      setHead('users', names[st.game], `G'olibga pul mukofoti (kuniga 5 marta)`);
      if (st.game === 'kurash') body.append(el('p', 'sheet-note', "10 soniya ichida tugmani raqibdan ko'p bosing 🤼"));
      TW_VIEWS.invitePick(body, st.game);
    },
    invitePick(body, game) {
      const list = onlinePeople();
      if (!list.length) { body.append(el('p', 'sheet-note', "Hozir o'yinda boshqa hech kim yo'q")); return; }
      const who = pickPerson(list, 'Raqibni tanlang');
      body.append(who, actionBtn('send', 'Chaqirish', () => {
        if (!who.value) return;
        twPost('/api/game/table/invite', { game, to: who.value }, () => toast('Taklif yuborildi — javobini kuting 🎲', 'success'));
      }, 'btn btn--primary btn--block'));
    },

    invites(body, st) {
      setHead('message', 'Takliflar', '');
      const d = st.data;
      if (!d) return;
      if (!d.table && !d.home) body.append(el('p', 'sheet-note', "Hozircha taklif yo'q"));
      if (d.table) {
        body.append(row2(`🎲 ${d.table.name}: ${d.table.game_name}`, 'Rozimisiz?',
          sm('check', 'Ha', () => api('/api/game/table/accept', { method: 'POST', body: { yes: true } }).then((x) => { if (x.table) { town.tableSeen = x.table.id; const s2 = openTw('table'); s2.data = x.table; twRe(s2); } }).catch(said)),
          sm('x', "Yo'q", () => api('/api/game/table/accept', { method: 'POST', body: { yes: false } }).then(() => closeSheet()).catch(said), false)));
      }
      if (d.home) {
        body.append(row2(`🏠 ${d.home.name} sizni uyiga chaqiryapti`, '',
          sm('check', 'Mehmonga borish', () => api('/api/game/home/visit', { method: 'POST' }).then((x) => {
            toast('Mehmondasiz! 🏠', 'success');
            setTimeout(() => enterRoom(x.plot, `/api/game/home/room/${x.plot}`), 700);
          }).catch(said))));
      }
    },

    table(body, st) {
      const t = st.data;
      if (!t) { setHead('target', "O'yin", ''); body.append(el('p', 'sheet-note', "O'yin yo'q")); return; }
      const over = t.winner || t.draw;
      setHead('target', `${t.name}: ${t.other_name} bilan`, over ? '' : (t.game === 'chess' || t.game === 'domino' ? (t.my_turn ? '🟢 Sizning navbatingiz' : '⏳ Raqib o\'ylayapti…') : ''));
      if (over) {
        const res = t.draw ? '🤝 Durang!' : (t.winner === t.me ? `🏆 Siz yutdingiz! +${formatNumber(t.prize)} so'm` : '😔 Raqib yutdi');
        if (st.shownEnd !== t.id) { st.shownEnd = t.id; if (t.winner === t.me) sound.cash(); }
        body.append(el('p', t.winner === t.me ? 'kitchen__ok' : 'kitchen__bad', res));
      }
      const G = TW_GAMES[t.game];
      if (G) G(body, st, t, over);
      body.append(over
        ? actionBtn('x', 'Yopish', () => { api('/api/game/table/resign', { method: 'POST' }).catch(() => {}); closeSheet(); }, 'btn btn--ghost btn--block')
        : actionBtn('x', 'Taslim bo\'lish', () => { if (window.confirm('Taslim bo\'lasizmi?')) api('/api/game/table/resign', { method: 'POST' }).then(() => closeSheet()).catch(said); }, 'btn btn--ghost btn--block'));
    },

    math(body, st) {
      setHead('plus', '➗ Matematik poyga', `Birinchi bo'lib 10 ta misolni yeching — ${formatNumber(8000)} so'm`);
      const m = st.data;
      if (!m) {
        body.append(actionBtn('plus', 'Poygani boshlash', () => api('/api/game/math/start', { method: 'POST' }).then((d) => { st.data = d.math; twRe(st); }).catch(said), 'btn btn--primary btn--block'));
        return;
      }
      if (m.phase === 'lobby') {
        body.append(el('p', 'kitchen__dish', `⏳ ${m.left} soniyada boshlanadi`));
        if (!m.joined) body.append(actionBtn('plus', "Qo'shilish", () => api('/api/game/math/join', { method: 'POST' }).then((d) => { st.data = d.math; twRe(st); }).catch(said), 'btn btn--primary btn--block'));
      } else if (m.phase === 'play' && m.joined && m.q) {
        body.append(el('p', 'kitchen__dish', `${m.q}   (${m.n}/${m.goal}) · ${m.left} s`));
        const inp = el('input', 'input-plain');
        inp.type = 'number';
        inp.inputMode = 'numeric';
        inp.placeholder = 'Javob';
        const send = () => {
          st.typing = false;
          api('/api/game/math/answer', { method: 'POST', body: { a: Number(inp.value) } }).then((d) => {
            if (d.math.n > m.n) sound.right(); else sound.wrong();
            st.data = d.math;
            twRe(st);
            const ni = $('sheet-body').querySelector('input');
            if (ni) ni.focus();
          }).catch(said);
        };
        inp.addEventListener('input', () => { st.typing = true; });
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
        body.append(inp, actionBtn('check', 'Javob', send, 'btn btn--primary btn--block'));
        setTimeout(() => inp.focus(), 30);
      } else if (m.phase === 'done') {
        body.append(el('p', 'kitchen__ok', m.winner ? `🏆 G'olib: ${m.winner}` : 'Vaqt tugadi'));
      } else body.append(el('p', 'sheet-note', `Poyga ketyapti (${m.left} s) — keyingisiga qo'shiling`));
      m.players.forEach((p) => body.append(el('p', 'sheet-note', `${p.name}: ${'🟩'.repeat(p.n)}${'⬜'.repeat(Math.max(0, m.goal - p.n))}`)));
    },

    tug(body) {
      const t = town.tug;
      setHead('users', '🪢 Arqon tortish', t ? `Chap: ${t.L} kishi · O'ng: ${t.R} kishi` : '');
      if (!t) { body.append(el('p', 'sheet-note', 'Arqon tortish tugadi')); return; }
      if (t.phase === 'play' && t.side) {
        const diff = (t.taps.L - t.taps.R);
        body.append(el('p', 'kitchen__dish', `${t.side === 'L' ? '⬅️ Siz chapdasiz' : "Siz o'ngdasiz ➡️"} · ${t.left} s · ${diff > 0 ? '⬅️' : diff < 0 ? '➡️' : '⏸️'} ${Math.abs(diff)}`));
        const b = actionBtn('users', 'TORT! 💪', () => {
          town.tugTaps += 1;
          if (!town.tugTimer) {
            town.tugTimer = setTimeout(() => {
              const n = Math.min(8, town.tugTaps);
              town.tugTaps = 0;
              town.tugTimer = null;
              api('/api/game/tug/tap', { method: 'POST', body: { taps: n } }).catch(() => {});
            }, 400);
          }
        }, 'btn btn--primary btn--block tw-big');
        body.append(b);
      } else body.append(el('p', 'sheet-note', t.phase === 'lobby' ? `${t.left} soniyada boshlanadi` : (t.result || '')));
    },

    acts(body) {
      setHead('sparkles', "Harakatlar va selfi", 'Boshqalar ham ko\'radi');
      const grid = el('div', 'kitchen__grid');
      [['wave', "👋 Qo'l silkitish"], ['dance', '💃 Raqs'], ['laugh', '😂 Kulish'], ['clap', '👏 Chapak'], ['jump', '🤸 Sakrash'], ['bow', "🙇 Ta'zim"]].forEach(([a, t]) => {
        const b = el('button', 'btn btn--ghost', t);
        b.type = 'button';
        b.addEventListener('click', () => doAct(a));
        grid.append(b);
      });
      body.append(grid, actionBtn('star', '📸 Selfi', () => selfie(false), 'btn btn--primary btn--block'),
        actionBtn('users', '📸 Guruh selfisi (yaqindagilar bilan)', () => selfie(true), 'btn btn--ghost btn--block'));
    },

    friends(body, st) {
      setHead('users', "Do'stga teleport", `${formatNumber(2000)} so'm — do'stingiz yoniga bir zumda`);
      const d = st.data;
      if (!d) return;
      const list = (d.friends || []).filter((f) => f.online);
      if (!list.length) body.append(el('p', 'sheet-note', "Onlayn do'st yo'q (do'stlar — telefon oynasida)"));
      list.forEach((f) => body.append(row2(`🟢 ${f.name}`, '', sm('navigation', 'Teleport', () => twPost('/api/game/friends/goto', { key: f.key }, () => { closeSheet(); toast(`✨ ${f.name} yonidasiz!`, 'success'); })))));
    },

    meeting(body, st) {
      setHead('message', "🏢 Mahalla yig'ini", "Masala qo'ying — hamma ovoz beradi (24 soat)");
      const d = st.data;
      if (!d) return;
      const inp = el('input', 'input-plain');
      inp.maxLength = 200;
      inp.placeholder = "Masala: masalan, «Bog'ga ko'proq daraxt ekaylik»";
      body.append(inp, priceButton("Masala qo'yish", d.price, () => api('/api/game/meeting', { method: 'POST', body: { text: inp.value } }).then((x) => { localVersion += 1; st.data = x; twRe(st); })));
      d.items.forEach((m) => {
        const r = row2(`${m.open ? '🟢' : '⚪'} ${m.text}`, `${m.author} · 👍 ${m.yes} · 👎 ${m.no}${m.open ? ` · ${m.left_h} soat` : ' · tugagan'}`);
        if (m.open) {
          r.append(sm('check', m.mine === 1 ? '👍 ✓' : '👍', () => api(`/api/game/meeting/${m.id}/vote`, { method: 'POST', body: { yes: true } }).then((x) => { st.data = x; twRe(st); }).catch(said), m.mine !== 1),
            sm('x', m.mine === 0 ? '👎 ✓' : '👎', () => api(`/api/game/meeting/${m.id}/vote`, { method: 'POST', body: { yes: false } }).then((x) => { st.data = x; twRe(st); }).catch(said), m.mine !== 0));
        }
        if (m.can_delete) r.append(sm('trash', '', () => api(`/api/game/meeting/${m.id}`, { method: 'DELETE' }).then((x) => { st.data = x; twRe(st); }).catch(said), false));
        body.append(r);
      });
    },

    mentor(body, st) {
      setHead('user', '🎓 Ustoz', `Ustozingiz bilan 5 daqiqa birga o'ynasangiz — ikkalangizga ${formatNumber(5000)} so'm (kuniga)`);
      const d = st.data;
      if (!d) return;
      body.append(row2(d.mentor ? `Ustozingiz: ${d.mentor.name}` : "Ustoz tanlanmagan", d.mentor ? `Bugun birga: ${Math.floor(d.progress / 60)}/${d.need / 60} daqiqa` : ''));
      const who = pickPerson((st.friends || []).map((f) => ({ key: f.key, name: f.name })), "Do'stlardan ustoz tanlang");
      body.append(who, actionBtn('check', 'Ustoz qilish', () => { if (who.value) api('/api/game/mentor', { method: 'POST', body: { key: who.value } }).then((x) => { st.data = x; twRe(st); }).catch(said); }, 'btn btn--primary btn--block'));
      if (d.mentor) body.append(actionBtn('x', 'Ustozdan voz kechish', () => api('/api/game/mentor', { method: 'POST', body: { key: null } }).then((x) => { st.data = x; twRe(st); }).catch(said), 'btn btn--ghost btn--block'));
      if (d.mentees.length) body.append(el('p', 'sheet-note', `Shogirdlaringiz: ${d.mentees.map((m) => m.name).join(', ')}`));
    },

    clans2(body, st) {
      setHead('users', "🏰 Klan uylari va hududlar", `Klan uyi: ${formatNumber(200000)} so'm (klan kassasidan, boshliq sotib oladi)`);
      const d = st.data;
      if (!d) return;
      body.append(actionBtn('home', 'Klan uyini sotib olish', () => api('/api/game/clanhouse/buy', { method: 'POST' }).then((x) => { setHouses(x.houses); toast('Klan uyi qurildi! 🏰', 'success'); TW_LOAD.clans2(st); }).catch(said), 'btn btn--primary btn--block'),
        actionBtn('map-pin', "Klanlar ko'chasiga yo'l", () => { const s = TW().clan_slots[0].door; setGuide(s.x, s.y, "Klanlar ko'chasi"); closeSheet(); }, 'btn btn--ghost btn--block'));
      d.houses.forEach((h) => body.append(el('p', 'sheet-note', `🏰 [${h.tag}] ${h.name}`)));
      body.append(el('h3', 'life-h3', '🚩 Hududlar'), el('p', 'sheet-note', "Klan a'zolari hudud bayrog'i yonida (aylana ichida) raqibdan 60 soniya ko'proq tursa — hudud klanniki. Har soatda klan kassasiga 2 000 so'm."));
      d.zones.forEach((z) => body.append(row2(`🚩 ${z.name}`, z.clan ? `[${z.clan.tag}] ${z.clan.name}` : 'Egasiz', sm('map-pin', "Yo'l", () => { setGuide(z.x, z.y, z.name); closeSheet(); }, false))));
    },

    report(body, st) {
      setHead('x', 'Shikoyat', "Faqat owner ko'radi");
      const d = st.data;
      if (!d) return;
      const who = pickPerson((d.people || []).filter((p) => !p.me && p.key !== 'owner'), 'Kim haqida?');
      const why = el('input', 'input-plain');
      why.maxLength = 300;
      why.placeholder = "Nima bo'ldi?";
      body.append(who, why, actionBtn('send', 'Yuborish', () => { if (who.value) twPost('/api/game/report', { key: who.value, reason: why.value }, () => { toast("Shikoyat owner'ga yuborildi", 'success'); closeSheet(); }); }, 'btn btn--primary btn--block'));
    },

    reports(body, st) {
      setHead('x', 'Shikoyatlar', '');
      (st.data ? st.data.items : []).forEach((r) => body.append(row2(`${r.done ? '✅' : '⚠️'} ${r.from} → ${r.to}`, `${r.at} · ${r.reason}`,
        ...(r.done ? [] : [sm('check', 'Ko\'rildi', () => api(`/api/game/reports/${r.id}/done`, { method: 'POST' }).then((x) => { st.data = x; twRe(st); }).catch(said), false)]))));
    },

    codetasks(body, st) {
      setHead('file', 'Kod topshiriqlari', 'Bajarsangiz — uyingiz oldiga bezak va 5 000 so\'m');
      const d = st.data;
      if (!d) return;
      d.tasks.forEach((t) => {
        body.append(row2(`${t.done ? '✅' : '📝'} ${t.title} → ${t.decor}`, t.task, sm('file', t.done ? 'Qayta' : 'Yozish', () => { st.task = t.id; twRe(st); }, !t.done)));
        if (st.task === t.id) {
          const ta = el('textarea', 'input-plain tw-code');
          ta.rows = 7;
          ta.spellcheck = false;
          ta.placeholder = 'Kodingizni shu yerga yozing…';
          body.append(ta, actionBtn('check', 'Tekshirish', () => api(`/api/game/codetasks/${t.id}`, { method: 'POST', body: { code: ta.value } }).then((x) => {
            toast(x.text, x.ok ? 'success' : 'warn');
            if (x.ok) { sound.cash(); loadTown(); TW_LOAD.codetasks(st); st.task = null; }
          }).catch(said), 'btn btn--primary btn--block'));
        }
      });
    },

    books(body, st) {
      setHead('book', '📚 Kitob va sertifikat', "O'qing, 3 savolga to'g'ri javob bering — sertifikat va 5 000 so'm");
      const d = st.data;
      if (!d) return;
      if (st.cert) {
        body.append(certCanvas(st.cert), actionBtn('arrow-left', 'Kitoblarga qaytish', () => { st.cert = null; twRe(st); }, 'btn btn--ghost btn--block'));
        return;
      }
      const b = d.books.find((x) => x.id === st.book);
      if (!b) {
        d.books.forEach((x) => body.append(row2(`${x.passed ? '📜' : '📖'} ${x.title}`, x.passed ? 'Sertifikat olingan' : '', sm('book', "O'qish", () => { st.book = x.id; st.ans = []; twRe(st); }))));
        return;
      }
      body.append(el('h3', 'life-h3', b.title), el('p', 'tw-text', b.text));
      b.qs.forEach((q, n) => {
        const bx = el('div', 'lic-q');
        bx.append(el('strong', '', `${n + 1}. ${q.q}`));
        const opts = el('div', 'lic-opts');
        q.options.forEach((o, i) => {
          const btn = el('button', `btn ${st.ans[n] === i ? 'btn--primary' : 'btn--ghost'} btn--sm`, o);
          btn.type = 'button';
          btn.addEventListener('click', () => { st.ans[n] = i; twRe(st); });
          opts.append(btn);
        });
        bx.append(opts);
        body.append(bx);
      });
      body.append(actionBtn('check', 'Topshirish', () => api(`/api/game/books/${b.id}`, { method: 'POST', body: { answers: b.qs.map((_, i) => (st.ans[i] ?? -1)) } }).then((x) => {
        if (!x.ok) { toast(x.text, 'warn'); return; }
        if (x.economy) { localVersion += 1; setEconomy(x.economy); }
        sound.cash();
        st.cert = x.cert;
        st.book = null;
        TW_LOAD.books(st);
      }).catch(said), 'btn btn--primary btn--block'), actionBtn('arrow-left', 'Orqaga', () => { st.book = null; twRe(st); }, 'btn btn--ghost btn--block'));
    },

    word(body, st) {
      setHead('book', '🔤 Inglizcha so\'z', 'To\'g\'ri tarjima — 1 000 so\'m');
      const d = st.data;
      if (!d) return;
      body.append(el('p', 'kitchen__dish', d.en));
      const grid = el('div', 'kitchen__grid');
      d.options.forEach((o) => {
        const b = el('button', 'btn btn--ghost', o);
        b.type = 'button';
        b.addEventListener('click', () => api(`/api/game/word/${st.id}`, { method: 'POST', body: { answer: o } }).then((x) => {
          if (x.ok) { localVersion += 1; setEconomy(x.economy); sound.cash(); toast(`${x.text} +${formatNumber(x.pay)} so'm`, 'success'); } else { sound.wrong(); toast(`Xato 🙁 To'g'ri javob: ${x.right}`, 'warn'); }
          closeSheet();
        }).catch(said));
        grid.append(b);
      });
      body.append(grid);
    },

    boss(body, st) {
      const d = st.data;
      setHead('target', '👾 Owner Boss', d ? `❤️ ${d.hp}/${d.max} — to'g'ri javob bossga zarba beradi` : '');
      if (!d) return;
      body.append(el('p', 'kitchen__dish', d.question));
      const grid = el('div', 'kitchen__grid');
      d.options.forEach((o, i) => {
        const b = el('button', 'btn btn--ghost', o);
        b.type = 'button';
        b.addEventListener('click', () => api('/api/game/boss/hit', { method: 'POST', body: { answer: i } }).then((x) => {
          if (x.ok) { sound.right(); toast(x.won ? '🎉 BOSS YENGILDI!' : `💥 Zarba! Bossda ${x.hp} jon qoldi`, 'success'); } else { sound.wrong(); toast("Xato 🙁 Boss kulib qo'ydi", 'warn'); }
          if (!x.won && x.hp > 0) TW_LOAD.boss(st); else closeSheet();
        }).catch(said));
        grid.append(b);
      });
      body.append(grid);
    },

    kit(body, st) {
      setHead('hammer', '🔧 Tuning', 'Spoyler va signal (H tugmasi)');
      const d = st.data;
      if (!d) return;
      const kit = d.kit || {};
      const save = (b) => api('/api/game/kit', { method: 'POST', body: b }).then((x) => { localVersion += 1; setEconomy(x.economy); town.me.kit = x.kit; st.data.kit = x.kit; sound.cash(); twRe(st); }).catch(said);
      body.append(row2(`🏁 Spoyler ${kit.spoiler ? '(bor)' : ''}`, kit.spoiler_owned ? 'Sotib olingan' : `${formatNumber(20000)} so'm`, sm('check', kit.spoiler ? "Olib tashlash" : "O'rnatish", () => save({ spoiler: !kit.spoiler }))));
      [['classic', '📯 Oddiy'], ['melody', '🎵 Kuy'], ['truck', '🚛 Yuk mashina']].forEach(([h, n]) => {
        const owned = (kit.horns || ['classic']).includes(h);
        body.append(row2(`${n} signal ${kit.horn === h || (!kit.horn && h === 'classic') ? '✓' : ''}`, owned ? '' : `${formatNumber(5000)} so'm`,
          sm('rotate', 'Eshitish', () => sound.horn('bmw', h), false), sm('check', 'Tanlash', () => save({ horn: h }))));
      });
    },

    bets(body, st) {
      setHead('target', '🎯 Ochko tikish', 'Pul emas — ochko! Har kuni +100 ochko. Yutsangiz 2 baravar');
      const d = st.data;
      if (!d) return;
      body.append(el('p', 'kitchen__dish', `Sizda: ${d.points} ochko`));
      if (!d.races.length) body.append(el('p', 'sheet-note', "Hozir poyga yo'q. Kimdir poygaga chaqirganda shu yerda chiqadi"));
      d.races.forEach((r) => {
        if (r.mine) { body.append(row2(`🏁 ${r.a_name} vs ${r.b_name}`, `Tikdingiz: ${r.mine.amount} ochko → ${r.mine.pick === r.a ? r.a_name : r.b_name}`)); return; }
        const amt = el('input', 'input-plain');
        amt.type = 'number';
        amt.value = '20';
        const bet = (pick) => api('/api/game/bets', { method: 'POST', body: { race: r.id, pick, amount: Math.round(Number(amt.value)) } }).then((x) => { st.data = x; twRe(st); toast('Tikildi 🎯', 'success'); }).catch(said);
        body.append(row2(`🏁 ${r.a_name} vs ${r.b_name}`, ''), amt, el('div', 'kitchen__grid'));
        body.lastChild.append(sm('target', r.a_name, () => bet(r.a)), sm('target', r.b_name, () => bet(r.b)));
      });
      if (d.top.length) body.append(el('h3', 'life-h3', '🏆 Ochko reytingi'), ...d.top.map((t, i) => el('p', 'sheet-note', `${i + 1}. ${t.name} — ${t.points}`)));
    },

    space(body, st) {
      setHead('plane', '🚀 Kosmos', '');
      const s = st.data;
      if (!s) return;
      const act = (a) => api(`/api/game/space/${a}`, { method: 'POST' }).then((x) => {
        if (x.economy) { localVersion += 1; setEconomy(x.economy); }
        if (x.text) toast(x.text, 'success');
        if (a === 'home') {
          if (town.spaceOv) { town.spaceOv.remove(); town.spaceOv = null; }
          closeSheet();
          return;
        }
        st.data = x.space;
        if (town.spaceOv) {
          town.spaceOv.querySelector('.moon-trip__moon').textContent = x.space.where === 'mars' ? '🔴' : x.space.where === 'station' ? '🛰️' : '🌕';
          town.spaceOv.querySelector('.moon-trip__text').textContent = x.space.where === 'mars' ? 'Marsdasiz! 🔴' : x.space.where === 'station' ? 'Kosmik stansiyada 🛰️' : 'Oydasiz 🌕';
        }
        twRe(st);
      }).catch(said);
      if (!s.where) {
        body.append(el('p', 'sheet-note', `Kosmosga kosmodromdan uchiladi (aeroport janubida). Oyga ${s.moon} marta uchgansiz. Mars — ${s.mars_need} martadan keyin.`),
          actionBtn('map-pin', "Kosmodromga yo'l", () => { setGuide(world.rocket.x, world.rocket.y, 'Kosmodrom'); closeSheet(); }, 'btn btn--primary btn--block'));
        return;
      }
      const where = { moon: '🌕 Oydasiz', mars: '🔴 Marsdasiz', station: '🛰️ Kosmik stansiyadasiz' }[s.where];
      body.append(el('p', 'kitchen__dish', `${where} · ${Math.ceil(s.left / 60)} daqiqa qoldi`));
      if (s.where === 'moon') {
        if (!s.base) body.append(priceButton('🏠 Oyda baza qurish', s.base_price, () => act('base')));
        else body.append(actionBtn('plus', `🫧 Kislorod yig'ish (${s.oxygen}/5)`, () => act('oxygen'), 'btn btn--primary btn--block'));
        body.append(s.moon >= s.mars_need ? priceButton('🔴 Marsga uchish', s.mars_price, () => act('mars')) : el('p', 'sheet-note', `🔴 Mars: Oyga ${s.mars_need} marta uching (${s.moon}/${s.mars_need})`));
      }
      if (s.where === 'mars') body.append(actionBtn('plus', `🪨 Mars toshi yig'ish (${s.rocks}/3)`, () => act('rock'), 'btn btn--primary btn--block'));
      if (s.where !== 'station') body.append(actionBtn('star', '🛰️ Kosmik stansiyaga', () => act('station'), 'btn btn--ghost btn--block'));
      else {
        body.append(el('p', 'sheet-note', `Stansiyada: ${s.station.join(', ') || 'faqat siz'}`));
        body.append(actionBtn('star', '🌕 Oyga qaytish', () => act('moon'), 'btn btn--ghost btn--block'));
      }
      body.append(actionBtn('home', '🌍 Yerga qaytish', () => act('home'), 'btn btn--ghost btn--block'));
    },

    records(body, st) {
      setHead('trophy', 'Haftalik rekordlar', '');
      if (!st.data) {
        st.data = {};
        const list = ['tennis', 'bowling', 'darts', 'rhythm', 'memory', 'sub'];
        Promise.all(list.map((g) => api(`/api/game/arcade/top/${g}`).then((d) => [g, d.top]).catch(() => [g, []])))
          .then((rows) => api('/api/game/records/ski').then((d) => [...rows, ['ski', d.top]]).catch(() => rows))
          .then((rows) => { st.data = Object.fromEntries(rows); twRe(st); });
        return;
      }
      const names = { tennis: '🎾 Tennis', bowling: '🎳 Bouling', darts: '🎯 Darts', rhythm: '🎵 Ritm', memory: '🃏 Xotira', sub: '🚢 Suv osti', ski: "⛷️ Chang'i (s)" };
      Object.entries(st.data).forEach(([g, top]) => body.append(el('h3', 'life-h3', names[g]), el('p', 'sheet-note', (top || []).slice(0, 3).map((t, i) => `${['🥇', '🥈', '🥉'][i]} ${t.name} — ${t.best}`).join('   ') || "Hali yo'q")));
    },

    owner(body, st) {
      setHead('crown', '👑 Owner asboblari', '');
      const m = st.movie;
      body.append(el('h3', 'life-h3', '🎬 Kinoteatr'), el('p', 'sheet-note', m ? `Hozir: «${m.title}»` : 'Kino qo\'yilmagan'));
      const url = el('input', 'input-plain');
      url.placeholder = 'YouTube havolasi';
      const title = el('input', 'input-plain');
      title.placeholder = 'Kino nomi';
      body.append(url, title, actionBtn('check', "Kinoni qo'yish / bo'sh — o'chirish", () => api('/api/game/movie', { method: 'POST', body: { url: url.value, title: title.value } }).then((x) => { st.movie = x.movie; toast('Saqlandi', 'success'); twRe(st); }).catch(said), 'btn btn--primary btn--block'));
      body.append(el('h3', 'life-h3', '👾 Boss'), actionBtn('target', 'Boss bo\'lib favvora oldiga chiqish', () => api('/api/game/boss/start', { method: 'POST' }).then(() => { toast('Boss maydonda! 👾', 'success'); closeSheet(); }).catch(said), 'btn btn--primary btn--block'));
      body.append(el('h3', 'life-h3', '⭐ Haykal'));
      const nm = el('input', 'input-plain');
      nm.placeholder = "O'quvchi ismi (bo'sh — avtomatik, reyting bo'yicha)";
      body.append(nm, actionBtn('check', 'Saqlash', () => api('/api/game/statue', { method: 'POST', body: { name: nm.value } }).then((x) => { setStatue(x.statue); toast('Saqlandi', 'success'); }).catch(said), 'btn btn--ghost btn--block'));
      const examOn = st.data && st.data.exam_day;
      body.append(el('h3', 'life-h3', '📝 Imtihon kuni'), el('p', 'sheet-note', examOn ? "Bugun imtihon kuni — o'quvchilar uchun o'yin yopiq" : "O'yin ochiq"),
        actionBtn('lock', examOn ? "O'yinni ochish" : "Bugun o'yinni yopish (imtihon kuni)", () => api('/api/game/examday', { method: 'POST', body: { on: !examOn } }).then(() => TW_LOAD.owner(st)).catch(said), 'btn btn--ghost btn--block'));
      body.append(el('h3', 'life-h3', '⚠️ Shikoyatlar'), actionBtn('x', 'Shikoyatlar', () => openTw('reports'), 'btn btn--ghost btn--block'));
    },

    movie(body, st) {
      const m = st.data;
      setHead('star', `🎬 ${m.title}`, "Hamma birga ko'ryapti — owner qo'ygan kino");
      const fr = el('iframe', 'tw-frame');
      fr.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(m.id)}?autoplay=1&start=${Math.max(0, m.elapsed | 0)}`;
      fr.allow = 'autoplay; encrypted-media; fullscreen';
      fr.allowFullscreen = true;
      fr.title = m.title;
      body.append(fr);
    },

    arcade(body) {
      setHead('star', "🕹️ O'yinlar markazi", "Ochko — pul (har o'yinda kuniga 15 000 so'mgacha)");
      [['tennis', '🎾 Tennis', "Raketka bilan to'pni qaytaring"], ['bowling', '🎳 Bouling', "Kegllarni urib tushiring"], ['darts', '🎯 Darts', "Nishonning o'rtasiga"],
        ['rhythm', '🎵 Ritm', 'D F J K yoki ekranni bosing'], ['memory', '🃏 Xotira', 'Juft kartalarni toping']].forEach(([g, t, s]) => body.append(row2(t, s, sm('target', "O'ynash", () => openTw('play', { game: g })))));
    },

    play(body, st) {
      const G = ARCADE_GAMES[st.game];
      setHead('star', G.title, G.help);
      if (st.result) {
        body.append(el('p', 'kitchen__ok', st.result), actionBtn('rotate', 'Yana', () => openTw('play', { game: st.game }), 'btn btn--primary btn--block'));
        return;
      }
      if (!st.canvas) {
        body.append(actionBtn('target', 'Boshlash', () => {
          api('/api/game/arcade/start', { method: 'POST', body: { game: st.game } }).then(() => {
            st.canvas = el('canvas', 'tw-canvas');
            st.canvas.width = 360;
            st.canvas.height = 260;
            st.t0 = performance.now();
            twRe(st);
            G.run(st, st.canvas, (score) => finishArcade(st, score));
          }).catch(said);
        }, 'btn btn--primary btn--block'));
        return;
      }
      body.append(st.canvas);
      if (G.buttons) body.append(G.buttons(st));
    },
  };

  function finishArcade(st, score) {
    if (sheetState !== st) return;
    st.done = true;
    const G = ARCADE_GAMES[st.game];
    const elapsed = (performance.now() - st.t0) / 1000;
    if (!score || elapsed < G.min) {
      st.result = score ? `Ochko: ${score} — juda tez tugadi, yana urinib ko'ring 🙂` : "0 ochko — yana urinib ko'ring 🙂";
      twRe(st);
      return;
    }
    api('/api/game/arcade/finish', { method: 'POST', body: { game: st.game, score } }).then((x) => {
      localVersion += 1;
      setEconomy(x.economy);
      if (x.pay) sound.cash();
      st.result = `Ochko: ${score}${x.best ? ' — haftalik rekord! 🏆' : ''} · +${formatNumber(x.pay)} so'm${x.pearls ? ` · 🦪 ${x.pearls} marvarid` : ''}${x.capped ? ' (bugungi chegara)' : ''}`;
      twRe(st);
    }).catch((err) => { st.result = err.message; twRe(st); });
  }

  // ---- Arkada o'yinlari (canvas) ----
  function gameLoop(st, cv, step) {
    const g = cv.getContext('2d');
    let last = performance.now();
    const frame = (now) => {
      if (sheetState !== st || st.done) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!document.body.contains(cv)) { const host = $('sheet-body'); if (host && !host.contains(cv)) { /* qayta chizildi */ } }
      step(g, dt, now);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }
  const pointerX = (cv, e) => { const r = cv.getBoundingClientRect(); return ((e.clientX - r.left) / r.width) * cv.width; };
  const pointerY = (cv, e) => { const r = cv.getBoundingClientRect(); return ((e.clientY - r.top) / r.height) * cv.height; };
  const ARCADE_GAMES = {
    tennis: {
      title: '🎾 Tennis', help: "Sichqoncha/barmoq bilan raketkani yurgizing. Har qaytarish — 1 ochko", min: 10,
      run(st, cv, end) {
        const s = { px: 180, bx: 180, by: 60, vx: 140, vy: 170, ai: 180, score: 0 };
        cv.addEventListener('pointermove', (e) => { s.px = pointerX(cv, e); });
        const keys = new Set();
        const kd = (e) => keys.add(e.key);
        const ku = (e) => keys.delete(e.key);
        window.addEventListener('keydown', kd);
        window.addEventListener('keyup', ku);
        gameLoop(st, cv, (g, dt) => {
          if (keys.has('ArrowLeft')) s.px -= 300 * dt;
          if (keys.has('ArrowRight')) s.px += 300 * dt;
          s.px = Math.max(30, Math.min(330, s.px));
          s.bx += s.vx * dt;
          s.by += s.vy * dt;
          s.ai += Math.sign(s.bx - s.ai) * Math.min(Math.abs(s.bx - s.ai), 170 * dt);
          if (s.bx < 6 || s.bx > 354) s.vx *= -1;
          if (s.by < 22 && s.vy < 0 && Math.abs(s.bx - s.ai) < 36) s.vy *= -1;
          if (s.by < 0) { s.vy = Math.abs(s.vy); }
          if (s.by > 234 && s.vy > 0 && Math.abs(s.bx - s.px) < 36) {
            s.vy = -Math.abs(s.vy) * 1.05;
            s.vx += (s.bx - s.px) * 4;
            s.score += 1;
            sound.right();
          }
          g.fillStyle = '#166534'; g.fillRect(0, 0, 360, 260);
          g.strokeStyle = '#fff'; g.strokeRect(4, 4, 352, 252); g.beginPath(); g.moveTo(0, 130); g.lineTo(360, 130); g.stroke();
          g.fillStyle = '#facc15'; g.fillRect(s.ai - 30, 10, 60, 8);
          g.fillStyle = '#f97316'; g.fillRect(s.px - 30, 240, 60, 8);
          g.fillStyle = '#fef08a'; g.beginPath(); g.arc(s.bx, s.by, 6, 0, 7); g.fill();
          g.fillStyle = '#fff'; g.font = 'bold 18px system-ui'; g.fillText(`${s.score}`, 10, 150);
          if (s.by > 262 || s.score >= 30) {
            window.removeEventListener('keydown', kd);
            window.removeEventListener('keyup', ku);
            st.done = true;
            end(s.score);
          }
        });
      },
    },
    bowling: {
      title: '🎳 Bouling', help: "Strelka o'rtaga kelganda bosing. 5 ta urinish", min: 8,
      run(st, cv, end) {
        const s = { t: 0, roll: 0, score: 0, last: '', anim: 0, pins: 0 };
        const shoot = () => {
          if (s.anim > 0 || s.roll >= 5) return;
          const aim = (Math.sin(s.t * 2.4) + 1) / 2;
          const acc = 1 - Math.abs(aim - 0.5) * 2;
          s.pins = Math.max(0, Math.min(10, Math.round(10 * acc ** 1.4 + (Math.random() - 0.5) * 2)));
          s.score += s.pins === 10 ? 15 : s.pins;
          s.last = s.pins === 10 ? 'STRIKE! 🎳 +15' : `${s.pins} ta kegl`;
          s.roll += 1;
          s.anim = 1.2;
          sound[s.pins >= 8 ? 'right' : 'door']();
        };
        cv.addEventListener('pointerdown', shoot);
        st.shoot = shoot;
        gameLoop(st, cv, (g, dt) => {
          s.t += dt;
          if (s.anim > 0) { s.anim -= dt; if (s.anim <= 0 && s.roll >= 5) { st.done = true; end(s.score); } }
          g.fillStyle = '#78350f'; g.fillRect(0, 0, 360, 260);
          g.fillStyle = '#d6a76b'; g.fillRect(120, 0, 120, 260);
          for (let i = 0; i < 10; i += 1) {
            const row = i < 4 ? 0 : i < 7 ? 1 : i < 9 ? 2 : 3;
            const k = [0, 4, 7, 9][row];
            const x = 180 + (i - k - (3 - row) / 2) * 22;
            const down = s.anim > 0 && i < s.pins;
            g.fillStyle = down ? '#a8a29e' : '#f8fafc';
            g.beginPath(); g.arc(x, 30 + row * 18, 7, 0, 7); g.fill();
          }
          const aim = (Math.sin(s.t * 2.4) + 1) / 2;
          g.fillStyle = '#1d4ed8'; g.beginPath(); g.arc(120 + aim * 120, 225, 12, 0, 7); g.fill();
          g.fillStyle = '#fff'; g.font = 'bold 16px system-ui';
          g.fillText(`Ochko: ${s.score} · ${s.roll}/5`, 8, 250); g.fillText(s.last, 8, 120);
        });
      },
      buttons: (st) => actionBtn('target', 'Otish!', () => st.shoot && st.shoot(), 'btn btn--primary btn--block'),
    },
    darts: {
      title: '🎯 Darts', help: "Nishon o'rtasiga kelganda bosing. 5 ta o'q", min: 6,
      run(st, cv, end) {
        const s = { t: 0, n: 0, score: 0, hits: [] };
        const shoot = () => {
          if (s.n >= 5) return;
          const x = 180 + Math.sin(s.t * 1.9) * 90;
          const y = 130 + Math.sin(s.t * 2.7) * 70;
          const d = Math.hypot(x - 180, y - 130);
          const p = d < 10 ? 50 : d < 30 ? 25 : d < 55 ? 10 : d < 85 ? 5 : 0;
          s.score += p;
          s.n += 1;
          s.hits.push([x, y, p]);
          sound[p >= 25 ? 'right' : 'door']();
          if (s.n >= 5) setTimeout(() => { st.done = true; end(s.score); }, 700);
        };
        cv.addEventListener('pointerdown', shoot);
        st.shoot = shoot;
        gameLoop(st, cv, (g, dt) => {
          s.t += dt;
          g.fillStyle = '#1e293b'; g.fillRect(0, 0, 360, 260);
          [[85, '#f8fafc'], [55, '#16a34a'], [30, '#dc2626'], [10, '#facc15']].forEach(([r, c]) => { g.fillStyle = c; g.beginPath(); g.arc(180, 130, r, 0, 7); g.fill(); });
          s.hits.forEach(([x, y]) => { g.fillStyle = '#0ea5e9'; g.beginPath(); g.arc(x, y, 4, 0, 7); g.fill(); });
          const x = 180 + Math.sin(s.t * 1.9) * 90;
          const y = 130 + Math.sin(s.t * 2.7) * 70;
          g.strokeStyle = '#f0abfc'; g.lineWidth = 2; g.beginPath(); g.moveTo(x - 10, y); g.lineTo(x + 10, y); g.moveTo(x, y - 10); g.lineTo(x, y + 10); g.stroke();
          g.fillStyle = '#fff'; g.font = 'bold 16px system-ui'; g.fillText(`Ochko: ${s.score} · ${s.n}/5`, 8, 22);
        });
      },
      buttons: (st) => actionBtn('target', 'Otish!', () => st.shoot && st.shoot(), 'btn btn--primary btn--block'),
    },
    rhythm: {
      title: '🎵 Ritm', help: "Notalar pastki chiziqqa yetganda D F J K (yoki ustunni bosing). 25 soniya", min: 15,
      run(st, cv, end) {
        const s = { t: 0, notes: [], next: 0.5, score: 0, miss: 0, flash: [0, 0, 0, 0] };
        const hit = (lane) => {
          const n = s.notes.find((q) => q.lane === lane && !q.done && Math.abs(q.y - 220) < 24);
          s.flash[lane] = 0.15;
          if (n) { n.done = true; s.score += 1; } else s.miss += 1;
        };
        const kd = (e) => { const i = ['d', 'f', 'j', 'k'].indexOf(e.key.toLowerCase()); if (i >= 0) { e.preventDefault(); hit(i); } };
        window.addEventListener('keydown', kd);
        cv.addEventListener('pointerdown', (e) => hit(Math.min(3, Math.floor(pointerX(cv, e) / 90))));
        gameLoop(st, cv, (g, dt) => {
          s.t += dt;
          if (s.t > s.next && s.t < 24) { s.notes.push({ lane: Math.floor(Math.random() * 4), y: -10 }); s.next = s.t + 0.35 + Math.random() * 0.4; }
          s.notes.forEach((n) => { n.y += 170 * dt; });
          s.notes = s.notes.filter((n) => n.y < 270 && !n.done);
          g.fillStyle = '#0f172a'; g.fillRect(0, 0, 360, 260);
          for (let i = 0; i < 4; i += 1) {
            g.fillStyle = s.flash[i] > 0 ? '#334155' : '#1e293b'; g.fillRect(i * 90 + 2, 0, 86, 260);
            s.flash[i] = Math.max(0, s.flash[i] - dt);
          }
          g.fillStyle = '#facc15'; g.fillRect(0, 218, 360, 4);
          s.notes.forEach((n) => { g.fillStyle = ['#f43f5e', '#22c55e', '#38bdf8', '#a855f7'][n.lane]; g.fillRect(n.lane * 90 + 15, n.y - 8, 60, 16); });
          g.fillStyle = '#fff'; g.font = 'bold 14px system-ui'; g.fillText(`🎵 ${s.score}   ⏱ ${Math.max(0, Math.ceil(25 - s.t))}`, 8, 20);
          ['D', 'F', 'J', 'K'].forEach((k, i) => g.fillText(k, i * 90 + 40, 248));
          if (s.t > 25) { window.removeEventListener('keydown', kd); st.done = true; end(s.score); }
        });
      },
    },
    memory: {
      title: '🃏 Xotira', help: 'Juft kartalarni toping. Kam xato — ko\'p ochko', min: 8,
      run(st, cv, end) {
        const faces = ['🍎', '🚗', '⚽', '🌙', '🎈', '🐱'];
        const cards = [...faces, ...faces].sort(() => Math.random() - 0.5).map((f) => ({ f, open: false, done: false }));
        const s = { sel: [], mistakes: 0, lock: 0 };
        cv.addEventListener('pointerdown', (e) => {
          if (s.lock > 0) return;
          const c = Math.floor(pointerX(cv, e) / 90);
          const r = Math.floor(pointerY(cv, e) / 87);
          const card = cards[r * 4 + c];
          if (!card || card.open || card.done) return;
          card.open = true;
          s.sel.push(card);
          if (s.sel.length === 2) {
            if (s.sel[0].f === s.sel[1].f) { s.sel.forEach((q) => { q.done = true; }); s.sel = []; sound.right(); } else { s.mistakes += 1; s.lock = 0.8; }
          }
          if (cards.every((q) => q.done)) setTimeout(() => { st.done = true; end(Math.max(1, 12 - s.mistakes)); }, 400);
        });
        gameLoop(st, cv, (g, dt) => {
          if (s.lock > 0) { s.lock -= dt; if (s.lock <= 0) { s.sel.forEach((q) => { q.open = false; }); s.sel = []; } }
          g.fillStyle = '#312e81'; g.fillRect(0, 0, 360, 260);
          cards.forEach((q, i) => {
            const x = (i % 4) * 90 + 6;
            const y = Math.floor(i / 4) * 87 + 6;
            g.fillStyle = q.done ? '#15803d' : q.open ? '#f8fafc' : '#6366f1';
            g.fillRect(x, y, 78, 75);
            if (q.open || q.done) { g.font = '36px system-ui'; g.fillText(q.f, x + 20, y + 50); }
          });
        });
      },
    },
    sub: {
      title: '🚢 Suv osti kemasi', help: "Kemani yuqori-pastga yurgizib marvaridlarni yig'ing, meduzalardan qoching. 25 soniya", min: 15,
      run(st, cv, end) {
        const s = { y: 130, t: 0, items: [], next: 0, score: 0, hurt: 0 };
        cv.addEventListener('pointermove', (e) => { s.y = pointerY(cv, e); });
        cv.addEventListener('pointerdown', (e) => { s.y = pointerY(cv, e); });
        const keys = new Set();
        const kd = (e) => keys.add(e.key);
        const ku = (e) => keys.delete(e.key);
        window.addEventListener('keydown', kd);
        window.addEventListener('keyup', ku);
        gameLoop(st, cv, (g, dt) => {
          s.t += dt;
          if (keys.has('ArrowUp')) s.y -= 200 * dt;
          if (keys.has('ArrowDown')) s.y += 200 * dt;
          s.y = Math.max(20, Math.min(240, s.y));
          if (s.t > s.next) { s.items.push({ x: 380, y: 20 + Math.random() * 220, bad: Math.random() < 0.3 }); s.next = s.t + 0.45; }
          s.items.forEach((it) => { it.x -= 150 * dt; });
          s.items = s.items.filter((it) => {
            if (it.x < -20) return false;
            if (Math.abs(it.x - 60) < 22 && Math.abs(it.y - s.y) < 20) {
              if (it.bad) { s.score = Math.max(0, s.score - 2); s.hurt = 0.4; sound.wrong(); } else { s.score += 1; sound.right(); }
              return false;
            }
            return true;
          });
          g.fillStyle = '#0c4a6e'; g.fillRect(0, 0, 360, 260);
          g.font = '22px system-ui';
          s.items.forEach((it) => g.fillText(it.bad ? '🪼' : '🦪', it.x - 11, it.y + 8));
          g.fillText('🚢', 44, s.y + 8);
          if (s.hurt > 0) { s.hurt -= dt; g.fillStyle = 'rgba(239,68,68,.3)'; g.fillRect(0, 0, 360, 260); }
          g.fillStyle = '#fff'; g.font = 'bold 14px system-ui'; g.fillText(`🦪 ${s.score}   ⏱ ${Math.max(0, Math.ceil(25 - s.t))}`, 8, 20);
          if (s.t > 25) { window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); st.done = true; end(s.score); }
        });
      },
    },
  };

  // ---- Stol o'yinlari ko'rinishi ----
  const PIECES = { K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞', P: '♟' };
  const TW_GAMES = {
    chess(body, st, t, over) {
      const board = el('div', 'chess');
      const flip = t.color === 'b';
      const targets = new Set(t.moves.filter((m) => m[0] === st.sel).map((m) => m[1]));
      for (let k = 0; k < 64; k += 1) {
        const i = flip ? 63 - k : k;
        const r = Math.floor(i / 8);
        const c = i % 8;
        const p = t.board[i];
        const b = el('button', `chess__sq ${(r + c) % 2 ? 'is-dark' : ''} ${st.sel === i ? 'is-sel' : ''} ${targets.has(i) ? 'is-target' : ''}`);
        b.type = 'button';
        if (p) {
          const s2 = el('span', p[0] === 'w' ? 'chess__w' : 'chess__b', PIECES[p[1]]);
          b.append(s2);
        }
        b.addEventListener('click', () => {
          if (over || !t.my_turn) return;
          if (targets.has(i)) {
            api('/api/game/table/move', { method: 'POST', body: { move: [st.sel, i] } }).then((d) => { st.sel = null; st.data = d.table; sound.door(); twRe(st); }).catch(said);
          } else if (p && p[0] === t.color) { st.sel = i; twRe(st); }
        });
        board.append(b);
      }
      body.append(board);
      if (t.check && !over) body.append(el('p', 'kitchen__bad', 'Shoh! ⚠️'));
      body.append(el('p', 'sheet-note', `Siz — ${t.color === 'w' ? 'oqlar' : 'qoralar'}. Rokirovka yo'q, piyoda oxirida farzin bo'ladi.`));
    },
    domino(body, st, t, over) {
      const tile = ([a, b]) => `[${a}|${b}]`;
      body.append(el('p', 'domino-chain', t.chain.length ? t.chain.map(tile).join('') : "Stol bo'sh — birinchi tosh"));
      body.append(el('p', 'sheet-note', `Raqibda: ${t.other_count} ta tosh · Bozorda: ${t.bone}`));
      const hand = el('div', 'kitchen__grid');
      t.hand.forEach((h, i) => {
        const opts = t.moves.filter((m) => m[0] === i);
        const b = el('button', `btn ${opts.length ? 'btn--primary' : 'btn--ghost'}`, tile(h));
        b.type = 'button';
        b.disabled = over || !opts.length;
        b.addEventListener('click', () => {
          const go = (m) => api('/api/game/table/move', { method: 'POST', body: { move: m } }).then((d) => { st.data = d.table; sound.door(); twRe(st); }).catch(said);
          if (opts.length === 1) go(opts[0]);
          else { st.pick = i; twRe(st); }
        });
        hand.append(b);
      });
      body.append(hand);
      if (st.pick !== undefined && st.pick !== null && !over) {
        const opts = t.moves.filter((m) => m[0] === st.pick);
        if (opts.length > 1) {
          body.append(el('div', 'kitchen__grid'));
          opts.forEach((m) => body.lastChild.append(sm('arrow-left', m[1] === 'L' ? '⬅️ Chapga' : "O'ngga ➡️", () => api('/api/game/table/move', { method: 'POST', body: { move: m } }).then((d) => { st.pick = null; st.data = d.table; twRe(st); }).catch(said))));
        }
      }
      if (!over && t.my_turn && !t.moves.length) {
        body.append(t.bone ? actionBtn('plus', 'Bozordan tosh olish', () => api('/api/game/table/move', { method: 'POST', body: { draw: true } }).then((d) => { st.data = d.table; twRe(st); }).catch(said), 'btn btn--primary btn--block')
          : actionBtn('arrow-left', "O'tkazib yuborish", () => api('/api/game/table/move', { method: 'POST', body: { pass: true } }).then((d) => { st.data = d.table; twRe(st); }).catch(said), 'btn btn--primary btn--block'));
      }
    },
    duel(body, st, t, over) {
      if (over) {
        body.append(el('p', 'sheet-note', `Natija: siz ${t.scores ? t.scores[t.me] : '?'} · raqib ${t.scores ? t.scores[t.other] : '?'}`));
        return;
      }
      if (t.answered) { body.append(el('p', 'sheet-note', `Javoblaringiz yuborildi. Raqib kutilmoqda… (${t.left} s)`)); return; }
      st.ans = st.ans || [];
      body.append(el('p', 'sheet-note', `⏱ ${t.left} s — tez va to'g'ri!`));
      t.qs.forEach((q, n) => {
        const bx = el('div', 'lic-q');
        bx.append(el('strong', '', `${n + 1}. ${q.question}`));
        const opts = el('div', 'lic-opts');
        q.options.forEach((o, i) => {
          const b = el('button', `btn ${st.ans[n] === i ? 'btn--primary' : 'btn--ghost'} btn--sm`, o);
          b.type = 'button';
          b.addEventListener('click', () => { st.ans[n] = i; twRe(st); });
          opts.append(b);
        });
        bx.append(opts);
        body.append(bx);
      });
      body.append(actionBtn('check', 'Yuborish', () => api('/api/game/table/move', { method: 'POST', body: { answers: t.qs.map((_, i) => (st.ans[i] ?? -1)) } }).then((d) => { st.data = d.table; twRe(st); }).catch(said), 'btn btn--primary btn--block'));
    },
    kurash(body, st, t, over) {
      if (over) { body.append(el('p', 'sheet-note', `Siz: ${t.mine} · Raqib: ${t.theirs}`)); return; }
      if (t.start_in > 0) { body.append(el('p', 'kitchen__dish', `⏳ ${Math.ceil(t.start_in)}…`)); return; }
      body.append(el('p', 'kitchen__dish', `🤼 Siz ${t.mine} — ${t.theirs} raqib · ${Math.ceil(t.left)} s`));
      body.append(actionBtn('star', 'BOS! 💪', () => {
        st.taps = (st.taps || 0) + 1;
        if (!st.tapTimer) {
          st.tapTimer = setTimeout(() => {
            const n = Math.min(8, st.taps);
            st.taps = 0;
            st.tapTimer = null;
            api('/api/game/table/move', { method: 'POST', body: { taps: n } }).then((d) => { st.data = d.table; twRe(st); }).catch(() => {});
          }, 380);
        }
      }, 'btn btn--primary btn--block tw-big'));
    },
  };

  // ---- Sertifikat (rasm) ----
  function certCanvas(c) {
    const cv = el('canvas', 'tw-canvas');
    cv.width = 800;
    cv.height = 560;
    const g = cv.getContext('2d');
    g.fillStyle = '#fffbeb'; g.fillRect(0, 0, 800, 560);
    g.strokeStyle = '#a16207'; g.lineWidth = 14; g.strokeRect(20, 20, 760, 520);
    g.lineWidth = 3; g.strokeRect(42, 42, 716, 476);
    g.fillStyle = '#78350f'; g.textAlign = 'center';
    g.font = '800 54px Georgia, serif'; g.fillText('SERTIFIKAT', 400, 130);
    g.font = '24px Georgia, serif'; g.fillText('Ushbu sertifikat', 400, 200);
    g.font = '800 44px Georgia, serif'; g.fillStyle = '#1e3a8a'; g.fillText(c.name, 400, 265);
    g.fillStyle = '#78350f'; g.font = '24px Georgia, serif';
    g.fillText(`«${c.title}» kitobini o'qib, testdan muvaffaqiyatli`, 400, 320);
    g.fillText("o'tgani uchun Mahalla kutubxonasi tomonidan berildi", 400, 355);
    g.font = '20px Georgia, serif'; g.fillText(`📅 ${c.date}        📚 Mahalla kutubxonasi`, 400, 440);
    g.font = '60px serif'; g.fillText('🏅', 400, 510);
    const wrap = el('div', '');
    const a = el('a', 'btn btn--primary btn--block', '⬇️ Sertifikatni yuklab olish');
    a.href = cv.toDataURL('image/png');
    a.download = `sertifikat-${c.title}.png`;
    wrap.append(cv, a);
    return wrap;
  }

  function openTownHub() {
    openTw('hub');
  }

  // ---------------- Kun va tun ----------------
  // Bir sutka — 20 daqiqa. Vaqt soatga bog'liq, shuning uchun hamma bir xil kun/tunni ko'radi.
  const DAY_MS = 20 * 60 * 1000;
  const DAY_SKY = new THREE.Color('#9fd3f7');
  const NIGHT_SKY = new THREE.Color('#0a1330');
  const DUSK_SKY = new THREE.Color('#f4a37a');
  const SUN_DAY = new THREE.Color('#fff4d6');
  const SUN_DUSK = new THREE.Color('#ffb072');
  let lampMat = null;
  let lampPoolMat = null;
  let dayCheckAt = -1e9;
  let isNight = null;

  function dayLight() {
    const t = (Date.now() % DAY_MS) / DAY_MS;
    return clamp(Math.sin(t * Math.PI * 2) * 2 + 0.45, 0, 1); // 1 — kunduz, 0 — tun
  }

  function updateDayNight(now) {
    if (now - dayCheckAt < 250) return;
    dayCheckAt = now;
    const day = dayLight();
    const dusk = Math.max(0, 1 - Math.abs(day - 0.5) * 2.2);
    SKY.copy(NIGHT_SKY).lerp(DAY_SKY, day).lerp(DUSK_SKY, dusk * 0.45);
    scene.fog.color.copy(SKY);
    hemi.intensity = 0.22 + 0.93 * day;
    sun.intensity = 0.08 + 2.22 * day;
    sun.color.copy(SUN_DAY).lerp(SUN_DUSK, dusk);
    // Ob-havo: bulutli — osmon kulrang, quyosh xira
    const cloud = weatherCloud();
    if (cloud > 0) {
      SKY.lerp(day > 0.4 ? STORM_SKY : NIGHT_STORM, cloud);
      scene.fog.color.copy(SKY);
      hemi.intensity *= 1 - cloud * 0.3;
      sun.intensity *= 1 - cloud * 0.65;
    }
    nightGlow = (1 - day) * 1.15;
    litMaterials.forEach((m) => { m.emissiveIntensity = nightGlow; });
    if (lampMat) lampMat.emissiveIntensity = 0.15 + (1 - day) * 2.6;
    if (lampPoolMat) lampPoolMat.opacity = (1 - day) * 0.3;
    const night = day < 0.35;
    if (night !== isNight) {
      if (isNight !== null) toast(night ? "Tun tushdi — ko'cha chiroqlari va derazalar yondi" : 'Tong otdi!');
      isNight = night;
    }
  }

  // Ko'cha chiroqlari: yo'l chetida, kechasi yonadi (yorug'lik dog'i — arzon "soxta" nur)
  function buildLamps() {
    const R = world.road;
    const spots = [];
    const nearRoad = (v, list) => list.some((r) => v > r - 50 && v < r + R + 50);
    world.h_roads.forEach((y) => {
      for (let x = 170; x < world.w - 40; x += 330) {
        if (!nearRoad(x, world.v_roads)) spots.push([x, y - 7]);
        if (!nearRoad(x + 165, world.v_roads)) spots.push([x + 165, y + R + 7]);
      }
    });
    world.v_roads.forEach((x) => {
      for (let y = 170; y < world.h - 40; y += 330) {
        if (!nearRoad(y, world.h_roads)) spots.push([x - 7, y]);
        if (!nearRoad(y + 165, world.h_roads)) spots.push([x + R + 7, y + 165]);
      }
    });
    const blockedAreas = [...world.plots, world.shop, world.pond];
    const list = spots.filter(([x, y]) => x > 20 && y > 20 && x < world.w - 20 && y < world.h - 20
      && !blockedAreas.some((a) => inside(x, y, a, 6)));
    const poleGeo = new THREE.CylinderGeometry(1.4, 2, 52, 6);
    poleGeo.translate(0, 26, 0);
    const headGeo = new THREE.SphereGeometry(4.5, 10, 8);
    headGeo.translate(0, 54, 0);
    const poolGeo = new THREE.CircleGeometry(62, 20);
    poolGeo.rotateX(-Math.PI / 2);
    lampMat = new THREE.MeshStandardMaterial({ color: '#fff7d6', emissive: '#ffd27a', emissiveIntensity: 0.2 });
    lampPoolMat = new THREE.MeshBasicMaterial({
      color: '#ffcf70', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const poles = new THREE.InstancedMesh(poleGeo, mat('#4b5563', { metalness: 0.4, roughness: 0.5 }), list.length);
    const heads = new THREE.InstancedMesh(headGeo, lampMat, list.length);
    const pools = new THREE.InstancedMesh(poolGeo, lampPoolMat, list.length);
    const m4 = new THREE.Matrix4();
    list.forEach(([x, y], i) => {
      m4.makeTranslation(x, 0, y);
      poles.setMatrixAt(i, m4);
      heads.setMatrixAt(i, m4);
      m4.makeTranslation(x, 1, y);
      pools.setMatrixAt(i, m4);
    });
    poles.castShadow = true;
    pools.renderOrder = 1;
    scene.add(poles, heads, pools);
  }

  // ---------------- Skameyka: o'tirish ----------------
  function nearestBench() {
    let best = null;
    world.benches.forEach((b) => {
      const d = Math.hypot(b.x - me.x, b.y - me.y);
      if (!best || d < best.d) best = { b, d };
    });
    return best;
  }

  function sitDown(b) {
    if (me.car || me.seat) return;
    me.sit = b;
    me.x = b.x;
    me.y = b.y;
    me.dir = b.dir;
    me.h = 0;
    me.vh = 0;
    toast("Skameykaga o'tirdingiz. Turish — yurish tugmalari yoki F");
  }

  function standUp() {
    const b = me.sit;
    me.sit = null;
    me.pose = null;
    if (b) {
      me.x = b.x + Math.cos(b.dir) * 26;
      me.y = b.y + Math.sin(b.dir) * 26;
    }
  }

  // ---------------- Futbol maydoni va to'p ----------------
  let ballView = null;
  let scoreView = null;
  const ball = { x: 0, y: 0, vx: 0, vy: 0, score: [0, 0], goal: -1, kickAt: 0, localAt: 0 };

  function ballTexture() {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#111827';
    [[16, 16], [48, 16], [32, 40], [8, 52], [56, 52]].forEach(([x, y]) => {
      g.beginPath();
      g.arc(x, y, 7, 0, Math.PI * 2);
      g.fill();
    });
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  function setScoreboard(a, b) {
    const F = world.field;
    if (scoreView) {
      scene.remove(scoreView);
      scoreView.material.map.dispose();
      scoreView.material.dispose();
    }
    scoreView = makeLabel(`FUTBOL  ·  ${a} : ${b}`, 'rgba(22,101,52,.92)', null, true);
    scoreView.position.set(F.x + F.w / 2, 70, F.y - 30);
    scoreView.scale.multiplyScalar(1.3);
    scene.add(scoreView);
  }

  function buildField() {
    const F = world.field;
    const cx = F.x + F.w / 2;
    const cz = F.y + F.h / 2;
    const stripes = tileTexture(64, (g, n) => {
      g.fillStyle = '#3f9b3a';
      g.fillRect(0, 0, n, n);
      g.fillStyle = '#4cae45';
      g.fillRect(0, 0, n / 2, n);
    }, F.w / 60, 1);
    scene.add(flat(F.w + 50, F.h + 50, new THREE.MeshStandardMaterial({ map: stripes, roughness: 1 }), cx, cz, 0.3));
    const line = mat('#f8fafc', { roughness: 1 });
    const L = (w, d, x, z) => scene.add(flat(w, d, line, x, z, 0.5));
    L(F.w, 3, cx, F.y);
    L(F.w, 3, cx, F.y + F.h);
    L(3, F.h, F.x, cz);
    L(3, F.h, F.x + F.w, cz);
    L(3, F.h, cx, cz);
    const ring = new THREE.Mesh(new THREE.RingGeometry(46, 49.5, 40), line);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(cx, 0.5, cz);
    scene.add(ring);
    [F.x, F.x + F.w].forEach((gx, i) => {
      const s = i ? -1 : 1;
      L(3, 170, gx + s * 70, cz);
      L(70, 3, gx + (s * 70) / 2, cz - 85);
      L(70, 3, gx + (s * 70) / 2, cz + 85);
    });
    // Darvozalar
    const gw = world.goal_w;
    const white = mat('#ffffff', { roughness: 0.4 });
    const net = new THREE.MeshStandardMaterial({ color: '#e5e7eb', transparent: true, opacity: 0.3, side: THREE.DoubleSide });
    [F.x, F.x + F.w].forEach((gx, i) => {
      const s = i ? 1 : -1;
      scene.add(cyl(2, 2, 40, white, gx, 20, cz - gw / 2, 8), cyl(2, 2, 40, white, gx, 20, cz + gw / 2, 8));
      const bar = cyl(2, 2, gw, white, gx, 40, cz, 8);
      bar.rotation.x = Math.PI / 2;
      scene.add(bar, mesh(new THREE.BoxGeometry(28, 40, gw), net, gx + s * 14, 20, cz, false));
    });
    ballView = mesh(new THREE.IcosahedronGeometry(9, 1),
      new THREE.MeshStandardMaterial({ map: ballTexture(), roughness: 0.5, flatShading: true }), cx, 9, cz);
    scene.add(ballView);
    ball.x = cx;
    ball.y = cz;
    setScoreboard(0, 0);
  }

  function stepBall(dt) {
    if (!ballView) return;
    const F = world.field;
    if (ball.vx || ball.vy) {
      ball.x += ball.vx * dt;
      ball.y += ball.vy * dt;
      const k = Math.exp(-1.1 * dt);
      ball.vx *= k;
      ball.vy *= k;
      if (ball.x < F.x || ball.x > F.x + F.w) {
        if (Math.abs(ball.y - (F.y + F.h / 2)) < world.goal_w / 2) {
          ball.x = clamp(ball.x, F.x - 22, F.x + F.w + 22); // darvozaga kirdi — server golni hisoblaydi
          ball.vx *= 0.3;
        } else {
          ball.x = clamp(ball.x, F.x, F.x + F.w);
          ball.vx = -ball.vx * 0.7;
        }
      }
      if (ball.y < F.y || ball.y > F.y + F.h) {
        ball.y = clamp(ball.y, F.y, F.y + F.h);
        ball.vy = -ball.vy * 0.7;
      }
      if (Math.hypot(ball.vx, ball.vy) < 4) {
        ball.vx = 0;
        ball.vy = 0;
      }
      ballView.rotation.x += (ball.vy * dt) / 9;
      ballView.rotation.z -= (ball.vx * dt) / 9;
    }
    ballView.position.set(ball.x, 9, ball.y);
    // O'yinchi yurib to'pga tegsa — tepadi
    if (me.seat || me.sit || room.on || performance.now() - ball.kickAt < 400) return;
    const reach = me.car ? 36 : 24;
    if (me.moving && me.h < 20 && Math.hypot(ball.x - me.x, ball.y - me.y) < reach) kickBall();
  }

  async function kickBall() {
    ball.kickAt = performance.now();
    let dx = ball.x - me.x;
    let dy = ball.y - me.y;
    const len0 = Math.hypot(dx, dy) || 1;
    dx = dx / len0 + Math.cos(me.dir) * 0.7;
    dy = dy / len0 + Math.sin(me.dir) * 0.7;
    const len = Math.hypot(dx, dy) || 1;
    const speed = me.car ? 820 : 560;
    ball.vx = (dx / len) * speed;
    ball.vy = (dy / len) * speed;
    ball.localAt = performance.now();
    sound.door();
    try {
      const data = await api('/api/game/ball/kick', { method: 'POST', body: { dx, dy } });
      ball.localAt = 0;
      setBall(data.ball);
    } catch (err) {
      handleAuthError(err);
    }
  }

  function setBall(b) {
    if (!b || !ballView) return;
    if (ball.goal < 0) ball.goal = b.goal;
    if (b.goal > ball.goal) {
      ball.goal = b.goal;
      ball.localAt = 0;
      ball.x = b.x;
      ball.y = b.y;
      sound.ding();
      const side = b.goal_side === 'left' ? 'chap' : "o'ng";
      toast(`GOL! ${b.goal_by ? `${b.goal_by} urdi (${side} jamoa). ` : ''}Hisob ${b.score[0]} : ${b.score[1]}`, 'success');
    }
    if (b.score[0] !== ball.score[0] || b.score[1] !== ball.score[1]) {
      ball.score = b.score;
      setScoreboard(b.score[0], b.score[1]);
    }
    // O'zimiz tepgan zahoti kelgan eski javob to'pni orqaga tortmasin
    if (ball.localAt && performance.now() - ball.localAt < 400) return;
    if (Math.hypot(b.x - ball.x, b.y - ball.y) > 80) {
      ball.x = b.x;
      ball.y = b.y;
    } else {
      ball.x += (b.x - ball.x) * 0.5;
      ball.y += (b.y - ball.y) * 0.5;
    }
    ball.vx = b.vx;
    ball.vy = b.vy;
  }

  // ---------------- Poyga ----------------
  let race = null;          // {id, opp, bet, fx, fy, startAt, result}
  let raceInvite = null;    // {from, name, bet, until}
  let raceCardSig = '';
  const raceFrozen = () => Boolean(race && !race.result && performance.now() < race.startAt);

  function setRaceInvite(inv) {
    raceInvite = inv ? { ...inv, until: performance.now() + inv.left * 1000 } : null;
  }

  function setRace(r) {
    if (!r) {
      race = null;
      return;
    }
    if (!race || race.id !== r.id) {
      race = { ...r, startAt: performance.now() + r.start_in * 1000, result: null };
      if (guide) setGuide();
      if (r.spot) {
        me.x = r.spot[0];
        me.y = r.spot[1];
        me.dir = r.spot[2];
        cam.yaw = -Math.PI / 2 - me.dir;
        camReady = false;
      }
      sound.ding();
      toast(`Poyga! ${r.opp} bilan o'rmondagi trassada — ${r.total} aylana. Birinchi tugatgan yutadi!`, 'success');
    }
    race.laps = r.laps;
    race.opp_laps = r.opp_laps;
    if (r.result && !race.result) {
      race.result = r.result;
      race.shownAt = performance.now();
      if (r.result === 'me') {
        sound.cash();
        toast(`G'alaba! Siz birinchi keldingiz${r.bet ? ` va ${formatNumber(r.bet * 2)} so'm yutdingiz` : ''}!`, 'success');
      } else if (r.result === 'opp') {
        toast(`${r.opp} birinchi yetib keldi. Keyingi safar omad!`, 'warn');
      } else {
        toast("Hech kim marraga yetmadi — pullar qaytarildi");
      }
    }
  }

  async function answerInvite(accept) {
    const inv = raceInvite;
    raceInvite = null;
    raceCardSig = '';
    localVersion += 1; // shu paytgacha yuborilgan sinxron javoblari taklifni qaytarmasin
    if (!inv) return;
    try {
      if (!accept) {
        await api('/api/game/race/decline', { method: 'POST' });
        return;
      }
      const data = await api('/api/game/race/accept', { method: 'POST' });
      localVersion += 1;
      setEconomy(data.economy);
      setRace(data.race);
    } catch (err) {
      if (!handleAuthError(err)) toast(err.message, 'warn');
    }
  }

  function updateRaceCard() {
    const card = $('race-card');
    const now = performance.now();
    let sig = '';
    let title = '';
    let sub = '';
    let buttons = false;
    if (raceInvite && now > raceInvite.until) raceInvite = null;
    if (race) {
      if (race.result) {
        title = race.result === 'me' ? "G'alaba!" : (race.result === 'opp' ? `${race.opp} yutdi` : 'Durang');
        sub = race.result === 'me' && race.bet ? `+${formatNumber(race.bet * 2)} so'm` : 'Poyga tugadi';
      } else if (now < race.startAt) {
        title = `${Math.ceil((race.startAt - now) / 1000)}…`;
        sub = `Poyga: ${race.opp} bilan · tikilgan ${formatNumber(race.bet)} so'm`;
      } else {
        title = `Aylana ${clamp(race.laps + 1, 1, race.total)} / ${race.total}`;
        sub = `${race.opp}: ${Math.max(0, race.opp_laps)} / ${race.total}${race.bet ? ` · yutuq ${formatNumber(race.bet * 2)} so'm` : ''}`;
      }
    } else if (raceInvite) {
      title = `${raceInvite.name} sizni poygaga chaqiryapti`;
      sub = `Tikish: ${formatNumber(raceInvite.bet)} so'm · ${Math.max(0, Math.ceil((raceInvite.until - now) / 1000))} s`;
      buttons = true;
    }
    const quit = Boolean(race && !race.result);
    sig = `${title}|${sub}|${buttons}|${quit}`;
    if (sig === raceCardSig) return;
    raceCardSig = sig;
    card.hidden = !title;
    if (!title) return;
    $('race-title').textContent = title;
    $('race-sub').textContent = sub;
    $('race-actions').hidden = !buttons;
    $('race-quit').hidden = !quit;
  }

  // ---------------- Menyu: bank, reyting, klan, ko'rinish ----------------
  function amountInput(st, placeholder = 'masalan 10 000') {
    const input = el('input', 'input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.placeholder = placeholder;
    input.setAttribute('aria-label', "Summa (so'm)");
    input.value = st.draft || '';
    input.addEventListener('input', () => { st.draft = input.value; });
    return input;
  }
  const parseAmount = (v) => Number(String(v).replace(/\D/g, ''));

  function amountChips(input, st, values = [1000, 10000, 100000, 1000000]) {
    const chips = el('div', 'chips');
    values.forEach((v) => {
      const c = el('button', 'chip', formatNumber(v));
      c.type = 'button';
      c.addEventListener('click', () => { input.value = formatNumber(v); st.draft = input.value; input.focus(); });
      chips.append(c);
    });
    return chips;
  }

  function actionBtn(iconName, text, onClick, cls = 'btn btn--primary') {
    const b = el('button', cls);
    b.type = 'button';
    b.append(icon(iconName), el('span', '', text));
    b.addEventListener('click', onClick);
    return b;
  }

  function backLink(text, onClick) {
    const back = el('button', 'link-btn');
    back.type = 'button';
    back.append(icon('arrow-left'), el('span', '', text));
    back.addEventListener('click', onClick);
    return back;
  }

  async function loadInto(st, url, apply) {
    try {
      const data = await api(url);
      if (sheetState !== st) return;
      apply(data);
      st.v = (st.v || 0) + 1;
      renderSheet();
    } catch (err) {
      if (!handleAuthError(err)) toast(err.message, 'warn');
    }
  }

  function renderHubSheet(body) {
    setHead('menu', 'Menyu', 'Bank, reyting, klan va boshqalar');
    const grid = el('div', 'hub');
    const tile = (ic, title, sub, fn) => {
      const b = el('button', 'hub__tile');
      b.type = 'button';
      const i = el('span', 'hub__icon');
      i.append(icon(ic));
      b.append(i, el('strong', '', title), el('small', '', sub));
      b.addEventListener('click', fn);
      grid.append(b);
    };
    tile('sparkles', 'Yangi shahar ✨', "Joylar, o'yinlar, do'stlar, dars, transport", openTownHub);
    tile('coins', 'Bank', 'Omonat va kredit', openBank);
    tile('message', 'Pochta qutisi', "Xat va sovg'a 📮", openMail);
    tile('coins', 'Sarmoya', "Biznesga pul tiking 💼", openInvest);
    tile('home', 'Ijara haqi', "Uylaringizdan kunlik pul 🏠", claimRent);
    tile('store', 'Bozor rastasi', "Narsalarni sotish va olish 🛒", openMarket);
    tile('trophy', 'Futbol kubogi', "Klanlar haftalik gollari ⚽", () => openList('⚽ Klanlar futbol kubogi', '/api/game/fcup', (t) => `[${t.tag}] ${t.name} — ${t.goals} gol`));
    tile('target', 'Bayroqni olish', "Bayroqni uyingizga olib boring 🚩", () => { if (city.flag) { setGuide(city.flag.x, city.flag.y, 'Bayroq'); closeSheet(); } else toast('Yangi bayroq tez orada chiqadi'); });
    tile('map-pin', 'Labirint', "Eng tez chiqing 🌿", () => { const m = world.maze.start; setGuide(m.x, m.y, 'Labirint'); closeSheet(); });
    tile('trophy', 'Labirint rekordlari', "Haftalik eng tezlar", () => openList('🌿 Labirint rekordlari', '/api/game/records/maze', (t) => `${t.name} — ${t.best} s`));
    tile('car', 'Velo-marafon', "Velosiped/skeyt poygasi 🚲", () => { const q = world.cpraces.bike.points[0]; setGuide(q.x, q.y, 'Velo-marafon'); closeSheet(); });
    tile('navigation', 'Qayiq poygasi', "Portda, qayiqda ⛵", () => { const q = world.cpraces.boat.points[0]; setGuide(q.x, q.y, 'Qayiq poygasi'); closeSheet(); });
    tile('map-pin', 'Tramvay', "1900-ko'chada 🚋", () => { setGuide(800, 1880, 'Tramvay bekati'); closeSheet(); });
    tile('sparkles', 'Qor jangi', "Q — qor otish (qishda) ❄️", () => openList('❄️ Bugungi qor jangi', '/api/game/snowball', (t) => `${t.name} — ${t.hits} ta`));
    tile('trophy', 'Boylar reytingi', "Eng boy 10 o'yinchi", openTop);
    tile('users', 'Klanlar', 'Jamoa, xazina, bayroq', openClans);
    tile('user', "Ko'rinishim", 'Soch, kiyim, shapka', openLooks);
    tile('home', 'Uyimga kirish', 'Mebel sotib olish', () => {
      const built = economy.plots.filter((p) => p.kind);
      if (!built.length) toast('Avval bino quring', 'warn');
      else if (built.length === 1) enterRoom(built[0].plot);
      else {
        openSheet({ kind: 'mine' });
        toast("Binoni oching va «Ichkariga kirish»ni bosing");
      }
    });
    tile('car', 'Poyga', "Do'stni poygaga chaqirish", openPeople);
    tile('target', 'Futbol', "Bog'dagi maydonga yo'l", () => {
      const F = world.field;
      setGuide(F.x + F.w / 2, F.y - 80, 'Futbol maydoni');
      closeSheet();
    });
    tile('sparkles', 'Sovg\'a', "Mashina yoki uy sovg'a qilish", openPeople);
    tile('star', 'Kod chellenji', "HTML/CSS topshiriq — katta pul", openChallenge);
    tile('check', 'Kunlik vazifalar', 'Har kuni 3 ta vazifa + bonus', openDaily);
    tile('rotate', "Omad g'ildiragi", 'Kuniga 1 marta bepul', openSpin);
    tile('hammer', 'Garaj', "Bo'yash, tezlik, neon", openGarage);
    tile('users', 'Avtobus ishi', "Bekatlarda yo'lovchi tashish", () => {
      if (carInfo() && carInfo().style === 'bus') {
        closeSheet();
        if (!busJob) toggleBus();
        return;
      }
      toast("Avtosalondan Avtobus oling, unga o'tiring va tepadagi «AVTOBUS» tugmasini bosing", 'warn');
    });
    tile('plane', 'Aeroport', 'Samolyotda reysga uchish', () => {
      const g = world.airport.gate;
      setGuide(g.x, g.y, 'Aeroport');
      closeSheet();
      toast("Aeroport — sharqdagi o'rmonda. Samolyotda keling va terminal oldida F ni bosing");
    });
    tile('message', 'Telefon', "Do'stlar va xabarlar", () => openPhone());
    tile('home', 'Uy hayvoni', "It, mushuk yoki to'tiqush", openPets);
    tile('hammer', 'Qurilish ishi', 'Binolarni qurib berib pul ishlash', () => startJob('build'));
    tile('users', "Hayvonot bog'i", "Sher, fil, jirafa…", () => { setGuide(1980, -60, "Hayvonot bog'i"); closeSheet(); toast("Hayvonot bog'i — shimoldagi o'rmonda (1940-ko'cha oxiri)"); });
    tile('navigation', 'Port va qayiq', 'Dengizda suzish', () => { setGuide(world.port.pier.x, world.port.pier.y, 'Port'); closeSheet(); toast("Port — janubi-sharqda (3420-ko'cha oxiri)"); });
    tile('megaphone', 'Konsert sahnasi', "Qo'shiq ayting — qarsak = pul", () => { const sp = world.places.stage.spot; setGuide(sp.x, sp.y, 'Sahna'); closeSheet(); });
    tile('vote', 'Mahalla raisi saylovi', "Ovoz bering yoki nomzod bo'ling 👑", openElection);
    tile('car', 'Haydovchilik testi', "Tez mashinalar uchun guvohnoma 🪪", openLicense);
    tile('home', 'Ferma', "Ekin eking, hosil yig'ib soting 🌾", () => openFarm(null));
    tile('coffee', 'Oshxona', "Kafengizda taom tayyorlang 🍳", openKitchen);
    tile('trophy', 'Avtopoyga kubogi', "Haftalik chempionat 🏆", openCup);
    tile('target', "O'rgimchak odam", "Yashirin o'rgimchakni toping 🕷️", openSpider);
    tile('navigation', 'Dron', "Shahar tepadan va surat 📸", openDrone);
    tile('plane', 'Kosmodrom', "Oyga sayohat 🚀", () => { setGuide(world.rocket.x, world.rocket.y, 'Kosmodrom'); closeSheet(); toast("Kosmodrom — aeroportning janubida. Raketa yonida F bosing"); });
    tile('map-pin', "Daryo va ko'prik", "Ko'prikdan baliq tuting 🎣", () => { const b = world.river.bridge; setGuide(b.x + b.w / 2, b.y, "Ko'prik"); closeSheet(); toast("Daryo — shaharning janubi-g'arbida, pastki ko'cha ortida"); });
    tile('trophy', 'Haftalik turnir', "Hafta g'oliblari mukofot oladi", openTournament);
    tile('map-pin', 'Pochtachi', '3 ta posilka yetkazish', () => startJob('post'));
    tile('coffee', 'Pitsa yetkazish', 'Issiqligida yetkazsangiz — choychaqa', () => startJob('pizza'));
    tile('coins', 'Aksiya birjasi', 'Arzon oling, qimmat soting', openStocks);
    tile('users', 'Yashirinmachoq', "Boshlang — boshqalar qo'shiladi", () => startMg('hide'));
    tile('footprints', 'Quvlashmachoq', 'Quvlovchidan qoching!', () => startMg('tag'));
    const go = (x, y, label, msg) => () => { setGuide(x, y, label); closeSheet(); if (msg) toast(msg); };
    const P = world.places;
    tile('target', 'Baliq ovlash', "Ko'l qirg'og'ida F", go(world.pond.x + world.pond.w / 2, world.pond.y - 30, "Ko'l", "Ko'l qirg'og'iga piyoda boring va F ni bosing"));
    tile('navigation', 'Metro', '4 ta bekat, 500 so\'m', () => { const n = nearestMetro(); go(n.m.x, n.m.y, 'Metro')(); });
    tile('star', 'Kinoteatr', 'Multfilm — 1 000 so\'m', go(P.cinema.door.x, P.cinema.door.y, 'Kinoteatr'));
    tile('target', 'Basketbol', "Savatga tushirsangiz +500", go(P.court.spot.x, P.court.spot.y, 'Basketbol'));
    tile('car', 'Avtoyuvish', "Qor-yomg'irdan keyin", go(P.wash.door.x, P.wash.door.y, 'Avtoyuvish'));
    tile('users', 'Akvapark', 'Suv tepaliklari, basseyn', go(-150, 1180, 'Akvapark', "Akvapark — g'arbdagi o'rmonda (1140-ko'cha davomi)"));
    tile('plane', 'Parashyut', 'Samolyotdan sakrash (P)', () => toast("Samolyotda 200 dan baland uching va P ni bosing. Nishon — futbol maydoni o'rtasida"));
    tile('sparkles', "Velosiped / skeytbord", 'Avtosalonda arzon', () => toast("Avtosalonda Velosiped (2 000) va Skeytbord (1 000) sotiladi"));
    if (IS_OWNER) tile('megaphone', 'Mahalla bayrami', "Hammani yig'ib sovg'a berish", openFestAdmin);
    tile('book', 'Uy vazifasi bonusi', "Har ball uchun +20 000 so'm", () => {
      toast("Panelda uy vazifasidan ijobiy ball olsangiz, har bir ball uchun o'yinda +20 000 so'm tushadi (5 ball = 100 000)");
    });
    body.append(grid, el('p', 'sheet-note',
      `Bir sutka — 20 daqiqa: kechasi ko'cha chiroqlari va derazalar yonadi. Hozir — ${isNight ? 'tun' : 'kunduz'}, `
      + `${WEATHER[weather.kind].name.toLowerCase()} (${weatherLeftText()}).`));
  }

  // --- Bank ---
  function openBank() {
    const st = { kind: 'bank', data: null, draft: '', v: 0 };
    openSheet(st);
    loadInto(st, '/api/game/bank', (d) => { st.data = d.bank; setEconomy(d.economy); });
  }

  function hoursText(sec) {
    if (sec == null) return '';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return h ? `${h} soat ${m} daqiqa` : `${m} daqiqa`;
  }

  function renderBankSheet(body, st) {
    const d = st.data;
    setHead('coins', 'Bank', d ? `Omonat soatiga +${d.bank_rate * 100}% o'sadi` : 'Yuklanmoqda…');
    if (!d) return;
    const stats = el('div', 'bank-stats');
    const stat = (label, value, cls = '') => {
      const c = el('div', `bank-stat ${cls}`);
      c.append(el('small', '', label), el('strong', '', `${formatNumber(value)} so'm`));
      stats.append(c);
    };
    stat('Hamyonda', Math.floor(money()));
    stat('Bankda', d.bank, 'bank-stat--good');
    stat('Qarz', d.loan, d.loan ? 'bank-stat--bad' : '');
    const box2 = el('div', 'sale');
    const input = amountInput(st);
    box2.append(el('strong', 'sale__title', 'Summa'), input, amountChips(input, st));
    const actions = el('div', 'bank-actions');
    const go = (action, done) => async () => {
      const amount = parseAmount(input.value);
      if (!amount) {
        toast('Summani yozing', 'warn');
        input.focus();
        return;
      }
      try {
        const res = await api('/api/game/bank', { method: 'POST', body: { action, amount } });
        localVersion += 1;
        st.data = res.bank;
        st.draft = '';
        st.v += 1;
        setEconomy(res.economy);
        sound.cash();
        toast(done(res.paid || amount), 'success');
        renderSheet();
      } catch (err) {
        if (!handleAuthError(err)) toast(err.message, 'warn');
      }
    };
    actions.append(
      actionBtn('download', 'Bankka qo\'yish', go('deposit', (a) => `${formatNumber(a)} so'm bankka qo'yildi`)),
      actionBtn('upload', 'Bankdan olish', go('withdraw', (a) => `${formatNumber(a)} so'm bankdan olindi`), 'btn btn--ghost'),
      actionBtn('plus', 'Kredit olish', go('borrow', (a) => `${formatNumber(a)} so'm kredit oldingiz`), 'btn btn--ghost'),
      actionBtn('check', "Qarzni to'lash", go('repay', (a) => `${formatNumber(a)} so'm qarz to'landi`), 'btn btn--ghost'),
    );
    box2.append(actions);
    body.append(stats, box2);
    if (d.loan) {
      body.append(el('p', 'sheet-note sheet-note--warn',
        d.loan_left > 0
          ? `Qarzni ${hoursText(d.loan_left)} ichida qaytaring, aks holda puldan o'zi yechiladi.`
          : "Kredit muddati o'tdi — qarz pulingizdan o'zi yechilyapti."));
    }
    body.append(el('p', 'sheet-note',
      `Omonat har soatda +${d.bank_rate * 100}% o'sadi. Kredit — eng ko'pi ${formatNumber(d.limit)} so'm `
      + `(binolaringiz qancha ko'p daromad keltirsa, shuncha ko'p). Qarz har soatda +${d.loan_rate * 100}% o'sadi, `
      + `${d.loan_hours} soatda qaytarish kerak.`));
  }

  // --- Boylar reytingi ---
  function openTop() {
    const st = { kind: 'top', data: null, v: 0 };
    openSheet(st);
    loadInto(st, '/api/game/top', (d) => { st.data = d; });
  }

  function topRow(t) {
    const row = el('div', `top-row${t.me ? ' is-me' : ''}`);
    const place = el('span', `top-row__place top-row__place--${t.place <= 3 ? t.place : 'n'}`, String(t.place));
    const info = el('div', 'person__info');
    const name = el('strong', '', t.me ? `${t.name} (Siz)` : t.name);
    if (t.clan) {
      const tag = el('span', 'clan-tag', t.clan.tag);
      tag.style.setProperty('--clan', t.clan.color);
      name.prepend(tag);
    }
    info.append(name, el('small', '', `Pul ${formatNumber(t.money)} · mulk ${formatNumber(t.property)}`));
    row.append(place, avatarEl(t), info, el('strong', 'top-row__sum', `${formatNumber(t.wealth)} so'm`));
    return row;
  }

  function renderTopSheet(body, st) {
    const d = st.data;
    setHead('trophy', 'Boylar reytingi', d ? `Jami ${d.total} o'yinchi · pul + bank + mulk − qarz` : 'Yuklanmoqda…');
    if (!d) return;
    const list = el('div', 'people');
    d.top.forEach((t) => list.append(topRow(t)));
    if (d.me && d.me.place > 10) {
      list.append(el('div', 'top-gap', '…'), topRow(d.me));
    }
    if (!d.top.length) list.append(el('p', 'sheet-note', "Hali hech kim yo'q."));
    body.append(list);
  }

  // --- Klanlar ---
  function openClans() {
    const st = { kind: 'clans', data: null, v: 0, draft: '', form: { name: '', tag: '', color: null } };
    openSheet(st);
    loadInto(st, '/api/game/clans', (d) => { st.data = d; setEconomy(d.economy); });
  }

  async function clanCall(st, url, body, okText) {
    try {
      const d = await api(url, { method: 'POST', body });
      localVersion += 1;
      st.data = d;
      st.v += 1;
      setEconomy(d.economy);
      if (okText) toast(okText, 'success');
      renderSheet();
      return true;
    } catch (err) {
      if (!handleAuthError(err)) toast(err.message, 'warn');
      renderSheet();
      return false;
    }
  }

  function clanFlag(c, big = false) {
    const f = el('span', `clan-flag${big ? ' clan-flag--big' : ''}`, c.tag);
    f.style.setProperty('--clan', c.color);
    return f;
  }

  function renderClansSheet(body, st) {
    const d = st.data;
    if (!d) {
      setHead('users', 'Klanlar', 'Yuklanmoqda…');
      return;
    }
    const mine = d.clans.find((c) => c.id === d.my);
    if (mine) {
      const leader = mine.leader === me.key;
      setHead('users', mine.name, `${mine.members.length}/${d.max} a'zo · xazina ${formatNumber(mine.money)} so'm`);
      const head = el('div', 'clan-head');
      head.append(clanFlag(mine, true), el('div', 'person__info'));
      head.lastChild.append(el('strong', '', mine.name), el('small', '', `Boshliq: ${mine.leader_name}`));
      body.append(head);
      const box2 = el('div', 'sale');
      const input = amountInput(st);
      const row = el('div', 'sale__row');
      row.append(input, actionBtn('plus', 'Xazinaga', async () => {
        const amount = parseAmount(input.value);
        if (!amount) return toast('Summani yozing', 'warn');
        st.draft = '';
        return clanCall(st, '/api/game/clans/deposit', { amount }, `Xazinaga ${formatNumber(amount)} so'm qo'shdingiz`);
      }));
      box2.append(el('strong', 'sale__title', `Xazina: ${formatNumber(mine.money)} so'm`), row, amountChips(input, st));
      if (leader) box2.append(el('small', '', "Siz boshliqsiz: summani yozib, a'zo yonidagi «Berish» ni bosing — xazinadan unga o'tadi."));
      body.append(box2);
      const list = el('div', 'people');
      mine.members.forEach((m) => {
        const r = el('div', 'person');
        const info = el('div', 'person__info');
        info.append(el('strong', '', m.me ? `${m.name} (Siz)` : m.name), el('small', '', m.key === mine.leader ? 'Boshliq' : "A'zo"));
        r.append(avatarEl(m), info);
        if (leader) {
          r.append(actionBtn('coins', 'Berish', () => {
            const amount = parseAmount(input.value);
            if (!amount) return toast('Avval summani yozing', 'warn');
            st.draft = '';
            return clanCall(st, '/api/game/clans/pay', { amount, to: m.key }, `${m.name}ga ${formatNumber(amount)} so'm berildi`);
          }, 'btn btn--ghost'));
          if (!m.me) {
            r.append(actionBtn('x', '', () => clanCall(st, '/api/game/clans/kick', { key: m.key }, `${m.name} klandan chiqarildi`), 'btn btn--ghost btn--icon'));
          }
        }
        list.append(r);
      });
      body.append(list);
      if (leader) {
        // Boshliq odamlarni taklif qiladi — ular «Qabul» bossa klanga kiradi
        const add = el('div', 'sale');
        add.append(el('strong', 'sale__title', `A'zo qo'shish (${mine.members.length}/${d.max})`));
        const cands = d.candidates || [];
        if (!cands.length) add.append(el('small', '', "Taklif qiladigan odam yo'q — hamma klanda."));
        const people = el('div', 'people');
        cands.forEach((c) => {
          const r = el('div', 'person');
          const info = el('div', 'person__info');
          info.append(el('strong', '', c.name), el('small', c.online ? 'person__on' : '', c.online ? "O'yinda" : "O'yinda emas"));
          r.append(avatarEl(c), info);
          const btn = actionBtn(c.invited ? 'check' : 'user-plus', c.invited ? 'Taklif yuborilgan' : 'Taklif qilish',
            () => clanCall(st, '/api/game/clans/invite', { key: c.key }, `${c.name}ga taklif yuborildi. U «Qabul» bossa, klaningizga kiradi`),
            c.invited ? 'btn btn--ghost' : 'btn btn--primary');
          btn.disabled = c.invited || mine.members.length >= d.max;
          r.append(btn);
          people.append(r);
        });
        add.append(people);
        body.append(add);
      }
      body.append(actionBtn('log-out', 'Klandan chiqish', () => clanCall(st, '/api/game/clans/leave', {}, 'Klandan chiqdingiz'), 'btn btn--ghost btn--block'));
      return;
    }
    setHead('users', 'Klanlar', d.clans.length ? `${d.clans.length} ta klan · qo'shiling yoki o'zingiz tuzing` : "Hali klan yo'q — birinchisini tuzing!");
    (d.invites || []).forEach((inv) => {
      // Klan boshlig'idan kelgan taklif
      const r = el('div', 'clan-invite');
      const info = el('div', 'person__info');
      info.append(el('strong', '', `${inv.from} sizni «${inv.name}» klaniga taklif qildi`), el('small', '', "Qabul qilsangiz, klan a'zosi bo'lasiz"));
      r.append(clanFlag(inv), info,
        actionBtn('check', 'Qabul', () => clanCall(st, `/api/game/clans/${inv.clan}/join`, {}, `${inv.name} klaniga qo'shildingiz!`)),
        actionBtn('x', 'Rad', () => clanCall(st, `/api/game/clans/${inv.clan}/decline`, {}, null), 'btn btn--ghost'));
      body.append(r);
    });
    if (d.clans.length) {
      const list = el('div', 'people');
      d.clans.forEach((c) => {
        const r = el('div', 'person');
        const info = el('div', 'person__info');
        info.append(el('strong', '', c.name), el('small', '', `${c.members.length}/${d.max} a'zo · xazina ${formatNumber(c.money)} so'm`));
        r.append(clanFlag(c), info);
        const join = actionBtn('user-plus', "Qo'shilish", () => clanCall(st, `/api/game/clans/${c.id}/join`, {}, `${c.name} klaniga qo'shildingiz`));
        join.disabled = c.members.length >= d.max;
        r.append(join);
        list.append(r);
      });
      body.append(list);
    }
    const f = st.form;
    const form = el('div', 'sale');
    const name = el('input', 'input');
    name.placeholder = 'Klan nomi (masalan: Burgutlar)';
    name.maxLength = 20;
    name.value = f.name;
    name.addEventListener('input', () => { f.name = name.value; });
    const tag = el('input', 'input');
    tag.placeholder = 'Bayroq yozuvi: 2–4 harf (BRG)';
    tag.maxLength = 4;
    tag.value = f.tag;
    tag.addEventListener('input', () => {
      tag.value = tag.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      f.tag = tag.value;
    });
    const colors = el('div', 'swatches');
    d.colors.forEach((c) => {
      const s = el('button', `swatch${f.color === c ? ' is-on' : ''}`);
      s.type = 'button';
      s.style.setProperty('--sw', c);
      s.setAttribute('aria-label', `Rang ${c}`);
      s.addEventListener('click', () => { f.color = c; st.v += 1; renderSheet(); });
      colors.append(s);
    });
    form.append(el('strong', 'sale__title', 'Yangi klan tuzish'), name, tag, el('small', '', 'Bayroq rangi:'), colors,
      priceButton('Klan tuzish', d.price, () => {
        if (!f.color) {
          toast('Bayroq rangini tanlang', 'warn');
          renderSheet();
          return null;
        }
        return clanCall(st, '/api/game/clans', { name: f.name, tag: f.tag, color: f.color }, 'Klan tuzildi! Bayroq Ota hovlingizda hilpiraydi');
      }));
    body.append(form, el('p', 'sheet-note', "Klan a'zolarining ismi oldida bayroq yozuvi ko'rinadi, Ota hovlisida esa bayroq turadi. Xazinaga hamma pul qo'shadi, boshliq a'zolarga bo'lib beradi."));
  }

  // --- Ko'rinish ---
  const LOOK_LABELS = [['skin', 'Teri rangi'], ['hair', 'Soch'], ['shirt', "Ko'ylak"], ['pants', 'Shim'], ['hat', 'Shapka']];
  const HAT_NAMES = { '': "Yo'q", cap: 'Kepka', hat: 'Shlyapa', beanie: 'Qishki shapka', crown: 'Toj' };

  function openLooks() {
    const st = { kind: 'looks', data: null, v: 0, pick: {} };
    openSheet(st);
    loadInto(st, '/api/game/looks', (d) => {
      st.data = d;
      const o = d.options;
      st.pick = { skin: o.skin[0], hair: o.hair[0], shirt: o.shirt[0], pants: o.pants[0], hat: '', ...d.looks };
    });
  }

  function renderLooksSheet(body, st) {
    setHead('user', "Ko'rinishim", st.data ? 'Tanlang — odamchangiz darhol o\'zgaradi' : 'Yuklanmoqda…');
    if (!st.data) return;
    const preview = () => { setRigLooks(me.rig, st.pick); };
    LOOK_LABELS.forEach(([k, label]) => {
      const sec = el('div', 'looks-row');
      sec.append(el('strong', '', label));
      const list = el('div', k === 'hat' ? 'chips' : 'swatches');
      st.data.options[k].forEach((v) => {
        const on = (st.pick[k] || '') === v;
        let b;
        if (k === 'hat') {
          b = el('button', `chip${on ? ' is-on' : ''}`, HAT_NAMES[v] || v);
        } else {
          b = el('button', `swatch${on ? ' is-on' : ''}`);
          b.style.setProperty('--sw', v);
          b.setAttribute('aria-label', `${label}: ${v}`);
        }
        b.type = 'button';
        b.addEventListener('click', () => {
          st.pick[k] = v;
          st.v += 1;
          preview();
          renderSheet();
        });
        list.append(b);
      });
      sec.append(list);
      body.append(sec);
    });
    preview();
    body.append(actionBtn('check', 'Saqlash', async () => {
      try {
        const d = await api('/api/game/looks', { method: 'POST', body: st.pick });
        me.looks = d.looks;
        toast("Yangi ko'rinish saqlandi — hamma shunday ko'radi", 'success');
        closeSheet();
      } catch (err) {
        if (!handleAuthError(err)) toast(err.message, 'warn');
      }
    }, 'btn btn--primary btn--block'));
  }

  // --- Sovg'a ---
  function renderGiftSheet(body, st) {
    const p = st.person;
    setHead('sparkles', `${p.name}ga sovg'a`, "Mashina yoki uyingizni sovg'a qiling");
    const list = el('div', 'car-list');
    const send = (item, label) => async (e) => {
      const btn = e.currentTarget;
      if (btn.dataset.sure !== '1') {
        btn.dataset.sure = '1';
        btn.querySelector('span').textContent = 'Rostdanmi? Yana bosing';
        return;
      }
      btn.disabled = true;
      try {
        const d = await api('/api/game/gift', { method: 'POST', body: { to: p.key, ...item } });
        localVersion += 1;
        setPlots(d.plots);
        setEconomy(d.economy);
        sound.cash();
        toast(`${d.to}ga ${d.thing} sovg'a qildingiz!`, 'success');
        openPeople();
      } catch (err) {
        if (!handleAuthError(err)) toast(err.message, 'warn');
        btn.disabled = false;
      }
    };
    const row = (iconName, color, title, sub, item) => {
      const r = el('div', 'car-row');
      const sw = el('span', 'car-row__swatch');
      sw.style.setProperty('--car', color);
      sw.append(icon(iconName));
      const info = el('div', 'car-row__info');
      info.append(el('strong', '', title), el('small', '', sub));
      r.append(sw, info, actionBtn('sparkles', "Sovg'a qilish", send(item), 'btn btn--ghost'));
      list.append(r);
    };
    economy.cars.forEach((id) => {
      const c = carsById[id];
      if (c) row('car', c.color || '#64748b', c.name, 'Mashina', { car: id });
    });
    economy.plots.filter((pl) => !pl.home).forEach((pl) => {
      row(pl.kind ? KIND_ICONS[pl.kind] : 'map-pin', pl.kind ? buildingsById[pl.kind].color : '#a8a29e',
        pl.kind ? `${bName(pl.kind, pl.variant)} · ${pl.level} qavat` : `${plotTitle(pl.plot)} — bo'sh yer`,
        plotTitle(pl.plot), { plot: pl.plot });
    });
    if (!list.children.length) list.append(el('p', 'sheet-note', "Sovg'a qiladigan narsangiz yo'q (Ota hovlini sovg'a qilib bo'lmaydi)."));
    body.append(list, backLink("Odamlar ro'yxatiga qaytish", openPeople));
  }

  // --- Poyga taklifi ---
  function renderRaceSheet(body, st) {
    const p = st.person;
    setHead('car', `${p.name} bilan poyga`, 'Marraga birinchi yetgan tikilgan pulni oladi');
    const box2 = el('div', 'sale');
    const input = amountInput(st, "0 — pulsiz poyga");
    const row = el('div', 'sale__row');
    const submit = async () => {
      const bet = parseAmount(input.value) || 0;
      if (bet > money()) return toast('Pul yetarli emas', 'warn');
      try {
        const d = await api('/api/game/race/invite', { method: 'POST', body: { to: p.key, bet } });
        toast(`${d.to}ga taklif yuborildi. Javobini kuting…`, 'success');
        closeSheet();
      } catch (err) {
        if (!handleAuthError(err)) toast(err.message, 'warn');
      }
      return null;
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    row.append(input, actionBtn('send', 'Chaqirish', submit));
    box2.append(el('strong', 'sale__title', 'Qancha tikasiz?'), row, amountChips(input, st, [1000, 10000, 100000, 1000000]));
    body.append(box2, el('p', 'sheet-note',
      "Ikkalangiz ham shu summani tikasiz, birinchi yetgan ikkalasini oladi. Taklif 30 soniya amal qiladi. "
      + "Marra xaritada ko'k nur bilan ko'rinadi — mashinada tezroq!"), backLink("Odamlar ro'yxatiga qaytish", openPeople));
    setTimeout(() => input.focus(), 0);
  }

  // --- Kod chellenji: HTML/CSS topshiriq, AI tekshiradi ---
  function openChallenge() {
    const st = { kind: 'code', data: null, v: 0, draft: '', result: null, busy: false };
    openSheet(st);
    loadInto(st, '/api/game/challenge', (d) => { st.data = d; setEconomy(d.economy); });
  }

  function setChallenge(st, d) {
    if (st.data && d.challenge && st.data.challenge && d.challenge.id !== st.data.challenge.id) st.draft = '';
    st.data = d;
    st.waitUntil = Date.now() + (d.wait || 0) * 1000;
    st.v += 1;
    setEconomy(d.economy);
  }

  function renderCodeSheet(body, st) {
    const d = st.data;
    setHead('star', 'Kod chellenji', d ? `Bajarildi: ${d.solved} / ${d.total} · javobni AI tekshiradi` : 'Yuklanmoqda…');
    if (!d) return;
    if (!d.challenge) {
      const done = el('div', 'offer offer--done');
      done.append(icon('trophy'), el('strong', '', "Barcha topshiriqlarni bajardingiz! Zo'r dasturchisiz."));
      body.append(done);
      return;
    }
    const c = d.challenge;
    const task = el('div', 'code-task');
    task.append(el('small', 'eyebrow', c.title), el('p', '', c.task), el('strong', 'code-task__prize', `Mukofot: ${formatNumber(c.reward)} so'm`));
    body.append(task);
    if (st.result) {
      const r = st.result;
      const box2 = el('div', `code-result ${r.passed ? 'code-result--ok' : 'code-result--bad'}`);
      box2.append(el('strong', '', r.passed ? `To'g'ri! +${formatNumber(r.reward)} so'm` : "Hali to'g'ri emas"));
      if (r.feedback) box2.append(el('p', '', r.feedback));
      if (r.mistakes && r.mistakes.length) {
        const ul = el('ul', '');
        r.mistakes.forEach((m) => ul.append(el('li', '', m)));
        box2.append(ul);
      }
      body.append(box2);
    }
    const area = el('textarea', 'code-input');
    area.spellcheck = false;
    area.placeholder = '<style>\n  button { ... }\n</style>\n<button>Yuborish</button>';
    area.value = st.draft || '';
    area.setAttribute('aria-label', 'HTML/CSS kodingiz');
    const frame = el('iframe', 'code-preview');
    frame.setAttribute('sandbox', '');   // skriptlar ishlamaydi — faqat ko'rinish
    frame.title = 'Natija';
    let timer = null;
    const preview = () => { frame.srcdoc = area.value; };
    area.addEventListener('input', () => {
      st.draft = area.value;
      clearTimeout(timer);
      timer = setTimeout(preview, 300);
    });
    area.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      e.preventDefault(); // Tab — 2 ta probel
      const a = area.selectionStart;
      area.setRangeText('  ', a, area.selectionEnd, 'end');
      st.draft = area.value;
    });
    preview();
    body.append(el('small', 'code-label', 'Kodingiz (HTML va <style>):'), area, el('small', 'code-label', "Natija:"), frame);
    const actions = el('div', 'bank-actions');
    const send = actionBtn('check', st.busy ? 'Tekshirilyapti…' : 'Tekshirish', async () => {
      const wait = Math.ceil(((st.waitUntil || 0) - Date.now()) / 1000);
      if (wait > 0) return toast(`${wait} soniyadan keyin qayta urinib ko'ring`, 'warn');
      if (area.value.trim().length < 10) return toast('Avval kodni yozing', 'warn');
      st.busy = true;
      st.v += 1;
      renderSheet();
      try {
        const res = await api('/api/game/challenge', { method: 'POST', body: { id: c.id, code: area.value } });
        localVersion += 1;
        st.result = res.result;
        setChallenge(st, res);
        if (res.result.passed) {
          sound.cash();
          toast(`To'g'ri! +${formatNumber(res.result.reward)} so'm`, 'success');
        } else {
          toast("Xato bor — AI izohini o'qing", 'warn');
        }
      } catch (err) {
        if (!handleAuthError(err)) toast(err.message, 'warn');
      }
      st.busy = false;
      st.v += 1;
      if (sheetState === st) renderSheet();
      return null;
    });
    send.disabled = st.busy || !d.ai;
    const skip = actionBtn('refresh', 'Boshqa topshiriq', async () => {
      try {
        const res = await api('/api/game/challenge/skip', { method: 'POST' });
        st.result = null;
        setChallenge(st, res);
        renderSheet();
      } catch (err) {
        if (!handleAuthError(err)) toast(err.message, 'warn');
      }
    }, 'btn btn--ghost');
    skip.disabled = st.busy;
    actions.append(send, skip);
    body.append(actions);
    if (!d.ai) body.append(el('p', 'sheet-note sheet-note--warn', "AI hozir ulanmagan — owner .env fayliga GEMINI_API_KEY qo'yishi kerak."));
    body.append(el('p', 'sheet-note',
      "Har topshiriq bir marta pul beradi. Xato bo'lsa 30 soniyadan keyin qayta yuborasiz. "
      + "Kodni o'zingiz yozing — tayyor kodni ko'chirsangiz, o'rganmaysiz!"));
  }

  // ---------------- Uy ichi: mebel ----------------
  const CELL = 26;
  const room = {
    on: false, plot: null, data: null, scene: null, camera: null, floor: null, items: null, ghost: null, grid: null,
    placing: null, rot: 0, hover: null, sel: -1, busy: false, windowMat: null, cam: { yaw: 0.35, pitch: 0.95, dist: 420 },
  };
  const WALLS = { uy: '#fde7c8', magazin: '#dbeafe', kafe: '#fef3c7', ofis: '#e5e7eb' };
  const furnitureById = () => Object.fromEntries(room.data.catalog.map((f) => [f.id, f]));

  function furnitureModel(id, color) {
    const g = new THREE.Group();
    const c = mat(color);
    const W = CELL;
    const legs = (h, sx, sz, m) => [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([a, b]) => g.add(box(2, h, 2, m, a * sx, h / 2, b * sz)));
    if (id === 'divan') {
      g.add(box(2 * W - 6, 9, W - 6, c, 0, 8, 2), box(2 * W - 6, 15, 5, c, 0, 15, -W / 2 + 5),
        box(5, 13, W - 6, c, -W + 5, 11, 0), box(5, 13, W - 6, c, W - 5, 11, 0));
    } else if (id === 'krovat') {
      g.add(box(2 * W - 6, 8, 2 * W - 6, mat('#92400e'), 0, 4, 0), box(2 * W - 10, 6, 2 * W - 10, mat('#f8fafc'), 0, 11, 0),
        box(2 * W - 10, 2, W, mat('#3b82f6'), 0, 14.5, W / 2 - 4), box(16, 4, 9, mat('#ffffff'), -10, 15, -W + 11),
        box(16, 4, 9, mat('#ffffff'), 10, 15, -W + 11), box(2 * W - 6, 22, 3, mat('#78350f'), 0, 11, -W + 4));
    } else if (id === 'stol') {
      g.add(box(W - 4, 2.5, W - 4, c, 0, 16, 0));
      legs(15, W / 2 - 4, W / 2 - 4, c);
    } else if (id === 'stul') {
      g.add(box(W - 10, 2, W - 10, c, 0, 10, 0), box(W - 10, 12, 2, c, 0, 17, -(W / 2 - 6)));
      legs(9, W / 2 - 6, W / 2 - 6, c);
    } else if (id === 'tv') {
      g.add(box(2 * W - 10, 8, W - 12, mat('#78350f'), 0, 4, 0), box(2 * W - 8, 22, 2, c, 0, 21, -2),
        box(2 * W - 12, 18, 0.5, glow('#38bdf8', 0.6), 0, 21, -0.7));
    } else if (id === 'shkaf') {
      g.add(box(2 * W - 6, 52, W - 6, c, 0, 26, 0), box(0.8, 48, 0.6, mat('#1f2937'), 0, 26, W / 2 - 2.7),
        box(1.5, 7, 1.5, mat('#e5e7eb'), -3, 28, W / 2 - 2.4), box(1.5, 7, 1.5, mat('#e5e7eb'), 3, 28, W / 2 - 2.4));
    } else if (id === 'muzlatgich') {
      g.add(box(W - 6, 46, W - 6, c, 0, 23, 0), box(W - 6, 0.6, 0.6, mat('#9ca3af'), 0, 30, W / 2 - 2.7),
        box(1.5, 10, 1.5, mat('#9ca3af'), W / 2 - 7, 37, W / 2 - 2.4));
    } else if (id === 'kompyuter') {
      g.add(box(2 * W - 6, 2.5, W - 6, c, 0, 16, 0), box(18, 12, 1.5, mat('#111827'), 0, 25, -4),
        box(16, 10, 0.4, glow('#60a5fa', 0.8), 0, 25, -3.1), box(14, 1, 5, mat('#e5e7eb'), 0, 17.8, 5));
      legs(15, W - 6, W / 2 - 5, mat('#1f2937'));
    } else if (id === 'gul') {
      g.add(cyl(5, 4, 8, mat('#b45309'), 0, 4, 0, 12), mesh(new THREE.IcosahedronGeometry(8, 0), c, 0, 15, 0));
    } else if (id === 'lampa') {
      g.add(cyl(5, 6, 1.5, mat('#374151'), 0, 0.75, 0, 12), cyl(0.8, 0.8, 34, mat('#374151'), 0, 17, 0, 6),
        mesh(new THREE.ConeGeometry(7, 9, 14, 1, true), glow(color, 0.9), 0, 36, 0));
    } else if (id === 'akvarium') {
      g.add(box(2 * W - 6, 12, W - 6, mat('#1f2937'), 0, 6, 0),
        mesh(new THREE.BoxGeometry(2 * W - 8, 16, W - 8),
          new THREE.MeshStandardMaterial({ color: '#38bdf8', transparent: true, opacity: 0.45, roughness: 0.1 }), 0, 20.5, 0),
        box(4, 2.5, 1.2, mat('#f97316'), -6, 21, 0), box(4, 2.5, 1.2, mat('#facc15'), 7, 18, 2));
    } else if (id === 'gilam') {
      g.add(box(3 * W - 4, 0.8, 2 * W - 4, c, 0, 0.5, 0), box(3 * W - 14, 0.9, 2 * W - 14, mat('#fde68a'), 0, 0.6, 0),
        box(3 * W - 20, 1, 2 * W - 20, c, 0, 0.7, 0));
    } else {
      g.add(box(W - 6, 10, W - 6, c, 0, 5, 0));
    }
    return g;
  }

  // Mebel egallaydigan katakchalar (burilganda eni va bo'yi almashadi)
  function itemDims(item) {
    const f = furnitureById()[item.item];
    return item.r % 2 ? [f.d, f.w] : [f.w, f.d];
  }
  function itemCells(item) {
    const [w, d] = itemDims(item);
    const cells = [];
    for (let i = 0; i < w; i += 1) for (let j = 0; j < d; j += 1) cells.push(`${item.x + i},${item.z + j}`);
    return cells;
  }
  function fitsLocal(item, skip = -1) {
    const { w, d } = room.data.room;
    const [iw, id] = itemDims(item);
    if (item.x < 0 || item.z < 0 || item.x + iw > w || item.z + id > d) return false;
    const fb = furnitureById();
    const floor = Boolean(fb[item.item].floor);
    const mine = new Set(itemCells(item));
    return !room.data.items.some((o, i) => i !== skip && Boolean(fb[o.item].floor) === floor && itemCells(o).some((c) => mine.has(c)));
  }

  function placeModel(model, item) {
    const { w, d } = room.data.room;
    const [iw, id] = itemDims(item);
    model.position.set((item.x + iw / 2) * CELL - (w * CELL) / 2, 0, (item.z + id / 2) * CELL - (d * CELL) / 2);
    model.rotation.y = -item.r * (Math.PI / 2);
  }

  function buildRoomScene() {
    const { w, d } = room.data.room;
    const W = w * CELL;
    const D = d * CELL;
    const sc = new THREE.Scene();
    sc.background = new THREE.Color('#0f172a');
    sc.add(new THREE.HemisphereLight('#fff7ed', '#334155', 1.2));
    const key = new THREE.DirectionalLight('#ffffff', 1.5);
    key.position.set(-120, 260, 200);
    sc.add(key, new THREE.PointLight('#ffd7a0', 0.6, 0, 0));
    const wood = tileTexture(128, (g, n) => {
      g.fillStyle = '#b07a46';
      g.fillRect(0, 0, n, n);
      for (let i = 0; i < 4; i += 1) {
        g.fillStyle = i % 2 ? '#a36d3b' : '#bb8752';
        g.fillRect(0, (i * n) / 4, n, n / 4 - 2);
        g.fillStyle = 'rgba(0,0,0,.18)';
        g.fillRect(((i * 37) % n), (i * n) / 4, 2, n / 4);
      }
    }, w / 2, d / 2);
    room.floor = flat(W, D, new THREE.MeshStandardMaterial({ map: wood, roughness: 0.8 }), 0, 0, 0);
    sc.add(room.floor);
    // Katakchalar (joylashtirayotganda ko'rinadi)
    const pts = [];
    for (let i = 0; i <= w; i += 1) pts.push(i * CELL - W / 2, 0.4, -D / 2, i * CELL - W / 2, 0.4, D / 2);
    for (let j = 0; j <= d; j += 1) pts.push(-W / 2, 0.4, j * CELL - D / 2, W / 2, 0.4, j * CELL - D / 2);
    const gridGeo = new THREE.BufferGeometry();
    gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    room.grid = new THREE.LineSegments(gridGeo, new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.35 }));
    room.grid.visible = false;
    sc.add(room.grid);
    const wall = mat(WALLS[room.data.kind] || '#f5f5f4', { roughness: 0.95 });
    const H = 90;
    sc.add(box(W + 8, H, 4, wall, 0, H / 2, -D / 2 - 2), box(4, H, D, wall, -W / 2 - 2, H / 2, 0), box(4, H, D, wall, W / 2 + 2, H / 2, 0));
    sc.add(box(W + 8, 6, 5, mat('#e7e5e4'), 0, 3, -D / 2 - 1.5));
    // Deraza: tashqarida kun yoki tun ko'rinadi
    room.windowMat = new THREE.MeshBasicMaterial({ color: SKY.clone() });
    [-W / 4, W / 4].forEach((x) => {
      sc.add(box(64, 40, 2, mat('#f8fafc'), x, 52, -D / 2 + 0.4));
      sc.add(mesh(new THREE.PlaneGeometry(58, 34), room.windowMat, x, 52, -D / 2 + 1.6, false));
      sc.add(box(2, 34, 1, mat('#f8fafc'), x, 52, -D / 2 + 1.8));
    });
    room.items = new THREE.Group();
    sc.add(room.items);
    room.scene = sc;
    room.camera = new THREE.PerspectiveCamera(50, 1, 1, 5000);
  }

  function renderRoomItems() {
    room.items.children.slice().forEach((o) => { room.items.remove(o); disposeTree(o); });
    const fb = furnitureById();
    room.data.items.forEach((item, i) => {
      const f = fb[item.item];
      const m = furnitureModel(f.id, f.color);
      placeModel(m, item);
      m.traverse((o) => { o.userData.index = i; });
      if (i === room.sel) {
        const [iw, id] = itemDims(item);
        const mark = new THREE.Mesh(new THREE.PlaneGeometry(iw * CELL - 2, id * CELL - 2),
          new THREE.MeshBasicMaterial({ color: '#3b82f6', transparent: true, opacity: 0.45, depthWrite: false }));
        mark.rotation.x = -Math.PI / 2;
        mark.rotation.z = item.r * (Math.PI / 2);
        mark.position.y = 1.2;
        m.add(mark);
      }
      room.items.add(m);
    });
  }

  function setGhost() {
    if (room.ghost) {
      room.scene.remove(room.ghost);
      disposeTree(room.ghost);
      room.ghost = null;
    }
    room.grid.visible = Boolean(room.placing);
    if (!room.placing || !room.hover) return;
    const f = furnitureById()[room.placing];
    const item = { item: f.id, x: room.hover.x, z: room.hover.z, r: room.rot };
    const ok = fitsLocal(item);
    const g = furnitureModel(f.id, f.color);
    g.traverse((o) => {
      if (o.isMesh) {
        o.material = o.material.clone();
        o.material.transparent = true;
        o.material.opacity = 0.6;
        if (!ok) o.material.color = new THREE.Color('#ef4444');
      }
    });
    placeModel(g, item);
    room.ghost = g;
    room.ghost.userData.ok = ok;
    room.scene.add(g);
  }

  function roomRay(clientX, clientY) {
    const v = new THREE.Vector2((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
    raycaster.setFromCamera(v, room.camera);
    return raycaster;
  }

  function roomHover(clientX, clientY) {
    if (!room.placing) return;
    const hit = roomRay(clientX, clientY).intersectObject(room.floor)[0];
    if (!hit) return;
    const { w, d } = room.data.room;
    const f = furnitureById()[room.placing];
    const [iw, id] = room.rot % 2 ? [f.d, f.w] : [f.w, f.d];
    const cx = Math.floor((hit.point.x + (w * CELL) / 2) / CELL);
    const cz = Math.floor((hit.point.z + (d * CELL) / 2) / CELL);
    const next = { x: clamp(cx - Math.floor((iw - 1) / 2), 0, w - iw), z: clamp(cz - Math.floor((id - 1) / 2), 0, d - id) };
    if (room.hover && room.hover.x === next.x && room.hover.z === next.z && room.ghost) return;
    room.hover = next;
    setGhost();
  }

  async function roomCall(body, okText) {
    if (room.busy) return false;
    room.busy = true;
    try {
      const d = await api(`/api/game/plots/${room.plot}/furniture`, { method: 'POST', body });
      localVersion += 1;
      room.data = d;
      setEconomy(d.economy);
      if (okText) toast(okText, 'success');
      return true;
    } catch (err) {
      if (!handleAuthError(err)) toast(err.message, 'warn');
      return false;
    } finally {
      room.busy = false;
      renderRoomItems();
      setGhost();
      renderRoomUI();
    }
  }

  function roomClick(clientX, clientY) {
    if (room.placing) {
      roomHover(clientX, clientY);
      if (!room.hover) return;
      if (room.ghost && !room.ghost.userData.ok) {
        toast("Bu joy band yoki xonaga sig'maydi", 'warn');
        return;
      }
      const f = furnitureById()[room.placing];
      if (money() < f.price) {
        toast('Pul yetarli emas', 'warn');
        return;
      }
      const body = { action: 'add', item: room.placing, x: room.hover.x, z: room.hover.z, r: room.rot };
      room.placing = null;
      sound.cash();
      roomCall(body, `${f.name} joylashtirildi`);
      return;
    }
    const hit = roomRay(clientX, clientY).intersectObjects(room.items.children, true)[0];
    room.sel = hit ? hit.object.userData.index : -1;
    renderRoomItems();
    renderRoomUI();
  }

  function rotateGhost() {
    if (!room.placing) return;
    room.rot = (room.rot + 1) % 4;
    if (room.hover) {
      const { w, d } = room.data.room;
      const f = furnitureById()[room.placing];
      const [iw, id] = room.rot % 2 ? [f.d, f.w] : [f.w, f.d];
      room.hover = { x: clamp(room.hover.x, 0, w - iw), z: clamp(room.hover.z, 0, d - id) };
    }
    setGhost();
  }

  function renderRoomUI() {
    const d = room.data;
    $('room-title').textContent = `${bName(d.kind, d.variant)} — ichkarisi`;
    $('room-sub').textContent = `${d.items.length} / ${d.room.max} ta narsa · sotib oling va polga qo'ying`;
    const shop = $('room-shop');
    shop.replaceChildren();
    d.catalog.forEach((f) => {
      const b = el('button', `room-item${room.placing === f.id ? ' is-on' : ''}`);
      b.type = 'button';
      const sw = el('span', 'room-item__sw');
      sw.style.setProperty('--sw', f.color);
      b.append(sw, el('strong', '', f.name), el('small', '', `${formatNumber(f.price)} so'm`));
      b.disabled = money() < f.price;
      b.addEventListener('click', () => {
        room.placing = room.placing === f.id ? null : f.id;
        room.sel = -1;
        room.rot = 0;
        room.hover = null;
        setGhost();
        renderRoomItems();
        renderRoomUI();
      });
      shop.append(b);
    });
    const sel = $('room-sel');
    sel.replaceChildren();
    const item = room.sel >= 0 ? d.items[room.sel] : null;
    sel.hidden = !item;
    if (item) {
      const f = furnitureById()[item.item];
      sel.append(el('strong', '', f.name),
        actionBtn('rotate', 'Burish', () => roomCall({ action: 'rotate', index: room.sel }), 'btn btn--ghost'),
        actionBtn('trash', `Sotish (+${formatNumber(Math.floor(f.price / 2))})`, () => {
          const index = room.sel;
          room.sel = -1;
          return roomCall({ action: 'remove', index }, `${f.name} sotildi`);
        }, 'btn btn--ghost'));
    }
    $('room-hint').textContent = room.placing
      ? (TOUCH ? 'Polga bosing — shu yerga qo\'yiladi. «Burish» — aylantirish' : "Polga bosing — shu yerga qo'yiladi. R — burish, Esc — bekor")
      : `Ro'yxatdan mebel tanlang yoki xonadagi narsani bosing. Tortib — aylantirish${TOUCH ? '' : ", g'ildirak — yaqinlashtirish"}`;
    $('room-rotate').hidden = !room.placing;
  }

  async function enterRoom(plotId, url = null) {
    try {
      const d = await api(url || `/api/game/plots/${plotId}/furniture`);
      room.data = d;
      room.plot = plotId;
      room.on = true;
      room.sel = -1;
      room.placing = null;
      room.hover = null;
      const portrait = window.innerWidth < window.innerHeight;
      room.cam.dist = portrait ? 640 : 420; // tik ekranda uzoqroqdan
      room.cam.yaw = portrait ? 0.1 : 0.35;
      setEconomy(d.economy);
      buildRoomScene();
      renderRoomItems();
      closeSheet();
      releaseAll();
      document.body.classList.add('is-room');
      $('room-ui').hidden = false;
      renderRoomUI();
      toast(d.items.length ? 'Uyingizga xush kelibsiz!' : "Uy bo'm-bo'sh — pastdan mebel tanlab, polga qo'ying");
    } catch (err) {
      if (!handleAuthError(err)) toast(err.message, 'warn');
    }
  }

  function exitRoom() {
    if (!room.on) return;
    room.on = false;
    room.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    room.scene = null;
    room.ghost = null;
    document.body.classList.remove('is-room');
    $('room-ui').hidden = true;
  }

  function roomFrame() {
    room.windowMat.color.copy(SKY);
    const c = room.cam;
    const horiz = Math.cos(c.pitch) * c.dist;
    room.camera.position.set(Math.sin(c.yaw) * horiz, Math.sin(c.pitch) * c.dist, Math.cos(c.yaw) * horiz);
    room.camera.lookAt(0, 0, 55); // xona ekranning yuqoriroq qismida — pastdagi panel yopmasin
    room.camera.aspect = window.innerWidth / window.innerHeight;
    room.camera.fov = window.innerWidth < window.innerHeight ? 70 : 50;
    room.camera.updateProjectionMatrix();
    renderer.render(room.scene, room.camera);
  }

  $('room-exit').addEventListener('click', exitRoom);
  $('room-rotate').addEventListener('click', rotateGhost);
  $('race-yes').addEventListener('click', () => answerInvite(true));
  $('race-no').addEventListener('click', () => answerInvite(false));
  $('btn-menu').addEventListener('click', () => openSheet({ kind: 'hub' }));

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
      if (Math.hypot(data.correct.x - me.x, data.correct.y - me.y) > 600) {
        // Server ko'chirdi (poyga trassasiga yoki qaytib) — kamera ham sakraydi
        camReady = false;
        if (data.correct.dir !== undefined) me.dir = data.correct.dir;
        cam.yaw = -Math.PI / 2 - me.dir;
        me.fly = false;
        me.h = 0;
      }
      me.x = data.correct.x;
      me.y = data.correct.y;
      me.vx = 0;
      me.vz = 0;
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
    mayorKey = data.mayor || null;
    if (fresh && data.spider_me !== undefined) setSpiderMe(data.spider_me);
    if (fresh && data.drone !== undefined && Boolean(me.drone) !== data.drone) setDroneOwned(data.drone);
    setSpiderBug(data.spider_bug || null);
    setPlayers(data.players);
    webOthers(data.players || []);
    setFarm(data.farm);
    // Kimdir pul bergan bo'lsa — xabar
    addChat(data.chat);
    addVoices(data.voices);
    (data.gifts || []).forEach((g) => {
      sound.cash();
      toast(g.text || `${g.from} sizga ${formatNumber(g.amount)} so'm berdi!`, 'success');
    });
    if (data.loan_collected) toast(`Kredit muddati o'tdi: ${formatNumber(data.loan_collected)} so'm qarz pulingizdan yechildi`, 'warn');
    // Poyga holati faqat yangi javobdan (taklifni qabul qilgan zahoti kelgan eski javob uni o'chirib yubormasin)
    if (fresh) {
      setRaceInvite(data.race_invite || null);
      setRace(data.race || null);
      setBus(data.bus || null);
      if (data.flight && !flight) setFlight(data.flight);
      setJob(data.job || null);
      if (data.proposal && !proposal) {
        proposal = data.proposal;
        sound.ding();
      } else if (!data.proposal) proposal = null;
      updateWedCard();
    }
    setMg(data.mg || null);
    setStage(data.stage || null);
    setFlag(data.flag || null);
    setComet(data.comet || null);
    townSync(data, fresh);
    weddings = data.weddings || [];
    onPm(data.pm);
    if (weddings.some((w) => w.treat)) {
      sound.cash();
      toast(`To'yga keldingiz — to'y oshi: +${formatNumber(2000)} so'm! 💍`, 'success');
    }
    setFest(data.fest || null);
    if (data.fest_paid) {
      sound.cash();
      floatText(`+${formatNumber(data.fest_paid)} so'm`, me.x, me.y, me.rig.root.position.y + 20);
      toast(`Bayram sovg'asi: +${formatNumber(data.fest_paid)} so'm! 🎉`, 'success');
    }
    if (data.ball) setBall(data.ball);
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
            chat_since: chatSince, voice_since: voiceSince, pose: me.sit ? 'sit' : (me.dance && !me.car ? 'dance' : null),
            para: Boolean(me.para), dirt: dirtOf(me.car), pm_since: pmSince, boat: Boolean(me.boat), web: zip ? me.web : null,
            drift: Boolean(me.car) && drifting(),
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
    updateDayNight(now);
    if (room.on) {
      // Uy ichida: faqat xona chiziladi (o'yinchi ko'chada turib qoladi)
      roomFrame();
      updateHud();
      updateRaceCard();
      requestAnimationFrame(loop);
      return;
    }
    step(dt);
    stepBall(dt);
    stepSmoke(dt);
    updateTrackVisibility();
    stepFireworks(dt, now);
    stepDirt(dt, now);
    stepFishing(now);
    stepShot(now);
    drawMovie(now);
    stepParachuteVisual();
    stepMgVisual();
    updateMgCard();
    stepZoo(dt);
    stepSpider(dt);
    stepNpcSpider();
    stepDrone(dt);
    stepCity(performance.now());
    stepTown(dt);
    updateStageUi();
    updateFlight(now);
    updateFestCard();
    stepWeather(dt, now);
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
    updateRaceCard();
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
        moving: false, fly: false, throttle: 0, taxi: false, seat: null, vx: 0, vz: 0,
      };
      me.rig = makeRig(me.name, me.avatar, true);
      me.looks = {};
      api('/api/game/looks').then((d) => { me.looks = d.looks; setRigLooks(me.rig, suitLooks(d.looks, me.spider)); }).catch(() => {});

      // Kichik xarita dunyo nisbatida (kesilib qolmasin)
      mini.height = Math.round((mini.width * world.h) / world.w);
      mini.style.aspectRatio = `${world.w} / ${world.h}`;
      buildGround();
      buildTrees();
      buildPark();
      buildField();
      buildLamps();
      buildTrack();
      buildAirport();
      buildWeather();
      buildBusStops();
      buildPlaces();
      buildAqua();
      buildZoo();
      buildPort();
      buildStage();
      buildDepot();
      buildRocket();
      buildRiver();
      buildCity();
      buildTown();
      loadPet();
      initPhone();
      loadTuning();
      buildShop();
      updateDayNight(performance.now());
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
