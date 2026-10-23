"""Retail simulation engine (deterministic and Monte Carlo).

This is ordinary numerical code: the language-model agents never produce or
alter these numbers. A run is fully reproducible from (model spec, levers,
config incl. seed).

Time step is one day. For R runs and P products the state is

    inv[R, P, A]   units on hand by age (days since received), A age buckets
    pipe[R, P, T]  units on order, indexed by arrival day
    cash[R]

Daily sequence:
    1. receive orders due today (age 0)
    2. expire perishable units whose age reached their shelf life (waste)
    3. draw demand (walk-in + incremental delivery), cap by labor capacity
    4. sell first-in-first-out from oldest stock
    5. take in revenue; pay recurring costs on their due dates
    6. reorder when stock on hand + on order <= reorder point,
       limited by free storage and by cash available (suppliers paid on order)
    7. age stock by one day

Accounting definitions used in every result:
    revenue            = units sold x selling price + delivery fees
    COGS               = units sold x purchase cost (current supplier price)
    waste cost         = expired units x purchase cost
    gross profit       = revenue - COGS - waste cost
    operating expenses = recurring expenses + labor + delivery costs (accrued daily)
    operating profit   = gross profit - operating expenses
    one-time costs     = investments, setup costs and unexpected expenses (shown separately)
    ending cash        = starting cash + cash received - cash paid
Cash and profit differ because purchases are paid when ordered (inventory build
or run-down changes cash but not profit) and recurring bills are paid on due
dates but accrued daily.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import threading
from dataclasses import dataclass, field
from typing import Callable

import numpy as np

from ..domain.retail import RISK_TOLERANCE_SHORTFALL, normalize_spec

ENGINE_VERSION = "retail-engine 1.0"
MAX_AGE_BUCKETS = 121
PERIOD_DAYS = {"daily": 1, "weekly": 7, "monthly": 30}

DEFAULT_LEVERS: dict = {
    "price_change_pct": 0.0,
    "price_products": [],          # empty = all products
    "demand_change_pct": 0.0,
    "supplier_cost_change_pct": 0.0,
    "order_quantity_change_pct": 0.0,
    "reorder_point_change_pct": 0.0,
    "inventory_products": [],      # empty = all products
    "lead_time_change_days": 0,
    "shelf_life_change_pct": 0.0,
    "extra_staff": [],             # [{role, count, hourly_wage, hours_per_week}]
    "staff_hours_change_pct": 0.0,
    "expense_change_pct": 0.0,     # all recurring expenses
    "rent_change_pct": 0.0,
    "one_time_investment": 0.0,
    "unexpected_expense": 0.0,
    "unexpected_expense_day": 30,
    "starting_cash_change": 0.0,
    "storage_capacity_change_pct": 0.0,
    "supply_disruption_prob": 0.0,  # chance an order is delayed
    "disruption_delay_days": 0,
    "delivery": {
        "enabled": False,
        "orders_per_day": 0.0,
        "units_per_order": 4.0,
        "fee_per_order": 0.0,
        "cost_per_order": 0.0,
        "fixed_monthly_cost": 0.0,
        "setup_cost": 0.0,
        "cannibalization_pct": 30.0,  # share of delivery units customers would have bought in store anyway
    },
}

DEFAULT_CONFIG = {"mode": "monte_carlo", "runs": 400, "horizon_days": 90, "seed": 20240601}
MAX_RUNS = 2000
MAX_HORIZON = 365


class SimulationCancelled(Exception):
    pass


def merge_levers(levers: dict | None) -> dict:
    out = copy.deepcopy(DEFAULT_LEVERS)
    for k, v in (levers or {}).items():
        if k == "delivery" and isinstance(v, dict):
            out["delivery"].update(v)
        elif k in out:
            out[k] = v
    return out


def merge_config(config: dict | None) -> dict:
    cfg = {**DEFAULT_CONFIG, **(config or {})}
    cfg["mode"] = "deterministic" if cfg.get("mode") == "deterministic" else "monte_carlo"
    cfg["horizon_days"] = int(min(MAX_HORIZON, max(7, int(cfg["horizon_days"]))))
    cfg["runs"] = 1 if cfg["mode"] == "deterministic" else int(min(MAX_RUNS, max(20, int(cfg["runs"]))))
    cfg["seed"] = int(cfg.get("seed") or DEFAULT_CONFIG["seed"])
    return cfg


def levers_hash(levers: dict, config: dict, criteria: dict | None = None) -> str:
    blob = json.dumps({"l": merge_levers(levers), "c": merge_config(config), "k": criteria or {}}, sort_keys=True, default=str)
    return hashlib.sha256(blob.encode()).hexdigest()[:32]


@dataclass
class Effective:
    """Model parameters after a scenario's levers are applied."""
    names: list[str]
    ids: list[str]
    price: np.ndarray
    unit_cost: np.ndarray
    demand: np.ndarray
    cv: np.ndarray
    start_inv: np.ndarray
    shelf: np.ndarray            # days; inf for non-perishable
    reorder_point: np.ndarray
    order_qty: np.ndarray
    lead: np.ndarray             # int days
    storage_capacity: float
    labor_hours_per_day: float
    units_per_labor_hour: float
    delivery_minutes_per_order: float
    labor_weekly_cost: float
    recurring: list[tuple[str, float, int]]  # (name, amount, period days)
    delivery: dict
    one_time_day0: float
    unexpected: tuple[float, int]
    starting_cash: float
    min_cash_buffer: float
    demand_level_sd: float
    supplier_cost_sd: float
    disruption_prob: float
    disruption_delay: int
    applied_changes: list[str] = field(default_factory=list)


def _pct(x) -> float:
    return float(x or 0) / 100.0


def apply_levers(spec: dict, levers: dict) -> Effective:
    s = normalize_spec(spec)
    L = merge_levers(levers)
    prods = s["products"]
    if not prods:
        raise ValueError("The model has no products to simulate.")
    ids = [p["id"] for p in prods]
    changes: list[str] = []

    price = np.array([float(p["price"]) for p in prods])
    base_price = price.copy()
    price_mask = np.array([(not L["price_products"]) or (pid in L["price_products"]) for pid in ids], dtype=bool)
    if L["price_change_pct"]:
        price = np.where(price_mask, price * (1 + _pct(L["price_change_pct"])), price)
        scope = "all products" if not L["price_products"] else ", ".join(p["name"] for p in prods if p["id"] in L["price_products"])
        changes.append(f"Selling price {L['price_change_pct']:+.1f}% on {scope}")
    elasticity = np.array([float(p.get("price_elasticity", -1.0)) for p in prods])
    with np.errstate(divide="ignore", invalid="ignore"):
        ratio = np.where(base_price > 0, price / np.where(base_price > 0, base_price, 1), 1.0)
    price_effect = np.power(np.clip(ratio, 1e-6, None), elasticity)

    demand = np.array([float(p["avg_daily_demand"]) for p in prods]) * price_effect
    if L["demand_change_pct"]:
        demand *= 1 + _pct(L["demand_change_pct"])
        changes.append(f"Customer demand {L['demand_change_pct']:+.1f}%")

    unit_cost = np.array([float(p["unit_cost"]) for p in prods])
    if L["supplier_cost_change_pct"]:
        unit_cost *= 1 + _pct(L["supplier_cost_change_pct"])
        changes.append(f"Supplier prices {L['supplier_cost_change_pct']:+.1f}%")

    inv_mask = np.array([(not L["inventory_products"]) or (pid in L["inventory_products"]) for pid in ids], dtype=bool)
    order_qty = np.array([float(p["order_quantity"]) for p in prods])
    reorder = np.array([float(p["reorder_point"]) for p in prods])
    if L["order_quantity_change_pct"]:
        order_qty = np.where(inv_mask, order_qty * (1 + _pct(L["order_quantity_change_pct"])), order_qty)
        changes.append(f"Order quantity {L['order_quantity_change_pct']:+.1f}%")
    if L["reorder_point_change_pct"]:
        reorder = np.where(inv_mask, reorder * (1 + _pct(L["reorder_point_change_pct"])), reorder)
        changes.append(f"Reorder point {L['reorder_point_change_pct']:+.1f}%")

    lead = np.array([int(round(float(p["lead_time_days"]))) for p in prods]) + int(L["lead_time_change_days"] or 0)
    lead = np.clip(lead, 0, 90)
    if L["lead_time_change_days"]:
        changes.append(f"Supplier lead time {int(L['lead_time_change_days']):+d} days")

    shelf = np.array([float(p["shelf_life_days"]) if p.get("shelf_life_days") not in (None, "") else math.inf for p in prods])
    if L["shelf_life_change_pct"]:
        shelf = np.where(np.isfinite(shelf), np.maximum(1, np.round(shelf * (1 + _pct(L["shelf_life_change_pct"])))), shelf)
        changes.append(f"Shelf life {L['shelf_life_change_pct']:+.1f}% (perishables)")
    shelf = np.where(np.isfinite(shelf), np.clip(np.round(shelf), 1, MAX_AGE_BUCKETS - 1), shelf)

    ops = s["operations"]
    open_days = max(1.0, float(ops.get("open_days_per_week") or 7))
    staff = [dict(x) for x in s["staff"]]
    for extra in L["extra_staff"] or []:
        staff.append(extra)
        changes.append(f"Add {extra.get('count', 1)} × {extra.get('role', 'staff')} ({extra.get('hours_per_week', 0)} h/week at ${extra.get('hourly_wage', 0)}/h)")
    hours_factor = 1 + _pct(L["staff_hours_change_pct"])
    if L["staff_hours_change_pct"]:
        changes.append(f"Staff hours available {L['staff_hours_change_pct']:+.1f}%")
    weekly_hours = sum(float(x.get("count", 0)) * float(x.get("hours_per_week", 0)) for x in staff) * hours_factor
    labor_weekly_cost = sum(float(x.get("count", 0)) * float(x.get("hours_per_week", 0)) * float(x.get("hourly_wage", 0)) for x in staff) * hours_factor

    recurring = []
    for e in s["expenses"]:
        amt = float(e["amount"])
        if L["expense_change_pct"]:
            amt *= 1 + _pct(L["expense_change_pct"])
        if e.get("category") == "rent" and L["rent_change_pct"]:
            amt *= 1 + _pct(L["rent_change_pct"])
        recurring.append((e["name"], amt, PERIOD_DAYS.get(e.get("frequency"), 30)))
    if L["expense_change_pct"]:
        changes.append(f"Recurring operating expenses {L['expense_change_pct']:+.1f}%")
    if L["rent_change_pct"]:
        changes.append(f"Rent {L['rent_change_pct']:+.1f}%")

    d = dict(L["delivery"])
    one_time = float(L["one_time_investment"] or 0)
    if one_time:
        changes.append(f"One-time investment ${one_time:,.0f} on day 1")
    if d.get("enabled"):
        one_time += float(d.get("setup_cost") or 0)
        changes.append(
            f"Delivery service: {float(d.get('orders_per_day') or 0):.0f} orders/day × {float(d.get('units_per_order') or 0):.1f} units, "
            f"fee ${float(d.get('fee_per_order') or 0):.2f}, cost ${float(d.get('cost_per_order') or 0):.2f}/order, "
            f"${float(d.get('fixed_monthly_cost') or 0):,.0f}/month fixed, ${float(d.get('setup_cost') or 0):,.0f} setup, "
            f"{float(d.get('cannibalization_pct') or 0):.0f}% of delivery units would have been bought in store"
        )
    unexpected = (float(L["unexpected_expense"] or 0), int(L["unexpected_expense_day"] or 0))
    if unexpected[0]:
        changes.append(f"Unexpected expense ${unexpected[0]:,.0f} on day {unexpected[1] + 1}")
    starting_cash = float(s["finance"]["starting_cash"]) + float(L["starting_cash_change"] or 0)
    if L["starting_cash_change"]:
        changes.append(f"Starting cash {float(L['starting_cash_change']):+,.0f}")
    capacity = float(ops.get("storage_capacity_units") or 0) * (1 + _pct(L["storage_capacity_change_pct"]))
    if L["storage_capacity_change_pct"]:
        changes.append(f"Storage capacity {L['storage_capacity_change_pct']:+.1f}%")
    if L["supply_disruption_prob"]:
        changes.append(f"{float(L['supply_disruption_prob']) * 100:.0f}% of orders delayed by {int(L['disruption_delay_days'])} days")

    return Effective(
        names=[p["name"] for p in prods], ids=ids, price=price, unit_cost=unit_cost, demand=demand,
        cv=np.array([max(0.0, float(p.get("demand_cv", 0.3))) for p in prods]),
        start_inv=np.array([float(p["starting_inventory"]) for p in prods]), shelf=shelf,
        reorder_point=reorder, order_qty=order_qty, lead=lead.astype(int),
        storage_capacity=capacity if capacity > 0 else math.inf,
        labor_hours_per_day=weekly_hours / open_days if staff else 0.0,
        units_per_labor_hour=float(ops.get("units_per_labor_hour") or 0),
        delivery_minutes_per_order=float(ops.get("delivery_minutes_per_order") or 0),
        labor_weekly_cost=labor_weekly_cost, recurring=recurring, delivery=d,
        one_time_day0=one_time, unexpected=unexpected, starting_cash=starting_cash,
        min_cash_buffer=float(s["finance"].get("min_cash_buffer") or 0),
        demand_level_sd=_pct(s["uncertainty"].get("demand_level_pct")),
        supplier_cost_sd=_pct(s["uncertainty"].get("supplier_cost_pct")),
        disruption_prob=float(L["supply_disruption_prob"] or 0), disruption_delay=int(L["disruption_delay_days"] or 0),
        applied_changes=changes,
    )


def simulate(
    spec: dict,
    levers: dict | None = None,
    config: dict | None = None,
    criteria: dict | None = None,
    progress: Callable[[float, str], None] | None = None,
    cancel: threading.Event | None = None,
) -> dict:
    cfg = merge_config(config)
    E = apply_levers(spec, levers or {})
    R, P, H = cfg["runs"], len(E.ids), cfg["horizon_days"]
    stochastic = cfg["mode"] == "monte_carlo"
    rng = np.random.default_rng(cfg["seed"])

    perishable = np.isfinite(E.shelf)
    A = int(max(1, (E.shelf[perishable].max() + 1) if perishable.any() else 1))
    age_idx = np.arange(A)
    shelf_int = np.where(perishable, E.shelf, A + 1).astype(int)
    expire_mask = age_idx[None, :] >= shelf_int[:, None]          # [P, A]

    # Run-level structural uncertainty: the true average demand and supplier
    # prices are not known exactly, so each Monte Carlo run draws its own level.
    if stochastic:
        demand_level = np.clip(rng.normal(1.0, E.demand_level_sd, R), 0.3, 2.0)
        cost_level = np.clip(rng.normal(1.0, E.supplier_cost_sd, R), 0.5, 1.5)
    else:
        demand_level = np.ones(R)
        cost_level = np.ones(R)
    unit_cost = E.unit_cost[None, :] * cost_level[:, None]           # [R, P]

    max_lead = int(E.lead.max()) + E.disruption_delay + 1
    inv = np.zeros((R, P, A))
    inv[:, :, 0] = E.start_inv[None, :]
    pipe = np.zeros((R, P, H + max_lead + 1))
    cash = np.full(R, E.starting_cash)

    d = E.delivery
    delivery_on = bool(d.get("enabled")) and float(d.get("orders_per_day") or 0) > 0
    mix = E.demand / E.demand.sum() if E.demand.sum() > 0 else np.full(P, 1.0 / P)
    upo = float(d.get("units_per_order") or 0)
    cannib = min(1.0, max(0.0, _pct(d.get("cannibalization_pct"))))

    # Accumulators
    acc = {k: np.zeros(R) for k in (
        "sales_revenue", "delivery_revenue", "cogs", "waste_cost", "labor", "fixed_expenses",
        "delivery_costs", "one_time_costs", "units_sold", "units_demanded", "lost_sales_units",
        "waste_units", "stockout_product_days", "capacity_limited_days", "purchases_paid",
        "cash_limited_orders", "storage_limited_orders", "labor_hours_needed", "delivery_orders",
        "delivery_orders_filled", "orders_placed", "units_received", "recurring_paid",
    )}
    prod_sold = np.zeros((R, P))
    prod_waste = np.zeros((R, P))
    prod_lost = np.zeros((R, P))
    prod_stockout_days = np.zeros((R, P))
    min_cash = cash.copy()
    daily = {k: np.zeros((R, H)) for k in ("cash", "revenue", "op_profit", "inventory", "waste", "units_sold", "demand", "costs")}

    daily_recurring = sum(a / p for _, a, p in E.recurring)
    daily_labor = E.labor_weekly_cost / 7.0
    daily_delivery_fixed = float(d.get("fixed_monthly_cost") or 0) / 30.0 if delivery_on else 0.0
    capacity_units = E.labor_hours_per_day * E.units_per_labor_hour if (E.units_per_labor_hour > 0 and E.labor_hours_per_day > 0) else math.inf

    # Day-0 one-time outflows
    cash -= E.one_time_day0
    acc["one_time_costs"] += E.one_time_day0

    report_every = max(1, H // 20)
    for t in range(H):
        if cancel is not None and cancel.is_set():
            raise SimulationCancelled()

        # 1. receive
        inv[:, :, 0] += pipe[:, :, t]
        acc["units_received"] += pipe[:, :, t].sum(axis=1)
        # 2. expire
        if perishable.any():
            expired = (inv * expire_mask[None, :, :]).sum(axis=2)
            inv *= ~expire_mask[None, :, :]
            prod_waste += expired
            day_waste = expired.sum(axis=1)
            day_waste_cost = (expired * unit_cost).sum(axis=1)
            acc["waste_units"] += day_waste
            acc["waste_cost"] += day_waste_cost
        else:
            day_waste = np.zeros(R)
            day_waste_cost = np.zeros(R)

        # 3. demand
        mu = E.demand[None, :] * demand_level[:, None]
        if stochastic:
            shape = np.where(E.cv > 0, 1.0 / np.maximum(E.cv, 1e-6) ** 2, 1e6)
            lam = rng.gamma(np.broadcast_to(shape, (R, P)), mu / shape[None, :])
            walk_in = rng.poisson(lam).astype(float)
        else:
            walk_in = mu.copy()
        if delivery_on:
            exp_orders = float(d["orders_per_day"]) * demand_level
            orders = rng.poisson(exp_orders).astype(float) if stochastic else exp_orders
            incremental = (orders * upo * (1 - cannib))[:, None] * mix[None, :]
            want = walk_in + incremental
        else:
            orders = np.zeros(R)
            want = walk_in
        total_want = want.sum(axis=1)
        acc["units_demanded"] += total_want

        # labor capacity (delivery orders also take handling time)
        if math.isfinite(capacity_units):
            handling_units = orders * E.delivery_minutes_per_order / 60.0 * E.units_per_labor_hour
            cap = np.maximum(0.0, capacity_units - handling_units)
            scale = np.where(total_want > cap, cap / np.maximum(total_want, 1e-9), 1.0)
            acc["capacity_limited_days"] += (scale < 0.999)
            served = want * scale[:, None]
            acc["labor_hours_needed"] += (total_want / E.units_per_labor_hour) + orders * E.delivery_minutes_per_order / 60.0
        else:
            served = want

        # 4. sell FIFO (oldest first)
        remaining = served.copy()
        for a in range(A - 1, -1, -1):
            take = np.minimum(inv[:, :, a], remaining)
            inv[:, :, a] -= take
            remaining -= take
        sold = served - remaining
        lost = want - sold
        stockout = (remaining > 1e-6) & (want > 0)
        prod_sold += sold
        prod_lost += lost
        prod_stockout_days += stockout
        units = sold.sum(axis=1)
        acc["units_sold"] += units
        acc["lost_sales_units"] += lost.sum(axis=1)
        acc["stockout_product_days"] += stockout.sum(axis=1)

        # 5. money in / recurring money out
        sales_rev = (sold * E.price[None, :]).sum(axis=1)
        cogs = (sold * unit_cost).sum(axis=1)
        fill_today = np.where(total_want > 0, units / np.maximum(total_want, 1e-9), 1.0)
        if delivery_on:
            filled_orders = orders * fill_today
            del_rev = filled_orders * float(d.get("fee_per_order") or 0)
            del_var_cost = orders * float(d.get("cost_per_order") or 0)
            acc["delivery_orders"] += orders
            acc["delivery_orders_filled"] += filled_orders
        else:
            del_rev = np.zeros(R)
            del_var_cost = np.zeros(R)
        acc["sales_revenue"] += sales_rev
        acc["delivery_revenue"] += del_rev
        acc["cogs"] += cogs
        cash += sales_rev + del_rev

        paid_today = del_var_cost.copy()
        for _, amount, period in E.recurring:
            if t % period == 0:
                paid_today += amount
        if t % 7 == 6:
            paid_today += E.labor_weekly_cost
        if delivery_on and t % 30 == 0:
            paid_today += float(d.get("fixed_monthly_cost") or 0)
        acc["recurring_paid"] += paid_today
        if E.unexpected[0] and t == min(H - 1, E.unexpected[1]):
            paid_today += E.unexpected[0]
            acc["one_time_costs"] += E.unexpected[0]
        cash -= paid_today
        acc["labor"] += daily_labor
        acc["fixed_expenses"] += daily_recurring
        acc["delivery_costs"] += del_var_cost + daily_delivery_fixed

        # 6. reorder (supplier paid when the order is placed)
        on_hand = inv.sum(axis=2)
        on_order = pipe[:, :, t + 1:].sum(axis=2)
        position = on_hand + on_order
        need = (position <= E.reorder_point[None, :]) & (E.order_qty[None, :] > 0)
        q = np.where(need, E.order_qty[None, :], 0.0)
        if q.any():
            requested = q.sum(axis=1)
            if math.isfinite(E.storage_capacity):
                free = np.maximum(0.0, E.storage_capacity - on_hand.sum(axis=1) - on_order.sum(axis=1))
                s_space = np.where(requested > 0, np.minimum(1.0, free / np.maximum(requested, 1e-9)), 1.0)
            else:
                s_space = np.ones(R)
            cost_req = (q * unit_cost).sum(axis=1) * s_space
            s_cash = np.where(cost_req > 0, np.clip(np.maximum(cash, 0.0) / np.maximum(cost_req, 1e-9), 0.0, 1.0), 1.0)
            acc["storage_limited_orders"] += (s_space < 0.999) & (requested > 0)
            acc["cash_limited_orders"] += (s_cash < 0.999) & (requested > 0)
            q = q * (s_space * s_cash)[:, None]
            spend = (q * unit_cost).sum(axis=1)
            cash -= spend
            acc["purchases_paid"] += spend
            acc["orders_placed"] += (q > 0).sum(axis=1)
            arrive = t + np.maximum(1, E.lead)[None, :].repeat(R, axis=0)
            if E.disruption_prob > 0 and E.disruption_delay > 0:
                if stochastic:
                    delayed = rng.random((R, P)) < E.disruption_prob
                    arrive = arrive + delayed * E.disruption_delay
                else:
                    # Deterministic mode uses the expected delay, rounded to whole days.
                    arrive = arrive + int(round(E.disruption_prob * E.disruption_delay))
            rr, pp = np.nonzero(q > 0)
            np.add.at(pipe, (rr, pp, np.minimum(arrive[rr, pp], pipe.shape[2] - 1)), q[rr, pp])

        # 7. age stock; non-perishable units collect in the oldest bucket
        if A > 1:
            oldest = inv[:, :, -1] + inv[:, :, -2]
            inv[:, :, 1:] = inv[:, :, :-1].copy()
            inv[:, :, 0] = 0.0
            inv[:, :, -1] = oldest

        min_cash = np.minimum(min_cash, cash)
        day_opex = daily_labor + daily_recurring + del_var_cost + daily_delivery_fixed
        daily["cash"][:, t] = cash
        daily["revenue"][:, t] = sales_rev + del_rev
        daily["units_sold"][:, t] = units
        daily["demand"][:, t] = total_want
        daily["inventory"][:, t] = inv.sum(axis=(1, 2))
        daily["waste"][:, t] = day_waste
        daily["costs"][:, t] = cogs + day_waste_cost + day_opex
        daily["op_profit"][:, t] = sales_rev + del_rev - cogs - day_waste_cost - day_opex

        if progress and (t % report_every == 0 or t == H - 1):
            progress((t + 1) / H, f"Day {t + 1} of {H}")

    return _summarize(E, cfg, criteria or {}, acc, inv, unit_cost, min_cash, cash, daily,
                      prod_sold, prod_waste, prod_lost, prod_stockout_days)


def _dist(x: np.ndarray) -> dict:
    x = np.asarray(x, dtype=float)
    return {
        "mean": float(x.mean()), "p10": float(np.percentile(x, 10)), "p50": float(np.percentile(x, 50)),
        "p90": float(np.percentile(x, 90)), "min": float(x.min()), "max": float(x.max()),
    }


def _bands(arr: np.ndarray) -> dict:
    return {
        "p10": np.percentile(arr, 10, axis=0).round(2).tolist(),
        "p50": np.percentile(arr, 50, axis=0).round(2).tolist(),
        "p90": np.percentile(arr, 90, axis=0).round(2).tolist(),
        "mean": arr.mean(axis=0).round(2).tolist(),
    }


def _weekly(arr: np.ndarray, how: str) -> np.ndarray:
    R, H = arr.shape
    weeks = math.ceil(H / 7)
    out = np.zeros((R, weeks))
    for w in range(weeks):
        seg = arr[:, w * 7:(w + 1) * 7]
        out[:, w] = seg.sum(axis=1) if how == "sum" else seg[:, -1]
    return out


def _summarize(E, cfg, criteria, acc, inv, unit_cost, min_cash, cash, daily,
               prod_sold, prod_waste, prod_lost, prod_stockout_days) -> dict:
    R, H = cfg["runs"], cfg["horizon_days"]
    months = H / 30.0
    revenue = acc["sales_revenue"] + acc["delivery_revenue"]
    gross = revenue - acc["cogs"] - acc["waste_cost"]
    opex = acc["labor"] + acc["fixed_expenses"] + acc["delivery_costs"]
    op_profit = gross - opex
    end_inv_units = inv.sum(axis=(1, 2))
    end_inv_value = (inv.sum(axis=2) * unit_cost).sum(axis=1)
    fill = np.where(acc["units_demanded"] > 0, acc["units_sold"] / np.maximum(acc["units_demanded"], 1e-9), 1.0)
    waste_rate = np.where(acc["units_sold"] + acc["waste_units"] > 0,
                          acc["waste_units"] / np.maximum(acc["units_sold"] + acc["waste_units"], 1e-9), 0.0)
    labor_util = np.where(E.labor_hours_per_day > 0, acc["labor_hours_needed"] / max(1e-9, E.labor_hours_per_day * H), 0.0)

    metrics = {
        "revenue": revenue, "sales_revenue": acc["sales_revenue"], "delivery_revenue": acc["delivery_revenue"],
        "cogs": acc["cogs"], "waste_cost": acc["waste_cost"], "gross_profit": gross,
        "labor_cost": acc["labor"], "recurring_expenses": acc["fixed_expenses"], "delivery_costs": acc["delivery_costs"],
        "operating_expenses": opex, "operating_profit": op_profit,
        "avg_monthly_operating_profit": op_profit / months,
        "one_time_costs": acc["one_time_costs"], "profit_after_one_time_costs": op_profit - acc["one_time_costs"],
        "ending_cash": cash, "min_cash": min_cash, "purchases_paid": acc["purchases_paid"],
        "units_sold": acc["units_sold"], "units_demanded": acc["units_demanded"], "lost_sales_units": acc["lost_sales_units"],
        "waste_units": acc["waste_units"], "fill_rate": fill, "waste_rate": waste_rate,
        "stockout_rate": acc["stockout_product_days"] / (H * len(E.ids)),
        "capacity_limited_day_share": acc["capacity_limited_days"] / H,
        "labor_utilization": labor_util if np.ndim(labor_util) else np.full(R, float(labor_util)),
        "ending_inventory_units": end_inv_units, "ending_inventory_value": end_inv_value,
        "cash_limited_orders": acc["cash_limited_orders"], "storage_limited_orders": acc["storage_limited_orders"],
        "delivery_orders": acc["delivery_orders"], "delivery_orders_filled": acc["delivery_orders_filled"],
        "units_received": acc["units_received"], "operating_cash_paid": acc["recurring_paid"],
    }
    summary = {k: _dist(v) for k, v in metrics.items()}

    stochastic = cfg["mode"] == "monte_carlo"
    buffer = float(criteria.get("min_cash_floor", E.min_cash_buffer) if criteria.get("min_cash_floor") is not None else E.min_cash_buffer)
    target = criteria.get("target_monthly_operating_profit")
    probabilities = {
        "cash_below_zero": float((min_cash < 0).mean()),
        "cash_below_buffer": float((min_cash < buffer).mean()),
        "meets_profit_target": float((op_profit / months >= float(target)).mean()) if target is not None else None,
        "basis": f"Share of {R} Monte Carlo runs" if stochastic else "Deterministic run: 1 = happens with expected inputs, 0 = does not",
    }

    constraints = evaluate_constraints(summary, probabilities, criteria, buffer, stochastic, R)
    violated = [c for c in constraints if c["violated"]]
    warnings = []
    if summary["cash_limited_orders"]["mean"] > 0:
        warnings.append(f"Purchases were cut short by lack of cash on average {summary['cash_limited_orders']['mean']:.1f} times. Results include lost sales from those shortages.")
    if summary["storage_limited_orders"]["mean"] > 0:
        warnings.append(f"Orders were limited by storage capacity on average {summary['storage_limited_orders']['mean']:.1f} times.")
    if summary["capacity_limited_day_share"]["mean"] > 0.05:
        warnings.append(f"Staff capacity limited sales on {summary['capacity_limited_day_share']['mean']:.0%} of days.")
    if H % 30:
        warnings.append(f"Horizon of {H} days is not a whole number of 30-day months; monthly figures are pro-rated.")

    weekly_cash = _weekly(daily["cash"], "last")
    weekly_rev = _weekly(daily["revenue"], "sum")
    weekly_profit = _weekly(daily["op_profit"], "sum")
    series = {
        "weeks": list(range(1, weekly_cash.shape[1] + 1)),
        "cash": _bands(weekly_cash),
        "revenue": _bands(weekly_rev),
        "operating_profit": _bands(weekly_profit),
        "cumulative_operating_profit": _bands(np.cumsum(weekly_profit, axis=1)),
        "inventory_units": _bands(_weekly(daily["inventory"], "last")),
        "waste_units": _bands(_weekly(daily["waste"], "sum")),
    }
    daily_expected = {k: daily[k].mean(axis=0).round(3).tolist() for k in ("revenue", "costs", "units_sold", "demand", "op_profit")}

    per_product = []
    for i, (pid, name) in enumerate(zip(E.ids, E.names)):
        per_product.append({
            "id": pid, "name": name,
            "price": round(float(E.price[i]), 4), "unit_cost": round(float(E.unit_cost[i]), 4),
            "expected_daily_demand": round(float(E.demand[i]), 3),
            "units_sold": float(prod_sold[:, i].mean()), "revenue": float((prod_sold[:, i] * E.price[i]).mean()),
            "waste_units": float(prod_waste[:, i].mean()), "lost_sales_units": float(prod_lost[:, i].mean()),
            "stockout_day_share": float(prod_stockout_days[:, i].mean() / H),
        })

    return {
        "engine_version": ENGINE_VERSION,
        "config": cfg,
        "applied_changes": E.applied_changes,
        "summary": summary,
        "probabilities": probabilities,
        "constraints": constraints,
        "outcome": "failed_constraints" if violated else "passed",
        "warnings": warnings,
        "series": series,
        "daily_expected": daily_expected,
        "per_product": per_product,
    }


def _share(p: float) -> str:
    return f"{p:.0%}" if p >= 0.01 or p == 0 else "under 1%"


def evaluate_constraints(summary: dict, probs: dict, criteria: dict, buffer: float, stochastic: bool, runs: int) -> list[dict]:
    """Only these explicit checks can mark a scenario as failed."""
    tol = criteria.get("max_shortfall_probability")
    if tol is None:
        tol = RISK_TOLERANCE_SHORTFALL.get(criteria.get("risk_tolerance", "medium"), 0.10)
    tol = float(tol)
    out = []
    if stochastic:
        p = probs["cash_below_buffer"]
        out.append({
            "key": "cash_floor", "label": f"Cash stays above ${buffer:,.0f}",
            "limit": f"at most {tol:.0%} of runs dip below", "value": f"{_share(p)} of runs dip below",
            "violated": p > tol, "basis": f"{runs} Monte Carlo runs; risk tolerance allows {tol:.0%}",
        })
    else:
        v = summary["min_cash"]["mean"]
        out.append({
            "key": "cash_floor", "label": f"Cash stays above ${buffer:,.0f}", "limit": f"${buffer:,.0f}",
            "value": f"lowest point ${v:,.0f}", "violated": v < buffer, "basis": "Deterministic run with expected inputs",
        })
    target = criteria.get("target_monthly_operating_profit")
    if target is not None:
        target = float(target)
        if stochastic:
            p = probs["meets_profit_target"]
            out.append({
                "key": "profit_target", "label": f"Operating profit of at least ${target:,.0f}/month",
                "limit": "met in at least 50% of runs", "value": f"met in {_share(p)} of runs",
                "violated": p < 0.5, "basis": "Median outcome must reach the target",
            })
        else:
            v = summary["avg_monthly_operating_profit"]["mean"]
            out.append({
                "key": "profit_target", "label": f"Operating profit of at least ${target:,.0f}/month",
                "limit": f"${target:,.0f}/month", "value": f"${v:,.0f}/month", "violated": v < target,
                "basis": "Deterministic run with expected inputs",
            })
    if criteria.get("max_waste_rate") is not None:
        lim = float(criteria["max_waste_rate"])
        v = summary["waste_rate"]["mean"]
        out.append({"key": "waste", "label": f"Waste at most {lim:.0%} of units", "limit": f"{lim:.0%}", "value": f"{v:.1%}", "violated": v > lim, "basis": "Average across runs"})
    if criteria.get("min_fill_rate") is not None:
        lim = float(criteria["min_fill_rate"])
        v = summary["fill_rate"]["mean"]
        out.append({"key": "fill_rate", "label": f"At least {lim:.0%} of demand served", "limit": f"{lim:.0%}", "value": f"{v:.1%}", "violated": v < lim, "basis": "Average across runs"})
    if criteria.get("max_investment") is not None:
        lim = float(criteria["max_investment"])
        v = summary["one_time_costs"]["max"]
        out.append({"key": "budget", "label": f"One-time spending within ${lim:,.0f} budget", "limit": f"${lim:,.0f}", "value": f"${v:,.0f}", "violated": v > lim + 1e-6, "basis": "Largest one-time spend in any run"})
    return out


def default_criteria(spec: dict) -> dict:
    s = normalize_spec(spec)
    g = s["goals"]
    return {
        "min_cash_floor": float(s["finance"].get("min_cash_buffer") or 0),
        "target_monthly_operating_profit": g.get("target_monthly_operating_profit"),
        "max_waste_rate": g.get("max_waste_rate"),
        "min_fill_rate": g.get("min_fill_rate"),
        "max_investment": g.get("max_investment_budget"),
        "risk_tolerance": g.get("risk_tolerance", "medium"),
    }
