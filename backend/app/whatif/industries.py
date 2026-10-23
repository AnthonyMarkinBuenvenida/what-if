"""Industry profiles: what each kind of business is asked for, and starting estimates.

Every number in a template is a What-if default estimate (provenance
"default"). Templates exist so a new business can run a first simulation
immediately; the setup page and the confidence indicator both point out
which values are still estimates. None of them is market data.
"""
from __future__ import annotations

import copy

from .schemas import Profile

# Elasticities below are rough rules of thumb for small businesses, not
# measurements. They are labelled as such wherever they are used.
INDUSTRIES: dict[str, dict] = {
    "food_beverage": {
        "label": "Food & beverage", "examples": "Milk tea shop, café, bakery, food stall",
        "unit_label": "cups", "unit_cost_label": "Ingredient & packaging cost per unit",
        "sections": ["products", "staff", "fixed_costs", "marketing", "capacity", "inventory", "finance", "seasonality", "suppliers", "history"],
        "background": "food_beverage",
        "external": ["weather", "inflation", "fx"],
        "elasticity_note": "Default −1.1: drinks and snacks usually have close substitutes nearby.",
        "suggestions": [
            "What if I lower my selling price by 10%?",
            "What if ingredient costs increase by 15%?",
            "What if I hire two additional employees?",
            "What if customer demand increases 25% during the summer months?",
            "What if I introduce a new product?",
        ],
    },
    "retail": {
        "label": "Retail", "examples": "Grocery, boutique, hardware store, pharmacy",
        "unit_label": "units", "unit_cost_label": "Purchase cost per unit",
        "sections": ["products", "staff", "fixed_costs", "marketing", "capacity", "inventory", "finance", "seasonality", "suppliers", "history"],
        "background": "retail",
        "external": ["inflation", "fx"],
        "elasticity_note": "Default −1.0: typical for everyday goods with competing stores.",
        "suggestions": [
            "What if my monthly sales decrease by 20%?",
            "What if I increase my advertising budget by 50%?",
            "What if customer demand increases 30% during the holiday season?",
            "What if I open another branch?",
            "What if supplier costs increase by 8%?",
        ],
    },
    "manufacturing": {
        "label": "Manufacturing", "examples": "Workshop, food processing, small factory",
        "unit_label": "units", "unit_cost_label": "Materials & direct cost per unit",
        "sections": ["products", "staff", "fixed_costs", "marketing", "capacity", "inventory", "finance", "seasonality", "suppliers", "history"],
        "background": "manufacturing",
        "external": ["inflation", "fx", "lending"],
        "elasticity_note": "Default −0.7: business buyers usually react less to price than consumers.",
        "suggestions": [
            "What if material costs increase by 12%?",
            "What if I add a second shift with four more workers?",
            "What if demand drops 15% and I lower prices by 5%?",
            "What if I invest in a machine that adds 30% capacity?",
        ],
    },
    "technology": {
        "label": "Technology & software", "examples": "SaaS, app, online service",
        "unit_label": "subscribers", "unit_cost_label": "Hosting & support cost per subscriber",
        "sections": ["products", "subscription", "staff", "fixed_costs", "marketing", "finance", "history"],
        "background": "technology",
        "external": ["fx", "lending"],
        "elasticity_note": "Default −0.6 on new sign-ups only; existing subscribers follow the churn rate.",
        "suggestions": [
            "What if I raise prices by 15%?",
            "What if monthly churn rises by 2 points?",
            "What if I double the marketing budget?",
            "What if I hire two engineers?",
        ],
    },
    "agriculture": {
        "label": "Agriculture", "examples": "Farm, orchard, poultry, aquaculture",
        "unit_label": "kg", "unit_cost_label": "Input cost per kg (seed, feed, fertiliser)",
        "sections": ["products", "staff", "fixed_costs", "capacity", "inventory", "finance", "seasonality", "suppliers", "history"],
        "background": "agriculture",
        "external": ["weather", "inflation", "fx"],
        "elasticity_note": "Default −0.4: farm-gate prices are mostly set by the market.",
        "suggestions": [
            "What if fertiliser costs increase by 20%?",
            "What if a dry season cuts harvest by 30% in March to May?",
            "What if the market price falls by 10%?",
            "What if I invest in irrigation that adds 25% capacity?",
        ],
    },
    "services": {
        "label": "Services", "examples": "Salon, agency, clinic, repair shop",
        "unit_label": "appointments", "unit_cost_label": "Direct cost per appointment",
        "sections": ["products", "staff", "fixed_costs", "marketing", "capacity", "finance", "seasonality", "history"],
        "background": "services",
        "external": ["inflation", "fx"],
        "elasticity_note": "Default −0.8: regular clients are fairly loyal.",
        "suggestions": [
            "What if I raise prices by 8%?",
            "What if I hire another stylist?",
            "What if rent increases by 15%?",
            "What if bookings fall 20% for three months?",
        ],
    },
}


def _season(peaks: dict[int, float]) -> list[float]:
    s = [peaks.get(m, 1.0) for m in range(1, 13)]
    mean = sum(s) / 12
    return [round(x / mean, 3) for x in s]


def _template(industry: str, name: str, currency: str, country: str) -> dict:
    meta = INDUSTRIES[industry]
    common = {
        "industry": industry, "unit_label": meta["unit_label"],
        "business": {"name": name, "business_type": meta["examples"].split(",")[0], "country": country, "currency": currency},
        "marketing": {"monthly_budget": 800, "elasticity": 0.08},
        "finance": {"starting_cash": 30000, "min_cash_buffer": 5000, "tax_rate_pct": 20},
        "uncertainty": {"demand_pct": 10, "cost_pct": 5, "elasticity_abs": 0.3},
    }
    if industry == "food_beverage":
        t = {
            "products": [
                {"name": "Signature drink", "price": 5.0, "unit_cost": 1.7, "monthly_units": 3200, "elasticity": -1.1},
                {"name": "Seasonal drink", "price": 6.0, "unit_cost": 2.2, "monthly_units": 1200, "elasticity": -1.1},
                {"name": "Snacks", "price": 3.5, "unit_cost": 1.4, "monthly_units": 900, "elasticity": -1.2},
            ],
            "staff": [{"role": "Crew", "count": 2, "monthly_wage": 2300}, {"role": "Shift lead", "count": 1, "monthly_wage": 3200}],
            "fixed_costs": [{"name": "Rent", "category": "rent", "monthly_amount": 3800}, {"name": "Utilities", "category": "utilities", "monthly_amount": 900},
                            {"name": "POS & software", "category": "software", "monthly_amount": 150}, {"name": "Insurance & permits", "category": "insurance", "monthly_amount": 200}],
            "operations": {"monthly_capacity_units": 6500},
            "growth": {"monthly_growth_pct": 0, "seasonality": _season({3: 1.12, 4: 1.18, 5: 1.15, 7: 0.9, 8: 0.88, 9: 0.9, 12: 1.08})},
        }
    elif industry == "retail":
        t = {
            "products": [
                {"name": "Everyday items", "price": 4.2, "unit_cost": 2.5, "monthly_units": 7000, "elasticity": -1.0, "stock_units": 7500, "restock_units_per_month": 11000},
                {"name": "Premium items", "price": 12.0, "unit_cost": 6.6, "monthly_units": 1400, "elasticity": -1.2, "stock_units": 1800, "restock_units_per_month": 2400},
            ],
            "staff": [{"role": "Sales associate", "count": 2, "monthly_wage": 2600}, {"role": "Store manager", "count": 1, "monthly_wage": 4200}],
            "fixed_costs": [{"name": "Rent", "category": "rent", "monthly_amount": 4500}, {"name": "Utilities", "category": "utilities", "monthly_amount": 800},
                            {"name": "Software", "category": "software", "monthly_amount": 200}, {"name": "Insurance", "category": "insurance", "monthly_amount": 300}],
            "operations": {"monthly_capacity_units": 13000, "inventory_lead_time_days": 7},
            "growth": {"monthly_growth_pct": 0, "seasonality": _season({11: 1.15, 12: 1.4, 1: 0.85, 2: 0.9})},
        }
    elif industry == "manufacturing":
        t = {
            "products": [{"name": "Standard product", "price": 48.0, "unit_cost": 24.0, "monthly_units": 1700, "elasticity": -0.7, "stock_units": 900, "restock_units_per_month": None}],
            "staff": [{"role": "Production worker", "count": 7, "monthly_wage": 2800}, {"role": "Supervisor", "count": 1, "monthly_wage": 4500}],
            "fixed_costs": [{"name": "Factory rent", "category": "rent", "monthly_amount": 6000}, {"name": "Power & utilities", "category": "utilities", "monthly_amount": 2500},
                            {"name": "Equipment maintenance", "category": "maintenance", "monthly_amount": 1200}, {"name": "Insurance", "category": "insurance", "monthly_amount": 600},
                            {"name": "Equipment loan interest", "category": "loan", "monthly_amount": 900}],
            "operations": {"capacity_per_staff": 260, "inventory_lead_time_days": 14},
            "suppliers": [{"name": "Main materials supplier", "share_pct": 75}],
        }
        common["marketing"] = {"monthly_budget": 600, "elasticity": 0.05}
        common["finance"] = {"starting_cash": 60000, "min_cash_buffer": 15000, "tax_rate_pct": 20}
    elif industry == "technology":
        t = {
            "products": [{"name": "Monthly plan", "price": 29.0, "unit_cost": 3.0, "monthly_units": 600, "elasticity": -0.6},
                         {"name": "Team plan", "price": 99.0, "unit_cost": 9.0, "monthly_units": 80, "elasticity": -0.5}],
            "subscription": {"enabled": True, "monthly_churn_pct": 3.5, "new_customers_per_month": 45},
            "staff": [{"role": "Engineer", "count": 2, "monthly_wage": 7500}, {"role": "Support & success", "count": 1, "monthly_wage": 4200}],
            "fixed_costs": [{"name": "Base cloud infrastructure", "category": "software", "monthly_amount": 900}, {"name": "Tools & licences", "category": "software", "monthly_amount": 600},
                            {"name": "Office / coworking", "category": "rent", "monthly_amount": 1200}],
            "growth": {"monthly_growth_pct": 0},
        }
        common["marketing"] = {"monthly_budget": 2500, "elasticity": 0.25}
        common["finance"] = {"starting_cash": 90000, "min_cash_buffer": 20000, "tax_rate_pct": 20}
    elif industry == "agriculture":
        t = {
            "products": [{"name": "Main crop", "price": 1.1, "unit_cost": 0.40, "monthly_units": 14000, "elasticity": -0.4, "stock_units": 0, "restock_units_per_month": None},
                         {"name": "Secondary crop", "price": 1.8, "unit_cost": 0.7, "monthly_units": 4000, "elasticity": -0.4}],
            "staff": [{"role": "Farm worker", "count": 3, "monthly_wage": 1700}, {"role": "Farm manager", "count": 1, "monthly_wage": 2600}],
            "fixed_costs": [{"name": "Land lease", "category": "rent", "monthly_amount": 1500}, {"name": "Water & power", "category": "utilities", "monthly_amount": 450},
                            {"name": "Equipment upkeep", "category": "maintenance", "monthly_amount": 600}],
            "operations": {"monthly_capacity_units": 30000},
            "growth": {"monthly_growth_pct": 0, "seasonality": _season({1: 0.6, 2: 0.6, 3: 0.8, 6: 1.3, 7: 1.5, 8: 1.5, 9: 1.3, 10: 1.1, 12: 0.7})},
            "suppliers": [{"name": "Fertiliser & seed supplier", "share_pct": 65}],
        }
        common["marketing"] = {"monthly_budget": 0, "elasticity": 0.0}
        common["finance"] = {"starting_cash": 25000, "min_cash_buffer": 6000, "tax_rate_pct": 15}
    else:  # services
        t = {
            "products": [{"name": "Standard service", "price": 45.0, "unit_cost": 6.0, "monthly_units": 320, "elasticity": -0.8},
                         {"name": "Premium service", "price": 90.0, "unit_cost": 14.0, "monthly_units": 70, "elasticity": -0.7}],
            "staff": [{"role": "Specialist", "count": 3, "monthly_wage": 2900}, {"role": "Front desk", "count": 1, "monthly_wage": 2000}],
            "fixed_costs": [{"name": "Rent", "category": "rent", "monthly_amount": 2800}, {"name": "Utilities", "category": "utilities", "monthly_amount": 450},
                            {"name": "Booking software", "category": "software", "monthly_amount": 120}, {"name": "Insurance", "category": "insurance", "monthly_amount": 220}],
            "operations": {"capacity_per_staff": 150},
            "growth": {"monthly_growth_pct": 0, "seasonality": _season({12: 1.2, 1: 0.85})},
        }
    out = {**common, **t}
    out.setdefault("growth", {"monthly_growth_pct": 0})
    return out


def template(industry: str, name: str, currency: str = "USD", country: str = "") -> dict:
    """A complete starting profile. Every value is tagged as a default estimate."""
    if industry not in INDUSTRIES:
        raise ValueError(f"Unknown industry '{industry}'.")
    spec = Profile.model_validate(_template(industry, name, currency, country)).model_dump()
    spec["provenance"] = {path: "default" for path in value_paths(spec)}
    for p in ("business.name", "business.currency", "business.country"):
        spec["provenance"][p] = "user"
    return spec


def value_paths(spec: dict):
    """Paths of every editable number in a profile (used for provenance)."""
    for p in spec.get("products", []):
        for f in ("price", "unit_cost", "monthly_units", "elasticity", "stock_units", "restock_units_per_month"):
            if p.get(f) is not None:
                yield f"products.{p['id']}.{f}"
    for s in spec.get("staff", []):
        yield f"staff.{s['id']}.count"
        yield f"staff.{s['id']}.monthly_wage"
    for c in spec.get("fixed_costs", []):
        yield f"fixed_costs.{c['id']}.monthly_amount"
    yield "marketing.monthly_budget"
    yield "marketing.elasticity"
    ops = spec.get("operations") or {}
    for f in ("monthly_capacity_units", "capacity_per_staff"):
        if ops.get(f) is not None:
            yield f"operations.{f}"
    if (spec.get("subscription") or {}).get("enabled"):
        yield "subscription.monthly_churn_pct"
        yield "subscription.new_customers_per_month"
    for f in ("starting_cash", "tax_rate_pct"):
        yield f"finance.{f}"
    yield "growth.seasonality"


def public_catalog() -> list[dict]:
    return [{"id": k, **copy.deepcopy(v)} for k, v in INDUSTRIES.items()]
