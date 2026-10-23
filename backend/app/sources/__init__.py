"""Public data-source connectors. See base.py for provenance and data kinds."""
from .frankfurter import frankfurter
from .gdelt import gdelt
from .marketstack import marketstack
from .open_meteo import open_meteo
from .open_food_facts import open_food_facts
from .open_prices import open_prices
from .weatherstack import weatherstack
from .world_bank import world_bank

CONNECTORS = {c.info.id: c for c in (open_prices, open_food_facts, world_bank, gdelt, frankfurter, open_meteo, weatherstack, marketstack)}
