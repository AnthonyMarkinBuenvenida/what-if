"""Risk Radar assessment (advisor.py): severity-adapted sections, safeguards, caching and fallbacks. AI is mocked."""
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.agents.llm import llm, public_reason
from app.main import app
from app.whatif import advisor
from app.whatif.schemas import Levers, Profile
from app.whatif.service import demo_profile, run
from tests.test_whatif_engine import simple

H = {"X-StartUp-Client": "web"}


def two_products():
    return simple(products=[{"id": "a", "name": "A", "price": 10, "unit_cost": 4, "monthly_units": 1000, "elasticity": -1.2},
                            {"id": "b", "name": "B", "price": 12, "unit_cost": 5, "monthly_units": 900, "elasticity": -1.2}],
                  finance={"starting_cash": 40000, "tax_rate_pct": 0, "min_cash_buffer": 5000})


# One case per severity: (profile, levers). Levers {} assesses the current course.
CASES = {
    "low": (two_products, {}),
    "moderate": (lambda: Profile.model_validate(demo_profile()), {}),
    "high": (lambda: Profile.model_validate(demo_profile()), {"price_change_pct": -10}),
    "critical": (lambda: Profile.model_validate(demo_profile()), {"price_change_pct": -35}),
}


def case(level):
    make, lv = CASES[level]
    p = make()
    sim, r = run(p, Levers(horizon_months=12, **lv))
    report = r["scenario"] if lv else r["baseline"]
    scope = {"kind": "scenario" if lv else "baseline", "id": 1 if lv else None, "name": "the test scope"}
    assert report["level"] == level, (level, report["level"])
    return p, sim, report, scope


def assess(level, **kw):
    p, sim, report, scope = case(level)
    return advisor.assess(p, sim, report, scope=scope, signals={}, focus=kw.get("focus")), (p, sim, report, scope)


@pytest.fixture
def no_ai(monkeypatch):
    monkeypatch.setattr(type(llm), "available", property(lambda self: False))


@pytest.fixture
def with_ai(monkeypatch):
    monkeypatch.setattr(type(llm), "available", property(lambda self: True))
    calls = []

    def install(answer):
        def fake(system, prompt, schema, effort="medium", timeout=None):
            calls.append({"system": system, "prompt": prompt})
            body = answer(prompt) if callable(answer) else answer
            return None if body is None else schema.model_validate(body)
        monkeypatch.setattr(llm, "structured", fake)
        return calls
    return install


def ai_answer(report, level, **over):
    ids = [f["id"] for f in report["findings"]]
    first = ids[:1]
    body = {
        "risk_level": level, "risk_summary": "The margin is thin under the current figures.",
        "priority": "Start with the margin.", "relationships": None,
        "recommended_actions": [{"action": "Consider testing a 5% price increase", "reason": "It addresses the thin margin.", "finding_ids": first, "timing": "immediate"},
                                {"action": "Review supplier terms", "reason": "Lower variable costs raise each unit's contribution.", "finding_ids": first + ["made-up:id"], "timing": "next"}],
        "not_recommended_actions": [{"action": "Avoid adding fixed costs now", "reason": "They would come straight out of a thin profit.", "finding_ids": first}],
        "no_inadvisable_action": None,
        "expected_impact": {"if_followed": "The simulation will show whether profit improves.", "if_ignored": "Profit stays thin."},
        "monitoring_indicators": [{"indicator": "Net margin", "why": "Shows whether the margin recovers.", "finding_ids": first}],
        "suggested_scenarios": [{"title": "Price +5%", "rationale": "Tests the margin.", "finding_ids": first, "levers_json": json.dumps({"price_change_pct": 5})}],
        "verify": ["Confirm the price response estimate."],
    }
    body.update(over)
    return body


# ------------------------------------------------------------------ all four severity levels

@pytest.mark.parametrize("level", ["low", "moderate", "high", "critical"])
def test_rule_based_assessment_has_every_section_for_each_level(no_ai, level):
    a, (p, sim, report, scope) = assess(level)
    assert a["mode"] == "rules" and a["level"] == level and a["overall_level"] == report["level"]
    assert "rule-based" in a["disclaimer"].lower() and "AI is not connected" in a["notice"]
    assert a["overview"] and a["recommended"] and (a["not_recommended"] or a["not_recommended_none"])
    assert a["expected_impact"]["if_followed"] and a["expected_impact"]["if_ignored"] and a["monitor"] and a["scenarios"]
    assert a["labels"] == {k: advisor.LEVELS[level][k] for k in a["labels"]}
    # Evidence is the Radar's own findings, unchanged.
    assert [d["finding_id"] for d in a["detected"]] == [f["id"] for f in report["findings"]]
    for d, f in zip(a["detected"], report["findings"]):
        assert d["metric"] == f["metric"] and d["severity"] == f["severity"]
    # Every recommendation that names a warning names a real one.
    ids = {f["id"] for f in report["findings"]}
    for item in a["recommended"] + a["not_recommended"] + a["monitor"]:
        assert set(item["finding_ids"]) <= ids
    # Suggested scenarios are valid What-if levers on top of the scope.
    for s in a["scenarios"]:
        Levers.model_validate({**(sim["levers"] if scope["kind"] == "scenario" else {}), **s["levers"]})


def test_low_risk_does_not_manufacture_problems(no_ai):
    a, _ = assess("low")
    assert a["detected"] == [] and a["priority"] is None
    assert "no warnings" in a["overview"] and "not a guarantee" in a["overview"]
    assert all(s["title"].startswith("Stress test") for s in a["scenarios"])
    assert "Expanding" in a["not_recommended"][0]["action"]


def test_critical_is_short_prioritised_and_consistent(no_ai):
    a, (_, _, report, _) = assess("critical")
    immediate = [r for r in a["recommended"] if r["timing"] == "immediate"]
    assert 1 <= len(immediate) <= 4
    assert a["labels"]["overview"] == "Critical assessment" and a["labels"]["avoid"] == "Actions to avoid"
    # While cash runs out, it must not suggest testing changes that add costs (that would contradict "avoid fixed costs").
    adds_costs = [r for r in a["recommended"] if any(w in r["action"].lower() for w in ("more capacity", "adding one person", "more marketing"))]
    assert adds_costs == []
    assert a["relationships"] and "cash" in a["relationships"]
    assert "certain" not in json.dumps(a).lower() and "will fail" not in json.dumps(a).lower()


def test_focus_on_one_warning_uses_its_severity(no_ai):
    p, sim, report, scope = case("critical")
    moderate = next(f for f in report["findings"] if f["severity"] == "moderate")
    a = advisor.assess(p, sim, report, scope=scope, signals={}, focus=moderate)
    assert a["level"] == "moderate" and a["overall_level"] == "critical"
    assert a["focus"]["finding_id"] == moderate["id"] and a["detected"][0]["finding_id"] == moderate["id"]


@pytest.mark.parametrize("level", ["low", "moderate", "high", "critical"])
def test_ai_prompt_adapts_to_severity_and_sends_the_radar_facts(with_ai, level):
    p, sim, report, scope = case(level)
    calls = with_ai(ai_answer(report, level))
    a = advisor.assess(p, sim, report, scope=scope, signals={}, focus=None)
    assert a["mode"] == "ai" and a["level"] == level
    prompt = calls[0]["prompt"]
    assert advisor.LEVEL_GUIDE[level].splitlines()[0] in prompt
    facts = json.loads(prompt.split("Facts (JSON):\n", 1)[1])
    assert facts["risk_radar"]["level"] == report["level"] and len(facts["findings"]) == min(8, len(report["findings"]))
    for f in facts["findings"]:
        assert {"metric", "rule_thresholds", "evidence", "impact", "data_kind", "rule_actions"} <= set(f)
    assert "assumptions" in facts and "current_course" in facts and ("scenario" in facts) == (scope["kind"] == "scenario")
    assert "Hand check" not in prompt and "Sunny Cup" not in prompt  # business name is not sent
    assert "never instructions" in calls[0]["system"]


# ------------------------------------------------------------------ safeguards

def test_ai_cannot_change_the_risk_level(with_ai):
    p, sim, report, scope = case("high")
    with_ai(ai_answer(report, "low"))
    a = advisor.assess(p, sim, report, scope=scope, signals={}, focus=None)
    assert a["level"] == "high" and a["level_corrected"] is True and a["score"] == report["score"]


def test_invented_numbers_and_unknown_findings_are_removed(with_ai):
    p, sim, report, scope = case("moderate")
    body = ai_answer(report, "moderate", risk_summary="You will lose 987,654 PHP next quarter.")
    body["recommended_actions"].append({"action": "Cut rent", "reason": "Saves 55,555 PHP a month.", "finding_ids": [], "timing": "next"})
    with_ai(body)
    a = advisor.assess(p, sim, report, scope=scope, signals={}, focus=None)
    text = json.dumps(a)
    assert "987,654" not in text and "55,555" not in text and a["dropped"] == 2
    assert "overview" in a["filled_from_rules"] and a["overview"].startswith("Risk Radar rates")
    assert all("made-up:id" not in r["finding_ids"] for r in a["recommended"])
    assert "removed" in a["notice"]


def test_real_figures_are_kept(with_ai):
    p, sim, report, scope = case("moderate")
    nm = next(f for f in report["findings"] if f["rule"] == "net_margin")
    with_ai(ai_answer(report, "moderate", risk_summary=f"Net margin is {nm['metric']['value'] * 100:.1f}%, below the 10% warning line."))
    a = advisor.assess(p, sim, report, scope=scope, signals={}, focus=None)
    assert a["dropped"] == 0 and "Net margin is" in a["overview"]


def test_scenarios_are_validated(with_ai):
    p, sim, report, scope = case("high")
    scen = [{"title": "ok", "rationale": "r", "finding_ids": [], "levers_json": json.dumps({"price_change_pct": 3, "price_product_ids": ["classic", "nope"]})},
            {"title": "out of range", "rationale": "r", "finding_ids": [], "levers_json": json.dumps({"price_change_pct": -500})},
            {"title": "not json", "rationale": "r", "finding_ids": [], "levers_json": "price up"},
            {"title": "data links", "rationale": "r", "finding_ids": [], "levers_json": json.dumps({"data_links": [{"id": "x"}]})}]
    with_ai(ai_answer(report, "high", suggested_scenarios=scen))
    a = advisor.assess(p, sim, report, scope=scope, signals={}, focus=None)
    assert [s["title"] for s in a["scenarios"]] == ["ok"]
    assert a["scenarios"][0]["levers"] == {"price_change_pct": 3, "price_product_ids": ["classic"]}


def test_empty_not_recommended_is_filled_from_rules_unless_explained(with_ai):
    p, sim, report, scope = case("moderate")
    with_ai(ai_answer(report, "moderate", not_recommended_actions=[]))
    a = advisor.assess(p, sim, report, scope=scope, signals={}, focus=None)
    assert a["not_recommended"] and "not_recommended" in a["filled_from_rules"]
    with_ai(ai_answer(report, "moderate", not_recommended_actions=[], no_inadvisable_action="Nothing here is clearly inadvisable."))
    b = advisor.assess(p, sim, report, scope=scope, signals={}, focus=None)
    assert b["not_recommended"] == [] and b["not_recommended_none"] == "Nothing here is clearly inadvisable."


def test_ai_failure_falls_back_to_labelled_rules_without_provider_details(with_ai, monkeypatch):
    p, sim, report, scope = case("critical")
    with_ai(None)
    monkeypatch.setattr(llm, "last_error", "the AI account needs more credits (HTTP 402: can only afford 733. visit [link removed])")
    a = advisor.assess(p, sim, report, scope=scope, signals={}, focus=None)
    assert a["mode"] == "rules" and a["level"] == "critical" and a["recommended"]
    assert "does not have enough credits" in a["notice"] and "733" not in a["notice"] and "HTTP" not in a["notice"]


@pytest.mark.parametrize("msg, expected", [
    ("The AI service did not answer within 120 s; deterministic analysis was used.", "did not answer in time"),
    ("The AI service is rate limited; deterministic analysis was used.", "rate limiting"),
    ("The AI answer was cut off at the answer-length limit (1800 tokens, WHATIF_AI_MAX_TOKENS).", "answer-length limit"),
    ("AI response could not be used (JSONDecodeError).", "expected format"),
    ("Could not reach the AI service; deterministic analysis was used.", "could not be reached"),
])
def test_public_reasons(msg, expected):
    assert expected in public_reason(msg)


def test_provider_links_and_cutoffs_are_handled(monkeypatch):
    from app.config import settings
    monkeypatch.setattr(type(settings), "ai_enabled", property(lambda self: True))
    object.__setattr__(settings, "ai_provider", "openai_compatible")
    object.__setattr__(settings, "ai_base_url", "http://llm.local/v1")
    try:
        r402 = lambda req: httpx.Response(402, json={"error": {"message": "Need credits. Visit https://openrouter.ai/workspaces/default/keys/abc123 to add."}})
        assert llm._openai_compatible("s", "p", advisor.AIRiskAssessment, transport=httpx.MockTransport(r402)) is None
        assert "abc123" not in llm.last_error and "[link removed]" in llm.last_error
        cut = lambda req: httpx.Response(200, json={"choices": [{"finish_reason": "length", "message": {"content": '{"risk_level": "hi'}}]})
        assert llm._openai_compatible("s", "p", advisor.AIRiskAssessment, transport=httpx.MockTransport(cut)) is None
        assert "cut off" in llm.last_error
        seen = {}

        def slow(req):
            seen["timeout"] = req.extensions.get("timeout")
            return httpx.Response(200, json={"choices": [{"message": {"content": "{}"}}]})
        llm._openai_compatible("s", "p", advisor.AIRiskAssessment, transport=httpx.MockTransport(slow), timeout=120)
        assert seen["timeout"]["read"] == 120
    finally:
        object.__setattr__(settings, "ai_provider", "anthropic")
        object.__setattr__(settings, "ai_base_url", "")


# ------------------------------------------------------------------ API: caching, staleness, no auto-run

@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def demo(c):
    c.cookies.clear()
    assert c.post("/api/workspace", headers=H).status_code == 200
    bid = c.post("/api/whatif/demo", headers=H).json()["business"]["id"]
    return bid


def test_api_cache_staleness_and_no_side_effects(client, with_ai):
    bid = demo(client)
    url = f"/api/whatif/businesses/{bid}/risk/assessment"
    radar = client.get(f"/api/whatif/businesses/{bid}/risk").json()
    calls = with_ai(lambda prompt: ai_answer(radar["baseline"], radar["baseline"]["level"]))
    assert client.get(url).json() == {"assessment": None, "current": False, "ai": {"configured": True, "model": llm.model}}
    scen_before = client.get(f"/api/whatif/businesses/{bid}/scenarios").json()
    prof_before = client.get(f"/api/whatif/businesses/{bid}/profile").json()["profile"]

    first = client.post(url, headers=H, json={"scope": "baseline"}).json()
    assert first["assessment"]["mode"] == "ai" and first["current"] and not first["cached"] and len(calls) == 1
    assert first["assessment"]["level"] == radar["baseline"]["level"]
    again = client.post(url, headers=H, json={"scope": "baseline"}).json()
    assert again["cached"] and len(calls) == 1  # same inputs: no second AI call
    forced = client.post(url, headers=H, json={"scope": "baseline", "refresh": True}).json()
    assert not forced["cached"] and len(calls) == 2
    got = client.get(url).json()
    assert got["current"] and got["assessment"]["created_at"] == forced["assessment"]["created_at"]

    # Nothing was simulated, saved or changed.
    assert client.get(f"/api/whatif/businesses/{bid}/scenarios").json() == scen_before
    assert client.get(f"/api/whatif/businesses/{bid}/profile").json()["profile"]["version"] == prof_before["version"]

    # Changing the business figures makes the saved assessment outdated; a new request calls the AI again.
    spec = prof_before["spec"]
    spec["fixed_costs"][0]["monthly_amount"] += 5000
    assert client.put(f"/api/whatif/businesses/{bid}/profile", headers=H, json={"spec": spec}).status_code == 200
    stale = client.get(url).json()
    assert stale["assessment"] is not None and stale["current"] is False
    fresh = client.post(url, headers=H, json={"scope": "baseline"}).json()
    assert not fresh["cached"] and fresh["current"] and len(calls) == 3


def test_api_scenario_scope_focus_and_fallback(client, with_ai, monkeypatch):
    bid = demo(client)
    radar = client.get(f"/api/whatif/businesses/{bid}/risk").json()
    sc = next(s for s in radar["scenarios"] if s["findings"])
    url = f"/api/whatif/businesses/{bid}/risk/assessment"
    with_ai(None)  # AI fails
    monkeypatch.setattr(llm, "last_error", "The AI service is rate limited; deterministic analysis was used.")
    f = sc["findings"][0]
    r = client.post(url, headers=H, json={"scope": str(sc["id"]), "finding_id": f["id"]})
    assert r.status_code == 200, r.text
    a = r.json()["assessment"]
    assert a["mode"] == "rules" and a["scope"]["kind"] == "scenario" and a["focus"]["finding_id"] == f["id"]
    assert a["level"] == f["severity"] and a["overall_level"] == sc["level"] and "rate limiting" in a["notice"]
    # Risk Radar itself keeps working when the AI fails.
    assert client.get(f"/api/whatif/businesses/{bid}/risk").status_code == 200
    # Unknown warning / scenario of another business
    assert client.post(url, headers=H, json={"scope": "baseline", "finding_id": "baseline:nope:9"}).status_code == 409
    assert client.post(url, headers=H, json={"scope": "999999"}).status_code == 404
    assert client.post(url, headers=H, json={"scope": "x"}).status_code == 422


def test_api_never_returns_secrets(client, with_ai, monkeypatch):
    monkeypatch.setenv("WHATIF_AI_API_KEY", "sk-test-secret-value")
    bid = demo(client)
    radar = client.get(f"/api/whatif/businesses/{bid}/risk").json()
    with_ai(lambda prompt: ai_answer(radar["baseline"], radar["baseline"]["level"]))
    body = client.post(f"/api/whatif/businesses/{bid}/risk/assessment", headers=H, json={"scope": "baseline", "refresh": True}).text
    assert "sk-test-secret-value" not in body and "Authorization" not in body


def test_fallback_model_and_reasoning_effort(monkeypatch):
    from app.config import settings
    monkeypatch.setattr(type(settings), "ai_enabled", property(lambda self: True))
    saved = {k: getattr(settings, k) for k in ("ai_provider", "ai_base_url", "ai_fallback_models", "ai_reasoning_effort", "ai_model", "ai_backup_base_url")}
    object.__setattr__(settings, "ai_backup_base_url", "")  # independent of any backup configured in the local .env
    object.__setattr__(settings, "ai_provider", "openai_compatible")
    object.__setattr__(settings, "ai_base_url", "http://llm.local/v1")
    object.__setattr__(settings, "ai_model", "main-model")
    object.__setattr__(settings, "ai_fallback_models", ("backup-model",))
    object.__setattr__(settings, "ai_reasoning_effort", "low")
    try:
        seen = []

        def h(req):
            body = json.loads(req.content)
            seen.append((body["model"], body.get("reasoning_effort")))
            if body["model"] == "main-model":
                return httpx.Response(503, json={"error": {"message": "high demand"}})
            return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps({"summary": "s", "trade_offs": []})}}]})
        from app.whatif import ai
        out = llm._openai_compatible("s", "p", ai.AIComparison, transport=httpx.MockTransport(h))
        assert out is not None and out.summary == "s"
        assert seen == [("main-model", "low"), ("backup-model", "low")] and llm.last_model == "backup-model"
        # Every model overloaded: falls back to rules with a clear reason; a bad key is not retried on other models.
        seen.clear()
        assert llm._openai_compatible("s", "p", ai.AIComparison, transport=httpx.MockTransport(lambda r: httpx.Response(503, json={}))) is None
        assert "HTTP 503" in llm.last_error and len(seen) == 0
        calls = []
        assert llm._openai_compatible("s", "p", ai.AIComparison, transport=httpx.MockTransport(lambda r: calls.append(1) or httpx.Response(401, json={}))) is None
        assert len(calls) == 1 and "rejected" in llm.last_error
        object.__setattr__(settings, "ai_reasoning_effort", "")
        body = {}
        llm._openai_compatible("s", "p", ai.AIComparison, transport=httpx.MockTransport(lambda r: body.update(json.loads(r.content)) or httpx.Response(200, json={"choices": [{"message": {"content": "{}"}}]})))
        assert "reasoning_effort" not in body
    finally:
        for k, v in saved.items():
            object.__setattr__(settings, k, v)


def test_backup_endpoint_is_tried_after_the_main_one(monkeypatch):
    from app.config import settings
    from app.whatif import ai
    monkeypatch.setattr(type(settings), "ai_enabled", property(lambda self: True))
    monkeypatch.setenv("WHATIF_AI_API_KEY", "main-key")
    monkeypatch.setenv("WHATIF_AI_BACKUP_API_KEY", "backup-key")
    keys = ("ai_provider", "ai_base_url", "ai_model", "ai_fallback_models", "ai_reasoning_effort", "ai_backup_base_url", "ai_backup_models", "ai_backup_extra")
    saved = {k: getattr(settings, k) for k in keys}
    for k, v in {"ai_provider": "openai_compatible", "ai_base_url": "http://gemini.local/v1", "ai_model": "g1", "ai_fallback_models": (),
                 "ai_reasoning_effort": "low", "ai_backup_base_url": "http://router.local/v1", "ai_backup_models": ("free-a", "free-b"),
                 "ai_backup_extra": {"reasoning": {"enabled": False}}}.items():
        object.__setattr__(settings, k, v)
    try:
        seen = []

        def h(req):
            body = json.loads(req.content)
            seen.append((req.url.host, req.headers["authorization"], body["model"], body.get("reasoning_effort"), body.get("reasoning")))
            if req.url.host == "gemini.local":
                return httpx.Response(429, json={"error": {"message": "quota exceeded"}})
            if body["model"] == "free-a":
                return httpx.Response(200, json={"choices": [{"finish_reason": "length", "message": {"content": '{"summ'}}]})
            return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps({"summary": "from backup", "trade_offs": []})}}]})
        out = llm._openai_compatible("s", "p", ai.AIComparison, transport=httpx.MockTransport(h))
        assert out.summary == "from backup" and llm.last_model == "free-b"
        assert seen[0] == ("gemini.local", "Bearer main-key", "g1", "low", None)
        assert seen[1][:3] == ("router.local", "Bearer backup-key", "free-a") and seen[1][4] == {"enabled": False} and seen[1][3] is None
        assert [s[2] for s in seen] == ["g1", "free-a", "free-b"]
        # Without a backup key the backup endpoint is not used.
        monkeypatch.delenv("WHATIF_AI_BACKUP_API_KEY")
        seen.clear()
        assert llm._openai_compatible("s", "p", ai.AIComparison, transport=httpx.MockTransport(h)) is None
        assert [s[0] for s in seen] == ["gemini.local"] and "rate limited" in llm.last_error
    finally:
        for k, v in saved.items():
            object.__setattr__(settings, k, v)


def test_promised_outcomes_doom_and_cost_adding_tests_are_removed(with_ai):
    p, sim, report, scope = case("critical")
    body = ai_answer(report, "critical", expected_impact={"if_followed": "Cash shortfall is avoided and operations remain viable.",
                                                          "if_ignored": "The business will need emergency funding or closure."})
    body["recommended_actions"].append({"action": "Do this", "reason": "It will restore profitability.", "finding_ids": [], "timing": "next"})
    body["suggested_scenarios"].append({"title": "More capacity", "rationale": "r", "finding_ids": [], "levers_json": json.dumps({"capacity_change_pct": 20})})
    with_ai(body)
    a = advisor.assess(p, sim, report, scope=scope, signals={}, focus=None)
    text = json.dumps(a)
    assert "is avoided" not in text and "closure" not in text and "will restore" not in text
    assert a["expected_impact"]["if_followed"].startswith("Not calculated yet") and a["dropped"] == 3
    assert all("capacity_change_pct" not in s["levers"] for s in a["scenarios"])


def test_high_and_critical_always_name_something_to_avoid(with_ai):
    p, sim, report, scope = case("critical")
    body = ai_answer(report, "critical", not_recommended_actions=[], no_inadvisable_action="Nothing would make this worse.")
    body["recommended_actions"][0]["action"] = "Test 10% lower fixed costs (levers: fixed_cost_change_pct: -10)"
    body["expected_impact"]["if_followed"] = "The cash drain is expected to stop, preventing the deficit."
    with_ai(body)
    a = advisor.assess(p, sim, report, scope=scope, signals={}, focus=None)
    assert a["not_recommended"] and a["not_recommended_none"] is None and "not_recommended" in a["filled_from_rules"]
    assert a["recommended"][0]["action"] == "Test 10% lower fixed costs"
    assert a["expected_impact"]["if_followed"].startswith("Not calculated yet")
