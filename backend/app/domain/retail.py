"""Retail digital-twin specification, defaults, templates and validation.

A model spec is plain JSON so that it can be versioned, diffed and stored
unchanged with every simulation run. Every editable value has a provenance tag:

    confirmed  - came from imported business data
    user       - entered or stated by the user
    inferred   - derived from data (e.g. average demand from sales history)
    calibrated - adjusted from actual results the user approved
    default    - a What-if default; replace it with real data when possible
"""
from __future__ import annotations

import copy
import re
from typing import Any

PROVENANCE = ("confirmed", "user", "inferred", "calibrated", "default")

# Editable variables, how they affect the simulation, and their valid ranges.
VARIABLE_GUIDE: dict[str, dict[str, Any]] = {
    "price": {"label": "Selling price", "unit": "$/unit", "min": 0, "effect": "Revenue per unit sold. Demand responds through price elasticity when a scenario changes price."},
    "unit_cost": {"label": "Purchase cost", "unit": "$/unit", "min": 0, "effect": "Cost of goods sold and cash paid when restocking."},
    "avg_daily_demand": {"label": "Average daily demand", "unit": "units/day", "min": 0, "effect": "Expected customer demand before stock or staff limits."},
    "demand_cv": {"label": "Demand variability", "unit": "std ÷ mean", "min": 0, "max": 3, "effect": "Day-to-day randomness in Monte Carlo runs. Higher values create more stockouts and waste."},
    "starting_inventory": {"label": "Stock on hand", "unit": "units", "min": 0, "effect": "Inventory available on day one."},
    "shelf_life_days": {"label": "Shelf life", "unit": "days", "min": 1, "max": 120, "effect": "Units older than this expire and are written off. Empty means non-perishable."},
    "reorder_point": {"label": "Reorder point", "unit": "units", "min": 0, "effect": "A purchase order is placed when stock on hand plus stock on order falls to this level."},
    "order_quantity": {"label": "Order quantity", "unit": "units", "min": 0, "effect": "Units purchased per order."},
    "lead_time_days": {"label": "Supplier lead time", "unit": "days", "min": 0, "max": 60, "effect": "Days between ordering and receiving stock."},
    "price_elasticity": {"label": "Price elasticity", "unit": "", "min": -5, "max": 0, "effect": "Demand change for a 1% price change (e.g. -1.2 means a 1% rise cuts demand 1.2%)."},
}

DEFAULT_OPERATIONS = {
    "open_days_per_week": 7,
    "units_per_labor_hour": 40.0,
    "storage_capacity_units": 6000,
    "delivery_minutes_per_order": 12.0,
}
DEFAULT_UNCERTAINTY = {"demand_level_pct": 10.0, "supplier_cost_pct": 3.0}
DEFAULT_GOALS = {
    "target_monthly_operating_profit": None,
    "max_investment_budget": None,
    "risk_tolerance": "medium",
    "max_waste_rate": None,
    "min_fill_rate": None,
}
RISK_TOLERANCE_SHORTFALL = {"low": 0.05, "medium": 0.10, "high": 0.20}


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40] or "item"


def grocery_template(name: str = "Neighborhood grocery") -> dict:
    """Illustrative starting model for a small grocery store.

    Every number here is a What-if default and is tagged as such. It exists so a
    user can see a working model immediately, and it must be replaced with the
    business's own data before results are treated as calibrated.
    """
    products = [
        # id, name, category, price, cost, demand/day, cv, stock, shelf, reorder, qty, lead
        ("produce", "Fresh produce", "Perishable", 3.20, 1.85, 165, 0.35, 700, 6, 420, 600, 2),
        ("dairy", "Dairy & eggs", "Perishable", 4.10, 2.65, 110, 0.30, 520, 10, 300, 450, 2),
        ("bakery", "Bakery", "Perishable", 3.60, 1.50, 70, 0.40, 150, 3, 90, 140, 1),
        ("pantry", "Pantry staples", "Shelf-stable", 3.90, 2.55, 140, 0.25, 1500, None, 800, 1200, 5),
        ("beverages", "Beverages", "Shelf-stable", 2.40, 1.35, 130, 0.30, 1100, None, 600, 900, 4),
        ("household", "Household goods", "Shelf-stable", 6.50, 4.20, 30, 0.45, 300, None, 220, 200, 7),
    ]
    spec_products = []
    for pid, pname, cat, price, cost, dem, cv, stock, shelf, rop, qty, lead in products:
        spec_products.append({
            "id": pid, "name": pname, "category": cat, "price": price, "unit_cost": cost,
            "avg_daily_demand": dem, "demand_cv": cv, "starting_inventory": stock,
            "shelf_life_days": shelf, "reorder_point": rop, "order_quantity": qty,
            "lead_time_days": lead, "price_elasticity": -1.2 if cat == "Perishable" else -0.9,
        })
    spec = {
        "industry": "retail",
        "business": {"name": name, "type": "grocery", "currency": "USD"},
        "products": spec_products,
        "expenses": [
            {"id": "rent", "name": "Rent", "category": "rent", "amount": 6500, "frequency": "monthly"},
            {"id": "utilities", "name": "Utilities & refrigeration", "category": "utilities", "amount": 1900, "frequency": "monthly"},
            {"id": "insurance", "name": "Insurance", "category": "insurance", "amount": 450, "frequency": "monthly"},
            {"id": "software", "name": "POS & software", "category": "other", "amount": 220, "frequency": "monthly"},
            {"id": "card-fees", "name": "Card processing (est.)", "category": "fees", "amount": 160, "frequency": "weekly"},
        ],
        "staff": [
            {"id": "clerks", "role": "Store clerk", "count": 3, "hourly_wage": 17.0, "hours_per_week": 36},
            {"id": "manager", "role": "Store manager", "count": 1, "hourly_wage": 26.0, "hours_per_week": 45},
        ],
        "operations": dict(DEFAULT_OPERATIONS),
        "finance": {"starting_cash": 38000.0, "min_cash_buffer": 8000.0},
        "goals": {**DEFAULT_GOALS, "target_monthly_operating_profit": 4500.0, "max_investment_budget": 15000.0},
        "uncertainty": dict(DEFAULT_UNCERTAINTY),
        "provenance": {},
    }
    tag_all(spec, "default")
    return spec


def tag_all(spec: dict, tag: str, overwrite: bool = False) -> None:
    prov = spec.setdefault("provenance", {})
    for path in iter_value_paths(spec):
        if overwrite or path not in prov:
            prov[path] = tag


def iter_value_paths(spec: dict):
    for p in spec.get("products", []):
        for f in VARIABLE_GUIDE:
            yield f"products.{p['id']}.{f}"
    for e in spec.get("expenses", []):
        yield f"expenses.{e['id']}.amount"
    for s in spec.get("staff", []):
        for f in ("count", "hourly_wage", "hours_per_week"):
            yield f"staff.{s['id']}.{f}"
    for f in ("units_per_labor_hour", "storage_capacity_units", "delivery_minutes_per_order", "open_days_per_week"):
        yield f"operations.{f}"
    for f in ("starting_cash", "min_cash_buffer"):
        yield f"finance.{f}"
    for f in ("demand_level_pct", "supplier_cost_pct"):
        yield f"uncertainty.{f}"


def normalize_spec(spec: dict) -> dict:
    """Fill structural defaults and stable ids without touching user values."""
    s = copy.deepcopy(spec)
    s.setdefault("industry", "retail")
    s.setdefault("business", {}).setdefault("currency", "USD")
    s.setdefault("products", [])
    s.setdefault("expenses", [])
    s.setdefault("staff", [])
    s["operations"] = {**DEFAULT_OPERATIONS, **(s.get("operations") or {})}
    s["finance"] = {"starting_cash": 0.0, "min_cash_buffer": 0.0, **(s.get("finance") or {})}
    s["goals"] = {**DEFAULT_GOALS, **(s.get("goals") or {})}
    s["uncertainty"] = {**DEFAULT_UNCERTAINTY, **(s.get("uncertainty") or {})}
    s.setdefault("provenance", {})
    seen: set[str] = set()
    for group, key in (("products", "name"), ("expenses", "name"), ("staff", "role")):
        for item in s[group]:
            if not item.get("id"):
                item["id"] = _slug(str(item.get(key, group)))
            base, n = item["id"], 2
            while f"{group}:{item['id']}" in seen:
                item["id"] = f"{base}-{n}"
                n += 1
            seen.add(f"{group}:{item['id']}")
    for p in s["products"]:
        p.setdefault("category", "General")
        p.setdefault("demand_cv", 0.3)
        p.setdefault("shelf_life_days", None)
        p.setdefault("lead_time_days", 3)
        p.setdefault("price_elasticity", -1.0)
        p.setdefault("starting_inventory", 0)
        p.setdefault("reorder_point", 0)
        p.setdefault("order_quantity", 0)
    for e in s["expenses"]:
        e.setdefault("frequency", "monthly")
        e.setdefault("category", "other")
    # Any value without provenance is a default the user has not confirmed.
    for path in iter_value_paths(s):
        s["provenance"].setdefault(path, "default")
    return s


def _num(v: Any) -> float | None:
    try:
        if v is None or v == "":
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


def validate_spec(spec: dict, sales_history_days: int | None = None) -> dict:
    """Check a model before simulation.

    Returns issues with severity:
        error   - the model cannot be simulated (impossible values)
        warning - the model can run, but results are exploratory until fixed
        info    - worth knowing; does not affect calibration status
    """
    s = normalize_spec(spec)
    issues: list[dict] = []
    prov = s["provenance"]

    def add(severity: str, code: str, message: str, path: str | None = None, fix: str | None = None):
        issues.append({"severity": severity, "code": code, "message": message, "path": path, "fix": fix})

    if not s["products"]:
        add("error", "no_products", "The model has no products. Add at least one product or import a product list.", "products")

    ops = s["operations"]
    capacity = _num(ops.get("storage_capacity_units")) or 0
    for p in s["products"]:
        pid, name = p["id"], p.get("name") or p["id"]
        base = f"products.{pid}"
        price, cost = _num(p.get("price")), _num(p.get("unit_cost"))
        if price is None or price < 0:
            add("error", "invalid_price", f"{name}: selling price is missing or negative.", f"{base}.price")
        if cost is None or cost < 0:
            add("error", "invalid_cost", f"{name}: purchase cost is missing or negative.", f"{base}.unit_cost")
        if price is not None and cost is not None and 0 <= price < cost:
            add("warning", "price_below_cost", f"{name}: selling price (${price:.2f}) is below purchase cost (${cost:.2f}). Every unit sold loses money.", f"{base}.price", "Check the price and cost, or confirm this is a deliberate loss leader.")
        inv = _num(p.get("starting_inventory"))
        if inv is None or inv < 0:
            add("error", "negative_inventory", f"{name}: stock on hand cannot be negative.", f"{base}.starting_inventory")
        dem = _num(p.get("avg_daily_demand"))
        if dem is None or dem < 0:
            add("error", "invalid_demand", f"{name}: average daily demand is missing or negative.", f"{base}.avg_daily_demand")
        cv = _num(p.get("demand_cv")) or 0
        if cv > 1.5:
            add("warning", "volatile_demand", f"{name}: demand variability of {cv:.2f} is very high; check the sales data for errors or one-off spikes.", f"{base}.demand_cv")
        for f in ("reorder_point", "order_quantity", "lead_time_days"):
            v = _num(p.get(f))
            if v is None or v < 0:
                add("error", f"invalid_{f}", f"{name}: {VARIABLE_GUIDE[f]['label'].lower()} must be zero or more.", f"{base}.{f}")
        shelf = _num(p.get("shelf_life_days"))
        lead = _num(p.get("lead_time_days")) or 0
        if shelf is not None:
            if shelf < 1:
                add("error", "invalid_shelf_life", f"{name}: shelf life must be at least 1 day.", f"{base}.shelf_life_days")
            elif shelf > 120:
                add("warning", "long_shelf_life", f"{name}: shelf life over 120 days is simulated as 120 days. Leave it empty for non-perishable goods.", f"{base}.shelf_life_days")
            if dem and shelf and _num(p.get("order_quantity")) and _num(p.get("order_quantity")) > dem * shelf * 1.1:
                add("warning", "order_exceeds_shelf_life", f"{name}: one order ({p['order_quantity']:.0f} units) is more than about {shelf:.0f} days of demand, so part of each order is likely to expire.", f"{base}.order_quantity", "Reduce the order quantity or order more often.")
        if dem and _num(p.get("reorder_point")) is not None and p["reorder_point"] < dem * lead:
            add("warning", "reorder_below_lead_demand", f"{name}: reorder point ({p['reorder_point']:.0f}) is below expected demand during the {lead:.0f}-day lead time ({dem * lead:.0f}). Expect stockouts while orders are in transit.", f"{base}.reorder_point")
        if capacity and _num(p.get("order_quantity")) and p["order_quantity"] > capacity:
            add("warning", "order_exceeds_storage", f"{name}: order quantity exceeds total storage capacity.", f"{base}.order_quantity")
        if dem and prov.get(f"{base}.avg_daily_demand") == "default":
            add("warning", "demand_is_default", f"{name}: demand is a What-if default, not your data. Import sales history or enter your own figure.", f"{base}.avg_daily_demand", "Upload a sales CSV/XLSX or edit the value.")

    if dem_total := sum((_num(p.get("avg_daily_demand")) or 0) for p in s["products"]):
        if capacity and dem_total > capacity:
            add("warning", "demand_exceeds_storage", f"Total daily demand ({dem_total:.0f} units) exceeds storage capacity ({capacity:.0f}). Check units or capacity.", "operations.storage_capacity_units")
        hours_per_day = sum((_num(x.get("count")) or 0) * (_num(x.get("hours_per_week")) or 0) for x in s["staff"]) / max(1, _num(ops.get("open_days_per_week")) or 7)
        uplh = _num(ops.get("units_per_labor_hour")) or 0
        if s["staff"] and uplh and dem_total > hours_per_day * uplh * 1.5:
            add("warning", "unrealistic_demand_for_staff", f"Expected demand ({dem_total:.0f} units/day) is far above what current staff can serve (about {hours_per_day * uplh:.0f} units/day). Either demand or staffing is likely wrong.", "operations.units_per_labor_hour")

    categories = {e.get("category") for e in s["expenses"]}
    if not s["expenses"]:
        add("warning", "no_expenses", "No operating expenses are recorded. Profit will be overstated.", "expenses", "Add rent, utilities and other recurring costs.")
    else:
        for needed, label in (("rent", "rent or occupancy"), ("utilities", "utilities")):
            if needed not in categories:
                add("warning", f"missing_{needed}", f"No {label} expense is recorded. Add it, or add a zero-amount line to confirm there is none.", "expenses")
    for e in s["expenses"]:
        amt = _num(e.get("amount"))
        if amt is None or amt < 0:
            add("error", "invalid_expense", f"Expense '{e.get('name')}' must be zero or more.", f"expenses.{e['id']}.amount")
        if e.get("frequency") not in ("daily", "weekly", "monthly"):
            add("error", "invalid_frequency", f"Expense '{e.get('name')}' needs a frequency of daily, weekly or monthly.", f"expenses.{e['id']}")
    if not s["staff"]:
        add("warning", "no_staff", "No staff are recorded. Labor costs and service capacity are not simulated.", "staff")
    for st in s["staff"]:
        for f in ("count", "hourly_wage", "hours_per_week"):
            v = _num(st.get(f))
            if v is None or v < 0:
                add("error", "invalid_staff", f"Staff '{st.get('role')}': {f.replace('_', ' ')} must be zero or more.", f"staff.{st['id']}.{f}")

    fin = s["finance"]
    cash = _num(fin.get("starting_cash"))
    if cash is None:
        add("error", "missing_cash", "Starting cash is required to simulate cash flow.", "finance.starting_cash")
    else:
        monthly_fixed = sum(_monthly(e) for e in s["expenses"]) + sum(
            (_num(x.get("count")) or 0) * (_num(x.get("hourly_wage")) or 0) * (_num(x.get("hours_per_week")) or 0) * 30 / 7 for x in s["staff"]
        )
        if monthly_fixed and cash < monthly_fixed:
            add("info", "thin_cash", f"Starting cash (${cash:,.0f}) covers less than one month of fixed costs (${monthly_fixed:,.0f}).", "finance.starting_cash")

    if sales_history_days is not None and sales_history_days < 28:
        add("warning", "short_history", f"Sales history covers only {sales_history_days} days. At least 4 weeks is recommended for a usable demand estimate.", "products")

    default_share = _default_share(s)
    if default_share > 0.5:
        add("info", "mostly_defaults", f"{default_share:.0%} of model values are What-if defaults. Results describe a typical store, not yours, until you replace them.", None)

    has_error = any(i["severity"] == "error" for i in issues)
    has_warning = any(i["severity"] == "warning" for i in issues)
    status = "invalid" if has_error else ("exploratory" if has_warning or default_share > 0 else "calibrated")
    return {
        "status": status,
        "issues": issues,
        "counts": {k: sum(1 for i in issues if i["severity"] == k) for k in ("error", "warning", "info")},
        "default_share": round(default_share, 3),
    }


def _monthly(e: dict) -> float:
    amt = _num(e.get("amount")) or 0
    return {"daily": amt * 30, "weekly": amt * 30 / 7, "monthly": amt}.get(e.get("frequency"), amt)


def _default_share(spec: dict) -> float:
    prov = spec.get("provenance", {})
    values = list(prov.values())
    if not values:
        return 1.0
    return sum(1 for v in values if v == "default") / len(values)


def provenance_counts(spec: dict) -> dict:
    counts = {k: 0 for k in PROVENANCE}
    for v in spec.get("provenance", {}).values():
        counts[v] = counts.get(v, 0) + 1
    return counts
