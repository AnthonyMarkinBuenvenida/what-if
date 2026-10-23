import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../../lib/api";
import { useAsync } from "../../lib/hooks";
import { useWorkspace } from "../../app/workspace";
import { ErrorBox, Skeleton, Spinner, useToast } from "../../components/ui";
import { IconPlus, IconTrash } from "../../components/icons";
import { money, monthLabel } from "../format";
import type { IndustryInfo, ProfileRow, ProfileSpec } from "../types";
import { DemoButton, KindTag, PageTitle, SourceBadge, useProfile } from "../ui";

const COUNTRIES: [string, string, string][] = [
  ["PH", "Philippines", "PHP"], ["US", "United States", "USD"], ["GB", "United Kingdom", "GBP"], ["DE", "Germany", "EUR"], ["FR", "France", "EUR"],
  ["ES", "Spain", "EUR"], ["IT", "Italy", "EUR"], ["IN", "India", "INR"], ["ID", "Indonesia", "IDR"], ["MY", "Malaysia", "MYR"], ["SG", "Singapore", "SGD"],
  ["TH", "Thailand", "THB"], ["VN", "Vietnam", "VND"], ["JP", "Japan", "JPY"], ["CA", "Canada", "CAD"], ["AU", "Australia", "AUD"], ["NO", "Norway", "NOK"], ["SE", "Sweden", "SEK"],
];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default function Setup() {
  const [params] = useSearchParams();
  const { current } = useWorkspace();
  const prof = useProfile(current?.id);
  const isNew = params.get("new") === "1" || (!prof.loading && !prof.profile && !current);
  const cat = useAsync(() => api.get<{ industries: IndustryInfo[] }>("/api/whatif/industries"), []);
  if (cat.error) return <ErrorBox message={cat.error} onRetry={cat.reload} />;
  if (!cat.data || prof.loading) return <div className="grid gap-4"><Skeleton h={60} w="40%" /><Skeleton h={400} /></div>;
  if (isNew || !prof.profile) return <NewBusiness industries={cat.data.industries} />;
  return <Editor key={prof.profile.id} row={prof.profile} industry={cat.data.industries.find((i) => i.id === prof.profile!.spec.industry)!} onSaved={prof.reload} businessId={current!.id} />;
}

function NewBusiness({ industries }: { industries: IndustryInfo[] }) {
  const { refresh, setCurrentId } = useWorkspace();
  const nav = useNavigate();
  const [industry, setIndustry] = useState(industries[0].id);
  const [name, setName] = useState("");
  const [country, setCountry] = useState("PH");
  const [currency, setCurrency] = useState("PHP");
  const [type, setType] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<{ business: { id: number } }>("/api/whatif/businesses", { name: name.trim(), industry, country, currency, business_type: type });
      await refresh();
      setCurrentId(r.business.id);
      nav("/app/setup", { replace: true });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <div className="grid gap-8">
      <PageTitle title="Set up a business" sub="Choose the kind of business. What-if fills in a starting profile for that industry; every starting value is marked as an estimate until you replace it." actions={<DemoButton className="btn btn-outline" />} />
      <fieldset className="grid gap-3">
        <legend className="label mb-2">Industry</legend>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {industries.map((i) => (
            <label key={i.id} className={`panel interactive grid cursor-pointer gap-1 p-4 ${industry === i.id ? "!border-[var(--signal)]" : ""}`}>
              <span className="flex items-center gap-2"><input type="radio" name="industry" checked={industry === i.id} onChange={() => setIndustry(i.id)} /><b>{i.label}</b></span>
              <span className="text-[0.84rem] text-text-2">{i.examples}</span>
              <span className="text-[0.76rem] text-text-3">Measured in {i.unit_label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="panel glass grid max-w-3xl gap-4 p-5 sm:grid-cols-2">
        <label className="field sm:col-span-2"><span>Business name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={160} placeholder="e.g. Corner Tea House" /></label>
        <label className="field"><span>Kind of business (optional)</span><input className="input" value={type} onChange={(e) => setType(e.target.value)} placeholder={industries.find((i) => i.id === industry)?.examples.split(",")[0]} /></label>
        <label className="field"><span>Country</span>
          <select className="select" value={country} onChange={(e) => { setCountry(e.target.value); setCurrency(COUNTRIES.find((c) => c[0] === e.target.value)?.[2] ?? currency); }}>
            {COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
          </select>
        </label>
        <label className="field"><span>Currency</span><input className="input" value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} /></label>
        <div className="flex items-end"><button className="btn btn-primary" onClick={create} disabled={busy || !name.trim() || currency.length !== 3}>{busy && <Spinner />}Create business</button></div>
        {err && <p className="error-text sm:col-span-2">{err}</p>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ editor

function Editor({ row, industry, onSaved, businessId }: { row: ProfileRow; industry: IndustryInfo; onSaved: () => Promise<void>; businessId: number }) {
  const toast = useToast();
  const { refresh } = useWorkspace();
  const [spec, setSpec] = useState<ProfileSpec>(() => structuredClone(row.spec));
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const has = (s: string) => industry.sections.includes(s);
  const cur = spec.business.currency;
  const dirty = JSON.stringify(spec) !== JSON.stringify(row.spec);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const upd = (path: string, fn: (s: ProfileSpec) => void) => {
    setSpec((p) => { const n = structuredClone(p); fn(n); return n; });
    setTouched((t) => new Set(t).add(path));
  };
  const src = (path: string) => (touched.has(path) ? "user" : spec.provenance[path]);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.put(`/api/whatif/businesses/${businessId}/profile`, { spec, note: "Updated in Business setup." });
      toast("Business figures saved. Risks and simulations now use this version.");
      setTouched(new Set());
      await refresh();
      await onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const estimates = Object.values(spec.provenance).filter((v) => v === "default").length;

  return (
    <div className="grid gap-8">
      <PageTitle title="Business setup" sub={<>Profile version {row.version} of <b className="text-text">{spec.business.name}</b> ({industry.label}). Saving creates a new version; saved scenarios keep the version they were calculated on.</>}
        actions={<button className="btn btn-primary" onClick={save} disabled={busy || !dirty}>{busy && <Spinner />}{dirty ? "Save changes" : "Saved"}</button>} />
      {estimates > 0 && <div className="panel flex flex-wrap items-center gap-2 border-dashed p-3 text-[0.88rem]"><KindTag kind="estimate" />{estimates} values are still What-if estimates. Replace them with your own figures; edited values are marked <SourceBadge s="user" />.</div>}
      {row.validation.issues.length > 0 && (
        <ul className="grid gap-1 text-[0.86rem]">{row.validation.issues.map((i) => <li key={i.code + i.path} className={i.severity === "warning" ? "text-[var(--sev-moderate)]" : "text-text-2"}>{i.severity === "warning" ? "⚠ " : "• "}{i.message}</li>)}</ul>
      )}
      {err && <ErrorBox message={err} />}

      <Block title="Business">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="field sm:col-span-2"><span>Name</span><input className="input" value={spec.business.name} onChange={(e) => upd("business.name", (s) => { s.business.name = e.target.value; })} /></label>
          <label className="field"><span>Kind of business</span><input className="input" value={spec.business.business_type} onChange={(e) => upd("business.type", (s) => { s.business.business_type = e.target.value; })} /></label>
          <label className="field"><span>Unit sold</span><input className="input" value={spec.unit_label} onChange={(e) => upd("unit", (s) => { s.unit_label = e.target.value; })} /></label>
          <label className="field"><span>Country</span>
            <select className="select" value={spec.business.country} onChange={(e) => upd("business.country", (s) => { s.business.country = e.target.value; })}>
              <option value="">Not set</option>{COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
            </select>
          </label>
          <label className="field"><span>Currency</span><input className="input" value={spec.business.currency} maxLength={3} onChange={(e) => upd("business.currency", (s) => { s.business.currency = e.target.value.toUpperCase(); })} /></label>
          <Location spec={spec} onPick={(c, lat, lon) => upd("location", (s) => { s.location = { city: c, latitude: lat, longitude: lon }; })} />
        </div>
      </Block>

      <Block title="Products or services" hint={`${industry.unit_cost_label}. Elasticity: how much demand changes for a 1% price change. ${industry.elasticity_note}`}>
        <Grid cols={has("inventory") ? 8 : 6} head={["Name", "Price", "Variable cost", spec.subscription.enabled ? "Subscribers" : `${spec.unit_label}/month`, "Elasticity", ...(has("inventory") ? ["Stock on hand", "Supplier max/month"] : []), ""]}>
          {spec.products.map((p, i) => (
            <Row key={p.id || i}>
              <input className="input" aria-label="Product name" value={p.name} onChange={(e) => upd(`products.${p.id}.name`, (s) => { s.products[i].name = e.target.value; })} />
              <Num v={p.price} on={(v) => upd(`products.${p.id}.price`, (s) => { s.products[i].price = v; })} src={src(`products.${p.id}.price`)} step={0.01} label="Price" />
              <Num v={p.unit_cost} on={(v) => upd(`products.${p.id}.unit_cost`, (s) => { s.products[i].unit_cost = v; })} src={src(`products.${p.id}.unit_cost`)} step={0.01} label="Variable cost" />
              <Num v={p.monthly_units} on={(v) => upd(`products.${p.id}.monthly_units`, (s) => { s.products[i].monthly_units = v; })} src={src(`products.${p.id}.monthly_units`)} label="Monthly units" />
              <Num v={p.elasticity} on={(v) => upd(`products.${p.id}.elasticity`, (s) => { s.products[i].elasticity = v; })} src={src(`products.${p.id}.elasticity`)} step={0.1} min={-6} label="Elasticity" />
              {has("inventory") && <Num v={p.stock_units} empty on={(v) => upd(`products.${p.id}.stock_units`, (s) => { s.products[i].stock_units = v; })} src={src(`products.${p.id}.stock_units`)} label="Stock on hand" />}
              {has("inventory") && <Num v={p.restock_units_per_month} empty on={(v) => upd(`products.${p.id}.restock_units_per_month`, (s) => { s.products[i].restock_units_per_month = v; })} src={src(`products.${p.id}.restock_units_per_month`)} label="Supplier limit" />}
              <Del on={() => spec.products.length > 1 && upd("products", (s) => { s.products.splice(i, 1); })} />
            </Row>
          ))}
        </Grid>
        <Add on={() => upd("products", (s) => { s.products.push({ id: "", name: "New product", price: 10, unit_cost: 4, monthly_units: 100, elasticity: -1, stock_units: null, restock_units_per_month: null }); })}>Add product</Add>
        {has("inventory") && <p className="hint">Leave stock empty to skip inventory tracking. With stock set, What-if restocks to that level each month, up to the supplier limit, and reports stockouts.</p>}
      </Block>

      <div className="grid gap-8 lg:grid-cols-2">
        <Block title="Staff" hint="Monthly cost per person, including benefits.">
          <Grid cols={4} head={["Role", "People", "Cost each/month", ""]}>
            {spec.staff.map((st, i) => (
              <Row key={st.id || i}>
                <input className="input" aria-label="Role" value={st.role} onChange={(e) => upd(`staff.${st.id}.role`, (s) => { s.staff[i].role = e.target.value; })} />
                <Num v={st.count} on={(v) => upd(`staff.${st.id}.count`, (s) => { s.staff[i].count = v; })} src={src(`staff.${st.id}.count`)} label="People" />
                <Num v={st.monthly_wage} on={(v) => upd(`staff.${st.id}.monthly_wage`, (s) => { s.staff[i].monthly_wage = v; })} src={src(`staff.${st.id}.monthly_wage`)} label="Monthly cost" />
                <Del on={() => upd("staff", (s) => { s.staff.splice(i, 1); })} />
              </Row>
            ))}
          </Grid>
          <Add on={() => upd("staff", (s) => { s.staff.push({ id: "", role: "Staff", count: 1, monthly_wage: 2000 }); })}>Add role</Add>
        </Block>
        <Block title="Fixed costs per month">
          <Grid cols={4} head={["Cost", "Type", "Amount/month", ""]}>
            {spec.fixed_costs.map((c, i) => (
              <Row key={c.id || i}>
                <input className="input" aria-label="Cost name" value={c.name} onChange={(e) => upd(`fixed_costs.${c.id}.name`, (s) => { s.fixed_costs[i].name = e.target.value; })} />
                <select className="select" aria-label="Cost type" value={c.category} onChange={(e) => upd(`fixed_costs.${c.id}.category`, (s) => { s.fixed_costs[i].category = e.target.value; })}>
                  {["rent", "utilities", "software", "insurance", "loan", "maintenance", "other"].map((x) => <option key={x}>{x}</option>)}
                </select>
                <Num v={c.monthly_amount} on={(v) => upd(`fixed_costs.${c.id}.monthly_amount`, (s) => { s.fixed_costs[i].monthly_amount = v; })} src={src(`fixed_costs.${c.id}.monthly_amount`)} label="Monthly amount" />
                <Del on={() => upd("fixed_costs", (s) => { s.fixed_costs.splice(i, 1); })} />
              </Row>
            ))}
          </Grid>
          <Add on={() => upd("fixed_costs", (s) => { s.fixed_costs.push({ id: "", name: "New cost", category: "other", monthly_amount: 0 }); })}>Add cost</Add>
        </Block>
      </div>

      <div className="grid gap-8 lg:grid-cols-3">
        {has("marketing") && (
          <Block title="Marketing">
            <Field label="Budget per month" src={src("marketing.monthly_budget")}><NumInput v={spec.marketing.monthly_budget} on={(v) => upd("marketing.monthly_budget", (s) => { s.marketing.monthly_budget = v; })} /></Field>
            <Field label="Response (elasticity)" src={src("marketing.elasticity")} hint="0.08 = doubling spend raises demand about 5.7%."><NumInput v={spec.marketing.elasticity} step={0.01} on={(v) => upd("marketing.elasticity", (s) => { s.marketing.elasticity = v; })} /></Field>
            <Field label="Extra sales per 1,000 spent" hint="Only used when today's budget is zero."><NumInput v={spec.marketing.units_per_1000} empty on={(v) => upd("marketing.units_per_1000", (s) => { s.marketing.units_per_1000 = v; })} /></Field>
          </Block>
        )}
        {has("capacity") && (
          <Block title="Capacity">
            <Field label={`Most ${spec.unit_label} per month`} src={src("operations.monthly_capacity_units")}><NumInput v={spec.operations.monthly_capacity_units} empty on={(v) => upd("operations.monthly_capacity_units", (s) => { s.operations.monthly_capacity_units = v; })} /></Field>
            <Field label={`…or ${spec.unit_label} per staff member`} src={src("operations.capacity_per_staff")} hint="If set, capacity grows with headcount and overrides the fixed figure."><NumInput v={spec.operations.capacity_per_staff} empty on={(v) => upd("operations.capacity_per_staff", (s) => { s.operations.capacity_per_staff = v; })} /></Field>
          </Block>
        )}
        {has("subscription") && (
          <Block title="Subscribers">
            <label className="flex items-center gap-2 text-[0.88rem]"><input type="checkbox" checked={spec.subscription.enabled} onChange={(e) => upd("subscription.enabled", (s) => { s.subscription.enabled = e.target.checked; })} />Subscription business (units are active subscribers)</label>
            <Field label="Monthly churn %" src={src("subscription.monthly_churn_pct")}><NumInput v={spec.subscription.monthly_churn_pct} step={0.1} on={(v) => upd("subscription.monthly_churn_pct", (s) => { s.subscription.monthly_churn_pct = v; })} /></Field>
            <Field label="New subscribers per month" src={src("subscription.new_customers_per_month")}><NumInput v={spec.subscription.new_customers_per_month} on={(v) => upd("subscription.new_customers_per_month", (s) => { s.subscription.new_customers_per_month = v; })} /></Field>
          </Block>
        )}
        <Block title="Cash & tax">
          <Field label="Cash today" src={src("finance.starting_cash")}><NumInput v={spec.finance.starting_cash} min={-1e12} on={(v) => upd("finance.starting_cash", (s) => { s.finance.starting_cash = v; })} /></Field>
          <Field label="Minimum cash buffer"><NumInput v={spec.finance.min_cash_buffer} on={(v) => upd("finance.min_cash_buffer", (s) => { s.finance.min_cash_buffer = v; })} /></Field>
          <Field label="Tax rate on profit %" src={src("finance.tax_rate_pct")}><NumInput v={spec.finance.tax_rate_pct} on={(v) => upd("finance.tax_rate_pct", (s) => { s.finance.tax_rate_pct = v; })} /></Field>
          <Field label="Loan repayments per month" hint="Reduces cash, not profit."><NumInput v={spec.finance.monthly_debt_payment} on={(v) => upd("finance.monthly_debt_payment", (s) => { s.finance.monthly_debt_payment = v; })} /></Field>
        </Block>
        <Block title="External exposure" hint="Lets exchange-rate and stock-price data inform a scenario, only when you apply it.">
          <Field label="Foreign currency of imported supplies"><input className="input" maxLength={3} value={spec.external.foreign_currency} onChange={(e) => upd("external", (s) => { s.external.foreign_currency = e.target.value.toUpperCase(); })} /></Field>
          <Field label="Share of variable costs priced in it %" hint="Leave empty if you buy nothing priced in a foreign currency."><NumInput v={spec.external.imported_cost_share_pct} empty on={(v) => upd("external", (s) => { s.external.imported_cost_share_pct = v; })} /></Field>
          <Field label="Stock to follow (ticker)" hint="Optional: a supplier, customer, competitor or sector fund, e.g. AAPL or JFC.XPHS. Prices come from Marketstack (needs a key)."><input className="input" maxLength={20} placeholder="none" value={spec.external.market_symbol ?? ""} onChange={(e) => upd("external", (s) => { s.external.market_symbol = e.target.value.toUpperCase().replace(/[^A-Z0-9.-]/g, ""); })} /></Field>
        </Block>
        <Block title="Goals (optional)">
          <Field label="Target net profit per month"><NumInput v={spec.goals.target_monthly_profit} empty min={-1e12} on={(v) => upd("goals", (s) => { s.goals.target_monthly_profit = v; })} /></Field>
          <Field label="Minimum net margin %"><NumInput v={spec.goals.min_margin_pct} empty min={-100} on={(v) => upd("goals", (s) => { s.goals.min_margin_pct = v; })} /></Field>
          <Field label="Most you would invest"><NumInput v={spec.goals.max_investment} empty on={(v) => upd("goals", (s) => { s.goals.max_investment = v; })} /></Field>
        </Block>
        <Block title="Uncertainty ranges" hint="Used for the best and worst cases.">
          <Field label="Demand ±%"><NumInput v={spec.uncertainty.demand_pct} on={(v) => upd("uncertainty", (s) => { s.uncertainty.demand_pct = v; })} /></Field>
          <Field label="Variable costs ±%"><NumInput v={spec.uncertainty.cost_pct} on={(v) => upd("uncertainty", (s) => { s.uncertainty.cost_pct = v; })} /></Field>
          <Field label="Elasticity ±"><NumInput v={spec.uncertainty.elasticity_abs} step={0.1} on={(v) => upd("uncertainty", (s) => { s.uncertainty.elasticity_abs = v; })} /></Field>
        </Block>
      </div>

      {has("seasonality") && (
        <Block title="Seasonality" hint="Demand index by calendar month; 1.0 is an average month. Leave all at 1.0 if sales are steady." aside={<SourceBadge s={src("growth.seasonality")} />}>
          <div className="grid grid-cols-6 gap-2 sm:grid-cols-12">
            {spec.growth.seasonality.map((v, i) => (
              <label key={i} className="grid justify-items-center gap-1">
                <div className="flex h-16 w-full items-end justify-center rounded-[var(--r-control)] bg-night px-2"><div className="w-full rounded-t-[3px] bg-[var(--series-1)]" style={{ height: `${Math.min(100, (v / 2) * 100)}%` }} /></div>
                <input className="input input-num !min-h-[1.9rem] !px-1 !text-[0.8rem]" type="number" step={0.05} min={0} value={v} aria-label={`${MONTHS[i]} demand index`} onChange={(e) => upd("growth.seasonality", (s) => { s.growth.seasonality[i] = +e.target.value; })} />
                <span className="text-[0.74rem] text-text-3">{MONTHS[i]}</span>
              </label>
            ))}
          </div>
          <Field label="Underlying growth % per month"><NumInput v={spec.growth.monthly_growth_pct} step={0.1} min={-30} on={(v) => upd("growth", (s) => { s.growth.monthly_growth_pct = v; })} /></Field>
        </Block>
      )}

      {has("suppliers") && (
        <Block title="Suppliers" hint="Share of purchases from each supplier (used to flag dependence on one supplier).">
          <Grid cols={3} head={["Supplier", "Share %", ""]}>
            {spec.suppliers.map((sp, i) => (
              <Row key={i}>
                <input className="input" aria-label="Supplier" value={sp.name} onChange={(e) => upd("suppliers", (s) => { s.suppliers[i].name = e.target.value; })} />
                <NumInput v={sp.share_pct} on={(v) => upd("suppliers", (s) => { s.suppliers[i].share_pct = v; })} />
                <Del on={() => upd("suppliers", (s) => { s.suppliers.splice(i, 1); })} />
              </Row>
            ))}
          </Grid>
          <Add on={() => upd("suppliers", (s) => { s.suppliers.push({ name: "Supplier", share_pct: 50 }); })}>Add supplier</Add>
        </Block>
      )}

      <History spec={spec} cur={cur} onChange={(h) => upd("history", (s) => { s.history = h; })} />

      <div className="flex flex-wrap items-center gap-3">
        <button className="btn btn-primary btn-lg" onClick={save} disabled={busy || !dirty}>{busy && <Spinner />}{dirty ? "Save changes" : "Saved"}</button>
        {dirty && <button className="btn btn-quiet" onClick={() => { setSpec(structuredClone(row.spec)); setTouched(new Set()); }}>Discard changes</button>}
      </div>
    </div>
  );
}

function Location({ spec, onPick }: { spec: ProfileSpec; onPick: (city: string, lat: number, lon: number) => void }) {
  const [q, setQ] = useState(spec.location.city);
  const [places, setPlaces] = useState<{ name: string; admin1: string; country: string; latitude: number; longitude: number }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const search = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.get<{ places: typeof places }>(`/api/whatif/geocode?q=${encodeURIComponent(q)}&country=${spec.business.country}`);
      setPlaces(r.places);
      if (!r.places.length) setErr("No place found with that name.");
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <div className="field sm:col-span-2">
      <span>Location (for weather forecasts)</span>
      <div className="flex gap-2">
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="City" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); search(); } }} />
        <button className="btn" onClick={search} disabled={busy || q.trim().length < 2}>{busy && <Spinner />}Find</button>
      </div>
      {spec.location.latitude != null && <span className="hint">Set: {spec.location.city} ({spec.location.latitude.toFixed(3)}, {spec.location.longitude?.toFixed(3)}), via Open-Meteo geocoding.</span>}
      {err && <span className="hint">{err}</span>}
      {places.length > 0 && (
        <div className="flex flex-wrap gap-1.5">{places.map((p) => <button key={`${p.latitude},${p.longitude}`} className="chip interactive cursor-pointer" onClick={() => { onPick(p.name, p.latitude, p.longitude); setPlaces([]); setQ(p.name); }}>{p.name}, {p.admin1}, {p.country}</button>)}</div>
      )}
    </div>
  );
}

function History({ spec, cur, onChange }: { spec: ProfileSpec; cur: string; onChange: (h: ProfileSpec["history"]) => void }) {
  const [paste, setPaste] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const rows = spec.history;
  const importCsv = () => {
    setErr(null);
    const out: ProfileSpec["history"] = [];
    for (const [n, line] of paste.trim().split(/\r?\n/).entries()) {
      const cells = line.split(/[,;\t]/).map((c) => c.trim());
      if (n === 0 && /month/i.test(cells[0])) continue;
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(cells[0]) || cells[1] === undefined || Number.isNaN(+cells[1])) { setErr(`Line ${n + 1}: expected "YYYY-MM, revenue[, units, total costs, net profit]".`); return; }
      const v = (i: number) => (cells[i] === undefined || cells[i] === "" ? null : +cells[i]);
      out.push({ month: cells[0], revenue: +cells[1], units: v(2), total_costs: v(3), net_profit: v(4) });
    }
    const merged = new Map(rows.map((r) => [r.month, r]));
    out.forEach((r) => merged.set(r.month, r));
    onChange([...merged.values()].sort((a, b) => a.month.localeCompare(b.month)));
    setPaste("");
  };
  return (
    <Block title="Past monthly results (optional)" hint="Actual figures. They are shown as Actual next to projections, checked for trends by Risk Radar, and raise confidence. They are never mixed into calculated results." aside={<KindTag kind="actual" />}>
      {rows.length > 0 && (
        <Grid cols={6} head={["Month", "Revenue", "Units", "Total costs", "Net profit", ""]}>
          {rows.map((h, i) => (
            <Row key={h.month}>
              <span className="text-[0.86rem]">{monthLabel(h.month, true)}</span>
              <NumInput v={h.revenue} on={(v) => onChange(rows.map((r, j) => (j === i ? { ...r, revenue: v } : r)))} />
              <NumInput v={h.units} empty on={(v) => onChange(rows.map((r, j) => (j === i ? { ...r, units: v } : r)))} />
              <NumInput v={h.total_costs} empty on={(v) => onChange(rows.map((r, j) => (j === i ? { ...r, total_costs: v } : r)))} />
              <NumInput v={h.net_profit} empty min={-1e12} on={(v) => onChange(rows.map((r, j) => (j === i ? { ...r, net_profit: v } : r)))} />
              <Del on={() => onChange(rows.filter((_, j) => j !== i))} />
            </Row>
          ))}
        </Grid>
      )}
      <label className="field"><span>Paste rows (CSV): month, revenue, units, total costs, net profit</span>
        <textarea className="textarea font-[ui-monospace] text-[0.82rem]" rows={3} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={"2026-07, 352000, 2800, 330000, 22000\n2026-08, 341000, 2700, 324000, 17000"} />
      </label>
      <div className="flex items-center gap-2"><button className="btn btn-sm" onClick={importCsv} disabled={!paste.trim()}>Add rows</button>{err && <span className="error-text">{err}</span>}{rows.length > 0 && <span className="hint">{rows.length} months · latest revenue {money(rows[rows.length - 1].revenue, cur)}</span>}</div>
    </Block>
  );
}

// ------------------------------------------------------------- primitives

function Block({ title, hint, aside, children }: { title: string; hint?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel glass grid content-start gap-3 p-5">
      <div className="flex items-start justify-between gap-2"><div className="grid gap-0.5"><h2 className="text-[1rem] font-semibold">{title}</h2>{hint && <p className="max-w-[80ch] text-[0.8rem] text-text-3">{hint}</p>}</div>{aside}</div>
      {children}
    </section>
  );
}
function Grid({ cols, head, children }: { cols: number; head: string[]; children: ReactNode }) {
  const tpl = useMemo(() => `minmax(9rem,1.6fr) ${"minmax(5.5rem,1fr) ".repeat(cols - 2)}2.25rem`, [cols]);
  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[560px] gap-1.5" style={{ ["--cols" as string]: tpl }}>
        <div className="grid gap-2 text-[0.76rem] text-text-3" style={{ gridTemplateColumns: "var(--cols)" }}>{head.map((h, i) => <span key={i}>{h}</span>)}</div>
        {children}
      </div>
    </div>
  );
}
function Row({ children }: { children: ReactNode }) {
  return <div className="grid items-center gap-2" style={{ gridTemplateColumns: "var(--cols)" }}>{children}</div>;
}
function NumInput({ v, on, step = 1, min = 0, empty = false }: { v: number | null; on: (v: number) => void; step?: number; min?: number; empty?: boolean }) {
  return <input className="input input-num" type="number" step={step} min={min} value={v ?? ""} placeholder={empty ? "—" : undefined}
    onChange={(e) => on(e.target.value === "" ? (empty ? (null as unknown as number) : 0) : +e.target.value)} />;
}
function Num({ v, on, src, step = 1, min = 0, empty = false, label }: { v: number | null; on: (v: number) => void; src?: string; step?: number; min?: number; empty?: boolean; label: string }) {
  return (
    <div className="relative">
      <input className="input input-num !pr-2" aria-label={label} type="number" step={step} min={min} value={v ?? ""} placeholder={empty ? "—" : undefined}
        onChange={(e) => on(e.target.value === "" ? (empty ? (null as unknown as number) : 0) : +e.target.value)} />
      {src === "default" && <span className="absolute -top-1.5 left-1.5 rounded-sm bg-surface px-1 text-[0.62rem] text-[var(--sev-moderate)]" title="What-if estimate; replace with your figure">estimate</span>}
    </div>
  );
}
function Field({ label, src, hint, children }: { label: string; src?: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span className="flex items-center gap-2">{label}{src === "default" && <SourceBadge s="default" />}</span>{children}{hint && <span className="hint">{hint}</span>}</label>;
}
function Del({ on }: { on: () => void }) {
  return <button className="btn btn-quiet btn-sm !px-1.5" onClick={on} aria-label="Remove row"><IconTrash size={15} /></button>;
}
function Add({ on, children }: { on: () => void; children: ReactNode }) {
  return <button className="btn btn-sm btn-outline justify-self-start" onClick={on}><IconPlus size={14} />{children}</button>;
}
