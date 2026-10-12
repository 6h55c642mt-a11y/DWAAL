// Bouwstenen voor stadsgidsen. Basis Nederlands, Engels in `en`.
// P(id, categorie, lat, lon, wikipedia, minuten, nl, en, extra)  — wikipedia zonder taalprefix = Engelse Wikipedia
export const P = (id, cat, lat, lon, wiki, time, nl, en, extra = {}) => ({ id, cat, lat, lon, wiki: wiki ? (/^[a-z]{2}:/.test(wiki) ? wiki : 'en:' + wiki) : null, time, ...nl, en, ...extra });
// D(id, naam, kleur, ondertitel, polygoon [[lat,lon]…], tekst[], hoogtepunten[], routes[{title,desc,stops}], en{name?,tag,text,highlights,routes[{title,desc}]})
export const D = (id, name, color, tag, poly, text, highlights, routes, en) => ({ id, name, color, tag, poly, text, highlights, routes, en });
// R(id, titel, kleur, omschrijving, stops, en{title,desc})
export const R = (id, title, color, desc, stops, en) => ({ id, title, color, desc, stops, en });
export const FREE = { book: 'Gratis.', en: { book: 'Free.' } };
export const ONLINE = { book: 'Online tickets aanbevolen.', en: { book: 'Online tickets recommended.' } };
export const SLOT = { book: 'Koop online met tijdslot.', en: { book: 'Buy online with a time slot.' } };
