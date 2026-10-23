# What-if: business decision simulator

What-if simulates business decisions before you make them. Describe a change ("What if I lower my price by 10%?"). A deterministic engine calculates month by month what happens to revenue, profit, cash, break-even and capacity, compared with the current course and with best and worst cases. **Risk Radar** checks the result against written thresholds and suggests actions you can simulate next. An AI model, when connected, reads your question and explains the result. It never produces or changes a number.

Results are simulations under stated assumptions. They are not forecasts or guarantees.

There are no accounts and no login. The workspace opens directly and belongs to your browser.

## Run it locally

Requirements: Python 3.11+ and Node 20+.

```bash
# 1. Backend (API + engine), port 8000
cd backend
python -m venv .venv
.venv/Scripts/activate          # Windows (Git Bash: source .venv/Scripts/activate); macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # optional: AI provider, weather provider, Prometheus
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000

# 2. Frontend (dev server), port 5173, proxies /api to :8000
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. For single-process mode, run `npm run build` in `frontend/`, then restart the backend; it serves the built app at http://127.0.0.1:8000.

| Page | What it does |
|---|---|
| `/` | Landing page with a live preview: the real engine runs on a fictional milk tea shop |
| `/app` | Dashboard: current course for 12 months, actual history, active risks, recent scenarios and insights, data connections |
| `/app/simulate` | Simulation workspace: ask in plain language or use the controls, run, see why the numbers change, save |
| `/app/risk` | Risk Radar: score, warnings filterable by severity, category, metric, date and scope; evidence, rule, impact, "Simulate this" actions; assessment and recommendations for the current course, a saved scenario or one warning |
| `/app/compare` | Scenario comparison: same profile, period and start month; ranked by an objective you choose |
| `/app/setup` | Business setup by industry; every template value is marked as an estimate until you change it |
| `/app/reports` | Reports: frozen snapshots of scenarios, assumptions, results, risks and explanations; CSV export, print to PDF |
| `/app/settings` | AI provider status, external data and licensing, privacy, assumptions, JSON import/export, workspace and audit trail |
| Retail lab | The original Monte Carlo digital-twin tools (`/app/overview`, `/app/twin`, `/app/worlds`, `/app/simulations`, `/app/lab`, …) and the `/demo` walkthrough |

**Demo:** "Open the demo milk tea shop" creates *Sunny Cup Milk Tea (demo)*, a fictional shop in Quezon City with six months of made-up history and six saved scenarios. It is labelled as demo data everywhere.

## Kinds of numbers

Every screen labels what a number is:

| Label | Meaning |
|---|---|
| **Actual** | Past monthly results you entered |
| **Calculated** | Engine output for the inputs and assumptions shown |
| **AI-written** | Wording by an AI model; sentences citing numbers that are not in the calculation are removed before display |
| **From the calculation** | Explanations written by fixed rules from the calculation (used when AI is not connected) |
| **Forecast** / **Historical** / **Observed** | External data: Open-Meteo weather forecast; World Bank annual statistics; Frankfurter published exchange rates, each with source and retrieval time |
| **Estimate** | A What-if default you have not replaced |
| **Demo data** | The fictional demo shop |

## The engine (`backend/app/whatif/engine.py`)

The engine runs monthly over 1 to 36 months. It is deterministic: the same profile and levers always give the same result.

```
Revenue          = selling price × units sold
Variable costs   = variable cost per unit × units sold
Gross profit     = revenue − variable costs
Operating costs  = staff + rent + other fixed costs + marketing (+ new-location running costs)
Net profit       = gross profit − operating costs − tax (tax rate × positive operating profit)
Net margin       = net profit ÷ revenue                     (undefined, not an error, when revenue is 0)
Break-even units = operating costs ÷ contribution per unit  (none when contribution ≤ 0)
Cash flow        = net profit + (variable costs − inventory purchases) − one-time spending − debt payments
```

- **Demand:** current units × (price factor)^elasticity × (1 + demand change) × marketing factor × seasonality × growth × new-location ramp. Lowering a price raises volume only as far as the elasticity says; setting the elasticity to 0 gives no volume response. Elasticities are per product, default estimates are labelled, and you can override them per scenario.
- **Marketing:** (new ÷ current spend)^marketing elasticity, with spend floored at 5% of today's. With no spend today, a stated "extra units per 1,000 spent" is used. If none is given, the result says the response is unknown.
- **Subscriptions** (technology): subscribers = previous × (1 − churn) + new sign-ups. Only new sign-ups respond to price and marketing.
- **Capacity:** fixed, or staff × units per person. Demand above capacity is lost and reported.
- **Inventory:** optional. Stock is restocked to its normal level each month, up to a supplier maximum. Stockouts are reported, and purchases affect cash but not profit.
- **Best and worst cases:** the scenario is recalculated over a grid of demand ±x%, variable costs ±y% and elasticity ±z (27 cases), using your uncertainty ranges.
- **Profit bridge:** an exact decomposition of the change in net profit into volume, price, unit cost, new product, staff, fixed costs, marketing and tax. It sums to the total.
- **Confidence:** starts at 100, with points subtracted for estimated inputs, missing history, large changes, long periods and wide best-to-worst ranges. Every reason is listed.
- **Industries:** food & beverage, retail, manufacturing, technology (subscriptions), agriculture (harvest seasonality) and services. Each has its own units, inputs, starting estimates, seasonality and relevant external data.

## Risk Radar (`backend/app/whatif/risk.py`)

There are 19 written rules: net margin, break-even, unit economics (price at or below cost), cash shortfall and runway, profit versus the current course, operating costs outpacing revenue, revenue decline (seasonally adjusted for entered history), cost pressure on gross margin, capacity, stockouts and excess stock, marketing spend and return, product and supplier concentration, expansion versus cash, profit goal, worst-case loss, churn, severe weather (forecast), inflation (World Bank), and data quality.

Each warning carries its metric, threshold, evidence, what triggered it, estimated impact, what happens without action, and actions that load into the simulator. Severity is shown with a shape and a word, never colour alone: low ● · moderate ▲ · high ◆ · critical ⯃. Score = 100 × (1 − Π(1 − weight)), with weights critical 0.45, high 0.25 and moderate 0.10. Risks are recalculated whenever the profile or a scenario changes, and when Risk Radar opens. Nothing runs in the background.

### Assessment and recommendations (`backend/app/whatif/advisor.py`)

On request, Risk Radar writes an assessment of the current course, a saved scenario or one selected warning, in seven parts: risk overview, why the risk was detected, recommended actions, not recommended, expected impact, what to monitor, and scenarios to test.

- **Adapted to severity:** the section titles, tone and length follow the Radar's level.
  - **Low:** preventive steps, premature actions to avoid, and stress tests. It does not invent problems.
  - **Moderate:** corrective steps and a priority.
  - **High:** immediate actions and next steps, plus what to verify.
  - **Critical:** a short, prioritised containment list, actions to avoid, the supported impact of doing nothing, and a follow-up check. It never implies that failure is certain.
  - **One selected warning:** the assessment uses that warning's severity and also shows the overall level.
- **What the AI receives:** the Radar's findings (metric, threshold, evidence, impact, trigger, data kind, the rule's own test actions); calculated totals and metrics for the current course and the scenario; assumptions with their sources; confidence; summaries of retrieved external data; and the levers it may propose. The business name, description and history rows are not sent. The text of names and labels is marked as data, never instructions.
- **Safeguards:**
  - The Radar's level always wins, and the engine's figures are shown as calculated.
  - Statements citing a number that is not in the facts are removed.
  - References to warnings that do not exist are dropped.
  - Proposed scenarios must pass the `Levers` model, may use only decision levers (no data links, period or tax), and are applied on top of the assessed scope.
  - An empty "not recommended" section is filled from the rules unless the AI explains why nothing is inadvisable.
- **Without AI** (not connected, out of credits, rate-limited, timed out, answer too long or invalid): the same sections are built from the 19 rules and labelled "rule-based". The browser only ever sees a short reason, never provider error text or links.
- **Saved and outdated:** each assessment is stored with a hash of its inputs: the profile, the scope's levers, the period, the selected warning, external data summaries and the prompt version. Asking again with unchanged inputs reuses the saved AI assessment without a new call. "Refresh" forces a new one. Changed inputs mark the saved assessment "Outdated".
- **Scenarios are never run automatically.** Each one shows its proposed values, which can be edited. "Run this simulation" shows the calculated result next to the current course (and the saved scenario), and "Review in simulator" loads the values without running them. No scenario is saved and the business figures are not changed.

## AI

- **Default provider:** Anthropic Claude (`ANTHROPIC_API_KEY`, model `WHATIF_AI_MODEL`, default `claude-opus-5-5`) through structured outputs.
- **Alternative:** set `WHATIF_AI_PROVIDER=openai_compatible` with `WHATIF_AI_BASE_URL`, `WHATIF_AI_MODEL` and `WHATIF_AI_API_KEY` for OpenAI, OpenRouter, Ollama or vLLM.
- **Uses:** turns questions into validated levers (assumed values are marked, missing information becomes questions), explains results, writes Risk Radar assessments, comments on comparisons, and writes the report narrative.
- **Google Gemini (free tier):** use the OpenAI-compatible endpoint: `WHATIF_AI_PROVIDER=openai_compatible`, `WHATIF_AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai`, `WHATIF_AI_MODEL=gemini-3.6-flash` and a Google AI Studio key. Gemini spends part of `WHATIF_AI_MAX_TOKENS` on thinking, so set `WHATIF_AI_REASONING_EFFORT=low` and a budget of about 8000. `WHATIF_AI_FALLBACK_MODELS` (comma-separated, e.g. `gemini-3.5-flash`) is tried when the main model is overloaded (HTTP 503), rate limited (HTTP 429) or slow. The label shows which model answered. The free tier allows about 20 requests a day per model, shared with any other app using the same key.
- **Backup provider:** `WHATIF_AI_BACKUP_BASE_URL`, `WHATIF_AI_BACKUP_API_KEY` and `WHATIF_AI_BACKUP_MODELS` add a second OpenAI-compatible endpoint, tried after the main one (and its fallback models). `WHATIF_AI_BACKUP_EXTRA` is JSON merged into each request. Example: OpenRouter free models (`dots-studio/dots-3-note-preview:free`, `nvidia/nemotron-3.5-super-vl:free`) need no credits, about 50 requests a day per account, with `{"reasoning": {"enabled": false}}`; with thinking on they run out of tokens. They are weaker than Gemini, so every model's answer also passes a wording check: statements that promise an outcome or predict failure are removed, the "if you follow the suggestions" line must be hedged, high and critical assessments always list something to avoid, and while the business is losing money or cash, cost-adding test scenarios are dropped.
- **Answer length and time:** `WHATIF_AI_MAX_TOKENS` caps every answer. An answer cut off at the cap is reported as such and the rule-based path is used. Risk Radar assessments are allowed up to 120 seconds; other calls use `WHATIF_AI_TIMEOUT_SECONDS` (default 60).
- **Safeguards:** responses are schema-validated. Any statement citing a number that is not in the calculation is removed. Timeouts, rate limits, rejected keys and invalid output fall back to the labelled rule-based path.
- **Never sent to the AI:** business name, description, location or history rows.
- **Without a key:** everything still works; the rule-based parser and calculation explanations are used and labelled. **No AI key is configured in this repository.**

## External data

| Source | Endpoint (v2 / v1) | Used for | Kind | Cache | Terms |
|---|---|---|---|---|---|
| Frankfurter | `https://api.frankfurter.dev/v2/rates?base=USD&quotes=PHP` (+ `from`/`to` for 90-day history) | Rate of the business's foreign supply currency → business currency | observed (central-bank reference rate with its date; **not real-time**) | 6 h | free, no key |
| World Bank Indicators | `https://api.worldbank.org/v2/country/PH/indicator/{FP.CPI.TOTL.ZG, FR.INR.LEND, NY.GDP.MKTP.KD.ZG}?format=json&per_page=15` | Inflation, lending rate, GDP growth for the business's country | historical (latest **non-null** year, with its age) | 24 h | CC-BY 4.0, no key |
| Open-Meteo | `https://api.open-meteo.com/v1/forecast?latitude=…&longitude=…&current=…&daily=…&timezone=auto` | Current conditions (model estimate) and 16-day forecast at the business location | forecast | 3 h | **free API is non-commercial only**, under 10,000 calls/day, CC-BY 4.0 ("Weather data by Open-Meteo.com") |
| Weatherstack (optional) | `https://api.weatherstack.com/current?query=<lat>,<lon>&units=m` | Reported current conditions with observation time, beside the Open-Meteo forecast | reported current | 3 h | key required; free plan 100 requests/month, current weather only, non-commercial |
| Marketstack (optional) | `https://api.marketstack.com/v2/eod?symbols=<TICKER>&date_from=…&date_to=…&limit=100` | End-of-day closes and ~90-day move for the ticker in Business setup | observed (end of day, **not real-time**) | 24 h | key required; free plan 100 requests/month, 1 year history, non-commercial |
| Open Prices, Open Food Facts, GDELT | see `backend/app/sources/` | Retail lab market research | observed | varies | no key |

- **When data is fetched:** only when you open or refresh external data (Dashboard, Risk Radar, the simulator's External data panel). There is no background monitoring.
- **Caching:** every response is cached in memory for the period above, so repeat views make no new calls, and each retrieval is stored in the database with its URL and retrieval time.
- **Failures:** timeouts, rate limits, unknown currencies, missing observations and offline conditions are reported as such. If a refresh fails, the last good value is kept, marked **stale** with its age. Nothing is invented.
- **Data gaps:** the World Bank often has no recent value. The Philippines lending rate's latest published year is 2019, and What-if shows that year instead of hiding it.
- **Weather provider:** set `WHATIF_WEATHER_PROVIDER=none` to turn weather off. For a commercial deployment, set `WHATIF_OPEN_METEO_BASE_URL` and `WHATIF_OPEN_METEO_API_KEY` for a paid plan.
- **Weatherstack (optional key):** with `WHATIF_WEATHERSTACK_API_KEY` set, the weather card also shows Weatherstack's reported current conditions with their observation time. Its free plan has no forecast, so forecasts and the weather rule still use Open-Meteo. If Weatherstack fails, the forecast is still shown.
- **Marketstack (optional key):** set a ticker in Business setup → External exposure and `WHATIF_MARKETSTACK_API_KEY`. The "Stock price" signal shows the latest end-of-day close and the move over about 90 days (adjusted closes when available), from one request cached for 24 h. The rule "Your sensitivity to a stock's observed price move" applies your sensitivity × that move to variable costs or demand.
- **API keys:** keys go in `backend/.env` only. They are removed from every URL What-if stores, returns or shows in reports. Both apilayer free plans allow 100 requests a month and non-commercial use only.

### How external data reaches a simulation

Data never changes a scenario or the business baseline by itself. In the simulator's **External data** panel you apply a documented rule. The rule turns the data point into explicit changes, and the scenario keeps a record of it: source, indicator, value and unit, observation year or forecast period, retrieval time, kind, the rule text and the exact amounts applied. Removing the record removes exactly those amounts. Saved scenarios, reports (assumptions table) and CSV exports carry the record.

| Rule | Data | Effect |
|---|---|---|
| Exchange-rate move on imported costs | Frankfurter rate + 90-day move (or a rate you choose to test) | variable cost change = your imported share × rate change |
| Costs rise with published inflation | World Bank inflation, latest year | average cost uplift over the period = rate × (months ÷ 12) ÷ 2, on the costs you pick |
| Interest at the published lending rate | World Bank lending rate, latest year | monthly interest = your loan × rate ÷ 12, added to operating costs |
| Demand adjustment on forecast weather days | Open-Meteo daily forecast | your demand change × (matching forecast days ÷ days in that month), only in those months |
| Your sensitivity to a stock's observed price move | Marketstack end-of-day closes, ~90-day move | variable cost or demand change = your sensitivity × price move |

GDP growth is shown as context only. Set the foreign currency and imported cost share in **Business setup → External exposure**.

## Tests

```bash
cd backend && .venv/Scripts/python -m pytest tests -q   # engine, Risk Radar, AI layer (mocked), API workflow, external data, retail lab
cd backend && STARTUP_LIVE_TESTS=1 .venv/Scripts/python -m pytest tests -q -k live   # also call the real external APIs
cd frontend && npx vitest run                           # retail-lab browser fallback engine parity
cd frontend && npx tsc -b                               # type check
cd frontend && npm run build                            # production build
```

## Architecture

```
frontend/src/
  whatif/            What-if pages, charts, backdrop system (backdrop/), formatting, types
  landing/           landing page with the live engine preview
  app/               app shell (navigation, backdrop state), workspace context, retail lab pages
  demo/              retail lab demo and presentation mode
backend/app/
  whatif/            schemas.py, industries.py, engine.py, risk.py, rules_parser.py, ai.py, signals.py, service.py
  routers/whatif.py  /api/whatif/* (setup, simulate, interpret, explain, scenarios, risk, compare, signals, reports, dashboard, public preview)
  agents/llm.py      provider-switchable, validated LLM access
  sources/           Open-Meteo, World Bank, Frankfurter, Open Prices, Open Food Facts, GDELT connectors
  engine/, domain/   retail lab Monte Carlo engine and digital twin
```

**Theme, background and motion (Ascend).** The app uses the Ascend deep-space theme: near-black navy, a mint accent, Inter type, glass cards and pill buttons (`frontend/src/styles/tokens.css`, `app.css`).

The background (`frontend/src/whatif/backdrop/`) is a fixed WebGL planet (`planet.ts`, three.js r0.143). It is a GLTF Earth with a day/night city-lights and ocean shader, three cloud shells, an atmosphere halo, stars, ambient motes and golden land markers, composited through bloom and a corner-flame pass. Each page picks a context:

- **Landing:** the planet rises from below on load, then zooms out and swings left and right as you scroll.
- **App, simulation, risk:** the planet is held low as a dimmed horizon, at a lower pixel ratio.
  - Simulation and risk pages add an analytical grid, with a scan line only while a calculation runs.
  - The business's industry adds a faint line-art scene at the bottom, and scenarios that commit money switch it to finance.
- **Report:** plain; all backdrop layers are removed in print.

Lenis gives smooth scrolling, and `[data-reveal]` elements fade up in a stagger as they enter the view (`frontend/src/lib/scrollfx.tsx`). Under reduced motion, Lenis, the entrance and every time-based animation are off, and all content shows immediately.

three.js loads in its own chunk after first paint. Without WebGL, or if the planet assets cannot be fetched, the deep-space gradient remains.

**External assets:** visitors' browsers fetch the planet files (`planet.glb`, `planet-lights.glb`, `planet-clouds.png`, about 1.9 MB in total) from the Ascend asset bucket at `api.getlayers.ai`, and the DRACO decoder from `www.gstatic.com`. Host copies yourself, and change `ASSET_BASE_URL` in `planet.ts`, if you need to avoid those third-party requests.

## No-login workspaces

The first visit creates an anonymous workspace, stored in a signed httpOnly cookie (`startup_workspace`, 400 days). Every query is scoped to it. Clearing site data opens a new, empty workspace. State-changing requests need the `X-StartUp-Client` header (CSRF guard). The `startup_`/`STARTUP_` names are kept from before the What-if rename so existing workspaces and configurations keep working. `python -m scripts.workspaces list|move` moves data between workspaces.

## Retail lab: Prometheus live data

The original retail tools can read a Prometheus server (`PROMETHEUS_URL`, see `.env.example`). What-if exposes its own operational telemetry at `/metrics`, and business metrics are used only through an explicit `STARTUP_BUSINESS_METRICS` mapping.

## Known limitations

- Monthly granularity: there are no weekly cycles, receivables or payables, loss carry-forward, competitor reactions or multi-currency costs.
- Constant elasticity is a simplification; large price changes reduce confidence and say so.
- Default estimates are rules of thumb, not market data. Replace them for meaningful results.
- The AI paths are tested with mocked responses. With OpenRouter (`openai_compatible`), question reading and result explanations were verified live. Live Risk Radar assessments were verified with Google Gemini (gemini-3.6-flash, with gemini-3.5-flash as the fallback) for all four levels: Low, Moderate, High and Critical. Each took 8–10 seconds; no statement was removed by the number check, the cited figures matched the engine, and a repeated request reused the saved copy. An earlier OpenRouter account without credits could only complete the Low level.
- PDF export uses the browser's print dialog. CSV is generated by the server.
- External signals refresh only on request; there is no background monitoring.
- Open-Meteo's free API may not be used commercially; World Bank values can be several years old (the latest year is always shown).
- The old Creative Lab database table (`wi_creatives`, empty) is left in existing databases; nothing reads it.
