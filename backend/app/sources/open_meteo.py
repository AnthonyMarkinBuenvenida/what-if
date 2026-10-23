"""Open-Meteo — weather forecasts and place search (no API key).

Docs: https://open-meteo.com/en/docs and https://open-meteo.com/en/docs/geocoding-api
Endpoints used (verified live 2026-10-22):
    GET https://api.open-meteo.com/v1/forecast?latitude=..&longitude=..&current=..&daily=..&timezone=auto&forecast_days=16
    GET https://geocoding-api.open-meteo.com/v1/search?name=..&count=5&language=en&format=json
Terms (https://open-meteo.com/en/terms): free for non-commercial use, fewer than
10,000 calls per day / 5,000 per hour / 600 per minute; data under CC-BY 4.0.
Commercial use needs a paid plan.

Labelling: daily values are forecasts for future days (kind "forecast"). The
`current` block is Open-Meteo's model estimate for the present 15-minute
interval, not a weather-station reading, so it is labelled "current model
estimate", never "observed". Local times are returned in the location's
timezone; the UTC offset is attached so they are unambiguous.

Configuration (backend/.env), so a commercially licensed source can replace the free API:
    WHATIF_WEATHER_PROVIDER      open_meteo (default) | none
    WHATIF_OPEN_METEO_BASE_URL   default https://api.open-meteo.com/v1
                                 (paid plans use https://customer-api.open-meteo.com/v1)
    WHATIF_OPEN_METEO_API_KEY    sent as `apikey` for paid plans only
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

from .base import Connector, SourceInfo

DAILY = ("temperature_2m_max", "temperature_2m_min", "precipitation_sum", "precipitation_probability_max", "wind_speed_10m_max")
CURRENT = ("temperature_2m", "relative_humidity_2m", "precipitation", "weather_code", "wind_speed_10m")

# WMO weather interpretation codes, as listed in the Open-Meteo documentation.
WMO = {0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Depositing rime fog",
       51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle", 56: "Light freezing drizzle", 57: "Dense freezing drizzle",
       61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain", 66: "Light freezing rain", 67: "Heavy freezing rain",
       71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow", 77: "Snow grains", 80: "Slight rain showers",
       81: "Moderate rain showers", 82: "Violent rain showers", 85: "Slight snow showers", 86: "Heavy snow showers",
       95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail"}


def provider() -> str:
    return os.getenv("WHATIF_WEATHER_PROVIDER", "open_meteo").strip().lower()


class OpenMeteo(Connector):
    info = SourceInfo(
        id="open_meteo", name="Open-Meteo", base_url="https://api.open-meteo.com/v1",
        docs_url="https://open-meteo.com/en/docs", min_interval=0.25, cache_seconds=3 * 3600,
        timeout=15, max_wait=10, retries=1,
        rate_note="free non-commercial tier: under 600 calls/minute and 10,000/day (CC-BY 4.0)",
    )

    def forecast(self, latitude: float, longitude: float, days: int = 16) -> dict:
        if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
            raise self.fail("invalid_request", f"Coordinates {latitude}, {longitude} are outside the valid range.")
        base = os.getenv("WHATIF_OPEN_METEO_BASE_URL", "").rstrip("/") or self.info.base_url
        f = self.get(f"{base}/forecast", {"latitude": round(latitude, 4), "longitude": round(longitude, 4), "current": ",".join(CURRENT),
                                          "daily": ",".join(DAILY), "timezone": "auto", "forecast_days": max(1, min(16, days)),
                                          "apikey": os.getenv("WHATIF_OPEN_METEO_API_KEY") or None})
        d = f.data
        if not isinstance(d, dict) or d.get("error"):
            raise self.fail("invalid_response", f"Open-Meteo rejected the request: {d.get('reason') if isinstance(d, dict) else 'unexpected body'}.", f.url)
        daily = d.get("daily") or {}
        times = daily.get("time") or []
        if not times:
            raise self.fail("invalid_response", "Open-Meteo returned no daily forecast.", f.url)
        rows = []
        for i, day in enumerate(times):
            row = {"date": day}
            for key in DAILY:
                vals = daily.get(key) or []
                row[key] = vals[i] if i < len(vals) else None  # missing stays missing
            rows.append(row)
        offset = timedelta(seconds=d.get("utc_offset_seconds") or 0)
        tz = timezone(offset)
        cur = d.get("current") or {}
        current = None
        if cur.get("time"):
            local = datetime.fromisoformat(cur["time"]).replace(tzinfo=tz)
            current = {"kind": "current_model_estimate", "time_local": local.isoformat(), "time_utc": local.astimezone(timezone.utc).isoformat(),
                       "interval_seconds": cur.get("interval"), "units": d.get("current_units") or {},
                       **{k: cur.get(k) for k in CURRENT},
                       "weather": WMO.get(cur.get("weather_code"), f"WMO code {cur.get('weather_code')}") if cur.get("weather_code") is not None else None}
        return {
            "kind": "forecast", "source": self.info.id, "latitude": d.get("latitude"), "longitude": d.get("longitude"),
            "timezone": d.get("timezone"), "timezone_abbreviation": d.get("timezone_abbreviation"), "utc_offset_seconds": d.get("utc_offset_seconds"),
            "units": d.get("daily_units") or {}, "days": rows, "current": current,
            "forecast_period": {"from": times[0], "to": times[-1], "days": len(times)},
            "source_url": f.url, "retrieved_at": f.retrieved_at, "cached": f.cached,
            "license": "CC-BY 4.0, weather data by Open-Meteo.com",
        }

    def geocode(self, name: str, country_code: str | None = None) -> dict:
        name = (name or "").strip()
        if len(name) < 2:
            raise self.fail("invalid_request", "Enter at least two letters of a place name.")
        f = self.get("https://geocoding-api.open-meteo.com/v1/search", {"name": name, "count": 8, "language": "en", "format": "json"})
        d = f.data if isinstance(f.data, dict) else {}
        results = d.get("results") or []
        places = [{
            "name": r.get("name"), "admin1": r.get("admin1"), "country": r.get("country"), "country_code": r.get("country_code"),
            "latitude": r.get("latitude"), "longitude": r.get("longitude"), "timezone": r.get("timezone"),
        } for r in results if r.get("latitude") is not None and r.get("longitude") is not None]
        if country_code:
            local = [p for p in places if (p["country_code"] or "").upper() == country_code.upper()]
            places = local or places
        return {"kind": "observed", "source": self.info.id, "query": name, "places": places[:5],
                "source_url": f.url, "retrieved_at": f.retrieved_at, "cached": f.cached}

    def _url(self, path: str, params: dict | None) -> str:
        # Absolute URLs (geocoding host, a configured commercial base URL) are used as given.
        if path.startswith("https://"):
            from urllib.parse import urlencode
            clean = {k: v for k, v in (params or {}).items() if v is not None and v != ""}
            return f"{path}?{urlencode(clean)}" if clean else path
        return super()._url(path, params)


open_meteo = OpenMeteo()
