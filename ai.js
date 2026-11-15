// Loaded after the main script in index.html, so it can use $, esc, r1, api, fail, date, S, render.
const A = { img: null, msgs: [], pending: null, replace: null };
const SUM = { period: 'week' };
const c = (v, f = Math.round) => `<td align="center">${f(v)}</td>`;
const wrap = rows => `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:14px">${rows}</table></div>`;

// ---------- chat on the Today tab ----------
function chatHtml() {
  if (!A.msgs.length) return `<p class="mute">Tell me what you ate and I will log it for you. For example: "I ate 2 scrambled eggs, 1 slice of wheat bread, and a banana for breakfast." You can also send a photo.</p>`;
  return A.msgs.map((m, i) => {
    const me = m.role === 'user';
    const actions = m.mealId && !m.undone ? `<div style="margin-top:6px;display:flex;gap:6px"><button class="btn ghost" onclick="chatUndo(${m.mealId})">Undo</button><button class="btn ghost" onclick="chatFix(${m.mealId})">Correct</button></div>`
      : m.undone ? '<div class="mute">Undone</div>'
      : m.ask && A.pending && i === A.msgs.length - 1 ? '<div style="margin-top:6px"><button class="btn ghost" onclick="chatCancel()">Cancel, don\'t log this</button></div>' : '';
    return `<div style="display:flex;justify-content:${me ? 'flex-end' : 'flex-start'};margin:6px 0"><div style="max-width:88%;padding:8px 12px;border-radius:12px;white-space:pre-wrap;` +
      `background:${me ? 'var(--pro)' : '#fff'};color:${me ? '#fff' : 'var(--ink)'};border:1px solid ${me ? 'var(--pro)' : 'var(--line)'}${m.err ? ';color:var(--warn)' : ''}">${esc(m.text)}${actions}</div></div>`;
  }).join('');
}
function chatPanel() {
  return `<h2>Log a meal</h2><div class="card"><div id="chat" style="max-height:340px;overflow-y:auto" aria-live="polite">${chatHtml()}</div>
    <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><input id="cin" placeholder="What did you eat?" style="flex:1;min-width:180px" onkeydown="if(event.key==='Enter')chatSend()" aria-label="Describe your meal">
    <label class="btn ghost" style="cursor:pointer;display:inline-block">Photo<input type="file" id="caf" accept="image/*" hidden onchange="pickImg(this)"></label>
    <button class="btn" id="cbtn" onclick="chatSend()">Send</button></div><span id="aimg" class="mute"></span></div>`;
}
const renderChat = () => { const b = $('#chat'); if (b) { b.innerHTML = chatHtml(); scrollChat(); } };
function scrollChat() { const b = $('#chat'); if (b) b.scrollTop = b.scrollHeight; }

function pickImg(inp) {
  const f = inp.files[0]; A.img = null; $('#aimg').textContent = '';
  if (!f) return;
  const im = new Image();
  im.onload = () => {
    const s = Math.min(1, 1280 / Math.max(im.width, im.height)), cv = document.createElement('canvas');
    cv.width = Math.round(im.width * s); cv.height = Math.round(im.height * s);
    cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height);
    A.img = cv.toDataURL('image/jpeg', 0.8); $('#aimg').textContent = 'Photo ready. Press Send.'; URL.revokeObjectURL(im.src);
  };
  im.onerror = () => fail({ message: 'That image could not be read.' });
  im.src = URL.createObjectURL(f);
}

async function chatSend() {
  const inp = $('#cin'), text = inp.value.trim();
  if (!text && !A.img) return;
  const now = new Date(), eaten = new Date(`${date}T${now.toTimeString().slice(0, 5)}:00`).toISOString();   // selected day, current time
  const body = { day: date, text, image: A.img, eaten_at: eaten, hour: now.getHours(), pending: A.pending, replace: A.replace };
  A.msgs.push({ role: 'user', text: text || '(photo)' }, { role: 'bot', text: 'Working on it...', tmp: true });
  inp.value = ''; A.img = null; $('#aimg').textContent = ''; $('#caf').value = ''; $('#cbtn').disabled = true; fail(); renderChat();
  try {
    const r = await api('/chat', { method: 'POST', body });
    A.msgs.pop(); A.replace = null;
    if (r.status === 'ask') { A.pending = r.pending; A.msgs.push({ role: 'bot', text: r.reply, ask: true }); }
    else {
      A.pending = null;
      A.msgs.push({ role: 'bot', text: r.reply, mealId: r.status === 'saved' ? r.meal.id : null });
      if (r.status === 'saved') { S.log = await api('/log?day=' + date); render(); return; }   // daily totals and meal list update at once
    }
  } catch (e) { A.msgs.pop(); A.msgs.push({ role: 'bot', text: (e && e.message) || 'Something went wrong. Try again.', err: true }); }
  const b = $('#cbtn'); if (b) b.disabled = false;
  renderChat();
}
async function chatUndo(id) {
  try {
    await api('/meals/' + id, { method: 'DELETE' });
    A.msgs.forEach(m => { if (m.mealId === id) m.undone = true; });
    S.log = await api('/log?day=' + date); render();
  } catch (e) { fail(e); }
}
function chatFix(id) {
  A.replace = id; A.pending = null;
  A.msgs.push({ role: 'bot', text: 'What should I change about that meal?' }); renderChat(); $('#cin').focus();
}
function chatCancel() { A.pending = null; A.replace = null; A.msgs.push({ role: 'bot', text: 'Okay, nothing was logged.' }); renderChat(); }

// ---------- summary tab: day, week and month totals, trends and history ----------
function viewSummary() {
  setTimeout(loadSum, 0);
  return `<div class="card"><div style="display:flex;gap:8px">${['day', 'week', 'month'].map(p =>
    `<button class="btn ${SUM.period === p ? '' : 'ghost'}" onclick="SUM.period='${p}';render()">${p[0].toUpperCase() + p.slice(1)}</button>`).join('')}</div>
    <p class="mute">Based on the date selected at the top. Includes manual and AI-logged food.</p></div><div id="sumres"></div>`;
}
async function loadSum() {
  const b = $('#sumres'); if (!b) return;
  try {
    const r = await api(`/summary?period=${SUM.period}&date=${date}`);
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
    $('#histres').innerHTML = '<h2>Meal history</h2>' + (ms.length ? ms.map(m => `<div class="card"><div class="row"><strong>${esc(m.meal)}</strong>
      <span class="mute">${new Date(m.eaten_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></div>
      <span class="mute">${esc(m.items.map(i => i.name).join(', '))} · ${Math.round(m.totals.kcal)} kcal${m.items.some(i => i.verification === 'ai_estimated') ? ' · includes AI estimates' : ''}</span></div>`).join('')
      : '<p class="mute">No AI-analyzed meals in this period.</p>');
  } catch (e) { if (e) fail(e); }
}
