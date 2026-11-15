"""
Tests for the USDA FoodData Central integration (nutrition.js).

Offline tests (always run, need only Node.js): they run the real nutrition.js adapters with a mocked network, so they
check how USDA and Open Food Facts responses are turned into nutrition values.

Live tests (need USDA_API_KEY and internet): they call the real USDA API to confirm the key works and that the
response still has the nutrient IDs and per-100 g values the app depends on.

Run:  USDA_API_KEY=your-key pytest tests/test_usda.py -v
"""
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
USDA_KEY = os.environ.get("USDA_API_KEY", "")
SEARCH_URL = "https://api.nal.usda.gov/fdc/v1/foods/search"

needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is not installed")
needs_key = pytest.mark.skipif(not USDA_KEY, reason="Set USDA_API_KEY to run the live USDA tests")

# Keys that could change which providers are active, removed so the offline tests behave the same everywhere.
PROVIDER_KEYS = ("USDA_API_KEY", "NUTRITIONIX_APP_ID", "NUTRITIONIX_APP_KEY", "EDAMAM_APP_ID", "EDAMAM_APP_KEY")


def run_node(script, env=None):
    clean = {k: v for k, v in os.environ.items() if k not in PROVIDER_KEYS}
    clean.update(env or {})
    p = subprocess.run(["node", "-e", script], cwd=ROOT, env=clean, capture_output=True, text=True, timeout=60)
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout.strip().splitlines()[-1])


def ok_response(payload):
    return "({ ok: true, status: 200, json: async () => (" + json.dumps(payload) + ") })"


def search_with_mock(tier, term, response, env=None):
    """Runs nutrition.searchTier(TIERS[tier], term) with fetch replaced by a mock that returns `response`."""
    script = (
        "const calls = [];\n"
        "global.fetch = async (url) => { calls.push(String(url)); return " + response + "; };\n"
        "const nut = require('./nutrition.js');\n"
        f"nut.searchTier(nut.TIERS[{tier}], {json.dumps(term)})"
        ".then(r => console.log(JSON.stringify({ cands: r.cands, failed: r.failed, calls })));"
    )
    return run_node(script, env)


SCRAMBLED_EGG = {"foods": [{"fdcId": 123, "description": "Egg, whole, cooked, scrambled", "foodNutrients": [
    {"nutrientId": 1008, "value": 149}, {"nutrientId": 1003, "value": 10.0}, {"nutrientId": 1004, "value": 11.0},
    {"nutrientId": 1005, "value": 1.6}, {"nutrientId": 1079, "value": 0}, {"nutrientId": 2000, "value": 1.4},
    {"nutrientId": 1093, "value": 145}]}]}


# ---------------------------------------------------------------- offline: USDA adapter

@needs_node
class TestUsdaAdapterOffline:
    def test_maps_usda_nutrients_per_100g(self):
        r = search_with_mock(0, "egg, scrambled", ok_response(SCRAMBLED_EGG), {"USDA_API_KEY": "test-key"})
        assert r["failed"] is False and len(r["cands"]) == 1
        c = r["cands"][0]
        assert c["source"] == "USDA FoodData Central"
        assert c["type"] == "government"
        assert c["id"] == "123"
        assert c["name"] == "Egg, whole, cooked, scrambled"
        assert "123" in c["url"] and c["url"].startswith("https://fdc.nal.usda.gov")
        assert c["per100g"] == {"kcal": 149, "protein": 10, "carbs": 1.6, "fat": 11, "fiber": 0, "sugar": 1.4, "sodium": 145}

    @pytest.mark.parametrize("energy_id", [2047, 2048])
    def test_uses_atwater_energy_when_standard_energy_is_missing(self, energy_id):
        payload = {"foods": [{"fdcId": 7, "description": "Foundation food", "foodNutrients": [
            {"nutrientId": energy_id, "value": 120}, {"nutrientId": 1003, "value": 20}]}]}
        c = search_with_mock(0, "x", ok_response(payload), {"USDA_API_KEY": "k"})["cands"][0]
        assert c["per100g"]["kcal"] == 120

    def test_missing_nutrients_default_to_zero(self):
        payload = {"foods": [{"fdcId": 9, "description": "Sparse", "foodNutrients": [{"nutrientId": 1008, "value": 50}]}]}
        c = search_with_mock(0, "x", ok_response(payload), {"USDA_API_KEY": "k"})["cands"][0]
        assert c["per100g"]["protein"] == 0 and c["per100g"]["sodium"] == 0

    def test_request_uses_expected_url_and_parameters(self):
        r = search_with_mock(0, "egg, scrambled", ok_response(SCRAMBLED_EGG), {"USDA_API_KEY": "my-key"})
        url = r["calls"][0]
        assert url.startswith(SEARCH_URL)
        assert "api_key=my-key" in url
        assert "query=egg%2C%20scrambled" in url          # the search term is URL-encoded
        assert "pageSize=5" in url
        assert "dataType=Foundation,SR%20Legacy" in url    # generic foods, not branded products

    def test_no_foods_in_response_gives_no_candidates(self):
        r = search_with_mock(0, "x", ok_response({"foods": []}), {"USDA_API_KEY": "k"})
        assert r["cands"] == [] and r["failed"] is False

    def test_response_without_foods_field_is_handled(self):
        r = search_with_mock(0, "x", ok_response({}), {"USDA_API_KEY": "k"})
        assert r["cands"] == [] and r["failed"] is False

    @pytest.mark.parametrize("status", [400, 403, 429, 500])
    def test_http_errors_are_reported_as_failed(self, status):
        response = "({ ok: false, status: %d, json: async () => ({}) })" % status
        r = search_with_mock(0, "x", response, {"USDA_API_KEY": "k"})
        assert r["failed"] is True and r["cands"] == []

    def test_provider_is_skipped_without_a_key(self):
        r = search_with_mock(0, "egg", ok_response(SCRAMBLED_EGG))   # no USDA_API_KEY in the environment
        assert r["cands"] == [] and r["failed"] is False and r["calls"] == []


# ---------------------------------------------------------------- offline: other nutrition code

@needs_node
class TestNutritionHelpersOffline:
    def test_scale_to_portion(self):
        script = ("const n = require('./nutrition.js');"
                  "console.log(JSON.stringify(n.scale({kcal:89,protein:1.1,carbs:22.8,fat:0.3,fiber:2.6,sugar:12.2,sodium:1}, 118)));")
        s = run_node(script)
        expected = {"kcal": 105.0, "protein": 1.3, "carbs": 26.9, "fat": 0.4, "fiber": 3.1, "sugar": 14.4, "sodium": 1.2}
        assert s == pytest.approx(expected)

    def test_scale_zero_grams_gives_zeros(self):
        script = "const n = require('./nutrition.js'); console.log(JSON.stringify(n.scale({kcal:89,protein:1.1}, 0)));"
        assert run_node(script) == {"kcal": 0, "protein": 0}

    def test_open_food_facts_converts_sodium_from_grams_to_mg(self):
        payload = {"products": [
            {"code": "111", "product_name": "Whole wheat bread", "brands": "Acme", "nutriments": {
                "energy-kcal_100g": 250, "proteins_100g": 9, "carbohydrates_100g": 45, "fat_100g": 3,
                "fiber_100g": 3, "sugars_100g": 4, "sodium_100g": 0.5}},
            {"code": "222", "product_name": "No nutrition data", "nutriments": {}},
        ]}
        r = search_with_mock(1, "bread", ok_response(payload))   # tier 1: Open Food Facts plus optional databases
        assert len(r["cands"]) == 1                              # the product without calories is dropped
        c = r["cands"][0]
        assert c["source"] == "Open Food Facts (manufacturer label)" and c["type"] == "manufacturer_label"
        assert c["name"] == "Whole wheat bread - Acme"
        assert c["per100g"]["sodium"] == 500 and c["per100g"]["kcal"] == 250

    def test_label_tier_failure_is_reported(self):
        r = search_with_mock(1, "x", "({ ok: false, status: 503, json: async () => ({}) })")
        assert r["failed"] is True and r["cands"] == []


# ---------------------------------------------------------------- live: the real USDA API

def usda_search(query, key=None, **extra):
    requests = pytest.importorskip("requests")
    params = {"api_key": key if key is not None else USDA_KEY, "query": query, "pageSize": 5,
              "dataType": "Foundation,SR Legacy", **extra}
    return requests.get(SEARCH_URL, params=params, timeout=30)


def nutrient(food, *ids):
    for i in ids:
        for n in food.get("foodNutrients", []):
            if n.get("nutrientId") == i:
                return n.get("value")
    return None


@needs_key
class TestUsdaLive:
    def test_key_is_accepted(self):
        r = usda_search("banana")
        assert r.status_code == 200, r.text[:200]
        assert isinstance(r.json().get("foods"), list) and r.json()["foods"]

    def test_invalid_key_is_rejected(self):
        r = usda_search("banana", key="INVALID_KEY_FOR_TEST")
        assert r.status_code in (400, 401, 403)

    def test_results_contain_the_nutrient_ids_the_app_reads(self):
        food = usda_search("egg").json()["foods"][0]
        assert nutrient(food, 1003) is not None                              # protein
        assert nutrient(food, 1008, 2047, 2048) is not None                  # energy (kcal)
        assert "fdcId" in food and "description" in food

    @pytest.mark.parametrize("query, kcal_range, protein_range", [
        ("banana raw", (80, 100), (0.5, 2)),
        ("egg, scrambled", (120, 220), (8, 15)),
        ("chicken breast cooked", (130, 200), (24, 36)),
        ("white rice cooked", (110, 150), (2, 4)),
    ])
    def test_values_are_per_100g_and_plausible(self, query, kcal_range, protein_range):
        foods = usda_search(query).json()["foods"]
        assert foods, f"no results for {query!r}"
        # USDA's top hit can vary, so at least one of the top five must be in the expected range.
        assert any(
            (k := nutrient(f, 1008, 2047, 2048)) is not None and kcal_range[0] <= k <= kcal_range[1]
            and (p := nutrient(f, 1003)) is not None and protein_range[0] <= p <= protein_range[1]
            for f in foods
        ), [(f["description"], nutrient(f, 1008, 2047, 2048), nutrient(f, 1003)) for f in foods]

    def test_gibberish_returns_no_foods(self):
        r = usda_search("zzzqqqxxyyww")
        assert r.status_code == 200 and r.json().get("foods") == []

    @needs_node
    def test_app_adapter_works_against_the_real_api(self):
        script = ("const nut = require('./nutrition.js');"
                  "nut.searchTier(nut.TIERS[0], 'banana').then(r => console.log(JSON.stringify(r)));")
        r = run_node(script, {"USDA_API_KEY": USDA_KEY})
        assert r["failed"] is False and r["cands"], r
        c = r["cands"][0]
        assert c["source"] == "USDA FoodData Central" and c["type"] == "government"
        assert c["per100g"]["kcal"] > 0 and c["url"].startswith("https://fdc.nal.usda.gov")
