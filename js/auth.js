// Accounts via Supabase (optioneel). Zonder sleutels werkt alles lokaal.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
let sb = null, user = null;
const listeners = new Set();
const emit = () => listeners.forEach(f => { try { f(user); } catch (e) { console.warn(e); } });
export const Auth = {
  enabled: !!(SUPABASE_URL && SUPABASE_ANON_KEY),
  get user() { return user; },
  async init() {
    if (!this.enabled || sb) return;
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
    sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data } = await sb.auth.getSession(); user = data.session?.user || null;
    sb.auth.onAuthStateChange((_e, s) => { const was = user?.id; user = s?.user || null; if (was !== user?.id) emit(); });
    emit();
  },
  onChange(f) { listeners.add(f); },
  name() { return user?.user_metadata?.full_name || user?.user_metadata?.name || user?.email?.split('@')[0] || 'Guest'; },
  async magicLink(email) { const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.href.split('#')[0] } }); if (error) throw error; },
  async google() { const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.href.split('#')[0] } }); if (error) throw error; },
  async signOut() { await sb.auth.signOut(); user = null; emit(); },
};
const need = () => { if (!sb || !user) throw new Error('niet ingelogd'); };
export const Sync = {
  async pullVisits(city) { need(); const { data, error } = await sb.from('visits').select('place_key').eq('city', city).eq('user_id', user.id); if (error) throw error; return data.map(r => r.place_key); },
  async setVisit(city, key, on) {
    need();
    const q = on ? sb.from('visits').upsert({ user_id: user.id, city, place_key: key }) : sb.from('visits').delete().match({ user_id: user.id, city, place_key: key });
    const { error } = await q; if (error) throw error;
  },
  async pullRoutes(city) { need(); const { data, error } = await sb.from('routes').select('*').eq('city', city).eq('user_id', user.id).order('updated_at', { ascending: false }); if (error) throw error; return data; },
  async saveRoute(city, r) { need(); const { error } = await sb.from('routes').upsert({ id: r.id, user_id: user.id, city, title: r.title, color: r.color || null, stops: r.stops, updated_at: new Date().toISOString() }); if (error) throw error; },
  async deleteRoute(id) { need(); await sb.from('routes').delete().eq('id', id).eq('user_id', user.id); },
  async reviews(city, key) { if (!sb) return []; const { data, error } = await sb.from('reviews').select('stars,text,author_name,created_at,user_id').eq('city', city).eq('place_key', key).order('created_at', { ascending: false }).limit(40); if (error) throw error; return (data || []).filter(r => r.user_id !== user?.id); },
  async addReview(city, key, rv) { need(); const { error } = await sb.from('reviews').insert({ user_id: user.id, city, place_key: key, stars: rv.stars, text: rv.text || '', author_name: Auth.name() }); if (error) throw error; },
};
