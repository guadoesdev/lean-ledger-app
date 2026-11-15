const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { sb, listLog } = require('./supabase');
const gem = require('./gemini');
const nut = require('./nutrition');

const THRESHOLD = Number(process.env.CONFIDENCE_THRESHOLD) || 0.7;   // below this, ask the user first
const DRAFT_SECRET = (process.env.JWT_SECRET || 'dev-only-change-me') + ':meal-draft';
const MEALS = ['Breakfast', 'Lunch', 'Dinner', 'Snacks'];
const NUT = ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'sodium'];
const ok = ({ data, error }) => { if (error) throw new Error('Supabase: ' + error.message); return data; };
const isId = s => /^\d+$/.test(String(s));
const r1 = x => Math.round(x * 10) / 10;
const sum = rows => Object.fromEntries(NUT.map(k => [k, r1(rows.reduce((a, r) => a + (r[k] || 0), 0))]));
const pub = ({ meal_id, user_id, day, meal, extra, ...rest }) => ({ ...rest, ingredients: (extra && extra.ingredients) || [] });
const typeOf = (text, image) => (image && text ? 'text+image' : image ? 'image' : 'text');
class BadInput extends Error {}

const hits = new Map();   // per-user hourly cap on AI calls
function limited(uid) {
  const now = Date.now(), a = (hits.get(uid) || []).filter(t => now - t < 36e5);
  if (a.length >= (Number(process.env.AI_HOURLY_LIMIT) || 30)) return true;
  a.push(now); hits.set(uid, a); return false;
}

// ---------- input checks ----------
function cleanItems(arr) {
  if (!Array.isArray(arr) || arr.length > 30) throw new BadInput('Send up to 30 items.');
  return arr.map(it => {
    const name = String(it.name || '').trim().slice(0, 100), grams = Number(it.grams);
    if (!name || !(grams >= 0 && grams <= 5000)) throw new BadInput('Each item needs a name and grams between 0 and 5000.');
    return { name, search_term: String(it.search_term || name).trim().slice(0, 100), ingredients: [],
      quantity: it.quantity != null && Number.isFinite(+it.quantity) ? +it.quantity : null,
      unit: it.unit ? String(it.unit).slice(0, 30) : null, grams, food_confidence: 1, portion_confidence: 1 };   // user-verified
  });
}
function parseImage(s) {
  if (s == null || s === '') return null;
  const m = /^data:(image\/(?:jpeg|png|webp));base64,/.exec(String(s).slice(0, 40));
  if (!m || s.length > 7e6) throw new BadInput('Upload a JPEG, PNG or WebP photo under about 5 MB.');
  return { mime: m[1], data: s.slice(m[0].length) };
}
function readInput(b = {}) {
  const t = new Date(b.eaten_at);
  const input = { text: String(b.text || '').trim().slice(0, 2000), clarifications: String(b.clarifications || '').trim().slice(0, 1000),
    image: parseImage(b.image), items: b.items ? cleanItems(b.items) : null, previous: b.previous ? cleanItems(b.previous) : null,
    eaten_at: isNaN(t) ? new Date().toISOString() : t.toISOString() };
  if (!input.text && !input.image && !input.items && !input.clarifications) throw new BadInput('Describe the meal or add a photo.');
  return input;
}

// ---------- nutrition lookup: government DB > manufacturer labels / approved DBs > web references > AI estimate ----------
async function resolveNutrition(items) {
  const found = items.map(() => null);
  let unavailable = false;
  const open = () => items.map((_, i) => i).filter(i => !found[i]);

  for (const tier of nut.TIERS) {
    const todo = open();
    if (!todo.length) break;
    const res = await Promise.all(todo.map(i => nut.searchTier(tier, items[i].search_term)));
    if (res.some(r => r.failed)) unavailable = true;
    const cands = res.map(r => r.cands);
    if (!cands.some(c => c.length)) continue;
    const picks = await gem.mapFoods(todo.map(i => items[i]), cands);
    todo.forEach((i, k) => {
      const p = picks[k], c = p.candidate >= 0 ? cands[k][p.candidate] : null;
      if (c && p.confidence >= THRESHOLD) found[i] = { c, conf: p.confidence, v: 'verified' };
    });
  }
  await Promise.all(open().slice(0, 6).map(async i => {            // web references need a source link to count as verified
    const w = await gem.webNutrition(items[i].search_term);
    if (w) found[i] = { c: w, conf: 0.6, v: 'verified' };
  }));
  const rest = open();
  if (rest.length) {                                                // last resort, always labeled as an estimate
    const est = await gem.estimateNutrition(rest.map(i => items[i]));
    rest.forEach((i, k) => {
      if (est[k]) found[i] = { c: { source: 'AI estimate', type: 'ai_estimate', id: null, url: null, name: items[i].name, per100g: est[k] }, conf: 0.5, v: 'ai_estimated' };
    });
  }
  const missing = open();
  if (missing.length) return { questions: missing.map(i => ({ item: i, reason: 'no_match',
    question: `I couldn't find reliable nutrition data for "${items[i].name}". Try a simpler or more common name.` })) };

  const notices = [], est = found.filter(f => f.v === 'ai_estimated').length;
  if (unavailable) notices.push('A nutrition source could not be reached, so some values came from other sources.');
  if (est) notices.push(`${est} item${est > 1 ? 's use' : ' uses'} AI-estimated values, marked "estimated". Check ${est > 1 ? 'them' : 'it'} before saving.`);
  return { notices, items: items.map((it, i) => { const { c, conf, v } = found[i];
    return { ...it, source: c.source, source_type: c.type, source_url: c.url, source_food_id: c.id, source_food_name: c.name,
      verification: v, map_confidence: conf, per100g: c.per100g, ...nut.scale(c.per100g, it.grams) }; }) };
}

// Never writes to the database. Returns needs_clarification or review.
async function pipeline(input, pre) {
  const ai = pre || (input.items ? { items: input.items } : await gem.analyzeMeal(input));
  const items = ai.items;
  if (!items.length) return { status: 'needs_clarification', items: [], questions: [
    { item: -1, reason: 'nothing_found', question: 'I could not identify any food. Describe what you ate, with rough amounts.' }] };
  const qs = [];
  items.forEach((it, i) => {
    if (it.grams <= 0) qs.push({ item: i, reason: 'portion', question: it.question || `How much ${it.name} did you have?` });
    else if (it.food_confidence < THRESHOLD || it.portion_confidence < THRESHOLD)
      qs.push({ item: i, reason: it.food_confidence < THRESHOLD ? 'food' : 'portion',
        question: it.question || `I'm not sure about "${it.name}" (about ${Math.round(it.grams)} g). Is that right?` });
  });
  if (qs.length) return { status: 'needs_clarification', items, questions: qs };   // stop before any nutrition lookup
  const r = await resolveNutrition(items);
  if (r.questions) return { status: 'needs_clarification', items, questions: r.questions };
  return { status: 'review', meal_type: ai.meal_type, items: r.items, notices: r.notices };
}

// ---------- review drafts: signed, expire after 1 hour, and can be used only once ----------
const used = new Set();
const signDraft = d => jwt.sign({ ...d, n: crypto.randomUUID() }, DRAFT_SECRET, { expiresIn: '1h' });
function readDraft(token, uid) {
  try {
    const d = jwt.verify(String(token), DRAFT_SECRET);
    if (d.uid !== uid || used.has(d.n)) throw new Error('bad');
    return d;
  } catch (e) { throw new BadInput('This review expired or was already saved. Please analyze the meal again.'); }
}
const reviewItem = ({ per100g, source_food_id, map_confidence, search_term, question, ...rest }) => rest;
const review = (r, d) => ({ status: 'review', draft: signDraft(d), meal: d.meal, meal_type: d.meal_type, replace: d.replace,
  eaten_at: d.eaten_at, items: r.items.map(reviewItem), totals: sum(r.items), notices: r.notices });

// ---------- database ----------
const itemRow = (uid, mealId, day, meal, eatenAt, it) => ({ meal_id: mealId, user_id: uid, day, meal, eaten_at: eatenAt,
  name: it.name, grams: it.grams, quantity: it.quantity, unit: it.unit, food_confidence: it.food_confidence,
  portion_confidence: it.portion_confidence, confidence: Math.min(it.food_confidence, it.portion_confidence),
  source: it.source, source_type: it.source_type, source_url: it.source_url, source_food_id: it.source_food_id,
  source_food_name: it.source_food_name, verification: it.verification,
  extra: { map_confidence: it.map_confidence, ingredients: it.ingredients || [] }, ...Object.fromEntries(NUT.map(k => [k, it[k]])) });

async function createMeal(uid, d, items) {
  const m = ok(await sb.from('meals').insert({ user_id: uid, day: d.day, meal: d.meal, input_type: d.type, input_text: d.text || null,
    eaten_at: d.eaten_at, classified_meal: d.meal_type }).select('id').single());
  try { ok(await sb.from('meal_items').insert(items.map(it => itemRow(uid, m.id, d.day, d.meal, d.eaten_at, it)))); }
  catch (e) { await sb.from('meals').delete().eq('id', m.id); throw e; }      // never leave a half-saved meal
  return m.id;
}
async function replaceItems(uid, m, meal, items) {
  const old = ok(await sb.from('meal_items').select('*').eq('meal_id', m.id));
  ok(await sb.from('meal_revisions').insert({ meal_id: m.id, user_id: uid, revision: m.revision, snapshot: { meal: m.meal, items: old } }));
  ok(await sb.from('meal_items').insert(items.map(it => itemRow(uid, m.id, m.day, meal, m.eaten_at, it))));
  ok(await sb.from('meal_items').delete().in('id', old.map(o => o.id)));
  ok(await sb.from('meals').update({ meal, revision: m.revision + 1, updated_at: new Date().toISOString() }).eq('id', m.id));
}
const getRow = async (uid, id) => isId(id) ? ok(await sb.from('meals').select('*').eq('id', id).eq('user_id', uid).maybeSingle()) : null;
const shape = (m, items) => ({ id: m.id, day: m.day, meal: m.meal, eaten_at: m.eaten_at, input_type: m.input_type, input_text: m.input_text,
  revision: m.revision, items: items.map(pub), totals: sum(items) });
async function getMeal(uid, id) {
  const m = await getRow(uid, id);
  return m && shape(m, ok(await sb.from('meal_items').select('*').eq('meal_id', id).order('id')));
}
async function listMeals(uid, day) {
  const ms = ok(await sb.from('meals').select('*').eq('user_id', uid).eq('day', day).order('id'));
  const its = ok(await sb.from('meal_items').select('*').eq('user_id', uid).eq('day', day).order('id'));
  return ms.map(m => shape(m, its.filter(i => i.meal_id === m.id)));
}
async function history(uid, from, to) {
  const ms = ok(await sb.from('meals').select('*').eq('user_id', uid).gte('day', from).lte('day', to).order('eaten_at', { ascending: false }).limit(200));
  const its = ms.length ? ok(await sb.from('meal_items').select('*').in('meal_id', ms.map(m => m.id))) : [];
  return ms.map(m => shape(m, its.filter(i => i.meal_id === m.id)));
}

// Saved AI items appear in the Today screen as log rows with ids like "m12".
async function itemsAsLog(uid, day) {
  return ok(await sb.from('meal_items').select('*').eq('user_id', uid).eq('day', day).order('id')).map(i => ({
    id: 'm' + i.id, meal: i.meal, name: i.name, sv: `${Math.round(i.grams)} g`, qty: 1,
    kcal: i.kcal, p: i.protein, c: i.carbs, f: i.fat, na: i.sodium, fi: i.fiber }));
}
async function removeItem(uid, id) {
  if (!isId(id)) return;
  const it = ok(await sb.from('meal_items').select('meal_id').eq('id', id).eq('user_id', uid).maybeSingle());
  if (!it) return;
  ok(await sb.from('meal_items').delete().eq('id', id).eq('user_id', uid));
  if (!ok(await sb.from('meal_items').select('id').eq('meal_id', it.meal_id).limit(1)).length)
    ok(await sb.from('meals').delete().eq('id', it.meal_id).eq('user_id', uid));
}

// ---------- summaries and trends ----------
const iso = d => d.toISOString().slice(0, 10);
const TREND = ['kcal', 'protein', 'carbs', 'fat', 'fiber'];
async function summary(uid, period, date, withTrend = true) {
  const d = new Date(date + 'T00:00:00Z');
  let from = new Date(d), to = new Date(d), prev = new Date(d);
  prev.setUTCDate(d.getUTCDate() - 1);
  if (period === 'week') { from.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); to = new Date(from); to.setUTCDate(from.getUTCDate() + 6); prev = new Date(from); prev.setUTCDate(from.getUTCDate() - 1); }
  if (period === 'month') { from = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); to = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)); prev = new Date(from); prev.setUTCDate(0); }
  const [a, b] = await Promise.all([
    sb.from('meal_items').select('day, kcal, protein, carbs, fat, fiber, sugar, sodium').eq('user_id', uid).gte('day', iso(from)).lte('day', iso(to)),
    sb.from('log_entries').select('day, kcal, protein, carbs, fat, fiber, sodium').eq('user_id', uid).gte('day', iso(from)).lte('day', iso(to))]);
  const rows = [...ok(a), ...ok(b)], days = {};
  for (const r of rows) (days[r.day] = days[r.day] || []).push(r);
  const list = Object.keys(days).sort().map(day => ({ day, ...sum(days[day]) }));
  const total = sum(rows), n = list.length || 1;
  const out = { period, from: iso(from), to: iso(to), days: list, total, days_logged: list.length,
    average: Object.fromEntries(NUT.map(k => [k, r1(total[k] / n)])) };
  if (withTrend) {   // percent change in daily averages versus the previous day, week or month
    const p = await summary(uid, period, iso(prev), false);
    out.trend = p.days_logged ? Object.fromEntries(TREND.map(k => [k, p.average[k] ? r1((out.average[k] - p.average[k]) / p.average[k] * 100) : null])) : null;
  }
  return out;
}

// ---------- chat helpers ----------
const byTime = h => (h < 11 ? 'Breakfast' : h < 15 ? 'Lunch' : h < 21 ? 'Dinner' : 'Snacks');
const askText = r => 'Before I log this:\n' + r.questions.map(q => q.question).join('\n');
function savedText(m, notices) {
  const srcs = [...new Set(m.items.map(i => (i.verification === 'ai_estimated' ? 'AI estimate' : i.source)))];
  return `Logged to ${m.meal}:\n` + m.items.map(i => `• ${i.name} (${Math.round(i.grams)} g): ${Math.round(i.kcal)} kcal, P ${r1(i.protein)} g, C ${r1(i.carbs)} g, F ${r1(i.fat)} g` +
    (i.verification === 'ai_estimated' ? ' (estimated)' : '')).join('\n') +
    `\nMeal total: ${Math.round(m.totals.kcal)} kcal, P ${r1(m.totals.protein)} g, C ${r1(m.totals.carbs)} g, F ${r1(m.totals.fat)} g` +
    `\nSources: ${srcs.join(', ')}` + (notices && notices.length ? '\n' + notices.join('\n') : '');
}

// Saves chat messages so the day's conversation stays visible. A failure here never blocks logging a meal.
async function say(uid, day, role, text, extra = {}) {
  try { ok(await sb.from('chat_messages').insert({ user_id: uid, day, role, text: String(text).slice(0, 4000), meal_id: extra.meal_id || null, pending: extra.pending || null })); }
  catch (e) { console.warn('Could not save chat message (did you run schema_chat.sql?):', e.message); }
}

// ---------- routes ----------
function mount(app, { h, bad, DAY }) {
  const hh = fn => h(async (req, res) => { try { await fn(req, res); } catch (e) { if (e instanceof BadInput) return bad(res, e.message); throw e; } });

  app.post('/api/meals/analyze', hh(async (req, res) => {
    const { day, meal } = req.body || {};
    if (!DAY.test(day || '') || !(meal === 'Auto' || MEALS.includes(meal))) return bad(res, 'Choose a valid day and meal.');
    const input = readInput(req.body);
    if (limited(req.uid)) return bad(res, 'AI limit reached for this hour. Try again later.', 429);
    const r = await pipeline(input);
    if (r.status !== 'review') return res.json(r);                       // nothing is saved here, ever
    const detected = MEALS.includes(r.meal_type) ? r.meal_type : null;
    res.json(review(r, { uid: req.uid, day, meal: MEALS.includes(meal) ? meal : detected || 'Snacks', meal_type: detected, replace: null,
      text: input.text, type: typeOf(input.text, input.image), eaten_at: input.eaten_at, items: r.items }));
  }));

  app.post('/api/meals/:id/reprocess', hh(async (req, res) => {
    const m = await getRow(req.uid, req.params.id);
    if (!m) return bad(res, 'Meal not found.', 404);
    const input = readInput({ ...req.body, text: (req.body || {}).text || m.input_text });
    if (limited(req.uid)) return bad(res, 'AI limit reached for this hour. Try again later.', 429);
    const r = await pipeline(input);
    if (r.status !== 'review') return res.json(r);                       // the saved meal stays unchanged
    res.json(review(r, { uid: req.uid, day: m.day, meal: m.meal, meal_type: null, replace: m.id,
      text: m.input_text, type: m.input_type, eaten_at: m.eaten_at, items: r.items }));
  }));

  // The only route that saves an AI meal. The user has reviewed the items and nutrition first.
  app.post('/api/meals/confirm', hh(async (req, res) => {
    const b = req.body || {}, d = readDraft(b.draft, req.uid);
    let items = d.items.map(it => ({ ...it }));
    for (const e of Array.isArray(b.edits) ? b.edits : []) {
      const it = items[e.i], g = Number(e.grams);
      if (!it) continue;
      if (!(g > 0 && g <= 5000)) throw new BadInput('Grams must be between 1 and 5000.');
      Object.assign(it, { grams: g, ...nut.scale(it.per100g, g) });
    }
    const rm = new Set(Array.isArray(b.remove) ? b.remove : []);
    items = items.filter((_, i) => !rm.has(i));
    if (!items.length) throw new BadInput('Keep at least one item to save.');
    const meal = MEALS.includes(b.meal) ? b.meal : d.meal;
    let id;
    if (d.replace) {
      const m = await getRow(req.uid, d.replace);
      if (!m) return bad(res, 'Meal not found.', 404);
      await replaceItems(req.uid, m, meal, items); id = m.id;
    } else id = await createMeal(req.uid, { ...d, meal }, items);
    used.add(d.n);
    res.json({ status: 'saved', meal: await getMeal(req.uid, id) });
  }));

  // Conversational logging: analyzes the message and saves automatically when confident, otherwise asks a follow-up question.
  app.post('/api/chat', hh(async (req, res) => {
    const b = req.body || {};
    if (!DAY.test(b.day || '')) return bad(res, 'Choose a valid day.');
    const message = String(b.text || '').trim().slice(0, 2000), image = parseImage(b.image);
    if (!message && !image) throw new BadInput('Type a message or add a photo.');
    const t = new Date(b.eaten_at), eaten_at = isNaN(t) ? new Date().toISOString() : t.toISOString();
    const hour = Number.isInteger(b.hour) && b.hour >= 0 && b.hour < 24 ? b.hour : new Date().getUTCHours();
    const pending = b.pending && typeof b.pending === 'object' ? b.pending : null;

    let replace = null, base;
    if (pending) {                                   // the user is answering my last question
      replace = pending.replace || null;
      base = { text: String(pending.text || '').slice(0, 2000), clarifications: message, previous: pending.items ? cleanItems(pending.items) : null, image };
    } else if (b.replace) {                          // the user is correcting an earlier meal
      const m = await getRow(req.uid, b.replace);
      if (!m) return bad(res, 'Meal not found.', 404);
      replace = m.id;
      const cur = ok(await sb.from('meal_items').select('name, grams, quantity, unit').eq('meal_id', m.id));
      base = { text: m.input_text || '', clarifications: message, previous: cleanItems(cur), image: null };
    } else base = { text: message, clarifications: '', previous: null, image };
    if (replace && !(await getRow(req.uid, replace))) return bad(res, 'Meal not found.', 404);
    if (limited(req.uid)) return bad(res, 'AI limit reached for this hour. Try again later.', 429);

    await say(req.uid, b.day, 'user', message || '(photo)');
    const out = async (payload, extra = {}) => { await say(req.uid, b.day, 'bot', payload.reply, extra); res.json(payload); };
    const rows = [...(await listLog(req.uid, b.day)), ...(await itemsAsLog(req.uid, b.day))];
    const tot = k => r1(rows.reduce((a, x) => a + (x[k] || 0), 0));
    const ai = await gem.analyzeMeal({ ...base, context: `${tot('kcal')} kcal, protein ${tot('p')} g, carbs ${tot('c')} g, fat ${tot('f')} g` });
    if (!ai.is_meal && !pending && !replace) return out({ status: 'chat', reply: ai.reply || 'Tell me what you ate and I will log it for you.' });
    if (pending || replace) ai.items.forEach(i => { if (i.grams > 0) { i.food_confidence = 1; i.portion_confidence = 1; } });   // the user just answered, so treat as confirmed

    const r = await pipeline({ items: null }, ai);
    if (r.status !== 'review') {   // nothing saved yet
      const pend = { text: base.text, items: r.items, replace };
      return out({ status: 'ask', reply: askText(r), pending: pend }, { pending: pend });
    }

    const detected = MEALS.includes(ai.meal_type) ? ai.meal_type : null;
    let id;
    if (replace) { const m = await getRow(req.uid, replace); await replaceItems(req.uid, m, m.meal, r.items); id = m.id; }
    else id = await createMeal(req.uid, { day: b.day, meal: detected || byTime(hour), meal_type: detected, text: base.text,
      type: typeOf(base.text, image), eaten_at }, r.items);
    const saved = await getMeal(req.uid, id);
    await out({ status: 'saved', reply: savedText(saved, r.notices), meal: saved }, { meal_id: saved.id });
  }));

  app.get('/api/chat/history', hh(async (req, res) => {
    if (!DAY.test(req.query.day || '')) return bad(res, 'Invalid date.');
    const ms = ok(await sb.from('chat_messages').select('*').eq('user_id', req.uid).eq('day', req.query.day).order('id').limit(300));
    const ids = [...new Set(ms.map(m => m.meal_id).filter(Boolean))];
    const alive = new Set(ids.length ? ok(await sb.from('meals').select('id').in('id', ids)).map(m => m.id) : []);
    res.json(ms.map(m => ({ role: m.role, text: m.text, meal_id: m.meal_id, pending: m.pending, undone: !!m.meal_id && !alive.has(m.meal_id) })));
  }));
  app.post('/api/chat/cancel', hh(async (req, res) => {
    const day = (req.body || {}).day;
    if (!DAY.test(day || '')) return bad(res, 'Invalid date.');
    try { ok(await sb.from('chat_messages').update({ pending: null }).eq('user_id', req.uid).eq('day', day).not('pending', 'is', null)); } catch (e) {}
    await say(req.uid, day, 'bot', 'Okay, nothing was logged.');
    res.json({ ok: true });
  }));

  app.get('/api/meals/history', hh(async (req, res) => {
    const to = DAY.test(req.query.to || '') ? req.query.to : iso(new Date());
    const from = DAY.test(req.query.from || '') ? req.query.from : iso(new Date(Date.now() - 29 * 864e5));
    res.json(await history(req.uid, from, to));
  }));
  app.get('/api/meals', hh(async (req, res) => {
    if (!DAY.test(req.query.day || '')) return bad(res, 'Invalid date.');
    res.json(await listMeals(req.uid, req.query.day));
  }));
  app.get('/api/meals/:id', hh(async (req, res) => {
    const m = await getMeal(req.uid, req.params.id);
    m ? res.json(m) : bad(res, 'Meal not found.', 404);
  }));
  app.delete('/api/meals/:id', hh(async (req, res) => {
    if (isId(req.params.id)) ok(await sb.from('meals').delete().eq('id', req.params.id).eq('user_id', req.uid));
    res.json({ ok: true });
  }));
  app.get('/api/summary', hh(async (req, res) => {
    const { period, date } = req.query;
    if (!['day', 'week', 'month'].includes(period) || !DAY.test(date || '')) return bad(res, 'Use period=day|week|month and date=YYYY-MM-DD.');
    res.json(await summary(req.uid, period, date));
  }));
}

module.exports = { mount, itemsAsLog, removeItem };
