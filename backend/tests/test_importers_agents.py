import io

import pytest

from app.agents.llm import ungrounded_numbers
from app.agents.workflow import _extract_rule_based, decision_analyst, digital_twin_agent, scenario_designer
from app.domain.retail import grocery_template
from app.engine.analysis import compare_runs
from app.engine.simulation import simulate
from app.importers import ImportErrorWithReport, apply_import_to_spec, parse_import


def test_products_csv_validation_reports_rows():
    csv = b"name,price,cost,stock,shelf_life\nApples,1.2,0.6,100,7\nBad,abc,0.5,10,\nNeg,2,1,-4,\nLoss,1,2,10,\nApples,1,1,1,\n"
    out = parse_import("products", "p.csv", csv)
    rep = out["report"]
    assert rep["accepted_rows"] == 3 and rep["rejected_rows"] == 2
    msgs = " ".join(e["message"] for e in rep["errors"])
    assert "not a number" in msgs and "negative" in msgs
    assert any("below cost" in w["message"] for w in rep["warnings"])
    assert any("Duplicate" in w["message"] for w in rep["warnings"])
    assert [p["name"] for p in out["parsed"]["products"]] == ["Apples", "Loss"]


def test_missing_required_columns():
    out = parse_import("products", "p.csv", b"name,stock\nA,1\n")
    assert out["report"]["missing_columns"] == ["price", "unit_cost"]
    assert out["parsed"] == {}


def test_unsupported_format_and_empty():
    with pytest.raises(ImportErrorWithReport):
        parse_import("products", "p.pdf", b"x")
    with pytest.raises(ImportErrorWithReport):
        parse_import("products", "p.csv", b"")


def test_sales_inference_and_gaps():
    rows = ["date,product,units,stock_on_hand"]
    for d in range(1, 29):
        if d == 10:
            continue  # a gap day
        rows.append(f"2026-02-{d:02d},Fresh produce,{10 if d % 2 else 20},{100}")
    rows.append("2026-02-03,Fresh produce,5,2")  # duplicate day and sold more than stock
    out = parse_import("sales", "s.csv", "\n".join(rows).encode(), grocery_template()["products"])
    p = out["parsed"]["products"][0]
    assert p["matched_product_id"] == "produce"
    assert out["parsed"]["history_days"] == 28
    total = sum(10 if d % 2 else 20 for d in range(1, 29) if d != 10) + 5
    assert p["avg_daily_demand"] == pytest.approx(total / 28, rel=1e-3)
    w = " ".join(x["message"] for x in out["report"]["warnings"])
    assert "no sales rows" in w and "Second row" in w and "stock on hand was 2" in w
    spec, changes = apply_import_to_spec(grocery_template(), "sales", out["parsed"])
    prod = next(x for x in spec["products"] if x["id"] == "produce")
    assert prod["avg_daily_demand"] == p["avg_daily_demand"]
    assert spec["provenance"]["products.produce.avg_daily_demand"] == "inferred"


def test_xlsx_import_and_apply_products():
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.append(["Product", "Selling Price", "Cost Price", "On hand"])
    ws.append(["Fresh produce", 3.5, 2.0, 650])
    ws.append(["Olive oil", 9.0, 6.0, 40])
    buf = io.BytesIO()
    wb.save(buf)
    out = parse_import("products", "p.xlsx", buf.getvalue())
    assert out["report"]["accepted_rows"] == 2
    spec, changes = apply_import_to_spec(grocery_template(), "products", out["parsed"])
    produce = next(x for x in spec["products"] if x["id"] == "produce")
    assert produce["price"] == 3.5 and spec["provenance"]["products.produce.price"] == "confirmed"
    assert any(x["name"] == "Olive oil" for x in spec["products"])
    assert any("Added product Olive oil" in c for c in changes)


def test_expenses_import_rejects_unknown_frequency():
    out = parse_import("expenses", "e.csv", b"name,amount,frequency\nShop rent,5000,monthly\nPower,300,quarterly\n")
    assert len(out["parsed"]["expenses"]) == 1 and out["parsed"]["expenses"][0]["category"] == "rent"
    assert any("quarterly" in w["message"] for w in out["report"]["warnings"])


def test_rule_based_fact_extraction_does_not_invent():
    f = _extract_rule_based("I operate a neighborhood grocery store. I want to reduce expired inventory and determine whether starting a delivery service would increase profit without exceeding my $15,000 budget.")
    assert f.business_type == "grocery" and f.stated_budget == 15000
    assert set(["delivery", "waste", "inventory"]) <= set(f.mentioned_topics)
    assert f.stated_starting_cash is None and f.stated_monthly_rent is None


def test_twin_agent_tags_only_stated_facts(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    out = digital_twin_agent("Corner Market", "grocery", "We have a $20k budget and want to try delivery.")
    assert out["mode"] == "deterministic" and out["notes"]
    spec = out["output"]["spec"]
    assert spec["goals"]["max_investment_budget"] == 20000
    assert spec["provenance"]["goals.max_investment_budget"] == "user"
    assert spec["provenance"]["finance.starting_cash"] == "default"


def test_scenario_designer_rules(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    out = scenario_designer("Should I start delivery? Also too much produce expires.", grocery_template())
    names = [p["name"] for p in out["output"]["proposals"]]
    assert names[0] == "Baseline World" and names[-1] == "Economic Stress World"
    assert "Delivery Service World" in names and "Lean Ordering World" in names


def test_decision_analyst_prefers_viable_over_highest_profit(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    spec = grocery_template()
    cfg = {"mode": "deterministic", "horizon_days": 30}
    crit = {"min_cash_floor": 8000, "max_investment": 15000}
    base = {"id": 1, "scenario_name": "Base", "color_index": 0, "model_version_id": 1, "results": simulate(spec, {}, cfg, crit)}
    # Highest profit but blows the investment budget.
    risky = {"id": 2, "scenario_name": "Risky", "color_index": 1, "model_version_id": 1,
             "results": simulate(spec, {"price_change_pct": 6, "one_time_investment": 30000}, cfg, crit)}
    cmp = compare_runs([base, risky])
    assert cmp["rows"][1]["avg_monthly_operating_profit"]["mean"] > cmp["rows"][0]["avg_monthly_operating_profit"]["mean"]
    out = decision_analyst(cmp, {"risk_tolerance": "medium"})
    assert out["output"]["recommended_run_id"] == 1
    assert "Risky" in out["output"]["recommendation"]


def test_grounding_check():
    facts = [4246.3, 0.29, 203145.0]
    assert ungrounded_numbers("Median profit is $4,246 a month and 29% of runs meet the target.", facts) == []
    assert ungrounded_numbers("Profit could reach $9,900 per month.", facts) == ["$9,900"]
    assert ungrounded_numbers("Run 3 of 5 steps in 2026.", facts) == []
