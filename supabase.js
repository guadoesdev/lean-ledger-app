const { createClient } = require('@supabase/supabase-js');

// The service role key bypasses row level security, so it must stay on the server. Never send it to the browser.
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const ok = ({ data, error }) => { if (error) throw new Error('Supabase: ' + error.message); return data; };
const isId = s => /^\d+$/.test(String(s));
const n = v => (typeof v === 'number' ? v : 0);
const mine = uid => `user_id.is.null,user_id.eq.${Number(uid)}`;   // built-in foods plus this user's own

// ---------- users ----------
const userByEmail = async email => {
  const r = ok(await sb.from('users').select('id, pass').eq('email', email).maybeSingle());
  return r && { id: r.id, pass: r.pass };
};
const createUser = async (email, pass) => ok(await sb.from('users').insert({ email, pass }).select('id').single()).id;

// ---------- profile ----------
const PF = { sex: 'sex', a: 'age', h: 'height', w: 'start_weight', gw: 'goal_weight',
  act: 'activity', def: 'deficit', ppk: 'protein_per_kg', na: 'sodium' };
const getProfile = async uid => {
  const r = ok(await sb.from('profiles').select('*').eq('user_id', uid).maybeSingle());
  return r && Object.fromEntries(Object.entries(PF).map(([k, c]) => [k, r[c]]));
};
async function saveProfile(uid, p) {
  const row = { user_id: uid };
  for (const [k, c] of Object.entries(PF)) row[c] = p[k];
  ok(await sb.from('profiles').upsert(row, { onConflict: 'user_id' }));
}

// ---------- weights ----------
const listWeights = async (uid, top = 60) =>
  ok(await sb.from('weights').select('day, kg').eq('user_id', uid).order('day', { ascending: false }).limit(top));
async function saveWeight(uid, day, kg) {
  ok(await sb.from('weights').upsert({ user_id: uid, day, kg }, { onConflict: 'user_id,day' }));
}

// ---------- foods (built-in foods have user_id = null) ----------
const FOOD_COLS = 'id, name, serving, kcal, protein, carbs, fat, sodium, fiber';
const toFood = r => ({ id: r.id, n: r.name, s: r.serving, k: n(r.kcal), p: n(r.protein),
  c: n(r.carbs), f: n(r.fat), na: n(r.sodium), fi: n(r.fiber) });
async function searchFoods(uid, q) {
  let query = sb.from('foods').select(FOOD_COLS).or(mine(uid));
  if (q) query = query.ilike('name', '%' + q.replace(/[\\%_]/g, '\\$&') + '%');
  return ok(await query.order('name').limit(8)).map(toFood);
}
const myFoods = async uid => ok(await sb.from('foods').select(FOOD_COLS).eq('user_id', uid).order('name')).map(toFood);
async function getFood(uid, id) {
  if (!isId(id)) return null;
  const r = ok(await sb.from('foods').select(FOOD_COLS).or(mine(uid)).eq('id', id).maybeSingle());
  return r && toFood(r);
}
const createFood = async (uid, f) => ok(await sb.from('foods').insert({ user_id: uid || null, name: f.n,
  serving: f.s, kcal: f.k, protein: f.p, carbs: f.c, fat: f.f, sodium: f.na, fiber: f.fi }).select('id').single()).id;
async function removeFood(uid, id) {
  if (isId(id)) ok(await sb.from('foods').delete().eq('id', id).eq('user_id', uid));
}
const hasBuiltInFoods = async () => ok(await sb.from('foods').select('id').is('user_id', null).limit(1)).length > 0;

// ---------- food log ----------
const toLog = r => ({ id: r.id, meal: r.meal, name: r.name, sv: r.serving, qty: n(r.qty), kcal: n(r.kcal),
  p: n(r.protein), c: n(r.carbs), f: n(r.fat), na: n(r.sodium), fi: n(r.fiber) });
const listLog = async (uid, day) =>
  ok(await sb.from('log_entries').select('*').eq('user_id', uid).eq('day', day).order('id')).map(toLog);
const addLog = async (uid, e) => ok(await sb.from('log_entries').insert({ user_id: uid, day: e.day, meal: e.meal,
  name: e.name, serving: e.sv, qty: e.qty, kcal: e.kcal, protein: e.p, carbs: e.c, fat: e.f, sodium: e.na,
  fiber: e.fi }).select('id').single()).id;
async function removeLog(uid, id) {
  if (isId(id)) ok(await sb.from('log_entries').delete().eq('id', id).eq('user_id', uid));
}

module.exports = { userByEmail, createUser, getProfile, saveProfile, listWeights, saveWeight,
  searchFoods, myFoods, getFood, createFood, removeFood, hasBuiltInFoods, listLog, addLog, removeLog };
