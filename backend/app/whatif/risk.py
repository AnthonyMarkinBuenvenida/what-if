"""Risk Radar: quantitative rules over a calculated projection.

Every warning comes from a rule in RULES with a written threshold. The rules
read engine output and the profile, never AI text. AI may later explain a
finding in plain language, but it cannot raise, lower or invent one.

Severity
    low       stable under the current assumptions (shown only as context)
    moderate  a developing issue that needs attention
    high      a material problem that may affect profitability or operations
    critical  a serious potential threat that needs prompt review

Overall score (0-100) = 100 x (1 - product over findings of (1 - weight)),
with weights critical 0.45, high 0.25, moderate 0.10, low 0.02. More and
worse findings raise the score; it never exceeds 100. The overall level is
the most severe finding.
"""
from __future__ import annotations

from .schemas import Profile

SEVERITY_ORDER = {"low": 0, "moderate": 1, "high": 2, "critical": 3}
WEIGHTS = {"critical": 0.45, "high": 0.25, "moderate": 0.10, "low": 0.02}

CATEGORIES = {
    "profitability": "Profitability", "cash": "Cash flow", "pricing": "Pricing", "costs": "Costs",
    "revenue": "Revenue", "operations": "Capacity & operations", "inventory": "Inventory",
    "marketing": "Marketing", "concentration": "Concentration", "expansion": "Expansion",
    "goals": "Goals", "external": "External conditions", "data": "Data quality",
}

# id: category, metric, thresholds (as written), why it matters
RULES: dict[str, dict] = {
    "net_margin": {"category": "profitability", "metric": "Net margin",
                   "thresholds": "critical < 0% · high < 5% · moderate < 10% (or below your minimum margin goal)",
                   "why": "Thin margins leave little room for cost increases or slow months."},
    "break_even": {"category": "profitability", "metric": "Units sold vs break-even units",
                   "thresholds": "high: below break-even · moderate: less than 10% above it",
                   "why": "Below break-even every month loses money before tax."},
    "unit_economics": {"category": "pricing", "metric": "Contribution per unit",
                       "thresholds": "critical: a product with ≥10% of revenue sells at or below its variable cost · high: any such product · moderate: contribution under 15% of price",
                       "why": "Selling below variable cost means more sales make losses larger."},
    "cash_shortfall": {"category": "cash", "metric": "Lowest cash balance",
                       "thresholds": "critical: cash below zero · high: below your minimum buffer · moderate: under 6 months of runway while cash is falling (high under 3)",
                       "why": "Running out of cash stops a business even when it is profitable on paper."},
    "profit_vs_baseline": {"category": "profitability", "metric": "Net profit vs current course",
                           "thresholds": "high: more than 25% lower · moderate: more than 10% lower",
                           "why": "The decision makes the business less profitable than doing nothing."},
    "opex_vs_revenue": {"category": "costs", "metric": "Operating cost growth vs revenue growth",
                        "thresholds": "moderate: operating costs grow more than 5 points faster than revenue · high: and net profit falls",
                        "why": "Costs growing faster than sales squeeze profit over time."},
    "revenue_decline": {"category": "revenue", "metric": "Revenue trend",
                        "thresholds": "past results: high < −8%/month, moderate < −3%/month · projection: high > 20% below current course, moderate > 10%",
                        "why": "Falling revenue erodes the ability to cover fixed costs."},
    "cost_pressure": {"category": "costs", "metric": "Gross margin change",
                      "thresholds": "high: gross margin falls by more than 8 points · moderate: by more than 3 points",
                      "why": "Rising input costs that are not passed on reduce every unit's profit."},
    "capacity": {"category": "operations", "metric": "Capacity use",
                 "thresholds": "high: more than 5% of demand cannot be served · moderate: above 95% of capacity · moderate: under 40% (idle capacity)",
                 "why": "Over capacity loses sales; far under capacity means paying for unused resources."},
    "inventory": {"category": "inventory", "metric": "Stockouts and stock cover",
                  "thresholds": "high: stockouts above 10% of demand · moderate: any stockouts or cover above 3 months",
                  "why": "Stockouts lose sales; excess stock ties up cash."},
    "marketing": {"category": "marketing", "metric": "Marketing spend and return",
                  "thresholds": "high: extra spending returns less gross profit than it costs, or spend > 25% of revenue · moderate: spend > 15% of revenue",
                  "why": "Advertising that does not pay for itself lowers profit."},
    "concentration": {"category": "concentration", "metric": "Largest product or supplier share",
                      "thresholds": "high: > 80% · moderate: > 60%",
                      "why": "Depending on one product or supplier makes the business fragile."},
    "expansion": {"category": "expansion", "metric": "One-time spending vs available cash, payback",
                  "thresholds": "critical: spending exceeds starting cash · high: leaves less than the cash buffer, or no payback within the period · moderate: payback over 24 months",
                  "why": "Expansion that outruns resources can cause a cash crisis."},
    "goal": {"category": "goals", "metric": "Monthly net profit vs your target",
             "thresholds": "high: below 50% of target · moderate: below target",
             "why": "The plan does not reach the profit you said you need."},
    "downside": {"category": "profitability", "metric": "Worst-case net profit",
                 "thresholds": "moderate: the worst case is a loss while the expected case is a profit",
                 "why": "Within your stated uncertainty, the outcome could be a loss."},
    "churn": {"category": "revenue", "metric": "Monthly churn and subscriber trend",
              "thresholds": "high: churn ≥ 8% · moderate: churn ≥ 5% or subscribers shrink over the period",
              "why": "High churn forces constant spending to stand still."},
    "weather": {"category": "external", "metric": "Forecast rain and heat (Open-Meteo)",
                "thresholds": "high: a day with ≥ 50 mm rain or 3 days ≥ 100 mm · moderate: a day ≥ 30 mm or ≥ 38 °C",
                "why": "Severe weather can damage crops or disrupt work and deliveries."},
    "inflation": {"category": "external", "metric": "Consumer price inflation (World Bank, latest year)",
                  "thresholds": "high: ≥ 10% per year · moderate: ≥ 5% per year",
                  "why": "General inflation tends to push supplier and wage costs up."},
    "data_quality": {"category": "data", "metric": "Share of estimated inputs",
                     "thresholds": "moderate: more than half of core figures are What-if estimates",
                     "why": "Results built on estimates describe a typical business, not yours."},
}


def _f(v, nd=0):
    return f"{v:,.{nd}f}"


def _pct(v, nd=1):
    return f"{v * 100:.{nd}f}%"


class _Collector:
    def __init__(self, scope: str, currency: str):
        self.items: list[dict] = []
        self.scope = scope
        self.cur = currency

    def add(self, rule: str, severity: str, title: str, summary: str, *, metric: dict, evidence: list[dict],
            triggered_by: list[str], impact: dict | None = None, actions: list[dict] | None = None, if_no_action: str = "",
            data_kind: str = "calculated"):
        r = RULES[rule]
        self.items.append({
            "id": f"{self.scope}:{rule}:{len(self.items)}", "rule": rule, "category": r["category"],
            "category_label": CATEGORIES[r["category"]], "severity": severity, "title": title, "summary": summary,
            "metric": metric, "evidence": evidence, "triggered_by": triggered_by, "impact": impact,
            "actions": actions or [], "if_no_action": if_no_action, "threshold": r["thresholds"], "why": r["why"],
            "data_kind": data_kind, "scope": self.scope,
        })


def _triggers(levers: dict) -> list[str]:
    out = []
    names = {"price_change_pct": "selling price", "unit_cost_change_pct": "variable cost", "demand_change_pct": "demand",
             "marketing_change_pct": "marketing budget", "wage_change_pct": "wages", "rent_change_pct": "rent",
             "fixed_cost_change_pct": "fixed costs", "capacity_change_pct": "capacity", "churn_change_pts": "churn"}
    for k, label in names.items():
        v = levers.get(k) or 0
        if v:
            out.append(f"{label} {'+' if v > 0 else ''}{v:g}{' pts' if k == 'churn_change_pts' else '%'}")
    if levers.get("marketing_budget") is not None:
        out.append(f"marketing budget set to {levers['marketing_budget']:,.0f}")
    for ch in levers.get("staff_changes") or []:
        out.append(f"{'+' if ch['count'] > 0 else ''}{ch['count']:g} {ch.get('role') or 'staff'}")
    if levers.get("new_branch"):
        out.append("new location")
    if levers.get("new_product"):
        out.append(f"new product ({levers['new_product'].get('name')})")
    if levers.get("one_time_investment"):
        out.append(f"one-time investment {levers['one_time_investment']:,.0f}")
    for s in levers.get("seasonal") or []:
        out.append(f"{s.get('label', 'seasonal change')} {s['demand_change_pct']:+g}%")
    return out


def analyse(profile: Profile, sim: dict, *, scope: str = "scenario", signals: dict | None = None) -> dict:
    """Run every rule on one simulation result (engine.simulate output)."""
    cur = profile.business.currency
    c = _Collector(scope, cur)
    is_scen = scope != "baseline" and not sim.get("is_baseline")
    pr = sim["scenario"] if scope != "baseline" else sim["baseline"]
    base = sim["baseline"]
    m, t, avg = pr["metrics"], pr["totals"], pr["monthly_avg"]
    bm, bt = base["metrics"], base["totals"]
    levers = sim["levers"] if is_scen else {}
    trig = _triggers(levers) if is_scen else ["current business profile"]
    H = pr["horizon_months"]
    goals = profile.goals

    # --- net margin
    nm = m["net_margin"]
    if nm is None:
        c.add("net_margin", "critical", "No revenue in the projection", "The projection has no sales, so every cost is a loss.",
              metric={"key": "net_margin", "label": "Net margin", "value": None, "threshold": 0, "unit": "%"},
              evidence=[{"label": "Revenue over the period", "value": 0, "unit": cur}], triggered_by=trig,
              impact={"value": t["net_profit"], "unit": cur, "period": f"{H} months", "label": "Net result"},
              if_no_action="All operating costs would be paid from cash.")
    else:
        floor = (goals.min_margin_pct / 100) if goals.min_margin_pct is not None else None
        sev = "critical" if nm < 0 else "high" if nm < 0.05 else "moderate" if (nm < 0.10 or (floor is not None and nm < floor)) else None
        if sev:
            title = {"critical": "Operating at a loss", "high": "Very thin profit margin", "moderate": "Thin profit margin"}[sev]
            c.add("net_margin", sev, title,
                  f"Net margin is {_pct(nm)} over {H} months (net profit {_f(t['net_profit'])} {cur} on revenue {_f(t['revenue'])} {cur}).",
                  metric={"key": "net_margin", "label": "Net margin", "value": nm, "threshold": 0 if sev == "critical" else 0.05 if sev == "high" else (floor or 0.10), "unit": "%"},
                  evidence=[{"label": "Net profit", "value": t["net_profit"], "unit": cur}, {"label": "Revenue", "value": t["revenue"], "unit": cur},
                            {"label": "Gross margin", "value": m["gross_margin"], "unit": "%"}],
                  triggered_by=trig,
                  impact={"value": t["net_profit"], "unit": cur, "period": f"{H} months", "label": "Net profit"},
                  actions=[{"label": "Test a 5% price increase", "levers": {"price_change_pct": 5}},
                           {"label": "Test 8% lower variable costs (supplier review)", "levers": {"unit_cost_change_pct": -8}},
                           {"label": "Test 10% lower fixed costs", "levers": {"fixed_cost_change_pct": -10}}],
                  if_no_action="Profit stays " + ("negative and cash keeps falling." if sev == "critical" else "small, so a modest cost increase or slow month could turn it into a loss."))

    # --- unit economics
    for p in pr["products"]:
        if p["price"] <= p["unit_cost"] and p["units"] > 0:
            share = p["share_of_revenue"] or 0
            sev = "critical" if share >= 0.10 else "high"
            c.add("unit_economics", sev, f"{p['name']} sells at or below its cost",
                  f"{p['name']} sells for {p['price']:,.2f} {cur} but costs {p['unit_cost']:,.2f} {cur} per unit, so each sale loses {p['unit_cost'] - p['price']:,.2f} {cur}.",
                  metric={"key": "contribution_per_unit", "label": f"Contribution per unit, {p['name']}", "value": p["price"] - p["unit_cost"], "threshold": 0, "unit": cur},
                  evidence=[{"label": "Selling price", "value": p["price"], "unit": cur}, {"label": "Variable cost", "value": p["unit_cost"], "unit": cur},
                            {"label": "Share of revenue", "value": share, "unit": "%"}],
                  triggered_by=trig, impact={"value": p["gross_profit"], "unit": cur, "period": f"{H} months", "label": "Gross profit on this product"},
                  actions=[{"label": f"Test a price at least 20% above cost for {p['name']}", "levers": {"price_change_pct": round((p['unit_cost'] * 1.2 / p['base_price'] - 1) * 100, 1) if p.get('base_price') else 10, "price_product_ids": [p["id"]]} if not p["is_new"] else {}}],
                  if_no_action="Selling more of this product makes the loss larger.")
        elif p["price"] > 0 and (p["price"] - p["unit_cost"]) / p["price"] < 0.15 and p["units"] > 0:
            c.add("unit_economics", "moderate", f"Low contribution on {p['name']}",
                  f"Only {_pct((p['price'] - p['unit_cost']) / p['price'])} of {p['name']}'s price is left after variable costs.",
                  metric={"key": "contribution_ratio", "label": f"Contribution ratio, {p['name']}", "value": (p["price"] - p["unit_cost"]) / p["price"], "threshold": 0.15, "unit": "%"},
                  evidence=[{"label": "Selling price", "value": p["price"], "unit": cur}, {"label": "Variable cost", "value": p["unit_cost"], "unit": cur}],
                  triggered_by=trig, actions=[{"label": "Test a 5% price increase", "levers": {"price_change_pct": 5, "price_product_ids": [p["id"]] if not p["is_new"] else []}}],
                  if_no_action="A small cost increase would wipe out this product's profit.")

    # --- break-even
    be = m["break_even_units"]
    if be is None and m["contribution_per_unit"] is not None and m["contribution_per_unit"] <= 0:
        c.add("break_even", "critical", "No break-even point",
              "On average, each unit sold costs more than it brings in, so no sales volume covers fixed costs.",
              metric={"key": "contribution_per_unit", "label": "Average contribution per unit", "value": m["contribution_per_unit"], "threshold": 0, "unit": cur},
              evidence=[{"label": "Revenue", "value": t["revenue"], "unit": cur}, {"label": "Variable costs", "value": t["variable_costs"], "unit": cur}],
              triggered_by=trig, actions=[{"label": "Test a 15% price increase", "levers": {"price_change_pct": 15}}],
              if_no_action="Losses grow with every sale.")
    elif be is not None and avg["units"] > 0:
        gap = (avg["units"] - be) / be
        if gap < 0 or gap < 0.10:
            sev = "high" if gap < 0 else "moderate"
            c.add("break_even", sev, "Sales below break-even" if gap < 0 else "Close to break-even",
                  f"Average sales of {_f(avg['units'])} {profile.unit_label}/month against a break-even of {_f(be)} ({'+' if gap >= 0 else ''}{gap * 100:.1f}%).",
                  metric={"key": "break_even_units", "label": "Units vs break-even", "value": avg["units"], "threshold": be, "unit": profile.unit_label},
                  evidence=[{"label": "Break-even units per month", "value": be, "unit": profile.unit_label},
                            {"label": "Average contribution per unit", "value": m["contribution_per_unit"], "unit": cur},
                            {"label": "Operating costs per month", "value": avg["operating_expenses"], "unit": cur}],
                  triggered_by=trig,
                  impact={"value": (avg["units"] - be) * m["contribution_per_unit"], "unit": cur, "period": "per month", "label": "Contribution above (below) break-even"},
                  actions=[{"label": "Test 10% more demand", "levers": {"demand_change_pct": 10}}, {"label": "Test 10% lower fixed costs", "levers": {"fixed_cost_change_pct": -10}}],
                  if_no_action="A small drop in sales would mean monthly losses." if gap >= 0 else "Each month loses money before tax.")

    # --- cash
    buf = profile.finance.min_cash_buffer
    if m["min_cash"] < 0:
        c.add("cash_shortfall", "critical", "Cash runs out",
              f"Cash falls below zero, reaching {_f(m['min_cash'])} {cur} in {m['min_cash_month']}.",
              metric={"key": "min_cash", "label": "Lowest cash", "value": m["min_cash"], "threshold": 0, "unit": cur},
              evidence=[{"label": "Starting cash", "value": m["starting_cash"], "unit": cur}, {"label": "Average monthly cash flow", "value": avg["cash_flow"], "unit": cur},
                        {"label": "One-time spending", "value": t["one_time"], "unit": cur}],
              triggered_by=trig, impact={"value": m["min_cash"], "unit": cur, "period": m["min_cash_month"], "label": "Cash shortfall"},
              actions=[{"label": "Test delaying the investment by 6 months", "levers": {"investment_month": min(36, (levers.get('investment_month') or 1) + 6)}} if levers.get("one_time_investment") else
                       {"label": "Test 10% lower fixed costs", "levers": {"fixed_cost_change_pct": -10}}],
              if_no_action="The business would need new funding or credit before the end of the period.")
    elif m["min_cash"] < buf:
        c.add("cash_shortfall", "high", "Cash drops below your buffer",
              f"Cash falls to {_f(m['min_cash'])} {cur} in {m['min_cash_month']}, under your minimum buffer of {_f(buf)} {cur}.",
              metric={"key": "min_cash", "label": "Lowest cash", "value": m["min_cash"], "threshold": buf, "unit": cur},
              evidence=[{"label": "Months below buffer", "value": m["months_below_buffer"], "unit": "months"}, {"label": "Starting cash", "value": m["starting_cash"], "unit": cur}],
              triggered_by=trig, impact={"value": m["min_cash"] - buf, "unit": cur, "period": m["min_cash_month"], "label": "Below buffer by"},
              actions=[{"label": "Test 10% lower fixed costs", "levers": {"fixed_cost_change_pct": -10}}],
              if_no_action="Little room is left for an unexpected bill or a slow month.")
    elif m["runway_months"] is not None and m["runway_months"] < 6:
        sev = "high" if m["runway_months"] < 3 else "moderate"
        c.add("cash_shortfall", sev, "Short cash runway",
              f"Cash falls by {_f(-avg['cash_flow'])} {cur} a month on average; starting cash covers about {m['runway_months']:.1f} months.",
              metric={"key": "runway_months", "label": "Runway", "value": m["runway_months"], "threshold": 3 if sev == "high" else 6, "unit": "months"},
              evidence=[{"label": "Average monthly cash flow", "value": avg["cash_flow"], "unit": cur}], triggered_by=trig,
              actions=[{"label": "Test a 5% price increase", "levers": {"price_change_pct": 5}}], if_no_action="Cash would run out soon after the period.")

    # --- scenario vs baseline
    if is_scen:
        d_np = t["net_profit"] - bt["net_profit"]
        if bt["net_profit"] > 0 and d_np < 0:
            drop = -d_np / bt["net_profit"]
            if drop > 0.10:
                sev = "high" if drop > 0.25 else "moderate"
                c.add("profit_vs_baseline", sev, "Less profit than the current course",
                      f"This decision lowers net profit by {_f(-d_np)} {cur} ({drop * 100:.1f}%) over {H} months compared with keeping things as they are.",
                      metric={"key": "net_profit", "label": "Net profit vs current course", "value": t["net_profit"], "threshold": bt["net_profit"], "unit": cur},
                      evidence=[{"label": "Current course net profit", "value": bt["net_profit"], "unit": cur}, {"label": "Scenario net profit", "value": t["net_profit"], "unit": cur}]
                      + [{"label": f"Effect of {b['label'].lower()}", "value": b["value"], "unit": cur} for b in sim.get("bridge", []) if b["value"] < 0][:3],
                      triggered_by=trig, impact={"value": d_np, "unit": cur, "period": f"{H} months", "label": "Change in net profit"},
                      if_no_action="Keeping the current course is more profitable under these assumptions.")
        d_rev = (t["revenue"] - bt["revenue"]) / bt["revenue"] if bt["revenue"] else 0
        d_opx = (t["operating_expenses"] - bt["operating_expenses"]) / bt["operating_expenses"] if bt["operating_expenses"] else 0
        if d_opx > 0 and d_opx - d_rev > 0.05:
            sev = "high" if d_np < 0 else "moderate"
            c.add("opex_vs_revenue", sev, "Costs grow faster than revenue",
                  f"Operating costs rise {d_opx * 100:.1f}% while revenue changes {d_rev * 100:+.1f}%.",
                  metric={"key": "operating_expenses", "label": "Operating cost growth", "value": d_opx, "threshold": d_rev + 0.05, "unit": "%"},
                  evidence=[{"label": "Operating costs, current course", "value": bt["operating_expenses"], "unit": cur},
                            {"label": "Operating costs, scenario", "value": t["operating_expenses"], "unit": cur},
                            {"label": "Revenue change", "value": d_rev, "unit": "%"}],
                  triggered_by=trig, impact={"value": t["operating_expenses"] - bt["operating_expenses"], "unit": cur, "period": f"{H} months", "label": "Extra operating costs"},
                  if_no_action="The extra costs need more sales than the scenario expects to pay for themselves.")
        if d_rev < -0.10:
            sev = "high" if d_rev < -0.20 else "moderate"
            c.add("revenue_decline", sev, "Revenue falls",
                  f"Revenue is {abs(d_rev) * 100:.1f}% lower than on the current course ({_f(t['revenue'])} vs {_f(bt['revenue'])} {cur}).",
                  metric={"key": "revenue", "label": "Revenue vs current course", "value": d_rev, "threshold": -0.10, "unit": "%"},
                  evidence=[{"label": "Current course revenue", "value": bt["revenue"], "unit": cur}, {"label": "Scenario revenue", "value": t["revenue"], "unit": cur}],
                  triggered_by=trig, impact={"value": t["revenue"] - bt["revenue"], "unit": cur, "period": f"{H} months", "label": "Revenue change"},
                  actions=[{"label": "Test 20% more marketing", "levers": {"marketing_change_pct": 20}}],
                  if_no_action="Lower revenue makes fixed costs a bigger share of every sale.")
        if bm["gross_margin"] is not None and m["gross_margin"] is not None:
            drop_pts = bm["gross_margin"] - m["gross_margin"]
            if drop_pts > 0.03 and (levers.get("unit_cost_change_pct") or 0) > 0:
                sev = "high" if drop_pts > 0.08 else "moderate"
                c.add("cost_pressure", sev, "Rising costs squeeze gross margin",
                      f"Gross margin falls from {_pct(bm['gross_margin'])} to {_pct(m['gross_margin'])} ({drop_pts * 100:.1f} points).",
                      metric={"key": "gross_margin", "label": "Gross margin", "value": m["gross_margin"], "threshold": bm["gross_margin"] - 0.03, "unit": "%"},
                      evidence=[{"label": "Variable cost change", "value": levers.get("unit_cost_change_pct"), "unit": "%"},
                                {"label": "Gross profit change", "value": t["gross_profit"] - bt["gross_profit"], "unit": cur}],
                      triggered_by=trig, impact={"value": t["gross_profit"] - bt["gross_profit"], "unit": cur, "period": f"{H} months", "label": "Gross profit change"},
                      actions=[{"label": "Test passing on half the cost increase", "levers": {**{k: levers[k] for k in ("unit_cost_change_pct",)}, "price_change_pct": round(levers['unit_cost_change_pct'] * (1 - (m['gross_margin'] or 0)) / 2, 1)}},
                               {"label": "Test a cheaper supplier (−8% cost)", "levers": {"unit_cost_change_pct": round((levers.get('unit_cost_change_pct') or 0) - 8, 1)}}],
                      if_no_action="Every unit sold earns less, so the same sales bring less profit.")
        # Marketing return: compare with the same scenario without the marketing change.
        if (levers.get("marketing_change_pct") or 0) > 0 or (levers.get("marketing_budget") is not None and levers["marketing_budget"] > profile.marketing.monthly_budget):
            from .engine import project
            from .schemas import Levers
            no_mkt = Levers.model_validate({**levers, "marketing_change_pct": 0, "marketing_budget": None})
            alt = project(profile, no_mkt)
            extra_gp = t["gross_profit"] - alt["totals"]["gross_profit"]
            extra_spend = t["marketing"] - alt["totals"]["marketing"]
            if extra_spend > 0:
                roi = extra_gp / extra_spend
                if roi < 1:
                    c.add("marketing", "high", "Extra advertising does not pay for itself",
                          f"The extra {_f(extra_spend)} {cur} of marketing brings an estimated {_f(extra_gp)} {cur} of gross profit ({roi:.2f} per 1 spent).",
                          metric={"key": "marketing_return", "label": "Gross profit per 1 of extra marketing", "value": roi, "threshold": 1, "unit": "×"},
                          evidence=[{"label": "Extra marketing spend", "value": extra_spend, "unit": cur}, {"label": "Extra gross profit", "value": extra_gp, "unit": cur},
                                    {"label": "Marketing response (assumption)", "value": profile.marketing.elasticity, "unit": ""}],
                          triggered_by=trig, impact={"value": extra_gp - extra_spend, "unit": cur, "period": f"{H} months", "label": "Net effect of the extra spend"},
                          actions=[{"label": "Test a smaller increase (+20%)", "levers": {"marketing_change_pct": 20}}],
                          if_no_action="Profit is lower than with the current budget, under the stated marketing response.")
    else:
        trend = sim.get("history_trend")
        if trend and trend.get("slope_pct_per_month") is not None and trend["slope_pct_per_month"] < -0.03:
            s = trend["slope_pct_per_month"]
            sev = "high" if s < -0.08 else "moderate"
            c.add("revenue_decline", sev, "Revenue has been falling",
                  f"Your entered results from {trend['first_month']} to {trend['last_month']} fall by about {abs(s) * 100:.1f}% of average revenue per month"
                  + (" after adjusting for seasonality." if trend.get("seasonally_adjusted") else "."),
                  metric={"key": "revenue_trend", "label": "Revenue trend (actual)", "value": s, "threshold": -0.03, "unit": "% per month"},
                  evidence=[{"label": f"Revenue {trend['first_month']}", "value": trend["first_revenue"], "unit": cur},
                            {"label": f"Revenue {trend['last_month']}", "value": trend["last_revenue"], "unit": cur}],
                  triggered_by=["entered monthly results"], data_kind="actual",
                  actions=[{"label": "Test whether 20% more marketing reverses it", "levers": {"marketing_change_pct": 20}}],
                  if_no_action="If the trend continues, revenue will fall below today's baseline.")
        if trend and trend.get("cost_slope_pct_per_month") is not None and trend.get("slope_pct_per_month") is not None \
                and trend["cost_slope_pct_per_month"] - trend["slope_pct_per_month"] > 0.02:
            c.add("opex_vs_revenue", "moderate", "Costs have been growing faster than revenue",
                  f"In your entered results, costs change {trend['cost_slope_pct_per_month'] * 100:+.1f}% a month and revenue {trend['slope_pct_per_month'] * 100:+.1f}%.",
                  metric={"key": "cost_trend", "label": "Cost trend minus revenue trend (actual)", "value": trend["cost_slope_pct_per_month"] - trend["slope_pct_per_month"], "threshold": 0.02, "unit": "% per month"},
                  evidence=[], triggered_by=["entered monthly results"], data_kind="actual", if_no_action="Margins will keep shrinking.")

    # --- capacity
    util = m["capacity_utilization"]
    lost_share = (t["lost_units"] / t["demand_units"]) if t["demand_units"] else 0
    if util is not None:
        if lost_share > 0.05:
            c.add("capacity", "high", "Demand exceeds capacity",
                  f"{_pct(lost_share)} of demand ({_f(t['lost_units'])} {profile.unit_label}) cannot be served over {H} months.",
                  metric={"key": "lost_share", "label": "Demand that cannot be served", "value": lost_share, "threshold": 0.05, "unit": "%"},
                  evidence=[{"label": "Average capacity per month", "value": m["capacity"], "unit": profile.unit_label}, {"label": "Capacity use", "value": util, "unit": "%"}],
                  triggered_by=trig, impact={"value": -t["lost_units"] * (m["contribution_per_unit"] or 0), "unit": cur, "period": f"{H} months", "label": "Contribution lost (estimate)"},
                  actions=[{"label": "Test 20% more capacity", "levers": {"capacity_change_pct": 20}}, {"label": "Test adding one person", "levers": {"staff_changes": [{"role": "Extra staff", "count": 1}]}}],
                  if_no_action="Customers are turned away at peak times.")
        elif util > 0.95:
            c.add("capacity", "moderate", "Running near full capacity",
                  f"Demand uses {_pct(util)} of capacity on average.",
                  metric={"key": "capacity_utilization", "label": "Capacity use", "value": util, "threshold": 0.95, "unit": "%"},
                  evidence=[{"label": "Average capacity per month", "value": m["capacity"], "unit": profile.unit_label}], triggered_by=trig,
                  actions=[{"label": "Test 15% more capacity", "levers": {"capacity_change_pct": 15}}], if_no_action="Any growth would be lost at peak times.")
        elif util < 0.40:
            c.add("capacity", "moderate", "Much of capacity is unused",
                  f"Demand uses only {_pct(util)} of capacity, so part of the staff or equipment cost is idle.",
                  metric={"key": "capacity_utilization", "label": "Capacity use", "value": util, "threshold": 0.40, "unit": "%"},
                  evidence=[{"label": "Average capacity per month", "value": m["capacity"], "unit": profile.unit_label}], triggered_by=trig,
                  actions=[{"label": "Test 20% more demand (promotion)", "levers": {"demand_change_pct": 20}}], if_no_action="Fixed costs stay high relative to sales.")

    # --- inventory
    if t["stockout_units"] > 0 and t["demand_units"]:
        so = t["stockout_units"] / t["demand_units"]
        if so > 0.001:
            sev = "high" if so > 0.10 else "moderate"
            c.add("inventory", sev, "Stockouts", f"Supplier limits leave {_pct(so)} of demand unfilled ({_f(t['stockout_units'])} {profile.unit_label}).",
                  metric={"key": "stockout_share", "label": "Demand lost to stockouts", "value": so, "threshold": 0.10 if sev == "high" else 0, "unit": "%"},
                  evidence=[], triggered_by=trig, impact={"value": -t["stockout_units"] * (m["contribution_per_unit"] or 0), "unit": cur, "period": f"{H} months", "label": "Contribution lost (estimate)"},
                  if_no_action="Sales are lost whenever stock runs out.")
    cover = m["inventory_cover_months"]
    if cover is not None and cover > 3:
        c.add("inventory", "moderate", "Excess stock", f"Stock at the end of the period covers {cover:.1f} months of sales, tying up {_f(m['inventory_value_end'] or 0)} {cur}.",
              metric={"key": "inventory_cover_months", "label": "Stock cover", "value": cover, "threshold": 3, "unit": "months"},
              evidence=[{"label": "Stock value at the end", "value": m["inventory_value_end"], "unit": cur}], triggered_by=trig,
              if_no_action="Cash stays tied up in stock that sells slowly.")

    # --- marketing share
    ms = m["marketing_share"]
    if ms is not None and ms > 0.15:
        sev = "high" if ms > 0.25 else "moderate"
        c.add("marketing", sev, "High advertising spend", f"Marketing is {_pct(ms)} of revenue.",
              metric={"key": "marketing_share", "label": "Marketing as share of revenue", "value": ms, "threshold": 0.25 if sev == "high" else 0.15, "unit": "%"},
              evidence=[{"label": "Marketing over the period", "value": t["marketing"], "unit": cur}], triggered_by=trig,
              actions=[{"label": "Test 25% less marketing", "levers": {"marketing_change_pct": -25}}], if_no_action="A large share of revenue goes to advertising.")

    # --- concentration
    top = max(pr["products"], key=lambda p: p["revenue"]) if pr["products"] else None
    if top and len(pr["products"]) >= 1 and (top["share_of_revenue"] or 0) > 0.60:
        sh = top["share_of_revenue"]
        sev = "high" if sh > 0.80 else "moderate"
        c.add("concentration", sev, f"Depends heavily on {top['name']}", f"{top['name']} brings {_pct(sh)} of revenue.",
              metric={"key": "top_product_share", "label": "Largest product's share of revenue", "value": sh, "threshold": 0.80 if sev == "high" else 0.60, "unit": "%"},
              evidence=[{"label": f"{top['name']} revenue", "value": top["revenue"], "unit": cur}], triggered_by=["product mix"],
              actions=[{"label": "Test a new product", "levers": {"new_product": {"name": "New product", "price": round(top['price'], 2), "unit_cost": round(top['unit_cost'], 2), "monthly_units": round(top['units'] / H * 0.2), "cannibalization_pct": 30}}}],
              if_no_action="A problem with this one product would hit most of the business.")
    for s in profile.suppliers:
        if s.share_pct > 60:
            sev = "high" if s.share_pct > 80 else "moderate"
            c.add("concentration", sev, f"Depends heavily on {s.name}", f"{s.share_pct:g}% of purchases come from {s.name}.",
                  metric={"key": "supplier_share", "label": "Largest supplier's share", "value": s.share_pct / 100, "threshold": 0.80 if sev == "high" else 0.60, "unit": "%"},
                  evidence=[], triggered_by=["supplier list"], data_kind="actual",
                  actions=[{"label": "Test a 10% cost rise if this supplier raises prices", "levers": {"unit_cost_change_pct": 10}}],
                  if_no_action="A price rise or delivery problem at this supplier would hit the whole business.")

    # --- expansion
    one_time = t["one_time"]
    if is_scen and one_time > 0:
        cash0 = profile.finance.starting_cash
        payback = sim.get("payback_months")
        if one_time > cash0:
            sev = "critical"
        elif cash0 - one_time < buf or payback is None or (payback and payback > H):
            sev = "high"
        elif payback and payback > 24:
            sev = "moderate"
        else:
            sev = None
        if sev:
            c.add("expansion", sev, "Expansion may exceed resources",
                  f"One-time spending of {_f(one_time)} {cur} against starting cash of {_f(cash0)} {cur}; "
                  + (f"payback in about {payback:.1f} months." if payback else "the extra monthly profit does not pay it back."),
                  metric={"key": "one_time", "label": "One-time spending vs starting cash", "value": one_time, "threshold": cash0, "unit": cur},
                  evidence=[{"label": "Starting cash", "value": cash0, "unit": cur}, {"label": "Cash buffer", "value": buf, "unit": cur},
                            {"label": "Payback (months)", "value": payback, "unit": "months"}],
                  triggered_by=trig, impact={"value": -one_time, "unit": cur, "period": "up front", "label": "One-time spending"},
                  actions=[{"label": "Test a slower ramp-up (6 months)", "levers": {"new_branch": {**levers["new_branch"], "ramp_months": 6}}} if levers.get("new_branch") else
                           {"label": "Test spreading the investment later", "levers": {"investment_month": 6}}],
                  if_no_action="The business may need outside funding to complete the plan.")

    # --- goal
    target = goals.target_monthly_profit
    if target is not None and target > 0 and avg["net_profit"] < target:
        sev = "high" if avg["net_profit"] < 0.5 * target else "moderate"
        c.add("goal", sev, "Below your profit target", f"Average net profit is {_f(avg['net_profit'])} {cur} a month against your target of {_f(target)} {cur}.",
              metric={"key": "monthly_net_profit", "label": "Monthly net profit vs target", "value": avg["net_profit"], "threshold": target, "unit": cur},
              evidence=[], triggered_by=trig, impact={"value": avg["net_profit"] - target, "unit": cur, "period": "per month", "label": "Gap to target"},
              if_no_action="The plan does not reach the profit you set as a goal.")

    # --- downside
    band = sim.get("bands" if scope != "baseline" else "baseline_bands")
    if band and band["worst"]["net_profit"] < 0 < t["net_profit"]:
        c.add("downside", "moderate", "The worst case is a loss",
              f"Expected net profit is {_f(t['net_profit'])} {cur}, but the worst case within your uncertainty ranges is {_f(band['worst']['net_profit'])} {cur}.",
              metric={"key": "worst_net_profit", "label": "Worst-case net profit", "value": band["worst"]["net_profit"], "threshold": 0, "unit": cur},
              evidence=[{"label": "Best case", "value": band["best"]["net_profit"], "unit": cur}], triggered_by=trig,
              if_no_action="A somewhat weaker month-to-month result than expected would mean a loss.")

    # --- churn
    if profile.subscription.enabled and m.get("churn_rate") is not None:
        ch = m["churn_rate"]
        start_subs = sum(p.monthly_units for p in profile.products)
        shrinking = (m["subscribers_end"] or 0) < start_subs
        if ch >= 0.08 or ch >= 0.05 or shrinking:
            sev = "high" if ch >= 0.08 else "moderate"
            c.add("churn", sev, "High churn" if ch >= 0.05 else "Subscriber base shrinks",
                  f"Monthly churn is {_pct(ch)}; subscribers go from {_f(start_subs)} to {_f(m['subscribers_end'])} over {H} months.",
                  metric={"key": "churn", "label": "Monthly churn", "value": ch, "threshold": 0.08 if sev == "high" else 0.05, "unit": "%"},
                  evidence=[{"label": "Subscribers at the end", "value": m["subscribers_end"], "unit": "subscribers"}], triggered_by=trig,
                  actions=[{"label": "Test 1 point lower churn", "levers": {"churn_change_pts": -1}}, {"label": "Test 30% more sign-ups", "levers": {"new_customers_change_pct": 30}}],
                  if_no_action="Revenue falls unless new sign-ups replace the customers who leave.")

    # --- external signals (observed / forecast data, labelled as such)
    for f in _external_findings(profile, signals or {}, cur):
        c.add(**f)

    # --- data quality
    conf = sim.get("confidence") or {}
    if (conf.get("default_share") or 0) > 0.5:
        c.add("data_quality", "moderate", "Results rely mostly on estimates",
              f"{conf['default_share'] * 100:.0f}% of the core business figures are What-if estimates.",
              metric={"key": "default_share", "label": "Share of estimated inputs", "value": conf["default_share"], "threshold": 0.5, "unit": "%"},
              evidence=[], triggered_by=["business setup"], if_no_action="Results describe a typical business of this kind, not yours.")

    items = sorted(c.items, key=lambda i: (-SEVERITY_ORDER[i["severity"]], i["category"]))
    score = 1.0
    for i in items:
        score *= (1 - WEIGHTS[i["severity"]])
    score = round(100 * (1 - score))
    level = items[0]["severity"] if items else "low"
    counts = {s: sum(1 for i in items if i["severity"] == s) for s in SEVERITY_ORDER}
    return {"scope": scope, "score": score, "level": level, "counts": counts, "findings": items,
            "method": "Score = 100 × (1 − Π(1 − weight)), weights: critical 0.45, high 0.25, moderate 0.10. Level = most severe finding."}


def _external_findings(profile: Profile, signals: dict, cur: str) -> list[dict]:
    out = []
    w = signals.get("weather")
    if w and w.get("status") in ("ok", "stale") and profile.industry in ("agriculture", "food_beverage"):
        days = w["data"]["days"]
        rain = [(d["date"], d.get("precipitation_sum") or 0) for d in days]
        heat = [(d["date"], d.get("temperature_2m_max")) for d in days if d.get("temperature_2m_max") is not None]
        max_rain = max(rain, key=lambda x: x[1]) if rain else None
        three = max((sum(r for _, r in rain[i:i + 3]), rain[i][0]) for i in range(max(1, len(rain) - 2))) if len(rain) >= 3 else (0, None)
        max_heat = max(heat, key=lambda x: x[1]) if heat else None
        sev = None
        if max_rain and (max_rain[1] >= 50 or three[0] >= 100):
            sev = "high"
        elif (max_rain and max_rain[1] >= 30) or (max_heat and max_heat[1] >= 38):
            sev = "moderate"
        if sev and (profile.industry == "agriculture" or sev == "high"):
            out.append(dict(rule="weather", severity=sev, title="Severe weather in the forecast",
                            summary=f"Open-Meteo forecasts up to {max_rain[1]:.0f} mm of rain on {max_rain[0]}" + (f" and highs of {max_heat[1]:.0f} °C" if max_heat else "") + f" near {profile.location.city or 'your location'}.",
                            metric={"key": "max_daily_rain", "label": "Highest forecast daily rain", "value": max_rain[1], "threshold": 50 if sev == "high" else 30, "unit": "mm"},
                            evidence=[{"label": "Wettest 3 days", "value": three[0], "unit": "mm"}, {"label": "Forecast retrieved", "value": w["retrieved_at"], "unit": ""}],
                            triggered_by=["weather forecast"], data_kind="forecast",
                            actions=[{"label": "Test a 30% harvest/demand drop next month", "levers": {"seasonal": [{"months": [_next_month()], "demand_change_pct": -30, "label": "Weather disruption"}]}}],
                            if_no_action="Field work, harvests or deliveries could be disrupted."))
    infl = signals.get("inflation")
    if infl and infl.get("status") in ("ok", "stale"):
        latest = (infl["data"] or {}).get("latest") or {}
        v = latest.get("value")
        if v is not None and v >= 5:
            sev = "high" if v >= 10 else "moderate"
            out.append(dict(rule="inflation", severity=sev, title="High inflation",
                            summary=f"Consumer prices in {infl['data'].get('country')} rose {v:.1f}% in {latest.get('year')} (World Bank, latest published year).",
                            metric={"key": "inflation", "label": "Consumer price inflation", "value": v / 100, "threshold": 0.10 if sev == "high" else 0.05, "unit": "% per year"},
                            evidence=[{"label": "Year", "value": latest.get("year"), "unit": ""}], triggered_by=["World Bank indicator FP.CPI.TOTL.ZG"], data_kind="historical",
                            actions=[{"label": f"Test variable costs +{v:.0f}%", "levers": {"unit_cost_change_pct": round(v, 1)}}],
                            if_no_action="Supplier prices and wages may keep rising."))
    return out


def _next_month() -> int:
    from datetime import date
    return date.today().month % 12 + 1


def rules_catalog() -> list[dict]:
    return [{"id": k, **v, "category_label": CATEGORIES[v["category"]]} for k, v in RULES.items()]
