"""Standard 'parallel world' scenario templates for the retail MVP.

These are experiments, not predictions: each one changes a small set of named
levers relative to the same baseline model so the effect of the decision can
be isolated.
"""
from __future__ import annotations

import copy

RETAIL_WORLDS: list[dict] = [
    {
        "kind": "baseline",
        "name": "Baseline World",
        "description": "The business continues operating exactly as the model describes today.",
        "decision": "Keep current operations",
        "levers": {},
        "assumptions": ["No change to prices, stock policy, staffing or costs."],
    },
    {
        "kind": "inventory",
        "name": "Inventory Expansion World",
        "description": "Order 40% more per purchase and reorder earlier to respond to expected demand.",
        "decision": "Buy more inventory per order",
        "levers": {"order_quantity_change_pct": 40, "reorder_point_change_pct": 30},
        "assumptions": ["Suppliers can deliver the larger orders at the same unit price.", "Customer demand does not change because of extra stock."],
    },
    {
        "kind": "delivery",
        "name": "Delivery Service World",
        "description": "Offer local delivery with a per-order fee, driver cost, monthly software cost and a one-time setup cost.",
        "decision": "Start a local delivery service",
        "levers": {"delivery": {
            "enabled": True, "orders_per_day": 25, "units_per_order": 6, "fee_per_order": 4.99,
            "cost_per_order": 6.50, "fixed_monthly_cost": 600, "setup_cost": 3500, "cannibalization_pct": 35,
        }},
        "assumptions": [
            "25 delivery orders a day on average once launched (no ramp-up period modelled).",
            "35% of delivered units would otherwise have been bought in store.",
            "Each delivery order takes about 12 minutes of staff time to pick and pack.",
        ],
    },
    {
        "kind": "price",
        "name": "Price Adjustment World",
        "description": "Raise shelf-stable prices by 4%; demand responds through each product's price elasticity.",
        "decision": "Raise prices on shelf-stable goods",
        "levers": {"price_change_pct": 4, "price_products": ["pantry", "beverages", "household"]},
        "assumptions": ["Price elasticity values in the model hold for a 4% change.", "Competitors do not change their prices."],
    },
    {
        "kind": "stress",
        "name": "Economic Stress World",
        "description": "Demand falls 15%, supplier prices rise 8%, deliveries arrive a day later and a $4,000 repair bill lands mid-period.",
        "decision": "Test resilience to a downturn",
        "levers": {"demand_change_pct": -15, "supplier_cost_change_pct": 8, "lead_time_change_days": 1,
                   "unexpected_expense": 4000, "unexpected_expense_day": 45},
        "assumptions": ["All adverse conditions happen together for the whole period.", "The business does not react by cutting costs."],
    },
]


# Not one of the five standard worlds, but used by the demo and the Scenario
# Designer when the goal is less waste or more cash on hand.
LEAN_WORLD: dict = {
    "kind": "inventory",
    "name": "Lean Ordering World",
    "description": "Order perishables in batches 25% smaller, accepting more frequent orders.",
    "decision": "Order perishables in smaller batches",
    "levers": {"order_quantity_change_pct": -25, "inventory_products": ["produce", "dairy", "bakery"]},
    "assumptions": ["Suppliers accept smaller orders at the same unit price.", "Ordering more often does not add delivery charges."],
}


def world_templates(model_product_ids: list[str] | None = None) -> list[dict]:
    worlds = copy.deepcopy(RETAIL_WORLDS)
    if model_product_ids is not None:
        for w in worlds:
            for key in ("price_products", "inventory_products"):
                if key in w["levers"]:
                    kept = [p for p in w["levers"][key] if p in model_product_ids]
                    w["levers"][key] = kept  # empty list means "all products"
    return worlds
