"""Weatherstack: current weather conditions at the business location (apilayer, API key required).

Docs: https://weatherstack.com/documentation
Endpoint used: GET https://api.weatherstack.com/current?access_key=..&query=<lat>,<lon>&units=m
Plans (https://weatherstack.com/product, 2026-10-23): the free plan has current weather only,
100 requests/month, non-commercial use. Forecasts need the Professional plan, so What-if keeps
Open-Meteo for the 16-day forecast and shows Weatherstack's reading beside it.

Labelling: Weatherstack's `observation_time` is the UTC time it says the data was collected.
The reading is shown as "reported by Weatherstack" with that time, not as a forecast.

Configuration (backend/.env):
    WHATIF_WEATHERSTACK_API_KEY   your key; leave unset to skip Weatherstack
"""
from __future__ import annotations

from .apilayer import ApiLayer
from .base import SourceInfo


class Weatherstack(ApiLayer):
    key_env = "WHATIF_WEATHERSTACK_API_KEY"
    info = SourceInfo(
        id="weatherstack", name="Weatherstack", base_url="https://api.weatherstack.com",
        docs_url="https://weatherstack.com/documentation", min_interval=1.0, cache_seconds=3 * 3600,
        timeout=15, max_wait=10, retries=1,
        rate_note="free plan: 100 requests/month, current weather only, non-commercial",
    )

    def current(self, latitude: float, longitude: float) -> dict:
        if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
            raise self.fail("invalid_request", f"Coordinates {latitude}, {longitude} are outside the valid range.")
        f = self.call("/current", {"query": f"{latitude:.4f},{longitude:.4f}", "units": "m"})
        d = f.data if isinstance(f.data, dict) else {}
        cur, loc = d.get("current") or {}, d.get("location") or {}
        if cur.get("temperature") is None:
            raise self.fail("invalid_response", "Weatherstack returned no current temperature.", f.url)
        return {
            "kind": "current_reported", "source": self.info.id,
            "observation_time_utc": cur.get("observation_time"), "localtime": loc.get("localtime"),
            "place": ", ".join(x for x in (loc.get("name"), loc.get("country")) if x) or None,
            "weather": ", ".join(cur.get("weather_descriptions") or []) or None,
            "temperature": cur.get("temperature"), "feelslike": cur.get("feelslike"), "humidity": cur.get("humidity"),
            "precip": cur.get("precip"), "wind_speed": cur.get("wind_speed"),
            "units": {"temperature": "°C", "feelslike": "°C", "humidity": "%", "precip": "mm", "wind_speed": "km/h"},
            "source_url": f.url, "retrieved_at": f.retrieved_at, "cached": f.cached,
        }


weatherstack = Weatherstack()
