// Landingspagina: wereldbol met de echte stand van de zon. Kies een stad.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { feature } from 'https://cdn.jsdelivr.net/npm/topojson-client@3/+esm';
import { LANG, T, installTranslator } from './i18n.js';
import { Auth } from './auth.js';
import { CITIES } from '../cities/index.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DEG = Math.PI / 180, isMobile = matchMedia('(pointer:coarse)').matches || innerWidth < 760;
const cname = c => (LANG === 'nl' && c.id === 'paris') ? 'Parijs' : c.name;
installTranslator();

// ---------- scène ----------
const canvas = $('#globe');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, isMobile ? 1.75 : 2)); renderer.setSize(innerWidth, innerHeight);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(36, innerWidth / innerHeight, .1, 100);
const controls = new OrbitControls(camera, canvas);
Object.assign(controls, { enablePan: false, enableDamping: true, dampingFactor: .07, minDistance: 1.7, maxDistance: 6, rotateSpeed: .55, autoRotate: true, autoRotateSpeed: .35 });
controls.addEventListener('start', () => { controls.autoRotate = false; });
const ll2v = (lat, lon, r = 1) => new THREE.Vector3(r * Math.cos(lat * DEG) * Math.cos(lon * DEG), r * Math.sin(lat * DEG), -r * Math.cos(lat * DEG) * Math.sin(lon * DEG));
camera.position.copy(ll2v(32, -18, isMobile ? 3.9 : 3.2));

// ---------- zon: subsolair punt uit de huidige tijd ----------
function subsolar(date = new Date()) {
  const d = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 864e5;
  const g = (357.529 + .98560028 * d) * DEG, q = (280.459 + .98564736 * d) * DEG;
  const L = q + (1.915 * Math.sin(g) + .020 * Math.sin(2 * g)) * DEG, e = (23.439 - .00000036 * d) * DEG;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24;
  let lon = (ra / DEG - gmst * 15) % 360; if (lon > 180) lon -= 360; if (lon < -180) lon += 360;
  return { lat: dec / DEG, lon };
}
const sunU = { value: new THREE.Vector3(1, 0, 0) };
const updSun = () => { const s = subsolar(); sunU.value.copy(ll2v(s.lat, s.lon)).normalize(); };
updSun(); setInterval(updSun, 60000);

// ---------- aarde: land getekend in de stijl van de kaart ----------
const W = isMobile ? 2048 : 4096, H = W / 2, tc = document.createElement('canvas'); tc.width = W; tc.height = H;
const g = tc.getContext('2d');
g.fillStyle = '#4F93A3'; g.fillRect(0, 0, W, H);
g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 1;
for (let lo = -180; lo <= 180; lo += 15) { const x = (lo + 180) / 360 * W; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
for (let la = -75; la <= 75; la += 15) { const y = (90 - la) / 180 * H; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
const tex = new THREE.CanvasTexture(tc); tex.anisotropy = 4;
const globeMat = new THREE.ShaderMaterial({
  uniforms: { map: { value: tex }, sun: sunU },
  vertexShader: 'varying vec2 vUv; varying vec3 vN; void main(){ vUv = uv; vN = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D map; uniform vec3 sun; varying vec2 vUv; varying vec3 vN;
    void main(){ vec3 c = texture2D(map, vUv).rgb; float d = dot(normalize(vN), sun);
      float day = smoothstep(-.09, .14, d);
      vec3 dayC = c * (.62 + .38 * max(d, 0.0));
      vec3 nightC = c * vec3(.11, .14, .22) + vec3(.01, .015, .03);
      vec3 col = mix(nightC, dayC, day);
      col += vec3(1.0, .55, .25) * .10 * (1.0 - abs(d * 6.0 - .2)) * step(-.17, d) * step(d, .2);
      gl_FragColor = vec4(col, 1.0); }`,
});
const globe = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 64), globeMat); scene.add(globe);
const atmo = new THREE.Mesh(new THREE.SphereGeometry(1.06, 64, 32), new THREE.ShaderMaterial({
  uniforms: { sun: sunU }, side: THREE.BackSide, transparent: true, depthWrite: false,
  vertexShader: 'varying vec3 vN; varying vec3 vV; void main(){ vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position,1.); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }',
  fragmentShader: 'varying vec3 vN; varying vec3 vV; void main(){ float f = pow(1.0 - abs(dot(vN, vV)), 2.2); gl_FragColor = vec4(.62, .82, .9, f * .55); }',
})); scene.add(atmo);
fetch(`https://cdn.jsdelivr.net/npm/world-atlas@2/land-${isMobile ? 110 : 50}m.json`).then(r => r.json()).then(topo => {
  const land = feature(topo, topo.objects.land);
  g.fillStyle = '#F4F2EC'; g.strokeStyle = '#C9C4B4'; g.lineWidth = isMobile ? 1 : 1.6;
  const path = coords => { coords.forEach((ring, ri) => { let px = null; ring.forEach(([lo, la], i) => { const x = (lo + 180) / 360 * W, y = (90 - la) / 180 * H; if (i === 0 || (px != null && Math.abs(x - px) > W / 2)) g.moveTo(x, y); else g.lineTo(x, y); px = x; }); }); };
  g.beginPath();
  for (const f of land.features) { const geo = f.geometry; if (geo.type === 'Polygon') path(geo.coordinates); else for (const p of geo.coordinates) path(p); }
  g.fill('evenodd'); g.stroke(); tex.needsUpdate = true; $('#gstat').hidden = true;
}).catch(e => { console.warn(e); $('#gstat').textContent = T('Kaart kon niet laden; de steden werken wel.'); });

// ---------- steden ----------
const labels = $('#labels'), markers = [];
for (const c of CITIES) {
  const p = ll2v(c.lat, c.lon, 1.004);
  const dot = new THREE.Mesh(new THREE.SphereGeometry(.012, 12, 8), new THREE.MeshBasicMaterial({ color: '#D7262C' })); dot.position.copy(p); scene.add(dot);
  const ring = new THREE.Mesh(new THREE.RingGeometry(.016, .022, 32), new THREE.MeshBasicMaterial({ color: '#D7262C', transparent: true, side: THREE.DoubleSide })); ring.position.copy(p); ring.lookAt(p.clone().multiplyScalar(2)); scene.add(ring);
  const b = document.createElement('button'); b.className = 'clabel'; b.innerHTML = `<i></i>${esc(cname(c))}`; b.onclick = () => select(c); labels.appendChild(b);
  markers.push({ c, p, b, ring });
}
$('#clist').innerHTML = CITIES.map(c => `<button data-c="${c.id}">${esc(cname(c))}<small>${esc(c.country[LANG])}</small></button>`).join('');
document.querySelectorAll('#clist [data-c]').forEach(b => b.onclick = () => select(CITIES.find(c => c.id === b.dataset.c)));

let fly = null;
function select(c) {
  controls.autoRotate = false;
  const to = ll2v(c.lat, c.lon, isMobile ? 2.6 : 2.1), from = camera.position.clone();
  fly = { from, to, t0: performance.now() };
  const local = new Intl.DateTimeFormat(LANG === 'nl' ? 'nl-NL' : 'en-GB', { timeZone: c.tz, hour: '2-digit', minute: '2-digit', weekday: 'long' }).format(new Date());
  const isDay = ll2v(c.lat, c.lon).dot(sunU.value) > -.05;
  const card = $('#ccard');
  card.innerHTML = `<button class="mclose" aria-label="${T('Sluit')}">×</button><span class="pill">${esc(c.country[LANG])}</span><h2>${esc(cname(c))}</h2>
    <p class="ctime">${isDay ? '☀︎' : '☾'} ${esc(local)} ${T('lokale tijd')}, ${T(isDay ? 'Nu dag' : 'Nu nacht')}</p><p>${esc(c.blurb[LANG])}</p>
    <a class="btn pri" href="city.html?city=${c.id}&lang=${LANG}">${T('Verken')} ${esc(cname(c))} →</a>`;
  card.hidden = false; $('.mclose', card).onclick = () => { card.hidden = true; };
}

// ---------- kop: taal en account ----------
$('#btnLang').textContent = LANG === 'nl' ? 'EN' : 'NL';
$('#btnLang').onclick = () => { try { localStorage.setItem('dwaal:lang', LANG === 'nl' ? 'en' : 'nl'); } catch { } const u = new URL(location.href); u.searchParams.set('lang', LANG === 'nl' ? 'en' : 'nl'); location.href = u.toString(); };
$('#btnAcct').onclick = () => {
  const m = $('#modal'); m.hidden = false; m.onclick = e => { if (e.target === m) m.hidden = true; };
  const box = $('.mbox', m);
  if (!Auth.enabled) box.innerHTML = `<button class="mclose">×</button><h2>Account</h2><p>${T('Accounts zijn nog niet gekoppeld. Alles wat je bewaart (routes, bezochte plekken, ervaringen) staat nu op dit apparaat.')}</p>`;
  else if (Auth.user) { box.innerHTML = `<button class="mclose">×</button><h2>${T('Hallo')} ${esc(Auth.name())}</h2><p class="note">${esc(Auth.user.email || '')}</p><div class="btnrow"><button class="btn" id="aOut">${T('Uitloggen')}</button></div>`; $('#aOut').onclick = async () => { await Auth.signOut(); m.hidden = true; }; }
  else {
    box.innerHTML = `<button class="mclose">×</button><h2>${T('Inloggen')}</h2><p>${T('Log in om je routes, bezochte plekken en ervaringen te bewaren en te delen. Je krijgt een link per e-mail, zonder wachtwoord.')}</p><input class="field" id="aMail" type="email" placeholder="${T('jij@voorbeeld.nl')}"><div class="btnrow"><button class="btn pri" id="aLink">${T('Stuur inloglink')}</button><button class="btn" id="aGoogle">${T('Doorgaan met Google')}</button></div><p class="note" id="aMsg"></p>`;
    $('#aLink').onclick = async () => { try { await Auth.magicLink($('#aMail').value.trim()); $('#aMsg').textContent = T('Check je mail en klik op de link om in te loggen.'); } catch (e) { $('#aMsg').textContent = e.message; } };
    $('#aGoogle').onclick = () => Auth.google().catch(e => { $('#aMsg').textContent = e.message; });
  }
  $('.mclose', box).onclick = () => { m.hidden = true; };
};
Auth.init().then(() => { if (Auth.user) $('#btnAcct').innerHTML = `<span class="avatar">${esc(Auth.name()[0].toUpperCase())}</span>`; }).catch(() => { });

// ---------- lus ----------
const tmp = new THREE.Vector3(), camDir = new THREE.Vector3();
function loop() {
  requestAnimationFrame(loop);
  if (fly) { const k = Math.min(1, (performance.now() - fly.t0) / 1400), e = k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; camera.position.copy(fly.from).lerp(fly.to, e).setLength(fly.from.length() + (fly.to.length() - fly.from.length()) * e); if (k >= 1) fly = null; }
  controls.update();
  camDir.copy(camera.position).normalize();
  const t = performance.now() / 1000;
  for (const m of markers) {
    const vis = m.p.clone().normalize().dot(camDir) > .15;
    tmp.copy(m.p).project(camera);
    m.b.style.transform = `translate(${(tmp.x * .5 + .5) * innerWidth}px, ${(-tmp.y * .5 + .5) * innerHeight}px)`;
    m.b.classList.toggle('hidden', !vis); m.b.tabIndex = vis ? 0 : -1;
    const s = 1 + (t * .8 % 1) * 1.8; m.ring.scale.setScalar(s); m.ring.material.opacity = 1 - (t * .8 % 1);
  }
  renderer.render(scene, camera);
}
loop();
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
