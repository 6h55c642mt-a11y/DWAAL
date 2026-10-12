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
const cname = c => c.names?.[LANG] || c.name;
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

// ---------- aarde ----------
// Land in de kaartstijl (canvas, alpha = land), oceaan, wolken en stadslichten in shaders.
const NOISE = `
#define OCT ${isMobile ? 3 : 5}
vec3 mod289(vec3 x){return x-floor(x*(1./289.))*289.;} vec4 mod289(vec4 x){return x-floor(x*(1./289.))*289.;}
vec4 permute(vec4 x){return mod289(((x*34.)+1.)*x);} vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-.85373472095314*r;}
float snoise(vec3 v){const vec2 C=vec2(1./6.,1./3.);const vec4 D=vec4(0.,.5,1.,2.);vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);
vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;
i=mod289(i);vec4 p=permute(permute(permute(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));
float n_=.142857142857;vec3 ns=n_*D.wyz-D.xzx;vec4 j=p-49.*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.*x_);
vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.-abs(x)-abs(y);vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
vec4 s0=floor(b0)*2.+1.;vec4 s1=floor(b1)*2.+1.;vec4 sh=-step(h,vec4(0.));vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);m=m*m;return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));}
float fbm(vec3 p){float f=0.,a=.5;for(int i=0;i<OCT;i++){f+=a*snoise(p);p*=2.03;a*=.5;}return f;}
// wolkdichtheid op een punt van de bol (t = tijd)
float clouds(vec3 n,float t){ vec3 q=n*2.2+vec3(t*.012,0.,t*.007); float w=fbm(q+.7*fbm(q+1.7));
  float lat=abs(n.y); float band=.52+.12*smoothstep(.12,.32,lat)*(1.-smoothstep(.42,.7,lat)); // minder wolken rond 25° (woestijngordel)
  return smoothstep(band,band+.2,w*.5+.5); }
`;
const W = isMobile ? 2048 : 4096, H = W / 2, tc = document.createElement('canvas'); tc.width = W; tc.height = H;
const g = tc.getContext('2d', { willReadFrequently: true });   // CPU-canvas: blijft bewaard bij een GPU-reset
const tex = new THREE.CanvasTexture(tc); tex.anisotropy = 8; tex.colorSpace = THREE.SRGBColorSpace;
const nightTex = new THREE.TextureLoader().load('assets/earth-night.jpg');
const timeU = { value: 0 };
const CW = isMobile ? 512 : 1024, cloudRT = new THREE.WebGLRenderTarget(CW, CW / 2, { wrapS: THREE.RepeatWrapping });
const cloudScene = new THREE.Scene(), cloudCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const cloudGen = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  uniforms: { time: timeU }, depthTest: false,
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
  fragmentShader: NOISE + `uniform float time; varying vec2 vUv;
    void main(){ float ph = vUv.x * 6.2831853, th = (1. - vUv.y) * 3.1415927;
      vec3 n = vec3(-cos(ph) * sin(th), cos(th), sin(ph) * sin(th));
      gl_FragColor = vec4(clouds(n, time), clouds(n, time + 40.), 0., 1.); }`,
}));
cloudScene.add(cloudGen);
let cloudT = -99;
function updateClouds(t) { if (t - cloudT < (isMobile ? 4 : 1.5)) return; cloudT = t; renderer.setRenderTarget(cloudRT); renderer.render(cloudScene, cloudCam); renderer.setRenderTarget(null); }
const UVF = `vec2 n2uv(vec3 n){ float u = atan(n.z, -n.x) / 6.2831853; return vec2(fract(u), 1. - acos(clamp(n.y, -1., 1.)) / 3.1415927); }`;
const globeMat = new THREE.ShaderMaterial({
  uniforms: { map: { value: tex }, night: { value: nightTex }, cl: { value: cloudRT.texture }, sun: sunU, time: timeU, camPos: { value: new THREE.Vector3() } },
  vertexShader: 'varying vec2 vUv; varying vec3 vN; varying vec3 vW; void main(){ vUv = uv; vN = normalize(position); vW = (modelMatrix*vec4(position,1.)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: NOISE + UVF + `uniform sampler2D map; uniform sampler2D night; uniform sampler2D cl; uniform vec3 sun; uniform float time; uniform vec3 camPos; varying vec2 vUv; varying vec3 vN; varying vec3 vW;
    void main(){
      vec3 n = normalize(vN); vec4 t = texture2D(map, vUv); float land = t.a;
      float d = dot(n, sun), day = smoothstep(-.10, .16, d);
      vec3 V = normalize(camPos - vW);
      // oceaan: diepte-kleur, golfnormalen en zonneglinstering
      vec3 deep = vec3(.17,.36,.42), shallow = vec3(.36,.60,.66);
      float wv = snoise(n*90. + vec3(time*.15)), wv2 = snoise(n*90. + 7.3 - vec3(time*.12));
      vec3 wn = normalize(n + .018 * vec3(wv, wv2, wv * .7 - wv2 * .5));
      float fres = pow(1. - max(dot(V, n), 0.), 3.);
      vec3 H = normalize(sun + V); float spec = pow(max(dot(wn, H), 0.), 400.) * .9 + pow(max(dot(n, H), 0.), 60.) * .08;
      vec3 ocean = mix(deep, shallow, .38 + .06 * wv);
      ocean = mix(ocean, vec3(.75,.88,.92), fres * .55);
      vec3 landC = t.rgb;
      vec3 c = mix(ocean, landC, land);
      // wolkschaduw op de grond
      float cs = texture2D(cl, n2uv(normalize(n + sun * .02))).r;
      vec3 dayC = c * (.55 + .45 * max(d, 0.)) * (1. - .28 * cs) + vec3(1.,.97,.9) * spec * (1. - land) * (1. - cs) * day;
      vec3 nightC = mix(vec3(.035,.06,.085), vec3(.07,.075,.09), land);
      // stadslichten aan de nachtkant
      float lights = texture2D(night, vUv).r; lights = smoothstep(.12, .9, lights);
      nightC += vec3(1., .72, .38) * lights * 1.35 * land * (1. - .6 * texture2D(cl, vUv).r);
      vec3 col = mix(nightC, dayC, day);
      col += vec3(1., .5, .22) * .14 * exp(-pow(d * 9., 2.)) * (1. - land * .3);   // warme schemerrand
      gl_FragColor = vec4(col, 1.0);
      #include <colorspace_fragment>
    }`,
});
const globe = new THREE.Mesh(new THREE.SphereGeometry(1, 192, 96), globeMat); scene.add(globe);
// wolken: twee lagen voor diepte, belicht door de zon
const cloudMat = (r, k) => new THREE.ShaderMaterial({
  uniforms: { sun: sunU, k: { value: k }, cl: { value: cloudRT.texture } }, transparent: true, depthWrite: false,
  vertexShader: 'varying vec3 vN; varying vec3 vV; void main(){ vN = normalize(position); vec4 mv = modelViewMatrix*vec4(position,1.); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }',
  fragmentShader: UVF + `uniform vec3 sun; uniform float k; uniform sampler2D cl; varying vec3 vN; varying vec3 vV;
    float C(vec3 n){ vec2 t = texture2D(cl, n2uv(n)).rg; return k > .5 ? t.g : t.r; }
    void main(){ vec3 n = normalize(vN); float c = C(n);
      float top = C(normalize(n - sun * .012));            // zelfschaduw: lichter aan de zonkant
      float d = dot(n, sun), day = smoothstep(-.12, .18, d);
      vec3 lit = mix(vec3(.62,.66,.72), vec3(1.), clamp(1. - (top - c) * 4. + .2, 0., 1.)) * (.6 + .4 * max(d, 0.));
      vec3 col = mix(vec3(.05,.07,.1), lit, day) + vec3(1.,.55,.3) * .25 * exp(-pow(d * 8., 2.));
      gl_FragColor = vec4(col, c * (k > .5 ? .45 : .8));
      #include <colorspace_fragment>
    }`,
});
const cloudsLo = new THREE.Mesh(new THREE.SphereGeometry(1.008, 128, 64), cloudMat(1.008, 0)); scene.add(cloudsLo);
const cloudsHi = new THREE.Mesh(new THREE.SphereGeometry(1.016, 96, 48), cloudMat(1.016, 1)); cloudsHi.rotation.y = .7; scene.add(cloudsHi);
const atmo = new THREE.Mesh(new THREE.SphereGeometry(1.07, 64, 32), new THREE.ShaderMaterial({
  uniforms: { sun: sunU }, side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: 'varying vec3 vN; varying vec3 vV; varying vec3 vP; void main(){ vN = normalize(normalMatrix * normal); vP = normalize(position); vec4 mv = modelViewMatrix * vec4(position,1.); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }',
  fragmentShader: 'uniform vec3 sun; varying vec3 vN; varying vec3 vV; varying vec3 vP; void main(){ float f = pow(1.0 - abs(dot(vN, vV)), 2.4); float l = smoothstep(-.35, .4, dot(vP, sun)); gl_FragColor = vec4(mix(vec3(.25,.35,.5), vec3(.6,.82,.95), l), f * (.25 + .5 * l)); }',
})); scene.add(atmo);
fetch(`https://cdn.jsdelivr.net/npm/world-atlas@2/land-${isMobile ? 110 : 50}m.json`).then(r => r.json()).then(topo => {
  const land = feature(topo, topo.objects.land);
  g.clearRect(0, 0, W, H);
  const path = coords => { coords.forEach(ring => { let px = null; ring.forEach(([lo, la], i) => { const x = (lo + 180) / 360 * W, y = (90 - la) / 180 * H; if (i === 0 || (px != null && Math.abs(x - px) > W / 2)) g.moveTo(x, y); else g.lineTo(x, y); px = x; }); }); };
  g.beginPath();
  for (const f of land.features) { const geo = f.geometry; if (geo.type === 'Polygon') path(geo.coordinates); else for (const p of geo.coordinates) path(p); }
  g.fillStyle = '#F2F0EA'; g.fill('evenodd');
  g.save(); g.clip('evenodd');
  // lichte reliëfvlekken in het land voor wat textuur
  for (let k = 0; k < 9000; k++) { const x = Math.random() * W, y = Math.random() * H, r = 1.5 + Math.random() * 7; g.fillStyle = `rgba(${Math.random() < .5 ? '214,208,190' : '226,232,220'},${.05 + Math.random() * .09})`; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); }
  g.restore();
  g.strokeStyle = 'rgba(160,152,130,.9)'; g.lineWidth = isMobile ? 1 : 1.5; g.stroke();
  tex.needsUpdate = true; $('#gstat').hidden = true;
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
    <p class="ctime">${isDay ? '☀︎' : '☾'} ${esc(local)} ${T('lokale tijd')}, ${T(isDay ? 'Nu dag' : 'Nu nacht')}</p>${(c.intro?.[LANG] || [c.blurb[LANG]]).map(t => `<p class="cintro">${esc(t)}</p>`).join('')}${c.top ? `<ul class="ctop">${c.top[LANG].map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
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
  controls.update(); timeU.value = performance.now() / 1000; updateClouds(timeU.value); globeMat.uniforms.camPos.value.copy(camera.position);
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
