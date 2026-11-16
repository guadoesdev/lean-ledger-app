# Lean Ledger on Supabase

## 1. Create the project and tables
1. Create a project at supabase.com and wait for it to finish setting up.
2. Open **SQL Editor > New query**, paste the contents of `schema.sql`, and run it. This creates the five tables and turns on row level security so the public anon key cannot read them.

## 2. Get your keys
In **Project Settings > API**, copy:
- **Project URL** into `SUPABASE_URL`
- The **service_role** key into `SUPABASE_SERVICE_ROLE_KEY`

The service role key bypasses row level security. It belongs only in the server's `.env` file. Never put it in `public/index.html` or any code the browser loads.

## 3. Run it
Requires Node.js 20.6 or newer.

```
cp .env.example .env      # fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, JWT_SECRET
npm install
npm run seed              # one time: loads the built-in foods
npm start
```

Open http://localhost:3000 and create an account.

## Notes
- Users never talk to Supabase directly. Only the server does, and every query filters by `user_id`, which keeps one user's data private from another's. Do not remove those filters.
- Sign-in is handled by Supabase Auth (see the next section). The server checks the Supabase token on every request and maps it to its own `users` row.
- Before going live: HTTPS, a strong `JWT_SECRET`, login rate limiting, and keeping `.env` out of source control.

## Sign-in with Supabase Auth (email, Google, GitHub)
Users sign in in the browser with Supabase Auth. The server never sees passwords: it only verifies the Supabase access token (`auth.js`).

1. In Supabase's SQL Editor, run `schema_auth.sql`.
2. **Authentication > URL Configuration:** set **Site URL** to your Render address (for example `https://lean-ledger-app.onrender.com`) and add it, plus `http://localhost:3000`, under **Redirect URLs**.
3. **Authentication > Sign In / Providers:**
   - **Email:** keep it on. Leave "Confirm email" on, so an address is proven before it can be linked to older data.
   - **Google:** create an OAuth client in Google Cloud Console and paste its client ID and secret into Supabase. Add Supabase's callback URL (shown on that page, `https://<project-ref>.supabase.co/auth/v1/callback`) as an authorized redirect URI in Google.
   - **GitHub:** create an OAuth app in GitHub (Settings > Developer settings), use the same Supabase callback URL, and paste the client ID and secret into Supabase.
4. Leave **Allow anonymous sign-ins** off.
5. Copy the **publishable** key (or the legacy anon key) from **Project Settings > API Keys** into `SUPABASE_PUBLISHABLE_KEY`, in `.env` and in Render's environment variables. This key is meant to be public. Never put the service role key in the browser.

**Existing accounts:** passwords were not moved to Supabase. A person with an older account signs in with the same email through Google or GitHub, or uses **Create account** with that email and confirms it. Because Supabase has then verified the address, the older data is linked to the new sign-in. Unverified addresses are never linked.

Supabase also offers an "OAuth 2.1 Server" (beta) that lets other apps or AI agents sign in through your project. This app does not need it.

## AI meal chat (Gemini)
1. In Supabase, run `schema_ai.sql`, then `schema_ai_v2.sql`, then `schema_chat.sql` (this one keeps each day's chat visible).
2. Add keys to `.env` and to Render's environment variables: `GEMINI_API_KEY` (Google AI Studio) and `USDA_API_KEY` (free, fdc.nal.usda.gov). Nutritionix and Edamam are optional.
3. On the **Today** tab, type what you ate in the chat, or add a photo, and press Send.

How it works: Gemini identifies the foods, ingredients, portions, meal type and confidence. If it is confident, the meal is saved automatically and the daily totals update at once. If anything is below `CONFIDENCE_THRESHOLD`, or a portion can't be estimated, the chat asks a follow-up question and saves nothing until you answer. Every logged meal has **Undo** and **Correct** buttons. Nutrition comes from USDA FoodData Central first, then manufacturer labels (Open Food Facts) and optional databases, then web references found with Gemini's Google Search tool (accepted only with a source link), and finally an AI estimate that is labeled "(estimated)". Each item stores its source, source link, verified or AI-estimated status, confidence, time eaten and your original text. Corrections keep the earlier version in `meal_revisions`.

Main endpoint: `POST /api/chat`. Chat history: `GET /api/chat/history?day=`. Others: `GET /api/meals?day=`, `GET /api/meals/history?from=&to=`, `GET /api/meals/:id`, `DELETE /api/meals/:id`, `GET /api/summary?period=day|week|month&date=`.
