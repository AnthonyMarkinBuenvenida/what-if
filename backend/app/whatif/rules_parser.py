"""Rule-based reading of "What if ...?" questions (used when no AI provider is connected).

This is pattern matching, not AI. It recognises the common decision types,
turns them into levers, and marks every value it had to assume so the user
can confirm or change it. Anything it does not recognise is reported back
rather than guessed.
"""
from __future__ import annotations

import re

from .schemas import Levers, Profile

WORDNUM = {"a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
           "nine": 9, "ten": 10, "a couple of": 2, "a few": 3, "another": 1, "an extra": 1, "one more": 1}
UP = r"(?:increase|increases|increased|rise|rises|raise|raises|go up|goes up|grow|grows|jump|jumps|climb|climbs|up)"
DOWN = r"(?:decrease|decreases|decreased|fall|falls|drop|drops|decline|declines|go down|goes down|lower|reduce|reduces|cut|cuts|down|shrink|shrinks)"
NUM = r"(\d+(?:\.\d+)?)"
TROPICAL = {"PH", "TH", "VN", "ID", "MY", "SG", "IN", "KH", "LA", "MM", "BD", "LK"}
SOUTHERN = {"AU", "NZ", "ZA", "AR", "CL", "UY", "BR"}


def _sign(word: str) -> int:
    return -1 if re.fullmatch(DOWN, word.strip(), re.I) else 1


def _count(token: str) -> float | None:
    token = token.strip().lower()
    if re.fullmatch(r"\d+(?:\.\d+)?", token):
        return float(token)
    return WORDNUM.get(token)


def _money(token: str) -> float | None:
    t = token.lower().replace(",", "").strip()
    mult = 1.0
    if t.endswith("k"):
        mult, t = 1000.0, t[:-1]
    elif t.endswith("m"):
        mult, t = 1_000_000.0, t[:-1]
    try:
        return float(re.sub(r"[^\d.]", "", t)) * mult
    except ValueError:
        return None


def _season_months(word: str, country: str) -> tuple[list[int], str]:
    w = word.lower()
    if any(x in w for x in ("holiday", "christmas", "festive", "year-end", "year end")):
        return [11, 12], "Holiday season = November and December"
    if "summer" in w:
        if country in TROPICAL:
            return [3, 4, 5], "Summer = March to May (tropical dry season)"
        if country in SOUTHERN:
            return [12, 1, 2], "Summer = December to February (southern hemisphere)"
        return [6, 7, 8], "Summer = June to August"
    if "winter" in w:
        if country in SOUTHERN:
            return [6, 7, 8], "Winter = June to August (southern hemisphere)"
        return [12, 1, 2], "Winter = December to February"
    if "rainy" in w or "monsoon" in w or "wet season" in w:
        return [6, 7, 8, 9, 10], "Rainy season = June to October"
    if "dry season" in w:
        return [3, 4, 5], "Dry season = March to May"
    if "back to school" in w or "back-to-school" in w:
        return [6, 8], "Back to school = June and August"
    return [], ""


def parse(question: str, profile: Profile) -> dict:
    q = " " + re.sub(r"\s+", " ", question.strip()) + " "
    ql = q.lower()
    lv: dict = {}
    rec: list[dict] = []
    questions: list[str] = []
    used: list[tuple[int, int]] = []

    def note(lever: str, label: str, value, source: str = "stated", match: re.Match | None = None, unit: str = "%"):
        rec.append({"lever": lever, "label": label, "value": value, "unit": unit, "source": source, "text": match.group(0).strip() if match else ""})
        if match:
            used.append(match.span())

    # Products named in the question (for price/cost changes that target one product)
    named = [p for p in profile.products if re.search(r"\b" + re.escape(p.name.lower()) + r"\b", ql)]

    # --- selling price
    m = re.search(rf"\b({UP}|{DOWN}|discount|mark ?down|hike)\s+(?:my |our |the )?(?:selling |sale |retail )?prices?\b(?:\s+of\s+[^%\d]+?)?\s*(?:by|to)?\s*{NUM}\s*(%|percent)", ql) \
        or re.search(rf"\bprices?\s+(?:of [^%\d]+?)?({UP}|{DOWN})\s+(?:by\s+)?{NUM}\s*(%|percent)", ql) \
        or re.search(rf"\b{NUM}\s*(%|percent)\s+(price (?:cut|increase|rise|drop|reduction)|discount|cheaper|more expensive)", ql)
    if m:
        g = m.groups()
        if re.match(r"\d", g[0] or ""):
            val, word = float(g[0]), g[2]
            sign = -1 if any(x in word for x in ("cut", "drop", "reduction", "discount", "cheaper")) else 1
        else:
            word, val = g[0], float(g[1])
            sign = -1 if (word.startswith("discount") or word.startswith("mark") or _sign(word) < 0) else 1
        lv["price_change_pct"] = sign * val
        if named:
            lv["price_product_ids"] = [p.id for p in named]
        note("price_change_pct", "Selling price" + (f" ({', '.join(p.name for p in named)})" if named else " (all products)"), sign * val, match=m)

    # --- variable / ingredient / supplier cost
    cost_words = r"(?:ingredient|ingredients|supplier|supply|material|materials|raw material|input|fertili[sz]er|feed|seed|packaging|purchase|wholesale|product|unit|variable|production|hosting|cloud|cost of goods)"
    m = re.search(rf"\b{cost_words}\s*(?:costs?|prices?)\s+({UP}|{DOWN})\s+(?:by\s+)?{NUM}\s*(%|percent)", ql) \
        or re.search(rf"\b({UP}|{DOWN})\s+(?:in\s+)?(?:my |our |the )?{cost_words}\s*(?:costs?|prices?)\s+(?:by\s+)?{NUM}\s*(%|percent)", ql) \
        or re.search(rf"\b{cost_words}\s*(?:costs?|prices?)\s+(?:are |were |go |goes )?{NUM}\s*(%|percent)\s+(higher|lower|more|less)", ql)
    if m:
        g = m.groups()
        if g[0] and re.match(r"\d", g[0]):
            val, sign = float(g[0]), (-1 if g[2] in ("lower", "less") else 1)
        else:
            val, sign = float(g[1]), _sign(g[0])
        lv["unit_cost_change_pct"] = sign * val
        note("unit_cost_change_pct", "Variable cost per unit", sign * val, match=m)

    # --- seasonal demand (checked before general demand)
    m = re.search(rf"\b(?:customer |customers'? )?(?:demand|sales|traffic|orders|bookings|harvest|yield)\s+({UP}|{DOWN})\s+(?:by\s+)?{NUM}\s*(%|percent)\s+(?:during|in|over|for)\s+(?:the\s+)?([a-z\- ]+?(?:season|summer|winter|holidays|christmas))", ql) \
        or re.search(rf"\b(?:during|in|over)\s+(?:the\s+)?([a-z\- ]+?(?:season|summer|winter|holidays|christmas))[, ]+(?:customer )?(?:demand|sales|harvest|yield)\s+({UP}|{DOWN})\s+(?:by\s+)?{NUM}\s*(%|percent)", ql) \
        or re.search(rf"\b(?:customer )?(?:demand|sales)\s+({UP}|{DOWN})s?\s+(?:during|in)\s+(?:the\s+)?([a-z\- ]+?(?:season|summer|winter|holidays|christmas))", ql)
    if m:
        g = [x for x in m.groups() if x is not None]
        word = next(x for x in g if re.fullmatch(f"{UP}|{DOWN}", x))
        season = next(x for x in g if re.search(r"season|summer|winter|holiday|christmas", x))
        nums = [x for x in g if re.fullmatch(NUM, x)]
        months, explain = _season_months(season, profile.business.country)
        if months:
            if nums:
                val, src = float(nums[0]), "stated"
            else:
                val, src = 20.0, "assumed"
                questions.append(f"How much does demand change during the {season.strip()}? What-if assumed {val:+g}%.")
            season = re.sub(r"^the\s+", "", season.strip())
            sh = {"months": months, "demand_change_pct": _sign(word) * val, "label": season.capitalize()}
            lv.setdefault("seasonal", []).append(sh)
            note("seasonal", f"{season.strip().capitalize()} demand ({explain})", _sign(word) * val, src, m)
    # --- general demand / sales volume
    if "seasonal" not in lv:
        m = re.search(rf"\b(?:my |our |the |monthly |customer )*(?:sales|demand|customers|orders|bookings|traffic|sales volume|volume|visitors|sign-?ups)\s+(?:\w+\s+){{0,2}}?({UP}|{DOWN})\s+(?:by\s+)?{NUM}\s*(%|percent)", ql) \
            or re.search(rf"\b(?:lose|losing|gain|gaining)\s+{NUM}\s*(%|percent)\s+of\s+(?:my |our )?(?:customers|sales|orders)", ql)
        if m:
            g = m.groups()
            if g[0] and re.match(r"\d", g[0]):
                val = float(g[0])
                sign = -1 if m.group(0).strip().startswith("los") else 1
            else:
                val, sign = float(g[1]), _sign(g[0])
            key = "new_customers_change_pct" if profile.subscription.enabled and "sign" in m.group(0) else "demand_change_pct"
            lv[key] = sign * val
            note(key, "New sign-ups" if key.startswith("new_") else "Customer demand", sign * val, match=m)

    # --- hiring / staff changes
    m = re.search(r"\b(hire|hires|hiring|add|adding|recruit|bring on|employ|take on)\s+(\d+|a couple of|a few|one more|an extra|another|one|two|three|four|five|six|seven|eight|nine|ten|a|an)\s+(?:additional |more |new |extra |part-time |full-time )?([a-z\- ]{2,30}?)(?:s)?\b(?=[ ,.?!]|$)", ql)
    staff_words = r"(employee|staff|worker|people|person|barista|crew|engineer|developer|stylist|cashier|cook|chef|server|associate|specialist|operator|labou?rer|assistant|nurse|driver|technician|designer|sales ?person|shift|helper|farmhand|picker)"
    if m and re.search(staff_words, m.group(3)):
        n = _count(m.group(2)) or 1
        role = m.group(3).strip()
        role = role[:-1] if role.endswith("s") and not role.endswith("ss") else role
        lv.setdefault("staff_changes", []).append({"role": role.capitalize(), "count": n})
        wage = None
        for s in profile.staff:
            if s.role.lower().rstrip("s") in role or role in s.role.lower():
                wage = s.monthly_wage
        if wage is not None:
            lv["staff_changes"][-1]["monthly_wage"] = wage
        note("staff_changes", f"Add {n:g} {role}{'s' if n != 1 else ''}", n, match=m, unit="people")
        if wage is None:
            questions.append(f"What will each new {role} cost per month? What-if used your current average staff cost.")
            rec.append({"lever": "staff_changes.monthly_wage", "label": "Cost per new person", "value": None, "unit": "",
                        "source": "assumed", "text": "current average monthly staff cost"})
        if profile.operations.capacity_per_staff is None and profile.operations.monthly_capacity_units:
            questions.append("Will the new staff let you serve more customers? If so, add a capacity change.")
    m = re.search(r"\b(lay off|let go|cut|fire|remove|reduce staff by)\s+(\d+|one|two|three|four|five|a|an)\s+(?:of my |of our )?([a-z\- ]{2,30}?)(?:s)?\b(?=[ ,.?!]|$)", ql)
    if m and re.search(staff_words, m.group(3)):
        n = _count(m.group(2)) or 1
        lv.setdefault("staff_changes", []).append({"role": m.group(3).strip().capitalize(), "count": -n})
        note("staff_changes", f"Remove {n:g} {m.group(3).strip()}", -n, match=m, unit="people")

    # --- new branch / location
    m = re.search(r"\b(open|opening|launch|start|add)\s+(?:a |an |one |another |second |a second |new |a new |one more )+(branch|location|store|shop|outlet|kiosk|stall|site|franchise|restaurant|cafe|café|clinic|salon|factory|plant)\b", ql)
    if m:
        monthly = sum(s.count * s.monthly_wage for s in profile.staff) + sum(c.monthly_amount for c in profile.fixed_costs)
        nb = {"setup_cost": round(monthly * 4, -2), "monthly_fixed_cost": round(monthly * 0.9, -2), "demand_share_pct": 70, "ramp_months": 4}
        mm = re.search(r"(?:cost|costs|set ?up|investment|invest)\s+(?:of\s+|about\s+|around\s+)?([\d,\.]+\s*[km]?)", ql)
        if mm and _money(mm.group(1)):
            nb["setup_cost"] = _money(mm.group(1))
            note("new_branch.setup_cost", "Set-up cost of the new location", nb["setup_cost"], "stated", mm, unit="")
        else:
            questions.append(f"What would the new {m.group(2)} cost to set up? What-if assumed {nb['setup_cost']:,.0f} (about four months of today's fixed costs).")
        questions.append(f"What would it cost to run each month? What-if assumed {nb['monthly_fixed_cost']:,.0f} (90% of today's staff and fixed costs).")
        questions.append("How busy would it be compared with today? What-if assumed 70% of today's demand after a 4-month ramp-up.")
        lv["new_branch"] = nb
        note("new_branch", f"Open another {m.group(2)}", None, match=m, unit="")
        rec.append({"lever": "new_branch", "label": "New location figures", "value": None, "unit": "", "source": "assumed",
                    "text": f"set-up {nb['setup_cost']:,.0f}, running costs {nb['monthly_fixed_cost']:,.0f}/month, 70% of today's demand"})

    # --- marketing / advertising
    m = re.search(r"\b(increase|increases|raise|boost|double|triple|cut|reduce|halve|lower|stop|spend more on|spend less on)\s+(?:my |our |the )?(?:advertising|marketing|ads|ad|promotion|promotions)\s*(?:budget|spend|spending)?(?:\s+(?:by|to)\s+([\d,\.]+\s*[km]?)\s*(%|percent)?)?", ql) \
        or re.search(r"\b(?:advertising|marketing|ad)\s*(?:budget|spend|spending)?\s+(?:goes |go )?(up|down)\s+(?:by\s+)?([\d\.]+)\s*(%|percent)", ql)
    if m:
        verb = m.group(1)
        amount, is_pct = (m.group(2), bool(m.group(3))) if m.lastindex and m.lastindex >= 2 else (None, False)
        to_value = " to " in m.group(0)
        if verb == "double":
            lv["marketing_change_pct"], src = 100.0, "stated"
        elif verb == "triple":
            lv["marketing_change_pct"], src = 200.0, "stated"
        elif verb == "halve":
            lv["marketing_change_pct"], src = -50.0, "stated"
        elif verb == "stop":
            lv["marketing_change_pct"], src = -100.0, "stated"
        elif amount and is_pct:
            sign = -1 if verb in ("cut", "reduce", "lower", "spend less on", "down") else 1
            lv["marketing_change_pct"], src = sign * float(amount), "stated"
        elif amount and _money(amount) is not None and to_value:
            lv["marketing_budget"], src = _money(amount), "stated"
        elif amount and _money(amount) is not None:
            sign = -1 if verb in ("cut", "reduce", "lower", "spend less on") else 1
            lv["marketing_budget"], src = max(0.0, profile.marketing.monthly_budget + sign * _money(amount)), "stated"
        else:
            sign = -1 if verb in ("cut", "reduce", "lower", "spend less on") else 1
            lv["marketing_change_pct"], src = sign * 25.0, "assumed"
            questions.append(f"By how much? What-if assumed {sign * 25:+g}% on today's budget of {profile.marketing.monthly_budget:,.0f} per month.")
        if "marketing_budget" in lv:
            note("marketing_budget", "Marketing budget per month", lv["marketing_budget"], src, m, unit="")
        else:
            note("marketing_change_pct", "Marketing budget", lv["marketing_change_pct"], src, m)
        if profile.marketing.monthly_budget == 0 and profile.marketing.units_per_1000 is None:
            questions.append("Today's marketing budget is zero, so What-if needs to know how many extra sales each 1,000 spent would bring (Business setup → Marketing).")

    # --- new product
    m = re.search(r"\b(introduce|introducing|launch|launching|add|adding|sell|selling|offer|offering)\s+(?:a |an )?new\s+([a-z\- ]{2,25}?)\b(?=[ ,.?!]|$)", ql)
    if m and not re.search(r"branch|location|store|shop|outlet|employee|staff|worker", m.group(2)):
        prods = profile.products
        avg_price = sum(p.price * p.monthly_units for p in prods) / max(1, sum(p.monthly_units for p in prods))
        avg_cost = sum(p.unit_cost * p.monthly_units for p in prods) / max(1, sum(p.monthly_units for p in prods))
        units = round(sum(p.monthly_units for p in prods) / len(prods) * 0.25)
        npd = {"name": f"New {m.group(2).strip()}", "price": round(avg_price, 2), "unit_cost": round(avg_cost, 2), "monthly_units": units, "cannibalization_pct": 25}
        pm = re.search(r"(?:priced at|price of|sell(?:s|ing)? (?:it )?for|at)\s+\$?([\d\.]+)", ql)
        if pm:
            npd["price"] = float(pm.group(1))
            note("new_product.price", "New product price", npd["price"], "stated", pm, unit="")
        lv["new_product"] = npd
        note("new_product", f"Introduce {npd['name'].lower()}", None, match=m, unit="")
        rec.append({"lever": "new_product", "label": "New product figures", "value": None, "unit": "", "source": "assumed",
                    "text": f"price {npd['price']:g}, cost {npd['unit_cost']:g}, {units:,} units/month, 25% taken from existing products"})
        questions.append(f"What would the new {m.group(2).strip()} sell for and cost to make? What-if used your average price ({avg_price:,.2f}) and cost ({avg_cost:,.2f}).")
        questions.append(f"How many would you sell per month? What-if assumed {units:,} (a quarter of an average product).")

    # --- rent, wages, other fixed costs, capacity, churn, investment
    for key, pat, label in (
        ("rent_change_pct", rf"\brent\s+(?:\w+\s+){{0,2}}?({UP}|{DOWN})\s+(?:by\s+)?{NUM}\s*(%|percent)", "Rent"),
        ("wage_change_pct", rf"\b(?:wages?|salar(?:y|ies)|minimum wage|pay|labou?r costs?)\s+(?:\w+\s+){{0,2}}?({UP}|{DOWN})\s+(?:by\s+)?{NUM}\s*(%|percent)", "Wages"),
        ("fixed_cost_change_pct", rf"\b(?:utilit(?:y|ies)|electricity|power|overheads?|fixed costs?|operating expenses|bills)\s+(?:\w+\s+){{0,2}}?({UP}|{DOWN})\s+(?:by\s+)?{NUM}\s*(%|percent)", "Other fixed costs"),
        ("capacity_change_pct", rf"\bcapacity\s+(?:\w+\s+){{0,2}}?({UP}|{DOWN})?\s*(?:by\s+)?{NUM}\s*(%|percent)", "Capacity"),
    ):
        m = re.search(pat, ql)
        if m:
            word, val = (m.group(1) or "up"), float(m.group(2))
            lv[key] = _sign(word) * val
            note(key, label, lv[key], match=m)
    m = re.search(rf"\b(?:adds?|adding|with)\s+{NUM}\s*(%|percent)\s+(?:more\s+)?capacity", ql)
    if m and "capacity_change_pct" not in lv:
        lv["capacity_change_pct"] = float(m.group(1))
        note("capacity_change_pct", "Capacity", lv["capacity_change_pct"], match=m)
    m = re.search(rf"\bchurn\s+(?:\w+\s+){{0,2}}?({UP}|{DOWN})\s+(?:by\s+)?{NUM}\s*(points?|pts|percentage points|%)?", ql)
    if m:
        lv["churn_change_pts"] = _sign(m.group(1)) * float(m.group(2))
        note("churn_change_pts", "Monthly churn", lv["churn_change_pts"], match=m, unit="points")
    m = re.search(r"\binvest(?:ing|ment of)?\s+(?:in\s+[a-z\- ]+?\s+(?:for|costing|worth)\s+)?\$?([\d,\.]+\s*[km]?)\b", ql) \
        or re.search(r"\b(?:machine|equipment|renovation|irrigation|upgrade|system)\s+(?:that )?(?:costs?|costing|for|worth)\s+\$?([\d,\.]+\s*[km]?)\b", ql)
    if m and _money(m.group(1)):
        lv["one_time_investment"] = _money(m.group(1))
        note("one_time_investment", "One-time investment", lv["one_time_investment"], match=m, unit="")
    elif re.search(r"\binvest(?:ing)?\s+in\s+(?:a |an |new )?(machine|equipment|irrigation|renovation|upgrade|system|oven|vehicle)", ql):
        questions.append("How much would the investment cost? Add it as a one-time investment.")

    # --- horizon
    m = re.search(r"\b(?:over|for|in|during)\s+(?:the\s+)?(?:next\s+)?(\d{1,2})\s+months?\b", ql)
    if m and 1 <= int(m.group(1)) <= 36:
        lv["horizon_months"] = int(m.group(1))
        note("horizon_months", "Simulation period", int(m.group(1)), match=m, unit="months")
    elif re.search(r"\bnext (?:two|2) years\b", ql):
        lv["horizon_months"] = 24
        rec.append({"lever": "horizon_months", "label": "Simulation period", "value": 24, "unit": "months", "source": "stated", "text": "next two years"})

    # Anything left that looks like a request but was not matched
    leftover = ql
    for a, b in sorted(used, reverse=True):
        leftover = leftover[:a] + " " + leftover[b:]
    leftover = re.sub(r"\b(what|if|happens|would|happen|i|we|my|our|the|a|an|and|by|to|of|in|on|for|then|also|while|with|do|does|will|should|it|is|are|be|what's|whats|so|that|at|this|if i|when|how|much|more|less|than|me)\b", " ", leftover)
    leftover = re.sub(r"[^a-z0-9%]+", " ", leftover).strip()
    unrecognized = leftover if len(leftover) > 3 and not rec else (leftover if len(leftover.split()) >= 3 else None)

    clean = Levers.model_validate(lv).model_dump(exclude_defaults=True) if lv else {}
    name = _name(rec) or "Custom scenario"
    if not rec:
        questions.insert(0, "What-if could not match this question to a change it can simulate. Try wording like "
                            "\"lower my price by 10%\", \"ingredient costs increase 15%\", \"hire two employees\" or \"open another branch\", "
                            "or set the changes with the controls.")
    return {"mode": "rules", "levers": clean, "recognized": rec, "questions": questions, "unrecognized": unrecognized, "name": name}


def _name(rec: list[dict]) -> str:
    parts = []
    for r in rec:
        if r["source"] == "assumed" and r["value"] is None:
            continue
        if r["lever"] in ("price_change_pct", "unit_cost_change_pct", "demand_change_pct", "marketing_change_pct", "rent_change_pct", "wage_change_pct", "capacity_change_pct", "new_customers_change_pct", "fixed_cost_change_pct"):
            parts.append(f"{r['label'].split(' (')[0]} {r['value']:+g}%")
        elif r["lever"] == "seasonal":
            parts.append(f"{r['label'].split(' (')[0]} {r['value']:+g}%")
        elif r["lever"] in ("staff_changes", "new_branch", "new_product", "one_time_investment", "marketing_budget"):
            parts.append(r["label"] if r["lever"] != "one_time_investment" else f"Invest {r['value']:,.0f}")
        elif r["lever"] == "churn_change_pts":
            parts.append(f"Churn {r['value']:+g} pts")
    return ", ".join(parts[:3])[:110]
