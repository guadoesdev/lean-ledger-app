const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const dv = require('./supabase');

const SECRET = process.env.JWT_SECRET || 'dev-only-change-me';
if (!process.env.JWT_SECRET) console.warn('Warning: set JWT_SECRET before deploying.');

const app = express();
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const MEALS = ['Breakfast', 'Lunch', 'Dinner', 'Snacks'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const num = (v, min = 0, max = 1e6) => typeof v === 'number' && isFinite(v) && v >= min && v <= max;
const r1 = x => Math.round(x * 10) / 10;
const sign = id => jwt.sign({ id }, SECRET, { expiresIn: '30d' });
// Express 4 does not catch async errors, so every handler goes through h().
const h = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
  console.error(e); bad(res, 'Something went wrong on the server. Try again.', 500);
});

// ---------- auth ----------
function credentials(req, res) {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const password = String((req.body || {}).password || '');
  if (!/^\S+@\S+\.\S+$/.test(email)) return bad(res, 'Enter a valid email address.');
  if (password.length < 8) return bad(res, 'Use a password with at least 8 characters.');
  return { email, password };
}
app.post('/api/register', h(async (req, res) => {
  const c = credentials(req, res); if (!c.email) return;
  if (await dv.userByEmail(c.email)) return bad(res, 'That email is already registered.', 409);
  res.json({ token: sign(await dv.createUser(c.email, bcrypt.hashSync(c.password, 10))) });
}));
app.post('/api/login', h(async (req, res) => {
  const c = credentials(req, res); if (!c.email) return;
  const u = await dv.userByEmail(c.email);
  if (!u || !bcrypt.compareSync(c.password, u.pass)) return bad(res, 'Email or password is incorrect.', 401);
  res.json({ token: sign(u.id) });
}));
app.use('/api', (req, res, next) => {
  if (req.path === '/login' || req.path === '/register') return next();
  try { req.uid = jwt.verify((req.headers.authorization || '').slice(7), SECRET).id; next(); }
  catch (e) { bad(res, 'Please log in again.', 401); }
});

// ---------- profile and targets ----------
app.get('/api/profile', h(async (req, res) => res.json(await dv.getProfile(req.uid))));

app.put('/api/profile', h(async (req, res) => {
  const b = req.body || {};
  if (!['m', 'f'].includes(b.sex) || !num(b.a, 10, 110) || !num(b.h, 100, 250) || !num(b.w, 30, 400) ||
      !num(b.gw, 30, 400) || !num(b.act, 1.2, 2) || !num(b.def, 0, 2000) || !num(b.ppk, 0.5, 4) || !num(b.na, 500, 6000))
    return bad(res, 'Check your numbers. One of the values is out of range.');
  await dv.saveProfile(req.uid, b);
  res.json(await dv.getProfile(req.uid));
}));

app.get('/api/targets', h(async (req, res) => {
  const p = await dv.getProfile(req.uid);
  if (!p) return res.json(null);
  const lw = (await dv.listWeights(req.uid, 1))[0];
  const w = lw ? lw.kg : p.w;
  const bmr = 10 * w + 6.25 * p.h - 5 * p.a + (p.sex === 'm' ? 5 : -161);
  const tdee = bmr * p.act;
  const k = Math.round(tdee - p.def), pr = Math.round(w * p.ppk), f = Math.round(k * 0.25 / 9);
  res.json({
    bmr: Math.round(bmr), tdee: Math.round(tdee), k, p: pr, f,
    c: Math.max(0, Math.round((k - pr * 4 - f * 9) / 4)), na: p.na,
    pct: p.def * 7 / 7700 / w * 100
  });
}));

// ---------- foods ----------
app.get('/api/foods', h(async (req, res) => res.json(await dv.searchFoods(req.uid, String(req.query.q || '').trim()))));
app.get('/api/foods/mine', h(async (req, res) => res.json(await dv.myFoods(req.uid))));

app.post('/api/foods', h(async (req, res) => {
  const b = req.body || {};
  const name = String(b.n || '').trim(), s = String(b.s || '1 serving').trim();
  if (!name || name.length > 80 || s.length > 40) return bad(res, 'Add a name under 80 characters.');
  if (![b.k, b.p, b.c, b.f, b.na, b.fi].every(x => num(x, 0, 10000))) return bad(res, 'Nutrient values must be numbers of zero or more.');
  res.json({ id: await dv.createFood(req.uid, { n: name, s, k: b.k, p: b.p, c: b.c, f: b.f, na: b.na, fi: b.fi }) });
}));
app.delete('/api/foods/:id', h(async (req, res) => { await dv.removeFood(req.uid, req.params.id); res.json({ ok: true }); }));

// ---------- food log ----------
app.get('/api/log', h(async (req, res) => {
  if (!DAY.test(req.query.day || '')) return bad(res, 'Invalid date.');
  res.json(await dv.listLog(req.uid, req.query.day));
}));
app.post('/api/log', h(async (req, res) => {
  const { day, meal, foodId, qty } = req.body || {};
  if (!DAY.test(day || '') || !MEALS.includes(meal) || !num(qty, 0.1, 100)) return bad(res, 'Invalid entry.');
  const f = await dv.getFood(req.uid, foodId);
  if (!f) return bad(res, 'Food not found.', 404);
  const id = await dv.addLog(req.uid, { day, meal, name: f.n, sv: f.s, qty,
    kcal: r1(f.k * qty), p: r1(f.p * qty), c: r1(f.c * qty), f: r1(f.f * qty), na: r1(f.na * qty), fi: r1(f.fi * qty) });
  res.json({ id });
}));
app.delete('/api/log/:id', h(async (req, res) => { await dv.removeLog(req.uid, req.params.id); res.json({ ok: true }); }));

// ---------- weights ----------
app.get('/api/weights', h(async (req, res) => res.json(await dv.listWeights(req.uid))));
app.put('/api/weights/:day', h(async (req, res) => {
  const kg = (req.body || {}).kg;
  if (!DAY.test(req.params.day) || !num(kg, 30, 400)) return bad(res, 'Enter a weight between 30 and 400 kg.');
  await dv.saveWeight(req.uid, req.params.day, kg);
  res.json({ ok: true });
}));

app.use('/api', (req, res) => bad(res, 'Not found.', 404));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Lean Ledger running on http://localhost:' + PORT));
