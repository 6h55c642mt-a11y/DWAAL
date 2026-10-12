// Taal: Nederlands (basis van de interface) of Engels.
// De interface is in het Nederlands geschreven; in het Engels vertaalt een
// woordenboek (i18n-en.js) alle zichtbare teksten, ook die later verschijnen.
import { EN, EN_RULES, FACT_KEYS } from './i18n-en.js';

function detect() {
  const u = new URLSearchParams(location.search).get('lang');
  if (u === 'en' || u === 'nl') { try { localStorage.setItem('dwaal:lang', u); } catch { } return u; }
  try { const s = localStorage.getItem('dwaal:lang'); if (s === 'en' || s === 'nl') return s; } catch { }
  return (navigator.language || 'en').toLowerCase().startsWith('nl') ? 'nl' : 'en';
}
export const LANG = detect();
document.documentElement.lang = LANG;
export const DAY_NAMES = LANG === 'nl'
  ? ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag']
  : ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// Nederlandse tekst -> Engels (exact, of via een patroon voor tekst met getallen/namen)
export function T(s) {
  if (LANG === 'nl' || s == null) return s;
  const str = String(s), tr = str.trim(); if (!tr) return s;
  const hit = EN[tr]; if (hit != null) return str.replace(tr, hit);
  for (const [re, rep] of EN_RULES) if (re.test(tr)) return str.replace(tr, tr.replace(re, rep));
  return s;
}
export function setLang(l) { try { localStorage.setItem('dwaal:lang', l); } catch { } const u = new URL(location.href); u.searchParams.set('lang', l); location.href = u.toString(); }

// Vertaalt tekstknopen en attributen, ook van alles wat later in de pagina komt.
export function installTranslator(root = document.body) {
  if (LANG === 'nl') return;
  const ATTR = ['aria-label', 'placeholder', 'title'];
  const walk = node => {
    if (node.nodeType === 3) { const t = T(node.nodeValue); if (t !== node.nodeValue) node.nodeValue = t; return; }
    if (node.nodeType !== 1 || node.tagName === 'SCRIPT' || node.tagName === 'STYLE' || node.getAttribute('translate') === 'no') return;
    for (const a of ATTR) { const v = node.getAttribute(a); if (v) { const t = T(v); if (t !== v) node.setAttribute(a, t); } }
    for (const c of node.childNodes) walk(c);
  };
  walk(root); document.title = T(document.title);
  new MutationObserver(ms => {
    for (const m of ms) {
      if (m.type === 'characterData') { const t = T(m.target.nodeValue); if (t !== m.target.nodeValue) m.target.nodeValue = t; }
      else if (m.type === 'attributes') { const v = m.target.getAttribute(m.attributeName); if (v) { const t = T(v); if (t !== v) m.target.setAttribute(m.attributeName, t); } }
      else for (const n of m.addedNodes) walk(n);
    }
  }).observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTR });
}

// Stadsdata: basis in één taal, vertaling als overlay (cities/<stad>.js -> i18n[lang])
export function localizeCity(city, lang) {
  if (city.baseLang === lang) return city;
  const o = city.i18n?.[lang] || {}, c = { ...city };
  const tf = facts => { if (!facts || lang !== 'en') return facts; const r = {}; for (const [k, v] of Object.entries(facts)) r[FACT_KEYS[k] || k] = v; return r; };
  // vertaling staat óf in een aparte overlay (i18n[lang]), óf direct bij het item (veld met de taalcode, bv. en: {...})
  c.curated = city.curated.map(p => { const t = o.places?.[p.id] || p[lang]; if (!t) return { ...p, facts: tf(p.facts) }; return { ...p, ...t, facts: t.facts || tf(p.facts), wiki: t.wiki || p.wiki }; });
  c.districts = city.districts.map(D => { const t = o.districts?.[D.id] || D[lang]; if (!t) return D; return { ...D, ...t, routes: D.routes.map((r, i) => ({ ...r, ...(t.routes?.[i] || r[lang] || {}) })) }; });
  c.presets = city.presets.map(r => ({ ...r, ...(o.presets?.[r.id] || r[lang] || {}) }));
  c.info = Object.fromEntries(Object.entries(city.info || {}).map(([k, v]) => [k, { ...v, ...(o.info?.[k] || v[lang] || {}) }]));
  for (const k of ['transit', 'starts', 'cafeLabel', 'name']) if (o[k]) c[k] = o[k];
  return c;
}
