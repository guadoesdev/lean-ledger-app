"""
Black-box tests for the Lean Ledger HTTP API. They call a running server, so start it first (npm start).

    BASE_URL=http://localhost:3000 pytest tests/test_api.py -v

Optional:
    RUN_AI_TESTS=1   also run the live Gemini tests (they use your Gemini and USDA keys and cost a little)

These tests write to the database that the server is connected to. Each test registers its own throwaway user
(test+<random>@example.com), so use a development Supabase project, not your real data. Clean up afterwards with:
    delete from users where email like 'test+%@example.com';
"""
import os
import uuid

import pytest
import requests

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3000").rstrip("/")
RUN_AI = os.environ.get("RUN_AI_TESTS") == "1"
TIMEOUT = 90                      # generous, because a free Render service can take a while to wake up
PASSWORD = "Test-password-12345"
DAY = "2026-02-10"                # a Tuesday, so its week is 2026-02-09 to 2026-02-15
NEXT_DAY = "2026-02-11"
PROFILE = {"sex": "m", "a": 30, "h": 175, "w": 80, "gw": 75, "act": 1.55, "def": 400, "ppk": 2, "na": 2300}
FOOD = {"n": "Test Oats", "s": "1 cup", "k": 200, "p": 10, "c": 20, "f": 5, "na": 100, "fi": 3}

needs_ai = pytest.mark.skipif(not RUN_AI, reason="Set RUN_AI_TESTS=1 to run the live Gemini tests")


def call(method, path, token=None, **kw):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return requests.request(method, BASE_URL + path, headers=headers, timeout=TIMEOUT, **kw)


@pytest.fixture(scope="session", autouse=True)
def server_up():
    try:
        r = call("GET", "/api/profile")
    except requests.RequestException as e:
        pytest.skip(f"No server reachable at {BASE_URL} ({e.__class__.__name__}). Start it with npm start.")
    assert r.status_code == 401, f"{BASE_URL} does not look like the Lean Ledger API (got {r.status_code})"


def register():
    email = f"test+{uuid.uuid4().hex[:12]}@example.com"
    r = call("POST", "/api/register", json={"email": email, "password": PASSWORD})
    assert r.status_code == 200, r.text
    return {"email": email, "token": r.json()["token"]}


@pytest.fixture
def user():
    return register()


@pytest.fixture
def other():
    return register()


def make_food(token, **over):
    r = call("POST", "/api/foods", token, json={**FOOD, **over})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def log_food(token, food_id, day=DAY, meal="Breakfast", qty=1):
    r = call("POST", "/api/log", token, json={"day": day, "meal": meal, "foodId": food_id, "qty": qty})
    assert r.status_code == 200, r.text
    return r.json()["id"]


# ------------------------------------------------------------------ authentication

class TestAuth:
    def test_register_returns_a_token(self):
        assert register()["token"]

    @pytest.mark.parametrize("email", ["", "not-an-email", "a@b", "two words@x.com"])
    def test_register_rejects_bad_email(self, email):
        r = call("POST", "/api/register", json={"email": email, "password": PASSWORD})
        assert r.status_code == 400 and "email" in r.json()["error"].lower()

    def test_register_rejects_short_password(self):
        r = call("POST", "/api/register", json={"email": f"test+{uuid.uuid4().hex[:10]}@example.com", "password": "short"})
        assert r.status_code == 400 and "8 characters" in r.json()["error"]

    def test_register_rejects_missing_body(self):
        assert call("POST", "/api/register", json={}).status_code == 400

    def test_duplicate_email_is_rejected(self, user):
        r = call("POST", "/api/register", json={"email": user["email"], "password": PASSWORD})
        assert r.status_code == 409

    def test_login_succeeds(self, user):
        r = call("POST", "/api/login", json={"email": user["email"], "password": PASSWORD})
        assert r.status_code == 200 and r.json()["token"]

    def test_login_email_is_case_insensitive(self, user):
        r = call("POST", "/api/login", json={"email": user["email"].upper(), "password": PASSWORD})
        assert r.status_code == 200

    def test_login_wrong_password(self, user):
        r = call("POST", "/api/login", json={"email": user["email"], "password": "Wrong-password-1"})
        assert r.status_code == 401

    def test_login_unknown_email(self):
        r = call("POST", "/api/login", json={"email": f"nobody+{uuid.uuid4().hex}@example.com", "password": PASSWORD})
        assert r.status_code == 401

    @pytest.mark.parametrize("method, path", [
        ("GET", "/api/profile"), ("PUT", "/api/profile"), ("GET", "/api/targets"), ("GET", "/api/foods?q=a"),
        ("GET", "/api/foods/mine"), ("POST", "/api/foods"), ("GET", f"/api/log?day={DAY}"), ("POST", "/api/log"),
        ("DELETE", "/api/log/1"), ("GET", "/api/weights"), ("PUT", f"/api/weights/{DAY}"),
        ("GET", f"/api/meals?day={DAY}"), ("GET", "/api/meals/history"), ("DELETE", "/api/meals/1"),
        ("GET", f"/api/summary?period=day&date={DAY}"), ("POST", "/api/chat"), ("GET", f"/api/chat/history?day={DAY}"),
        ("POST", "/api/chat/cancel"), ("GET", "/api/ai/check"), ("POST", "/api/meals/analyze"), ("POST", "/api/meals/confirm"),
    ])
    def test_protected_routes_require_a_token(self, method, path):
        assert call(method, path).status_code == 401

    def test_garbage_token_is_rejected(self):
        assert call("GET", "/api/profile", token="garbage").status_code == 401

    def test_unknown_route_returns_404(self, user):
        r = call("GET", "/api/does-not-exist", user["token"])
        assert r.status_code == 404 and "error" in r.json()


# ------------------------------------------------------------------ profile and targets

class TestProfileAndTargets:
    def test_new_user_has_no_profile_or_targets(self, user):
        assert call("GET", "/api/profile", user["token"]).json() is None
        assert call("GET", "/api/targets", user["token"]).json() is None

    def test_save_and_read_profile(self, user):
        r = call("PUT", "/api/profile", user["token"], json=PROFILE)
        assert r.status_code == 200
        assert call("GET", "/api/profile", user["token"]).json() == PROFILE

    def test_profile_can_be_updated(self, user):
        call("PUT", "/api/profile", user["token"], json=PROFILE)
        call("PUT", "/api/profile", user["token"], json={**PROFILE, "def": 300})
        assert call("GET", "/api/profile", user["token"]).json()["def"] == 300

    @pytest.mark.parametrize("change", [
        {"sex": "x"}, {"a": 5}, {"a": 200}, {"h": 50}, {"h": 300}, {"w": 10}, {"gw": 500}, {"act": 1.0}, {"act": 2.5},
        {"def": -1}, {"def": 5000}, {"ppk": 0.1}, {"ppk": 6}, {"na": 100}, {"na": 9000}, {"a": "30"}, {"w": None},
    ])
    def test_profile_rejects_out_of_range_values(self, user, change):
        r = call("PUT", "/api/profile", user["token"], json={**PROFILE, **change})
        assert r.status_code == 400

    def test_profile_rejects_missing_field(self, user):
        incomplete = {k: v for k, v in PROFILE.items() if k != "w"}
        assert call("PUT", "/api/profile", user["token"], json=incomplete).status_code == 400

    def test_targets_for_male_profile(self, user):
        call("PUT", "/api/profile", user["token"], json=PROFILE)
        t = call("GET", "/api/targets", user["token"]).json()
        assert (t["bmr"], t["tdee"], t["k"]) == (1749, 2711, 2311)
        assert (t["p"], t["f"], t["c"], t["na"]) == (160, 64, 274, 2300)
        assert t["pct"] == pytest.approx(0.4545, abs=0.001)

    def test_targets_for_female_profile(self, user):
        call("PUT", "/api/profile", user["token"], json={**PROFILE, "sex": "f"})
        assert call("GET", "/api/targets", user["token"]).json()["bmr"] == 1583

    def test_targets_follow_the_latest_weigh_in(self, user):
        call("PUT", "/api/profile", user["token"], json=PROFILE)
        call("PUT", f"/api/weights/{DAY}", user["token"], json={"kg": 90})
        t = call("GET", "/api/targets", user["token"]).json()
        assert t["bmr"] == 1849 and t["p"] == 180

    def test_profiles_are_private(self, user, other):
        call("PUT", "/api/profile", user["token"], json=PROFILE)
        assert call("GET", "/api/profile", other["token"]).json() is None


# ------------------------------------------------------------------ weights

class TestWeights:
    def test_save_and_list_newest_first(self, user):
        call("PUT", "/api/weights/2026-01-05", user["token"], json={"kg": 81.5})
        call("PUT", "/api/weights/2026-01-06", user["token"], json={"kg": 81.0})
        rows = call("GET", "/api/weights", user["token"]).json()
        assert rows == [{"day": "2026-01-06", "kg": 81.0}, {"day": "2026-01-05", "kg": 81.5}]

    def test_same_day_is_overwritten(self, user):
        call("PUT", f"/api/weights/{DAY}", user["token"], json={"kg": 80})
        call("PUT", f"/api/weights/{DAY}", user["token"], json={"kg": 79.4})
        assert call("GET", "/api/weights", user["token"]).json() == [{"day": DAY, "kg": 79.4}]

    @pytest.mark.parametrize("path, body", [
        ("/api/weights/not-a-date", {"kg": 80}), (f"/api/weights/{DAY}", {"kg": 10}), (f"/api/weights/{DAY}", {"kg": 500}),
        (f"/api/weights/{DAY}", {"kg": "80"}), (f"/api/weights/{DAY}", {}),
    ])
    def test_weight_validation(self, user, path, body):
        assert call("PUT", path, user["token"], json=body).status_code == 400

    def test_weights_are_private(self, user, other):
        call("PUT", f"/api/weights/{DAY}", user["token"], json={"kg": 80})
        assert call("GET", "/api/weights", other["token"]).json() == []


# ------------------------------------------------------------------ foods and the manual food log

class TestFoods:
    def test_create_search_and_delete_custom_food(self, user):
        food_id = make_food(user["token"])
        mine = call("GET", "/api/foods/mine", user["token"]).json()
        assert [f["n"] for f in mine] == ["Test Oats"]
        found = call("GET", "/api/foods", user["token"], params={"q": "test oats"}).json()   # search ignores case
        assert any(f["id"] == food_id for f in found)
        assert set(found[0]) >= {"id", "n", "s", "k", "p", "c", "f", "na", "fi"}
        call("DELETE", f"/api/foods/{food_id}", user["token"])
        assert call("GET", "/api/foods/mine", user["token"]).json() == []

    @pytest.mark.parametrize("change", [{"n": ""}, {"n": "x" * 81}, {"k": -1}, {"p": "10"}, {"k": 99999}])
    def test_food_validation(self, user, change):
        assert call("POST", "/api/foods", user["token"], json={**FOOD, **change}).status_code == 400

    @pytest.mark.parametrize("q", ["'", "%", "_", "\\", "a,b", "x" * 300, "(", "\"; drop table foods; --"])
    def test_search_handles_awkward_text(self, user, q):
        r = call("GET", "/api/foods", user["token"], params={"q": q})
        assert r.status_code == 200 and isinstance(r.json(), list)

    def test_custom_foods_are_private(self, user, other):
        food_id = make_food(user["token"])
        assert call("GET", "/api/foods/mine", other["token"]).json() == []
        assert not any(f["id"] == food_id for f in call("GET", "/api/foods", other["token"], params={"q": "Test Oats"}).json())
        r = call("POST", "/api/log", other["token"], json={"day": DAY, "meal": "Lunch", "foodId": food_id, "qty": 1})
        assert r.status_code == 404

    def test_other_user_cannot_delete_my_food(self, user, other):
        food_id = make_food(user["token"])
        call("DELETE", f"/api/foods/{food_id}", other["token"])
        assert len(call("GET", "/api/foods/mine", user["token"]).json()) == 1


class TestManualLog:
    def test_log_entry_scales_nutrition_by_quantity(self, user):
        food_id = make_food(user["token"])
        entry_id = log_food(user["token"], food_id, qty=2)
        rows = call("GET", "/api/log", user["token"], params={"day": DAY}).json()
        e = next(r for r in rows if str(r["id"]) == str(entry_id))
        assert (e["meal"], e["name"], e["qty"]) == ("Breakfast", "Test Oats", 2)
        assert (e["kcal"], e["p"], e["c"], e["f"], e["na"], e["fi"]) == (400, 20, 40, 10, 200, 6)

    def test_log_entry_can_be_deleted(self, user):
        entry_id = log_food(user["token"], make_food(user["token"]))
        call("DELETE", f"/api/log/{entry_id}", user["token"])
        assert call("GET", "/api/log", user["token"], params={"day": DAY}).json() == []

    def test_log_only_returns_the_requested_day(self, user):
        food_id = make_food(user["token"])
        log_food(user["token"], food_id, day=DAY)
        assert call("GET", "/api/log", user["token"], params={"day": NEXT_DAY}).json() == []

    @pytest.mark.parametrize("change", [
        {"meal": "Brunch"}, {"qty": 0}, {"qty": 1000}, {"qty": "2"}, {"day": "tomorrow"}, {"foodId": "abc"},
    ])
    def test_log_validation(self, user, change):
        body = {"day": DAY, "meal": "Lunch", "foodId": make_food(user["token"]), "qty": 1, **change}
        assert call("POST", "/api/log", user["token"], json=body).status_code in (400, 404)

    def test_unknown_food_returns_404(self, user):
        r = call("POST", "/api/log", user["token"], json={"day": DAY, "meal": "Lunch", "foodId": 999999999, "qty": 1})
        assert r.status_code == 404

    def test_log_rejects_invalid_day(self, user):
        assert call("GET", "/api/log", user["token"], params={"day": "bad"}).status_code == 400

    def test_log_is_private_and_cannot_be_deleted_by_others(self, user, other):
        entry_id = log_food(user["token"], make_food(user["token"]))
        assert call("GET", "/api/log", other["token"], params={"day": DAY}).json() == []
        call("DELETE", f"/api/log/{entry_id}", other["token"])
        assert len(call("GET", "/api/log", user["token"], params={"day": DAY}).json()) == 1


# ------------------------------------------------------------------ summaries, meals and history (no AI needed)

class TestSummary:
    def test_day_week_and_month_totals(self, user):
        food_id = make_food(user["token"])
        log_food(user["token"], food_id, day=DAY)
        log_food(user["token"], food_id, day=NEXT_DAY, meal="Dinner")
        day = call("GET", "/api/summary", user["token"], params={"period": "day", "date": DAY}).json()
        week = call("GET", "/api/summary", user["token"], params={"period": "week", "date": DAY}).json()
        month = call("GET", "/api/summary", user["token"], params={"period": "month", "date": DAY}).json()
        assert (day["from"], day["to"]) == (DAY, DAY) and day["total"]["kcal"] == 200 and day["days_logged"] == 1
        assert (week["from"], week["to"]) == ("2026-02-09", "2026-02-15")
        assert week["total"]["kcal"] == 400 and week["days_logged"] == 2 and week["average"]["kcal"] == 200
        assert (month["from"], month["to"]) == ("2026-02-01", "2026-02-28") and month["total"]["kcal"] == 400
        assert [d["day"] for d in week["days"]] == [DAY, NEXT_DAY]
        assert {"kcal", "protein", "carbs", "fat", "fiber", "sugar", "sodium"} <= set(week["total"])
        assert "trend" in week

    def test_empty_period(self, user):
        s = call("GET", "/api/summary", user["token"], params={"period": "week", "date": DAY}).json()
        assert s["days"] == [] and s["days_logged"] == 0 and s["total"]["kcal"] == 0

    def test_trend_compares_with_previous_week(self, user):
        food_id = make_food(user["token"])
        log_food(user["token"], food_id, day="2026-02-03", qty=1)    # previous week: 200 kcal
        log_food(user["token"], food_id, day=DAY, qty=2)             # this week: 400 kcal
        s = call("GET", "/api/summary", user["token"], params={"period": "week", "date": DAY}).json()
        assert s["trend"]["kcal"] == 100.0                           # +100%

    @pytest.mark.parametrize("params", [
        {"period": "year", "date": DAY}, {"period": "day", "date": "bad"}, {"period": "day"}, {"date": DAY},
    ])
    def test_summary_validation(self, user, params):
        assert call("GET", "/api/summary", user["token"], params=params).status_code == 400

    def test_summary_is_private(self, user, other):
        log_food(user["token"], make_food(user["token"]))
        s = call("GET", "/api/summary", other["token"], params={"period": "day", "date": DAY}).json()
        assert s["total"]["kcal"] == 0


class TestMealsEndpoints:
    def test_empty_lists(self, user):
        assert call("GET", "/api/meals", user["token"], params={"day": DAY}).json() == []
        assert call("GET", "/api/meals/history", user["token"]).json() == []

    def test_meals_validation(self, user):
        assert call("GET", "/api/meals", user["token"], params={"day": "bad"}).status_code == 400

    def test_unknown_meal_returns_404(self, user):
        assert call("GET", "/api/meals/999999999", user["token"]).status_code == 404
        assert call("GET", "/api/meals/abc", user["token"]).status_code == 404

    def test_deleting_unknown_meal_is_harmless(self, user):
        assert call("DELETE", "/api/meals/999999999", user["token"]).status_code == 200

    def test_reprocess_unknown_meal_returns_404(self, user):
        r = call("POST", "/api/meals/999999999/reprocess", user["token"], json={"clarifications": "more rice"})
        assert r.status_code == 404

    def test_analyze_validation(self, user):
        post = lambda body: call("POST", "/api/meals/analyze", user["token"], json=body).status_code
        assert post({"day": "bad", "meal": "Lunch", "text": "eggs"}) == 400
        assert post({"day": DAY, "meal": "Brunch", "text": "eggs"}) == 400
        assert post({"day": DAY, "meal": "Lunch"}) == 400                       # nothing to analyze

    def test_confirm_rejects_a_forged_or_expired_draft(self, user):
        r = call("POST", "/api/meals/confirm", user["token"], json={"draft": "forged.draft.token"})
        assert r.status_code == 400 and "expired" in r.json()["error"].lower()


# ------------------------------------------------------------------ chat: validation and setup (no AI needed)

class TestChatBasics:
    def test_chat_requires_a_valid_day(self, user):
        r = call("POST", "/api/chat", user["token"], json={"day": "bad", "text": "2 eggs"})
        assert r.status_code == 400

    def test_chat_requires_text_or_photo(self, user):
        r = call("POST", "/api/chat", user["token"], json={"day": DAY, "text": "   "})
        assert r.status_code == 400

    @pytest.mark.parametrize("image", ["not-an-image", "data:text/plain;base64,AAAA", "data:image/gif;base64,AAAA"])
    def test_chat_rejects_bad_images(self, user, image):
        r = call("POST", "/api/chat", user["token"], json={"day": DAY, "image": image})
        assert r.status_code == 400

    def test_chat_history_starts_empty(self, user):
        r = call("GET", "/api/chat/history", user["token"], params={"day": DAY})
        assert r.status_code == 200 and r.json() == []      # a 502 here means schema_chat.sql has not been run

    def test_chat_history_validation(self, user):
        assert call("GET", "/api/chat/history", user["token"], params={"day": "bad"}).status_code == 400

    def test_chat_cancel(self, user):
        assert call("POST", "/api/chat/cancel", user["token"], json={"day": "bad"}).status_code == 400
        r = call("POST", "/api/chat/cancel", user["token"], json={"day": DAY})
        assert r.status_code == 200 and r.json() == {"ok": True}

    def test_setup_check_reports_each_item(self, user):
        r = call("GET", "/api/ai/check", user["token"])
        assert r.status_code == 200
        body = r.json()
        assert {"GEMINI_API_KEY", "USDA_API_KEY", "database: meals", "database: meal_items", "database: chat_messages"} <= set(body)
        assert body["database: meals"] == "ok", body["database: meals"]


# ------------------------------------------------------------------ chat with the live Gemini and USDA services

@needs_ai
class TestChatLive:
    AI_DAY = "2026-03-02"

    def chat(self, user, text, **extra):
        r = call("POST", "/api/chat", user["token"], json={"day": self.AI_DAY, "text": text, "hour": 8, **extra})
        assert r.status_code == 200, r.text
        return r.json()

    def test_small_talk_logs_nothing(self, user):
        r = self.chat(user, "Hi! What can you help me with?")
        assert r["status"] == "chat" and r["reply"]
        assert call("GET", "/api/meals", user["token"], params={"day": self.AI_DAY}).json() == []

    def test_meal_is_logged_automatically(self, user):
        r = self.chat(user, "I ate 2 scrambled eggs, 1 slice of wheat bread, and a banana for breakfast.")
        assert r["status"] == "saved", r
        meal = r["meal"]
        assert meal["meal"] == "Breakfast" and len(meal["items"]) >= 3
        assert 250 <= meal["totals"]["kcal"] <= 700
        for item in meal["items"]:
            assert item["source"] and item["verification"] in ("verified", "ai_estimated") and item["grams"] > 0
        # it shows up in the daily log used by the Today tab
        log = call("GET", "/api/log", user["token"], params={"day": self.AI_DAY}).json()
        assert sum(e["kcal"] for e in log) == pytest.approx(meal["totals"]["kcal"], abs=1)
        assert all(str(e["id"]).startswith("m") for e in log)
        # and in the day summary
        s = call("GET", "/api/summary", user["token"], params={"period": "day", "date": self.AI_DAY}).json()
        assert s["total"]["kcal"] == pytest.approx(meal["totals"]["kcal"], abs=1)

    def test_history_is_saved_and_undo_removes_the_meal(self, user):
        r = self.chat(user, "I had a banana for a snack.")
        assert r["status"] == "saved", r
        history = call("GET", "/api/chat/history", user["token"], params={"day": self.AI_DAY}).json()
        assert [m["role"] for m in history] == ["user", "bot"] and history[1]["meal_id"] == r["meal"]["id"]
        call("DELETE", f"/api/meals/{r['meal']['id']}", user["token"])
        assert call("GET", "/api/log", user["token"], params={"day": self.AI_DAY}).json() == []
        history = call("GET", "/api/chat/history", user["token"], params={"day": self.AI_DAY}).json()
        assert history[1]["undone"] is True

    def test_vague_input_does_not_save_silently(self, user):
        r = self.chat(user, "I had some stuff for lunch.")
        assert r["status"] in ("ask", "chat")
        assert call("GET", "/api/meals", user["token"], params={"day": self.AI_DAY}).json() == []

    def test_correction_replaces_the_meal(self, user):
        first = self.chat(user, "I ate 1 banana for breakfast.")
        assert first["status"] == "saved", first
        fixed = self.chat(user, "Actually it was 2 bananas.", replace=first["meal"]["id"])
        assert fixed["status"] == "saved" and fixed["meal"]["id"] == first["meal"]["id"]
        assert fixed["meal"]["revision"] == 2
        assert fixed["meal"]["totals"]["kcal"] > first["meal"]["totals"]["kcal"] * 1.5
