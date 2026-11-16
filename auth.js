const { sb } = require('./supabase');

// Sign-in happens in the browser with Supabase Auth (email, Google, GitHub). This file only checks the Supabase
// access token on each request and maps it to our own users.id, so the rest of the app keeps using req.uid.
const known = new Map();      // Supabase user id -> { id, until }
const inflight = new Map();   // Supabase user id -> promise, so parallel first requests create only one row
const KEEP_MS = 10 * 60 * 1000;
const ok = ({ data, error }) => { if (error) throw new Error('Supabase: ' + error.message); return data; };
const deny = res => res.status(401).json({ error: 'Please log in again.' });

// Finds our own user row for a Supabase Auth user. The first time, it creates the row, or links an older
// email-and-password account when Supabase has verified that the user owns that email address.
async function findOrCreate(authId) {
  const row = ok(await sb.from('users').select('id').eq('auth_id', authId).maybeSingle());
  if (row) return row.id;
  const { data, error } = await sb.auth.admin.getUserById(authId);
  if (error || !data || !data.user) throw new Error('Supabase: could not load the signed-in user');
  const u = data.user, email = String(u.email || '').trim().toLowerCase();
  const verified = !!(u.email_confirmed_at || u.confirmed_at);
  const same = email ? ok(await sb.from('users').select('id, auth_id').eq('email', email).maybeSingle()) : null;
  if (same && !same.auth_id && verified) {            // an older account: keep its data
    ok(await sb.from('users').update({ auth_id: authId }).eq('id', same.id));
    return same.id;
  }
  const mail = email && !same ? email : `${authId}@placeholder.invalid`;   // email is unique; never take over an unverified claim
  try { return ok(await sb.from('users').insert({ auth_id: authId, email: mail }).select('id').single()).id; }
  catch (e) {                                          // lost a race with another request: use the row that won
    const again = ok(await sb.from('users').select('id').eq('auth_id', authId).maybeSingle());
    if (again) return again.id;
    throw e;
  }
}
function appUserId(authId) {
  const hit = known.get(authId);
  if (hit && hit.until > Date.now()) return Promise.resolve(hit.id);
  if (!inflight.has(authId)) inflight.set(authId, findOrCreate(authId)
    .then(id => { known.set(authId, { id, until: Date.now() + KEEP_MS }); return id; })
    .finally(() => inflight.delete(authId)));
  return inflight.get(authId);
}

async function authenticate(req, res, next) {
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
  if (!m) return deny(res);
  let claims = null;
  try {
    const { data, error } = await sb.auth.getClaims(m[1]);   // checks signature and expiry (locally when the project uses signing keys)
    claims = !error && data && data.claims;
  } catch (e) { claims = null; }
  if (!claims || claims.role !== 'authenticated' || !claims.sub || claims.is_anonymous) return deny(res);
  try { req.uid = await appUserId(claims.sub); }
  catch (e) { console.error('Could not load the user:', e.message); return res.status(500).json({ error: 'Could not load your account. Try again.' }); }
  next();
}

module.exports = { authenticate, appUserId };
