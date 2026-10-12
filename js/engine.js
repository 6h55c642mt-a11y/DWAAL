import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
// BVH: raycasts op de 3DBAG-tiles worden duizenden keren sneller
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;
import { LANG, T, installTranslator, localizeCity, DAY_NAMES } from './i18n.js';
import { Auth, Sync } from './auth.js';
import { CITIES } from '../cities/index.js';

// ---------- welke stad? (city.html?city=amsterdam) ----------
const CITY_ID = (new URLSearchParams(location.search).get('city') || 'amsterdam').toLowerCase();
const CITY_META = CITIES.find(c => c.id === CITY_ID) || CITIES[0];
const CITY = localizeCity((await import(`../cities/${CITY_META.id}.js`)).default, LANG);
if (!CanvasRenderingContext2D.prototype.roundRect) CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) { this.moveTo(x + r, y); this.arcTo(x + w, y, x + w, y + h, r); this.arcTo(x + w, y + h, x, y + h, r); this.arcTo(x, y + h, x, y, r); this.arcTo(x, y, x + w, y, r); this.closePath(); };

// =====================================================================
//  CONFIG
// =====================================================================
const CFG = {
  city: CITY.name,
  center: CITY.center,
  radius: CITY.radius,
  cacheVersion: 'v6-' + CITY.id,
  cacheDays: 14,
  ep: {
    // zelfde bronnen als de zonnestudie
    tiles: CITY.tiles || 'https://data.3dbag.nl/v20250903/cesium3dtiles/lod22/tileset.json',
    bagPand: ['https://api.pdok.nl/lv/bag/ogc/v1/collections/pand/items', 'https://api.pdok.nl/kadaster/bag/ogc/v2/collections/pand/items'],
    draco: 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/draco/gltf/',
    overpass: ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'],
    osrmFoot: 'https://routing.openstreetmap.de/routed-foot/route/v1/driving/',
    pdokFree: 'https://api.pdok.nl/bzk/locatieserver/search/v3_1/free',
    pdokReverse: 'https://api.pdok.nl/bzk/locatieserver/search/v3_1/reverse',
    photon: 'https://photon.komoot.io',
    wiki: (lang, t) => `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t)}`,
  },
};
const R = CFG.radius;
const isMobile = matchMedia('(pointer:coarse)').matches || innerWidth < 760;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// =====================================================================
//  UTIL
// =====================================================================
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));
const uid = () => Math.random().toString(36).slice(2, 10);
function hash(s) { let h = 2166136261; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const fmtKm = m => m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`;
const fmtMin = s => { const m = Math.round(s / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} u ${m % 60} min`; };

async function fetchJSON(url, opts = {}, timeout = 60000) {
  // bewust zonder AbortSignal: time-out via race
  let t; const to = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('time-out')), timeout); });
  try { const r = await Promise.race([fetch(url, opts), to]); if (!r.ok) throw new Error(`HTTP ${r.status}`); return await Promise.race([r.json(), to]); }
  finally { clearTimeout(t); }
}
async function pool(tasks, n) { let i = 0; const run = async () => { while (i < tasks.length) { const k = i++; await tasks[k](); } }; await Promise.all(Array.from({ length: n }, run)); }

let toastT;
function toast(msg, ms = 2800) { const el = $('#toast'); el.innerHTML = msg; el.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), ms); }

// ---------- WGS84 -> lokaal oost/noord-vlak (ENU) rond het middelpunt ----------
// Zelfde frame als de 3DBAG-tiles, zodat OSM-data, routes en gebouwen op elkaar vallen.
const DEG = Math.PI / 180, WA = 6378137, WF = 1 / 298.257223563, WE2 = WF * (2 - WF);
const LAT0 = CFG.center.lat, LON0 = CFG.center.lon;
function geo2ecef(lat, lon, h = 0) { const p = lat * DEG, l = lon * DEG, s = Math.sin(p), N = WA / Math.sqrt(1 - WE2 * s * s); return [(N + h) * Math.cos(p) * Math.cos(l), (N + h) * Math.cos(p) * Math.sin(l), (N * (1 - WE2) + h) * s]; }
const O0 = geo2ecef(LAT0, LON0), SP = Math.sin(LAT0 * DEG), CP = Math.cos(LAT0 * DEG), SL = Math.sin(LON0 * DEG), CL = Math.cos(LON0 * DEG);
// lokaal: x = oost (m), z = zuid (m), y = omhoog  -> noorden is -z
function toLocal(lat, lon) { const [X, Y, Z] = geo2ecef(lat, lon), dx = X - O0[0], dy = Y - O0[1], dz = Z - O0[2]; return [-SL * dx + CL * dy, -(-SP * CL * dx - SP * SL * dy + CP * dz)]; }
function localToWgs(x, z) { let lat = LAT0 - z / 111250, lon = LON0 + x / (111320 * CP); for (let i = 0; i < 3; i++) { const [x1, z1] = toLocal(lat, lon); lat -= (z - z1) / 111250; lon += (x - x1) / (111320 * CP); } return [lat, lon]; }
const ptsOf = el => el.L || el.geometry.filter(Boolean).map(p => toLocal(p.lat, p.lon));
const BBOX_WGS = (() => { const a = localToWgs(-R - 60, R + 60), b = localToWgs(R + 60, -R - 60); return { s: a[0], w: a[1], n: b[0], e: b[1] }; })();
const OBB = `${BBOX_WGS.s.toFixed(5)},${BBOX_WGS.w.toFixed(5)},${BBOX_WGS.n.toFixed(5)},${BBOX_WGS.e.toFixed(5)}`;

// ---------- geometrie helpers ----------
function ringArea(p) { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; } return a / 2; }
function pip(pt, ring) { let inside = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1]; if (((zi > pt[1]) !== (zj > pt[1])) && (pt[0] < (xj - xi) * (pt[1] - zi) / (zj - zi) + xi)) inside = !inside; } return inside; }
function pipFlat(x, z, r) { let inside = false; const n = r.length / 2; for (let i = 0, j = n - 1; i < n; j = i++) { const xi = r[i * 2], zi = r[i * 2 + 1], xj = r[j * 2], zj = r[j * 2 + 1]; if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside; } return inside; }
function clipSeg(a, b, rc) {
  const dx = b[0] - a[0], dz = b[1] - a[1], A = dx * dx + dz * dz; if (A === 0) return null;
  const B = 2 * (a[0] * dx + a[1] * dz), C = a[0] * a[0] + a[1] * a[1] - rc * rc, D = B * B - 4 * A * C; if (D < 0) return null;
  const s = Math.sqrt(D); const t1 = Math.max((-B - s) / (2 * A), 0), t2 = Math.min((-B + s) / (2 * A), 1); if (t1 >= t2) return null;
  return [[a[0] + dx * t1, a[1] + dz * t1], [a[0] + dx * t2, a[1] + dz * t2]];
}
const near = (a, b, e = .05) => Math.abs(a[0] - b[0]) < e && Math.abs(a[1] - b[1]) < e;
function joinRings(ways) {
  const rings = [], pool_ = ways.filter(w => w.length > 1).map(w => w.slice());
  while (pool_.length) {
    let cur = pool_.shift(), changed = true;
    while (!near(cur[0], cur[cur.length - 1]) && changed) {
      changed = false;
      for (let i = 0; i < pool_.length; i++) {
        const w = pool_[i], e = cur[cur.length - 1];
        if (near(e, w[0])) cur = cur.concat(w.slice(1));
        else if (near(e, w[w.length - 1])) cur = cur.concat(w.slice().reverse().slice(1));
        else if (near(cur[0], w[w.length - 1])) cur = w.concat(cur.slice(1));
        else if (near(cur[0], w[0])) cur = w.slice().reverse().concat(cur.slice(1));
        else continue;
        pool_.splice(i, 1); changed = true; break;
      }
    }
    if (near(cur[0], cur[cur.length - 1]) && cur.length > 3) rings.push(cur);
  }
  return rings;
}
function chainWays(ws) {
  if (!ws.length) return [];
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let path = ws[0].slice();
  for (let i = 1; i < ws.length; i++) {
    const w = ws[i];
    if (i === 1) { const e = path[path.length - 1], s = path[0]; if (Math.min(d(s, w[0]), d(s, w[w.length - 1])) < Math.min(d(e, w[0]), d(e, w[w.length - 1]))) path.reverse(); }
    const e = path[path.length - 1];
    if (d(e, w[0]) <= d(e, w[w.length - 1])) path.push(...w.slice(1)); else path.push(...w.slice().reverse().slice(1));
  }
  return path;
}
function makeTrack(pts) { const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])); return { pts, cum, len: cum[cum.length - 1] }; }
function sampleTrack(T, s, o) {
  let lo = 0, hi = T.cum.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T.cum[m] <= s) lo = m; else hi = m; }
  const a = T.pts[lo], b = T.pts[hi], seg = (T.cum[hi] - T.cum[lo]) || 1, f = clamp((s - T.cum[lo]) / seg, 0, 1);
  o.x = a[0] + (b[0] - a[0]) * f; o.z = a[1] + (b[1] - a[1]) * f; o.ang = Math.atan2(b[0] - a[0], b[1] - a[1]); return o;
}

// =====================================================================
//  OPSLAG — lokaal. Dit is de naad voor de sociale laag: vervang de
//  methodes hieronder door API-calls (bv. Supabase) met echte accounts.
// =====================================================================
const Store = {
  key(k) { return /^(sound|planQ|night)$/.test(k) ? 'dwaal:' + k : `dwaal:${CITY.id}:${k}`; },
  get(k, d) { try { let v = localStorage.getItem(this.key(k)); if (v == null && CITY.id === 'amsterdam') v = localStorage.getItem('dwaal:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(this.key(k), JSON.stringify(v)); } catch { } },
  user() { return { id: 'local', name: 'Jij' }; },
  routes() { return this.get('routes', []); },
  saveRoute(r) { const all = this.routes().filter(x => x.id !== r.id); const rec = { ...r, author: this.user().name, updated: Date.now() }; all.unshift(rec); this.set('routes', all); return rec; },
  deleteRoute(id) { this.set('routes', this.routes().filter(r => r.id !== id)); },
  reviews(key) { return this.get('rev:' + key, []); },
  addReview(key, rv) { const a = this.reviews(key); a.unshift({ ...rv, author: this.user().name, t: Date.now() }); this.set('rev:' + key, a); },
  stamps() { return this.get('stamps', {}); },
  isVisited(key) { if (!key) return false; if (key.startsWith('g:')) return this.stamps()[key.slice(2)] === 'visited'; return !!this.get('visited', {})[key]; },
  setVisited(key, on) {
    if (key.startsWith('g:')) { const st = this.stamps(), id = key.slice(2); if (on) st[id] = 'visited'; else if (st[id] === 'visited') st[id] = 'seen'; this.set('stamps', st); }
    else { const v = this.get('visited', {}); if (on) v[key] = 1; else delete v[key]; this.set('visited', v); }
  },
  stamp(id, level) { const s = this.stamps(); const cur = s[id]; if (cur === 'visited' || cur === level) return false; s[id] = level; this.set('stamps', s); return true; },
};

// IndexedDB-cache voor zware kaartdata
const idb = {
  db: null,
  open() { if (this.db) return this.db; return this.db = new Promise((res, rej) => { const r = indexedDB.open('dwaal-cache', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async get(k) { try { const db = await this.open(); return await new Promise(res => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); }); } catch { return undefined; } },
  async set(k, v) { try { const db = await this.open(); await new Promise(res => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = res; tx.onerror = res; }); } catch { } },
};
async function cached(key, fn) {
  const k = `${CFG.cacheVersion}:${CFG.center.lat},${CFG.center.lon},${R}:${key}`;
  const hit = await idb.get(k);
  if (hit && Date.now() - hit.t < CFG.cacheDays * 864e5) return hit.v;
  const v = await fn(); if (v) idb.set(k, { t: Date.now(), v }); return v;
}

// =====================================================================
//  GELUID — alles gesynthetiseerd met WebAudio, geen bestanden nodig
// =====================================================================
const Sound = {
  ctx: null, master: null, amb: null, nb: null, on: Store.get('sound', true),
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const C = window.AudioContext || window.webkitAudioContext; if (!C) return;
    this.ctx = new C(); this.master = this.ctx.createGain(); this.master.gain.value = this.on ? .6 : 0; this.master.connect(this.ctx.destination);
    const n = this.ctx.sampleRate * 2, b = this.ctx.createBuffer(1, n, this.ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1; this.nb = b;
    // ambient: kabbelend water
    const s = this.ctx.createBufferSource(); s.buffer = b; s.loop = true;
    const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420;
    const g = this.ctx.createGain(); g.gain.value = .0;
    const lfo = this.ctx.createOscillator(); lfo.frequency.value = .17; const lg = this.ctx.createGain(); lg.gain.value = .004;
    lfo.connect(lg).connect(g.gain); s.connect(lp).connect(g).connect(this.master); s.start(); lfo.start(); this.amb = g;
  },
  set(on) { this.on = on; Store.set('sound', on); if (this.master) this.master.gain.setTargetAtTime(on ? .6 : 0, this.ctx.currentTime, .08); },
  ambient(v) { if (this.amb) this.amb.gain.setTargetAtTime(v, this.ctx.currentTime, .5); },
  tone(f, dur, o = {}) {
    if (!this.ctx || !this.on) return; const { type = 'sine', vol = .14, delay = 0, slide = null, attack = .006 } = o;
    const t = this.ctx.currentTime + delay, osc = this.ctx.createOscillator(), g = this.ctx.createGain();
    osc.type = type; osc.frequency.setValueAtTime(f, t); if (slide) osc.frequency.exponentialRampToValueAtTime(slide, t + dur * .8);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + attack); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
    osc.connect(g).connect(this.master); osc.start(t); osc.stop(t + dur + .05);
  },
  noise(dur, o = {}) {
    if (!this.ctx || !this.on) return; const { vol = .08, f0 = 400, f1 = 2000, q = .9, delay = 0 } = o;
    const t = this.ctx.currentTime + delay, s = this.ctx.createBufferSource(); s.buffer = this.nb;
    const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = q; bp.frequency.setValueAtTime(f0, t); bp.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = this.ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + dur * .3); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
    s.connect(bp).connect(g).connect(this.master); s.start(t, Math.random()); s.stop(t + dur + .05);
  },
  gull() { const b = 1250 + Math.random() * 300; this.tone(b, .32, { type: 'triangle', vol: .022, slide: b * .62 }); this.tone(b * 1.05, .26, { type: 'triangle', vol: .018, slide: b * .7, delay: .36 }); if (Math.random() < .5) this.tone(b * .98, .22, { type: 'triangle', vol: .014, slide: b * .68, delay: .66 }); },
  click() { this.tone(760, .09, { vol: .09, slide: 540 }); },
  pop() { this.tone(380, .14, { vol: .16, slide: 900, type: 'triangle' }); },
  whoosh() { this.noise(.7, { vol: .05, f0: 260, f1: 1600, q: .6 }); },
  open() { this.noise(.3, { vol: .05, f0: 500, f1: 2600 }); this.tone(988, .45, { vol: .06, delay: .07, type: 'triangle' }); this.tone(1319, .55, { vol: .045, delay: .14, type: 'triangle' }); },
  layer(on) { (on ? [523, 659, 784] : [784, 659, 523]).forEach((f, i) => this.tone(f, .22, { vol: .06, delay: i * .055, type: 'triangle' })); },
  bell() { [0, .24].forEach(d => [1, 2.76, 5.4].forEach((m, i) => this.tone(1150 * m, .9, { vol: .07 / (i + 1), delay: d }))); },
  stamp() { this.noise(.12, { vol: .22, f0: 220, f1: 110, q: .5 }); [784, 1047, 1319, 1568].forEach((f, i) => this.tone(f, .45, { vol: .06, delay: .12 + i * .075, type: 'triangle' })); },
  drop() { this.tone(520, .1, { vol: .12, slide: 260 }); this.tone(1040, .25, { vol: .06, delay: .08, type: 'triangle' }); },
};

// =====================================================================
//  SCENE
// =====================================================================
const canvas = $('#c');
let renderer;
try { renderer = new THREE.WebGLRenderer({ canvas, antialias: false, stencil: true, powerPreference: 'high-performance' }); }
catch (e) { $('#lstat').textContent = 'Deze browser ondersteunt geen WebGL. Probeer een recente Chrome, Safari of Firefox.'; throw e; }
// resolutie past zich aan aan de framerate (zie Perf), start op een verstandig niveau
const PR_MAX = Math.min(devicePixelRatio, isMobile ? 1.5 : 1.75), PR_MIN = Math.min(1, PR_MAX);
renderer.setPixelRatio(Math.min(PR_MAX, isMobile ? 1.25 : 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;   // de zon staat stil: schaduwkaart alleen opnieuw als er gebouwen bij/af komen
const Shadow = { want: true, last: 0, request() { this.want = true; }, tick(now) { if (this.want && now - this.last > 700) { renderer.shadowMap.needsUpdate = true; this.want = false; this.last = now; } } };
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.2;

const scene = new THREE.Scene();
const SKY = new THREE.Color('#D6E2E0'), NIGHT = new THREE.Color('#15232A');
scene.background = SKY.clone(); scene.fog = new THREE.Fog(SKY.clone(), R * 2.6, R * 6);
const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 3, R * 10);
camera.position.set(0, R * 2.8, R * 2.6);
const controls = new MapControls(camera, canvas);
Object.assign(controls, { enableDamping: true, dampingFactor: .085, maxPolarAngle: 1.32, minDistance: 45, maxDistance: R * 3.4, screenSpacePanning: false, zoomToCursor: true, zoomSpeed: 1.2 });

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), .04).texture;

const hemi = new THREE.HemisphereLight('#F5F1E6', '#62756D', .6); scene.add(hemi);
const sun = new THREE.DirectionalLight('#FFE6C4', 1.3);
sun.position.set(-1500, 2300, 1000); sun.castShadow = true;
sun.shadow.mapSize.set(isMobile ? 1024 : 4096, isMobile ? 1024 : 4096);
Object.assign(sun.shadow.camera, { left: -R - 250, right: R + 250, top: R + 250, bottom: -R - 250, near: 100, far: 9000 });
sun.shadow.bias = -.0005; scene.add(sun, sun.target);

function clipToRadius(mat) {
  mat.onBeforeCompile = sh => {
    sh.uniforms.uClipR = { value: R };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vClipW;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvClipW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vClipW;\nuniform float uClipR;')
      .replace('void main() {', 'void main() {\n  if (length(vClipW.xz) > uClipR) discard;');
  };
  return mat;
}
function waterNormalMap() {
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d'), img = g.createImageData(S, S), T = Math.PI * 2 / S;
  const h = (x, y) => Math.sin(x * T * 3 + Math.sin(y * T * 2) * 1.5) * .5 + Math.sin(y * T * 5 + x * T) * .35 + Math.sin((x + y) * T * 7) * .2 + Math.sin((x - 2 * y) * T * 4) * .25 + Math.sin((3 * x + y) * T * 9) * .08;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = h(x + 1, y) - h(x - 1, y), dy = h(x, y + 1) - h(x, y - 1); let nx = -dx * 2.2, ny = -dy * 2.2, nz = 1; const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const i = (y * S + x) * 4; img.data[i] = (nx * .5 + .5) * 255; img.data[i + 1] = (ny * .5 + .5) * 255; img.data[i + 2] = (nz * .5 + .5) * 255; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0); const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
}
const M = {
  ground: new THREE.MeshStandardMaterial({ color: '#CBC7B6', roughness: 1, envMapIntensity: .3 }),
  street: new THREE.MeshStandardMaterial({ color: '#EEEADF', roughness: .95, envMapIntensity: .3, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  park: clipToRadius(new THREE.MeshStandardMaterial({ color: '#9DB67F', roughness: 1, envMapIntensity: .3, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })),
  water: clipToRadius(new THREE.MeshStandardMaterial({ color: '#4A8FA0', roughness: .14, metalness: .05, envMapIntensity: 1.1, normalMap: waterNormalMap(), normalScale: new THREE.Vector2(.32, .32) })),
  tree: new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: .9, envMapIntensity: .3 }),
  plinth: new THREE.MeshStandardMaterial({ color: '#2E5E57', roughness: .75, envMapIntensity: .4 }),
};
M.building = makeTileMaterial();
const baseCol = {}; for (const k in M) baseCol[k] = M[k].color.clone();

// diorama-sokkel
const WATER_Y = CITY.waterY ?? -1.7;   // waterpeil t.o.v. kade (m) - geeft de grachten diepte
M.ground.onBeforeCompile = sh => {
  sh.uniforms.uDist = DIST_U.tex; sh.uniforms.uDistOn = DIST_U.on;
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vGW;').replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
  sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vGW;\nuniform sampler2D uDist;\nuniform float uDistOn;')
    .replace('#include <color_fragment>', `#include <color_fragment>\n  if (uDistOn > 0.0) { vec4 dc = texture2D(uDist, vec2(vGW.x / ${(2 * R).toFixed(1)} + .5, .5 - vGW.z / ${(2 * R).toFixed(1)})); diffuseColor.rgb = mix(diffuseColor.rgb, dc.rgb, dc.a * uDistOn * .7); }`);
};
Object.assign(M.ground, { stencilWrite: true, stencilWriteMask: 0, stencilRef: 1, stencilFunc: THREE.NotEqualStencilFunc });
const ground = new THREE.Mesh(new THREE.CircleGeometry(R, 180).rotateX(-Math.PI / 2), M.ground); ground.receiveShadow = true; ground.renderOrder = -1; scene.add(ground);
// onder de grachten: donkere bodem zodat een doorkijk nooit leeg is
const bed = new THREE.Mesh(new THREE.CircleGeometry(R - 1, 120).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#2F4A4F', roughness: 1 })); bed.position.y = WATER_Y - 1.2; scene.add(bed);
const side = new THREE.Mesh(new THREE.CylinderGeometry(R, R * .992, 70, 180, 1, true), M.plinth); side.position.y = -35.02; scene.add(side);
const bottom = new THREE.Mesh(new THREE.CircleGeometry(R * .992, 180).rotateX(Math.PI / 2), M.plinth); bottom.position.y = -70; scene.add(bottom);
const rim = new THREE.Mesh(new THREE.RingGeometry(R - .5, R + 7, 180).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#F3F4EF', roughness: .6 })); rim.position.y = .05; scene.add(rim);

// postprocessing (bloom voor gloed)
const rtMain = new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, stencilBuffer: true, depthBuffer: true });
const composer = new EffectComposer(renderer, rtMain);
composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(innerWidth, innerHeight);
composer.addPass(new RenderPass(scene, camera));
// vangnet: ongeldige pixels (NaN/Inf) nooit doorgeven aan bloom, anders ontstaan zwarte blokken
composer.addPass(new ShaderPass({
  uniforms: { tDiffuse: { value: null } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: 'uniform sampler2D tDiffuse; varying vec2 vUv; void main(){ vec4 c = texture2D(tDiffuse, vUv); bool bad = any(isnan(c)) || any(isinf(c)) || c.r != c.r || c.g != c.g || c.b != c.b; gl_FragColor = bad ? vec4(0.82, 0.8, 0.76, 1.0) : clamp(c, 0.0, 12.0); }',
}));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), .75, .55, 1.75);
{ const set = bloom.setSize.bind(bloom); bloom.setSize = (w, h) => set(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2))); bloom.setSize(innerWidth * renderer.getPixelRatio(), innerHeight * renderer.getPixelRatio()); }
composer.addPass(bloom); composer.addPass(new OutputPass());
const lineMats = new Set();
function regLineMat(m) { m.resolution.set(innerWidth, innerHeight); lineMats.add(m); return m; }

// =====================================================================
//  DATA LADEN
// =====================================================================
async function overpass(q, pref = 0) {
  let err; const eps = CFG.ep.overpass;
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < eps.length; i++) {
      const ep = eps[(pref + i) % eps.length];
      try {
        const j = await fetchJSON(ep, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 90000);
        if (!j || !Array.isArray(j.elements)) throw new Error('leeg antwoord');
        if (j.remark && /runtime error|timed out|out of memory/i.test(j.remark) && !j.elements.length) throw new Error(j.remark);
        return j;
      } catch (e) { err = e; console.warn('Overpass', ep, e.message); }
    }
    await new Promise(r => setTimeout(r, 4000));
  }
  throw err;
}
const Q_GEO = `[out:json][timeout:120];
(
 way["natural"="water"](${OBB}); relation["natural"="water"](${OBB});
 way["waterway"="riverbank"](${OBB});
 way["leisure"~"^(park|garden)$"](${OBB}); relation["leisure"="park"](${OBB});
 way["landuse"~"^(grass|recreation_ground)$"](${OBB});
 way["highway"~"^(primary|secondary|tertiary|unclassified|residential|living_street|pedestrian|service)$"]["area"!="yes"](${OBB});
 way["waterway"~"^(canal|river)$"](${OBB});
 way["natural"="coastline"](${OBB});
 way["amenity"="marketplace"](${OBB}); relation["amenity"="marketplace"](${OBB});
);
out geom;
node["natural"="tree"](${OBB});
out skel qt;`;
const Q_POI = `[out:json][timeout:120];
(
 nwr["tourism"~"^(museum|attraction|viewpoint)$"](${OBB});
 nwr["historic"~"^(monument|city_gate|tower|castle)$"](${OBB});
 nwr["amenity"~"^(theatre|cinema|arts_centre|music_venue|concert_hall|marketplace|ferry_terminal)$"](${OBB});
 nwr["shop"="department_store"](${OBB});
 nwr["leisure"~"^(park|garden)$"]["name"](${OBB});
 node["highway"="bus_stop"](${OBB});
 nwr["railway"~"^(station|tram_stop|subway_entrance)$"](${OBB});
 node["station"="subway"](${OBB});
);
out center tags;`;
const Q_FOOD = `[out:json][timeout:120];nwr["amenity"~"^(cafe|bar|pub|biergarten|restaurant|fast_food|ice_cream)$"](${OBB});out center tags;`;
const Q_TRANSIT = `[out:json][timeout:120];relation["route"~"^(tram|subway|ferry|light_rail)$"](${OBB});out geom;relation["route"="bus"](${OBB});out body;`;

// =====================================================================
//  WERELD: gebouwen
// =====================================================================
class Buf {
  constructor(n = 1 << 16) { this.p = new Float32Array(n * 3); this.c = new Uint8Array(n * 3); this.n = 0; }
  grow() { const p = new Float32Array(this.p.length * 2); p.set(this.p); this.p = p; const c = new Uint8Array(this.c.length * 2); c.set(this.c); this.c = c; }
  v(x, y, z, c) { if ((this.n + 1) * 3 > this.p.length) this.grow(); const i = this.n * 3; this.p[i] = x; this.p[i + 1] = y; this.p[i + 2] = z; this.c[i] = c[0]; this.c[i + 1] = c[1]; this.c[i + 2] = c[2]; this.n++; }
  geometry() { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(this.p.slice(0, this.n * 3), 3)); g.setAttribute('color', new THREE.BufferAttribute(this.c.slice(0, this.n * 3), 3, true)); g.computeBoundingSphere(); g.computeBoundingBox(); return g; }
}
function extrude(buf, rings, h, wall, roof, y0) {
  const wallLo = [wall[0] * .68 | 0, wall[1] * .68 | 0, wall[2] * .7 | 0];
  const Rr = rings.map((r, i) => { const pts = []; for (let k = 0; k < r.length; k += 2) pts.push([r[k], r[k + 1]]); const a = ringArea(pts); if ((i === 0 && a < 0) || (i > 0 && a > 0)) pts.reverse(); return pts; });
  for (const pts of Rr) for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    buf.v(p[0], y0, p[1], wallLo); buf.v(q[0], h, q[1], wall); buf.v(q[0], y0, q[1], wallLo);
    buf.v(p[0], y0, p[1], wallLo); buf.v(p[0], h, p[1], wall); buf.v(q[0], h, q[1], wall);
  }
  const contour = Rr[0].map(p => new THREE.Vector2(p[0], p[1])), holes = Rr.slice(1).map(r => r.map(p => new THREE.Vector2(p[0], p[1])));
  let tris; try { tris = THREE.ShapeUtils.triangulateShape(contour, holes); } catch { return; }
  const all = contour.concat(...holes);
  for (const t of tris) {
    let A = all[t[0]], B = all[t[1]], C = all[t[2]]; if (!A || !B || !C) continue;
    if ((B.y - A.y) * (C.x - A.x) - (B.x - A.x) * (C.y - A.y) < 0) { const s = B; B = C; C = s; }
    buf.v(A.x, h, A.y, roof); buf.v(B.x, h, B.y, roof); buf.v(C.x, h, C.y, roof);
  }
}
// =====================================================================
//  WERELD: gebouwen als gestreamde 3DBAG 3D Tiles (LoD2.2)
// =====================================================================
const DIST_U = { tex: { value: null }, on: { value: 0 } };
// exacte gebouwmarkering: per vertex een code (0 = geen, 1..12 = kleur uit deze lijst)
const NIGHT_U = { value: 0 };
const FAR_U = { tex: { value: null } };   // verre markeringen: kleurvlekken op een kaart over de hele stad
const HL_U = { col: { value: Array.from({ length: 12 }, () => new THREE.Color('#ffffff')) }, glow: { value: .35 } };
function makeTileMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: .88, metalness: 0, envMapIntensity: .35, flatShading: true, side: THREE.DoubleSide });
  const pal = ['#FBFBF9', '#F8F8F6', '#F6F6F3', '#FAFAF8', '#F7F7F4', '#FCFCFA', '#F5F5F2', '#F9F9F7'].map(c => new THREE.Color(c));   // neutraal wit, minimale variatie
  m.onBeforeCompile = sh => {
    sh.uniforms.uPal = { value: pal }; sh.uniforms.uDist = DIST_U.tex; sh.uniforms.uDistOn = DIST_U.on; sh.uniforms.uRoof = { value: new THREE.Color('#FFFFFF') }; sh.uniforms.uSlate = { value: new THREE.Color('#ECEBE8') }; sh.uniforms.uNight = NIGHT_U; sh.uniforms.uHlCol = HL_U.col; sh.uniforms.uHlGlow = HL_U.glow; sh.uniforms.uClipR = { value: R }; sh.uniforms.uFar = FAR_U.tex;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float fid;\nattribute float hl;\nvarying float vFid;\nvarying float vHl;\nvarying float vUp;\nvarying vec3 vW;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvFid = fid; vHl = hl;\nvec3 wN = mat3(modelMatrix) * objectNormal; vUp = dot(wN, wN) > 1e-8 ? normalize(wN).y : 1.0;\nvW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uDist;\nuniform float uDistOn;\nuniform vec3 uPal[8];\nuniform vec3 uRoof;\nuniform vec3 uSlate;\nuniform float uClipR;\nuniform vec3 uHlCol[12];\nuniform float uHlGlow;\nuniform float uNight;\nuniform sampler2D uFar;\nvarying float vFid;\nvarying float vHl;\nvarying float vUp;\nvarying vec3 vW;')
      .replace('void main() {', 'void main() {\n  if (length(vW.xz) > uClipR) discard;')
      // LoD2-tiles bevatten soms gedegenereerde driehoeken: flat shading geeft dan NaN-normalen,
      // en bloom smeert die NaN-pixels uit tot zwarte blokken. Hier vangen we dat af.
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n  if (any(isnan(normal)) || dot(normal, normal) < 1e-8) normal = vec3(0.0, 0.0, 1.0);')
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n  if (any(isnan(gl_FragColor)) || any(isinf(gl_FragColor))) gl_FragColor = vec4(0.8, 0.78, 0.74, 1.0);\n  gl_FragColor.rgb = min(gl_FragColor.rgb, vec3(1.6));')
      .replace('#include <color_fragment>', `#include <color_fragment>
  vec3 _fdx = dFdx(vW), _fdy = dFdy(vW); float upF = abs(normalize(cross(_fdx, _fdy)).y);
  float hh = fract(sin(vFid * 12.9898 + 78.233) * 43758.5453);
  vec3 wallC = uPal[int(floor(hh * 7.999))];
  vec3 roofC = mix(wallC, fract(hh * 7.0) > .66 ? uSlate : uRoof, .5);
  vec3 cc = upF > .55 ? roofC : wallC;
  cc *= mix(.8, 1.0, smoothstep(0.0, 7.0, vW.y));
  if (uDistOn > 0.0) { vec4 dc = texture2D(uDist, vec2(vW.x / (2.0 * uClipR) + .5, .5 - vW.z / (2.0 * uClipR))); cc = mix(cc, dc.rgb * 1.15, dc.a * uDistOn * .6); }
  float hSel = step(19.5, vHl), hC = vHl - 20. * hSel;   // 20+ = geselecteerd: eigen laagkleur, extra gloed
  if (hC > .5) cc = mix(cc, uHlCol[int(hC + .5) - 1], .92);
  vec3 farC = vec3(0.0);   // blokken op afstand (hl = -1): kleur uit de markeringskaart
  if (vHl < -.5) { vec4 fc = texture2D(uFar, vec2(vW.x / (2.0 * uClipR) + .5, .5 - vW.z / (2.0 * uClipR))); float fa = smoothstep(.3, .6, fc.a); farC = fc.rgb * fa; cc = mix(cc, fc.rgb, .92 * fa); }
  diffuseColor.rgb *= cc;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  if (hC > .5) totalEmissiveRadiance += uHlCol[int(hC + .5) - 1] * uHlGlow * (1. + 1.6 * hSel);
  totalEmissiveRadiance += farC * uHlGlow * 1.8;
  if (uNight > .01 && upF < .45 && vW.y > 2.5) {
    vec2 g = vec2((vW.x + vW.z) / 2.7, vW.y / 3.1), c = floor(g), f = fract(g);
    float r = fract(sin(dot(c + vec2(vFid * .371, vFid * .113), vec2(12.9898, 78.233))) * 43758.5453);
    float win = step(.22, f.x) * step(f.x, .78) * step(.28, f.y) * step(f.y, .82);
    totalEmissiveRadiance += vec3(1.0, .74, .42) * step(.6, r) * win * uNight * (1.1 + r);
  }`);
  };
  return m;
}
const DOWN = new THREE.Vector3(0, -1, 0);
const Tiles = {
  r: null, meshes: new Set(), list: [], dirty: true, version: 0, hasIds: false, bvhQ: [], base: new THREE.Matrix4(), h: 0, calibrated: false, firstT: 0, onReady: null, failed: 0,
  setOffset(h) { this.h = h; this.r.group.matrix.makeTranslation(0, -h, 0).multiply(this.base); this.r.group.matrixWorldNeedsUpdate = true; for (const o of this.meshes) o.userData.box = null; this.dirty = true; },
  onModel(obj) {
    obj.traverse(o => {
      if (!o.isMesh) return; const g = o.geometry; if (!g.attributes.normal) g.computeVertexNormals();
      const src = g.attributes._feature_id_0 || g.attributes._batchid, n = g.attributes.position.count, seed = hash(o.uuid) % 997, f = new Float32Array(n);
      if (src) { const ids = new Float32Array(n); for (let i = 0; i < n; i++) { ids[i] = src.getX(i); f[i] = ids[i] + seed * 1000; } o.userData.srcId = ids; this.hasIds = true; } else f.fill(seed);
      g.setAttribute('fid', new THREE.BufferAttribute(f, 1));
      g.setAttribute('hl', new THREE.BufferAttribute(new Float32Array(n), 1));
      o.material = M.building; o.castShadow = true; o.receiveShadow = true; this.meshes.add(o); this.bvhQ.push(o);
    });
    if (!this.firstT) this.firstT = performance.now();
    this.dirty = true;
  },
  attached(o) { if (!this.r) return !!o.parent; for (let p = o; p; p = p.parent) if (p === this.r.group) return true; return false; },
  measure(o) {
    const b = (o.userData.box = new THREE.Box3()).setFromObject(o, true);
    const dx = Math.max(b.min.x, 0, -b.max.x), dz = Math.max(b.min.z, 0, -b.max.z);
    o.visible = Math.hypot(dx, dz) < R;
    if (o.visible) HL.meshReady(o);
  },
  refresh() {
    if (this.r) this.r.update();
    // BVH's opbouwen in kleine porties (max ~4 ms per frame), dichtbij eerst
    const t0 = performance.now();
    while (this.bvhQ.length && performance.now() - t0 < 4) { const o = this.bvhQ.pop(); if (this.meshes.has(o) && !o.geometry.boundsTree) o.geometry.computeBoundsTree(); }
    if (!this.dirty) return; this.dirty = false; this.version++; Shadow.request();
    this.r?.group.updateMatrixWorld(true); this.list.length = 0;
    for (const o of this.meshes) { if (!this.attached(o)) continue; if (!o.userData.box) this.measure(o); if (o.visible) this.list.push(o); }
    if (!this.calibrated) this.calibrate();
  },
  calibrate() {
    const mins = []; for (const o of this.list) { const b = o.userData.box, cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2; if (cx * cx + cz * cz < 1700 * 1700) mins.push(b.min.y); }
    const waited = this.firstT && performance.now() - this.firstT > 5000;
    if (mins.length >= 6 || (mins.length && waited)) {
      mins.sort((a, b) => a - b);
      this.calibrated = true; this.setOffset(this.h + mins[Math.floor(mins.length * .5)] + .6);   // mediaan: gebouwen staan op de plaat, iets erin gezakt
      this.r.group.visible = true; this.onReady?.();
    } else if (!mins.length || !waited) this.dirty = true;   // opnieuw proberen volgende frame
  },
  get progress() { return Baked.progress; },
};
const downRay = new THREE.Raycaster(), _ro = new THREE.Vector3();
function roofAt(x, z) {
  if (!Tiles.calibrated) return null;
  const cand = Tiles.list.filter(o => { const b = o.userData.box; return b && x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z; });
  if (!cand.length) return null;
  for (const o of cand) if (!o.geometry.boundsTree) o.geometry.computeBoundsTree();
  downRay.firstHitOnly = true; downRay.set(_ro.set(x, 800, z), DOWN); const h = downRay.intersectObjects(cand, false);
  return h.length ? h[0].point.y : null;
}

// =====================================================================
//  WERELD: water, groen, straten, bomen, boten
// =====================================================================
function osmPolys(els, filter) {
  const polys = [];
  const inRange = ring => { let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; for (const p of ring) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); } const dx = Math.max(x0, 0, -x1), dz = Math.max(z0, 0, -z1); return Math.hypot(dx, dz) < R; };
  for (const el of els) {
    const t = el.tags || {}; if (!filter(t)) continue;
    if (el.type === 'way' && (el.geometry || el.L)) { const r = ptsOf(el); if (r.length > 3 && near(r[0], r[r.length - 1], .01) && inRange(r)) polys.push({ outer: r, holes: [] }); }
    else if (el.type === 'relation' && el.members) {
      const outs = [], ins = [];
      for (const m of el.members) { if (m.type !== 'way' || !(m.geometry || m.L)) continue; const w = ptsOf(m); (m.role === 'inner' ? ins : outs).push(w); }
      const O = joinRings(outs).filter(inRange), I = joinRings(ins); if (!O.length) continue;
      const mine = O.map(o => ({ outer: o, holes: [] })); for (const h of I) { const p = mine.find(pp => pip(h[0], pp.outer)); if (p) p.holes.push(h); } polys.push(...mine);
    }
  }
  return polys;
}
function flatMesh(polys, y, mat, uvScale = 70) {
  const pos = [], uv = [];
  for (const P of polys) {
    const c = P.outer.map(p => new THREE.Vector2(p[0], p[1])), hs = P.holes.map(h => h.map(p => new THREE.Vector2(p[0], p[1])));
    let tris; try { tris = THREE.ShapeUtils.triangulateShape(c, hs); } catch { continue; }
    const all = c.concat(...hs);
    for (const t of tris) {
      let A = all[t[0]], B = all[t[1]], C = all[t[2]]; if (!A || !B || !C) continue;
      if ((B.y - A.y) * (C.x - A.x) - (B.x - A.x) * (C.y - A.y) < 0) { const s = B; B = C; C = s; }
      for (const V of [A, B, C]) { pos.push(V.x, y, V.y); uv.push(V.x / uvScale, V.y / uvScale); }
    }
  }
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  const n = new Float32Array(pos.length); for (let i = 1; i < n.length; i += 3) n[i] = 1; g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
  const m = new THREE.Mesh(g, mat); m.receiveShadow = true; scene.add(m); return m;
}
const STREET_W = { primary: 11, secondary: 10, tertiary: 8, unclassified: 6, residential: 6, living_street: 5, pedestrian: 6, service: 3.5 };
function streetMesh(els) {
  const pos = [];
  for (const el of els) {
    const t = el.tags || {}; if (el.type !== 'way' || !t.highway || !(t.highway in STREET_W) || !(el.geometry || el.L)) continue;
    const w = STREET_W[t.highway] / 2, y = t.bridge ? 1.1 : .25, pts = ptsOf(el);
    for (let i = 1; i < pts.length; i++) {
      const s = clipSeg(pts[i - 1], pts[i], R - 1); if (!s) continue;
      let [a, b] = s; const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1, ux = dx / L, uz = dz / L, nx = -uz * w, nz = ux * w;
      a = [a[0] - ux * w * .9, a[1] - uz * w * .9]; b = [b[0] + ux * w * .9, b[1] + uz * w * .9];
      const p1 = [a[0] + nx, a[1] + nz], p2 = [a[0] - nx, a[1] - nz], p3 = [b[0] - nx, b[1] - nz], p4 = [b[0] + nx, b[1] + nz];
      for (const [A, B, C] of [[p1, p2, p3], [p1, p3, p4]]) {
        let BB = B, CC = C; if ((BB[1] - A[1]) * (CC[0] - A[0]) - (BB[0] - A[0]) * (CC[1] - A[1]) < 0) { const s2 = BB; BB = CC; CC = s2; }
        pos.push(A[0], y, A[1], BB[0], y, BB[1], CC[0], y, CC[1]);
      }
    }
  }
  if (!pos.length) return;
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const n = new Float32Array(pos.length); for (let i = 1; i < n.length; i += 3) n[i] = 1; g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
  const m = new THREE.Mesh(g, M.street); m.receiveShadow = true; scene.add(m);
}
function treeMesh(els) {
  const pts = []; for (const el of els) if (el.type === 'node' && !el.tags && (el.L || el.lat)) { const [x, z] = el.L || toLocal(el.lat, el.lon); if (x * x + z * z < (R - 4) ** 2) pts.push([x, z]); }
  if (!pts.length) return;
  const col = (g, c) => { const n = g.attributes.position.count, a = new Float32Array(n * 3), C = new THREE.Color(c); for (let i = 0; i < n; i++) { a[i * 3] = C.r; a[i * 3 + 1] = C.g; a[i * 3 + 2] = C.b; } g.setAttribute('color', new THREE.BufferAttribute(a, 3)); return g; };
  const trunk = col(new THREE.CylinderGeometry(.3, .45, 4, 5).translate(0, 2, 0).toNonIndexed(), '#6B5040');
  const crown = col(new THREE.IcosahedronGeometry(3, 0).scale(1, 1.15, 1).translate(0, 6.3, 0), '#739E57');
  const geo = mergeGeometries([trunk, crown]);
  const n = Math.min(pts.length, isMobile ? 16000 : 30000), im = new THREE.InstancedMesh(geo, M.tree, n);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const [x, z] = pts[i], hh = hash(i + ':' + x), k = .7 + (hh % 60) / 100;
    q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, (hh % 628) / 100); s.set(k, k * (.9 + (hh % 30) / 100), k); p.set(x, 0, z);
    im.setMatrixAt(i, m4.compose(p, q, s)); c.setHSL(.24 + (hh % 40) / 1000, .35 + (hh % 20) / 100, .78 + (hh % 25) / 100); im.setColorAt(i, c);
  }
  im.castShadow = !isMobile; im.receiveShadow = true; scene.add(im);
}
// bewegende dingen: rondvaartboten, trams, ponten
const Movers = [];
const tmpS = { x: 0, z: 0, ang: 0 };
function addMover(mesh, pts, speed, y, opts = {}) { const T = makeTrack(pts); if (T.len < 150) return null; const mv = { mesh, T, s: (hash(T.len) % 1000) / 1000 * T.len, speed, dir: opts.dir || 1, y, pingpong: opts.pingpong !== false }; scene.add(mesh); Movers.push(mv); return mv; }
function boatMesh(big = false) {
  const g = new THREE.Group(), L = big ? 32 : 13, W = big ? 8 : 3.2;
  const hull = new THREE.Mesh(new THREE.BoxGeometry(W, 1.3, L), new THREE.MeshStandardMaterial({ color: big ? '#F0EEE7' : '#2C3A3E', roughness: .6 })); hull.position.y = .65;
  const cab = new THREE.Mesh(new THREE.BoxGeometry(W * .8, big ? 2.6 : 1.3, L * .62), new THREE.MeshStandardMaterial({ color: big ? '#3E7BF0' : '#A9CFD6', roughness: .15, metalness: .1, envMapIntensity: 1.2 })); cab.position.y = big ? 2.6 : 1.9;
  g.add(hull, cab); return g;
}
function canalBoats(els) {
  const lines = []; for (const el of els) { if (el.type !== 'way' || !/^(canal|river)$/.test(el.tags?.waterway || '') || !(el.geometry || el.L)) continue; const pts = ptsOf(el).filter(p => p[0] * p[0] + p[1] * p[1] < (R - 20) ** 2); if (pts.length > 2) lines.push(pts); }
  lines.sort((a, b) => makeTrack(b).len - makeTrack(a).len);
  lines.slice(0, isMobile ? 10 : 18).forEach((pts, i) => addMover(boatMesh(false), pts, 2.2 + (i % 3) * .5, WATER_Y - .15, { dir: i % 2 ? 1 : -1 }));
}
function quayWalls(polys) {
  const pos = [], top = .06, bot = WATER_Y - .4, rim = [];
  for (const P of polys) for (const ring of [P.outer, ...P.holes]) for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1], b = ring[i]; if (a[0] * a[0] + a[1] * a[1] > (R + 20) ** 2 && b[0] * b[0] + b[1] * b[1] > (R + 20) ** 2) continue;
    pos.push(a[0], bot, a[1], b[0], top, b[1], b[0], bot, b[1], a[0], bot, a[1], a[0], top, a[1], b[0], top, b[1]);
  }
  if (!pos.length) return;
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const m = new THREE.Mesh(g, clipToRadius(new THREE.MeshStandardMaterial({ color: '#8E8577', roughness: .95, flatShading: true, side: THREE.DoubleSide, envMapIntensity: .3 })));
  m.receiveShadow = true; scene.add(m); M.quay = m.material; baseCol.quay = m.material.color.clone();
}
// ---------- leven: fietsers en meeuwen ----------
const Life = { bikes: null, bikeT: [], gulls: null, gullP: [] };
function addLife(els) {
  const ways = [];
  for (const el of els) { const t = el.tags || {}; if (el.type !== 'way' || !/^(residential|living_street|tertiary|secondary|unclassified)$/.test(t.highway || '') || !(el.geometry || el.L)) continue; const pts = ptsOf(el).filter(p => p[0] * p[0] + p[1] * p[1] < (R - 30) ** 2); if (pts.length > 1) { const T = makeTrack(pts); if (T.len > 120) ways.push(T); } }
  const nB = Math.min(ways.length, isMobile ? 45 : 110);
  if (nB) {
    const cabs = CITY.life?.vehicles === 'cabs', g = cabs ? new THREE.BoxGeometry(2, 1.6, 4.8).translate(0, .9, 0) : new THREE.BoxGeometry(.9, 1.7, 2.1).translate(0, 1.1, 0);
    Life.bikes = new THREE.InstancedMesh(g, new THREE.MeshStandardMaterial({ roughness: .7 }), nB);
    const cols = cabs ? ['#F7C325', '#F7C325', '#F7C325', '#1D2A2E', '#F3F4EF'] : ['#D7262C', '#2E5E57', '#F2C230', '#3E7BF0', '#1D2A2E', '#E0487F', '#F3F4EF'], c = new THREE.Color();
    for (let i = 0; i < nB; i++) { const T = ways[(i * 7919) % ways.length]; Life.bikeT.push({ T, s: Math.random() * T.len, v: 3.5 + Math.random() * 2.5, dir: Math.random() < .5 ? 1 : -1 }); Life.bikes.setColorAt(i, c.set(cols[i % cols.length])); }
    scene.add(Life.bikes);
  }
  // meeuwen cirkelen boven het water
  const nG = isMobile ? 22 : 40, wg = new THREE.BufferGeometry();
  wg.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, .6, -2.6, .7, -.2, 0, 0, -.5, 0, 0, .6, 0, 0, -.5, 2.6, .7, -.2], 3)); wg.computeVertexNormals();
  Life.gulls = new THREE.InstancedMesh(wg, new THREE.MeshStandardMaterial({ color: '#FAFAF7', side: THREE.DoubleSide, roughness: .6 }), nG);
  const spots = []; for (const el of els) if (el.type === 'way' && /^(canal|river)$/.test(el.tags?.waterway || '') && (el.geometry || el.L)) for (const q of ptsOf(el)) { if (q[0] * q[0] + q[1] * q[1] < (R - 150) ** 2) spots.push(q); }
  for (let i = 0; i < nG; i++) { const c = spots.length ? spots[(i * 104729) % spots.length] : [(Math.random() - .5) * R, (Math.random() - .5) * R]; Life.gullP.push({ cx: c[0] + (Math.random() - .5) * 60, cz: c[1] + (Math.random() - .5) * 60, r: 18 + Math.random() * 45, h: 28 + Math.random() * 40, w: (.18 + Math.random() * .25) * (Math.random() < .5 ? 1 : -1), ph: Math.random() * 7, f: 5 + Math.random() * 3 }); }
  scene.add(Life.gulls);
}
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1), _e = new THREE.Euler();
function tickLife(t, dt) {
  if (Life.bikes) Life.bikeT.forEach((b, i) => {
    b.s += b.v * dt * b.dir * (CITY.life?.vehicles === 'cabs' ? 1.8 : 1); if (b.s > b.T.len) { b.s = b.T.len; b.dir = -1; } else if (b.s < 0) { b.s = 0; b.dir = 1; }
    sampleTrack(b.T, b.s, tmpS); const side = b.dir > 0 ? 1.6 : -1.6, ca = Math.cos(tmpS.ang), sa = Math.sin(tmpS.ang);
    _p.set(tmpS.x + ca * side, .25, tmpS.z - sa * side); _q.setFromEuler(_e.set(0, tmpS.ang + (b.dir < 0 ? Math.PI : 0), 0)); _s.set(1, 1, 1);
    Life.bikes.setMatrixAt(i, _m4.compose(_p, _q, _s));
  });
  if (Life.bikes) Life.bikes.instanceMatrix.needsUpdate = true;
  if (Life.gulls) {
    Life.gullP.forEach((g, i) => {
      const a = g.ph + t * g.w, flap = Math.sin(t * g.f + g.ph);
      _p.set(g.cx + Math.cos(a) * g.r, g.h + Math.sin(t * .4 + g.ph) * 4, g.cz + Math.sin(a) * g.r);
      _q.setFromEuler(_e.set(0, -a + (g.w > 0 ? Math.PI : 0), (g.w > 0 ? -.25 : .25)));
      let sy = flap > -.2 ? flap : -.2 + (flap + .2) * .3; if (Math.abs(sy) < .08) sy = sy < 0 ? -.08 : .08; _s.set(1.4, 1.4 * sy, 1.4);
      Life.gulls.setMatrixAt(i, _m4.compose(_p, _q, _s));
    });
    Life.gulls.instanceMatrix.needsUpdate = true;
  }
}
function addGeo(json) {
  const els = json.elements || [];
  flatMesh(osmPolys(els, t => /^(park|garden)$/.test(t.leisure) || /^(grass|recreation_ground)$/.test(t.landuse)), .12, M.park, 40);
  Areas.build(els);
  const B = json.base;
  if (B) {
    const P = a => { const r = []; for (let i = 0; i < a.length; i += 2) r.push([a[i], a[i + 1]]); return r; };
    if (B.ground?.length) {
      ground.visible = false;
      const lm = flatMesh(B.ground.map(g => ({ outer: P(g.o), holes: (g.h || []).map(P) })), 0, M.ground, 70); if (lm) lm.renderOrder = -1;
      const sea = new THREE.Mesh(new THREE.CircleGeometry(R, 200).rotateX(-Math.PI / 2), M.water); sea.position.y = WATER_Y; sea.receiveShadow = true;
      const sp = sea.geometry.attributes.position.array, suv = []; for (let i = 0; i < sp.length; i += 3) suv.push(sp[i] / 70, sp[i + 2] / 70); sea.geometry.setAttribute('uv', new THREE.Float32BufferAttribute(suv, 2)); scene.add(sea);
    }
    quayWalls((B.quays || []).map(l => ({ outer: P(l), holes: [] })));
    streetMesh(els); treeMesh(els); canalBoats(els); addLife(els); Shadow.request();
    return;
  }
  const water = osmPolys(els, t => t.natural === 'water' || t.waterway === 'riverbank');
  // steden aan zee of een getijderivier: land uit de kustlijn opbouwen, de rest is water
  const coast = safe(() => coastLand(els), 'kustlijn');
  if (coast && coast.land.length) {
    ground.visible = false;
    const lm = flatMesh(coast.land, 0, M.ground, 70); if (lm) lm.renderOrder = -1;
    const sea = new THREE.Mesh(new THREE.CircleGeometry(R, 180).rotateX(-Math.PI / 2), M.water); sea.position.y = WATER_Y; sea.receiveShadow = true;
    const sp = sea.geometry.attributes.position.array, suv = []; for (let i = 0; i < sp.length; i += 3) suv.push(sp[i] / 70, sp[i + 2] / 70); sea.geometry.setAttribute('uv', new THREE.Float32BufferAttribute(suv, 2)); scene.add(sea);
    quayWalls(coast.lines.map(l => ({ outer: l, holes: [] })));
  }
  const wm = flatMesh(water, 0, M.water, 70);
  if (wm) {
    wm.position.y = WATER_Y;
    // stencil-snijder: grond wordt niet getekend waar water ligt, zodat je de gracht in kijkt
    const cut = new THREE.Mesh(wm.geometry, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp }));
    cut.position.y = .02; cut.renderOrder = -2; scene.add(cut);
    quayWalls(water);
  }
  streetMesh(els); treeMesh(els); canalBoats(els); addLife(els); Shadow.request();
}

// =====================================================================
//  STADSDATA (uit cities/<stad>.js, al vertaald naar de gekozen taal)
// =====================================================================
const CATS = {
  landmark:{label:'Bezienswaardig', grp:'zien',    color:'#EE7B30', icon:'🏛️'},
  church:  {label:'Kerk',           grp:'zien',    color:'#EE7B30', icon:'⛪'},
  view:    {label:'Uitzicht',       grp:'zien',    color:'#EE7B30', icon:'🌉'},
  museum:  {label:'Museum',         grp:'musea',   color:'#8B6CF0', icon:'🖼️'},
  theatre: {label:'Theater & muziek',grp:'theater',color:'#E0487F', icon:'🎭'},
  cafe:    {label:CITY.cafeLabel || 'Café & bar', grp:'eten', color:'#E0A21A', icon:'🍺'},
  market:  {label:'Markt & winkels',grp:'markt',   color:'#1FA37A', icon:'🌷'},
  park:    {label:'Park & groen',   grp:'groen',   color:'#6FA73A', icon:'🌳'},
};
const CURATED = CITY.curated, PRESET_ROUTES = CITY.presets, CURATED_INFO = CITY.info || {}, DISTRICTS = CITY.districts;
const PLAN_TAGS = CITY.planTags || {}, PLAN_POP = CITY.planPop || {}, PLAN_EVENING = new Set(CITY.planEvening || []), PLAN_DRINK = new Set(CITY.planDrink || []);

// =====================================================================
//  LAGEN
// =====================================================================
// Kaartlagen = dezelfde categorieën als in Ontdek (behalve Gids en OV)
const LAYERS = [
  { id: 'gids', name: 'Gids', color: '#D7262C' },
  { id: 'zien', name: 'Bezienswaardig', color: '#EE7B30', cat: true },
  { id: 'musea', name: 'Musea', color: '#8B6CF0', cat: true },
  { id: 'theater', name: 'Theater & muziek', color: '#E0487F', cat: true },
  { id: 'eten', name: 'Eten & drinken', color: '#E0A21A', cat: true },
  { id: 'markt', name: 'Markten & winkels', color: '#1FA37A', cat: true },
  { id: 'groen', name: 'Parken & groen', color: '#6FA73A', cat: true },
  { id: 'ov', name: 'Stations & haltes', color: '#3E7BF0' },
  { id: 'tram', name: 'Tram, metro & pont', color: '#22D3EE', dark: true },
];
// welke plekken krijgen een gebouwmarkering (alleen echte gebouwen)
const SHELL_CURATED = new Set(['landmark', 'church', 'museum', 'theatre', 'cafe']);
function shellable(o) {
  if (o.key?.startsWith('g:')) return !o.area && SHELL_CURATED.has(o.cat);
  if (isStreet(o)) return false;
  if (o.layer === 'musea' || o.layer === 'theater') return true;
  if (o.layer === 'ov') return o.tags.railway === 'station';
  if (o.layer === 'zien') return /^(city_gate|tower|castle)$/.test(o.tags.historic || '');
  return false;
}
let dim = 0, dimTarget = 0;
const Layers = {
  state: Object.assign({ gids: true }, Store.get('layers', {})), groups: {}, hl: {},
  init() {
    const wrap = $('#chips');
    for (const L of LAYERS) {
      const g = new THREE.Group(); g.visible = !!this.state[L.id]; scene.add(g); this.groups[L.id] = g;
      const b = document.createElement('button'); b.className = 'chip' + (L.dark ? ' dark' : ''); b.style.setProperty('--c', L.color);
      b.dataset.layer = L.id; b.setAttribute('aria-pressed', !!this.state[L.id]); b.innerHTML = `<i></i>${esc(L.name)}`;
      b.onclick = () => this.toggle(L.id); wrap.appendChild(b);
    }
    this.applyDim();
  },
  toggle(id) {
    Sound.init(); const on = !this.state[id]; this.state[id] = on; Store.set('layers', this.state);
    this.groups[id].visible = on; $(`.chip[data-layer="${id}"]`).setAttribute('aria-pressed', on);
    if (!on && id !== 'tram') HL.set(id, []);
    if (id === 'tram' && on) Sound.bell(); else Sound.layer(on);
    if (on) { const n = Data.layerCount(id), L = LAYERS.find(l => l.id === id); if (n) toast(`${esc(L.name)}: ${n} ${id === 'tram' ? 'lijnen' : 'plekken'}`); }
    this.applyDim(); Transit.setGlow(!!this.state.tram); legend(); Food.render();
    if (on) { this.ensure(id); this.dirty.add(id); }
  },
  applyDim() { dimTarget = this.state.tram ? 1 : (LAYERS.some(l => l.id !== 'gids' && l.id !== 'tram' && this.state[l.id]) ? .18 : 0); },
  dirty: new Set(),
  pois(id) { if (id === 'gids') return CURATED.filter(shellable); return CURATED.filter(p => CATS[p.cat].grp === id && shellable(p)).concat(Data.osm.filter(o => o.layer === id && shellable(o))); },
  ensure(id) {
    return;
    for (const o of this.pois(id)) if (!o.fpReq) { o.fpReq = true; FP.get(o).then(f => { if (f) { o.fp = f; if (o.key.startsWith('g:')) { this.dirty.add('gids'); this.dirty.add(CATS[o.cat].grp); } else this.dirty.add(o.layer); } }); }
  },
  rebuild(id) {
    const L = LAYERS.find(l => l.id === id), g = this.groups[id];
    for (const o of this.hl[id] || []) { g.remove(o); o.geometry.dispose(); o.material.dispose(); }
    this.hl[id] = [];
    const seen = new Set(), fps = [];
    for (const o of this.pois(id)) { if (o.fp) { if (!seen.has(o.fp.id)) { seen.add(o.fp.id); fps.push(o.fp); } } else if (!seen.has(o.key)) { seen.add(o.key); fps.push({ id: o.key, rings: null, cx: o.x, cz: o.z, probe: true }); } }
    if (Tiles.hasIds || !Tiles.calibrated) {   // exacte overlay op het echte gebouw
      // overige plekken van deze laag (cafés, restaurants, bezienswaardigheden) via hun eigen punt
      if (id !== 'gids') for (const o of Data.osm) if (o.layer === id && !isStreet(o) && !o.fp && (id !== 'eten' || Food.match(o)) && !seen.has(o.key)) { seen.add(o.key); fps.push({ id: o.key, rings: null, cx: o.x, cz: o.z, probe: true }); }
      HL.set(id, fps); return;
    }
    HL.set(id, []);
    const geo = shellGeometry(fps); if (!geo) return;
    const col = new THREE.Color(L.color);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: .35, roughness: .4, transparent: true, opacity: .45, depthWrite: false, flatShading: true }));
    mesh.renderOrder = 5;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), new THREE.LineBasicMaterial({ color: col.clone().multiplyScalar(4.5) }));
    g.add(mesh, edges); this.hl[id] = [mesh, edges];
  },
  tick() {
    // alleen herbouwen als er echt nieuwe hoogtes zijn gevonden
    if (Tiles.calibrated) for (const L of LAYERS) { if (L.id === 'tram' || !this.state[L.id]) continue; let found = false; for (const o of this.pois(L.id)) if (o.fp && o.fp.h == null && footprintHeight(o.fp) != null) found = true; if (found) this.dirty.add(L.id); }
    for (const id of [...this.dirty]) { if (this.state[id]) { this.rebuild(id); this.dirty.delete(id); } }
  },
};
const MOON = new THREE.Color('#9FB6FF'), SUNC = new THREE.Color('#FFE6C4'), NIGHT_SKY = new THREE.Color('#0D1822');
function updateDim(dt) {
  const moving = Night.step(dt);
  if (Math.abs(dim - dimTarget) < .001 && !moving) return;
  dim += (dimTarget - dim) * Math.min(1, dt * 3.2);
  const n = Night.amt, f = (1 - .66 * dim) * (1 - .6 * n);
  for (const k of ['building', 'ground', 'street', 'park', 'water', 'tree', 'plinth', 'quay']) if (M[k]) M[k].color.copy(baseCol[k]).multiplyScalar(f);
  hemi.intensity = .6 * (1 - .5 * dim) * (1 - .55 * n); sun.intensity = 1.3 * (1 - .6 * dim) * (1 - .78 * n);
  sun.color.lerpColors(SUNC, MOON, n); NIGHT_U.value = n;
  scene.background.lerpColors(SKY, n > dim ? NIGHT_SKY : NIGHT, Math.max(dim, n)); scene.fog.color.copy(scene.background);
}

// =====================================================================
//  DATA: gids + OpenStreetMap-plekken
// =====================================================================
function classify(t) {
  if (t.railway === 'tram_stop' || t.station === 'subway' || t.amenity === 'ferry_terminal') return 'tramstop';
  if (t.railway === 'station' || t.highway === 'bus_stop' || t.railway === 'subway_entrance') return 'ov';
  if (t.tourism === 'museum') return 'musea';
  if (/^(theatre|cinema|arts_centre|music_venue|concert_hall)$/.test(t.amenity || '')) return 'theater';
  if (/^(cafe|bar|pub|biergarten|restaurant|fast_food|ice_cream)$/.test(t.amenity || '')) return 'eten';
  if (t.amenity === 'marketplace' || t.shop === 'department_store') return 'markt';
  if (/^(park|garden)$/.test(t.leisure || '')) return 'groen';
  if (/^(attraction|viewpoint)$/.test(t.tourism || '') || t.historic) return 'zien';
  return null;
}
function typeLabel(t) {
  const a = { theatre: 'Theater', cinema: 'Bioscoop', arts_centre: 'Kunstcentrum', music_venue: 'Muziekpodium', concert_hall: 'Concertzaal', cafe: 'Café', bar: 'Bar', pub: 'Kroeg', biergarten: 'Biertuin', restaurant: 'Restaurant', fast_food: 'Snel eten', ice_cream: 'IJssalon', marketplace: 'Markt', ferry_terminal: 'Pont' }[t.amenity];
  if (a) return a; if (t.tourism === 'museum') return 'Museum'; if (t.highway === 'bus_stop') return 'Bushalte';
  if (t.railway === 'tram_stop') return 'Tramhalte'; if (t.station === 'subway') return 'Metrostation'; if (t.railway === 'subway_entrance') return 'Metro-ingang';
  if (t.railway === 'station') return 'Station'; if (t.shop === 'department_store') return 'Warenhuis';
  if (t.leisure === 'park') return 'Park'; if (t.leisure === 'garden') return 'Tuin'; if (t.tourism === 'viewpoint') return 'Uitzichtpunt';
  if (t.historic) return 'Monument'; if (t.tourism === 'attraction') return 'Bezienswaardigheid'; return 'Plek';
}
const Data = {
  byId: new Map(), osm: [], osmByKey: new Map(),
  prep() { for (const p of CURATED) { [p.x, p.z] = toLocal(p.lat, p.lon); p.key = 'g:' + p.id; p.h = null; this.byId.set(p.id, p); } },
  addPois(j) {
    for (const el of j.elements || []) {
      const t = el.tags || {}, lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon; if (lat == null) continue;
      const layer = classify(t); if (!layer) continue;
      let name = t.name; if (!name) { if (t.highway === 'bus_stop') name = 'Bushalte'; else if (t.railway === 'subway_entrance') name = 'Metro-ingang'; else continue; }
      const [x, z] = toLocal(lat, lon); if (x * x + z * z > R * R) continue;
      if (this.osmByKey.has(`osm:${el.type}/${el.id}`)) continue;
      const o = { key: `osm:${el.type}/${el.id}`, name, layer, tags: t, lat, lon, x, z, node: el.type === 'node' };
      this.osm.push(o); this.osmByKey.set(o.key, o);
    }
    this.linkCurated();
  },
  linkCurated() {
    const norm = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\b(het|de|museum|theater|cafe|koninklijk)\b/g, ' ').replace(/\s+/g, ' ').trim();
    for (const p of CURATED) {
      const pn = norm(p.name); let best = null, bd = 160;
      for (const o of this.osm) { if (isStreet(o)) continue; const d = Math.hypot(o.x - p.x, o.z - p.z); if (d > 160) continue; const on = norm(o.name); const nameHit = on && pn && (on.includes(pn) || pn.includes(on)); const score = nameHit ? d : d + 200; if (score < bd || (!best && d < 30)) { bd = score; best = o; } }
      p.osm = best;
    }
  },
  layerCount(id) { if (id === 'gids') return CURATED.length; if (id === 'tram') return Transit.lines.length; return this.osm.filter(o => o.layer === id).length + CURATED.filter(p => CATS[p.cat].grp === id).length; },
};
function isStreet(o) { return o.layer === 'tramstop' || o.tags?.highway === 'bus_stop' || o.tags?.railway === 'subway_entrance'; }

// ---------- BAG-contouren via PDOK OGC API (zelfde bron als de zonnestudie) ----------
async function fetchFootprint(lat, lon, pad) {
  const [x, z] = toLocal(lat, lon), a = localToWgs(x - pad, z + pad), b = localToWgs(x + pad, z - pad);
  const bbox = `${a[1].toFixed(7)},${a[0].toFixed(7)},${b[1].toFixed(7)},${b[0].toFixed(7)}`;
  let j = null;
  for (const base of CFG.ep.bagPand) { try { j = await fetchJSON(`${base}?bbox=${bbox}&limit=50&f=json`, {}, 15000); break; } catch { } }
  if (!j) throw new Error('BAG niet bereikbaar');
  let best = null, bd = pad;
  for (const f of j.features || []) {
    const g = f.geometry; if (!g) continue;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of polys) {
      const rings = poly.map(r => { let n = r.length; if (n > 1 && r[0][0] === r[n - 1][0] && r[0][1] === r[n - 1][1]) n--; const q = new Float32Array(n * 2); for (let i = 0; i < n; i++) { const [px, pz] = toLocal(r[i][1], r[i][0]); q[i * 2] = px; q[i * 2 + 1] = pz; } return q; }).filter(r => r.length >= 6);
      if (!rings.length) continue;
      let d = -1; if (!pipFlat(x, z, rings[0])) { d = 1e9; const r = rings[0]; for (let i = 0; i < r.length; i += 2) d = Math.min(d, Math.hypot(r[i] - x, r[i + 1] - z)); }
      if (d < bd) { bd = d; best = { f, rings }; }
    }
  }
  if (!best) return null;
  const p = best.f.properties || {}, r = best.rings[0]; let cx = 0, cz = 0; for (let i = 0; i < r.length; i += 2) { cx += r[i]; cz += r[i + 1]; } cx /= r.length / 2; cz /= r.length / 2;
  return { id: String(p.identificatie || best.f.id || cx.toFixed(1) + ',' + cz.toFixed(1)), yr: +(p.bouwjaar || p.oorspronkelijkbouwjaar || p.oorspronkelijk_bouwjaar || 0) || null, rings: best.rings, cx, cz };
}
const FP = {
  cache: new Map(), queue: [], running: 0,
  get(o) {
    if (this.cache.has(o.key)) return this.cache.get(o.key);
    const p = new Promise(res => { this.queue.push({ o, res }); this.pump(); }); this.cache.set(o.key, p); return p;
  },
  pump() {
    while (this.running < 6 && this.queue.length) {
      let bi = 0, bd = Infinity; const t = controls.target;
      for (let i = 0; i < this.queue.length; i++) { const q = this.queue[i].o, d = (q.x - t.x) ** 2 + (q.z - t.z) ** 2 - (q.key.startsWith('g:') ? 1e12 : 0); if (d < bd) { bd = d; bi = i; } }
      const { o, res } = this.queue.splice(bi, 1)[0]; this.running++;
      Promise.resolve({ none: true })
        .then(f => res(f && !f.none ? f : null)).catch(() => res(null)).finally(() => { this.running--; this.pump(); });
    }
  },
};
let rayBudget = 0;
function footprintHeight(f) {
  if (f.h == null && Tiles.calibrated && f.tried !== Tiles.version && rayBudget > 0) {
    f.tried = Tiles.version; rayBudget -= 3;
    const r = f.rings[0], pts = [[f.cx, f.cz]]; for (let i = 0; i < Math.min(r.length, 12); i += 6) pts.push([(r[i] + f.cx) / 2, (r[i + 1] + f.cz) / 2]);
    let best = null; for (const [x, z] of pts) { const y = roofAt(x, z); if (y != null && y > 1 && (best == null || y > best)) best = y; }
    if (best != null) f.h = best;
  }
  return f.h;
}
function shellGeometry(fps, pad = .7) {
  const buf = new Buf(1 << 14), W = [255, 255, 255];
  for (const f of fps) {
    const h = (f.h ?? 16) + pad;
    const rings = f.rings.map((r, ri) => { const q = new Float32Array(r.length); for (let i = 0; i < r.length; i += 2) { const dx = r[i] - f.cx, dz = r[i + 1] - f.cz, d = Math.hypot(dx, dz) || 1, k = (ri === 0 ? pad : -pad) / d; q[i] = r[i] + dx * k; q[i + 1] = r[i + 1] + dz * k; } return q; });
    extrude(buf, rings, h, W, W, -.5);
  }
  return buf.n ? buf.geometry() : null;
}
// geselecteerd pand (na tik)
const Sel = {
  obj: null,
  show(f) { this.hide(); if (Tiles.hasIds) { HL.set('sel', [f]); return; } const geo = shellGeometry([f], .5); if (!geo) return; const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: new THREE.Color('#FFFFFF').multiplyScalar(1.6), transparent: true, opacity: .28, depthWrite: false })); const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), new THREE.LineBasicMaterial({ color: new THREE.Color('#FFFFFF').multiplyScalar(4) })); this.obj = new THREE.Group(); this.obj.add(m, e); scene.add(this.obj); },
  hide() { HL.set('sel', []); if (!this.obj) return; scene.remove(this.obj); this.obj.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); }); this.obj = null; },
};

const stopFromCurated = p => ({ name: p.name, lat: p.lat, lon: p.lon, ref: 'g:' + p.id });

// ---------- sprites & texturen ----------
const pxScale = px => px / innerHeight * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
function canvasTex(w, h, draw) { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d')); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; }
const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
function pinTexture(p) {
  const C = CATS[p.cat], done = Store.isVisited(p.key);
  return canvasTex(96, 120, g => {
    g.fillStyle = 'rgba(0,0,0,.22)'; g.beginPath(); g.ellipse(48, 114, 12, 4, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = C.color; g.beginPath(); g.moveTo(48, 113); g.lineTo(28, 76); g.lineTo(68, 76); g.fill();
    g.beginPath(); g.arc(48, 46, 40, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff'; g.beginPath(); g.arc(48, 46, 31, 0, Math.PI * 2); g.fill();
    g.font = `34px ${EMOJI_FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(C.icon, 48, 49);
    if (done) { g.fillStyle = '#2E7A4E'; g.beginPath(); g.arc(76, 16, 15, 0, Math.PI * 2); g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 4; g.beginPath(); g.moveTo(69, 16); g.lineTo(74, 21); g.lineTo(83, 11); g.stroke(); }
  });
}
function dotTexture(color, ring) {
  return canvasTex(64, 64, g => {
    g.beginPath(); g.arc(32, 32, 25, 0, Math.PI * 2); g.fillStyle = ring ? '#0E2B31' : color; g.fill();
    g.lineWidth = 8; g.strokeStyle = ring ? color : '#fff'; g.stroke();
    if (!ring) { g.beginPath(); g.arc(32, 32, 7, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill(); }
  });
}
function numTexture(n, color) {
  return canvasTex(64, 64, g => {
    g.beginPath(); g.arc(32, 32, 27, 0, Math.PI * 2); g.fillStyle = color; g.fill(); g.lineWidth = 5; g.strokeStyle = '#fff'; g.stroke();
    g.fillStyle = '#fff'; g.font = '800 28px "Bricolage Grotesque",system-ui,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(n), 32, 34);
  });
}
const Pins = {
  list: [],
  init() {
    for (const p of CURATED) {
      const mat = new THREE.SpriteMaterial({ map: pinTexture(p), sizeAttenuation: false, depthTest: false, transparent: true }); mat.color.setScalar(1.4);
      const sp = new THREE.Sprite(mat); sp.center.set(.5, 0); sp.renderOrder = 30; sp.userData = { kind: 'curated', item: p, phase: hash(p.id) % 100 / 16 };
      Layers.groups.gids.add(sp); this.list.push(sp);
    }
    this.place(); this.resize();
  },
  place() { for (const sp of this.list) { const p = sp.userData.item; sp.userData.baseY = (p.h ?? 18) + 5; sp.position.set(p.x, sp.userData.baseY, p.z); } },
  tick() {
    if (!Tiles.calibrated) return; let ch = false;
    for (const p of CURATED) if (p.h == null && p.hTry !== Tiles.version && rayBudget > 0) { p.hTry = Tiles.version; rayBudget--; const y = p.fp ? footprintHeight(p.fp) : roofAt(p.x, p.z); if (y != null && y > 1) { p.h = y; ch = true; } }
    if (ch) this.place();
  },
  resize() { const s = pxScale(isMobile ? 46 : 40); for (const sp of this.list) sp.scale.set(s, s * 1.25, 1); },
  refresh(p) { const sp = this.list.find(x => x.userData.item === p); if (!sp) return; sp.material.map.dispose(); sp.material.map = pinTexture(p); sp.material.needsUpdate = true; },
};
const pointObjs = [];
function pointHeight(o) {
  if (o.h != null && o.h < 1) o.h = null;
  if (o.h == null && Tiles.calibrated && o.hTried !== Tiles.version && rayBudget > 0) {
    o.hTried = Tiles.version; rayBudget--;
    const y = roofAt(o.x, o.z); if (y != null) o.h = y;
  }
  return (o.fp?.h ?? o.h ?? 30) + 4;
}
function updatePointHeights() {
  for (const p of pointObjs) { if (p.userData.tram) continue; const a = p.geometry.attributes.position; let ch = false;
    p.userData.items.forEach((o, i) => { const y = pointHeight(o); if (a.getY(i) !== y) { a.setY(i, y); ch = true; } }); if (ch) a.needsUpdate = true; }
}
function buildPoints() {
  for (const o of pointObjs) { o.parent?.remove(o); o.geometry.dispose(); o.material.map?.dispose(); o.material.dispose(); }
  pointObjs.length = 0;
  for (const L of LAYERS) {
    if (L.id === 'gids') continue;
    const tram = L.id === 'tram', items = Data.osm.filter(o => (tram ? o.layer === 'tramstop' : o.layer === L.id) && (L.id !== 'eten' || Food.match(o))); if (!items.length) continue;
    const pos = new Float32Array(items.length * 3);
    items.forEach((o, i) => { pos[i * 3] = o.x; pos[i * 3 + 1] = tram ? 4 : (o.fp?.h ?? o.h ?? 30) + 4; pos[i * 3 + 2] = o.z; });
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({ map: dotTexture(tram ? '#7DF3FF' : L.color, tram), size: (tram ? 15 : 19) * renderer.getPixelRatio(), sizeAttenuation: false, transparent: true, alphaTest: .25, depthTest: !tram });
    m.color.setScalar(tram ? 2.2 : 1.35);
    const pts = new THREE.Points(g, m); pts.renderOrder = tram ? 24 : 12; pts.userData = { kind: 'osm', items, tram, basePx: tram ? 15 : 19 };
    Layers.groups[L.id].add(pts); pointObjs.push(pts);
  }
}

// =====================================================================
//  OV: tram, metro en pont als gloeiende lijnen + rijdende trams
// =====================================================================
const PALETTE = ['#22D3EE', '#F472B6', '#A3E635', '#FBBF24', '#60A5FA', '#F87171', '#34D399', '#C084FC', '#FB923C', '#2DD4BF', '#E879F9', '#FDE047', '#38BDF8', '#4ADE80'];
function lineColor(L, i) {
  let c = null; const raw = (L.colour || '').trim();
  if (/^#?[0-9a-f]{6}$/i.test(raw)) c = new THREE.Color(raw.startsWith('#') ? raw : '#' + raw);
  if (!c) c = new THREE.Color(PALETTE[(parseInt(L.ref) || i) % PALETTE.length]);
  const hsl = {}; c.getHSL(hsl, THREE.SRGBColorSpace); c.setHSL(hsl.h, Math.max(hsl.s, .7), clamp(hsl.l, .55, .68), THREE.SRGBColorSpace);
  return '#' + c.getHexString();
}
const ROUTE_LAB = { tram: 'Tram', subway: 'Metro', ferry: 'Pont', light_rail: 'Sneltram', bus: 'Bus' };
const Transit = {
  lines: [], all: [], tramMats: [], focused: null,
  build(j) {
    const byLine = new Map();
    for (const r of j.elements || []) {
      if (r.type !== 'relation') continue; const t = r.tags || {}, key = t.route + ':' + (t.ref || t.name || r.id);
      let L = byLine.get(key); if (!L) byLine.set(key, L = { route: t.route, ref: t.ref || '', name: t.name || '', colour: t.colour, ways: new Map(), paths: [], nodes: new Set(), stopPts: [], dests: new Set() });
      if (t.to) L.dests.add(t.to);
      const chain = [];
      for (const m of r.members || []) {
        const role = m.role || '';
        if (m.type === 'node' && /stop|platform/.test(role)) { L.nodes.add(m.ref); if (m.lat != null) L.stopPts.push(toLocal(m.lat, m.lon)); continue; }
        if (m.type === 'way' && /platform/.test(role)) { if (m.geometry?.[0]) L.stopPts.push(toLocal(m.geometry[0].lat, m.geometry[0].lon)); continue; }
        if (m.type !== 'way' || !(m.geometry || m.L)) continue;
        const pts = ptsOf(m); if (pts.length < 2) continue;
        if (!L.ways.has(m.ref)) L.ways.set(m.ref, pts); chain.push(pts);
      }
      const path = chainWays(chain); if (path.length > 1 && L.paths.length < 2) L.paths.push(path);
    }
    const order = { tram: 0, subway: 1, light_rail: 2, ferry: 3, bus: 4 };
    this.all = [...byLine.values()].sort((a, b) => (order[a.route] ?? 9) - (order[b.route] ?? 9) || (parseInt(a.ref) || 999) - (parseInt(b.ref) || 999) || a.ref.localeCompare(b.ref));
    const g = Layers.groups.tram;
    this.all.forEach((L, i) => {
      L.color = L.route === 'bus' ? '#3E7BF0' : lineColor(L, i);
      if (L.route === 'bus') return;
      const seg = [], y = L.route === 'subway' ? 3.4 : L.route === 'ferry' ? 1.6 : 2.6;
      for (const pts of L.ways.values()) for (let k = 1; k < pts.length; k++) { const s = clipSeg(pts[k - 1], pts[k], R - 2); if (s) seg.push(s[0][0], y, s[0][1], s[1][0], y, s[1][1]); }
      if (!seg.length) return;
      this.lines.push(L);
      const geo = new LineSegmentsGeometry(); geo.setPositions(seg);
      const mat = regLineMat(new LineMaterial({ color: new THREE.Color(L.color).multiplyScalar(3.4), linewidth: L.route === 'subway' ? 5.5 : L.route === 'ferry' ? 3 : 3.6, transparent: true, opacity: .95, depthTest: false, dashed: L.route === 'ferry', dashSize: 18, gapSize: 12 }));
      const o = new LineSegments2(geo, mat); if (L.route === 'ferry') o.computeLineDistances(); o.renderOrder = 22; g.add(o); L.obj = o;
      if (L.route === 'tram') L.paths.forEach((p, k) => {
        const tm = new THREE.MeshStandardMaterial({ color: '#EDEDE6', emissive: new THREE.Color(L.color), emissiveIntensity: 0, roughness: .5 });
        this.tramMats.push(tm); const mesh = new THREE.Mesh(new THREE.BoxGeometry(2.5, 3.3, 26), tm);
        addMover(mesh, p, 6 + (i % 3), 1.9, { dir: k ? -1 : 1 });
      });
      if (L.route === 'ferry' && L.paths[0]) addMover(boatMesh(true), L.paths[0], 4, WATER_Y - .1);
    });
  },
  // welke lijnen stoppen bij deze halte? eerst exacte OSM-koppeling, anders nabijheid
  linesAt(o) {
    const id = /^osm:node\//.test(o.key) ? +o.key.slice(9) : null, out = [];
    for (const L of this.all) {
      let hit = id != null && L.nodes.has(id);
      if (!hit && L.route !== 'bus') { const lim = L.route === 'subway' ? 170 : 60; hit = L.stopPts.some(p => Math.hypot(p[0] - o.x, p[1] - o.z) < lim); }
      if (hit) out.push(L);
    }
    return out;
  },
  focus(ls) {
    const set = new Set(ls); this.focused = set; Layers.groups.tram.visible = true;
    for (const L of this.lines) if (L.obj) L.obj.material.opacity = set.has(L) ? 1 : .08;
  },
  unfocus() {
    if (!this.focused) return; this.focused = null; Layers.groups.tram.visible = !!Layers.state.tram;
    for (const L of this.lines) if (L.obj) L.obj.material.opacity = .95;
  },
  setGlow(on) { for (const m of this.tramMats) m.emissiveIntensity = on ? 3.2 : 0; },
};
function legend() {
  const el = $('#legend');
  if (!Layers.state.tram || !Transit.lines.length) { el.hidden = true; return; }
  const lab = { tram: 'Tram', subway: 'Metro', ferry: 'Pont', light_rail: 'Sneltram' };
  el.innerHTML = '<b>Lijnen in dit gebied</b><small style="width:100%;opacity:.75">Tik op een halte om te zien welke lijnen daar stoppen.</small>' + Transit.lines.map(L => `<span style="--c:${L.color}"><i></i>${esc(lab[L.route] || L.route)} ${esc(L.ref || L.name)}</span>`).join('');
  el.hidden = false;
}

// =====================================================================
//  CAMERA
// =====================================================================
let tween = null;
const isNarrow = () => innerWidth < 900;
function flyTo(x, z, dist = 420, o = {}) {
  const off = camera.position.clone().sub(controls.target); if (off.lengthSq() < 1) off.set(0, 1, 1);
  let az = Math.atan2(off.x, off.z), pol = Math.acos(clamp(off.y / off.length(), -1, 1));
  if (View.mode === 'plan') pol = View.PLAN; else if (o.polar != null) pol = o.polar; else if (pol > 1.05 || pol < .35) pol = .85;
  if (o.az != null) az = o.az;
  off.setFromSphericalCoords(dist, pol, az);
  const tgt = new THREE.Vector3(x, 0, z);
  if (o.shift) { const fwd = new THREE.Vector3(-off.x, 0, -off.z).normalize(); tgt.addScaledVector(fwd, -dist * .3); }
  tween = { t0: performance.now(), dur: (reduceMotion ? .3 : (o.dur || 1.5)) * 1000, fT: controls.target.clone(), tT: tgt, fP: camera.position.clone(), tP: tgt.clone().add(off), end: o.end };
  if (!o.silent) Sound.whoosh();
}
function stepTween() {
  if (!tween) return; const k = clamp((performance.now() - tween.t0) / tween.dur, 0, 1), e = ease(k);
  controls.target.lerpVectors(tween.fT, tween.tT, e); camera.position.lerpVectors(tween.fP, tween.tP, e);
  camera.position.y += Math.sin(k * Math.PI) * Math.min(tween.fP.distanceTo(tween.tP) * .22, 800);
  if (k >= 1) { const f = tween.end; tween = null; f?.(); }
}
// weergave: vrij rondkijken of recht van bovenaf (blijft 3D, alleen de camera staat loodrecht)
const View = {
  mode: 'free', PLAN: .0015,
  init() {
    for (const b of $$('#viewSeg [data-view]')) b.onclick = () => { Sound.init(); this.set(b.dataset.view); };
    addEventListener('keydown', e => { if ((e.key === 'v' || e.key === 'V') && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName)) this.set(this.mode === 'plan' ? 'free' : 'plan'); });
  },
  set(m) {
    if (m === this.mode) return; this.mode = m;
    for (const b of $$('#viewSeg [data-view]')) b.setAttribute('aria-checked', String(b.dataset.view === m));
    const tg = controls.target, d = camera.position.distanceTo(tg);
    if (m === 'plan') {
      controls.minPolarAngle = 0;
      flyTo(tg.x, tg.z, Math.max(d * 1.15, 260), { az: 0, dur: 1.1, silent: true, end: () => { if (this.mode === 'plan') controls.maxPolarAngle = this.PLAN; } });
    } else {
      controls.maxPolarAngle = 1.32; controls.minPolarAngle = 0;
      flyTo(tg.x, tg.z, d / 1.15, { polar: .85, dur: 1.1, silent: true });
    }
    Sound.click();
  },
};
controls.addEventListener('start', () => { const f = tween?.end; tween = null; f?.(); });
function clampTarget() {
  const tg = controls.target, d = Math.hypot(tg.x, tg.z);
  if (d > R) { const k = R / d, dx = tg.x * (k - 1), dz = tg.z * (k - 1); tg.x += dx; tg.z += dz; camera.position.x += dx; camera.position.z += dz; }
  if (tg.y !== 0) { camera.position.y -= tg.y; tg.y = 0; }
  if (camera.position.y < 12) camera.position.y = 12;
}

// =====================================================================
//  EXTERNE INFO: Wikipedia, PDOK, routering
// =====================================================================
const wikiCache = new Map();
const wdec = t => { try { return decodeURIComponent(t); } catch { return t; } };
function wiki(ref) {
  if (!ref) return Promise.resolve(null); if (wikiCache.has(ref)) return wikiCache.get(ref);
  const i = ref.indexOf(':'), lang = i > 0 && i < 4 ? ref.slice(0, i) : 'nl', title = wdec(i > 0 && i < 4 ? ref.slice(i + 1) : ref);
  const p = fetchJSON(CFG.ep.wiki(lang, title.replace(/ /g, '_')), {}, 12000).then(j => {
    const th = j.thumbnail?.source; return { thumb: th, big: th ? th.replace(/\/\d+px-/, '/800px-') : j.originalimage?.source, url: j.content_urls?.desktop?.page };
  }).catch(() => null);
  wikiCache.set(ref, p); return p;
}
const osrmCache = new Map();
function osrm(coords) {
  const k = coords.map(c => c.map(n => n.toFixed(5)).join(',')).join(';');
  if (!osrmCache.has(k)) osrmCache.set(k, fetchJSON(CFG.ep.osrmFoot + k + '?overview=full&geometries=geojson', {}, 20000).then(j => { if (!j.routes?.length) throw new Error('geen route'); return j; }).catch(e => { osrmCache.delete(k); throw e; }));
  return osrmCache.get(k);
}
// ---------- geocoding: PDOK in Nederland, Photon (OpenStreetMap) elders ----------
async function geoSearch(q) {
  if (CITY.geocoder === 'pdok') return pdokSearch(q);
  const j = await fetchJSON(`${CFG.ep.photon}/api/?q=${encodeURIComponent(q)}&lat=${CITY.center.lat}&lon=${CITY.center.lon}&limit=8`, {}, 10000);
  return (j.features || []).map(f => { const p = f.properties, [lon, lat] = f.geometry.coordinates; const name = p.name || (p.housenumber ? `${p.street} ${p.housenumber}` : p.street) || p.city; return { name: name + (p.city && p.city !== name ? ', ' + p.city : ''), lat, lon, type: p.housenumber ? 'adres' : 'weg' }; })
    .filter(d => { const [x, z] = toLocal(d.lat, d.lon); return x * x + z * z < R * R; });
}
async function geoReverse(lat, lon) {
  try {
    if (CITY.geocoder === 'pdok') { const j = await fetchJSON(`${CFG.ep.pdokReverse}?lat=${lat}&lon=${lon}&rows=1&type=adres&distance=40`, {}, 8000); return j.response?.docs?.[0]?.weergavenaam.split(',')[0] || null; }
    const j = await fetchJSON(`${CFG.ep.photon}/reverse?lat=${lat}&lon=${lon}&limit=1`, {}, 8000); const p = j.features?.[0]?.properties; if (!p) return null;
    return p.housenumber ? `${p.street} ${p.housenumber}` : (p.name || p.street || null);
  } catch { return null; }
}
async function pdokSearch(q) {
  const u = `${CFG.ep.pdokFree}?q=${encodeURIComponent(q)}&fq=${encodeURIComponent('type:(adres OR weg)')}&fq=${encodeURIComponent('gemeentenaam:Amsterdam')}&rows=6&fl=${encodeURIComponent('weergavenaam,centroide_ll,type')}`;
  const j = await fetchJSON(u, {}, 10000);
  return (j.response?.docs || []).map(d => { const m = /POINT\(([-\d.]+) ([-\d.]+)\)/.exec(d.centroide_ll || ''); return m ? { name: d.weergavenaam, lon: +m[1], lat: +m[2], type: d.type } : null; }).filter(Boolean)
    .filter(d => { const [x, z] = toLocal(d.lat, d.lon); return x * x + z * z < R * R; });
}
function gmapsUrl(stops) {
  const p = s => `${s.lat.toFixed(6)},${s.lon.toFixed(6)}`;
  if (stops.length === 1) return `https://www.google.com/maps/search/?api=1&query=${p(stops[0])}`;
  const w = stops.slice(1, -1).slice(0, 8).map(p).join('|');
  return `https://www.google.com/maps/dir/?api=1&origin=${p(stops[0])}&destination=${p(stops[stops.length - 1])}${w ? `&waypoints=${encodeURIComponent(w)}` : ''}&travelmode=walking`;
}
function openGmaps(stops) { if (!stops.length) return; if (stops.length > 10) toast('Google Maps neemt de eerste 10 stops mee'); open(gmapsUrl(stops), '_blank', 'noopener'); }

// =====================================================================
//  ROUTES
// =====================================================================
const fmtDur = m => m < 60 ? `${m} min` : `${Math.floor(m / 60)} u${m % 60 ? ' ' + (m % 60) + ' min' : ''}`;
function estDist(stops) { let d = 0; for (let i = 1; i < stops.length; i++) { const a = toLocal(stops[i - 1].lat, stops[i - 1].lon), b = toLocal(stops[i].lat, stops[i].lon); d += Math.hypot(a[0] - b[0], a[1] - b[1]) * 1.3; } return d; }
function presetRoute(p) { return { id: p.id, title: p.title, color: p.color, desc: p.desc, preset: true, stops: p.stops.map(id => Data.byId.get(id)).filter(Boolean).map(stopFromCurated) }; }
const RouteView = {
  line: null, marks: [], current: null, token: 0,
  async show(route, { fit = true } = {}) {
    const tk = ++this.token; this.clear(); this.current = { ...route };
    const st = route.stops; if (!st.length) return this.current;
    let geo = st.map(s => [s.lon, s.lat]), dist = 0, dur = 0;
    if (st.length > 1) { try { const j = await osrm(geo); geo = j.routes[0].geometry.coordinates; dist = j.routes[0].distance; dur = j.routes[0].duration; } catch (e) { console.warn('routering', e); } }
    if (tk !== this.token) return this.current;
    if (!dist) { dist = estDist(st); dur = dist / 1.3; }
    const col = new THREE.Color(route.color || '#D7262C');
    if (geo.length > 1) {
      const pos = []; for (const [lon, lat] of geo) { const [x, z] = toLocal(lat, lon); pos.push(x, 4.5, z); }
      const g = new LineGeometry(); g.setPositions(pos);
      const m = regLineMat(new LineMaterial({ color: col.clone().multiplyScalar(2.6), linewidth: 6, dashed: true, dashSize: 16, gapSize: 9, depthTest: false, transparent: true }));
      const l = new Line2(g, m); l.computeLineDistances(); l.renderOrder = 26; scene.add(l); this.line = l;
    }
    st.forEach((s, i) => {
      const [x, z] = toLocal(s.lat, s.lon), mat = new THREE.SpriteMaterial({ map: numTexture(i + 1, route.color || '#D7262C'), sizeAttenuation: false, depthTest: false, transparent: true });
      mat.color.setScalar(1.35); const sp = new THREE.Sprite(mat); const k = pxScale(30); sp.scale.set(k, k, 1); sp.position.set(x, 6, z); sp.renderOrder = 31; scene.add(sp); this.marks.push(sp);
    });
    Object.assign(this.current, { dist, dur }); if (fit) this.fit(); return this.current;
  },
  fit() {
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (const s of this.current.stops) { const [x, z] = toLocal(s.lat, s.lon); x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    flyTo((x0 + x1) / 2, (z0 + z1) / 2, Math.max(x1 - x0, z1 - z0, 250) * 1.3 + 300, { polar: .7, shift: isNarrow() && $('#panel').classList.contains('open') });
  },
  clear() {
    if (this.line) { scene.remove(this.line); this.line.geometry.dispose(); lineMats.delete(this.line.material); this.line.material.dispose(); this.line = null; }
    for (const m of this.marks) { scene.remove(m); m.material.map.dispose(); m.material.dispose(); }
    this.marks = []; this.current = null;
  },
  tick(t) { if (this.line) this.line.material.dashOffset = -t * 22; },
};
const MyRoute = {
  r: Store.get('draft', { id: uid(), title: 'Mijn route', stops: [] }),
  save() { Store.set('draft', this.r); updateDock(); },
  add(s) {
    if (this.r.stops.some(x => x.ref === s.ref)) { toast(`${esc(s.name)} staat al in je route`); return; }
    this.r.stops.push({ name: s.name, lat: s.lat, lon: s.lon, ref: s.ref }); this.save(); Sound.drop();
    const d = $('#dock'); d.classList.remove('bump'); void d.offsetWidth; d.classList.add('bump');
    toast(`Toegevoegd aan je route: ${esc(s.name)}`);
    if (UI.tab === 'mijn') UI.render();
    if (RouteView.current?.draft) RouteView.show(this.asRoute(), { fit: false });
  },
  asRoute() { return { ...this.r, color: '#D7262C', draft: true }; },
};
function updateDock() {
  const n = MyRoute.r.stops.length; $('#dockN').textContent = n; $('#dockL').textContent = n ? 'Mijn route' : 'Sleep plekken hierheen';
  const b = $('#tabBadge'); b.hidden = !n; b.textContent = n;
}
function encodeRoute(r) { const o = { t: r.title, c: r.color, s: r.stops.map(s => [s.name, +(+s.lat).toFixed(6), +(+s.lon).toFixed(6), s.ref || '']) }; return btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function decodeRoute(str) {
  try { const o = JSON.parse(decodeURIComponent(escape(atob(str.replace(/-/g, '+').replace(/_/g, '/'))))); return { id: 'shared-' + hash(str), title: o.t || 'Gedeelde route', color: o.c || '#D7262C', desc: 'Iemand heeft deze route met je gedeeld.', shared: true, stops: (o.s || []).map(a => ({ name: a[0], lat: +a[1], lon: +a[2], ref: a[3] })).filter(s => isFinite(s.lat) && isFinite(s.lon)) }; }
  catch { return null; }
}
function shareRoute(r) {
  if (!r.stops.length) { toast('Voeg eerst een stop toe'); return; }
  const url = location.href.split('#')[0] + '#r=' + encodeRoute(r);
  Share.open({ title: r.title, text: T('Loop deze route door') + ' ' + CITY.name + ': ' + r.title, url });
}
const Tour = {
  i: 0, route: null,
  start(route) { if (!route.stops.length) return; this.route = route; this.i = 0; $('#tour').hidden = false; UI.closePanel(); this.go(); },
  go() {
    const s = this.route.stops[this.i], el = $('#tour');
    el.innerHTML = `<button data-t="prev" aria-label="Vorige stop">‹</button><span>${this.i + 1} van ${this.route.stops.length}: ${esc(s.name)}</span><button data-t="next" aria-label="Volgende stop">›</button><button data-t="end" aria-label="Stop de tour">✕</button>`;
    el.querySelectorAll('button').forEach(b => b.onclick = () => { const a = b.dataset.t; if (a === 'end') return this.end(); this.i = clamp(this.i + (a === 'next' ? 1 : -1), 0, this.route.stops.length - 1); this.go(); });
    const [x, z] = toLocal(s.lat, s.lon); flyTo(x, z, 280, { shift: isNarrow(), polar: .95 }); openStop(s, false);
  },
  end() { $('#tour').hidden = true; this.route = null; Card.close(); },
};

// =====================================================================
//  KAART-INTERACTIE: tikken, lang indrukken, slepen
// =====================================================================
const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), _gp = new THREE.Vector3();
function pickAt(cx, cy) {
  ndc.set(cx / innerWidth * 2 - 1, -(cy / innerHeight) * 2 + 1); raycaster.setFromCamera(ndc, camera);
  if (Districts.mode === 'overview') {
    const lh = raycaster.intersectObjects(Districts.list.map(D => D.label), false); if (lh.length) return { kind: 'district', D: lh[0].object.userData.district };
    if (raycaster.ray.intersectPlane(groundPlane, _gp)) { const D = Districts.at(_gp.x, _gp.z); if (D) return { kind: 'district', D }; }
  }
  if (Layers.state.gids) { const h = raycaster.intersectObjects(Pins.list, false); if (h.length) return { kind: 'curated', item: h[0].object.userData.item }; }
  const dist = camera.position.distanceTo(controls.target);
  raycaster.params.Points.threshold = dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 2 / innerHeight * 13;
  const ph = raycaster.intersectObjects(pointObjs.filter(o => o.parent?.visible), false);
  if (ph.length) return { kind: 'osm', item: ph[0].object.userData.items[ph[0].index] };
  raycaster.firstHitOnly = true; const bh = raycaster.intersectObjects(Tiles.list, false); raycaster.firstHitOnly = false;
  if (bh.length) {
    const p = bh[0].point;
    // 1) plek waarvan de BAG-contour dit punt bevat
    const inFp = o => o.fp && pipFlat(p.x, p.z, o.fp.rings[0]);
    for (const c of CURATED) if (inFp(c)) return { kind: 'curated', item: c };
    for (const o of Data.osm) if (Layers.state[o.layer] && inFp(o)) return { kind: 'osm', item: o };
    // 2) dichtstbijzijnde plek
    let best = null, bd = 12;
    for (const c of CURATED) { const d = Math.hypot(c.x - p.x, c.z - p.z); if (d < bd) { bd = d; best = { kind: 'curated', item: c }; } }
    if (!best) { bd = 8; for (const o of Data.osm) { if (isStreet(o)) continue; const d = Math.hypot(o.x - p.x, o.z - p.z); if (d < bd) { bd = d; best = { kind: 'osm', item: o }; } } }
    return best || { kind: 'building', point: p.clone() };
  }
  return null;
}
function hitToStop(h) {
  if (!h) return null;
  if (h.kind === 'curated') return stopFromCurated(h.item);
  if (h.kind === 'osm') return { name: h.item.name, lat: h.item.lat, lon: h.item.lon, ref: h.item.key };
  if (h.kind === 'building') { const [lat, lon] = localToWgs(h.point.x, h.point.z); return { name: 'Pand', lat, lon, ref: 'b:' + lat.toFixed(5) + ',' + lon.toFixed(5) }; }
  return null;
}
function onPick(hit) {
  if (!hit) { Card.close(); return; }
  Sound.click();
  if (hit.kind === 'district') { Districts.select(hit.D); UI.tab = null; UI.openTab('buurten', true); return; }
  if (hit.kind === 'curated') Card.curated(hit.item); else if (hit.kind === 'osm') Card.osm(hit.item); else if (hit.kind === 'building') Card.building(hit.point);
}
let down = null, lpTimer = null, pointers = 0;
canvas.addEventListener('pointerdown', e => {
  Sound.init(); pointers++;
  if (pointers > 1) { clearTimeout(lpTimer); down = null; return; }
  down = { x: e.clientX, y: e.clientY, t: performance.now() }; clearTimeout(lpTimer);
  lpTimer = setTimeout(() => {
    if (!down) return; const s = hitToStop(pickAt(down.x, down.y));
    if (s) { controls.enabled = false; Drag.start(s, down.x, down.y); navigator.vibrate?.(12); }
    down = null;
  }, 520);
});
canvas.addEventListener('pointermove', e => { if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 7) { down = null; clearTimeout(lpTimer); } });
const ptrUp = e => { pointers = Math.max(0, pointers - 1); clearTimeout(lpTimer); if (down && performance.now() - down.t < 500 && e.type === 'pointerup') onPick(pickAt(e.clientX, e.clientY)); down = null; };
canvas.addEventListener('pointerup', ptrUp); canvas.addEventListener('pointercancel', ptrUp);

const Drag = {
  item: null, hot: null, el: $('#ghost'),
  start(item, x, y) {
    this.item = item; this.el.textContent = '+ ' + item.name; this.el.hidden = false; this.move(x, y); Sound.pop();
    addEventListener('pointermove', this.onMove); addEventListener('pointerup', this.onUp); addEventListener('pointercancel', this.onUp);
  },
  move(x, y) {
    this.el.style.left = x + 'px'; this.el.style.top = y + 'px';
    const t = document.elementFromPoint(x, y)?.closest('[data-drop]') || null;
    if (t !== this.hot) { this.hot?.classList.remove('hot'); t?.classList.add('hot'); this.hot = t; }
  },
  onMove: e => Drag.move(e.clientX, e.clientY),
  onUp: () => {
    const D = Drag; removeEventListener('pointermove', D.onMove); removeEventListener('pointerup', D.onUp); removeEventListener('pointercancel', D.onUp);
    D.el.hidden = true; if (D.hot) { D.hot.classList.remove('hot'); MyRoute.add(D.item); }
    D.hot = null; D.item = null; controls.enabled = true;
  },
};

// =====================================================================
//  INFOKAART
// =====================================================================
function openStop(s, fly = true) {
  if (fly) { const [x, z] = toLocal(s.lat, s.lon); flyTo(x, z, 300, { shift: isNarrow() }); }
  if (s.ref?.startsWith('g:')) { const p = Data.byId.get(s.ref.slice(2)); if (p) return Card.curated(p); }
  if (s.ref?.startsWith('osm:')) { const o = Data.osmByKey.get(s.ref); if (o) return Card.osm(o); }
  Card.place(s);
}
function actionsHtml(s, query) {
  const g = query ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}` : gmapsUrl([s]);
  return `<div class="btnrow"><button class="btn pri" data-a="add"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Aan route</button>
  <a class="btn" href="${esc(g)}" target="_blank" rel="noopener"><svg viewBox="0 0 24 24"><path d="M12 21s-6.5-5.4-6.5-11a6.5 6.5 0 0 1 13 0c0 5.6-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg>Google Maps</a>
  <button class="btn" data-a="fly"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/></svg>Zoom in</button>
  <button class="btn visit${Store.isVisited(s.ref) ? ' on' : ''}" data-a="visit" aria-pressed="${Store.isVisited(s.ref)}"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg><span>${Store.isVisited(s.ref) ? 'Bezocht' : 'Markeer als bezocht'}</span></button></div>`;
}
function reviewsHtml(key) {
  const rv = Store.reviews(key);
  return `<section class="reviews"><h3>Ervaringen</h3>
  ${rv.length ? rv.map(r => `<div class="rv"><span class="st">${'★'.repeat(r.stars)}${'☆'.repeat(5 - r.stars)}</span> <b>${esc(r.author)}</b>${r.text ? '<br>' + esc(r.text) : ''}</div>`).join('') : '<p class="note">Nog geen ervaringen. Laat de eerste achter.</p>'}
  <div class="stars" role="group" aria-label="Waardering">${[1, 2, 3, 4, 5].map(n => `<button data-star="${n}" aria-label="${n} ${n === 1 ? 'ster' : 'sterren'}">★</button>`).join('')}</div>
  <textarea class="field" data-rv placeholder="Wat moet de volgende bezoeker weten?"></textarea>
  <div class="btnrow"><button class="btn" data-rv-send>Plaats ervaring</button></div>
  <p class="note">Ervaringen staan nu alleen op dit apparaat. Met accounts worden ze gedeeld.</p></section>`;
}
function setMedia(w) {
  const m = $('.media', Card.el); if (!m || !w?.big) return;
  m.classList.remove('slim'); const img = new Image(); img.alt = '';
  img.onerror = () => { if (w.thumb && img.src !== w.thumb) img.src = w.thumb; else img.remove(); };
  img.src = w.big; m.prepend(img);
  const cr = $('.credit', Card.el); if (cr && w.url) cr.insertAdjacentHTML('beforeend', ` Foto via <a href="${esc(w.url)}" target="_blank" rel="noopener">Wikipedia</a>.`);
}
// ---------- openingstijden (eenvoudige OSM opening_hours-parser, Amsterdamse tijd) ----------
const OH_D = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
function ohParse(s) {
  if (!s) return null; s = s.trim(); if (s === '24/7') return Array.from({ length: 7 }, () => [[0, 1440]]);
  const week = Array(7).fill(null);
  for (let rule of s.split(';')) {
    rule = rule.trim(); if (!rule || /^PH/.test(rule)) continue;
    const m = rule.match(/^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?,?)+)\s+(.+)$/); let days, times;
    if (m) { days = []; for (const part of m[1].split(',').filter(Boolean)) { const [a, b] = part.split('-'), i = OH_D.indexOf(a), j = b ? OH_D.indexOf(b) : i; for (let k = i; ; k = (k + 1) % 7) { days.push(k); if (k === j) break; } } times = m[2].trim(); }
    else if (/^\d/.test(rule)) { days = [0, 1, 2, 3, 4, 5, 6]; times = rule; } else return null;
    if (/^(off|closed)$/.test(times)) { for (const d of days) week[d] = []; continue; }
    const iv = []; for (const tt of times.split(',')) { const mm = tt.trim().match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})\+?$/); if (!mm) return null; const a = +mm[1] * 60 + +mm[2]; let b = +mm[3] * 60 + +mm[4]; if (b <= a) b += 1440; iv.push([a, b]); }
    for (const d of days) week[d] = iv;
  }
  return week;
}
function amsNow() { const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: CITY.tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map(x => [x.type, x.value])); return { d: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday), m: +p.hour * 60 + +p.minute }; }
const hhmm = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
function ohStatus(s) {
  const w = ohParse(s); if (!w) return null; const { d, m } = amsNow(); if (d < 0) return null;
  const yd = (d + 6) % 7;
  for (const [a, b] of w[d] || []) if (m >= a && m < b) return { open: true, text: `Nu open, tot ${hhmm(b)}` };
  for (const [a, b] of w[yd] || []) if (b > 1440 && m + 1440 < b) return { open: true, text: `Nu open, tot ${hhmm(b)}` };
  if (w[d] == null) return null;
  const next = (w[d] || []).find(([a]) => a > m);
  return { open: false, text: next ? `Gesloten, opent om ${hhmm(next[0])}` : 'Nu gesloten' };
}
function ohPretty(s) { const nl = { Mo: 'ma', Tu: 'di', We: 'wo', Th: 'do', Fr: 'vr', Sa: 'za', Su: 'zo', PH: 'feestdagen', off: 'gesloten', closed: 'gesloten' }; return esc(s).replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su|PH|off|closed)\b/g, x => nl[x]).replace(/;\s*/g, '<br>'); }
// ---------- lijnen, halte in de buurt ----------
function linesHtml(ls) {
  const by = new Map(); for (const L of ls) { const k = L.route + ':' + L.ref; if (!by.has(k)) by.set(k, L); }
  return `<ul class="lines">${[...by.values()].map(L => `<li><span class="lp" style="--c:${L.color}">${esc(ROUTE_LAB[L.route] || L.route)} ${esc(L.ref)}</span><small>${L.dests.size ? 'richting ' + esc([...L.dests].slice(0, 2).join(' / ')) : esc(L.name)}</small></li>`).join('')}</ul>`;
}
function nearestStop(x, z) {
  let best = null, bd = 700; for (const o of Data.osm) if (o.layer === 'tramstop' || o.tags.railway === 'station') { const d = Math.hypot(o.x - x, o.z - z); if (d < bd) { bd = d; best = o; } }
  return best ? { o: best, d: bd } : null;
}
function stopHtml(x, z) {
  const n = nearestStop(x, z); if (!n) return '';
  const ls = Transit.linesAt(n.o), refs = [...new Map(ls.map(L => [L.route + L.ref, L])).values()];
  return `<dt>Dichtstbijzijnde halte</dt><dd>${esc(n.o.name)}, ${fmtKm(n.d * 1.25)} lopen${refs.length ? `<br>${refs.map(L => `<span class="lp sm" style="--c:${L.color}">${esc(ROUTE_LAB[L.route] || '')} ${esc(L.ref)}</span>`).join(' ')}` : ''}</dd>`;
}
// ---------- Wikipedia: langere Nederlandstalige tekst ----------
async function wikiLong(ref) {
  const i = ref.indexOf(':'); let lang = ref.slice(0, i), title = wdec(ref.slice(i + 1)).replace(/_/g, ' ');
  if (lang !== LANG) { try { const j = await fetchJSON(`https://${lang}.wikipedia.org/w/api.php?action=query&prop=langlinks&lllang=${LANG}&redirects=1&titles=${encodeURIComponent(title)}&format=json&origin=*`, {}, 10000); const ll = Object.values(j.query?.pages || {})[0]?.langlinks?.[0]; if (ll) { lang = LANG; title = ll['*']; } } catch { } }
  const j = await fetchJSON(`https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=plain&exchars=2600&redirects=1&titles=${encodeURIComponent(title)}&format=json&origin=*`, {}, 12000);
  const text = Object.values(j.query?.pages || {})[0]?.extract; if (!text) return null;
  const paras = text.split(/\n+/).map(x => x.trim()).filter(x => x.length > 60).slice(0, 6);
  return { paras, lang, url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}` };
}
async function backgroundHtml(ref) {
  if (!ref) return ''; const w = await wikiLong(ref).catch(() => null); if (!w || !w.paras.length) return '';
  return `<section class="msec"><h3>Achtergrond</h3>${w.paras.map(p => `<p>${esc(p)}</p>`).join('')}<p class="note">Bron: <a href="${esc(w.url)}" target="_blank" rel="noopener">Wikipedia${w.lang !== LANG ? (w.lang === 'en' ? ' (Engelstalig)' : ' (Nederlandstalig)') : ''}</a>, CC BY-SA.</p></section>`;
}
function practicalHtml({ hours, site, book, phone, wheel, x, z }) {
  const rows = [], oh = ohStatus(hours);
  if (hours) rows.push(`<dt>Openingstijden</dt><dd>${oh ? `<span class="openb ${oh.open ? 'y' : 'n'}">${esc(oh.text)}</span><br>` : ''}${ohPretty(hours)}</dd>`);
  if (book) rows.push(`<dt>Tickets</dt><dd>${esc(book)}</dd>`);
  if (site) rows.push(`<dt>Website</dt><dd><a href="${esc(site)}" target="_blank" rel="noopener">${esc(site.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))}</a></dd>`);
  if (phone) rows.push(`<dt>Telefoon</dt><dd><a href="tel:${esc(phone.replace(/\s/g, ''))}">${esc(phone)}</a></dd>`);
  if (wheel) rows.push(`<dt>Rolstoel</dt><dd>${wheel === 'yes' ? 'Toegankelijk' : wheel === 'limited' ? 'Beperkt toegankelijk' : wheel === 'no' ? 'Niet toegankelijk' : esc(wheel)}</dd>`);
  const st = x != null ? stopHtml(x, z) : ''; if (st) rows.push(st);
  if (!hours) rows.push(`<dt>Actueel</dt><dd>Openingstijden wisselen soms. <a href="https://www.google.com/search?q=${encodeURIComponent('openingstijden ' + (arguments[0].name || ''))}" target="_blank" rel="noopener">Controleer vooraf</a></dd>`);
  return rows.length ? `<section class="msec"><h3>Praktisch</h3><dl class="facts">${rows.join('')}</dl></section>` : '';
}
async function moreCurated(p) {
  const t = p.osm?.tags || {}, info = CURATED_INFO[p.id] || {};
  const prac = practicalHtml({ name: p.name, hours: t.opening_hours, site: info.site || t.website || t['contact:website'], book: info.book, phone: t.phone || t['contact:phone'], wheel: t.wheelchair, x: p.x, z: p.z });
  return prac + await backgroundHtml(p.wiki);
}
async function moreOsm(o) {
  const t = o.tags; const isStop = o.layer === 'tramstop' || t.highway === 'bus_stop';
  if (isStop) return `<section class="msec"><h3>Reizen</h3><p><a href="${esc(CITY.transit.url)}" target="_blank" rel="noopener">${esc(CITY.transit.planner)}</a>. ${esc(CITY.transit.pay)}</p></section>`;
  const extra = t.cuisine ? `<p class="note">Keuken: ${esc(t.cuisine.replace(/;/g, ', '))}</p>` : '';
  return practicalHtml({ name: o.name, hours: t.opening_hours, site: t.website || t['contact:website'], phone: t.phone || t['contact:phone'], wheel: t.wheelchair, x: o.x, z: o.z }) + extra + await backgroundHtml(t.wikipedia);
}
const Card = {
  el: $('#card'), cur: null,
  show() { if (isNarrow()) UI.closePanel(); this.el.hidden = false; this.el.scrollTop = 0; },
  // (selectie wordt bij een nieuw pand vervangen)
  close() { Sel.hide(); Transit.unfocus(); if (!this.el.hidden) { this.el.hidden = true; this.cur = null; } },
  frame({ color, icon, slim, kick, title, body, stop, query, key, credit, reopen, more }) {
    this.el.innerHTML = `<div class="media${slim ? ' slim' : ''}" style="--c:${color}">${icon}<button class="close" aria-label="Sluit">×</button></div>
    <div class="cbody"><div class="kick">${kick}</div><h2>${esc(title)}</h2>${body}${actionsHtml(stop, query)}
    <button class="morebtn" data-a="more" aria-expanded="false"><span>Lees meer</span><i aria-hidden="true">▾</i></button>
    <div class="more" hidden></div><p class="credit">${credit}</p></div>`;
    $('.close', this.el).onclick = () => { Sound.click(); this.close(); };
    const moreEl = $('.more', this.el), token = this.cur; let loaded = false, stars = 0;
    const bindReviews = () => {
      moreEl.querySelectorAll('[data-star]').forEach(b => b.onclick = () => { stars = +b.dataset.star; moreEl.querySelectorAll('[data-star]').forEach(x => x.classList.toggle('on', +x.dataset.star <= stars)); Sound.click(); });
      const rb = moreEl.querySelector('[data-rv-send]'); if (rb) rb.onclick = () => { if (!stars) { toast('Kies eerst een aantal sterren'); return; } Store.addReview(key, { stars, text: $('[data-rv]', moreEl).value.trim().slice(0, 600) }); Sound.pop(); toast('Bedankt, je ervaring staat erbij'); reopen(); };
    };
    this.el.querySelectorAll('[data-a]').forEach(b => b.onclick = async () => {
      const a = b.dataset.a;
      if (a === 'add') MyRoute.add(stop);
      if (a === 'visit') {
        const on = !Store.isVisited(stop.ref); Store.setVisited(stop.ref, on); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); $('span', b).textContent = on ? 'Bezocht' : 'Markeer als bezocht';
        if (on) { Sound.stamp(); toast(`✓ ${esc(stop.name)} staat op je lijst als bezocht`); } else Sound.click();
        if (stop.ref.startsWith('g:')) { const p = Data.byId.get(stop.ref.slice(2)); if (p) Pins.refresh(p); }
        if (UI.tab === 'plan' || UI.tab === 'ontdek') UI.render();
      }
      if (a === 'fly') { const [x, z] = toLocal(stop.lat, stop.lon); flyTo(x, z, 220, { shift: isNarrow(), polar: 1 }); }
      if (a === 'more') {
        const open = moreEl.hidden; moreEl.hidden = !open; b.setAttribute('aria-expanded', open); $('span', b).textContent = open ? 'Minder tonen' : 'Lees meer'; Sound.click();
        if (open && !loaded) {
          loaded = true; moreEl.innerHTML = '<p class="note">Meer informatie laden…</p>';
          let html = ''; try { html = more ? await more() : ''; } catch (e) { console.warn(e); }
          if (this.cur !== token) return;
          moreEl.innerHTML = (html || '') + reviewsHtml(key); bindReviews(); Account.remoteReviews(key, moreEl);
        }
      }
    });
    this.show();
  },
  curated(p) {
    Sel.hide(); Transit.unfocus(); this.cur = p; if (!p.area) Sel.show({ id: 'sel:' + p.key, rings: null, cx: p.x, cz: p.z, probe: true }); const C = CATS[p.cat], st = Store.stamps()[p.id];
    const media = p.video ? `<iframe src="https://www.youtube-nocookie.com/embed/${esc(p.video)}" title="Video" allow="encrypted-media; picture-in-picture" allowfullscreen></iframe>` : C.icon;
    this.frame({
      color: C.color, icon: media, key: p.key, stop: stopFromCurated(p), query: p.name + ' ' + CITY.name, reopen: () => this.curated(p),
      kick: `<span class="pill c" style="--c:${C.color}">${C.label}</span><span class="pill">± ${fmtDur(p.time)}</span>${st ? `<span class="pill" style="color:var(--red)">✕ ${st === 'visited' ? 'Bezocht' : 'Gestempeld'}</span>` : ''}`,
      title: p.name,
      body: `<p class="lede">${esc(p.lede)}</p><dl class="facts">${Object.entries(p.facts || {}).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>${p.tip ? `<p class="tip"><b>Tip van de gids.</b> ${esc(p.tip)}</p>` : ''}`,
      credit: 'Tekst: Dwaal-gids.', more: () => moreCurated(p),
    });
    if (!p.video && p.wiki) wiki(p.wiki).then(w => { if (this.cur === p) setMedia(w); });
    if (Store.stamp(p.id, 'seen')) { const n = Object.keys(Store.stamps()).length; setTimeout(() => { Sound.stamp(); toast(`✕ Nieuwe stempel: ${esc(p.name)} (${n} van ${CURATED.length})`); }, 420); }
    else Sound.open();
  },
  osm(o) {
    Sel.hide(); Transit.unfocus(); this.cur = o; if (!isStreet(o)) Sel.show({ id: 'sel:' + o.key, rings: null, cx: o.x, cz: o.z, probe: true }); const t = o.tags, L = LAYERS.find(l => l.id === (o.layer === 'tramstop' ? 'tram' : o.layer)) || LAYERS[0];
    const addr = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ');
    const icon = { musea: '🖼️', theater: '🎭', eten: foodIcon(t), zien: '📍', markt: '🛍️', groen: '🌳', ov: '🚉', tram: '🚋' }[L.id] || '📍';
    const isStop = o.layer === 'tramstop' || o.tags.highway === 'bus_stop' || o.tags.railway === 'station' || o.tags.railway === 'subway_entrance';
    const oh = ohStatus(t.opening_hours);
    let body = '';
    if (isStop) {
      const ls = Transit.linesAt(o);
      body = ls.length ? `<h3 class="sub" style="margin-top:4px">Lijnen die hier stoppen</h3>${linesHtml(ls)}` : `<p class="note">${Transit.all.length ? 'Geen lijnen gevonden voor deze halte.' : 'Lijninformatie wordt nog geladen.'}</p>`;
      const drawn = ls.filter(l => l.obj); if (drawn.length) Transit.focus(drawn);
    } else {
      const bits = []; if (oh) bits.push(`<span class="openb ${oh.open ? 'y' : 'n'}">${esc(oh.text)}</span>`); if (addr) bits.push(esc(addr));
      if (bits.length) body = `<p class="lede" style="font-size:15px">${bits.join(' ')}</p>`;
    }
    this.frame({
      color: L.color, icon, slim: true, key: o.key, stop: { name: o.name, lat: o.lat, lon: o.lon, ref: o.key }, query: o.name + (addr ? ' ' + addr : '') + ' ' + CITY.name, reopen: () => this.osm(o),
      kick: `<span class="pill c" style="--c:${L.color}">${esc(typeLabel(t))}</span>`, title: o.name, body,
      credit: 'Gegevens: © OpenStreetMap-bijdragers.', more: () => moreOsm(o),
    });
    Sound.open(); if (t.wikipedia) wiki(t.wikipedia).then(w => { if (this.cur === o) setMedia(w); });
  },
  building(pt) {
    Sel.hide(); Transit.unfocus();
    const [lat, lon] = localToWgs(pt.x, pt.z), stop = { name: 'Pand', lat, lon, ref: 'b:' + lat.toFixed(5) + ',' + lon.toFixed(5) }, tok = {}; this.cur = tok;
    this.frame({
      color: '#5E6B6D', icon: '🏠', slim: true, key: stop.ref, stop, reopen: () => this.building(pt),
      kick: '<span class="pill" id="bAge">Pand</span>', title: 'Pand', body: '<dl class="facts" id="bFacts"><dt>Gegevens</dt><dd>laden…</dd></dl>',
      credit: CITY.buildings === '3dbag' ? 'Bron: 3DBAG (TU Delft).' : 'Bron: Overture Maps Foundation.',
    });
    Sound.open();
    Promise.resolve(Baked.footprint(pt.x, pt.z, 4)).then(f => {
      if (this.cur !== tok) return; const el = $('#bFacts', this.el); if (!f) { if (el) el.innerHTML = '<dt>Gegevens</dt><dd>Geen BAG-pand gevonden</dd>'; return; }
      rayBudget += 6; const h = footprintHeight(f) ?? pt.y, facts = {}; Sel.show(f);
      if (f.name) facts['Naam'] = f.name; if (f.yr) facts['Bouwjaar'] = f.yr; if (f.architect) facts['Architect'] = f.architect; if (f.levels) facts['Verdiepingen'] = f.levels; facts['Hoogte'] = `ca. ${Math.round(h)} m`; if (/^\d{10,}$/.test(f.id)) facts['BAG-pand'] = f.id;
      if (el) el.innerHTML = Object.entries(facts).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
      const age = f.yr ? (f.yr < 1700 ? 'Gouden Eeuw of ouder' : f.yr < 1900 ? '18e en 19e eeuw' : f.yr < 1960 ? 'Vooroorlogs en wederopbouw' : 'Modern') : 'Pand';
      const a = $('#bAge', this.el); if (a) a.textContent = age; if (f.yr) stop.name = `Pand uit ${f.yr}`;
    }).catch(() => { const el = $('#bFacts', this.el); if (el && this.cur === tok) el.innerHTML = '<dt>Gegevens</dt><dd>BAG is nu niet bereikbaar</dd>'; });
    geoReverse(lat, lon).then(nm => {
      if (!nm || this.cur !== tok) return;
      stop.name = nm; const h = $('h2', this.el); if (h) h.textContent = nm;
    }).catch(() => { });
  },
  place(s) {
    this.cur = s;
    this.frame({ color: '#2E5E57', icon: '📍', slim: true, key: 'a:' + s.lat.toFixed(5) + ',' + s.lon.toFixed(5), stop: s, reopen: () => this.place(s), kick: '<span class="pill">Plek</span>', title: s.name, body: '', credit: '' });
    Sound.open();
  },
};

// =====================================================================
//  PANEEL: Ontdek, Routes, Mijn route, Stempels
// =====================================================================
const UI = {
  tab: null, filter: 'all', detail: null, shared: null, panel: $('#panel'), body: $('#pbody'),
  loader: { progress(p) { $('#lbar').style.width = Math.round(p * 100) + '%'; }, status(s) { $('#lstat').textContent = s; } },
  openTab(t, force) {
    if (!force && this.tab === t && this.panel.classList.contains('open')) { this.closePanel(); Sound.click(); return; }
    if (t !== 'buurten') Districts.hide();
    this.tab = t; $$('.tab').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === t || (t === 'stempels' && b.dataset.tab === 'ontdek')));
    this.panel.classList.add('open'); if (isNarrow()) Card.close(); this.render(); Sound.click();
  },
  closePanel() { this.panel.classList.remove('open'); $$('.tab').forEach(b => b.setAttribute('aria-selected', false)); this.tab = null; },
  render() { this.body.scrollTop = 0; ({ ontdek: renderOntdek, buurten: renderBuurten, plan: renderPlan, routes: renderRoutes, mijn: renderMijn, stempels: renderStempels })[this.tab]?.(); },
};
function loadThumbs(root) {
  $$('[data-wiki]', root).forEach(el => { const w = el.dataset.wiki; if (!w) return; wiki(w).then(r => { if (r?.thumb) { const img = new Image(); img.alt = ''; img.loading = 'lazy'; img.onload = () => { el.textContent = ''; el.appendChild(img); }; img.src = r.thumb; } }); });
}
function rcardHtml(r, idx) { return `<button class="rcard" data-route="${idx}" style="--c:${r.color || '#D7262C'}"><span class="bar"></span><span><h3>${esc(r.title)}</h3>${r.desc ? `<p>${esc(r.desc)}</p>` : ''}<small>${r.stops.length} stops, ± ${fmtKm(estDist(r.stops))}${r.author && !r.preset ? `, door ${esc(r.author)}` : ''}</small></span></button>`; }
function renderRoutes() {
  if (UI.detail) return renderRouteDetail(UI.detail);
  const list = [], saved = Store.routes();
  if (UI.shared) list.push(UI.shared); const presets = PRESET_ROUTES.map(presetRoute), dr = Districts.list.flatMap(D => districtRoutes(D, true)); list.push(...presets, ...dr, ...saved);
  let i = 0;
  UI.body.innerHTML = `<div class="ph"><h2>Routes</h2><p>Wandelroutes langs de mooiste plekken. Kies er een en loop hem hier alvast af.</p></div>
  ${UI.shared ? `<h3 class="sub">Gedeeld met jou</h3>${rcardHtml(UI.shared, i++)}` : ''}
  <h3 class="sub">Aanbevolen door de gids</h3>${presets.map(r => rcardHtml(r, i++)).join('')}
  <h3 class="sub">Per buurt</h3>${dr.map(r => rcardHtml(r, i++)).join('')}
  <h3 class="sub">Jouw bewaarde routes</h3>${saved.length ? saved.map(r => rcardHtml(r, i++)).join('') : '<p class="empty">Nog niets bewaard. Stel onder Mijn route je eigen wandeling samen en bewaar hem.</p>'}`;
  $$('[data-route]', UI.body).forEach(b => b.onclick = () => { UI.detail = list[+b.dataset.route]; Sound.click(); RouteView.show(UI.detail); renderRoutes(); });
}
function stopsHtml(stops, color, sortable) {
  return `<ol class="stops" id="${sortable ? 'mStops' : 'dStops'}">${stops.map((s, i) => `<li class="stop" data-i="${i}" style="--c:${color}"><span class="n">${i + 1}</span><button class="nm" data-go="${i}" style="text-align:left"><b>${esc(s.name)}</b><small>${s.ref?.startsWith('g:') ? esc(CATS[Data.byId.get(s.ref.slice(2))?.cat]?.label || 'Plek') : s.ref?.startsWith('osm:') ? 'Plek' : s.ref?.startsWith('b:') ? 'Pand' : 'Adres'}</small></button>${sortable ? `<button class="grip" data-sort="${i}" aria-label="Verplaats ${esc(s.name)}">⠿</button><button class="rm" data-rm="${i}" aria-label="Verwijder ${esc(s.name)}">×</button>` : ''}</li>`).join('')}</ol>`;
}
function statsHtml(cur, stops) { const d = cur?.dist || estDist(stops), t = cur?.dur || d / 1.3; return `<div><b>${fmtKm(d)}</b>lopen</div><div><b>${fmtMin(t)}</b>zonder stops</div><div><b>${stops.length}</b>stops</div>`; }
function renderRouteDetail(r) {
  const isSaved = Store.routes().some(x => x.id === r.id);
  UI.body.innerHTML = `<button class="btn" id="back" style="margin:4px 0 10px">‹ Alle routes</button>
  <div class="ph"><h2>${esc(r.title)}</h2>${r.desc ? `<p>${esc(r.desc)}</p>` : ''}</div>
  <div class="stats" id="dStats">${statsHtml(null, r.stops)}</div>
  <div class="btnrow"><button class="btn pri" data-r="tour"><svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>Start tour</button><button class="btn" data-r="gmaps">Google Maps</button><button class="btn" data-r="copy">Bewerk als mijn route</button><button class="btn" data-r="share">Deel</button>${isSaved ? '<button class="btn" data-r="del">Verwijder</button>' : ''}</div>
  ${stopsHtml(r.stops, r.color || '#D7262C', false)}`;
  $('#back').onclick = () => { UI.detail = null; RouteView.clear(); Sound.click(); renderRoutes(); };
  $$('[data-go]', UI.body).forEach(b => b.onclick = () => openStop(r.stops[+b.dataset.go]));
  const upd = () => { if (RouteView.current && RouteView.current.id === r.id && RouteView.current.dist) $('#dStats') && ($('#dStats').innerHTML = statsHtml(RouteView.current, r.stops)); };
  setTimeout(upd, 1500); setTimeout(upd, 4000);
  $$('[data-r]', UI.body).forEach(b => b.onclick = () => {
    const a = b.dataset.r;
    if (a === 'tour') { RouteView.show(r, { fit: false }); Tour.start(r); }
    if (a === 'gmaps') openGmaps(r.stops);
    if (a === 'share') shareRoute(r);
    if (a === 'copy') { MyRoute.r = { id: uid(), title: r.title + ' (mijn versie)', stops: r.stops.map(s => ({ ...s })) }; MyRoute.save(); UI.detail = null; UI.openTab('mijn', true); RouteView.show(MyRoute.asRoute()); }
    if (a === 'del' && confirm('Deze route verwijderen?')) { Store.deleteRoute(r.id); UI.detail = null; RouteView.clear(); renderRoutes(); }
  });
}
let addrT;
function renderMijn() {
  const r = MyRoute.r, st = r.stops;
  UI.body.innerHTML = `<div data-drop="route"><div class="ph"><input class="field titlein" id="rtTitle" value="${esc(r.title)}" aria-label="Naam van je route"></div>
  <div class="stats" id="mStats">${statsHtml(RouteView.current?.draft ? RouteView.current : null, st)}</div>
  ${stopsHtml(st, '#D7262C', true)}
  <div class="dropzone">${st.length ? 'Sleep meer plekken hierheen' : 'Sleep plekken hierheen vanuit Ontdek, of druk lang op een gebouw op de kaart. Tikken op + werkt ook.'}</div>
  <input class="field" id="addrQ" placeholder="Voeg een adres toe" autocomplete="off"><ul class="sresults" id="addrRes"></ul>
  <div class="btnrow"><button class="btn pri" data-m="show">Toon op kaart</button><button class="btn" data-m="tour">Start tour</button><button class="btn" data-m="gmaps">Google Maps</button><button class="btn" data-m="save">Bewaar</button><button class="btn" data-m="share">Deel</button>${st.length ? '<button class="btn" data-m="clear">Leegmaken</button>' : ''}</div></div>`;
  $('#rtTitle').onchange = e => { r.title = e.target.value.trim() || 'Mijn route'; MyRoute.save(); };
  $$('[data-go]', UI.body).forEach(b => b.onclick = () => openStop(st[+b.dataset.go]));
  $$('[data-rm]', UI.body).forEach(b => b.onclick = () => { st.splice(+b.dataset.rm, 1); MyRoute.save(); Sound.click(); renderMijn(); if (RouteView.current?.draft) RouteView.show(MyRoute.asRoute(), { fit: false }); });
  $$('[data-sort]', UI.body).forEach(b => b.addEventListener('pointerdown', e => sortStart(e, +b.dataset.sort)));
  $('#addrQ').oninput = e => {
    clearTimeout(addrT); const q = e.target.value.trim(); const out = $('#addrRes'); if (q.length < 3) { out.innerHTML = ''; return; }
    addrT = setTimeout(async () => {
      try { const res = await geoSearch(q); out.innerHTML = res.length ? res.map((d, i) => `<li><button data-ad="${i}"><span class="ic">📍</span><span>${esc(d.name)}</span></button></li>`).join('') : '<li class="empty">Geen adres gevonden binnen het kaartgebied.</li>';
        $$('[data-ad]', out).forEach(b => b.onclick = () => { const d = res[+b.dataset.ad]; MyRoute.add({ name: d.name.split(',')[0], lat: d.lat, lon: d.lon, ref: 'a:' + d.lat.toFixed(5) + ',' + d.lon.toFixed(5) }); }); }
      catch { out.innerHTML = '<li class="empty">Adressen zoeken lukt nu niet. Controleer je verbinding.</li>'; }
    }, 300);
  };
  $$('[data-m]', UI.body).forEach(b => b.onclick = async () => {
    const a = b.dataset.m; if (!st.length && a !== 'clear') { toast('Je route is nog leeg'); return; }
    if (a === 'show') { const c = await RouteView.show(MyRoute.asRoute()); const s = $('#mStats'); if (s && c) s.innerHTML = statsHtml(c, st); }
    if (a === 'tour') { RouteView.show(MyRoute.asRoute(), { fit: false }); Tour.start(MyRoute.asRoute()); }
    if (a === 'gmaps') openGmaps(st);
    if (a === 'save') { Store.saveRoute({ id: r.id, title: r.title, color: '#D7262C', stops: st.map(s => ({ ...s })) }); Sound.stamp(); toast('Bewaard. Je vindt hem onder Routes.'); }
    if (a === 'share') shareRoute({ title: r.title, color: '#D7262C', stops: st });
    if (a === 'clear' && confirm('Alle stops uit je route halen?')) { MyRoute.r = { id: uid(), title: 'Mijn route', stops: [] }; MyRoute.save(); RouteView.clear(); renderMijn(); }
  });
}
function sortStart(e, i) {
  e.preventDefault(); const list = $('#mStops'), items = [...list.children], li = items[i], h = li.getBoundingClientRect().height, y0 = e.clientY; let target = i;
  li.classList.add('drag');
  const move = ev => {
    const dy = ev.clientY - y0; li.style.transform = `translateY(${dy}px)`; target = clamp(i + Math.round(dy / h), 0, items.length - 1);
    items.forEach((el, k) => { if (k === i) return; let off = 0; if (i < target && k > i && k <= target) off = -h; if (i > target && k < i && k >= target) off = h; el.style.transform = off ? `translateY(${off}px)` : ''; });
  };
  const up = () => {
    removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
    if (target !== i) { const s = MyRoute.r.stops.splice(i, 1)[0]; MyRoute.r.stops.splice(target, 0, s); MyRoute.save(); Sound.drop(); if (RouteView.current?.draft) RouteView.show(MyRoute.asRoute(), { fit: false }); }
    renderMijn();
  };
  addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
}
function renderStempels() {
  const s = Store.stamps(), n = CURATED.filter(p => s[p.id]).length, v = CURATED.filter(p => s[p.id] === 'visited').length;
  UI.body.innerHTML = `<button class="btn" id="stBack" style="margin:4px 0 10px">‹ Ontdek</button><div class="ph"><h2>Stempelkaart</h2><p>Open een plek in de gids en je krijgt een stempel. Sta je er echt voor de deur met je locatie aan, dan wordt hij rood gevuld.</p></div>
  <div class="stats"><div><b>${n} van ${CURATED.length}</b>ontdekt</div><div><b>${v}</b>bezocht</div></div>
  <div class="progress"><i style="width:${n / CURATED.length * 100}%"></i></div>
  <div class="stamps">${CURATED.map(p => `<button class="stamp ${s[p.id] || ''}" data-open="${p.id}"><span class="s">${CATS[p.cat].icon}</span><span>${esc(p.name)}</span></button>`).join('')}</div>`;
  $$('[data-open]', UI.body).forEach(b => b.onclick = () => openStop(stopFromCurated(Data.byId.get(b.dataset.open))));
  $('#stBack').onclick = () => UI.openTab('ontdek', true);
}

// =====================================================================
//  ZOEKEN
// =====================================================================
let qT;
function openSearch() { Sound.click(); $('#search').hidden = false; $('#q').value = ''; $('#qres').innerHTML = '<p class="empty">Zoek op naam, bijvoorbeeld Rijksmuseum, of op een adres.</p>'; $('#q').focus(); }
function closeSearch() { $('#search').hidden = true; }
$('#q').addEventListener('input', e => {
  clearTimeout(qT); const q = e.target.value.trim().toLowerCase(), out = $('#qres'); if (q.length < 2) { out.innerHTML = ''; return; }
  const g = CURATED.filter(p => p.name.toLowerCase().includes(q)).slice(0, 6);
  const o = Data.osm.filter(x => x.name.toLowerCase().includes(q) && x.layer !== 'ov').slice(0, 8);
  const rows = [...g.map(p => ({ s: stopFromCurated(p), ic: CATS[p.cat].icon, c: CATS[p.cat].color, sub: 'Gids: ' + CATS[p.cat].label })), ...o.map(x => ({ s: { name: x.name, lat: x.lat, lon: x.lon, ref: x.key }, ic: '📍', c: 'var(--paper2)', sub: typeLabel(x.tags) }))];
  const draw = extra => {
    const all = rows.concat(extra || []);
    out.innerHTML = all.length ? `<ul class="sresults">${all.map((r, i) => `<li><button data-q="${i}"><span class="ic" style="--c:${r.c}">${r.ic}</span><span>${esc(r.s.name)}<small>${esc(r.sub)}</small></span></button></li>`).join('')}</ul>` : '<p class="empty">Niets gevonden. Probeer een andere naam of een straat.</p>';
    $$('[data-q]', out).forEach(b => b.onclick = () => { closeSearch(); openStop(all[+b.dataset.q].s); });
  };
  draw();
  if (q.length >= 3) qT = setTimeout(async () => { try { const res = await geoSearch(e.target.value.trim()); draw(res.map(d => ({ s: { name: d.name.split(',')[0], lat: d.lat, lon: d.lon, ref: 'a:' + d.lat.toFixed(5) + ',' + d.lon.toFixed(5) }, ic: '🏠', c: 'var(--paper2)', sub: d.type === 'weg' ? 'Straat' : 'Adres' }))); } catch { } }, 320);
});

// =====================================================================
//  LOCATIE (voor gouden stempels ter plekke)
// =====================================================================
const Me = {
  g: null, watch: null,
  locate() {
    if (!navigator.geolocation) { toast('Locatie is niet beschikbaar in deze browser'); return; }
    Sound.click();
    navigator.geolocation.getCurrentPosition(p => { this.update(p, true); if (!this.watch) this.watch = navigator.geolocation.watchPosition(q => this.update(q, false), () => { }, { enableHighAccuracy: true, maximumAge: 10000 }); },
      () => toast('Geen toegang tot je locatie. Sta locatie toe in je browser.'), { enableHighAccuracy: true, timeout: 12000 });
  },
  update(p, fly) {
    const [x, z] = toLocal(p.coords.latitude, p.coords.longitude), inside = x * x + z * z < R * R;
    if (!this.g) {
      this.g = new THREE.Group();
      const dot = new THREE.Mesh(new THREE.CircleGeometry(5, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color('#3E7BF0').multiplyScalar(2.5), depthTest: false }));
      const ring = new THREE.Mesh(new THREE.RingGeometry(6, 8, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#3E7BF0', transparent: true, depthTest: false }));
      dot.renderOrder = ring.renderOrder = 28; this.g.add(dot, ring); this.g.userData.ring = ring; scene.add(this.g);
    }
    this.g.position.set(x, 3, z); this.g.visible = inside;
    if (fly) { if (inside) flyTo(x, z, 350, { shift: false }); else toast('Je bent buiten het kaartgebied. Dwaal toont nu het centrum.', 4000); }
    if (inside) for (const c of CURATED) if (Math.hypot(c.x - x, c.z - z) < 60 && Store.stamp(c.id, 'visited')) { Sound.stamp(); toast(`✕ Gouden stempel: je staat bij ${esc(c.name)}`, 4500); }
  },
};

// =====================================================================
//  CHROME, LOOP, RESIZE, OPSTART
// =====================================================================
function bindChrome() {
  $$('.tab').forEach(b => b.onclick = () => { Sound.init(); UI.openTab(b.dataset.tab); });
  $('#dock').onclick = () => { Sound.init(); UI.openTab('mijn', true); };
  $('#grab').onclick = () => UI.closePanel();
  $('#btnSearch').onclick = () => { Sound.init(); openSearch(); };
  $('#qClose').onclick = closeSearch;
  const sb = $('#btnSound'); sb.setAttribute('aria-pressed', Sound.on);
  sb.onclick = () => { Sound.init(); Sound.set(!Sound.on); sb.setAttribute('aria-pressed', Sound.on); if (Sound.on) Sound.click(); };
  $('#btnLocate').onclick = () => { Sound.init(); Me.locate(); };
  $('#btnHome').onclick = () => { Sound.init(); flyTo(0, -R * .04, R * 1.25, { polar: .82 }); };
  addEventListener('keydown', e => { if (e.key === 'Escape') { if (!$('#search').hidden) closeSearch(); else if (!Card.el.hidden) Card.close(); else UI.closePanel(); } });
}
function onResize() {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight);
  for (const m of lineMats) m.resolution.set(innerWidth, innerHeight);
  Tiles.r?.setResolutionFromRenderer(camera, renderer);
  for (const p of pointObjs) p.material.size = p.userData.basePx * renderer.getPixelRatio();
  Pins.resize(); Districts.resize(); const k = pxScale(30); for (const sp of RouteView.marks) sp.scale.set(k, k, 1);
}
addEventListener('resize', onResize);
const clock = new THREE.Clock(); let ambT = 0;
function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), .05), t = clock.elapsedTime;
  stepTween(); controls.update(); clampTarget(); updateDim(dt);
  { // dieptebereik meeschalen met de afstand: anders wint het water het van de kade als je ver uitzoomt
    const cd0 = camera.position.distanceTo(controls.target), nr = clamp(cd0 * .04, 2, 600), fr = cd0 * 3 + R * 4;
    if (Math.abs(nr - camera.near) > camera.near * .15 || Math.abs(fr - camera.far) > camera.far * .15) { camera.near = nr; camera.far = fr; camera.updateProjectionMatrix(); }
  }
  camera.updateMatrixWorld(); Tiles.refresh(); slowTick(t);
  M.water.normalMap.offset.set(t * .012, t * .007);
  const camD = camera.position.distanceTo(controls.target);
  const pulse = .22 + .14 * Math.sin(t * 2.6);
  for (const k in Layers.hl) for (const o of Layers.hl[k]) if (o.isMesh) o.material.emissiveIntensity = pulse;
  if (Layers.state.gids) for (const sp of Pins.list) sp.position.y = sp.userData.baseY + (Math.sin(t * 2 + sp.userData.phase) * .5 + .5) * camD * .006;
  for (const mv of Movers) {
    mv.s += mv.speed * dt * mv.dir;
    if (mv.s > mv.T.len) { mv.s = mv.T.len; mv.dir = -1; } else if (mv.s < 0) { mv.s = 0; mv.dir = 1; }
    sampleTrack(mv.T, mv.s, tmpS); mv.mesh.position.set(tmpS.x, mv.y, tmpS.z); mv.mesh.rotation.y = tmpS.ang;
    mv.mesh.visible = tmpS.x * tmpS.x + tmpS.z * tmpS.z < (R - 14) ** 2;
  }
  RouteView.tick(t); tickLife(t, dt); Districts.tick(dt); HL.tick(); FarHL.tick(performance.now()); HL_U.glow.value = .55 + .22 * Math.sin(t * 2.6);
  if (Me.g?.visible) { const r = Me.g.userData.ring, k = 1 + (t % 1.6) * 2; r.scale.set(k, 1, k); r.material.opacity = 1 - (t % 1.6) / 1.6; }
  if (Sound.ctx && t - ambT > .5) { ambT = t; Sound.ambient(camD < 700 ? .012 * (1 - camD / 700) : 0); }
  Shadow.tick(performance.now());
  composer.render();
  Perf.tick(dt);
}
// ---------- adaptieve resolutie + optionele meter (?debug in de URL) ----------
const Perf = {
  acc: 0, n: 0, lastChange: 0, hud: null,
  init() { if (/debug/.test(location.search)) { this.hud = document.createElement('div'); this.hud.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:300;background:#000a;color:#fff;font:12px ui-monospace,monospace;padding:6px 8px;border-radius:8px;pointer-events:none;white-space:pre'; document.body.appendChild(this.hud); } },
  tick(dt) {
    this.acc += dt; this.n++; if (this.acc < 1) return;
    const ms = this.acc / this.n * 1000, now = performance.now(); this.acc = 0; this.n = 0;
    const pr = renderer.getPixelRatio();
    if (now - this.lastChange > 2500 && document.visibilityState === 'visible') {
      let np = pr; if (ms > 24 && pr > PR_MIN) np = Math.max(PR_MIN, pr - .25); else if (ms < 13 && pr < PR_MAX) np = Math.min(PR_MAX, pr + .25);
      if (np !== pr) { this.lastChange = now; renderer.setPixelRatio(np); composer.setPixelRatio(np); onResize(); }
    }
    if (this.hud) { const i = renderer.info.render; this.hud.textContent = `${(1000 / ms).toFixed(0)} fps  ${ms.toFixed(1)} ms\nresolutie x${renderer.getPixelRatio().toFixed(2)}\ndraw calls ${i.calls}  driehoeken ${(i.triangles / 1e6).toFixed(2)} M\ntiles ${Tiles.list.length}  bvh-wachtrij ${Tiles.bvhQ.length}`; }
  },
};
async function loadPlaces() {
  try { Data.addPois(venueFilter(await Baked.json('places'))); } catch (e) { ErrLog.add('plekken: ' + e.message); }
  buildPoints();
  for (const L of LAYERS) if (Layers.state[L.id]) { Layers.ensure(L.id); Layers.dirty.add(L.id); }
  console.info(`Plekken geladen: ${Data.osm.length} (waarvan ${Data.osm.filter(o => o.layer === 'eten').length} eten en drinken)`);
}
let slowT = 0;
function slowTick(t) {
  if (t - slowT < .7) return; slowT = t;
  rayBudget = 400;   // max ~400 raycasts per 0,7 s (met BVH goedkoop)
  Pins.tick(); Layers.tick(); updatePointHeights();
  // af en toe een meeuw, alleen als je ingezoomd bent
  if (Sound.ctx && Life.gulls && camera.position.distanceTo(controls.target) < 900 && Math.random() < .035) Sound.gull();
}
async function boot() {
  ErrLog.init(); safe(() => installTranslator(), 'vertaling'); safe(() => Chrome.init(), 'kop');
  for (const [fn, n] of [[() => Perf.init(), 'perf'], [() => HL.init(), 'markering'], [() => FarHL.init(), 'verre markering'], [() => View.init(), 'weergave'], [() => { window.__dwaal = { Layers, HL, FarHL, View, Baked }; }, 'debug'], [() => Data.prep(), 'gids'], [() => Layers.init(), 'lagen'], [() => Pins.init(), 'pins'], [() => Districts.init(), 'buurten'], [() => Food.render(), 'eten'], [() => updateDock(), 'dock'], [() => bindChrome(), 'knoppen']]) safe(fn, n);
  Auth.init().then(() => Account.sync()).catch(e => console.warn('auth', e));
  const m = location.hash.match(/#r=([\w-]+)/); if (m) UI.shared = decodeRoute(m[1]);
  camera.position.set(R * .25, R * 1.3, R * 1.3);
  Baked.load().catch(e => { ErrLog.add(e.message); UI.loader.status(e.message); });
  for (const L of LAYERS) if (Layers.state[L.id]) { Layers.ensure(L.id); Layers.dirty.add(L.id); }
  loop();
  let geoDone = false, tilesReady = false;
  const setP = () => UI.loader.progress(Math.min(1, (geoDone ? .35 : 0) + .65 * (tilesReady ? 1 : Tiles.progress * .9)));
  Tiles.onReady = () => { tilesReady = true; setP(); };
  UI.loader.status('Kaartdata laden…');
  const pG = Baked.json('base').then(B => ({ elements: baseToEls(B), base: B })).then(j => { geoDone = true; setP(); UI.loader.status('Water en straten tekenen…'); safe(() => addGeo(j), 'kaart'); safe(() => Night.build(j.elements || []), 'nacht'); })
    .catch(e => { console.error(e); geoDone = true; toast('Water en straten konden niet worden geladen.', 5000); });
  const pP = loadPlaces();
  const iv = setInterval(setP, 300), t0 = performance.now();
  await pG;
  while (!tilesReady && performance.now() - t0 < 30000) {
    if (Tiles.failed > 4 && !Tiles.meshes.size) break;
    if (!tilesReady) UI.loader.status(Tiles.meshes.size ? 'Panden plaatsen…' : 'Gebouwen ophalen…');
    await new Promise(r => setTimeout(r, 250));
  }
  clearInterval(iv); UI.loader.progress(1);
  UI.loader.status(tilesReady ? (CITY.buildings === '3dbag' ? 'Gebouwen uit 3DBAG. Meer detail laadt mee terwijl je rondkijkt.' : 'Gebouwen uit Overture Maps. Meer detail laadt mee terwijl je rondkijkt.') : Tiles.failed ? '3DBAG is nu niet bereikbaar. De kaart werkt, gebouwen verschijnen zodra ze laden.' : 'De gebouwen laden nog. Je kunt alvast beginnen.');
  if (!tilesReady) Tiles.onReady = () => toast('Gebouwen geladen');
  const sb = $('#startBtn'); sb.hidden = false; sb.focus();
  sb.onclick = () => {
    Sound.init(); Sound.whoosh(); $('#loader').classList.add('gone');
    flyTo(CITY.startView?.x ?? 0, CITY.startView?.z ?? 0, CITY.startView?.d ?? R * .85, { polar: .9, dur: 3.2, silent: true });
    if (UI.shared) setTimeout(() => { UI.detail = UI.shared; UI.openTab('routes', true); RouteView.show(UI.shared); toast('Iemand heeft een route met je gedeeld'); }, 3300);
  };
  await pP;
  Baked.json('transit').then(j => { Transit.build(j); legend(); Transit.setGlow(!!Layers.state.tram); })
    .catch(e => { console.error(e); toast('Het tram- en metronetwerk kon niet worden geladen.', 4000); });
}

// =====================================================================
//  ETEN & DRINKEN: subcategorieën (koffie, lunch, diner, borrel, snel)
// =====================================================================
const FOOD_SUBS = [['all', 'Alles'], ['koffie', 'Koffie'], ['lunch', 'Ontbijt & lunch'], ['diner', 'Diner'], ['bar', 'Borrel & bars'], ['snel', 'Snel & zoet']];
const FOOD_LABEL = { koffie: 'Koffiepauze', lunch: 'Lunch', diner: 'Diner', bar: 'Borrel', snel: 'Iets kleins' };
function foodSubs(t) {
  const s = new Set(), a = t.amenity, c = (t.cuisine || '').toLowerCase();
  if (a === 'cafe') { s.add('koffie'); if (!/coffee_shop/.test(c)) s.add('lunch'); }
  if (a === 'restaurant') s.add('diner');
  if (/breakfast|brunch|sandwich|bagel|pancake|lunch|bakery/.test(c) || t.breakfast === 'yes' || t.lunch === 'yes') s.add('lunch');
  if (/^(bar|pub|biergarten)$/.test(a)) s.add('bar');
  if (/^(fast_food|ice_cream)$/.test(a)) s.add('snel');
  return s;
}
function foodIcon(t) { const a = t.amenity; return a === 'cafe' ? '☕' : a === 'restaurant' ? '🍽️' : /^(bar|pub|biergarten)$/.test(a) ? '🍺' : a === 'ice_cream' ? '🍦' : a === 'fast_food' ? '🥙' : '🍴'; }
const Food = {
  sub: 'all',
  nowSub() { const { m } = amsNow(); if (m < 11 * 60) return 'koffie'; if (m < 14 * 60 + 30) return 'lunch'; if (m < 17 * 60) return 'koffie'; if (m < 18 * 60 + 30) return 'bar'; if (m < 21 * 60 + 30) return 'diner'; return 'bar'; },
  match(o) { if (this.sub === 'all') return true; o.subs ??= foodSubs(o.tags); return o.subs.has(this.sub); },
  render() {
    const el = $('#subchips'); if (!el) return;
    if (!Layers.state.eten) { el.hidden = true; return; }
    const now = this.nowSub();
    el.innerHTML = FOOD_SUBS.map(([k, l]) => `<button data-sub="${k}" aria-pressed="${this.sub === k}">${esc(l)}${k === now ? '<i>nu</i>' : ''}</button>`).join('');
    el.hidden = false;
    $$('[data-sub]', el).forEach(b => b.onclick = () => {
      this.sub = b.dataset.sub; Sound.click(); buildPoints(); this.render(); Layers.dirty.add('eten');
      const n = Data.osm.filter(o => o.layer === 'eten' && this.match(o)).length; toast(`${n} adressen voor ${esc(FOOD_SUBS.find(f => f[0] === this.sub)[1].toLowerCase())}`);
    });
  },
};

// =====================================================================
//  BUURTEN
// =====================================================================
function labelTexture(D) {
  const c = document.createElement('canvas'), g = c.getContext('2d'), font = '800 34px "Bricolage Grotesque",system-ui,sans-serif';
  g.font = font; const w = Math.ceil(g.measureText(D.name).width) + 74, h = 60; c.width = w; c.height = h;
  g.font = font; g.fillStyle = 'rgba(20,32,36,.86)'; g.beginPath(); g.roundRect(2, 2, w - 4, h - 4, 28); g.fill();
  g.fillStyle = D.color; g.beginPath(); g.arc(32, h / 2, 12, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#F3F4EF'; g.textBaseline = 'middle'; g.fillText(D.name, 54, h / 2 + 2);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.userData = { aspect: w / h }; return t;
}
function stopFromSpec(s) {
  if (typeof s === 'string') { const p = Data.byId.get(s); return p ? stopFromCurated(p) : null; }
  return { name: s.n, lat: s.lat, lon: s.lon, ref: 'a:' + s.lat.toFixed(5) + ',' + s.lon.toFixed(5) };
}
function districtRoutes(D, ownOnly) {
  const own = D.routes.map((r, i) => ({ id: `d-${D.id}-${i}`, title: r.title, desc: `${D.name}: ${r.desc}`, color: D.color, stops: r.stops.map(stopFromSpec).filter(Boolean) }));
  if (ownOnly) return own;
  const pres = PRESET_ROUTES.map(presetRoute).filter(r => r.stops.filter(s => { const [x, z] = toLocal(s.lat, s.lon); return pip([x, z], D.pts); }).length >= r.stops.length * .5);
  return own.concat(pres);
}
const Districts = {
  list: DISTRICTS, mode: null, sel: null, group: new THREE.Group(), amt: 0, target: 0,
  init() {
    const S = 1024; this.canvas = document.createElement('canvas'); this.canvas.width = this.canvas.height = S;
    this.tex = new THREE.CanvasTexture(this.canvas); this.tex.colorSpace = THREE.SRGBColorSpace; DIST_U.tex.value = this.tex;
    for (const D of this.list) {
      D.pts = D.poly.map(([la, lo]) => toLocal(la, lo));
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9, cx = 0, cz = 0;
      for (const [x, z] of D.pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); cx += x; cz += z; }
      D.bb = [x0, z0, x1, z1]; cx /= D.pts.length; cz /= D.pts.length;
      // labelpunt: binnen de buurt, zo dicht mogelijk bij het midden (grachtengordel is een ring)
      if (!pip([cx, cz], D.pts)) { let best = null, bd = 1e12; for (let i = 0; i <= 24; i++) for (let j = 0; j <= 24; j++) { const x = x0 + (x1 - x0) * i / 24, z = z0 + (z1 - z0) * j / 24; if (!pip([x, z], D.pts)) continue; const d = (x - cx) ** 2 + (z - cz) ** 2; if (d < bd) { bd = d; best = [x, z]; } } if (best) [cx, cz] = best; }
      D.lx = cx; D.lz = cz;
      const pos = []; for (const p of D.pts) pos.push(p[0], 3, p[1]); pos.push(D.pts[0][0], 3, D.pts[0][1]);
      const g = new LineGeometry(); g.setPositions(pos);
      D.lineMat = regLineMat(new LineMaterial({ color: new THREE.Color(D.color).multiplyScalar(2.4), linewidth: 3.5, transparent: true, opacity: .95, depthTest: false }));
      const l = new Line2(g, D.lineMat); l.renderOrder = 23; this.group.add(l);
      const sm = new THREE.SpriteMaterial({ map: labelTexture(D), sizeAttenuation: false, depthTest: false, transparent: true }); sm.color.setScalar(1.25);
      D.label = new THREE.Sprite(sm); D.label.renderOrder = 33; D.label.position.set(cx, 80, cz); D.label.userData = { district: D }; this.group.add(D.label);
      D.gids = CURATED.filter(p => pip([p.x, p.z], D.pts));
    }
    this.group.visible = false; scene.add(this.group); this.resize(); this.draw();
  },
  draw() {
    const g = this.canvas.getContext('2d'), S = this.canvas.width; g.clearRect(0, 0, S, S);
    for (const D of this.list) {
      const a = this.mode === 'detail' ? (D === this.sel ? 1 : .1) : 1;
      g.globalAlpha = a; g.fillStyle = D.color; g.beginPath();
      D.pts.forEach((p, i) => { const x = (p[0] + R) / (2 * R) * S, y = (p[1] + R) / (2 * R) * S; i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.closePath(); g.fill();
    }
    g.globalAlpha = 1; this.tex.needsUpdate = true;
  },
  overview() {
    this.mode = 'overview'; this.sel = null; this.group.visible = true; this.target = 1; this.draw();
    for (const D of this.list) { D.lineMat.opacity = .95; D.label.visible = true; }
    flyTo(0, 0, R * 1.7, { polar: .7 }); Sound.layer(true);
  },
  select(D) {
    this.mode = 'detail'; this.sel = D; this.group.visible = true; this.target = 1; this.draw();
    for (const X of this.list) { X.lineMat.opacity = X === D ? 1 : .12; X.label.visible = X === D; }
    const size = Math.max(D.bb[2] - D.bb[0], D.bb[3] - D.bb[1]);
    flyTo(D.lx, D.lz, size * 1.15 + 380, { polar: .78, shift: isNarrow() }); Sound.open();
  },
  hide() { if (!this.mode) return; this.mode = null; this.sel = null; this.target = 0; },
  tick(dt) {
    if (!this.group.visible && !this.amt) return;
    this.amt += (this.target - this.amt) * Math.min(1, dt * 4); DIST_U.on.value = this.amt;
    if (this.target === 0 && this.amt < .01) { this.amt = 0; DIST_U.on.value = 0; this.group.visible = false; }
  },
  at(x, z) { return this.list.find(D => x >= D.bb[0] && x <= D.bb[2] && z >= D.bb[1] && z <= D.bb[3] && pip([x, z], D.pts)) || null; },
  resize() { if (!this.list[0]?.label) return; const h = pxScale(isMobile ? 32 : 28); for (const D of this.list) D.label.scale.set(h * D.label.material.map.userData.aspect, h, 1); },
};

// ---------- gedeelde lijst met gidsplekken ----------
function plistHtml(items) {
  const seen = Store.stamps();
  return `<ul class="plist">${items.map(p => { const C = CATS[p.cat], vis = Store.isVisited(p.key); return `<li class="pitem"><button class="pmain" data-open="${p.id}"><span class="thumb" style="--c:${C.color}" data-wiki="${esc(p.wiki || '')}">${C.icon}</span><span style="min-width:0"><b>${esc(p.name)}</b><small>${esc(C.label)}${vis ? '<span class="vis">✓ bezocht</span>' : seen[p.id] ? '<span class="seen">✕ gestempeld</span>' : ''}</small></span></button><button class="grip" data-grip="${p.id}" aria-label="Sleep ${esc(p.name)} naar je route">⠿</button><button class="addb" data-add="${p.id}" aria-label="Voeg ${esc(p.name)} toe aan je route">+</button></li>`; }).join('')}</ul>`;
}
function bindPlist(root) {
  $$('[data-open]', root).forEach(b => b.onclick = () => { const p = Data.byId.get(b.dataset.open); if (p) openStop(stopFromCurated(p)); });
  $$('[data-add]', root).forEach(b => b.onclick = () => MyRoute.add(stopFromCurated(Data.byId.get(b.dataset.add))));
  $$('[data-grip]', root).forEach(b => b.addEventListener('pointerdown', e => { e.preventDefault(); Drag.start(stopFromCurated(Data.byId.get(b.dataset.grip)), e.clientX, e.clientY); }));
  loadThumbs(root);
}
function renderOntdek() {
  const cats = LAYERS.filter(L => L.cat && CURATED.some(p => CATS[p.cat].grp === L.id));
  const items = CURATED.filter(p => UI.filter === 'all' || CATS[p.cat].grp === UI.filter);
  const st = Store.stamps(), n = CURATED.filter(p => st[p.id]).length;
  UI.body.innerHTML = `<div class="ph"><h2>Ontdek ${esc(CITY.name)}</h2><p>${CURATED.length} plekken, gekozen door de gids. Tik om te lezen, sleep ⠿ naar je route.</p></div>
  <div class="btnrow" style="margin-top:0"><button class="btn" id="goStamps">✕ Stempelkaart ${n} van ${CURATED.length}</button><button class="btn" id="goPlan">Plan mijn bezoek</button></div>
  <div class="filters"><button data-f="all" aria-pressed="${UI.filter === 'all'}">Alles</button>${cats.map(L => `<button data-f="${L.id}" aria-pressed="${UI.filter === L.id}" style="--c:${L.color}"><i class="fdot"></i>${esc(L.name)}</button>`).join('')}</div>
  ${plistHtml(items)}`;
  $$('[data-f]', UI.body).forEach(b => b.onclick = () => { UI.filter = b.dataset.f; Sound.click(); renderOntdek(); });
  $('#goStamps').onclick = () => UI.openTab('stempels', true);
  $('#goPlan').onclick = () => UI.openTab('plan', true);
  bindPlist(UI.body);
}
function renderBuurten() {
  if (!Districts.mode) Districts.overview();
  if (Districts.mode === 'detail' && Districts.sel) return renderBuurt(Districts.sel);
  UI.body.innerHTML = `<div class="ph"><h2>Buurten</h2><p>${esc(CITY.name)} in ${Districts.list.length} buurten, elk met een eigen karakter. Tik op een buurt op de kaart of hieronder.</p></div>
  <ul class="plist">${Districts.list.map((D, i) => `<li><button class="rcard" data-d="${i}" style="--c:${D.color}"><span class="bar"></span><span><h3>${esc(D.name)}</h3><p>${esc(D.tag)}</p><small>${D.gids.length} plekken in de gids, ${districtRoutes(D).length} ${districtRoutes(D).length === 1 ? 'route' : 'routes'}</small></span></button></li>`).join('')}</ul>
  <div class="btnrow"><button class="btn" id="dOff">Buurtweergave uit</button></div>
  <p class="note">Deze indeling is die van de gids en volgt niet precies de officiële wijkgrenzen.</p>`;
  $$('[data-d]', UI.body).forEach(b => b.onclick = () => { Districts.select(Districts.list[+b.dataset.d]); renderBuurten(); });
  $('#dOff').onclick = () => { Districts.hide(); UI.closePanel(); };
}
function renderBuurt(D) {
  const routes = districtRoutes(D);
  UI.body.innerHTML = `<button class="btn" id="dBack" style="margin:4px 0 10px">‹ Alle buurten</button>
  <div class="ph dhead" style="--c:${D.color}"><span class="pill c" style="--c:${D.color}">Buurt</span><h2>${esc(D.name)}</h2><p>${esc(D.tag)}</p></div>
  ${D.text.map(t => `<p class="dtext">${esc(t)}</p>`).join('')}
  <h3 class="sub">Hoogtepunten</h3><ul class="hl">${D.highlights.map(h => `<li>${esc(h)}</li>`).join('')}</ul>
  <h3 class="sub">In de gids</h3>${D.gids.length ? plistHtml(D.gids) : '<p class="empty">Nog geen gidsplekken in deze buurt.</p>'}
  <h3 class="sub">Routes in deze buurt</h3>${routes.map((r, i) => rcardHtml(r, i)).join('')}`;
  $('#dBack').onclick = () => { Districts.overview(); renderBuurten(); };
  bindPlist(UI.body);
  $$('[data-route]', UI.body).forEach(b => b.onclick = () => { const r = routes[+b.dataset.route]; UI.detail = r; Sound.click(); RouteView.show(r); UI.openTab('routes', true); });
}

// =====================================================================
//  PLANNER: moment, dag of 2-3 dagen op maat
// =====================================================================
const PLAN_Q = {
  dur: [['nu', 'Nu, een paar uur'], ['dag', 'Een dag'], ['2d', 'Twee dagen'], ['3d', 'Drie dagen']],
  when: [['vandaag', 'Vandaag'], ['morgen', 'Morgen']],
  likes: [['kunst', 'Kunst & musea'], ['historie', 'Geschiedenis'], ['water', 'Grachten & water'], ['architectuur', 'Architectuur'], ['eten', 'Eten & drinken'], ['winkel', 'Markten & winkelen'], ['groen', 'Parken & rust'], ['cultuur', "Avond: theater & muziek"], ['verborgen', 'Verborgen plekjes'], ['kinderen', 'Met kinderen']],
  walk: [['weinig', 'Weinig, ± 4 km per dag'], ['gemiddeld', 'Gemiddeld, ± 8 km'], ['veel', 'Veel, 12 km of meer']],
  pace: [['rustig', 'Rustig'], ['gemiddeld', 'Gemiddeld'], ['vol', 'Vol programma']],
  start: [['centraal', CITY.starts[0].name], ['dam', CITY.starts[1].name], ['kaart', 'Midden van de kaart'], ['locatie', 'Mijn locatie']],
};
const DAYS_NL = DAY_NAMES;
const Plan = { q: Store.get('planQ', { dur: 'dag', when: 'vandaag', likes: ['historie', 'water'], walk: 'gemiddeld', pace: 'gemiddeld', start: 'centraal', skip: true }), editing: false };
const qLabel = (k, v) => PLAN_Q[k].find(x => x[0] === v)?.[1] || v;

function geoOnce(ms = 9000) { return new Promise(res => { if (!navigator.geolocation) return res(null); navigator.geolocation.getCurrentPosition(p => res(p), () => res(null), { enableHighAccuracy: true, timeout: ms }); }); }
async function planStart(q) {
  const at = (lat, lon, name) => { const [x, z] = toLocal(lat, lon); return { x, z, name }; };
  if (q.start === 'dam') return at(CITY.starts[1].lat, CITY.starts[1].lon, CITY.starts[1].name);
  if (q.start === 'kaart') return { x: controls.target.x, z: controls.target.z, name: 'Midden van de kaart' };
  if (q.start === 'locatie') {
    const p = await geoOnce();
    if (p) { const s = at(p.coords.latitude, p.coords.longitude, 'Jouw locatie'); if (s.x * s.x + s.z * s.z < R * R) return s; toast(T('Je bent buiten het kaartgebied. Het plan start bij') + ' ' + CITY.starts[0].name + '.', 4000); }
    else toast(T('Locatie niet beschikbaar. Het plan start bij') + ' ' + CITY.starts[0].name + '.', 4000);
  }
  return at(CITY.starts[0].lat, CITY.starts[0].lon, CITY.starts[0].name);
}
function placeScore(p, q) { let s = PLAN_POP[p.id] || 1; for (const t of PLAN_TAGS[p.id] || []) if (q.likes.includes(t)) s += 3; return s; }
function openAt(p, day, min) { const h = p.osm?.tags?.opening_hours; if (!h) return null; const w = ohParse(h); if (!w || w[day] == null) return null; return w[day].some(([a, b]) => min >= a && min + 30 <= b); }
const visitMin = (p, q) => Math.max(10, Math.round((p.time || 45) * ({ rustig: 1.15, gemiddeld: 1, vol: .8 }[q.pace]) / 5) * 5);
function bookNote(p) { const b = CURATED_INFO[p.id]?.book; return b && /online|tijdslot|reserve|vooruit/i.test(b) ? 'Reserveer vooraf. ' + b : ''; }
function mealItem(kind, pos, clock, day) {
  const opts = [];
  for (const o of Data.osm) {
    if (o.layer !== 'eten') continue; o.subs ??= foodSubs(o.tags); if (!o.subs.has(kind)) continue;
    const d = Math.hypot(o.x - pos.x, o.z - pos.z); if (d > 650) continue;
    let s = d; const w = o.tags.opening_hours ? ohParse(o.tags.opening_hours) : null;
    if (w && w[day] != null) { if (w[day].some(([a, b]) => clock >= a && clock + 45 <= b)) s -= 150; else s += 2000; }
    opts.push({ s, o });
  }
  opts.sort((a, b) => a.s - b.s);
  const [lat, lon] = localToWgs(pos.x, pos.z);
  return { type: 'meal', kind, label: FOOD_LABEL[kind], start: Math.round(clock), dur: kind === 'lunch' || kind === 'diner' ? 60 : 30, lat, lon, options: opts.filter(x => x.s < 1500).slice(0, 3).map(({ o }) => ({ name: o.name, ref: o.key, lat: o.lat, lon: o.lon, type: typeLabel(o.tags) })) };
}
function nearestFrom(set, pos, used, q) {
  let best = null, bd = 1e9;
  for (const p of CURATED) { if (!set.has(p.id) || used.has(p.id) || (q.skip && Store.isVisited(p.key))) continue; const d = Math.hypot(p.x - pos.x, p.z - pos.z); if (d < bd) { bd = d; best = p; } }
  return best ? { p: best, d: bd } : null;
}
function dayTitle(items) {
  const c = new Map(); for (const it of items) if (it.type === 'place') { const [x, z] = toLocal(it.lat, it.lon), D = Districts.at(x, z); if (D) c.set(D.name, (c.get(D.name) || 0) + 1); }
  const top = [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(e => e[0]);
  return top.length ? top.join(LANG === 'nl' ? ' en ' : ' and ') : CITY.name;
}
async function makePlan(q) {
  const start = await planStart(q);
  const nDays = { nu: 1, dag: 1, '2d': 2, '3d': 3 }[q.dur], now = amsNow();
  const baseDay = q.dur === 'nu' ? now.d : (now.d + (q.when === 'morgen' ? 1 : 0)) % 7;
  const walkMax = { weinig: 4000, gemiddeld: 8000, veel: 13000 }[q.walk] * (q.dur === 'nu' ? .5 : 1);
  const maxStops = q.dur === 'nu' ? { rustig: 2, gemiddeld: 3, vol: 4 }[q.pace] : { rustig: 4, gemiddeld: 6, vol: 8 }[q.pace];
  const pool = CURATED.filter(p => !PLAN_EVENING.has(p.id) && !PLAN_DRINK.has(p.id) && !(q.skip && Store.isVisited(p.key)));
  const used = new Set(), days = [], likesEat = q.likes.includes('eten');
  for (let d = 0; d < nDays; d++) {
    const day = (baseDay + d) % 7;
    let clock = q.dur === 'nu' ? Math.ceil(now.m / 15) * 15 : (q.pace === 'rustig' ? 600 : 570);
    const end = clock + (q.dur === 'nu' ? { rustig: 150, gemiddeld: 180, vol: 240 }[q.pace] : { rustig: 330, gemiddeld: 420, vol: 510 }[q.pace]);
    let cur = { x: start.x, z: start.z }, walked = 0, n = 0, lunch = q.dur === 'nu';
    const items = [];
    // dag 2 en 3: begin bij de best scorende plek die nog over is, zodat elke dag een eigen gebied krijgt
    if (d > 0) { let best = null, bv = -1; for (const p of pool) if (!used.has(p.id) && placeScore(p, q) > bv) { bv = placeScore(p, q); best = p; } if (best) cur = { x: best.x, z: best.z }; }
    while (n < maxStops && clock < end) {
      let best = null, bv = -1e9;
      for (const p of pool) {
        if (used.has(p.id)) continue;
        const dist = Math.hypot(p.x - cur.x, p.z - cur.z) * 1.3; if (walked + dist > walkMax) continue;
        const arrive = clock + dist / 75; if (openAt(p, day, arrive) === false) continue; if (arrive + visitMin(p, q) > end + 30) continue;
        const v = placeScore(p, q) - dist / 420; if (v > bv) { bv = v; best = p; }
      }
      if (!best) break;
      // lunch rond het middaguur, bij de plek waar je dan bent
      if (!lunch && clock >= 12 * 60) { items.push(mealItem('lunch', cur, clock, day)); clock += q.pace === 'vol' ? 45 : 60; lunch = true; continue; }
      const dist = Math.hypot(best.x - cur.x, best.z - cur.z) * 1.3; walked += dist; clock += dist / 75;
      items.push({ type: 'place', ref: best.key, name: best.name, lat: best.lat, lon: best.lon, start: Math.round(clock), dur: visitMin(best, q), note: bookNote(best), cat: best.cat });
      used.add(best.id); clock += visitMin(best, q); cur = best; n++;
    }
    if (!lunch && clock < 15 * 60 && items.length) { items.push(mealItem('lunch', cur, Math.max(clock, 12 * 60), day)); clock = Math.max(clock, 12 * 60) + 60; }
    if (q.dur === 'nu') {
      const k = Food.nowSub();
      const bar = k === 'bar' ? nearestFrom(PLAN_DRINK, cur, used, q) : null;
      if (bar) { items.push({ type: 'place', ref: bar.p.key, name: bar.p.name, lat: bar.p.lat, lon: bar.p.lon, start: Math.round(clock + bar.d * 1.3 / 75), dur: 45, note: 'Een borrel in een bruin café.', cat: bar.p.cat }); used.add(bar.p.id); }
      else items.push(mealItem(k, cur, clock, day));
    } else {
      if (likesEat || q.pace !== 'rustig') {
        const bar = nearestFrom(PLAN_DRINK, cur, used, q);
        if (bar && bar.d < 1600) { const t = Math.max(clock + bar.d * 1.3 / 75, 16 * 60 + 30); walked += bar.d * 1.3; items.push({ type: 'place', ref: bar.p.key, name: bar.p.name, lat: bar.p.lat, lon: bar.p.lon, start: Math.round(t), dur: 45, note: 'Borrel in een bruin café.', cat: bar.p.cat }); used.add(bar.p.id); cur = bar.p; clock = t + 45; }
      }
      const dinner = Math.max(clock, 18 * 60 + 30); items.push(mealItem('diner', cur, dinner, day)); clock = dinner + 75;
      if (q.likes.includes('cultuur')) {
        const th = nearestFrom(PLAN_EVENING, cur, used, q);
        if (th) { items.push({ type: 'place', ref: th.p.key, name: th.p.name, lat: th.p.lat, lon: th.p.lon, start: Math.max(clock, 20 * 60), dur: 150, note: 'Kijk vooraf wat er speelt en reserveer.', cat: th.p.cat }); used.add(th.p.id); }
      }
    }
    days.push({ items, walked, day, title: dayTitle(items) });
  }
  return { q: { ...q }, created: Date.now(), start: start.name, days };
}
function planStops(D) { return D.items.map(it => it.type === 'place' ? { name: it.name, lat: it.lat, lon: it.lon, ref: it.ref } : it.options[0] ? { name: it.options[0].name, lat: it.options[0].lat, lon: it.options[0].lon, ref: it.options[0].ref } : null).filter(Boolean); }

function renderPlan() { const plan = Store.get('plan', null); if (Plan.editing || !plan) return renderPlanForm(); renderPlanView(plan); }
function renderPlanForm() {
  const q = Plan.q, has = !!Store.get('plan', null);
  const grp = (key, label, multi) => `<div class="qg"><h3>${label}</h3><div class="qopts">${PLAN_Q[key].map(([k, l]) => `<button data-q="${key}" data-v="${k}" aria-pressed="${multi ? q[key].includes(k) : q[key] === k}">${esc(l)}</button>`).join('')}</div></div>`;
  UI.body.innerHTML = `<div class="ph"><h2>Plan je bezoek</h2><p>Een paar vragen, dan stelt de gids een programma op maat samen. Van een spontane middag tot drie dagen.</p></div>
  ${grp('dur', 'Hoeveel tijd heb je?')}${q.dur !== 'nu' ? grp('when', 'Wanneer begin je?') : ''}${grp('likes', 'Waar heb je zin in?', true)}${grp('walk', 'Hoeveel wil je lopen?')}${grp('pace', 'Welk tempo?')}${grp('start', 'Waar start je?')}
  <label class="chk"><input type="checkbox" id="qSkip" ${q.skip ? 'checked' : ''}> Sla plekken over die ik al bezocht heb</label>
  <div class="btnrow"><button class="btn pri" id="qGo">${q.dur === 'nu' ? 'Wat kan ik nu doen?' : 'Maak mijn plan'}</button>${has ? '<button class="btn" id="qCancel">Terug naar mijn plan</button>' : ''}</div>`;
  $$('[data-q]', UI.body).forEach(b => b.onclick = () => {
    const k = b.dataset.q, v = b.dataset.v;
    if (k === 'likes') { const i = q.likes.indexOf(v); if (i >= 0) q.likes.splice(i, 1); else q.likes.push(v); } else q[k] = v;
    Store.set('planQ', q); Sound.click(); const y = UI.body.scrollTop; renderPlanForm(); UI.body.scrollTop = y;
  });
  $('#qSkip').onchange = e => { q.skip = e.target.checked; Store.set('planQ', q); };
  $('#qGo').onclick = async () => {
    const b = $('#qGo'); b.disabled = true; b.textContent = 'Plan maken…';
    const plan = await makePlan(q);
    if (!plan.days.some(d => d.items.some(i => i.type === 'place'))) { toast('Met deze keuzes vond ik te weinig. Probeer meer loopafstand of andere interesses.', 4500); b.disabled = false; b.textContent = 'Maak mijn plan'; return; }
    Store.set('plan', plan); Plan.editing = false; Sound.stamp(); renderPlan();
    RouteView.show({ title: 'Plan', color: '#2E5E57', stops: planStops(plan.days[0]) });
  };
  if (has) $('#qCancel').onclick = () => { Plan.editing = false; renderPlan(); };
}
function renderPlanView(plan) {
  const q = plan.q, likes = q.likes.map(l => qLabel('likes', l).toLowerCase()).join(', ');
  const row = (it, di, ii) => {
    if (it.type === 'meal') return `<li class="tli meal"><span class="tt">${hhmm(it.start)}</span><div class="tb"><b>${esc(it.label)} in de buurt</b>${it.options.length ? `<div class="opts">${it.options.map((o, oi) => `<button data-meal="${di}:${ii}:${oi}">${esc(o.name)}<small>${esc(o.type)}</small></button>`).join('')}</div>` : '<small>Zet Eten & drinken aan op de kaart om adressen te zien.</small>'}</div></li>`;
    const v = Store.isVisited(it.ref), C = CATS[it.cat] || CATS.landmark;
    return `<li class="tli${v ? ' done' : ''}"><span class="tt">${hhmm(it.start)}</span><div class="tb"><button class="tn" data-open="${di}:${ii}"><b>${C.icon} ${esc(it.name)}</b><small>± ${fmtDur(it.dur)}</small></button>${it.note ? `<p class="note">${esc(it.note)}</p>` : ''}</div><label class="tv" title="Bezocht"><input type="checkbox" data-visit="${di}:${ii}" ${v ? 'checked' : ''}><span aria-hidden="true">✓</span><em class="sr">Bezocht</em></label></li>`;
  };
  UI.body.innerHTML = `<div class="ph"><h2>Jouw plan</h2><p>${esc(qLabel('dur', q.dur))}, ${esc(qLabel('pace', q.pace).toLowerCase())} tempo${likes ? `, voor ${esc(likes)}` : ''}. Start: ${esc(plan.start)}.</p></div>
  <div class="btnrow" style="margin-top:0"><button class="btn" id="pEdit">Pas vragen aan</button><button class="btn" id="pNew">Maak opnieuw</button></div>
  ${plan.days.map((D, di) => `<section class="pday"><h3 class="sub">${plan.days.length > 1 ? `Dag ${di + 1}, ${DAYS_NL[D.day]}: ` : ''}${esc(D.title)}</h3><p class="note">± ${fmtKm(D.walked)} lopen, ${D.items.filter(i => i.type === 'place').length} plekken</p>
    <ol class="tl">${D.items.map((it, ii) => row(it, di, ii)).join('')}</ol>
    <div class="btnrow"><button class="btn pri" data-pd="show" data-d="${di}">Toon op kaart</button><button class="btn" data-pd="tour" data-d="${di}">Start tour</button><button class="btn" data-pd="route" data-d="${di}">Maak er mijn route van</button><button class="btn" data-pd="gmaps" data-d="${di}">Google Maps</button></div></section>`).join('')}
  <p class="note">Tijden zijn een richtlijn. Controleer openingstijden en reserveer musea met tijdslot vooraf.</p>`;
  $('#pEdit').onclick = () => { Plan.q = { ...plan.q, likes: [...plan.q.likes] }; Plan.editing = true; renderPlan(); };
  $('#pNew').onclick = async () => { const p2 = await makePlan(plan.q); Store.set('plan', p2); Sound.stamp(); renderPlan(); };
  $$('[data-open]', UI.body).forEach(b => b.onclick = () => { const [di, ii] = b.dataset.open.split(':').map(Number), it = plan.days[di].items[ii]; openStop({ name: it.name, lat: it.lat, lon: it.lon, ref: it.ref }); });
  $$('[data-meal]', UI.body).forEach(b => b.onclick = () => { const [di, ii, oi] = b.dataset.meal.split(':').map(Number), o = plan.days[di].items[ii].options[oi]; openStop({ name: o.name, lat: o.lat, lon: o.lon, ref: o.ref }); });
  $$('[data-visit]', UI.body).forEach(c => c.onchange = () => {
    const [di, ii] = c.dataset.visit.split(':').map(Number), it = plan.days[di].items[ii]; Store.setVisited(it.ref, c.checked);
    c.closest('.tli').classList.toggle('done', c.checked); if (c.checked) Sound.stamp(); else Sound.click();
    if (it.ref.startsWith('g:')) { const p = Data.byId.get(it.ref.slice(2)); if (p) Pins.refresh(p); }
  });
  $$('[data-pd]', UI.body).forEach(b => b.onclick = () => {
    const D = plan.days[+b.dataset.d], stops = planStops(D), route = { id: 'plan-' + b.dataset.d, title: plan.days.length > 1 ? `Dag ${+b.dataset.d + 1}: ${D.title}` : D.title, color: '#2E5E57', stops };
    const a = b.dataset.pd;
    if (a === 'show') RouteView.show(route);
    if (a === 'tour') { RouteView.show(route, { fit: false }); Tour.start(route); }
    if (a === 'gmaps') openGmaps(stops);
    if (a === 'route') { MyRoute.r = { id: uid(), title: route.title, stops: stops.map(s => ({ ...s })) }; MyRoute.save(); UI.openTab('mijn', true); RouteView.show(MyRoute.asRoute()); toast('Je kunt de route nu aanpassen'); }
  });
}

// =====================================================================
//  EXACTE GEBOUWMARKERING op de 3DBAG-tiles
//  Een BAG-contour wordt via een verticale straal gekoppeld aan het gebouw-id
//  in de tile; alle vertices met dat id krijgen een kleurcode in de shader.
// =====================================================================
function insidePoint(f) {
  if (!f.rings) return [f.cx, f.cz];
  const r = f.rings[0]; if (pipFlat(f.cx, f.cz, r)) return [f.cx, f.cz];
  for (let i = 0; i < r.length; i += 2) { const x = (r[i] + f.cx) / 2, z = (r[i + 1] + f.cz) / 2; if (pipFlat(x, z, r)) return [x, z]; }
  return [r[0], r[1]];
}
function paintId(mesh, id, code) {
  const ud = mesh.userData, hl = mesh.geometry.attributes.hl; if (!hl || !ud.srcId) return;
  if (!ud.idIdx) { const m = new Map(), a = ud.srcId; for (let i = 0; i < a.length; i++) { let l = m.get(a[i]); if (!l) m.set(a[i], l = []); l.push(i); } ud.idIdx = m; }
  const list = ud.idIdx.get(id); if (!list) return;
  for (const i of list) hl.array[i] = code; hl.needsUpdate = true;
}
const HL = {
  entries: new Map(), pending: new Set(), fresh: [], reg: new Map(),   // reg: gebouw (tegel+id) -> alle markeringen die erop vallen
  init() { LAYERS.forEach((L, i) => HL_U.col.value[i].set(L.color)); HL_U.col.value[11].set('#FFFFFF'); },
  prio(tag) { return { sel: 99, musea: 9, theater: 8, zien: 7, markt: 6, ov: 5, groen: 4, eten: 3, gids: 2 }[tag] ?? 1; },
  code(tag) { return tag === 'sel' ? 12 : LAYERS.findIndex(l => l.id === tag) + 1; },
  entry(f) { let e = this.entries.get(f.id); if (!e) { const [x, z] = insidePoint(f); e = { f, x, z, tags: new Set(), hits: [], code: 0 }; this.entries.set(f.id, e); } return e; },
  set(tag, fps) {
    FarHL.dirty = true;
    const want = new Set(fps.map(f => f.id));
    for (const [k, e] of this.entries) if (e.tags.has(tag) && !want.has(k)) { e.tags.delete(tag); this.pending.add(k); }
    for (const f of fps) { const e = this.entry(f); if (!e.tags.has(tag)) { e.tags.add(tag); this.pending.add(f.id); } }
  },
  // eén gebouw kan door meerdere markeringen geraakt worden (laag + selectie): combineer ze
  combine(set) {
    let best = null, bp = -2, sel = false;
    for (const e of set) for (const t of e.tags) { if (t === 'sel') { sel = true; continue; } const p = this.prio(t); if (p > bp) { bp = p; best = t; } }
    if (!best) return sel ? 12 : 0; return this.code(best) + (sel ? 20 : 0);
  },
  target(e) { return this.combine([e]); },
  key(h) { return h.mesh.uuid + ':' + h.id; },
  paint(h) { const set = this.reg.get(this.key(h)); paintId(h.mesh, h.id, set ? this.combine(set) : 0); },
  link(e, h) { const k = this.key(h); let set = this.reg.get(k); if (!set) this.reg.set(k, set = new Set()); set.add(e); this.paint(h); },
  find(e, meshes) {
    const pad = e.f.probe ? 3 : 0, cand = meshes.filter(o => { const b = o.userData.box; return b && o.userData.srcId && e.x >= b.min.x - pad && e.x <= b.max.x + pad && e.z >= b.min.z - pad && e.z <= b.max.z + pad; });
    if (!cand.length) return [];
    for (const o of cand) if (!o.geometry.boundsTree) o.geometry.computeBoundsTree();
    downRay.firstHitOnly = true; let h = null;
    for (const [dx, dz] of e.f.probe ? [[0, 0], [2.5, 0], [-2.5, 0], [0, 2.5], [0, -2.5]] : [[0, 0]]) { downRay.set(_ro.set(e.x + dx, 800, e.z + dz), DOWN); h = downRay.intersectObjects(cand, false)[0]; if (h?.face) break; }
    if (!h || !h.face) return [];
    if (e.hits.some(x => x.mesh === h.object)) return [];
    const hit = { mesh: h.object, id: h.object.userData.srcId[h.face.a] }; e.hits.push(hit); return [hit];
  },
  apply(e) {
    const code = this.target(e);
    if (code && !e.hits.length) for (const h of this.find(e, Tiles.list)) this.link(e, h);
    e.code = code;
    if (!code) { this.entries.delete(e.f.id); for (const h of e.hits) { const k = this.key(h), set = this.reg.get(k); if (set) { set.delete(e); if (!set.size) this.reg.delete(k); } this.paint(h); } }
    else for (const h of e.hits) this.paint(h);
  },
  tick() {
    let n = 0; for (const k of this.pending) { if (n++ >= 120) break; this.pending.delete(k); const e = this.entries.get(k); if (e) this.apply(e); }
    // nieuw geladen tiles: bestaande markeringen er ook op aanbrengen
    let m = 0;
    while (this.fresh.length && m++ < 6) {
      const o = this.fresh.pop(); if (!Tiles.meshes.has(o) || !o.userData.box) continue; const b = o.userData.box;
      for (const e of this.entries.values()) { if (!e.code || e.x < b.min.x || e.x > b.max.x || e.z < b.min.z || e.z > b.max.z) continue; for (const h of this.find(e, [o])) this.link(e, h); }
    }
  },
  meshReady(o) { this.fresh.push(o); },
  meshGone(o) { for (const e of this.entries.values()) e.hits = e.hits.filter(h => h.mesh !== o); for (const k of [...this.reg.keys()]) if (k.startsWith(o.uuid + ':')) this.reg.delete(k); },
};

// verre markeringen: de lichte bouwblokken (zonder gebouw-id's) krijgen hun kleur uit een kaart
const FarHL = {
  dirty: true, last: 0,
  init() {
    const N = isMobile ? 2048 : 4096; this.N = N;
    this.cv = document.createElement('canvas'); this.cv.width = this.cv.height = N; this.ctx = this.cv.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.cv); this.tex.colorSpace = THREE.SRGBColorSpace; this.tex.generateMipmaps = false; this.tex.minFilter = THREE.LinearFilter;
    FAR_U.tex.value = this.tex;
  },
  tick(now) {
    if (!this.cv || !this.dirty || now - this.last < 200) return; this.dirty = false; this.last = now;
    const c = this.ctx, N = this.N, k = N / (2 * R), rad = Math.max(2.5, 18 * k); c.clearRect(0, 0, N, N);
    const groups = new Map();
    for (const e of HL.entries.values()) { const code = HL.target(e); if (!code) continue; const ci = (code > 19 ? code - 20 : code) - 1; let g = groups.get(ci); if (!g) groups.set(ci, g = []); g.push(e); }
    for (const [ci, es] of groups) {
      c.fillStyle = '#' + HL_U.col.value[ci].getHexString(); c.beginPath();
      for (const e of es) { const x = (e.x + R) * k, y = (e.z + R) * k; c.moveTo(x + rad, y); c.arc(x, y, rad, 0, 6.2832); }
      c.fill();
    }
    this.tex.needsUpdate = true;
  },
};

// =====================================================================
//  GEBIEDEN: parken en markten oplichten als hun laag aan staat
// =====================================================================
const Areas = {
  build(els) {
    const mk = (filter, layerId, color) => {
      const polys = [];
      for (const el of els) { const t = el.tags || {}; if (!filter(t)) continue; for (const P of osmPolys([el], filter)) polys.push(P); }
      if (!polys.length) return;
      const g = Layers.groups[layerId], col = new THREE.Color(color);
      const fill = flatMesh(polys, .45, clipToRadius(new THREE.MeshBasicMaterial({ color: col.clone().multiplyScalar(1.15), transparent: true, opacity: .55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 })));
      if (fill) { scene.remove(fill); fill.renderOrder = 4; g.add(fill); }
      const seg = []; for (const P of polys) { const r = P.outer; for (let i = 1; i < r.length; i++) { const s = clipSeg(r[i - 1], r[i], R - 1); if (s) seg.push(s[0][0], 1.4, s[0][1], s[1][0], 1.4, s[1][1]); } }
      if (seg.length) { const lg = new LineSegmentsGeometry(); lg.setPositions(seg); const l = new LineSegments2(lg, regLineMat(new LineMaterial({ color: col.clone().multiplyScalar(3.2), linewidth: 2.5, transparent: true, opacity: .95 }))); l.renderOrder = 6; g.add(l); }
      Areas[layerId] = polys.length;
    };
    mk(t => t.leisure === 'park' || (t.leisure === 'garden' && t.name), 'groen', '#7BC043');
    mk(t => t.amenity === 'marketplace', 'markt', '#1FA37A');
  },
};


// =====================================================================
//  VEILIG OPSTARTEN + ZICHTBARE FOUTMELDINGEN (handig op mobiel)
// =====================================================================
const ErrLog = {
  list: [], el: null,
  init() {
    for (const m of window.__dwaalErrs || []) this.add(m);
    addEventListener('error', e => this.add(`${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`));
    addEventListener('unhandledrejection', e => this.add('Promise: ' + (e.reason?.message || e.reason)));
  },
  add(m) {
    this.list.push(String(m)); console.warn('[dwaal]', m);
    if (!this.el) { this.el = document.createElement('button'); this.el.className = 'errpill'; this.el.onclick = () => alert(this.list.slice(-12).join('\n\n')); document.body.appendChild(this.el); }
    this.el.textContent = `⚠ ${this.list.length}`; this.el.setAttribute('aria-label', `${this.list.length} fouten, tik om te bekijken`);
  },
};
function safe(fn, label) { try { return fn(); } catch (e) { ErrLog.add(`${label}: ${e.message}`); return null; } }

// =====================================================================
//  GEBOUWEN UIT OPENSTREETMAP (steden buiten Nederland)
//  Levert meshes in hetzelfde formaat als de 3DBAG-tiles (gebouw-id per
//  vertex), zodat markeren, aanklikken en dakhoogtes hetzelfde werken.
// =====================================================================
const OSMB = {
  progress: 0, blds: [], grid: new Map(), G: 40, ready: Promise.resolve(), _res: null,
  num(v) { const m = /^\s*([\d.]+)\s*(m|ft|')?/.exec(v || ''); if (!m) return NaN; let x = parseFloat(m[1]); if (m[2] === 'ft' || m[2] === "'") x *= .3048; return x; },
  compact(j) {
    const out = [];
    for (const el of j.elements || []) {
      const t = el.tags || {}; let polys = [];
      if (el.type === 'way' && (el.geometry || el.L)) { const r = ptsOf(el); if (r.length > 3) polys = [{ outer: r, holes: [] }]; }
      else if (el.type === 'relation') polys = osmPolys([el], () => true);
      if (!polys.length) continue;
      let h = this.num(t.height); const lv = parseFloat(t['building:levels']);
      if (!(h > 0) && lv > 0) h = lv * 3.2 + (parseFloat(t['roof:levels']) > 0 ? parseFloat(t['roof:levels']) * 2.6 : 1.2);
      let minh = this.num(t.min_height); if (!(minh >= 0)) { const ml = parseFloat(t['building:min_level']); minh = ml > 0 ? ml * 3.2 : 0; }
      if (t.building === 'roof' && !(minh > 0)) minh = 3;
      const yr = +((t.start_date || t['building:year'] || '').match(/\d{4}/)?.[0] || 0) || null;
      for (const P of polys) {
        const flat = ring => { const a = new Float32Array(ring.length * 2); ring.forEach((p, i) => { a[i * 2] = p[0]; a[i * 2 + 1] = p[1]; }); return a; };
        const ro = P.outer.slice(); if (ro.length > 1 && near(ro[0], ro[ro.length - 1], .01)) ro.pop();
        out.push({ id: el.type[0] + el.id, part: !!t['building:part'] && !t.building, h: h > 0 ? h : null, minh, lv: lv > 0 ? lv : null, yr, name: t.name || null, arch: t.architect || null, r: [flat(ro), ...P.holes.map(hh => flat(hh))] });
      }
    }
    return out;
  },
  async load() {
    this.ready = new Promise(r => this._res = r);
    const n = R > 2100 ? 3 : 2, s = (2 * R + 120) / n, boxes = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const x0 = -R - 60 + i * s, z0 = -R - 60 + j * s, dx = Math.max(x0, 0, -(x0 + s)), dz = Math.max(z0, 0, -(z0 + s));
      if (Math.hypot(dx, dz) > R) continue;
      const sw = localToWgs(x0, z0 + s), ne = localToWgs(x0 + s, z0);
      boxes.push(`${sw[0].toFixed(5)},${sw[1].toFixed(5)},${ne[0].toFixed(5)},${ne[1].toFixed(5)}`);
    }
    let done = 0; const parts = [];
    await pool(boxes.map((bb, k) => async () => {
      const d = await cached('osmb' + n + ':' + k, async () => this.compact(await overpass(`[out:json][timeout:180];(way["building"](${bb});way["building:part"](${bb});relation["building"]["type"="multipolygon"](${bb}););out geom tags;`, k)));
      parts.push(...(d || [])); done++; this.progress = done / boxes.length * .9;
      UI.loader.status(`${T('Gebouwen ophalen…')} ${done}/${boxes.length}`);
    }), 2);
    await this.build(parts);
    this.progress = 1; this._res();
  },
  async build(list) {
    const seen = new Set(), items = [];
    for (const p of list) { const k = p.id + ':' + p.r[0][0].toFixed(1); if (seen.has(k)) continue; seen.add(k); items.push(p); }
    // gebouwen met losse delen (building:part) alleen als delen tekenen
    const pg = new Map(), G = 30, cen = r => { let x = 0, z = 0; const n = r.length / 2; for (let i = 0; i < r.length; i += 2) { x += r[i]; z += r[i + 1]; } return [x / n, z / n]; };
    for (const p of items) if (p.part) { const [x, z] = cen(p.r[0]), k = Math.floor(x / G) + ',' + Math.floor(z / G); (pg.get(k) || pg.set(k, []).get(k)).push([x, z]); }
    const hasPart = r => { let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; for (let i = 0; i < r.length; i += 2) { x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]); z0 = Math.min(z0, r[i + 1]); z1 = Math.max(z1, r[i + 1]); } for (let gx = Math.floor(x0 / G); gx <= Math.floor(x1 / G); gx++) for (let gz = Math.floor(z0 / G); gz <= Math.floor(z1 / G); gz++) for (const [x, z] of pg.get(gx + ',' + gz) || []) if (pipFlat(x, z, r)) return true; return false; };
    const skipNear = (CITY.landmarks || []).map(l => toLocal(l.lat, l.lon));
    const NC = 5, cs = 2 * R / NC, chunks = new Map();
    let k = 0;
    for (const p of items) {
      if (++k % 3000 === 0) { UI.loader.status(`${T('Panden bouwen…')} ${Math.round(k / items.length * 100)}%`); await nextFrame(); }
      const [cx, cz] = cen(p.r[0]); if (cx * cx + cz * cz > (R - 4) ** 2) continue;
      if (skipNear.some(([x, z]) => Math.hypot(x - cx, z - cz) < 70)) continue;
      if (!p.part && pg.size && hasPart(p.r[0])) continue;
      const hh = hash(p.id) % 1000 / 1000, h = p.h ?? (CITY.defaultHeight || 14) * (.8 + hh * .45); if (h <= p.minh + .5) continue;
      const bi = this.blds.length, r0 = p.r[0];
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; for (let i = 0; i < r0.length; i += 2) { x0 = Math.min(x0, r0[i]); x1 = Math.max(x1, r0[i]); z0 = Math.min(z0, r0[i + 1]); z1 = Math.max(z1, r0[i + 1]); }
      this.blds.push({ id: p.id, h, yr: p.yr, name: p.name, arch: p.arch, lv: p.lv, rings: p.r, cx, cz, bb: [x0, z0, x1, z1] });
      for (let gx = Math.floor(x0 / this.G); gx <= Math.floor(x1 / this.G); gx++) for (let gz = Math.floor(z0 / this.G); gz <= Math.floor(z1 / this.G); gz++) { const key = gx + ',' + gz; (this.grid.get(key) || this.grid.set(key, []).get(key)).push(bi); }
      const ci = clamp(Math.floor((cx + R) / cs), 0, NC - 1) + NC * clamp(Math.floor((cz + R) / cs), 0, NC - 1);
      let C = chunks.get(ci); if (!C) chunks.set(ci, C = { buf: new Buf(1 << 16), ids: [] });
      const before = C.buf.n; extrude(C.buf, p.r, h, [255, 255, 255], [255, 255, 255], p.minh > 0 ? p.minh : -1.5);
      for (let i = before; i < C.buf.n; i++) C.ids.push(bi);
    }
    for (const C of chunks.values()) {
      if (!C.buf.n) continue;
      const g = C.buf.geometry(); g.computeVertexNormals();
      const ids = Float32Array.from(C.ids), n = ids.length, f = new Float32Array(n);
      for (let i = 0; i < n; i++) f[i] = ids[i];
      g.setAttribute('fid', new THREE.BufferAttribute(f, 1)); g.setAttribute('hl', new THREE.BufferAttribute(new Float32Array(n), 1));
      const m = new THREE.Mesh(g, M.building); m.castShadow = m.receiveShadow = true; m.userData.srcId = ids;
      scene.add(m); Tiles.meshes.add(m); Tiles.bvhQ.push(m);
    }
    for (const l of CITY.landmarks || []) safe(() => Landmarks[l.type]?.(l), 'landmark');
    Tiles.hasIds = true; Tiles.calibrated = true; Tiles.dirty = true; Tiles.onReady?.();
  },
  footprint(x, z, pad = 4) {
    const a = this.grid.get(Math.floor(x / this.G) + ',' + Math.floor(z / this.G)) || []; let best = null, bd = pad;
    for (const bi of a) { const b = this.blds[bi]; if (x < b.bb[0] - pad || x > b.bb[2] + pad || z < b.bb[1] - pad || z > b.bb[3] + pad) continue; if (pipFlat(x, z, b.rings[0])) { best = b; bd = -1; break; } const r = b.rings[0]; for (let i = 0; i < r.length; i += 2) { const d = Math.hypot(r[i] - x, r[i + 1] - z); if (d < bd) { bd = d; best = b; } } }
    if (!best) return null;
    return { id: 'osm-' + best.id, yr: best.yr, rings: best.rings, cx: best.cx, cz: best.cz, h: best.h, name: best.name, architect: best.arch, levels: best.lv };
  },
};
// herkenbare bouwwerken die OSM niet als gebouw kent
const Landmarks = {
  mats: [],
  eiffel(l) {
    const [x, z] = toLocal(l.lat, l.lon), g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: '#F1EEE8', roughness: .7, flatShading: true, emissive: new THREE.Color('#FFB347'), emissiveIntensity: 0 }); this.mats.push(mat);
    const seg = (ax, az, ay, bx, bz, by, w) => { const a = new THREE.Vector3(ax, ay, az), b = new THREE.Vector3(bx, by, bz), m = new THREE.Mesh(new THREE.BoxGeometry(w, a.distanceTo(b), w), mat); m.position.copy(a).lerp(b, .5); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()); g.add(m); };
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) { seg(sx * 62, sz * 62, 0, sx * 25, sz * 25, 57, 10); seg(sx * 25, sz * 25, 57, sx * 12, sz * 12, 116, 7); seg(sx * 12, sz * 12, 116, sx * 3, sz * 3, 276, 4.5); }
    const plat = (s, y, t) => { const m = new THREE.Mesh(new THREE.BoxGeometry(s, t, s), mat); m.position.y = y; g.add(m); };
    plat(78, 57, 5); plat(40, 116, 4); plat(11, 276, 5);
    for (let i = 0; i < 4; i++) { const a = new THREE.Mesh(new THREE.TorusGeometry(37, 2.6, 5, 20, Math.PI), mat); a.rotation.y = i * Math.PI / 2; a.position.set(Math.sin(i * Math.PI / 2) * 44, 12, Math.cos(i * Math.PI / 2) * 44); g.add(a); }
    const sp = new THREE.Mesh(new THREE.CylinderGeometry(.6, 2, 54, 6), mat); sp.position.y = 303; g.add(sp);
    g.rotation.y = l.rot ?? -.73; g.position.set(x, 0, z); g.traverse(o => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
    scene.add(g); Shadow.request();
  },
};

// =====================================================================
//  KUSTLIJN → LAND (New York e.d.). OSM-kustlijnen hebben land links.
// =====================================================================
function coastLand(els) {
  const ways = els.filter(e => e.type === 'way' && e.tags?.natural === 'coastline' && e.geometry).map(e => e.geometry.filter(Boolean).map(p => { const [x, z] = toLocal(p.lat, p.lon); return [x, -z]; }));
  if (!ways.length) return null;
  return coastAssemble(ways, R + 30);
}
function coastAssemble(ways, B) {
  const nearP = (a, b) => Math.abs(a[0] - b[0]) < .05 && Math.abs(a[1] - b[1]) < .05, pool_ = ways.map(w => w.slice()), chains = [];
  while (pool_.length) {
    let c = pool_.shift(), ch = true;
    while (ch) { ch = false; for (let i = 0; i < pool_.length; i++) { const w = pool_[i]; if (nearP(c[c.length - 1], w[0])) { c = c.concat(w.slice(1)); pool_.splice(i, 1); ch = true; break; } if (nearP(w[w.length - 1], c[0])) { c = w.concat(c.slice(1)); pool_.splice(i, 1); ch = true; break; } } }
    chains.push(c);
  }
  const inside = p => Math.abs(p[0]) <= B && Math.abs(p[1]) <= B;
  const clip = (a, b) => { // Liang-Barsky
    let t0 = 0, t1 = 1; const dx = b[0] - a[0], dy = b[1] - a[1];
    for (const [p, q] of [[-dx, a[0] + B], [dx, B - a[0]], [-dy, a[1] + B], [dy, B - a[1]]]) { if (p === 0) { if (q < 0) return null; continue; } const r = q / p; if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; } }
    return [[a[0] + dx * t0, a[1] + dy * t0], [a[0] + dx * t1, a[1] + dy * t1], t0 > 0, t1 < 1];
  };
  const pieces = [], rings = [];
  for (const c of chains) {
    if (nearP(c[0], c[c.length - 1]) && c.every(inside)) { rings.push(c); continue; }
    let cur = null;
    for (let i = 1; i < c.length; i++) {
      const s = clip(c[i - 1], c[i]); if (!s) continue; const [p, q, aOut, bOut] = s;
      if (aOut) cur = { pts: [p], s0: true }; else if (!cur) cur = { pts: [p], s0: false };
      cur.pts.push(q);
      if (bOut) { cur.s1 = true; pieces.push(cur); cur = null; }
    }
    if (cur) pieces.push(cur);
  }
  const good = pieces.filter(p => p.s0 && p.s1);
  const per = ([x, y]) => { const e = .01; if (Math.abs(y + B) < e) return x + B; if (Math.abs(x - B) < e) return 2 * B + y + B; if (Math.abs(y - B) < e) return 4 * B + B - x; return 6 * B + B - y; };
  const corners = [[0, [-B, -B]], [2 * B, [B, -B]], [4 * B, [B, B]], [6 * B, [-B, B]]];
  const P = good.map(p => ({ pts: p.pts, ts: per(p.pts[0]), te: per(p.pts[p.pts.length - 1]), used: false })), land = [];
  for (const start of P) {
    if (start.used) continue; const ring = []; let cur = start, guard = 0;
    while (guard++ < 1000) {
      cur.used = true; ring.push(...cur.pts);
      let best = null, bd = Infinity;
      for (const q of P) { if (q.used && q !== start) continue; let d = q.ts - cur.te; if (d < 0) d += 8 * B; if (d < bd) { bd = d; best = q; } }
      const cs = corners.map(([ct, pt]) => { let d = ct - cur.te; if (d <= 0) d += 8 * B; return [d, pt]; }).filter(([d]) => d < bd).sort((a, b) => a[0] - b[0]);
      for (const [, pt] of cs) ring.push(pt);
      if (!best || best === start) break; cur = best;
    }
    if (ring.length > 2) land.push(ring);
  }
  for (const r of rings) if (ringArea(r) > 0) land.push(r);
  const toL = r => r.map(([x, y]) => [x, -y]);
  return { land: land.map(r => ({ outer: toL(r), holes: [] })), lines: [...good.map(p => toL(p.pts)), ...rings.map(toL)] };
}

// =====================================================================
//  DAG / NACHT met straatlantaarns en verlichte ramen
// =====================================================================
const Night = {
  amt: 0, target: 0, lamps: null, pools: null,
  step(dt) {
    const d = this.target - this.amt; if (Math.abs(d) < .002) { if (this.amt !== this.target) { this.amt = this.target; this.apply(); return true; } return false; }
    this.amt += d * Math.min(1, dt * 2.4); this.apply(); return true;
  },
  apply() {
    const a = this.amt;
    if (this.lamps) { this.lamps.visible = this.pools.visible = a > .02; this.lamps.material.opacity = a; this.pools.material.opacity = .5 * a; }
    for (const m of Landmarks.mats) m.emissiveIntensity = a * 1.4;
    M.water.envMapIntensity = 1.1 * (1 - .65 * a); renderer.toneMappingExposure = 1.2 - .08 * a;
  },
  build(els) {
    const step = isMobile ? 55 : 34, pts = [], cap = isMobile ? 3500 : 9000;
    for (const el of els) {
      const t = el.tags || {}; if (el.type !== 'way' || !/^(primary|secondary|tertiary|unclassified|residential|living_street|pedestrian)$/.test(t.highway || '') || !(el.geometry || el.L)) continue;
      const P = ptsOf(el); let acc = step / 2, side = 1;
      for (let i = 1; i < P.length && pts.length < cap; i++) {
        const a = P[i - 1], b = P[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (!L) continue; const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
        while (acc < L) { const x = a[0] + ux * acc - uz * 4.5 * side, z = a[1] + uz * acc + ux * 4.5 * side; if (x * x + z * z < (R - 8) ** 2) pts.push([x, z]); side = -side; acc += step; }
        acc -= L;
      }
    }
    if (!pts.length) return;
    const warm = new THREE.Color('#FFB35C');
    const lampM = new THREE.MeshBasicMaterial({ color: warm.clone().multiplyScalar(5), transparent: true, opacity: 0, depthWrite: false });
    const poolM = new THREE.MeshBasicMaterial({ color: warm, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    this.lamps = new THREE.InstancedMesh(new THREE.SphereGeometry(.8, 6, 4), lampM, pts.length);
    this.pools = new THREE.InstancedMesh(new THREE.CircleGeometry(8, 18).rotateX(-Math.PI / 2), poolM, pts.length);
    const m4 = new THREE.Matrix4();
    pts.forEach(([x, z], i) => { this.lamps.setMatrixAt(i, m4.makeTranslation(x, 5.5, z)); this.pools.setMatrixAt(i, m4.makeTranslation(x, .7, z)); });
    this.lamps.visible = this.pools.visible = false; this.pools.renderOrder = 3;
    scene.add(this.lamps, this.pools); this.apply();
  },
  toggle() {
    this.target = this.target ? 0 : 1; const on = !!this.target, b = $('#btnNight');
    if (b) { b.setAttribute('aria-pressed', on); b.setAttribute('aria-label', on ? 'Schakel naar dag' : 'Schakel naar nacht'); }
    Sound.init(); if (on) { Sound.tone(392, .6, { vol: .05, type: 'triangle' }); Sound.tone(523, .8, { vol: .04, type: 'triangle', delay: .15 }); } else Sound.layer(true);
    toast(on ? 'Nacht: de lantaarns gaan aan' : 'Dag');
  },
};

// =====================================================================
//  DELEN: sociale media, link, afbeelding
// =====================================================================
function modal(html, cls = '') {
  let m = $('#modal'); if (!m) { m = document.createElement('div'); m.id = 'modal'; m.className = 'modal'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); document.body.appendChild(m); }
  m.className = 'modal ' + cls; m.innerHTML = `<div class="mbox"><button class="mclose" aria-label="Sluit">×</button>${html}</div>`; m.hidden = false;
  const close = () => { m.hidden = true; }; $('.mclose', m).onclick = close; m.onclick = e => { if (e.target === m) close(); };
  return { el: m, close };
}
const Share = {
  open({ title, text, url }) {
    const u = encodeURIComponent(url), tx = encodeURIComponent(text);
    const links = [
      ['WhatsApp', `https://wa.me/?text=${encodeURIComponent(text + ' ' + url)}`, '#25D366'],
      ['X', `https://twitter.com/intent/tweet?text=${tx}&url=${u}`, '#111'],
      ['Facebook', `https://www.facebook.com/sharer/sharer.php?u=${u}`, '#1877F2'],
      ['LinkedIn', `https://www.linkedin.com/sharing/share-offsite/?url=${u}`, '#0A66C2'],
      ['Telegram', `https://t.me/share/url?url=${u}&text=${tx}`, '#229ED9'],
      ['E-mail', `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(text + '\n\n' + url)}`, '#5A686A'],
    ];
    const { el, close } = modal(`<h2>Deel je route</h2><p class="note">${esc(title)}</p>
      <div class="sharegrid">${links.map(([n, h, c]) => `<a class="shareb" href="${esc(h)}" target="_blank" rel="noopener" style="--c:${c}"><i></i>${esc(n)}</a>`).join('')}</div>
      <div class="btnrow"><button class="btn pri" data-s="copy">Kopieer link</button>${navigator.share ? '<button class="btn" data-s="native">Meer apps…</button>' : ''}<button class="btn" data-s="img">Deel als afbeelding</button></div>
      <p class="note">Voor Instagram: kies "Deel als afbeelding" en plaats hem in je story.</p>`);
    $$('[data-s]', el).forEach(b => b.onclick = async () => {
      const a = b.dataset.s;
      if (a === 'copy') { try { await navigator.clipboard.writeText(url); toast('Link gekopieerd'); } catch { prompt('Kopieer deze link', url); } }
      if (a === 'native') navigator.share({ title, text, url }).catch(() => { });
      if (a === 'img') this.image(title, url);
    });
  },
  image(title, url) {
    composer.render();
    const src = renderer.domElement, W = 1080, H = 1350, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
    const s = Math.max(W / src.width, (H - 260) / src.height), w = src.width * s, h = src.height * s;
    g.fillStyle = '#F3F4EF'; g.fillRect(0, 0, W, H); g.drawImage(src, (W - w) / 2, 0, w, h);
    g.fillStyle = '#2E5E57'; g.fillRect(0, H - 260, W, 260);
    g.fillStyle = '#D7262C'; g.font = '800 34px "Bricolage Grotesque",sans-serif'; g.fillText('✕✕✕ ' + CITY.name.toUpperCase(), 60, H - 185);
    g.fillStyle = '#F3F4EF'; g.font = '800 58px "Bricolage Grotesque",sans-serif'; g.fillText(title.slice(0, 32), 60, H - 110);
    g.font = '400 30px "Atkinson Hyperlegible",sans-serif'; g.globalAlpha = .8; g.fillText('dwaal: ' + T('ontdek de stad in 3D'), 60, H - 60); g.globalAlpha = 1;
    c.toBlob(async blob => {
      const file = new File([blob], 'dwaal-route.png', { type: 'image/png' });
      if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title, text: url }); return; } catch { } }
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'dwaal-route.png'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }, 'image/png');
  },
};

// =====================================================================
//  ACCOUNT: inloggen (Supabase) en synchroniseren met lokale opslag
// =====================================================================
const Account = {
  button() {
    const b = $('#btnAcct'); if (!b) return; const u = Auth.user;
    b.innerHTML = u ? `<span class="avatar">${esc(Auth.name().slice(0, 1).toUpperCase())}</span>` : '<svg viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c1.2-3.6 4-5.4 7.5-5.4s6.3 1.8 7.5 5.4"/></svg>';
    b.setAttribute('aria-label', u ? `Account: ${Auth.name()}` : 'Inloggen');
  },
  open() {
    Sound.click();
    if (!Auth.enabled) { modal(`<h2>Account</h2><p>Accounts zijn nog niet gekoppeld. Alles wat je bewaart (routes, bezochte plekken, ervaringen) staat nu op dit apparaat.</p><p class="note">Voor de beheerder: vul de Supabase-sleutels in js/config.js in (zie README).</p>`); return; }
    const u = Auth.user;
    if (u) {
      const { el, close } = modal(`<h2>Hallo ${esc(Auth.name())}</h2><p class="note">${esc(u.email || '')}</p><p>Je routes, bezochte plekken en ervaringen worden bewaard in je account en zijn op al je apparaten beschikbaar.</p><div class="btnrow"><button class="btn" id="aOut">Uitloggen</button></div>`);
      $('#aOut', el).onclick = async () => { await Auth.signOut(); close(); toast('Je bent uitgelogd'); this.button(); };
      return;
    }
    const { el } = modal(`<h2>Inloggen</h2><p>Log in om je routes, bezochte plekken en ervaringen te bewaren en te delen. Je krijgt een link per e-mail, zonder wachtwoord.</p>
      <label class="note" for="aMail">E-mailadres</label><input class="field" id="aMail" type="email" autocomplete="email" placeholder="jij@voorbeeld.nl">
      <div class="btnrow"><button class="btn pri" id="aLink">Stuur inloglink</button><button class="btn" id="aGoogle">Doorgaan met Google</button></div><p class="note" id="aMsg"></p>`);
    $('#aLink', el).onclick = async () => { const m = $('#aMail', el).value.trim(); if (!/^\S+@\S+\.\S+$/.test(m)) { $('#aMsg', el).textContent = T('Vul een geldig e-mailadres in.'); return; } try { await Auth.magicLink(m); $('#aMsg', el).textContent = T('Check je mail en klik op de link om in te loggen.'); } catch (e) { $('#aMsg', el).textContent = e.message; } };
    $('#aGoogle', el).onclick = () => Auth.google().catch(e => { $('#aMsg', el).textContent = e.message; });
  },
  async sync() {
    this.button(); if (!Auth.user) return;
    try {
      for (const k of await Sync.pullVisits(CITY.id)) localSetVisited(k, true);
      const remote = await Sync.pullRoutes(CITY.id), local = Store.routes(), byId = new Map(local.map(r => [r.id, r]));
      for (const r of remote) byId.set(r.id, { id: r.id, title: r.title, color: r.color, stops: r.stops, author: Auth.name(), updated: Date.parse(r.updated_at) });
      for (const r of local) if (!remote.some(x => x.id === r.id)) Sync.saveRoute(CITY.id, r).catch(() => { });
      Store.set('routes', [...byId.values()].sort((a, b) => (b.updated || 0) - (a.updated || 0)));
      for (const p of CURATED) Pins.refresh(p); if (UI.tab) UI.render();
    } catch (e) { ErrLog.add('sync: ' + e.message); }
  },
  async remoteReviews(key, root) {
    if (!Auth.enabled) return;
    try {
      const list = await Sync.reviews(CITY.id, key), box = $('.reviews', root); if (!list.length || !box) return;
      const h = $('h3', box); h.insertAdjacentHTML('afterend', list.map(r => `<div class="rv"><span class="st">${'★'.repeat(r.stars)}${'☆'.repeat(5 - r.stars)}</span> <b>${esc(r.author_name || '')}</b>${r.text ? '<br>' + esc(r.text) : ''}</div>`).join(''));
      $$('.note', box).forEach(n => { if (/Nog geen ervaringen|No reviews yet/.test(n.textContent)) n.remove(); });
    } catch (e) { console.warn(e); }
  },
};
// lokale opslag koppelen aan het account
const localSetVisited = Store.setVisited.bind(Store);
Store.setVisited = (k, on) => { localSetVisited(k, on); if (Auth.user) Sync.setVisit(CITY.id, k, on).catch(e => ErrLog.add('sync: ' + e.message)); };
{ const sr = Store.saveRoute.bind(Store), dr = Store.deleteRoute.bind(Store), ar = Store.addReview.bind(Store);
  Store.saveRoute = r => { const rec = sr(r); if (Auth.user) Sync.saveRoute(CITY.id, rec).catch(e => ErrLog.add('sync: ' + e.message)); return rec; };
  Store.deleteRoute = id => { dr(id); if (Auth.user) Sync.deleteRoute(id).catch(() => { }); };
  Store.addReview = (key, rv) => { ar(key, rv); if (Auth.user) Sync.addReview(CITY.id, key, rv).catch(e => ErrLog.add('review: ' + e.message)); };
  Store.user = () => ({ id: Auth.user?.id || 'local', name: Auth.user ? Auth.name() : 'Jij' }); }
Auth.onChange(() => Account.sync());

// =====================================================================
//  KOPBALK: stad, terug naar de wereldbol, dag/nacht, taal, account
// =====================================================================
const Chrome = {
  init() {
    document.title = `Dwaal · ${CITY.name}`;
    const brand = $('.brand'); if (brand) { $('span:last-child', brand).textContent = CITY.name; brand.title = 'Terug naar de wereldbol'; brand.onclick = () => { location.href = 'index.html'; }; brand.style.cursor = 'pointer'; }
    const em = $('.loader .big em'); if (em) em.textContent = '✕✕✕ ' + CITY.name;
    const sb = $('#btnSearch'), mk = (id, label, svg) => { const b = document.createElement('button'); b.className = 'ibtn'; b.id = id; b.setAttribute('aria-label', label); b.innerHTML = svg; sb.before(b); return b; };
    const nb = mk('btnNight', 'Schakel naar nacht', '<svg viewBox="0 0 24 24"><path class="off" d="M12 4v1.5M12 18.5V20M4 12h1.5M18.5 12H20M6.3 6.3l1.1 1.1M16.6 16.6l1.1 1.1M6.3 17.7l1.1-1.1M16.6 7.4l1.1-1.1"/><circle class="off" cx="12" cy="12" r="3.6"/><path class="on" d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/></svg>');
    nb.setAttribute('aria-pressed', 'false'); nb.onclick = () => Night.toggle();
    const lb = document.createElement('button'); lb.className = 'ibtn lang'; lb.id = 'btnLang'; lb.textContent = LANG === 'nl' ? 'EN' : 'NL'; lb.setAttribute('aria-label', LANG === 'nl' ? 'Switch to English' : 'Wissel naar Nederlands'); lb.setAttribute('translate', 'no'); lb.onclick = () => setLangAndReload(LANG === 'nl' ? 'en' : 'nl'); sb.before(lb);
    const ab = mk('btnAcct', 'Inloggen', ''); ab.onclick = () => Account.open(); $('#btnHome').after(ab); Account.button();
  },
};
function setLangAndReload(l) { try { localStorage.setItem('dwaal:lang', l); } catch { } const u = new URL(location.href); u.searchParams.set('lang', l); location.href = u.toString(); }


// =====================================================================
//  KLAARGEZETTE STADSDATA (data/<stad>/, gemaakt door bake/bake.py)
//  Eén methode voor alle steden:
//  - lo.bin.gz   : de hele stad als lichte bouwblokken (direct zichtbaar)
//  - hi/x_z.*    : volledig detail per tegel van 500 m, alleen bij inzoomen
//  - base/places/transit.json.gz : grond, water, straten, bomen, plekken, OV
// =====================================================================
// theater & muziek: alleen echte zalen. Overture noemt ook gezelschappen, scholen, bureaus en bioscopen 'theater'.
const NOT_VENUE = /\b(school|academy|academie|acad[ée]mie|studio[s]? school|drama|cours|conservato|company|compagnie|companie|ensemble|orkest|orchestra|orchestre|productions?|agency|agence|bureau|management|casting|records|rehearsal|repetitie|makelaar|real estate|convene|foundation|stichting|association|institute|lessons?|workshop)\b/i, CINEMA = /\b(cin[ée]ma|cinema|path[ée]|gaumont|ugc|mk2|amc|regal|imax|bioscoop|filmhuis)\b/i;
function venueFilter(J) {
  const seen = new Map(), out = [];
  for (const el of J.elements || []) {
    const t = el.tags || {};
    if (t.amenity === 'theatre') {
      const n = t.name || ''; if (!n || NOT_VENUE.test(n)) continue;
      if (CINEMA.test(n)) { t.amenity = 'cinema'; out.push(el); continue; }
      const la = el.lat ?? el.center?.lat, lo = el.lon ?? el.center?.lon, k = n.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 14);
      const prev = seen.get(k); if (prev && Math.abs(prev[0] - la) < .0008 && Math.abs(prev[1] - lo) < .0011) continue; seen.set(k, [la, lo]);
    }
    out.push(el);
  }
  return { ...J, elements: out };
}
const Baked = {
  progress: 0, man: null, tiles: new Map(), active: 0, S: 500,
  dir() { return `data/${CITY.id}/`; },
  async fetchBuf(name) {
    const r = await fetch(this.dir() + name); if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    let buf = await r.arrayBuffer(); const u = new Uint8Array(buf, 0, 2);
    if (u[0] === 0x1f && u[1] === 0x8b) buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    return buf;
  },
  async json(name) { await this.manifest(); return JSON.parse(new TextDecoder().decode(await this.fetchBuf(`${name}.json.gz`))); },
  manifest() {
    return this._m ??= fetch(this.dir() + 'manifest.json', { cache: 'no-cache' }).then(r => {
      if (!r.ok) throw new Error('Geen kaartdata gevonden voor deze stad. Draai eerst het bake-script (zie README).');
      return r.json();
    }).then(m => { this.man = m; this.S = m.tile; return m; });
  },
  // binair tegelformaat 'DWT1' (zie bake.py: write_tiles)
  parse(buf) {
    const dv = new DataView(buf); if (dv.getUint32(0, true) !== 0x31545744) throw new Error('onbekend tegelformaat');
    const n = dv.getUint32(4, true), out = []; let o = 8;
    for (let i = 0; i < n; i++) {
      const tx = dv.getInt32(o, true), tz = dv.getInt32(o + 4, true), nv = dv.getUint32(o + 8, true), ni = dv.getUint32(o + 12, true), it = dv.getUint8(o + 16), hasIds = dv.getUint8(o + 17); o += 20;
      const pos = new Uint16Array(buf, o, nv * 3); o = (o + nv * 6 + 3) & ~3;
      let ids = null; if (hasIds) { ids = new Uint16Array(buf, o, nv); o = (o + nv * 2 + 3) & ~3; }
      const idx = it === 2 ? new Uint16Array(buf, o, ni) : new Uint32Array(buf, o, ni); o = (o + ni * it + 3) & ~3;
      out.push({ tx, tz, nv, pos, ids, idx });
    }
    return out;
  },
  mesh(t) {
    const S = this.S, x0 = t.tx * S, z0 = t.tz * S, n = t.nv, p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { p[i * 3] = x0 - 50 + t.pos[i * 3] / 100; p[i * 3 + 1] = t.pos[i * 3 + 1] / 100 - 20; p[i * 3 + 2] = z0 - 50 + t.pos[i * 3 + 2] / 100; }   // 50 m marge, zie bake.py PAD
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3)); g.setIndex(new THREE.BufferAttribute(t.idx.slice(), 1));
    const seed = (hash(t.tx + ':' + t.tz) % 997) * 1000, f = new Float32Array(n);
    if (t.ids) for (let i = 0; i < n; i++) f[i] = t.ids[i] + seed; else f.fill(seed);
    g.setAttribute('fid', new THREE.BufferAttribute(f, 1)); g.setAttribute('hl', new THREE.BufferAttribute(t.ids ? new Float32Array(n) : new Float32Array(n).fill(-1), 1));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3));   // vlakke belichting via schermafgeleiden
    g.computeBoundingSphere(); g.computeBoundingBox();
    const m = new THREE.Mesh(g, M.building); m.castShadow = m.receiveShadow = true;
    if (t.ids) m.userData.srcId = Float32Array.from(t.ids);
    return m;
  },
  async load() {
    const m = await this.manifest();
    UI.loader.status('Gebouwen laden…');
    const buf = await this.fetchBuf(m.lo); this.progress = .7;
    for (const t of this.parse(buf)) {
      const key = t.tx + '_' + t.tz, mesh = this.mesh(t); scene.add(mesh); Tiles.meshes.add(mesh);
      this.tiles.set(key, { key, tx: t.tx, tz: t.tz, cx: (t.tx + .5) * this.S, cz: (t.tz + .5) * this.S, lo: mesh, hi: null, loading: false, hasHi: !!m.hi[key] });
    }
    for (const key of Object.keys(m.hi)) if (!this.tiles.has(key)) { const [tx, tz] = key.split('_').map(Number); this.tiles.set(key, { key, tx, tz, cx: (tx + .5) * this.S, cz: (tz + .5) * this.S, lo: null, hi: null, loading: false, hasHi: true }); }
    for (const l of CITY.landmarks || []) safe(() => Landmarks[l.type]?.(l), 'landmark');
    Tiles.hasIds = true; Tiles.calibrated = true; Tiles.dirty = true; this.progress = 1; Tiles.onReady?.();
    setInterval(() => this.update(), 250);
  },
  // detail laden rond het punt waar je naar kijkt; verder weg terug naar blokken
  update() {
    const tg = controls.target, cd = camera.position.distanceTo(tg);
    const range = cd < 3500 ? clamp(cd * 1.15, 650, 2400) : 0, want = [];
    for (const t of this.tiles.values()) {
      t.d = Math.hypot(t.cx - tg.x, t.cz - tg.z);
      if (t.hasHi && t.d < range) { if (!t.hi && !t.loading) want.push(t); }
      else if (t.hi && t.d > range * 1.5 + 400) this.dropHi(t);
    }
    want.sort((a, b) => a.d - b.d);
    for (const t of want) { if (this.active >= (isMobile ? 3 : 5)) break; this.loadHi(t); }
  },
  async loadHi(t) {
    t.loading = true; this.active++;
    try {
      const [buf, attrs] = await Promise.all([this.fetchBuf(`hi/${t.key}.bin.gz`), this.json(`hi/${t.key}`)]);
      const [pt] = this.parse(buf); const mesh = this.mesh(pt);
      t.attrs = attrs.b; t.rings = null; t.hi = mesh;
      scene.add(mesh); Tiles.meshes.add(mesh); Tiles.bvhQ.push(mesh);
      if (t.lo) t.lo.visible = false;
      Tiles.dirty = true;
    } catch (e) { t.hasHi = false; console.warn('tegel', t.key, e); }
    finally { t.loading = false; this.active--; }
  },
  dropHi(t) {
    const m = t.hi; if (!m) return; t.hi = null; t.attrs = t.rings = null;
    scene.remove(m); Tiles.meshes.delete(m); HL.meshGone(m); m.geometry.boundsTree && m.geometry.disposeBoundsTree(); m.geometry.dispose();
    if (t.lo) { const b = t.lo.userData.box; t.lo.visible = !b || Math.hypot(Math.max(b.min.x, 0, -b.max.x), Math.max(b.min.z, 0, -b.max.z)) < R; }
    Tiles.dirty = true;
  },
  // gebouwgegevens (voor het infokaartje) uit de geladen detailtegel
  footprint(x, z, pad = 4) {
    const t = this.tiles.get(Math.floor(x / this.S) + '_' + Math.floor(z / this.S)); if (!t?.attrs) return null;
    const x0 = t.tx * this.S, z0 = t.tz * this.S;
    if (!t.rings) t.rings = t.attrs.map(a => { const q = a[6], r = new Float32Array(q.length); let bx0 = 1e9, bx1 = -1e9, bz0 = 1e9, bz1 = -1e9; for (let i = 0; i < q.length; i += 2) { r[i] = x0 + q[i] / 10; r[i + 1] = z0 + q[i + 1] / 10; bx0 = Math.min(bx0, r[i]); bx1 = Math.max(bx1, r[i]); bz0 = Math.min(bz0, r[i + 1]); bz1 = Math.max(bz1, r[i + 1]); } return { r, bb: [bx0, bz0, bx1, bz1] }; });
    let best = -1, bd = pad;
    for (let i = 0; i < t.rings.length; i++) {
      const { r, bb } = t.rings[i]; if (r.length < 6 || x < bb[0] - pad || x > bb[2] + pad || z < bb[1] - pad || z > bb[3] + pad) continue;
      if (pipFlat(x, z, r)) { best = i; break; }
      for (let k = 0; k < r.length; k += 2) { const d = Math.hypot(r[k] - x, r[k + 1] - z); if (d < bd) { bd = d; best = i; } }
    }
    if (best < 0) return null;
    const a = t.attrs[best], { r } = t.rings[best]; let cx = 0, cz = 0; for (let i = 0; i < r.length; i += 2) { cx += r[i]; cz += r[i + 1]; } cx /= r.length / 2; cz /= r.length / 2;
    return { id: String(a[0]), h: a[1] || null, yr: a[2] || null, levels: a[3] || null, name: a[4] || null, architect: a[5] || null, rings: [r], cx, cz };
  },
};
// compacte basisdata -> dezelfde vorm als OpenStreetMap-elementen (met lokale coördinaten in .L)
function baseToEls(B) {
  const P = a => { const r = []; for (let i = 0; i < a.length; i += 2) r.push([a[i], a[i + 1]]); return r; };
  const closed = r => (r.length > 2 && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) ? [...r, r[0]] : r;
  const els = [];
  for (const p of B.parks || []) els.push({ type: 'way', tags: { leisure: 'park' }, L: closed(P(p.o)) });
  for (const p of B.markets || []) els.push({ type: 'way', tags: { amenity: 'marketplace' }, L: closed(P(p.o)) });
  for (const s of B.streets || []) els.push({ type: 'way', tags: s.b ? { highway: s.c, bridge: 'yes' } : { highway: s.c }, L: P(s.p) });
  for (const r of B.rivers || []) els.push({ type: 'way', tags: { waterway: 'river' }, L: P(r) });
  const tr = B.trees || []; for (let i = 0; i < tr.length; i += 2) els.push({ type: 'node', L: [tr[i], tr[i + 1]] });
  return els;
}

boot();
