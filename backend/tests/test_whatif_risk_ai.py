"""Risk Radar rules and the AI layer (AI is mocked; no network)."""
import json

import httpx
import pytest

from app.agents import llm as llm_mod
from app.agents.llm import llm, ungrounded_numbers
from app.whatif import ai, engine, risk, rules_parser
from app.whatif.schemas import Levers, Profile
from app.whatif.service import demo_profile, run
from tests.test_whatif_engine import simple


def findings(profile, **lv):
    sim = engine.simulate(profile, Levers(horizon_months=12, start_month="2027-01", **lv))
    return sim, risk.analyse(profile, sim, scope="scenario")


def rules_of(r):
    return {f["rule"]: f for f in r["findings"]}


def test_threshold_breach_triggers_warning_with_evidence():
    p = simple()
    _, r = findings(p, unit_cost_change_pct=40)
    f = rules_of(r)
    assert f["cost_pressure"]["severity"] == "high"
    cp = f["cost_pressure"]
    assert cp["evidence"] and cp["metric"]["value"] < cp["metric"]["threshold"]
    assert any("variable cost +40%" in t for t in cp["triggered_by"])
    assert cp["threshold"] and cp["why"]
    assert r["level"] in ("high", "critical") and 0 < r["score"] <= 100


def test_loss_is_critical_and_score_method_is_documented():
    _, r = findings(simple(), demand_change_pct=-60)
    f = rules_of(r)
    assert f["net_margin"]["severity"] == "critical"
    assert r["level"] == "critical"
    assert "Π" in r["method"]


def test_risk_updates_when_inputs_change():
    p = simple()
    _, before = findings(p)
    _, after = findings(p, price_change_pct=-35)
    assert before["score"] < after["score"]
    assert "profit_vs_baseline" in rules_of(after)


def test_recommended_actions_are_simulatable():
    p = Profile.model_validate(demo_profile())
    for lv in ({}, {"unit_cost_change_pct": 15}, {"price_change_pct": -10}, {"marketing_change_pct": 300}):
        sim, r = findings(p, **lv)
        for f in r["findings"]:
            for a in f["actions"]:
                if a.get("levers"):
                    test_lv = Levers.model_validate({**a["levers"], "horizon_months": 12})
                    engine.simulate(p, test_lv)  # must not raise


def test_negative_marketing_return_is_flagged():
    _, r = findings(Profile.model_validate(demo_profile()), marketing_change_pct=300)
    f = rules_of(r)["marketing"]
    assert f["severity"] == "high" and f["metric"]["value"] < 1


def test_capacity_and_concentration_rules():
    _, r = findings(simple(operations={"monthly_capacity_units": 800}))
    assert rules_of(r)["capacity"]["severity"] == "high"
    p = simple(suppliers=[{"name": "Only supplier", "share_pct": 90}])
    _, r = findings(p)
    sup = [f for f in r["findings"] if f["rule"] == "concentration" and "supplier" in f["metric"]["label"].lower()]
    assert sup and sup[0]["severity"] == "high"


def test_expansion_beyond_cash_is_critical():
    _, r = findings(simple(), new_branch={"setup_cost": 50000, "monthly_fixed_cost": 4000, "demand_share_pct": 60, "ramp_months": 3})
    f = rules_of(r)
    assert f["expansion"]["severity"] == "critical"
    assert f["cash_shortfall"]["severity"] == "critical"


def test_history_based_cost_trend_is_actual_data():
    p = Profile.model_validate(demo_profile())
    sim = engine.simulate(p, Levers(horizon_months=12, start_month="2027-01"))
    r = risk.analyse(p, sim, scope="baseline")
    trend = [f for f in r["findings"] if f["rule"] == "opex_vs_revenue"]
    assert trend and trend[0]["data_kind"] == "actual"
    assert not [f for f in r["findings"] if f["rule"] == "revenue_decline"]  # seasonal dip is not a decline


def test_weather_and_inflation_signals():
    p = Profile.model_validate({**demo_profile(), "industry": "agriculture"})
    days = [{"date": f"2026-11-{i + 1:02d}", "precipitation_sum": 5, "temperature_2m_max": 31} for i in range(16)]
    days[3]["precipitation_sum"] = 62
    sig = {"weather": {"status": "ok", "retrieved_at": "2026-10-22T00:00:00+00:00", "data": {"days": days}},
           "inflation": {"status": "ok", "data": {"country": "Philippines", "latest": {"year": "2025", "value": 6.2}}}}
    sim = engine.simulate(p, Levers(horizon_months=6))
    r = rules_of(risk.analyse(p, sim, scope="baseline", signals=sig))
    assert r["weather"]["severity"] == "high" and r["weather"]["data_kind"] == "forecast"
    assert r["inflation"]["severity"] == "moderate" and r["inflation"]["data_kind"] == "historical"
    failed = {"weather": {"status": "failed"}, "inflation": {"status": "unavailable"}}
    r2 = rules_of(risk.analyse(p, sim, scope="baseline", signals=failed))
    assert "weather" not in r2 and "inflation" not in r2


def test_risk_detection_works_without_ai(monkeypatch):
    monkeypatch.setattr(type(llm), "available", property(lambda self: False))
    p = Profile.model_validate(demo_profile())
    sim, risks = run(p, Levers(unit_cost_change_pct=15, horizon_months=12))
    assert risks["scenario"]["findings"]
    e = ai.explain(sim, risks["scenario"], p)
    assert e["mode"] == "calculation" and "not connected" in e["notice"]


# ------------------------------------------------------------------ AI layer

def test_interpret_without_ai_uses_labelled_rule_parser():
    p = Profile.model_validate(demo_profile())
    res = ai.interpret("What if I lower my selling price by 10%?", p)
    assert res["mode"] == "rules" and res["levers"] == {"price_change_pct": -10.0}
    assert "rule-based" in res["notice"]


def test_interpret_with_ai_validates_output(monkeypatch):
    p = Profile.model_validate(demo_profile())
    monkeypatch.setattr(type(llm), "available", property(lambda self: True))

    def fake(system, prompt, schema, effort="medium"):
        assert "Sunny Cup" not in prompt and "Quezon" not in prompt  # no business name or location sent
        return schema.model_validate({"levers_json": json.dumps({"price_change_pct": -10, "price_product_ids": ["classic", "made-up"]}),
                                      "recognized": [{"lever": "price_change_pct", "label": "Price", "value": -10, "source": "stated"}],
                                      "questions": [], "unrecognized": None, "name": "Milk tea −10%"})
    monkeypatch.setattr(llm, "structured", fake)
    res = ai.interpret("lower the price of my classic milk tea by 10%", p)
    assert res["mode"] == "ai" and res["levers"]["price_product_ids"] == ["classic"]  # unknown id dropped


def test_ai_failure_falls_back_to_rules(monkeypatch):
    p = Profile.model_validate(demo_profile())
    monkeypatch.setattr(type(llm), "available", property(lambda self: True))
    monkeypatch.setattr(llm, "structured", lambda *a, **k: None)
    monkeypatch.setattr(llm, "last_error", "Could not reach the AI service")
    res = ai.interpret("What if rent goes up by 15%?", p)
    assert res["mode"] == "rules" and res["levers"] == {"rent_change_pct": 15.0} and "failed" in res["notice"]


def test_ai_explanation_drops_invented_numbers(monkeypatch):
    p = Profile.model_validate(demo_profile())
    sim, risks = run(p, Levers(price_change_pct=-10, horizon_months=12, start_month="2027-01"))
    real = round(sim["delta"]["net_profit"]["scenario"])
    monkeypatch.setattr(type(llm), "available", property(lambda self: True))

    def fake(system, prompt, schema, effort="medium"):
        return schema.model_validate({
            "summary": f"Net profit would be {real:,} PHP over the period.",
            "key_points": ["Competitors usually match price cuts within 37,913 PHP of losses.", "Each cup earns less after the cut."],
            "risk_notes": [{"finding_id": "made-up", "explanation": "x"}],
            "recommendations": [{"text": "Test a smaller price cut.", "try_question": "What if I lower prices by 5%?"}],
            "next_scenarios": ["What if I raise prices by 5%?"], "caveats": ["The elasticity is an estimate."]})
    monkeypatch.setattr(llm, "structured", fake)
    e = ai.explain(sim, risks["scenario"], p)
    assert e["mode"] == "ai"
    assert e["summary"].startswith("Net profit would be")
    assert all("37,913" not in k for k in e["key_points"])
    assert e["dropped"] == 2 and e["risk_notes"] == []


def test_grounding_check_examples():
    assert ungrounded_numbers("Profit falls to ₱12,345.", [12345.0]) == []
    assert ungrounded_numbers("Margin is 8.2%", [0.082]) == []
    assert ungrounded_numbers("Sales rise 45%", [0.12]) == ["45%"]


def _transport(handler):
    return httpx.MockTransport(handler)


def test_openai_compatible_provider(monkeypatch):
    from app.config import settings
    monkeypatch.setattr(type(settings), "ai_enabled", property(lambda self: True))
    object.__setattr__(settings, "ai_provider", "openai_compatible")
    object.__setattr__(settings, "ai_base_url", "http://llm.local/v1")
    try:
        seen = {}

        def ok(req):
            seen["body"] = json.loads(req.content)
            content = json.dumps({"summary": "s", "trade_offs": ["t"], "caveats": []})
            return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})
        out = llm._openai_compatible("sys", "prompt", ai.AIComparison, transport=_transport(ok))
        assert out.summary == "s" and seen["body"]["response_format"]["type"] == "json_schema"
        bad = llm._openai_compatible("sys", "p", ai.AIComparison, transport=_transport(lambda r: httpx.Response(200, json={"choices": [{"message": {"content": "not json"}}]})))
        assert bad is None and "could not be used" in llm.last_error
        denied = llm._openai_compatible("sys", "p", ai.AIComparison, transport=_transport(lambda r: httpx.Response(401, json={})))
        assert denied is None and "rejected" in llm.last_error
        limited = llm._openai_compatible("sys", "p", ai.AIComparison, transport=_transport(lambda r: httpx.Response(429, json={})))
        assert limited is None and "rate limited" in llm.last_error
    finally:
        object.__setattr__(settings, "ai_provider", "anthropic")
        object.__setattr__(settings, "ai_base_url", "")


def test_missing_credentials_give_setup_message(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    from app.config import settings
    object.__setattr__(settings, "ai_disabled", False)
    try:
        st = llm.status()
        assert st["configured"] is False and "ANTHROPIC_API_KEY" in st["setup_hint"]
    finally:
        object.__setattr__(settings, "ai_disabled", True)


@pytest.mark.parametrize("q,expected", [
    ("What if I lower my selling price by 10%?", {"price_change_pct": -10.0}),
    ("What if ingredient costs increase by 15%?", {"unit_cost_change_pct": 15.0}),
    ("What if my monthly sales decrease by 20%?", {"demand_change_pct": -20.0}),
    ("What if I double the marketing budget?", {"marketing_change_pct": 100.0}),
    ("What if rent goes up by 15% over the next 6 months?", {"rent_change_pct": 15.0, "horizon_months": 6}),
])
def test_rule_parser_examples(q, expected):
    assert rules_parser.parse(q, Profile.model_validate(demo_profile()))["levers"] == expected


def test_rule_parser_marks_assumptions_and_asks():
    p = Profile.model_validate(demo_profile())
    r = rules_parser.parse("What if I open another branch?", p)
    assert r["levers"]["new_branch"]["setup_cost"] > 0
    assert any(x["source"] == "assumed" for x in r["recognized"]) and len(r["questions"]) >= 2
    r = rules_parser.parse("What if customer demand increases during the holiday season?", p)
    assert r["levers"]["seasonal"][0]["months"] == [11, 12]
    r = rules_parser.parse("Will it rain tomorrow?", p)
    assert r["levers"] == {} and r["unrecognized"]


def test_openai_compatible_needs_a_key_unless_local(monkeypatch):
    from app.config import settings
    monkeypatch.setenv("WHATIF_AI_MODEL", "anthropic/claude-opus-5.5")
    monkeypatch.delenv("WHATIF_AI_API_KEY", raising=False)
    object.__setattr__(settings, "ai_disabled", False)
    object.__setattr__(settings, "ai_provider", "openai_compatible")
    try:
        object.__setattr__(settings, "ai_base_url", "https://openrouter.ai/api/v1")
        assert settings.ai_enabled is False                      # hosted endpoint without a key: not connected
        monkeypatch.setenv("WHATIF_AI_API_KEY", "sk-or-v1-test")
        assert settings.ai_enabled is True
        monkeypatch.delenv("WHATIF_AI_API_KEY")
        object.__setattr__(settings, "ai_base_url", "http://localhost:11434/v1")
        assert settings.ai_enabled is True                       # local Ollama needs no key
    finally:
        object.__setattr__(settings, "ai_provider", "anthropic")
        object.__setattr__(settings, "ai_base_url", "")
        object.__setattr__(settings, "ai_disabled", True)


def test_openai_compatible_sends_output_cap_and_explains_402(monkeypatch):
    from app.config import settings
    monkeypatch.setattr(type(settings), "ai_enabled", property(lambda self: True))
    object.__setattr__(settings, "ai_provider", "openai_compatible")
    object.__setattr__(settings, "ai_base_url", "http://llm.local/v1")
    try:
        seen = {}

        def h(req):
            seen["body"] = json.loads(req.content)
            return httpx.Response(402, json={"error": {"message": "This request requires more credits, or fewer max_tokens."}})
        assert llm._openai_compatible("s", "p", ai.AIComparison, transport=httpx.MockTransport(h)) is None
        assert seen["body"]["max_tokens"] == settings.ai_max_tokens
        assert "needs more credits" in llm.last_error and "fewer max_tokens" in llm.last_error
    finally:
        object.__setattr__(settings, "ai_provider", "anthropic")
        object.__setattr__(settings, "ai_base_url", "")


def test_invalid_ai_levers_fall_back_to_rules(monkeypatch):
    p = Profile.model_validate(demo_profile())
    monkeypatch.setattr(type(llm), "available", property(lambda self: True))
    monkeypatch.setattr(llm, "structured", lambda system, prompt, schema, effort="medium": schema.model_validate(
        {"levers_json": '{"price_change_pct": -500}', "recognized": [], "questions": [], "unrecognized": None, "name": "x"}))
    res = ai.interpret("What if I lower my selling price by 10%?", p)
    assert res["mode"] == "rules" and res["levers"] == {"price_change_pct": -10.0} and "invalid levers" in res["notice"]


def test_portable_schema_strips_grammar_heavy_keywords():
    from app.agents.llm import _portable_schema
    from app.whatif.schemas import Levers
    txt = json.dumps(_portable_schema(Levers.model_json_schema()))
    assert '"pattern"' not in txt and '"maximum"' not in txt and '"minimum"' not in txt and '"properties"' in txt
