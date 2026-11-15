// Candidates: { source, type, id, name, url, per100g: { kcal, protein, carbs, fat, fiber, sugar, sodium (mg) } }
// Tiers are tried in order: 1) government database, 2) manufacturer labels and approved databases.
// Web references and AI estimates are handled afterwards (see ai-meals.js). Providers without keys are skipped.
const n = v => (typeof v === 'number' && isFinite(v) ? v : 0);
const sig = () => AbortSignal.timeout(8000);

const USDA_IDS = { kcal: [1008, 2047, 2048], protein: [1003], fat: [1004], carbs: [1005], fiber: [1079], sugar: [2000], sodium: [1093] };
const usda = {
  name: 'USDA FoodData Central',
  on: () => !!process.env.USDA_API_KEY,
  async search(term) {
    const url = 'https://api.nal.usda.gov/fdc/v1/foods/search?pageSize=5&dataType=Foundation,SR%20Legacy' +
      `&api_key=${process.env.USDA_API_KEY}&query=${encodeURIComponent(term)}`;
    const r = await fetch(url, { signal: sig() });
    if (!r.ok) throw new Error('USDA ' + r.status);
    return ((await r.json()).foods || []).map(f => {
      const get = ids => { for (const id of ids) { const x = (f.foodNutrients || []).find(y => y.nutrientId === id); if (x) return n(x.value); } return 0; };
      return { source: 'USDA FoodData Central', type: 'government', id: String(f.fdcId), name: f.description,
        url: `https://fdc.nal.usda.gov/fdc-app.html#/food-details/${f.fdcId}/nutrients`,
        per100g: Object.fromEntries(Object.entries(USDA_IDS).map(([k, ids]) => [k, get(ids)])) };
    });
  }
};

// Packaged-food labels entered from manufacturer packaging (community maintained, no key needed).
const off = {
  name: 'Open Food Facts',
  on: () => true,
  async search(term) {
    const url = 'https://world.openfoodfacts.org/cgi/search.pl?search_simple=1&action=process&json=1&page_size=5' +
      '&fields=code,product_name,brands,nutriments&search_terms=' + encodeURIComponent(term);
    const r = await fetch(url, { signal: sig(), headers: { 'User-Agent': 'LeanLedger/1.0 (personal nutrition tracker)' } });
    if (!r.ok) throw new Error('Open Food Facts ' + r.status);
    return ((await r.json()).products || []).filter(p => p.product_name && p.nutriments).map(p => {
      const x = p.nutriments;
      return { source: 'Open Food Facts (manufacturer label)', type: 'manufacturer_label', id: String(p.code),
        name: [p.product_name, p.brands].filter(Boolean).join(' - '), url: 'https://world.openfoodfacts.org/product/' + p.code,
        per100g: { kcal: n(x['energy-kcal_100g']), protein: n(x.proteins_100g), carbs: n(x.carbohydrates_100g), fat: n(x.fat_100g),
          fiber: n(x.fiber_100g), sugar: n(x.sugars_100g), sodium: n(x.sodium_100g) * 1000 } };   // label gives grams of sodium
    }).filter(c => c.per100g.kcal > 0);
  }
};

const nutritionix = {
  name: 'Nutritionix',
  on: () => !!(process.env.NUTRITIONIX_APP_ID && process.env.NUTRITIONIX_APP_KEY),
  async search(term) {
    const r = await fetch('https://trackapi.nutritionix.com/v2/natural/nutrients', { method: 'POST', signal: sig(),
      headers: { 'Content-Type': 'application/json', 'x-app-id': process.env.NUTRITIONIX_APP_ID, 'x-app-key': process.env.NUTRITIONIX_APP_KEY },
      body: JSON.stringify({ query: `100 g ${term}` }) });
    if (!r.ok) throw new Error('Nutritionix ' + r.status);
    return ((await r.json()).foods || []).slice(0, 1).map(f => ({ source: 'Nutritionix', type: 'database',
      id: String(f.tags?.tag_id || f.food_name), name: f.food_name, url: null,
      per100g: { kcal: n(f.nf_calories), protein: n(f.nf_protein), carbs: n(f.nf_total_carbohydrate), fat: n(f.nf_total_fat),
        fiber: n(f.nf_dietary_fiber), sugar: n(f.nf_sugars), sodium: n(f.nf_sodium) } }));
  }
};

const edamam = {
  name: 'Edamam',
  on: () => !!(process.env.EDAMAM_APP_ID && process.env.EDAMAM_APP_KEY),
  async search(term) {
    const url = `https://api.edamam.com/api/food-database/v2/parser?app_id=${process.env.EDAMAM_APP_ID}` +
      `&app_key=${process.env.EDAMAM_APP_KEY}&nutrition-type=cooking&ingr=${encodeURIComponent(term)}`;
    const r = await fetch(url, { signal: sig() });
    if (!r.ok) throw new Error('Edamam ' + r.status);
    return ((await r.json()).hints || []).slice(0, 5).map(h => ({ source: 'Edamam', type: 'database', id: h.food.foodId,
      name: h.food.label, url: null,
      per100g: { kcal: n(h.food.nutrients.ENERC_KCAL), protein: n(h.food.nutrients.PROCNT), carbs: n(h.food.nutrients.CHOCDF),
        fat: n(h.food.nutrients.FAT), fiber: n(h.food.nutrients.FIBTG), sugar: 0, sodium: 0 } }));
  }
};

const TIERS = [[usda], [off, nutritionix, edamam]];

// Searches every configured provider in one tier. "failed" is true if any provider could not be reached.
async function searchTier(tier, term) {
  const on = tier.filter(p => p.on());
  const res = await Promise.allSettled(on.map(p => p.search(term)));
  res.forEach((r, i) => r.status === 'rejected' && console.warn(on[i].name + ' lookup failed:', r.reason && r.reason.message));
  return { cands: res.flatMap(r => (r.status === 'fulfilled' ? r.value : [])), failed: res.some(r => r.status === 'rejected') };
}
const scale = (per100g, grams) => Object.fromEntries(Object.entries(per100g).map(([k, v]) => [k, Math.round(v * grams / 100 * 10) / 10]));

module.exports = { TIERS, searchTier, scale };
