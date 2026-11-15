// Loaded after the main script in index.html, so it can use $, esc, r1, api, fail, date, S, MEALS, render.
const A = { img: null, res: null, path: '/meals/analyze', base: {} };
const SUM = { period: 'week' };
let aiMeal = 'Auto';
const box = 'width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:6px;font:inherit;background:#fff';
const sure = i => Math.round(Math.min(i.food_confidence, i.portion_confidence) * 100);
const c = (v, f = Math.round) => `<td align="center">${f(v)}</td>`;
const hdr = '<tr><th align="left">Item</th><th>g</th><th>kcal</th><th>P</th><th>C</th><th>F</th></tr>';
const src = i => /^https?:\/\//.test(i.source_url || '') ? `<a href="${esc(i.source_url)}" target="_blank" rel="noopener">${esc(i.source)}</a>` : esc(i.source);
const badge = i => i.verification === 'ai_estimated' ? '<span class="warn">AI estimate, not verified</span>'
  : `<span style="color:var(--pro)">Verified</span> · ${src(i)}`;
const detail = i => `${badge(i)} · ${esc(i.source_food_name || '')} · ${sure(i)}% sure` +
  (i.ingredients && i.ingredients.length ? `<br>Ingredients: ${esc(i.ingredients.join(', '))}` : '');
const totalRow = t => `<tr style="border-top:2px solid var(--ink)"><td><strong>Total</strong></td><td></td>${c(t.kcal)}${c(t.protein, r1)}${c(t.carbs, r1)}${c(t.fat, r1)}</tr>`;
const extras = t => `<p class="mute">Fiber ${r1(t.fiber)} g · Sugar ${r1(t.sugar)} g · Sodium ${Math.round(t.sodium)} mg</p>`;
const wrap = rows => `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:14px">${rows}</table></div>`;

function savedTable(items, t) {
  return wrap(hdr + items.map(i => `<tr style="border-top:1px solid var(--line)"><td>${esc(i.name)}<br><span class="mute">${detail(i)}</span></td>
    ${c(i.grams)}${c(i.kcal)}${c(i.protein, r1)}${c(i.carbs, r1)}${c(i.fat, r1)}</tr>`).join('') + totalRow(t)) + extras(t);
}

function viewAI() {
  setTimeout(loadAIList, 0);
  return `<div class="card"><label>Describe your meal
    <textarea id="at" rows="3" style="${box}" placeholder="e.g. 2 scrambled eggs, a slice of toast and a latte"></textarea></label>
    <p><label>Or add a photo<input type="file" id="af" accept="image/*" onchange="pickImg(this)"></label><span id="aimg" class="mute"></span></p>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><select onchange="aiMeal=this.value" aria-label="Meal">
    ${['Auto', ...MEALS].map(m => `<option value="${m}" ${m === aiMeal ? 'selected' : ''}>${m === 'Auto' ? 'Auto-detect meal' : m}</option>`).join('')}</select>
    <button class="btn" id="abtn" onclick="aiAnalyze()">Analyze meal</button></div>
    <p class="mute">You will review everything before anything is saved.</p></div>
    <div id="ares"></div><h2>AI meals on this day</h2><div id="alist"></div>`;
}

function pickImg(inp) {
  const f = inp.files[0]; A.img = null; $('#aimg').textContent = '';
  if (!f) return;
  const im = new Image();
  im.onload = () => {
    const s = Math.min(1, 1280 / Math.max(im.width, im.height)), cv = document.createElement('canvas');
    cv.width = Math.round(im.width * s); cv.height = Math.round(im.height * s);
    cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height);
    A.img = cv.toDataURL('image/jpeg', 0.8); $('#aimg').textContent = ' Photo ready'; URL.revokeObjectURL(im.src);
  };
  im.onerror = () => fail({ message: 'That image could not be read.' });
  im.src = URL.createObjectURL(f);
}

async function aiAnalyze(extra = {}, path = '/meals/analyze', base = {}) {
  const btn = $('#abtn'); if (btn) btn.disabled = true;
  fail(); A.path = path; A.base = base;
  const eaten = new Date(`${date}T${new Date().toTimeString().slice(0, 5)}:00`).toISOString();   // selected day, current time
  try {
    A.res = await api(path, { method: 'POST', body: { day: date, meal: aiMeal, text: $('#at') ? $('#at').value : '', image: A.img, eaten_at: eaten, ...base, ...extra } });
    showAI();
  } catch (e) { fail(e); }
  if (btn) btn.disabled = false;
}

function showAI() {
  const r = A.res, b = $('#ares'); if (!b) return;
  if (r.status === 'saved') {
    b.innerHTML = `<div class="card"><strong>Saved to ${esc(r.meal.meal)}</strong>${savedTable(r.meal.items, r.meal.totals)}</div>`; return;
  }
  if (r.status === 'review') {
    b.innerHTML = `<div class="card"><strong>Review before saving</strong>
      <p class="mute">Nothing is saved until you confirm. Change grams or tick Remove if something is wrong.${r.replace ? ' Saving will replace the earlier version of this meal.' : ''}</p>
      ${(r.notices || []).map(n => `<p class="warn">${esc(n)}</p>`).join('')}
      ${r.items.map((it, i) => `<div class="res" style="align-items:flex-start"><span style="flex:1">${esc(it.name)}<br><span class="mute">${detail(it)}</span>
        <br><span class="mute">${Math.round(it.kcal)} kcal · P ${r1(it.protein)} · C ${r1(it.carbs)} · F ${r1(it.fat)}</span></span>
        <span><input type="number" id="rg${i}" value="${it.grams}" min="1" step="any" aria-label="Grams"> g<br>
        <label style="flex-direction:row;align-items:center"><input type="checkbox" id="rr${i}"> Remove</label></span></div>`).join('')}
      <p class="mute">Totals before edits: ${Math.round(r.totals.kcal)} kcal · P ${r1(r.totals.protein)} · C ${r1(r.totals.carbs)} · F ${r1(r.totals.fat)}</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><select id="rmeal" aria-label="Meal">${MEALS.map(m => `<option ${m === r.meal ? 'selected' : ''}>${m}</option>`).join('')}</select>
      <button class="btn" onclick="aiSave()">Confirm and save</button><button class="btn ghost" onclick="A.res=null;$('#ares').innerHTML=''">Cancel</button></div></div>`;
    return;
  }
  b.innerHTML = `<div class="card"><strong>I need a bit more detail first</strong>
    <p class="mute">Nothing has been saved or looked up yet.</p>${r.questions.map(q => `<p>${esc(q.question)}</p>`).join('')}
    ${r.items.map((it, i) => `<div class="res"><input id="ain${i}" value="${esc(it.name)}" style="flex:1" aria-label="Food">
      <span><input type="number" id="aig${i}" value="${Math.round(it.grams) || ''}" min="1" aria-label="Grams"> g <span class="mute">${sure(it)}% sure</span></span></div>`).join('')}
    <label style="margin-top:10px">Extra details (optional)<input id="aclar" style="${box}" placeholder="e.g. large bowl, whole milk"></label>
    <p><button class="btn" onclick="aiAgain()">Re-analyze with my answers</button>
    <button class="btn ghost" onclick="aiContinue()">Continue with my edited items</button></p></div>`;
}
const aiItems = () => A.res.items.map((it, i) => ({ name: $('#ain' + i).value, search_term: $('#ain' + i).value,
  grams: parseFloat($('#aig' + i).value) || 0, quantity: it.quantity, unit: it.unit }));
function aiAgain() { aiAnalyze({ clarifications: $('#aclar').value, previous: aiItems() }, A.path, A.base); }
function aiContinue() {
  if (!A.res.items.length) return fail({ message: 'Add details and choose Re-analyze first.' });
  aiAnalyze({ items: aiItems() }, A.path, A.base);
}

async function aiSave() {
  const r = A.res, edits = [], remove = [];
  r.items.forEach((it, i) => {
    if ($('#rr' + i).checked) return remove.push(i);
    const g = parseFloat($('#rg' + i).value);
    if (g !== it.grams) edits.push({ i, grams: g });
  });
  try {
    A.res = await api('/meals/confirm', { method: 'POST', body: { draft: r.draft, edits, remove, meal: $('#rmeal').value } });
    showAI(); S.log = await api('/log?day=' + date); loadAIList();     // keeps Today totals current
  } catch (e) { fail(e); }
}

async function loadAIList() {
  const l = $('#alist'); if (!l) return;
  try {
    const ms = await api('/meals?day=' + date);
    l.innerHTML = ms.length ? ms.map(m => `<div class="card"><div class="row"><strong>${esc(m.meal)}</strong>
      <span class="mute">${new Date(m.eaten_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · version ${m.revision}</span></div>
      ${m.input_text ? `<p class="mute">You entered: ${esc(m.input_text)}</p>` : ''}${savedTable(m.items, m.totals)}
      <div style="display:flex;gap:8px;flex-wrap:wrap"><input id="cor${m.id}" style="${box};flex:1;min-width:180px" placeholder="What should change? e.g. the rice was 200 g">
      <button class="btn ghost" onclick="aiCorrect(${m.id})">Correct</button><button class="btn ghost" onclick="aiDelete(${m.id})">Delete</button></div></div>`).join('')
      : '<p class="mute">Nothing analyzed for this day yet.</p>';
  } catch (e) { if (e) fail(e); }
}
function aiCorrect(id) {
  const t = $('#cor' + id).value.trim();
  if (!t) return fail({ message: 'Describe what should change.' });
  aiAnalyze({ clarifications: t }, `/meals/${id}/reprocess`, { text: '', image: null });   // goes through review again before saving
}
async function aiDelete(id) {
  if (!confirm('Delete this meal?')) return;
  try { await api('/meals/' + id, { method: 'DELETE' }); S.log = await api('/log?day=' + date); loadAIList(); } catch (e) { fail(e); }
}

function viewSummary() {
  setTimeout(loadSum, 0);
  return `<div class="card"><div style="display:flex;gap:8px">${['day', 'week', 'month'].map(p =>
    `<button class="btn ${SUM.period === p ? '' : 'ghost'}" onclick="SUM.period='${p}';render()">${p[0].toUpperCase() + p.slice(1)}</button>`).join('')}</div>
    <p class="mute">Based on the date selected at the top. Includes manual and AI-logged food.</p></div><div id="sumres"></div>`;
}
async function loadSum() {
  const b = $('#sumres'); if (!b) return;
  try {
    const [r, hist] = await Promise.all([api(`/summary?period=${SUM.period}&date=${date}`), null]);
    const row = (l, t, s = '') => `<tr style="${s}"><td>${l}</td>${c(t.kcal)}${c(t.protein, r1)}${c(t.carbs, r1)}${c(t.fat, r1)}${c(t.fiber, r1)}</tr>`;
    const tr = r.trend ? ['kcal', 'protein', 'carbs', 'fat', 'fiber'].filter(k => r.trend[k] != null)
      .map(k => `${k === 'kcal' ? 'Calories' : k[0].toUpperCase() + k.slice(1)} ${r.trend[k] >= 0 ? '+' : ''}${r.trend[k]}%`).join(' · ') : '';
    b.innerHTML = `<div class="card"><strong>${r.from}${r.to !== r.from ? ' to ' + r.to : ''}</strong>
      ${wrap('<tr><th align="left">Day</th><th>kcal</th><th>P</th><th>C</th><th>F</th><th>Fiber</th></tr>' +
      (r.days.map(d => row(d.day, d, 'border-top:1px solid var(--line)')).join('') || '<tr><td colspan="6" class="mute">No food logged in this period.</td></tr>') +
      (r.days_logged > 1 ? row('<strong>Total</strong>', r.total, 'border-top:2px solid var(--ink)') : '') +
      (r.days_logged ? row('<strong>Daily average</strong>', r.average) : ''))}
      ${tr ? `<p class="mute">Daily averages versus the previous ${r.period}: ${tr}</p>` : ''}</div><div id="histres"></div>`;
    const ms = await api(`/meals/history?from=${r.from}&to=${r.to}`);
    $('#histres').innerHTML = `<h2>Meal history</h2>` + (ms.length ? ms.map(m => `<div class="card"><div class="row"><strong>${esc(m.meal)}</strong>
      <span class="mute">${new Date(m.eaten_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></div>
      <span class="mute">${esc(m.items.map(i => i.name).join(', '))} · ${Math.round(m.totals.kcal)} kcal${m.items.some(i => i.verification === 'ai_estimated') ? ' · includes AI estimates' : ''}</span></div>`).join('')
      : '<p class="mute">No AI-analyzed meals in this period.</p>');
  } catch (e) { if (e) fail(e); }
}
