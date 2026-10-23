"""What-if calculation engine: deterministic, monthly, fully traceable.

Ordinary arithmetic only. Language models never produce or change these
numbers; they can only read them. The same profile and levers always give the
same result.

Per month t (calendar month m) and product p:

    demand    d = units_p x (price factor)^elasticity_p x (1 + demand change)
                  x marketing factor x season_m x seasonal shifts_m x (1 + growth)^t
                  x (1 + new-branch share x ramp_t)
              subscription businesses: subscribers_t = subscribers_{t-1} x (1 - churn) + new_t,
              where only new sign-ups respond to price and marketing
    marketing factor = (new spend / current spend)^marketing elasticity, spend floored at 5%
              of today's; with no spend today, extra units = units per 1,000 x spend / 1,000
    capacity  sales are capped by capacity (fixed, or staff x capacity per person); the excess is lost demand
    inventory if stock is tracked, the business buys what it needs to serve demand and return to its
              normal stock level, limited by the supplier's monthly maximum; unmet demand is a stockout

    Revenue           = selling price x units sold
    Variable costs    = variable cost per unit x units sold
    Gross profit      = revenue - variable costs
    Operating costs   = staff + rent + other fixed costs + marketing (+ new-branch running costs)
    Operating profit  = gross profit - operating costs
    Tax               = tax rate x positive operating profit (monthly, no loss carry-forward)
    Net profit        = operating profit - tax
    Net margin        = net profit / revenue          (undefined when revenue is zero)
    Break-even units  = operating costs / contribution per unit   (none when contribution <= 0)
    Cash flow         = net profit + (variable costs - inventory purchases) - one-time spending - debt payments

One-time spending (investments, branch set-up, product launch) is shown
separately from profit and only affects cash.
"""
from __future__ import annotations

import math
from datetime import date, datetime, timezone
from itertools import product as cartesian

from .schemas import Levers, Profile

ENGINE_VERSION = "whatif-engine 1.0"
MARKETING_FLOOR = 0.05
EPS = 1e-9

METRIC_LABELS = {
    "revenue": "Revenue", "units": "Units sold", "variable_costs": "Variable costs", "gross_profit": "Gross profit",
    "staff_costs": "Staff costs", "fixed_costs": "Rent & fixed costs", "marketing": "Marketing",
    "operating_expenses": "Operating costs", "operating_profit": "Operating profit", "tax": "Tax",
    "net_profit": "Net profit", "one_time": "One-time spending", "cash_flow": "Cash flow",
}


def _start(levers: Levers) -> tuple[int, int]:
    if levers.start_month:
        y, m = levers.start_month.split("-")
        return int(y), int(m)
    today = date.today()
    return (today.year + (today.month == 12), today.month % 12 + 1)


def _months(levers: Levers) -> list[tuple[int, int]]:
    y, m = _start(levers)
    out = []
    for _ in range(levers.horizon_months):
        out.append((y, m))
        m += 1
        if m > 12:
            y, m = y + 1, 1
    return out


def _r(v: float | None, nd: int = 2) -> float | None:
    if v is None or (isinstance(v, float) and (math.isnan(v) or math.isinf(v))):
        return None
    return round(v, nd)


def _div(a: float, b: float) -> float | None:
    return a / b if abs(b) > EPS else None


def capacity_today(profile: Profile) -> float | None:
    ops = profile.operations
    if ops.capacity_per_staff:
        return ops.capacity_per_staff * sum(s.count for s in profile.staff)
    return ops.monthly_capacity_units


def project(profile: Profile, levers: Levers, *, demand_mult: float = 1.0, cost_mult: float = 1.0,
            elasticity_shift: float = 0.0) -> dict:
    """Project one scenario month by month. The keyword arguments are used for best/worst cases."""
    L = levers
    months = _months(L)
    H = len(months)
    prods = profile.products
    season = profile.growth.seasonality
    s_mean = sum(season) / 12
    season = [x / s_mean for x in season]
    sub = profile.subscription.enabled
    flags: list[str] = []

    targeted_price = set(L.price_product_ids or [p.id for p in prods])
    targeted_cost = set(L.cost_product_ids or [p.id for p in prods])
    pf = {p.id: (1 + L.price_change_pct / 100) if p.id in targeted_price else 1.0 for p in prods}
    cf = {p.id: ((1 + L.unit_cost_change_pct / 100) if p.id in targeted_cost else 1.0) * cost_mult for p in prods}
    el = {p.id: min(1.0, (L.elasticity_override if L.elasticity_override is not None else p.elasticity) + elasticity_shift) for p in prods}
    price_eff = {p.id: pf[p.id] ** el[p.id] for p in prods}
    price1 = {p.id: p.price * pf[p.id] for p in prods}
    cost1 = {p.id: p.unit_cost * cf[p.id] for p in prods}
    dmult = (1 + L.demand_change_pct / 100) * demand_mult

    mkt0 = profile.marketing.monthly_budget
    mkt1 = L.marketing_budget if L.marketing_budget is not None else mkt0 * (1 + L.marketing_change_pct / 100)
    extra_units = 0.0
    if mkt0 > 0:
        mfac = (max(mkt1, MARKETING_FLOOR * mkt0) / mkt0) ** profile.marketing.elasticity
    else:
        mfac = 1.0
        if mkt1 > 0:
            if profile.marketing.units_per_1000:
                extra_units = profile.marketing.units_per_1000 * mkt1 / 1000
            else:
                flags.append("marketing_response_unknown")

    base_units_total = sum(p.monthly_units for p in prods) or 0.0
    share = {p.id: (p.monthly_units / base_units_total) if base_units_total > 0 else 1 / len(prods) for p in prods}

    nb = L.new_branch
    npd = L.new_product

    # Staff and fixed costs (constant across months)
    wage_mult = 1 + L.wage_change_pct / 100
    head = sum(s.count for s in profile.staff)
    avg_wage = (sum(s.count * s.monthly_wage for s in profile.staff) / head) if head > 0 else None
    staff_cost = sum(s.count * s.monthly_wage for s in profile.staff) * wage_mult
    head_after = head
    for ch in L.staff_changes:
        wage = ch.monthly_wage if ch.monthly_wage is not None else avg_wage
        if wage is None:
            flags.append("new_staff_wage_unknown")
            wage = 0.0
        staff_cost += ch.count * wage * wage_mult
        head_after += ch.count
    staff_cost = max(0.0, staff_cost)
    head_after = max(0.0, head_after)
    rent = sum(c.monthly_amount for c in profile.fixed_costs if c.category == "rent") * (1 + L.rent_change_pct / 100)
    other_fixed = sum(c.monthly_amount for c in profile.fixed_costs if c.category != "rent") * (1 + L.fixed_cost_change_pct / 100)
    branch_fixed = nb.monthly_fixed_cost if nb else 0.0
    fixed = rent + other_fixed + branch_fixed + sum(c.amount for c in L.extra_monthly_costs)
    tax_rate = (L.tax_rate_pct if L.tax_rate_pct is not None else profile.finance.tax_rate_pct) / 100

    ops = profile.operations
    if ops.capacity_per_staff:
        cap_base = ops.capacity_per_staff * head_after
    else:
        cap_base = ops.monthly_capacity_units
    if cap_base is not None:
        cap_base *= (1 + L.capacity_change_pct / 100) * (1 + (nb.demand_share_pct / 100 if nb else 0))

    churn = min(1.0, max(0.0, (profile.subscription.monthly_churn_pct + L.churn_change_pts) / 100))
    subs = {p.id: p.monthly_units for p in prods}
    stock = {p.id: p.stock_units for p in prods}
    target_stock = {p.id: p.stock_units for p in prods}

    acc = {p.id: {"units": 0.0, "revenue": 0.0, "vc": 0.0, "units_base_price": 0.0} for p in prods}
    new_acc = {"units": 0.0, "revenue": 0.0, "vc": 0.0}
    rows = []
    cash = profile.finance.starting_cash
    for t, (yy, mm) in enumerate(months):
        s_m = season[mm - 1]
        shift = 1.0
        for sh in L.seasonal:
            if mm in sh.months and (sh.year_month is None or sh.year_month == f"{yy:04d}-{mm:02d}"):
                shift *= max(0.0, 1 + sh.demand_change_pct / 100)
        g_t = (1 + profile.growth.monthly_growth_pct / 100) ** t
        ramp = 1.0 if (not nb or nb.ramp_months == 0) else min(1.0, (t + 1) / nb.ramp_months)
        b_t = 1 + ((nb.demand_share_pct / 100) * ramp if nb else 0.0)
        common = dmult * mfac * s_m * shift * g_t * b_t

        demand: dict[str, float] = {}
        if sub:
            new_total = profile.subscription.new_customers_per_month * (1 + L.new_customers_change_pct / 100) * common
            new_total += extra_units * s_m * shift * g_t * b_t * dmult
            for p in prods:
                subs[p.id] = max(0.0, subs[p.id] * (1 - churn) + new_total * share[p.id] * price_eff[p.id])
                demand[p.id] = subs[p.id]
        else:
            for p in prods:
                demand[p.id] = max(0.0, (p.monthly_units * common + extra_units * share[p.id] * s_m * shift * g_t * b_t * dmult) * price_eff[p.id])
        new_units = 0.0
        if npd:
            new_units = npd.monthly_units * dmult * mfac * s_m * shift * g_t * b_t
            taken = new_units * npd.cannibalization_pct / 100
            total_existing = sum(demand.values())
            if total_existing > 0:
                for pid in demand:
                    demand[pid] = max(0.0, demand[pid] - taken * demand[pid] / total_existing)
        total_demand = sum(demand.values()) + new_units

        ratio = 1.0
        cap_t = cap_base
        if cap_t is not None and total_demand > cap_t:
            ratio = cap_t / total_demand if total_demand > 0 else 0.0
        lost = total_demand * (1 - ratio)

        revenue = vc = purchases = 0.0
        stockout = 0.0
        units_sold = 0.0
        inv_units = 0.0
        inv_value = 0.0
        for p in prods:
            want = demand[p.id] * ratio
            if stock[p.id] is not None:
                need = max(0.0, want + target_stock[p.id] - stock[p.id])
                buy = min(need, p.restock_units_per_month) if p.restock_units_per_month is not None else need
                available = stock[p.id] + buy
                sold = min(want, available)
                stockout += want - sold
                stock[p.id] = available - sold
                purchases += buy * cost1[p.id]
                inv_units += stock[p.id]
                inv_value += stock[p.id] * cost1[p.id]
            else:
                sold = want
                purchases += sold * cost1[p.id]
            r = sold * price1[p.id]
            c = sold * cost1[p.id]
            revenue += r
            vc += c
            units_sold += sold
            a = acc[p.id]
            a["units"] += sold
            a["revenue"] += r
            a["vc"] += c
        if npd:
            sold_new = new_units * ratio
            r, c = sold_new * npd.price, sold_new * npd.unit_cost
            revenue += r
            vc += c
            purchases += c
            units_sold += sold_new
            new_acc["units"] += sold_new
            new_acc["revenue"] += r
            new_acc["vc"] += c

        gross = revenue - vc
        opex = staff_cost + fixed + mkt1
        op_profit = gross - opex
        tax = max(0.0, op_profit) * tax_rate
        net = op_profit - tax
        one_time = 0.0
        if L.one_time_investment and L.investment_month == t + 1:
            one_time += L.one_time_investment
        if t == 0:
            one_time += (nb.setup_cost if nb else 0.0) + (npd.launch_cost if npd else 0.0)
        cash_flow = net + (vc - purchases) - one_time - profile.finance.monthly_debt_payment
        cash += cash_flow
        rows.append({
            "month": f"{yy:04d}-{mm:02d}", "demand_units": total_demand, "units": units_sold, "lost_units": lost,
            "stockout_units": stockout, "capacity": cap_t, "revenue": revenue, "variable_costs": vc, "gross_profit": gross,
            "staff_costs": staff_cost, "fixed_costs": fixed, "marketing": mkt1, "operating_expenses": opex,
            "operating_profit": op_profit, "tax": tax, "net_profit": net, "one_time": one_time, "purchases": purchases,
            "cash_flow": cash_flow, "cash": cash, "inventory_units": inv_units if any(v is not None for v in stock.values()) else None,
            "inventory_value": inv_value if any(v is not None for v in stock.values()) else None,
        })

    sums = {k: sum(r[k] for r in rows) for k in ("demand_units", "units", "lost_units", "stockout_units", "revenue", "variable_costs",
                                                   "gross_profit", "staff_costs", "fixed_costs", "marketing", "operating_expenses",
                                                   "operating_profit", "tax", "net_profit", "one_time", "purchases", "cash_flow")}
    avg = {k: v / H for k, v in sums.items()}
    contribution = sums["revenue"] - sums["variable_costs"]
    cpu = _div(contribution, sums["units"])
    cratio = _div(contribution, sums["revenue"])
    be_units = (avg["operating_expenses"] / cpu) if (cpu is not None and cpu > EPS) else None
    be_revenue = (avg["operating_expenses"] / cratio) if (cratio is not None and cratio > EPS) else None
    if sums["revenue"] <= EPS:
        flags.append("zero_revenue")
    if cpu is not None and cpu <= EPS:
        flags.append("no_break_even")
    caps = [r["capacity"] for r in rows if r["capacity"] is not None]
    min_row = min(rows, key=lambda r: r["cash"])
    avg_cf = avg["cash_flow"]
    start_cash = profile.finance.starting_cash
    runway = None
    if avg_cf < -EPS:
        runway = max(0.0, start_cash / -avg_cf) if start_cash > 0 else 0.0
    end_inv = rows[-1]["inventory_units"]

    product_rows = []
    for p in prods:
        a = acc[p.id]
        product_rows.append({
            "id": p.id, "name": p.name, "is_new": False, "price": price1[p.id], "base_price": p.price,
            "unit_cost": cost1[p.id], "base_unit_cost": p.unit_cost, "elasticity": el[p.id],
            "units": a["units"], "revenue": a["revenue"], "variable_costs": a["vc"], "gross_profit": a["revenue"] - a["vc"],
            "contribution_per_unit": price1[p.id] - cost1[p.id],
        })
    if npd:
        product_rows.append({"id": "new-product", "name": npd.name, "is_new": True, "price": npd.price, "base_price": None,
                             "unit_cost": npd.unit_cost, "base_unit_cost": None, "elasticity": None, "units": new_acc["units"],
                             "revenue": new_acc["revenue"], "variable_costs": new_acc["vc"],
                             "gross_profit": new_acc["revenue"] - new_acc["vc"], "contribution_per_unit": npd.price - npd.unit_cost})
    for pr in product_rows:
        pr["share_of_revenue"] = _div(pr["revenue"], sums["revenue"])

    metrics = {
        "net_margin": _div(sums["net_profit"], sums["revenue"]),
        "gross_margin": _div(sums["gross_profit"], sums["revenue"]),
        "operating_margin": _div(sums["operating_profit"], sums["revenue"]),
        "contribution_per_unit": cpu, "contribution_ratio": cratio,
        "break_even_units": be_units, "break_even_revenue": be_revenue,
        "safety_margin": _div(avg["units"] - be_units, avg["units"]) if be_units is not None else None,
        "capacity": (sum(caps) / len(caps)) if caps else None,
        "capacity_utilization": _div(sums["demand_units"], sum(caps)) if caps else None,
        "lost_share": _div(sums["lost_units"] + sums["stockout_units"], sums["demand_units"]),
        "starting_cash": start_cash, "ending_cash": rows[-1]["cash"], "min_cash": min_row["cash"], "min_cash_month": min_row["month"],
        "months_below_buffer": sum(1 for r in rows if r["cash"] < profile.finance.min_cash_buffer),
        "runway_months": runway,
        "inventory_cover_months": _div(end_inv, avg["units"]) if end_inv is not None else None,
        "inventory_value_end": rows[-1]["inventory_value"],
        "marketing_share": _div(sums["marketing"], sums["revenue"]),
        "staff_share": _div(sums["staff_costs"], sums["revenue"]),
        "headcount": head_after, "tax_rate": tax_rate,
        "subscribers_end": sum(subs.values()) if sub else None,
        "churn_rate": churn if sub else None,
    }
    factors = []
    if L.price_change_pct:
        w = sum(price_eff[p.id] * share[p.id] for p in prods)
        factors.append({"key": "price", "label": "Price response (elasticity)", "multiplier": w,
                        "note": f"{'New sign-ups' if sub else 'Demand'} for repriced products × (price factor)^elasticity"})
    if L.demand_change_pct or demand_mult != 1.0:
        factors.append({"key": "demand", "label": "Demand change", "multiplier": dmult, "note": "Stated change in customer demand"})
    if abs(mfac - 1) > EPS:
        factors.append({"key": "marketing", "label": "Marketing response", "multiplier": mfac,
                        "note": f"(new spend ÷ current spend)^{profile.marketing.elasticity:g}"})
    for sh in L.seasonal:
        factors.append({"key": "seasonal", "label": sh.label, "multiplier": 1 + sh.demand_change_pct / 100, "note": f"In months {', '.join(str(m) for m in sh.months)}"})
    if nb:
        factors.append({"key": "branch", "label": "New location (when ramped up)", "multiplier": 1 + nb.demand_share_pct / 100, "note": f"Ramps up over {nb.ramp_months} months"})
    if sums["demand_units"] > EPS and (sums["lost_units"] + sums["stockout_units"]) > EPS:
        factors.append({"key": "limits", "label": "Capacity & stock limits", "multiplier": sums["units"] / sums["demand_units"], "note": "Share of demand that could actually be served"})
    return {"months": rows, "totals": sums, "monthly_avg": avg, "products": product_rows, "metrics": metrics,
            "demand_factors": factors, "flags": sorted(set(flags)), "horizon_months": H,
            "start_month": rows[0]["month"], "end_month": rows[-1]["month"]}


def bridge(base: dict, scen: dict) -> list[dict]:
    """Exact decomposition of the change in total net profit (scenario - baseline)."""
    bp = {p["id"]: p for p in base["products"]}
    price = cost = volume = 0.0
    new_gp = 0.0
    for p in scen["products"]:
        if p["is_new"]:
            new_gp += p["gross_profit"]
            continue
        b = bp[p["id"]]
        q1, q0 = p["units"], b["units"]
        price += (p["price"] - b["price"]) * q1
        cost -= (p["unit_cost"] - b["unit_cost"]) * q1
        volume += (b["price"] - b["unit_cost"]) * (q1 - q0)
    bt, st = base["totals"], scen["totals"]
    items = [
        ("volume", "Sales volume", volume, "Change in units sold × the old margin per unit"),
        ("price", "Selling price", price, "Price change × units sold"),
        ("unit_cost", "Variable cost per unit", cost, "Change in variable cost per unit × units sold"),
        ("new_product", "New product", new_gp, "Gross profit of the new product"),
        ("staff", "Staff costs", -(st["staff_costs"] - bt["staff_costs"]), ""),
        ("fixed", "Rent & fixed costs", -(st["fixed_costs"] - bt["fixed_costs"]), ""),
        ("marketing", "Marketing", -(st["marketing"] - bt["marketing"]), ""),
        ("tax", "Tax", -(st["tax"] - bt["tax"]), ""),
    ]
    total = st["net_profit"] - bt["net_profit"]
    rest = total - sum(v for _, _, v, _ in items)
    out = [{"key": k, "label": lab, "value": v, "note": note} for k, lab, v, note in items if abs(v) > 0.005]
    if abs(rest) > 0.01:  # should not happen; kept visible rather than hidden
        out.append({"key": "other", "label": "Other", "value": rest, "note": "Unexplained remainder"})
    return out


def bands(profile: Profile, levers: Levers) -> dict:
    """Best and worst cases across the stated uncertainty ranges (a grid, not random draws)."""
    u = profile.uncertainty
    d, c, e = u.demand_pct / 100, u.cost_pct / 100, u.elasticity_abs
    price_changed = bool(levers.price_change_pct) or levers.elasticity_override is not None
    grid = list(cartesian((1 - d, 1.0, 1 + d), (1 - c, 1.0, 1 + c), (-e, 0.0, e) if price_changed and e else (0.0,)))
    runs = []
    for dm, cm, es in grid:
        pr = project(profile, levers, demand_mult=dm, cost_mult=cm, elasticity_shift=es)
        runs.append(({"demand_mult": dm, "cost_mult": cm, "elasticity_shift": es}, pr))

    def pack(case: dict, pr: dict) -> dict:
        t, m = pr["totals"], pr["metrics"]
        return {"assumption": case, "net_profit": t["net_profit"], "revenue": t["revenue"], "units": t["units"],
                "min_cash": m["min_cash"], "ending_cash": m["ending_cash"], "net_margin": m["net_margin"],
                "monthly_net_profit": [r["net_profit"] for r in pr["months"]], "cash": [r["cash"] for r in pr["months"]]}
    best = max(runs, key=lambda x: x[1]["totals"]["net_profit"])
    worst = min(runs, key=lambda x: x[1]["totals"]["net_profit"])
    return {"best": pack(*best), "worst": pack(*worst), "cases": len(runs),
            "ranges": {"demand_pct": u.demand_pct, "cost_pct": u.cost_pct, "elasticity_abs": e if price_changed else 0}}


def assumptions(profile: Profile, levers: Levers, origin: dict | None = None) -> list[dict]:
    """Every assumption a result depends on, with where it came from."""
    prov = profile.provenance
    origin = origin or {}
    out: list[dict] = []

    fallback = "demo" if "demo" in prov.values() else "user"

    def src(path: str) -> str:
        return prov.get(path, fallback)

    for p in profile.products:
        if levers.price_change_pct or levers.elasticity_override is not None:
            e = levers.elasticity_override if levers.elasticity_override is not None else p.elasticity
            s = "scenario" if levers.elasticity_override is not None else src(f"products.{p.id}.elasticity")
            out.append({"key": f"elasticity.{p.id}", "label": f"Price elasticity, {p.name}", "value": e, "unit": "",
                        "source": s, "note": f"A 1% price change moves {'new sign-ups' if profile.subscription.enabled else 'demand'} by {e:g}%."})
    if levers.marketing_change_pct or levers.marketing_budget is not None:
        out.append({"key": "marketing.elasticity", "label": "Marketing response", "value": profile.marketing.elasticity, "unit": "",
                    "source": src("marketing.elasticity"), "note": "A 1% change in marketing spend moves demand by this %, with diminishing returns."})
    if profile.subscription.enabled:
        out.append({"key": "subscription.churn", "label": "Monthly churn", "value": profile.subscription.monthly_churn_pct + levers.churn_change_pts,
                    "unit": "%", "source": "scenario" if levers.churn_change_pts else src("subscription.monthly_churn_pct"),
                    "note": "Existing subscribers are assumed to stay at the new price; change churn to test a reaction."})
    if any(abs(x - 1) > 0.01 for x in profile.growth.seasonality):
        out.append({"key": "seasonality", "label": "Seasonality", "value": None, "unit": "", "source": src("growth.seasonality"),
                    "note": "Monthly demand index from the business profile."})
    if profile.growth.monthly_growth_pct:
        out.append({"key": "growth", "label": "Underlying growth", "value": profile.growth.monthly_growth_pct, "unit": "% per month", "source": src("growth.monthly_growth_pct"), "note": ""})
    lever_labels = {
        "price_change_pct": ("Selling price change", "%"), "unit_cost_change_pct": ("Variable cost change", "%"),
        "demand_change_pct": ("Demand change", "%"), "marketing_change_pct": ("Marketing budget change", "%"),
        "marketing_budget": ("New marketing budget", "per month"), "wage_change_pct": ("Wage change", "%"),
        "rent_change_pct": ("Rent change", "%"), "fixed_cost_change_pct": ("Other fixed cost change", "%"),
        "capacity_change_pct": ("Capacity change", "%"), "one_time_investment": ("One-time investment", ""),
        "tax_rate_pct": ("Tax rate", "%"), "churn_change_pts": ("Churn change", "points"),
        "new_customers_change_pct": ("New sign-ups change", "%"),
    }
    neutral = Levers()
    for key, (label, unit) in lever_labels.items():
        v = getattr(levers, key)
        if v != getattr(neutral, key):
            out.append({"key": f"lever.{key}", "label": label, "value": v, "unit": unit, "source": origin.get(key, "scenario"), "note": ""})
    for ch in levers.staff_changes:
        out.append({"key": "lever.staff", "label": f"Staff change: {ch.role}", "value": ch.count, "unit": "people",
                    "source": origin.get("staff_changes", "scenario"),
                    "note": "Monthly cost per person: " + (f"{ch.monthly_wage:g}" if ch.monthly_wage is not None else "current average wage")})
    for sh in levers.seasonal:
        out.append({"key": "lever.seasonal", "label": sh.label, "value": sh.demand_change_pct, "unit": "%",
                    "source": origin.get("seasonal", "scenario"), "note": f"Only {sh.year_month}" if sh.year_month else f"Months {', '.join(str(m) for m in sh.months)}"})
    for c in levers.extra_monthly_costs:
        out.append({"key": "lever.extra_cost", "label": c.label, "value": c.amount, "unit": "per month", "source": "scenario", "note": "Added to operating costs"})
    for dl in levers.data_links:
        out.append({"key": f"data.{dl.id}", "label": f"{dl.indicator} ({dl.source})", "value": dl.value, "unit": dl.unit, "source": dl.kind,
                    "note": f"{dl.rule_text} Observed/forecast: {dl.observed_at or 'n/a'}; retrieved {dl.retrieved_at or 'n/a'}."})
    if levers.new_branch:
        nb = levers.new_branch
        out.append({"key": "lever.new_branch", "label": "New location", "value": None, "unit": "", "source": origin.get("new_branch", "scenario"),
                    "note": f"Set-up {nb.setup_cost:,.0f}; running costs {nb.monthly_fixed_cost:,.0f}/month; demand {nb.demand_share_pct:g}% of today's after {nb.ramp_months} months."})
    if levers.new_product:
        np_ = levers.new_product
        out.append({"key": "lever.new_product", "label": f"New product: {np_.name}", "value": None, "unit": "", "source": origin.get("new_product", "scenario"),
                    "note": f"Price {np_.price:g}, cost {np_.unit_cost:g}, {np_.monthly_units:,.0f} units/month, {np_.cannibalization_pct:g}% taken from existing products."})
    u = profile.uncertainty
    out.append({"key": "uncertainty", "label": "Best/worst-case ranges", "value": None, "unit": "", "source": src("uncertainty"),
                "note": f"Demand ±{u.demand_pct:g}%, variable costs ±{u.cost_pct:g}%, elasticity ±{u.elasticity_abs:g}."})
    return out


SIMPLIFICATIONS = [
    "Demand responds to price with a constant elasticity; real customers may react differently to large changes.",
    "Tax is charged monthly on positive operating profit, with no loss carry-forward.",
    "Customers pay immediately and suppliers are paid in the month of purchase (no receivables or payables).",
    "One-time spending reduces cash, not profit.",
    "Inventory is restocked to its normal level each month, up to the supplier limit.",
]


def default_share(profile: Profile) -> float:
    """Share of the core business figures (prices, costs, volumes, wages, fixed costs) that are What-if estimates."""
    prov = profile.provenance
    key_paths = [f"products.{p.id}.{f}" for p in profile.products for f in ("price", "unit_cost", "monthly_units")]
    key_paths += [f"staff.{s.id}.monthly_wage" for s in profile.staff] + [f"fixed_costs.{c.id}.monthly_amount" for c in profile.fixed_costs]
    defaults = sum(1 for k in key_paths if prov.get(k) == "default")
    return defaults / len(key_paths) if key_paths else 0.0


def confidence(profile: Profile, levers: Levers, scen: dict, band: dict) -> dict:
    prov = profile.provenance
    share = default_share(profile)
    score = 100.0
    reasons: list[dict] = []

    def hit(points: float, text: str):
        nonlocal score
        score -= points
        reasons.append({"impact": -round(points), "text": text})

    if share > 0:
        hit(45 * share, f"{share:.0%} of the core business figures are What-if estimates, not your numbers.")
    if len(profile.history) == 0:
        hit(15, "No past monthly results were entered, so the baseline cannot be checked against reality.")
    elif len(profile.history) < 3:
        hit(8, "Fewer than three months of past results were entered.")
    if levers.price_change_pct and levers.elasticity_override is None and any(prov.get(f"products.{p.id}.elasticity", "default") == "default" for p in profile.products):
        hit(12, "The price response (elasticity) is a default estimate; the result depends heavily on it.")
    if (levers.marketing_change_pct or levers.marketing_budget is not None) and prov.get("marketing.elasticity", "default") == "default":
        hit(8, "The marketing response is a default estimate.")
    if abs(levers.price_change_pct) > 30:
        hit(10, "The price change is large, beyond the range where a constant elasticity is a reasonable approximation.")
    if abs(levers.demand_change_pct) > 50:
        hit(5, "The demand change is large.")
    if levers.horizon_months > 12:
        hit(8, "Projections more than 12 months ahead are less reliable.")
    exp = scen["totals"]["net_profit"]
    spread = band["best"]["net_profit"] - band["worst"]["net_profit"]
    ratio = spread / max(abs(exp), 1.0)
    if ratio > 2:
        hit(15, "The best and worst cases are far apart compared with the expected result.")
    elif ratio > 1:
        hit(8, "The best and worst cases differ by more than the expected result itself.")
    if band["worst"]["net_profit"] < 0 < band["best"]["net_profit"]:
        hit(5, "Within the stated ranges, the result can be either a profit or a loss.")
    score = max(5.0, min(95.0, score))
    level = "high" if score >= 70 else "medium" if score >= 40 else "low"
    return {"score": round(score), "level": level, "reasons": reasons, "default_share": round(share, 3),
            "method": "Starts at 100 and subtracts points for estimated inputs, missing history, large changes, long horizons and wide best/worst ranges."}


def history_trend(profile: Profile) -> dict | None:
    """Least-squares trend of entered monthly revenue (actual data, not a forecast).

    Revenue and costs are divided by the profile's seasonality index for their
    month first, so an ordinary seasonal dip is not reported as a decline.
    """
    h = profile.history
    if len(h) < 3:
        return None
    season = profile.growth.seasonality
    s_mean = sum(season) / 12
    idx = [max(0.05, season[int(r.month[5:7]) - 1] / s_mean) for r in h]
    ys = [r.revenue / i for r, i in zip(h, idx)]
    n = len(ys)
    xs = list(range(n))
    xm, ym = sum(xs) / n, sum(ys) / n
    sxx = sum((x - xm) ** 2 for x in xs)
    slope = sum((x - xm) * (y - ym) for x, y in zip(xs, ys)) / sxx if sxx else 0.0
    cost_rows = [(r, i) for r, i in zip(h, idx) if r.total_costs is not None]
    cost_slope = None
    if len(cost_rows) >= 3:
        cs = [r.total_costs / i for r, i in cost_rows]
        cm = sum(cs) / len(cs)
        cx = list(range(len(cs)))
        cxm = sum(cx) / len(cx)
        cs_xx = sum((x - cxm) ** 2 for x in cx)
        cost_slope = (sum((x - cxm) * (y - cm) for x, y in zip(cx, cs)) / cs_xx / cm) if cs_xx and cm else None
    return {"months": n, "first_month": h[0].month, "last_month": h[-1].month, "mean_revenue": ym,
            "slope_per_month": slope, "slope_pct_per_month": (slope / ym) if ym else None,
            "cost_slope_pct_per_month": cost_slope, "last_revenue": h[-1].revenue, "first_revenue": h[0].revenue,
            "seasonally_adjusted": any(abs(i - 1) > 0.01 for i in idx)}


def simulate(profile: Profile, levers: Levers, origin: dict | None = None) -> dict:
    """Baseline vs scenario, with bands, a profit bridge, confidence and assumptions."""
    neutral = Levers(horizon_months=levers.horizon_months, start_month=levers.start_month or "%04d-%02d" % _start(levers))
    levers = levers.model_copy(update={"start_month": neutral.start_month})
    base = project(profile, neutral)
    scen = project(profile, levers)
    band = bands(profile, levers)
    base_band = bands(profile, neutral)
    keys = ("revenue", "units", "variable_costs", "gross_profit", "operating_expenses", "operating_profit", "net_profit", "one_time", "cash_flow")
    delta = {}
    for k in keys:
        b, s = base["totals"][k], scen["totals"][k]
        delta[k] = {"baseline": b, "scenario": s, "change": s - b, "change_pct": _div(s - b, abs(b))}
    for k in ("net_margin", "gross_margin", "break_even_units", "min_cash", "ending_cash", "capacity_utilization"):
        b, s = base["metrics"][k], scen["metrics"][k]
        delta[k] = {"baseline": b, "scenario": s, "change": (s - b) if (s is not None and b is not None) else None}
    one_time = scen["totals"]["one_time"]
    gain = scen["monthly_avg"]["net_profit"] - base["monthly_avg"]["net_profit"]
    payback = (one_time / gain) if (one_time > 0 and gain > EPS) else None
    trend = history_trend(profile)
    hist_check = None
    if profile.history:
        last = profile.history[-1]
        first_base = base["months"][0]["revenue"]
        hist_check = {"last_actual_month": last.month, "last_actual_revenue": last.revenue, "baseline_first_month_revenue": first_base,
                      "gap_pct": _div(first_base - last.revenue, last.revenue)}
    return {
        "engine": ENGINE_VERSION, "computed_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "currency": profile.business.currency, "unit_label": profile.unit_label,
        "levers": levers.model_dump(), "is_baseline": levers.is_baseline(),
        "baseline": base, "scenario": scen, "bands": band, "baseline_bands": base_band,
        "delta": delta, "bridge": bridge(base, scen), "payback_months": payback,
        "confidence": confidence(profile, levers, scen, band),
        "assumptions": assumptions(profile, levers, origin), "simplifications": SIMPLIFICATIONS,
        "history_trend": trend, "history_check": hist_check,
    }


def validate_profile(profile: Profile) -> dict:
    """Plain-language checks on a profile before it is simulated."""
    issues: list[dict] = []

    def add(severity: str, code: str, msg: str, path: str | None = None):
        issues.append({"severity": severity, "code": code, "message": msg, "path": path})

    for p in profile.products:
        if p.price < p.unit_cost:
            add("warning", "price_below_cost", f"{p.name}: the selling price is below the variable cost, so every unit sold loses money.", f"products.{p.id}.price")
        if p.monthly_units == 0:
            add("info", "no_sales", f"{p.name}: no monthly sales are entered.", f"products.{p.id}.monthly_units")
        if p.restock_units_per_month is not None and p.stock_units is None:
            add("info", "restock_without_stock", f"{p.name}: a supplier limit is set but no stock on hand, so inventory is not tracked.", f"products.{p.id}.stock_units")
    if not profile.fixed_costs:
        add("warning", "no_fixed_costs", "No fixed costs (rent, utilities, software) are entered. Profit will be overstated.", "fixed_costs")
    if not profile.staff:
        add("info", "no_staff", "No staff costs are entered.", "staff")
    if profile.marketing.monthly_budget == 0 and profile.marketing.units_per_1000 is None:
        add("info", "marketing_response", "Marketing spend is zero today, so What-if cannot estimate what new spending would bring unless you enter extra units per 1,000 spent.", "marketing.units_per_1000")
    cap = capacity_today(profile)
    demand = sum(p.monthly_units for p in profile.products)
    if cap is not None and demand > cap and not profile.subscription.enabled:
        add("warning", "demand_over_capacity", f"Monthly sales ({demand:,.0f}) are above capacity ({cap:,.0f}). Check both numbers.", "operations")
    if profile.finance.starting_cash < profile.finance.min_cash_buffer:
        add("warning", "cash_below_buffer", "Starting cash is already below your minimum cash buffer.", "finance.starting_cash")
    defaults = [k for k, v in profile.provenance.items() if v == "default"]
    if profile.provenance and len(defaults) / len(profile.provenance) > 0.5:
        add("info", "mostly_defaults", "Most values are still What-if estimates. Replace them with your own numbers for meaningful results.", None)
    return {"status": "warnings" if any(i["severity"] == "warning" for i in issues) else "ok", "issues": issues}


def round_result(obj, nd: int = 4):
    """Round floats for storage and transport (keeps JSON small and stable)."""
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return None
        return round(obj, nd)
    if isinstance(obj, dict):
        return {k: round_result(v, nd) for k, v in obj.items()}
    if isinstance(obj, list):
        return [round_result(v, nd) for v in obj]
    return obj
