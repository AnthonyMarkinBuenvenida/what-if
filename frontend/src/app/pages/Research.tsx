/* Market research from public sources: Open Prices, Open Food Facts, World Bank,
   GDELT and Frankfurter. Every value is shown as the source returned it, labelled
   by kind (observed, historical, calculated, AI-generated) and linked to its
   source. A failed source is reported as failed; nothing is put in its place. */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { LineChart, Sparkline } from "../../components/charts";
import { IconAlert, IconCheck, IconRetry, IconX } from "../../components/icons";
import { DataTag, Empty, ErrorBox, Notice, PageHeader, Skeleton, Spinner, useToast } from "../../components/ui";
import { api } from "../../lib/api";
import { useLocalState } from "../../lib/hooks";
import { useWorkspace } from "../workspace";

// ------------------------------------------------------------------ types
interface SourceErr { source: string; kind: string; message: string; url: string | null; status: number | null; retry_after_seconds: number | null }
interface Failed { ok: false; error: SourceErr }
interface SourceInfo { id: string; name: string; docs_url: string; rate_note: string; cache_seconds: number; requests_made: number; cache_hits: number; last_success_at: string | null; last_error: SourceErr | null; last_error_at: string | null; rate_limited_for_seconds: number }
interface Country { code: string; name: string; currency: string }
interface Sources { sources: SourceInfo[]; countries: Country[]; indicators: { code: string; label: string; unit: string; use: string }[] }
interface Obs {
  id: number; price: number | null; currency: string | null; observed_on: string | null; is_discounted: boolean; price_per: string | null;
  product_code: string | null; category_tag: string | null; name_entered: string | null;
  product: { name: string | null; brands: string | null; quantity: string | null; categories_tags: string[]; source: string | null; synced_at: string | null } | null;
  location: { name: string | null; city: string | null; country_code: string | null } | null;
  evidence: { proof_type: string | null; proof_image_url: string | null } | null;
  source_url: string;
}
interface Coverage {
  country_code: string; local_currency?: string; observations: number; reported_price_count?: number; reported_location_count?: number; locations_found?: number;
  date_first?: string | null; date_last?: string | null; latest_age_days?: number | null; freshness?: string; observations_last_90_days?: number;
  distinct_products?: number; products_with_repeat_observations?: number; by_currency?: [string, number][]; by_city?: [string, number][];
  currency_mismatch?: number[]; sufficient: boolean; sufficiency_rule?: string; statements: string[];
}
interface Prices { ok: true; country_code: string; country_name?: string; observations: Obs[]; coverage: Coverage; source_urls: string[]; retrieved_at: string }
interface Indicator { code: string; label: string; unit: string | null; use: string | null; country: string; series: { year: string; value: number | null }[]; latest: { year: string; value: number } | null; latest_age_years?: number; stale?: boolean; source_last_updated: string | null; source_url: string; page_url: string; retrieved_at: string; cached: boolean }
interface Provider { key: string; name?: string; rate_type?: string; data_url?: string }
interface Rate { base: string; quote: string; rate: number; rate_date: string; provider: Provider | null; provider_note: string | null; source_url: string; retrieved_at: string; cached: boolean }
interface Series { points: { date: string; rate: number }[]; source_url: string; provider: Provider | null }
interface Conversion { value: number; amount: number; from: string; to: string; method: string }
interface Fx { ok: true; rate: Rate; series: Series | null; conversion: Conversion | null }
interface Article { title: string | null; url: string; domain: string | null; language: string | null; source_country: string | null; seen_at: string | null }
interface News { ok: true; query: string; timespan: string; articles: Article[]; source_url: string; retrieved_at: string; note: string }
interface OffProduct { ok: true; found: boolean; code: string; name?: string | null; brands?: string | null; quantity?: string | null; categories_tags?: string[]; image_url?: string | null; last_modified?: string | null; page_url?: string; source_url: string; note?: string }
interface ProductPrices { ok: true; product_code: string; observations: Obs[]; total_worldwide: number; source_urls: string[]; retrieved_at: string }

interface Proposal { id: string; source: string; name: string; kind: string; levers: Record<string, number>; method: string; assumptions: string[] }
interface ProductMatch { product_id: string; business_name: string; business_price: number | null; observations_in_country?: number; observations_worldwide?: number; observations?: Obs[]; observed_range?: { min: number; max: number; n: number; currencies: string[]; note: string }; metadata?: { name: string | null; brands: string | null; via: string }; metadata_note?: string; error?: SourceErr | null }
interface BriefContent {
  country: string; country_name: string; business_currency: string; supplier_currency: string | null; imported_share_pct: number | null; news_query: string; generated_at: string;
  sources: { source: string; status: "ok" | "failed"; error: SourceErr | null; retrieved_at?: string; partial_errors?: (SourceErr & { indicator: string })[] }[];
  observed: { prices: { coverage: Coverage; latest: Obs[]; product_matches: ProductMatch[]; matching_notes: string[]; retrieved_at: string } | null; fx: { rate: Rate; series: Series | null } | null; news: News | null };
  historical: { indicators: Indicator[]; errors: (SourceErr & { indicator: string })[] };
  calculated: { fx_change: { one_year_change_pct: number; from: { date: string; rate: number }; to: { date: string; rate: number }; largest_rise_pct: number; largest_rise_from: { date: string; rate: number } | null; largest_rise_to: { date: string; rate: number } | null; method: string } | null; example_conversion: Conversion | null };
  proposals: Proposal[];
  ai_reading: { available: boolean; reason?: string; summary?: string; implications?: string[]; caveats?: string[]; model?: string; note?: string };
  limitations: string[]; requests: { kind: string; what: string; why: string; where: string }[]; applied: Record<string, number>;
}
interface Brief { id: number; business_id: number; country: string; created_at: string; content: BriefContent }
interface BriefSummary { id: number; country: string; created_at: string; sources: BriefContent["sources"]; proposal_count: number }

// ---------------------------------------------------------------- helpers
const SOURCE_NAMES: Record<string, string> = { open_prices: "Open Prices", open_food_facts: "Open Food Facts", world_bank: "World Bank", gdelt: "GDELT", frankfurter: "Frankfurter" };
const at = (iso?: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—");
const num = (v: number | null | undefined, d = 2) => (v == null ? "—" : v.toLocaleString(undefined, { maximumFractionDigits: d }));
const isFailed = (x: unknown): x is Failed => !!x && typeof x === "object" && (x as { ok?: boolean }).ok === false;

function SourceLine({ url, retrievedAt, cached, label = "Source" }: { url?: string | null; retrievedAt?: string | null; cached?: boolean; label?: string }) {
  return (
    <p className="text-[0.75rem] text-text-3">
      {url && <a href={url} target="_blank" rel="noreferrer">{label} ↗</a>}
      {retrievedAt && <> · retrieved {at(retrievedAt)}{cached ? " (from What-if's cache)" : ""}</>}
    </p>
  );
}

function FailBox({ error, onRetry, what }: { error: SourceErr; onRetry?: () => void; what?: string }) {
  return (
    <Notice tone="warn">
      <div className="grid gap-1.5">
        <b>{SOURCE_NAMES[error.source] ?? error.source} did not provide {what ?? "data"}.</b>
        <span>{error.message}</span>
        <span className="text-text-2">Nothing is shown in its place.{error.retry_after_seconds && !error.message.includes("Try again") ? ` Try again in about ${Math.ceil(error.retry_after_seconds)} s.` : ""}</span>
        {onRetry && <div><button className="btn btn-sm" onClick={onRetry}><IconRetry size={14} />Try again</button></div>}
      </div>
    </Notice>
  );
}

function Section({ title, tag, aside, children }: { title: string; tag?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid grid-cols-[minmax(0,1fr)] gap-4 border-t border-text pt-5">
      <div className="flex flex-wrap items-center gap-3"><h2 className="t-h3">{title}</h2>{tag}{aside && <span className="text-[0.85rem] text-text-3">{aside}</span>}</div>
      {children}
    </section>
  );
}

function Cells({ items }: { items: { label: string; value: ReactNode; sub?: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-1 border-l border-t border-line sm:grid-cols-2 lg:grid-cols-4">
      {items.map((it) => (
        <div key={it.label} className="grid content-start gap-1 border-b border-r border-line p-4">
          <dt className="text-[0.8rem] text-text-2">{it.label}</dt>
          <dd className="num text-[1.3rem] font-semibold" style={{ fontFamily: "var(--font-display)" }}>{it.value}</dd>
          {it.sub && <span className="text-[0.72rem] text-text-3">{it.sub}</span>}
        </div>
      ))}
    </dl>
  );
}

function productLabel(o: Obs) {
  return o.product?.name || o.name_entered || (o.category_tag ? o.category_tag.replace(/^[a-z]{2}:/, "").replace(/-/g, " ") : null) || (o.product_code ? `Barcode ${o.product_code}` : "Unnamed item");
}

function ObsTable({ rows, localCurrency }: { rows: Obs[]; localCurrency?: string }) {
  if (!rows.length) return <p className="text-[0.9rem] text-text-2">No price records.</p>;
  return (
    <div className="table-wrap"><table className="data">
      <thead><tr><th>Recorded on</th><th>Product</th><th className="n">Price</th><th>Shop</th><th>Evidence</th></tr></thead>
      <tbody>{rows.map((o) => (
        <tr key={o.id}>
          <td className="whitespace-nowrap">{o.observed_on ?? "—"}</td>
          <td>
            <b>{productLabel(o)}</b>
            <div className="text-[0.72rem] text-text-3">
              {o.product_code && <span className="num">{o.product_code}</span>}
              {o.product?.brands && <> · {o.product.brands}</>}{o.product?.quantity && <> · {o.product.quantity}</>}
              {o.product?.synced_at && <> · details from Open {o.product.source === "opf" ? "Products" : "Food"} Facts, synced {o.product.synced_at.slice(0, 10)}</>}
              {!o.product && o.product_code && <> · no product details on record</>}
            </div>
          </td>
          <td className="n whitespace-nowrap">
            {o.price == null ? "—" : `${num(o.price)} ${o.currency ?? "(no currency)"}`}
            {o.price_per && <div className="text-[0.72rem] text-text-3">per {o.price_per.toLowerCase()}</div>}
            {o.is_discounted && <div className="text-[0.72rem] text-text-3">discounted</div>}
            {localCurrency && o.currency && o.currency !== localCurrency && <div><span className="chip chip-warn" style={{ height: "1.2rem", fontSize: "0.68rem" }}>Not {localCurrency}</span></div>}
          </td>
          <td>{o.location?.name ?? "—"}<div className="text-[0.72rem] text-text-3">{o.location?.city ?? ""}</div></td>
          <td className="whitespace-nowrap text-[0.8rem]">
            <a href={o.source_url} target="_blank" rel="noreferrer">Record ↗</a>
            {o.evidence?.proof_image_url && <> · <a href={o.evidence.proof_image_url} target="_blank" rel="noreferrer">{o.evidence.proof_type === "RECEIPT" ? "Receipt" : "Photo"} ↗</a></>}
          </td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

function CoverageView({ c }: { c: Coverage }) {
  return (
    <div className="grid gap-4">
      <Cells items={[
        { label: "Price records retrieved", value: c.observations.toLocaleString(), sub: c.reported_price_count != null ? `Open Prices reports ${c.reported_price_count.toLocaleString()} for this country` : undefined },
        { label: "Shops", value: c.locations_found ?? "—", sub: c.reported_location_count != null ? `of ${c.reported_location_count} reported` : undefined },
        { label: "Newest record", value: c.date_last ?? "—", sub: c.latest_age_days != null ? `${c.latest_age_days} days old · ${c.freshness}` : "no records" },
        { label: "Records in the last 90 days", value: c.observations_last_90_days ?? 0, sub: c.date_first ? `oldest ${c.date_first}` : undefined },
      ]} />
      <Notice tone={c.sufficient ? "info" : "warn"}>
        <div className="grid gap-1.5">
          <b>{c.sufficient ? "Coverage is enough for rough price benchmarks." : "Coverage is too thin to stand for market prices."}</b>
          <ul className="grid list-disc gap-1 pl-5">{c.statements.map((s) => <li key={s}>{s}</li>)}</ul>
          {c.sufficiency_rule && <span className="text-[0.78rem] text-text-3">Rule: {c.sufficiency_rule}</span>}
        </div>
      </Notice>
    </div>
  );
}

// --------------------------------------------------------------- panels
function PricesPanel({ country, localCurrency }: { country: string; localCurrency?: string }) {
  const [data, setData] = useState<Prices | Failed | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [lookup, setLookup] = useState<{ prices: ProductPrices | Failed; off: OffProduct | Failed } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setData(null); setErr(null);
    try { setData(await api.get<Prices | Failed>(`/api/research/prices?country=${country}`)); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => { load(); setLookup(null); }, [country]); // eslint-disable-line react-hooks/exhaustive-deps

  async function find(e: FormEvent) {
    e.preventDefault();
    const c = code.trim();
    if (!/^\d{8,14}$/.test(c)) return;
    setBusy(true);
    try {
      const prices = await api.get<ProductPrices | Failed>(`/api/research/prices/product/${c}?country=${country}`);
      const off = await api.get<OffProduct | Failed>(`/api/research/product/${c}`);
      setLookup({ prices, off });
    } catch (e2) { setErr(e2 instanceof Error ? e2.message : String(e2)); }
    finally { setBusy(false); }
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <Section title="Shelf prices" tag={<DataTag kind="observed" />} aside="Open Prices: prices shoppers recorded from receipts and price tags.">
        {err ? <ErrorBox message={err} onRetry={load} />
          : !data ? <div className="grid gap-2"><Skeleton h={90} /><Skeleton h={160} /></div>
          : isFailed(data) ? <FailBox error={data.error} onRetry={load} />
          : (
            <>
              <CoverageView c={data.coverage} />
              <ObsTable rows={data.observations} localCurrency={data.coverage.local_currency} />
              <SourceLine url={data.source_urls[data.source_urls.length - 1]} retrievedAt={data.retrieved_at} label="Open Prices API" />
            </>
          )}
      </Section>

      <Section title="Look up a product by barcode" aside="Exact barcode matches only; What-if never guesses a product from its name.">
        <form className="flex flex-wrap items-end gap-2" onSubmit={find}>
          <label className="field"><span>Barcode (EAN/UPC)</span>
            <input className="input num" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} placeholder="8 to 14 digits" aria-invalid={code !== "" && !/^\d{8,14}$/.test(code.trim())} />
          </label>
          <button className="btn btn-primary" disabled={busy || !/^\d{8,14}$/.test(code.trim())}>{busy && <Spinner />}Look up</button>
          {busy && <span className="text-[0.8rem] text-text-3">Open Food Facts allows 15 product reads a minute, so this can take a few seconds.</span>}
        </form>
        {lookup && (
          <div className="grid gap-4">
            <div className="card card-pad grid gap-2">
              <div className="flex items-center gap-2"><h3 className="text-[1rem]">Product details</h3><DataTag kind="observed" detail="As recorded in Open Food Facts by its contributors." /></div>
              {isFailed(lookup.off) ? <FailBox error={lookup.off.error} />
                : !lookup.off.found ? <p className="text-[0.9rem] text-text-2">{lookup.off.note} What-if shows no product details rather than guessing.</p>
                : (
                  <div className="flex gap-4">
                    {lookup.off.image_url && <img src={lookup.off.image_url} alt="" className="h-20 w-20 rounded object-contain" style={{ filter: "grayscale(1)" }} />}
                    <div className="grid gap-1 text-[0.9rem]">
                      <b>{lookup.off.name ?? "No name recorded"}</b>
                      <span className="text-text-2">{[lookup.off.brands, lookup.off.quantity].filter(Boolean).join(" · ") || "No brand or quantity recorded"}</span>
                      <span className="text-[0.75rem] text-text-3">Last edited on Open Food Facts {lookup.off.last_modified?.slice(0, 10) ?? "—"} · <a href={lookup.off.page_url} target="_blank" rel="noreferrer">Product page ↗</a></span>
                    </div>
                  </div>
                )}
            </div>
            <div className="grid gap-2">
              {isFailed(lookup.prices) ? <FailBox error={lookup.prices.error} /> : (
                <>
                  <p className="text-[0.9rem]"><b>{lookup.prices.observations.length}</b> price record(s) in this country; {lookup.prices.total_worldwide.toLocaleString()} worldwide in Open Prices.
                    {lookup.prices.observations.length === 0 && " No record means the price is unknown here, not zero."}</p>
                  <ObsTable rows={lookup.prices.observations} localCurrency={localCurrency} />
                  <SourceLine url={lookup.prices.source_urls[0]} retrievedAt={lookup.prices.retrieved_at} label="Open Prices API" />
                </>
              )}
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}

function IndicatorTable({ rows }: { rows: Indicator[] }) {
  return (
    <div className="table-wrap"><table className="data">
      <thead><tr><th>Indicator</th><th className="n">Latest</th><th>Year</th><th>Trend</th><th>Source</th></tr></thead>
      <tbody>{rows.map((i) => {
        const pts = i.series.filter((s) => s.value != null).map((s) => s.value as number);
        return (
          <tr key={i.code}>
            <td><b>{i.label}</b><div className="text-[0.72rem] text-text-3">{i.unit} · {i.use}</div></td>
            <td className="n">{i.latest ? num(i.latest.value, Math.abs(i.latest.value) > 1000 ? 0 : 2) : "No data"}</td>
            <td>{i.latest?.year ?? "—"}{i.stale && <div><span className="chip chip-warn" style={{ height: "1.2rem", fontSize: "0.68rem" }}>Not recent</span></div>}</td>
            <td>{pts.length > 1 ? <Sparkline values={pts} width={120} /> : <span className="text-[0.75rem] text-text-3">—</span>}<div className="text-[0.7rem] text-text-3">{i.series[0]?.year}–{i.series[i.series.length - 1]?.year}</div></td>
            <td className="text-[0.75rem]"><a href={i.page_url} target="_blank" rel="noreferrer">{i.code} ↗</a><div className="text-text-3">updated {i.source_last_updated ?? "—"}</div></td>
          </tr>
        );
      })}</tbody>
    </table></div>
  );
}

function EconomyPanel({ country, indicators, indicatorNames }: { country: string; indicators: string[]; indicatorNames: Record<string, string> }) {
  const [data, setData] = useState<{ ok: boolean; indicators: Indicator[]; errors: (SourceErr & { indicator: string })[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = async () => {
    setData(null); setErr(null);
    try { setData(await api.get(`/api/research/economy?country=${country}&indicators=${indicators.join(",")}`)); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => { load(); }, [country]); // eslint-disable-line react-hooks/exhaustive-deps
  const year = new Date().getFullYear();
  return (
    <Section title="Economy" tag={<DataTag kind="historical" />} aside="World Bank annual indicators, as published. Years without a value are left out, not filled.">
      {err ? <ErrorBox message={err} onRetry={load} /> : !data ? <Skeleton h={220} /> : (
        <>
          {data.indicators.length > 0 && <IndicatorTable rows={data.indicators.map((i) => ({ ...i, stale: i.latest ? year - Number(i.latest.year) > 3 : true }))} />}
          {data.errors.map((e) => <FailBox key={e.indicator} error={e} onRetry={load} what={`“${indicatorNames[e.indicator] ?? e.indicator}”`} />)}
          {data.indicators[0] && <SourceLine url={data.indicators[0].source_url} retrievedAt={data.indicators[0].retrieved_at} cached={data.indicators[0].cached} label="World Bank API (first indicator)" />}
        </>
      )}
    </Section>
  );
}

function FxPanel({ localCurrency }: { localCurrency: string }) {
  const [base, setBase] = useState("USD");
  const [quote, setQuote] = useState(localCurrency === "USD" ? "EUR" : localCurrency);
  const [amount, setAmount] = useState("100");
  const [provider, setProvider] = useState<"auto" | "blended">("auto");
  const [data, setData] = useState<Fx | Failed | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setQuote(localCurrency === "USD" ? "EUR" : localCurrency); }, [localCurrency]);

  async function load(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true); setErr(null);
    const amt = amount.trim() === "" ? "" : `&amount=${encodeURIComponent(amount)}`;
    try { setData(await api.get<Fx | Failed>(`/api/research/fx?base=${base}&quote=${quote}&days=365&provider=${provider}${amt}`)); }
    catch (e2) { setErr(e2 instanceof Error ? e2.message : String(e2)); }
    finally { setBusy(false); }
  }
  useEffect(() => { load(); }, [quote, provider]); // eslint-disable-line react-hooks/exhaustive-deps

  const ok = data && !isFailed(data) ? data : null;
  const pts = ok?.series?.points ?? [];
  return (
    <Section title="Exchange rates" tag={<DataTag kind="observed" />} aside="Frankfurter: reference rates published by central banks on working days. Not live market quotes.">
      <form className="flex flex-wrap items-end gap-2" onSubmit={load}>
        <label className="field"><span>Amount</span><input className="input input-num w-28" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label className="field"><span>From</span><input className="input w-20 uppercase" maxLength={3} value={base} onChange={(e) => setBase(e.target.value.toUpperCase())} /></label>
        <label className="field"><span>To</span><input className="input w-20 uppercase" maxLength={3} value={quote} onChange={(e) => setQuote(e.target.value.toUpperCase())} /></label>
        <div className="field"><span>Rate source</span>
          <div className="seg" role="group" aria-label="Rate source">
            <button type="button" aria-pressed={provider === "auto"} onClick={() => setProvider("auto")}>Local central bank</button>
            <button type="button" aria-pressed={provider === "blended"} onClick={() => setProvider("blended")}>Blended</button>
          </div>
        </div>
        <button className="btn btn-primary" disabled={busy}>{busy && <Spinner />}Get rate</button>
      </form>
      {err ? <ErrorBox message={err} /> : !data ? <Skeleton h={200} /> : isFailed(data) ? <FailBox error={data.error} onRetry={() => load()} /> : ok && (
        <div className="grid gap-4">
          <Cells items={[
            { label: `1 ${ok.rate.base} in ${ok.rate.quote}`, value: num(ok.rate.rate, 4), sub: `${ok.rate.rate_date} · ${ok.rate.provider?.name ?? "blended from several central banks"}` },
            ...(ok.conversion ? [{ label: `${num(ok.conversion.amount)} ${ok.conversion.from}`, value: `${num(ok.conversion.value)} ${ok.conversion.to}`, sub: <><DataTag kind="calculated" /> {ok.conversion.method}</> }] : []),
            ...(pts.length > 1 ? [{ label: "Change over the past year", value: `${((pts[pts.length - 1].rate / pts[0].rate - 1) * 100).toFixed(2)}%`, sub: <><DataTag kind="calculated" /> {pts[0].date} → {pts[pts.length - 1].date}</> }] : []),
          ]} />
          {pts.length > 1 && (
            <div className="card card-pad">
              <h3 className="mb-2 text-[0.95rem]">{ok.rate.base} → {ok.rate.quote}, past year ({pts.length} published rates)</h3>
              <LineChart ariaLabel={`${ok.rate.base} to ${ok.rate.quote} over the past year`} height={200} xTitle="Date" animate={false} showBands={false}
                format={(v) => v.toFixed(2)} xLabels={pts.map((p) => p.date.slice(5))} series={[{ id: "fx", label: `${ok.rate.base}/${ok.rate.quote}`, colorIndex: 0, values: pts.map((p) => p.rate) }]} />
            </div>
          )}
          <SourceLine url={ok.rate.source_url} retrievedAt={ok.rate.retrieved_at} cached={ok.rate.cached} label="Frankfurter API" />
          {ok.rate.provider?.data_url && <p className="text-[0.75rem] text-text-3">Published by {ok.rate.provider.name} ({ok.rate.provider.rate_type}): <a href={ok.rate.provider.data_url} target="_blank" rel="noreferrer">original data ↗</a></p>}
        </div>
      )}
    </Section>
  );
}

function NewsPanel({ country, countryName, defaultQuery }: { country: string; countryName: string; defaultQuery: string }) {
  const [q, setQ] = useState(defaultQuery);
  const [onlyCountry, setOnlyCountry] = useState(true);
  const [data, setData] = useState<News | Failed | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function search(e?: FormEvent) {
    e?.preventDefault();
    if (q.trim().length < 2) return;
    setBusy(true); setErr(null);
    try { setData(await api.get<News | Failed>(`/api/research/news?q=${encodeURIComponent(q.trim())}${onlyCountry ? `&country=${country}` : ""}`)); }
    catch (e2) { setErr(e2 instanceof Error ? e2.message : String(e2)); }
    finally { setBusy(false); }
  }
  return (
    <Section title="News coverage" tag={<DataTag kind="observed" detail="A record that an article was published. Its content is not verified by What-if." />} aside="GDELT: articles published in the last month. Searched only when you ask, because GDELT allows one request every 5 seconds.">
      <form className="flex flex-wrap items-end gap-2" onSubmit={search}>
        <label className="field min-w-[16rem] flex-1"><span>Search words</span><input className="input" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <label className="flex items-center gap-2 pb-2 text-[0.85rem]"><input type="checkbox" checked={onlyCountry} onChange={(e) => setOnlyCountry(e.target.checked)} />Only sources from {countryName}</label>
        <button className="btn btn-primary" disabled={busy || q.trim().length < 2}>{busy && <Spinner />}Search</button>
      </form>
      {busy && <p className="text-[0.8rem] text-text-3">GDELT can take up to 20 seconds to answer.</p>}
      {err ? <ErrorBox message={err} /> : !data ? null : isFailed(data) ? <FailBox error={data.error} onRetry={() => search()} /> : (
        <div className="grid gap-2">
          {data.articles.length === 0 ? <p className="text-[0.9rem] text-text-2">GDELT found no articles for this search in this period.</p> : (
            <ul className="grid gap-0 border-t border-line">{data.articles.map((a) => (
              <li key={a.url} className="grid gap-0.5 border-b border-line py-2.5">
                <a href={a.url} target="_blank" rel="noreferrer" className="font-medium">{a.title || a.url}</a>
                <span className="text-[0.75rem] text-text-3">{a.domain} · {a.source_country} · {a.language} · seen {at(a.seen_at)}</span>
              </li>
            ))}</ul>
          )}
          <p className="text-[0.78rem] text-text-3">{data.note}</p>
          <SourceLine url={data.source_url} retrievedAt={data.retrieved_at} label="GDELT API" />
        </div>
      )}
    </Section>
  );
}

function SourcesPanel({ data, reload }: { data: Sources; reload: () => void }) {
  return (
    <Section title="Sources" aside="How each public source has answered this What-if server so far. Opening this tab makes no external requests.">
      <div className="table-wrap"><table className="data">
        <thead><tr><th>Source</th><th>Request limit</th><th className="n">Requests</th><th>Last answered</th><th>Last problem</th></tr></thead>
        <tbody>{data.sources.map((s) => (
          <tr key={s.id}>
            <td><b>{s.name}</b><div className="text-[0.72rem]"><a href={s.docs_url} target="_blank" rel="noreferrer">Documentation ↗</a></div></td>
            <td className="text-[0.8rem]">{s.rate_note}<div className="text-[0.72rem] text-text-3">answers cached for {s.cache_seconds >= 3600 ? `${s.cache_seconds / 3600} h` : `${s.cache_seconds / 60} min`}</div></td>
            <td className="n">{s.requests_made}<div className="text-[0.72rem] text-text-3">{s.cache_hits} from cache</div></td>
            <td className="text-[0.8rem]">{s.last_success_at ? at(s.last_success_at) : "Not yet"}</td>
            <td className="text-[0.8rem]">{s.last_error ? <>{s.last_error.message}<div className="text-[0.72rem] text-text-3">{at(s.last_error_at)}{s.rate_limited_for_seconds ? ` · paused for ${s.rate_limited_for_seconds} s` : ""}</div></> : "None"}</td>
          </tr>
        ))}</tbody>
      </table></div>
      <div><button className="btn btn-sm" onClick={reload}><IconRetry size={14} />Refresh</button></div>
    </Section>
  );
}

// ------------------------------------------------------------------ brief
const leverText = (l: Record<string, number>) => Object.entries(l).map(([k, v]) => k === "supplier_cost_change_pct" ? `Purchase costs ${v > 0 ? "+" : ""}${v}%` : `${k} ${v}`).join(", ");

function BriefView({ brief, onApplied }: { brief: Brief; onApplied: (b: Brief) => void }) {
  const c = brief.content;
  const toast = useToast();
  const [pick, setPick] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  async function apply() {
    setBusy(true);
    try {
      const r = await api.post<{ created: { name: string }[]; applied: Record<string, number> }>(`/api/research/briefs/${brief.id}/apply`, { proposal_ids: pick });
      toast(`Created ${r.created.length} scenario(s). Run them in Parallel Worlds.`);
      onApplied({ ...brief, content: { ...c, applied: r.applied } });
      setPick([]);
    } catch (e) { toast(e instanceof Error ? e.message : String(e), "bad"); }
    finally { setBusy(false); }
  }
  const prices = c.observed.prices;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <div className="flex flex-wrap gap-2">
        {c.sources.map((s) => (
          <span key={s.source} className={`chip ${s.status === "ok" ? "chip-good" : "chip-bad"}`} title={s.error?.message ?? `answered ${at(s.retrieved_at)}`}>
            {s.status === "ok" ? <IconCheck size={13} /> : <IconX size={13} />}{SOURCE_NAMES[s.source] ?? s.source}{s.status === "ok" ? "" : ": no data"}
          </span>
        ))}
        <span className="text-[0.78rem] text-text-3 self-center">Gathered {at(c.generated_at)} for {c.country_name}</span>
      </div>

      {c.limitations.length > 0 && (
        <Notice tone="warn"><div className="grid gap-1"><b>What this research cannot tell you</b><ul className="grid list-disc gap-1 pl-5">{c.limitations.map((l) => <li key={l}>{l}</li>)}</ul></div></Notice>
      )}

      <Section title="Observed" tag={<DataTag kind="observed" />} aside="Recorded by public sources, shown as retrieved.">
        {prices ? (
          <div className="grid gap-3">
            <h3 className="text-[1rem]">Shelf prices in {c.country_name}</h3>
            <p className="text-[0.9rem] text-text-2">{prices.coverage.observations} records, newest {prices.coverage.date_last ?? "—"} ({prices.coverage.freshness}); {prices.coverage.sufficient ? "enough for rough benchmarks." : "too few to stand for market prices."}</p>
            {prices.matching_notes.map((n) => <p key={n} className="text-[0.85rem] text-text-2">{n}</p>)}
            {prices.product_matches.length > 0 && (
              <div className="table-wrap"><table className="data">
                <thead><tr><th>Your product</th><th className="n">Your price</th><th>Records here</th><th>Recorded range</th><th>Details</th></tr></thead>
                <tbody>{prices.product_matches.map((m) => (
                  <tr key={m.product_id}>
                    <td><b>{m.business_name}</b><div className="num text-[0.72rem] text-text-3">{m.product_id}</div></td>
                    <td className="n">{num(m.business_price)} {c.business_currency}</td>
                    <td>{m.error ? m.error.message : `${m.observations_in_country ?? 0} (${m.observations_worldwide ?? 0} worldwide)`}</td>
                    <td>{m.observed_range ? <>{num(m.observed_range.min)}–{num(m.observed_range.max)} {m.observed_range.currencies.join("/")} <DataTag kind="calculated" detail={m.observed_range.note} /></> : "Unknown (no records)"}</td>
                    <td className="text-[0.8rem]">{m.metadata ? <>{m.metadata.name ?? "—"}<div className="text-[0.72rem] text-text-3">via {m.metadata.via}</div></> : m.metadata_note ?? "—"}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </div>
        ) : <p className="text-[0.9rem] text-text-2">No price data (see sources above).</p>}
        {c.observed.fx && (
          <div className="grid gap-1">
            <h3 className="text-[1rem]">Exchange rate</h3>
            <p className="text-[0.9rem]">1 {c.observed.fx.rate.base} = <b className="num">{num(c.observed.fx.rate.rate, 4)}</b> {c.observed.fx.rate.quote} on {c.observed.fx.rate.rate_date} ({c.observed.fx.rate.provider?.name ?? "blended central-bank rates"}).</p>
            <SourceLine url={c.observed.fx.rate.source_url} retrievedAt={c.observed.fx.rate.retrieved_at} label="Frankfurter API" />
          </div>
        )}
        {c.observed.news ? (
          <div className="grid gap-1">
            <h3 className="text-[1rem]">News: “{c.news_query}”</h3>
            {c.observed.news.articles.length === 0 ? <p className="text-[0.9rem] text-text-2">No articles found.</p> : (
              <ul className="grid gap-1 text-[0.88rem]">{c.observed.news.articles.slice(0, 8).map((a) => <li key={a.url}><a href={a.url} target="_blank" rel="noreferrer">{a.title || a.url}</a> <span className="text-[0.72rem] text-text-3">{a.domain} · {at(a.seen_at)}</span></li>)}</ul>
            )}
          </div>
        ) : null}
      </Section>

      <Section title="Historical" tag={<DataTag kind="historical" />} aside="World Bank annual indicators.">
        {c.historical.indicators.length ? <IndicatorTable rows={c.historical.indicators} /> : <p className="text-[0.9rem] text-text-2">No indicators were retrieved.</p>}
      </Section>

      {(c.calculated.fx_change || c.calculated.example_conversion) && (
        <Section title="Calculated" tag={<DataTag kind="calculated" />} aside="What-if arithmetic on the data above.">
          {c.calculated.fx_change && (
            <Cells items={[
              { label: `${c.supplier_currency}→${c.business_currency}, past year`, value: `${c.calculated.fx_change.one_year_change_pct > 0 ? "+" : ""}${c.calculated.fx_change.one_year_change_pct}%`, sub: `${c.calculated.fx_change.from.date} (${c.calculated.fx_change.from.rate}) → ${c.calculated.fx_change.to.date} (${c.calculated.fx_change.to.rate})` },
              { label: "Largest rise in that year", value: `+${c.calculated.fx_change.largest_rise_pct}%`, sub: c.calculated.fx_change.largest_rise_from ? `${c.calculated.fx_change.largest_rise_from.date} → ${c.calculated.fx_change.largest_rise_to?.date}` : "no rise" },
            ]} />
          )}
          {c.calculated.fx_change && <p className="text-[0.78rem] text-text-3">{c.calculated.fx_change.method}</p>}
        </Section>
      )}

      <Section title="AI reading" tag={<DataTag kind="ai_generated" />}>
        {c.ai_reading.available ? (
          <div className="grid gap-2 text-[0.92rem]">
            <p>{c.ai_reading.summary}</p>
            {!!c.ai_reading.implications?.length && <ul className="grid list-disc gap-1 pl-5">{c.ai_reading.implications.map((t) => <li key={t}>{t}</li>)}</ul>}
            {!!c.ai_reading.caveats?.length && <p className="text-text-2">Caveats: {c.ai_reading.caveats.join(" ")}</p>}
            <p className="text-[0.75rem] text-text-3">{c.ai_reading.note} Model: {c.ai_reading.model}.</p>
          </div>
        ) : <p className="text-[0.9rem] text-text-2">{c.ai_reading.reason}</p>}
      </Section>

      <Section title="Scenarios you can test" aside="Built only from the data above. Nothing is added to your worlds until you choose.">
        {c.proposals.length === 0 ? <p className="text-[0.9rem] text-text-2">The retrieved data did not support any scenario. See the limitations above.</p> : (
          <>
            <div className="grid gap-3 md:grid-cols-2">
              {c.proposals.map((p) => {
                const done = c.applied[p.id];
                return (
                  <label key={p.id} className="card card-pad grid cursor-pointer gap-2" style={{ borderColor: pick.includes(p.id) ? "var(--text)" : undefined }}>
                    <div className="flex items-start gap-2">
                      {done ? <IconCheck size={18} /> : <input type="checkbox" className="mt-1" checked={pick.includes(p.id)} onChange={(e) => setPick((x) => e.target.checked ? [...x, p.id] : x.filter((y) => y !== p.id))} />}
                      <div className="grid gap-0.5"><b>{p.name}</b><span className="num text-[0.85rem]">{leverText(p.levers)}</span></div>
                    </div>
                    <p className="text-[0.82rem] text-text-2">{p.method}</p>
                    <ul className="grid list-disc gap-0.5 pl-5 text-[0.75rem] text-text-3">{p.assumptions.map((a) => <li key={a} className="[overflow-wrap:anywhere]">{a}</li>)}</ul>
                    {done && <span className="text-[0.8rem]">Created. <Link to="/app/worlds">Open in Parallel Worlds</Link></span>}
                  </label>
                );
              })}
            </div>
            <div><button className="btn btn-primary" disabled={busy || pick.length === 0} onClick={apply}>{busy && <Spinner />}Create {pick.length || ""} scenario{pick.length === 1 ? "" : "s"}</button></div>
          </>
        )}
      </Section>

      {c.requests.length > 0 && (
        <Section title="Data that would make this better">
          <ul className="grid gap-2">{c.requests.map((r) => (
            <li key={r.what} className="grid gap-0.5 border-b border-line pb-2 text-[0.9rem]"><b>{r.what}</b><span className="text-text-2">{r.why}</span><span className="text-[0.78rem] text-text-3">Where: {r.where.startsWith("Digital Twin") ? <Link to="/app/twin">{r.where}</Link> : r.where}</span></li>
          ))}</ul>
        </Section>
      )}
    </div>
  );
}

function BriefPanel({ countries }: { countries: Country[] }) {
  const ws = useWorkspace();
  const b = ws.current;
  const [list, setList] = useState<BriefSummary[] | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [form, setForm] = useState({ country: "PH", business_currency: "", supplier_currency: "", imported_share_pct: "", news_query: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!b) return;
    setBrief(null); setList(null);
    api.get<BriefSummary[]>(`/api/businesses/${b.id}/research/briefs`).then(setList).catch(() => setList([]));
    api.get<{ news_query: string; business_currency: string }>(`/api/businesses/${b.id}/research/defaults`)
      .then((d) => setForm((f) => ({ ...f, news_query: d.news_query, business_currency: d.business_currency }))).catch(() => undefined);
  }, [b?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!b) return <Empty title="Choose or create a business first">A research brief gathers public data for one business and suggests scenarios for it. <Link to="/app/new">Create a business</Link>.</Empty>;
  const countryCcy = countries.find((x) => x.code === form.country)?.currency;

  async function run(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const body = {
        country: form.country, business_currency: form.business_currency || null, supplier_currency: form.supplier_currency || null,
        imported_share_pct: form.imported_share_pct ? Number(form.imported_share_pct) : null, news_query: form.news_query || null,
      };
      const r = await api.post<Brief>(`/api/businesses/${b!.id}/research/briefs`, body);
      setBrief(r);
      setList((l) => [{ id: r.id, country: r.country, created_at: r.created_at, sources: r.content.sources, proposal_count: r.content.proposals.length }, ...(l ?? [])]);
    } catch (e2) { setErr(e2 instanceof Error ? e2.message : String(e2)); }
    finally { setBusy(false); }
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <Section title={`Research brief for ${b.name}`} aside="Gathers prices, economic indicators, exchange rates and news in one place, then suggests scenarios built only from what was retrieved.">
        <form className="grid gap-3 md:grid-cols-[repeat(4,minmax(0,1fr))]" onSubmit={run}>
          <label className="field"><span>Country</span>
            <select className="select" value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })}>
              {countries.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
            </select>
          </label>
          <label className="field"><span>Currency you sell in</span><input className="input uppercase" maxLength={3} value={form.business_currency} onChange={(e) => setForm({ ...form, business_currency: e.target.value.toUpperCase() })} /></label>
          <label className="field"><span>Currency you pay suppliers in (optional)</span><input className="input uppercase" maxLength={3} placeholder="e.g. USD" value={form.supplier_currency} onChange={(e) => setForm({ ...form, supplier_currency: e.target.value.toUpperCase() })} /></label>
          <label className="field"><span>Share of purchase costs in that currency, %</span><input className="input input-num" inputMode="decimal" placeholder="your figure" value={form.imported_share_pct} onChange={(e) => setForm({ ...form, imported_share_pct: e.target.value })} /></label>
          <label className="field md:col-span-3"><span>News search words</span><input className="input" value={form.news_query} onChange={(e) => setForm({ ...form, news_query: e.target.value })} /></label>
          <div className="flex items-end"><button className="btn btn-primary w-full" disabled={busy}>{busy && <Spinner />}{busy ? "Gathering data…" : "Gather data"}</button></div>
        </form>
        {countryCcy && form.business_currency && form.business_currency !== countryCcy && (
          <p className="text-[0.8rem] text-text-2"><IconAlert size={14} className="mr-1 inline" />{form.business_currency} differs from the local currency ({countryCcy}). If you trade in {countryCcy}, change it here and in the Digital Twin.</p>
        )}
        {busy && <p className="text-[0.8rem] text-text-3">Contacting five public sources. This usually takes 10–30 seconds.</p>}
        {err && <ErrorBox message={err} />}
      </Section>
      {list && list.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-[0.85rem]">
          <span className="text-text-2">Earlier briefs:</span>
          {list.map((x) => (
            <button key={x.id} className="btn btn-sm" aria-pressed={brief?.id === x.id}
              onClick={async () => setBrief(await api.get<Brief>(`/api/research/briefs/${x.id}`))}>
              #{x.id} · {x.country} · {new Date(x.created_at).toLocaleDateString()}
            </button>
          ))}
        </div>
      )}
      {brief && <BriefView key={brief.id} brief={brief} onApplied={setBrief} />}
    </div>
  );
}

// ------------------------------------------------------------------- page
const TABS = [
  { id: "brief", label: "Business brief" }, { id: "prices", label: "Shelf prices" }, { id: "economy", label: "Economy" },
  { id: "fx", label: "Exchange rates" }, { id: "news", label: "News" }, { id: "sources", label: "Sources" },
] as const;
type Tab = (typeof TABS)[number]["id"];

export default function Research() {
  const ws = useWorkspace();
  const [tab, setTab] = useLocalState<Tab>("startup-research-tab", "brief");
  const [country, setCountry] = useLocalState("startup-research-country", "PH");
  const [src, setSrc] = useState<Sources | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => api.get<Sources>("/api/research/sources").then((s) => { setSrc(s); setErr(null); }).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  useEffect(() => { load(); }, []);
  useEffect(() => { if (tab === "sources") load(); }, [tab]);

  if (err && !src) return <ErrorBox message={err} onRetry={load} />;
  if (!src) return <div className="grid gap-3"><Skeleton h={40} w={300} /><Skeleton h={220} /></div>;
  const c = src.countries.find((x) => x.code === country) ?? src.countries[0];

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-8">
      <PageHeader title="Market research" sub="Public data on prices, the economy, exchange rates and news, each linked to its source and kept separate from simulation results." />

      <dl className="grid gap-x-6 gap-y-2 text-[0.82rem] sm:grid-cols-2 lg:grid-cols-4">
        <div className="grid gap-1"><dt><DataTag kind="observed" /></dt><dd className="text-text-2">Recorded by a source at a point in time. One shelf price is one shopper's record, not an average.</dd></div>
        <div className="grid gap-1"><dt><DataTag kind="historical" /></dt><dd className="text-text-2">Official statistics for past years, as published.</dd></div>
        <div className="grid gap-1"><dt><DataTag kind="calculated" /></dt><dd className="text-text-2">What-if arithmetic on the data shown, with the method stated.</dd></div>
        <div className="grid gap-1"><dt><DataTag kind="ai_generated" /></dt><dd className="text-text-2">Interpretation written by an AI model. Only shown when it uses no numbers outside the data.</dd></div>
      </dl>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="seg max-w-full overflow-x-auto" role="tablist" aria-label="Research sections">
          {TABS.map((t) => <button key={t.id} className="whitespace-nowrap" role="tab"
            // Keep the active tab visible when the strip scrolls sideways on narrow screens (horizontal only).
            ref={(el) => { const p = el?.parentElement; if (el && p && tab === t.id) p.scrollLeft += el.getBoundingClientRect().left - p.getBoundingClientRect().left - 24; }} aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.id === "brief" && ws.current ? `Brief: ${ws.current.name}` : t.label}</button>)}
        </div>
        {tab !== "brief" && tab !== "sources" && (
          <label className="flex items-center gap-2 text-[0.85rem]"><span className="text-text-2">Country</span>
            <select className="select" value={c.code} onChange={(e) => setCountry(e.target.value)}>
              {src.countries.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
            </select>
          </label>
        )}
      </div>

      {tab === "brief" && <BriefPanel countries={src.countries} />}
      {tab === "prices" && <PricesPanel country={c.code} localCurrency={c.currency} />}
      {tab === "economy" && <EconomyPanel country={c.code} indicators={src.indicators.map((i) => i.code)} indicatorNames={Object.fromEntries(src.indicators.map((i) => [i.code, i.label]))} />}
      {tab === "fx" && <FxPanel localCurrency={c.currency} />}
      {tab === "news" && <NewsPanel country={c.code} countryName={c.name} defaultQuery={`${(ws.current?.business_type || "retail").split(/\s+/)[0].toLowerCase()} prices`} />}
      {tab === "sources" && <SourcesPanel data={src} reload={load} />}
    </div>
  );
}
