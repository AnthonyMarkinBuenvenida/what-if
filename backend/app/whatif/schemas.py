"""Validated shapes for What-if business profiles and decision levers.

A profile is the business as it is today (the baseline). Levers describe one
proposed decision or condition. Both are plain JSON when stored, and both pass
through these models before the engine sees them, so the engine never has to
guard against missing fields, wrong types or out-of-range values.

All money is in the profile's currency and all flows are per month.
"""
from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

INDUSTRIES = ("food_beverage", "retail", "manufacturing", "technology", "agriculture", "services")
SOURCES = ("user", "default", "imported", "observed", "demo")


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")[:40] or "item"


class _M(BaseModel):
    model_config = ConfigDict(extra="ignore")


# --------------------------------------------------------------------- profile

class Product(_M):
    id: str = ""
    name: str = Field(min_length=1, max_length=120)
    price: float = Field(ge=0, le=1e9, description="Selling price per unit")
    unit_cost: float = Field(ge=0, le=1e9, description="Variable cost per unit (ingredients, materials, packaging, hosting)")
    monthly_units: float = Field(ge=0, le=1e10, description="Units sold per month today (subscribers for subscription businesses)")
    elasticity: float = Field(-1.0, ge=-6, le=1, description="% change in demand for a 1% price change")
    stock_units: float | None = Field(None, ge=0, le=1e10, description="Units on hand today (inventory tracking is off when empty)")
    restock_units_per_month: float | None = Field(None, ge=0, le=1e10, description="Most units suppliers can deliver per month")


class StaffRole(_M):
    id: str = ""
    role: str = Field(min_length=1, max_length=80)
    count: float = Field(ge=0, le=100000)
    monthly_wage: float = Field(ge=0, le=1e8, description="Monthly cost per person, including benefits")


class FixedCost(_M):
    id: str = ""
    name: str = Field(min_length=1, max_length=120)
    category: Literal["rent", "utilities", "software", "insurance", "loan", "maintenance", "other"] = "other"
    monthly_amount: float = Field(ge=0, le=1e9)


class Marketing(_M):
    monthly_budget: float = Field(0, ge=0, le=1e9)
    elasticity: float = Field(0.08, ge=0, le=1, description="% change in demand for a 1% change in marketing spend")
    units_per_1000: float | None = Field(None, ge=0, le=1e7, description="Extra units per 1,000 spent, used when today's budget is zero")


class Operations(_M):
    monthly_capacity_units: float | None = Field(None, ge=0, le=1e11, description="Most units the business can serve or produce per month")
    capacity_per_staff: float | None = Field(None, ge=0, le=1e9, description="If set, capacity = staff count x this value")
    inventory_lead_time_days: float | None = Field(None, ge=0, le=365)


class Subscription(_M):
    enabled: bool = False
    monthly_churn_pct: float = Field(3.0, ge=0, le=100)
    new_customers_per_month: float = Field(0, ge=0, le=1e9)


class Finance(_M):
    starting_cash: float = Field(0, ge=-1e11, le=1e12)
    min_cash_buffer: float = Field(0, ge=0, le=1e12)
    tax_rate_pct: float = Field(0, ge=0, le=70, description="Tax on positive operating profit")
    monthly_debt_payment: float = Field(0, ge=0, le=1e10)


class Growth(_M):
    monthly_growth_pct: float = Field(0, ge=-30, le=30)
    seasonality: list[float] = Field(default_factory=lambda: [1.0] * 12, description="Demand index for Jan..Dec (1.0 = average month)")

    @field_validator("seasonality")
    @classmethod
    def _season(cls, v: list[float]) -> list[float]:
        if len(v) != 12:
            raise ValueError("seasonality needs exactly 12 monthly values (January to December)")
        if any((x is None) or x < 0 or x > 10 for x in v):
            raise ValueError("seasonality values must be between 0 and 10")
        if sum(v) <= 0:
            raise ValueError("seasonality cannot be zero in every month")
        return [float(x) for x in v]


class Goals(_M):
    target_monthly_profit: float | None = Field(None, ge=-1e12, le=1e12)
    max_investment: float | None = Field(None, ge=0, le=1e12)
    min_margin_pct: float | None = Field(None, ge=-100, le=100)


class Supplier(_M):
    name: str = Field(min_length=1, max_length=120)
    share_pct: float = Field(ge=0, le=100, description="Share of purchases from this supplier")


class HistoryRow(_M):
    month: str = Field(pattern=r"^\d{4}-(0[1-9]|1[0-2])$")
    revenue: float = Field(ge=0, le=1e12)
    units: float | None = Field(None, ge=0)
    total_costs: float | None = Field(None, ge=0)
    net_profit: float | None = None


class Location(_M):
    city: str = Field("", max_length=120)
    latitude: float | None = Field(None, ge=-90, le=90)
    longitude: float | None = Field(None, ge=-180, le=180)


class BusinessInfo(_M):
    name: str = Field(min_length=1, max_length=160)
    business_type: str = Field("", max_length=80)
    country: str = Field("", max_length=2)
    currency: str = Field("USD", min_length=3, max_length=3)
    description: str = Field("", max_length=4000)


class External(_M):
    """How this business is exposed to external conditions. Used only by rules the user applies."""
    foreign_currency: str = Field("USD", min_length=3, max_length=3, description="Currency of imported supplies or foreign-priced costs")
    imported_cost_share_pct: float | None = Field(None, ge=0, le=100, description="Share of variable costs priced in the foreign currency")
    market_symbol: str = Field("", max_length=20, description="Stock ticker to follow (a supplier, customer, competitor or sector fund); empty = none")

    @field_validator("foreign_currency")
    @classmethod
    def _ccy(cls, v: str) -> str:
        return v.upper()

    @field_validator("market_symbol")
    @classmethod
    def _symbol(cls, v: str) -> str:
        v = v.strip().upper()
        if v and not re.fullmatch(r"[A-Z0-9][A-Z0-9.\-]{0,19}", v):
            raise ValueError("ticker symbols use letters, digits, '.' or '-' (e.g. AAPL or JFC.XPHS)")
        return v


class Uncertainty(_M):
    demand_pct: float = Field(10, ge=0, le=80, description="± range on demand used for best/worst cases")
    cost_pct: float = Field(5, ge=0, le=80, description="± range on variable costs")
    elasticity_abs: float = Field(0.3, ge=0, le=3, description="± range on price elasticity")


class Profile(_M):
    industry: Literal["food_beverage", "retail", "manufacturing", "technology", "agriculture", "services"]
    business: BusinessInfo
    unit_label: str = Field("units", max_length=30)
    products: list[Product] = Field(min_length=1, max_length=60)
    staff: list[StaffRole] = Field(default_factory=list, max_length=60)
    fixed_costs: list[FixedCost] = Field(default_factory=list, max_length=80)
    marketing: Marketing = Field(default_factory=Marketing)
    operations: Operations = Field(default_factory=Operations)
    subscription: Subscription = Field(default_factory=Subscription)
    finance: Finance = Field(default_factory=Finance)
    growth: Growth = Field(default_factory=Growth)
    goals: Goals = Field(default_factory=Goals)
    suppliers: list[Supplier] = Field(default_factory=list, max_length=40)
    history: list[HistoryRow] = Field(default_factory=list, max_length=120)
    location: Location = Field(default_factory=Location)
    external: External = Field(default_factory=External)
    uncertainty: Uncertainty = Field(default_factory=Uncertainty)
    # path -> one of SOURCES, e.g. {"products.classic.price": "user"}
    provenance: dict[str, str] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _ids(self) -> "Profile":
        for group, key in (("products", "name"), ("staff", "role"), ("fixed_costs", "name")):
            seen: set[str] = set()
            for item in getattr(self, group):
                item.id = item.id or slug(getattr(item, key))
                base, n = item.id, 2
                while item.id in seen:
                    item.id = f"{base}-{n}"
                    n += 1
                seen.add(item.id)
        months = [h.month for h in self.history]
        if len(months) != len(set(months)):
            raise ValueError("history has the same month more than once")
        self.history.sort(key=lambda h: h.month)
        self.business.currency = self.business.currency.upper()
        self.business.country = self.business.country.upper()
        return self


# ---------------------------------------------------------------------- levers

class StaffChange(_M):
    role: str = Field("New staff", max_length=80)
    count: float = Field(ge=-1000, le=1000, description="People added (negative = removed)")
    monthly_wage: float | None = Field(None, ge=0, le=1e8, description="Monthly cost per person; empty = current average")


class NewBranch(_M):
    setup_cost: float = Field(0, ge=0, le=1e11)
    monthly_fixed_cost: float = Field(0, ge=0, le=1e10, description="Rent, staff and running costs of the new location")
    demand_share_pct: float = Field(70, ge=0, le=500, description="New location's demand as % of today's demand once ramped up")
    ramp_months: int = Field(3, ge=0, le=36)


class NewProduct(_M):
    name: str = Field("New product", min_length=1, max_length=120)
    price: float = Field(gt=0, le=1e9)
    unit_cost: float = Field(ge=0, le=1e9)
    monthly_units: float = Field(ge=0, le=1e10)
    cannibalization_pct: float = Field(20, ge=0, le=100, description="Share of its sales taken from existing products")
    launch_cost: float = Field(0, ge=0, le=1e10)


class SeasonalShift(_M):
    months: list[int] = Field(min_length=1, max_length=12)
    demand_change_pct: float = Field(ge=-100, le=1000)
    label: str = Field("Seasonal demand change", max_length=80)
    year_month: str | None = Field(None, pattern=r"^\d{4}-(0[1-9]|1[0-2])$", description="Apply only in this month (e.g. a forecast period), not every year")

    @field_validator("months")
    @classmethod
    def _months(cls, v: list[int]) -> list[int]:
        if any(m < 1 or m > 12 for m in v):
            raise ValueError("months are 1 (January) to 12 (December)")
        return sorted(set(v))


class ExtraCost(_M):
    label: str = Field("Extra monthly cost", max_length=120)
    amount: float = Field(ge=0, le=1e10)


class DataLink(_M):
    """Traceable record of an external data point that changed this scenario's levers."""
    id: str = Field(max_length=40)
    signal: Literal["fx", "inflation", "lending", "gdp", "weather", "market"]
    rule: str = Field(max_length=40)
    source: str = Field(max_length=80)
    indicator: str = Field(max_length=160)
    value: float | None = None
    unit: str = Field("", max_length=40)
    observed_at: str | None = Field(None, max_length=40, description="Observation year/date, or forecast period")
    retrieved_at: str | None = Field(None, max_length=40)
    kind: Literal["observed", "historical", "forecast", "user"]
    rule_text: str = Field(max_length=600)
    params: dict = Field(default_factory=dict)
    applied: dict = Field(default_factory=dict, description="Lever -> amount this link added")
    source_url: str | None = Field(None, max_length=600)


class Levers(_M):
    price_change_pct: float = Field(0, ge=-95, le=1000)
    price_product_ids: list[str] = Field(default_factory=list, description="Empty = all products")
    unit_cost_change_pct: float = Field(0, ge=-95, le=1000)
    cost_product_ids: list[str] = Field(default_factory=list, description="Empty = all products")
    demand_change_pct: float = Field(0, ge=-100, le=1000)
    seasonal: list[SeasonalShift] = Field(default_factory=list, max_length=6)
    marketing_change_pct: float = Field(0, ge=-100, le=5000)
    marketing_budget: float | None = Field(None, ge=0, le=1e10, description="New monthly budget (overrides the % change)")
    staff_changes: list[StaffChange] = Field(default_factory=list, max_length=12)
    wage_change_pct: float = Field(0, ge=-90, le=500)
    rent_change_pct: float = Field(0, ge=-100, le=1000)
    fixed_cost_change_pct: float = Field(0, ge=-100, le=1000, description="All fixed costs except rent, staff and marketing")
    capacity_change_pct: float = Field(0, ge=-100, le=2000)
    new_branch: NewBranch | None = None
    new_product: NewProduct | None = None
    one_time_investment: float = Field(0, ge=0, le=1e11)
    investment_month: int = Field(1, ge=1, le=36)
    tax_rate_pct: float | None = Field(None, ge=0, le=70)
    churn_change_pts: float = Field(0, ge=-100, le=100)
    new_customers_change_pct: float = Field(0, ge=-100, le=5000)
    extra_monthly_costs: list[ExtraCost] = Field(default_factory=list, max_length=10)
    data_links: list[DataLink] = Field(default_factory=list, max_length=12)
    elasticity_override: float | None = Field(None, ge=-6, le=1)
    horizon_months: int = Field(12, ge=1, le=36)
    start_month: str | None = Field(None, pattern=r"^\d{4}-(0[1-9]|1[0-2])$")

    def is_baseline(self) -> bool:
        neutral = Levers(horizon_months=self.horizon_months, start_month=self.start_month)
        return self.model_dump(exclude={"horizon_months", "start_month"}) == neutral.model_dump(exclude={"horizon_months", "start_month"})


OBJECTIVES = {
    "max_profit": "Highest net profit over the period",
    "protect_cash": "Highest lowest-cash point (protects cash flow)",
    "max_revenue": "Highest revenue",
    "lowest_risk": "Lowest risk score",
    "best_margin": "Highest net margin",
}
