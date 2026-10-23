"""Market research briefs: public data gathered for one business, kept in labelled sections.

A brief never mixes kinds of numbers:
    observed      Open Prices shelf prices, Frankfurter reference rates, GDELT articles
    historical    World Bank annual indicators
    calculated    What-if arithmetic on the above (currency moves, conversions, proposed lever values)
    ai_generated  an optional AI reading of the brief, checked so it cannot introduce new numbers

Sources that fail are reported as failed. Nothing is filled in for them.
Proposed scenarios are only created when the user applies them.
"""
from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

from pydantic import BaseModel, Field

from .agents.llm import llm, ungrounded_numbers
from .sources import CONNECTORS, frankfurter, gdelt, open_food_facts, open_prices, world_bank
from .sources.base import SourceError, utcnow_iso
from .sources.frankfurter import convert
from .sources.open_food_facts import BARCODE

# ISO 3166 alpha-2 → name used by GDELT's sourcecountry operator, local currency.
COUNTRIES: dict[str, dict] = {
    "PH": {"name": "Philippines", "currency": "PHP"}, "US": {"name": "United States", "currency": "USD"},
    "GB": {"name": "United Kingdom", "currency": "GBP"}, "FR": {"name": "France", "currency": "EUR"},
    "DE": {"name": "Germany", "currency": "EUR"}, "ES": {"name": "Spain", "currency": "EUR"},
    "IT": {"name": "Italy", "currency": "EUR"}, "IN": {"name": "India", "currency": "INR"},
    "ID": {"name": "Indonesia", "currency": "IDR"}, "MY": {"name": "Malaysia", "currency": "MYR"},
    "SG": {"name": "Singapore", "currency": "SGD"}, "TH": {"name": "Thailand", "currency": "THB"},
    "VN": {"name": "Vietnam", "currency": "VND"}, "JP": {"name": "Japan", "currency": "JPY"},
    "CA": {"name": "Canada", "currency": "CAD"}, "AU": {"name": "Australia", "currency": "AUD"},
    "NO": {"name": "Norway", "currency": "NOK"}, "SE": {"name": "Sweden", "currency": "SEK"},
}
BRIEF_INDICATORS = ("FP.CPI.TOTL.ZG", "NY.GDP.MKTP.KD.ZG", "NE.CON.PRVT.KD.ZG", "SL.UEM.TOTL.ZS", "FR.INR.LEND")
MAX_PRODUCT_LOOKUPS = 8      # Open Prices product queries per brief
MAX_OFF_LOOKUPS = 3          # Open Food Facts allows 15 product reads per minute per IP


def _attempt(fn, *args, **kwargs) -> tuple[dict | None, dict | None]:
    try:
        return fn(*args, **kwargs), None
    except SourceError as exc:
        return None, exc.as_dict()


def _status(source: str, ok: bool, error: dict | None = None, **extra) -> dict:
    return {"source": source, "status": "ok" if ok else "failed", "error": error, **extra}


# --------------------------------------------------------------- price data

def _product_matches(spec: dict, cc: str) -> tuple[list[dict], list[str]]:
    """Exact barcode matches between the business's products and Open Prices records in this country."""
    notes: list[str] = []
    coded = [p for p in spec.get("products", []) if BARCODE.match(str(p.get("id", "")))]
    if not coded:
        notes.append("None of this business's product ids are barcodes (8–14 digits), so no product can be matched exactly to Open Prices "
                     "or Open Food Facts. Import a product list whose id column holds EAN/UPC barcodes to enable matching.")
        return [], notes
    if len(coded) > MAX_PRODUCT_LOOKUPS:
        notes.append(f"Looked up the first {MAX_PRODUCT_LOOKUPS} of {len(coded)} barcoded products to stay within the sources' request limits.")
    out, off_used = [], 0
    for p in coded[:MAX_PRODUCT_LOOKUPS]:
        code = str(p["id"])
        res, err = _attempt(open_prices.product_observations, code, cc, 100)
        row: dict = {"product_id": code, "business_name": p.get("name"), "business_price": p.get("price"),
                     "business_unit_cost": p.get("unit_cost"), "error": err}
        if res:
            obs = res["observations"]
            row.update(observations=obs, observations_in_country=len(obs), observations_worldwide=res["total_worldwide"],
                       source_urls=res["source_urls"])
            local = [o["price"] for o in obs if isinstance(o["price"], (int, float))]
            if local:
                currencies = sorted({o["currency"] for o in obs if o["currency"]})
                row["observed_range"] = {"kind": "calculated", "min": min(local), "max": max(local), "n": len(local), "currencies": currencies,
                                         "note": "Lowest and highest recorded prices, not an average. Each is one shopper's record."}
            meta = next((o["product"] for o in obs if o["product"] and o["product"]["name"]), None)
            if meta:
                row["metadata"] = {**meta, "via": "Open Prices (synced from Open Food Facts)"}
        if not row.get("metadata") and off_used < MAX_OFF_LOOKUPS:
            off_used += 1
            m, merr = _attempt(open_food_facts.product, code)
            if m and m.get("found"):
                row["metadata"] = {**m, "via": "Open Food Facts"}
            elif m:
                row["metadata_note"] = m["note"]
            else:
                row["metadata_error"] = merr
        out.append(row)
    return out, notes


def gather_prices(cc: str, spec: dict) -> dict:
    res, err = _attempt(open_prices.country_observations, cc, 500)
    if err:
        return {"status": _status("open_prices", False, err), "data": None}
    matches, notes = _product_matches(spec, cc)
    latest = res["observations"][:12]
    return {"status": _status("open_prices", True, retrieved_at=res["retrieved_at"], urls=res["source_urls"][:3]),
            "data": {"coverage": res["coverage"], "latest": latest, "product_matches": matches, "matching_notes": notes,
                     "source_urls": res["source_urls"], "retrieved_at": res["retrieved_at"]}}


# ------------------------------------------------------------ economy / news

def gather_economy(cc: str) -> dict:
    rows, errors = [], []
    for code in BRIEF_INDICATORS:
        r, err = _attempt(world_bank.indicator, cc, code, 8)
        if r:
            age = date.today().year - int(r["latest"]["year"]) if r["latest"] else None
            r["latest_age_years"] = age
            r["stale"] = age is None or age > 3
            rows.append(r)
        else:
            errors.append({"indicator": code, **err})
    ok = bool(rows)
    return {"status": _status("world_bank", ok, errors[0] if errors and not ok else None, partial_errors=errors if ok else []),
            "data": {"indicators": rows, "errors": errors} if ok else None}


def default_news_query(business_type: str) -> str:
    words = [w for w in re.findall(r"[A-Za-z]{3,}", business_type or "") if w.lower() not in ("and", "the", "general", "store", "shop")]
    return f"{(words[0] if words else 'retail').lower()} prices"


def gather_news(query: str, cc: str) -> dict:
    name = COUNTRIES.get(cc, {}).get("name")
    r, err = _attempt(gdelt.articles, query, name, "1month", 15)
    if err:
        return {"status": _status("gdelt", False, err), "data": None}
    return {"status": _status("gdelt", True, retrieved_at=r["retrieved_at"], urls=[r["source_url"]]), "data": r}


# ---------------------------------------------------------------- currency

def gather_fx(supplier_ccy: str | None, business_ccy: str, imported_share_pct: float | None) -> dict:
    if not supplier_ccy or supplier_ccy == business_ccy:
        return {"status": None, "data": None}
    rate, err = _attempt(frankfurter.rate, supplier_ccy, business_ccy)
    if err:
        return {"status": _status("frankfurter", False, err), "data": None}
    start = (date.today() - timedelta(days=365)).isoformat()
    series, serr = _attempt(frankfurter.series, supplier_ccy, business_ccy, start, None)
    calc = None
    if series and len(series["points"]) >= 20:
        pts = series["points"]
        first, last = pts[0], pts[-1]
        change = (last["rate"] / first["rate"] - 1) * 100
        # Largest rise from any day to a later day: the worst move an importer would have faced in this window.
        low, worst, worst_pair = pts[0], 0.0, None
        for p in pts[1:]:
            if p["rate"] < low["rate"]:
                low = p
            rise = (p["rate"] / low["rate"] - 1) * 100
            if rise > worst:
                worst, worst_pair = rise, (low, p)
        calc = {"kind": "calculated", "one_year_change_pct": round(change, 2), "from": first, "to": last,
                "largest_rise_pct": round(worst, 2), "largest_rise_from": worst_pair[0] if worst_pair else None,
                "largest_rise_to": worst_pair[1] if worst_pair else None, "points": len(pts),
                "method": f"Change in {business_ccy} per 1 {supplier_ccy} between the first and last published rates in the window; "
                          "largest rise is the biggest increase from any day's rate to a later day's rate."}
    data = {"rate": rate, "series": series, "series_error": serr, "change": calc,
            "example_conversion": convert(100, rate), "imported_share_pct": imported_share_pct}
    return {"status": _status("frankfurter", True, retrieved_at=rate["retrieved_at"], urls=[rate["source_url"]]), "data": data}


# --------------------------------------------------------------- proposals

def _prov(src: str, url: str | None, retrieved: str | None) -> str:
    return f"Source: {src}, {url or 'no URL'}, retrieved {retrieved or 'unknown time'}."


def proposals(economy: dict | None, fx: dict | None, business_ccy: str, supplier_ccy: str | None) -> list[dict]:
    """Scenario suggestions derived only from retrieved data. The user decides whether to create them."""
    out: list[dict] = []
    cpi = next((i for i in (economy or {}).get("indicators", []) if i["code"] == "FP.CPI.TOTL.ZG" and i["latest"]), None)
    if cpi:
        latest = cpi["latest"]
        out.append({
            "id": "cpi-latest", "source": "world_bank", "name": f"Supplier costs follow {latest['year']} inflation",
            "kind": "custom", "levers": {"supplier_cost_change_pct": round(latest["value"], 2)},
            "method": f"Purchase costs rise by the latest annual consumer price inflation for {cpi['country']} ({latest['year']}).",
            "assumptions": [
                f"Purchase costs rise {latest['value']:.2f}%, the {latest['year']} consumer price inflation rate (World Bank {cpi['code']}).",
                "General inflation is a proxy. Your suppliers' actual increases may be higher or lower.",
                _prov("World Bank", cpi["source_url"], cpi["retrieved_at"]),
            ],
            "inputs": [{"kind": "historical", "code": cpi["code"], "year": latest["year"], "value": latest["value"], "source_url": cpi["source_url"]}],
        })
        reported = [s for s in cpi["series"] if s["value"] is not None]
        peak = max(reported, key=lambda s: s["value"]) if reported else None
        if peak and peak["year"] != latest["year"] and peak["value"] > latest["value"]:
            out.append({
                "id": "cpi-peak", "source": "world_bank", "name": f"Supplier costs follow {peak['year']} inflation (recent high)",
                "kind": "stress", "levers": {"supplier_cost_change_pct": round(peak["value"], 2)},
                "method": f"Purchase costs rise by the highest annual inflation rate in the retrieved years ({peak['year']}).",
                "assumptions": [
                    f"Purchase costs rise {peak['value']:.2f}%, the highest annual consumer price inflation in "
                    f"{reported[0]['year']}–{reported[-1]['year']} (World Bank {cpi['code']}, {peak['year']}).",
                    "Tests whether the business copes if a high-inflation year repeats.",
                    _prov("World Bank", cpi["source_url"], cpi["retrieved_at"]),
                ],
                "inputs": [{"kind": "historical", "code": cpi["code"], "year": peak["year"], "value": peak["value"], "source_url": cpi["source_url"]}],
            })
    share = (fx or {}).get("imported_share_pct")
    ch = (fx or {}).get("change")
    if ch and share:
        rate = fx["rate"]
        prov = (rate.get("provider") or {}).get("name") or "blended central-bank reference rates"
        for pid, pct, label, when in (
            ("fx-year", ch["one_year_change_pct"], "past year", f"{ch['from']['date']} to {ch['to']['date']}"),
            ("fx-worst", ch["largest_rise_pct"], "largest rise in the past year",
             f"{(ch['largest_rise_from'] or {}).get('date')} to {(ch['largest_rise_to'] or {}).get('date')}"),
        ):
            if pid == "fx-worst" and (not ch["largest_rise_from"] or pct <= max(0.0, ch["one_year_change_pct"])):
                continue
            lever = round(pct * share / 100, 2)
            out.append({
                "id": pid, "source": "frankfurter", "name": f"{supplier_ccy}/{business_ccy} moves like the {label}",
                "kind": "stress" if pid == "fx-worst" else "custom", "levers": {"supplier_cost_change_pct": lever},
                "method": f"{pct:+.2f}% currency move × {share:g}% of purchase costs paid in {supplier_ccy} = {lever:+.2f}% purchase costs.",
                "assumptions": [
                    f"The {supplier_ccy}→{business_ccy} rate moves {pct:+.2f}% ({when}, {prov}).",
                    f"{share:g}% of purchase costs are paid in {supplier_ccy} (your figure).",
                    "Suppliers pass currency changes through in full and immediately; real contracts may lag or share the change.",
                    _prov("Frankfurter", rate["source_url"], rate["retrieved_at"]),
                ],
                "inputs": [{"kind": "observed", "series_from": ch["from"], "series_to": ch["to"], "source_url": (fx.get("series") or {}).get("source_url")},
                           {"kind": "user", "imported_share_pct": share}],
            })
    return out


# ------------------------------------------------------------ AI reading

class ResearchReading(BaseModel):
    summary: str = Field(description="Two or three sentences on what the retrieved data means for this business.")
    implications: list[str] = Field(max_length=5, description="Concrete things to check or test in simulations.")
    caveats: list[str] = Field(max_length=4)


def _numbers(obj, out: list[float]) -> list[float]:
    if isinstance(obj, bool):
        return out
    if isinstance(obj, (int, float)):
        out.append(float(obj))
    elif isinstance(obj, dict):
        for v in obj.values():
            _numbers(v, out)
    elif isinstance(obj, list):
        for v in obj:
            _numbers(v, out)
    elif isinstance(obj, str):
        for m in re.findall(r"-?\d+(?:\.\d+)?", obj):
            out.append(float(m))
    return out


def ai_reading(facts: dict) -> dict:
    if not llm.available:
        return {"kind": "ai_generated", "available": False, "reason": "No AI model is configured on this server, so there is no AI reading. All data above is shown as retrieved."}
    system = ("You read public market data gathered for a small business and explain what it implies. Use only the facts given. "
              "Do not add numbers that are not in the facts. Crowdsourced price records are individual observations, not market averages. "
              "Missing data is unknown, not zero. Be plain and specific.")
    out = llm.structured(system, "Facts (JSON):\n" + json.dumps(facts, default=str)[:24000], ResearchReading, effort="low")
    if out is None:
        return {"kind": "ai_generated", "available": False, "reason": llm.last_error or "The AI reading could not be produced."}
    text = " ".join([out.summary, *out.implications, *out.caveats])
    bad = ungrounded_numbers(text, _numbers(facts, []))
    if bad:
        return {"kind": "ai_generated", "available": False,
                "reason": f"The AI reading was discarded because it contained numbers not found in the data ({', '.join(bad[:4])})."}
    return {"kind": "ai_generated", "available": True, "model": llm.model, **out.model_dump(),
            "note": "Written by an AI model from the data above. Numbers were checked against the retrieved data."}


# ------------------------------------------------------------------ brief

def build_brief(spec: dict, business_type: str, country: str, supplier_currency: str | None,
                imported_share_pct: float | None, news_query: str | None, business_currency: str | None = None) -> dict:
    cc = country.upper()
    meta = COUNTRIES.get(cc, {})
    business_ccy = (business_currency or (spec.get("business") or {}).get("currency") or meta.get("currency") or "USD").upper()
    supplier_ccy = supplier_currency.upper() if supplier_currency else None
    query = (news_query or "").strip() or default_news_query(business_type)
    with ThreadPoolExecutor(max_workers=4) as ex:
        f_prices = ex.submit(gather_prices, cc, spec)
        f_econ = ex.submit(gather_economy, cc)
        f_news = ex.submit(gather_news, query, cc)
        f_fx = ex.submit(gather_fx, supplier_ccy, business_ccy, imported_share_pct)
        prices, econ, news, fx = f_prices.result(), f_econ.result(), f_news.result(), f_fx.result()

    limitations: list[str] = []
    requests: list[dict] = []
    statuses = [s for s in (prices["status"], econ["status"], news["status"], fx["status"]) if s]
    for s in statuses:
        if s["status"] == "failed":
            limitations.append(f"{CONNECTORS[s['source']].info.name} could not be used: {s['error']['message']}")
    cov = (prices["data"] or {}).get("coverage")
    if cov and not cov.get("sufficient"):
        limitations.append(f"Open Prices has {cov['observations']} price records for {meta.get('name', cc)}, too few to benchmark prices.")
        requests.append({"kind": "upload", "what": "Your supplier price list or recent purchase invoices",
                         "why": "Real purchase costs replace What-if defaults in the digital twin.", "where": "Digital Twin → Import data → Products"})
    if business_ccy != meta.get("currency") and meta:
        limitations.append(f"The business model is in {business_ccy} but {meta['name']} uses {meta['currency']}. Prices are not converted automatically; "
                           f"set the model currency in the Digital Twin if this business trades in {meta['currency']}.")
    for i in ((econ["data"] or {}).get("indicators") or []):
        if i["stale"]:
            yr = i["latest"]["year"] if i["latest"] else "no year"
            limitations.append(f"World Bank {i['label'].lower()} for {i['country']} is not recent (latest: {yr}). It is shown for context only.")
    if supplier_ccy and supplier_ccy != business_ccy and not imported_share_pct:
        limitations.append(f"No currency scenario was proposed because the share of purchase costs paid in {supplier_ccy} is unknown.")
        requests.append({"kind": "input", "what": f"Share of purchase costs paid in {supplier_ccy}",
                         "why": "Needed to turn exchange-rate moves into a supplier-cost change.", "where": "Research brief form"})
    if not any(BARCODE.match(str(p.get("id", ""))) for p in spec.get("products", [])):
        requests.append({"kind": "upload", "what": "A product list with barcodes (EAN/UPC) in the id column",
                         "why": "Lets What-if match your products to Open Prices and Open Food Facts records exactly.", "where": "Digital Twin → Import data → Products"})
    requests.append({"kind": "connection", "what": "Your point-of-sale or sales export",
                     "why": "Public data describes the market, not your store. Your own sales are the only basis for calibrated demand.",
                     "where": "Digital Twin → Import data → Sales, or Live Data (Prometheus)"})

    props = proposals(econ["data"], fx["data"], business_ccy, supplier_ccy)
    facts = {"country": meta.get("name", cc), "business_type": business_type, "business_currency": business_ccy,
             "price_coverage": {k: cov.get(k) for k in ("observations", "date_first", "date_last", "latest_age_days", "freshness",
                                                         "distinct_products", "by_currency", "sufficient")} if cov else "unavailable",
             "indicators": [{"label": i["label"], "latest": i["latest"], "stale": i["stale"], "unit": i["unit"]}
                            for i in ((econ["data"] or {}).get("indicators") or [])],
             "fx": {"pair": f"{supplier_ccy}/{business_ccy}", "rate": fx["data"]["rate"]["rate"], "date": fx["data"]["rate"]["rate_date"],
                    "change": {k: (fx["data"]["change"] or {}).get(k) for k in ("one_year_change_pct", "largest_rise_pct")}} if fx["data"] else None,
             "news_headlines": [a["title"] for a in ((news["data"] or {}).get("articles") or [])[:10]],
             "proposals": [{"name": p["name"], "levers": p["levers"]} for p in props],
             "limitations": limitations}
    return {
        "country": cc, "country_name": meta.get("name", cc), "business_currency": business_ccy, "supplier_currency": supplier_ccy,
        "imported_share_pct": imported_share_pct, "news_query": query, "generated_at": utcnow_iso(),
        "sources": statuses,
        "observed": {"prices": prices["data"], "fx": ({k: fx["data"][k] for k in ("rate", "series", "series_error")} if fx["data"] else None),
                     "news": news["data"]},
        "historical": {"indicators": (econ["data"] or {}).get("indicators") or [], "errors": (econ["data"] or {}).get("errors") or []},
        "calculated": {"fx_change": (fx["data"] or {}).get("change"), "example_conversion": (fx["data"] or {}).get("example_conversion")},
        "proposals": props,
        "ai_reading": ai_reading(facts),
        "limitations": limitations,
        "requests": requests,
        "applied": {},
    }
