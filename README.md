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
- Login is still handled by this app (email, bcrypt-hashed password, JWT). If you would rather use Supabase Auth, the data layer can be changed to rely on row level security policies instead.
- Before going live: HTTPS, a strong `JWT_SECRET`, login rate limiting, and keeping `.env` out of source control.

## AI meal logging (Gemini)
1. In Supabase, run `schema_ai.sql`, then `schema_ai_v2.sql`.
2. Add keys to `.env` and to Render's environment variables: `GEMINI_API_KEY` (Google AI Studio) and `USDA_API_KEY` (free, fdc.nal.usda.gov). Nutritionix and Edamam are optional.
3. Open the **AI meal** tab, describe a meal or upload a photo, and choose **Analyze meal**.

Flow: Gemini identifies foods, ingredients, portions, the meal type and confidence scores. If anything is below `CONFIDENCE_THRESHOLD`, or a portion can't be estimated, you are asked first and no nutrition lookup happens. Otherwise nutrition is looked up in this order: USDA FoodData Central, then manufacturer labels (Open Food Facts) and any optional databases, then web references found with Gemini's Google Search tool (accepted only with a source link), and finally an AI estimate that is clearly labeled "not verified". You review the result, edit grams or remove items, and only **Confirm and save** writes to the database. Each item stores its source, source link, verified or AI-estimated status, confidence, time eaten, and the original text you entered. Corrections go through the same review and keep the earlier version in `meal_revisions`.

Endpoints: `POST /api/meals/analyze`, `POST /api/meals/confirm`, `POST /api/meals/:id/reprocess`, `GET /api/meals?day=`, `GET /api/meals/history?from=&to=`, `GET /api/meals/:id`, `DELETE /api/meals/:id`, `GET /api/summary?period=day|week|month&date=`.
