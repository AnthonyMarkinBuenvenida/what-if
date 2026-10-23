# StartUp — Design Reference Audit

This audit has two revisions:

- **Revision 2 (2026-10-22): Quick & Crafted, the primary reference for the current monochrome design.** See below.
- **Revision 1 (2026-10-21): Emergent and Higgsfield, now secondary references.** Kept further down for its observations. Its colour system (navy and gold) is **superseded**.

---

## Revision 2 — Quick & Crafted (primary reference)

Date of inspection: 2026-10-22. Site: https://quickandcrafted.com/

**Method.** I loaded the homepage live in a headless Chromium-based browser (Edge engine, Playwright) at 1440×900 and 390×844. I captured frames during load (about 0.9 s and 4.4 s) and after successive `PageDown` / `End` key presses, and recorded the accessibility tree. I also downloaded and analysed the HTML and the theme's own stylesheets (`base.css`, `chapters.css`, `wall.css`, `showroom.css`, `process.css`, `close.css`, `header.css`, `maker.css`, `material.css`) for tokens, type, radii, grids, easing and media queries.

### What was observed

- **Platform and type.** WordPress theme "quickandcrafted". Fonts are **Young Serif** (display) and **Instrument Sans** (text), self-hosted.
- **Palette (an important correction).** The site is **not black and white**. Its tokens are warm espresso, chocolate and kraft browns on ivory and paper: `--espresso #33201b`, `--chocolate #4a2e27`, `--kraft #835f54`, `--sand #e8d6cb`, `--paper #f4eae3`, `--ivory #fbf6f1`. The only dark error colour is `#a3261b`. The black-and-white direction for StartUp comes from the project brief, not from this site; from the site I took structure, spacing, type behaviour and motion.
- **Layout tokens.** `--max: 1440px`, a fluid gutter `clamp(18px, 4.2vw, 64px)`, section padding `clamp(5rem, 11vw, 10rem)`, and an 80px header. Grids are asymmetric: `minmax(0,6fr) minmax(0,5fr)`, `4fr/7fr` and `7fr/5fr`.
- **Radii.** Mostly 3px (15 uses), 50% for dots and 999px for a few pills. Corners stay almost square.
- **Type scale.** Large fluid `clamp()` headings (up to `clamp(4.5rem, 10.5vw, 12rem)`) with tight negative tracking (−0.03 to −0.04em).
- **Motion.** Three easings: `--ease-out cubic-bezier(0.16,1,0.3,1)`, `--ease-cut cubic-bezier(0.77,0,0.18,1)` and a small overshoot `--ease-mount`. Durations are 180 / 460 / 950 ms. Keyframes are named for the craft (`qc-cut-in`, `qc-laser-x`, `qc-tray-in`), and reveal animations sit inside `prefers-reduced-motion: no-preference` blocks.
- **Hero.** A one-line text headline at small size, top left ("Custom acrylic signs, displays and keepsakes, made to order."), above a **live configurator**. You type your words and choose a shape (Sign / Round / Arch / Panel / Box) and a finish (Clear / Frosted), and a rendered sign preview updates beside a reference photo. There is one primary action ("Request a quote with this") and a text link ("Browse all 60 products"). A small note says the sketch is not a production proof.
- **"Made for" chapters.** Five full-viewport chapters (Weddings & events, Offices & storefronts, Safety & facilities, Retail & display, Awards & keepsakes) with:
  - a counter ("1 / 5") and a short description at top left;
  - a vertical list of product thumbnails;
  - a full-bleed photo;
  - a very large condensed headline at bottom left;
  - a dash-marked chapter index at top right.
- **Product wall, FAQ and close.** "Everything we make, on one wall" (13 categories, horizontally scrolled; seen only in the accessibility tree, see limitations) leads into "Why acrylic", then a "Common questions" FAQ accordion (plus icons, hairline dividers). The page closes with a large serif headline "Tell us what you need made.", a short paragraph, one dark button, phone and address.
- **Navigation.** Logo, Products (dropdown), Events, About, Contact, and a "Quote list" counter. On mobile: logo, quote counter and a Menu button.

### What StartUp adopted

| Quick & Crafted principle | StartUp implementation |
|---|---|
| Hero as a live configurator with one primary action | Homepage hero: pick a decision and a demand level; one business forks into the baseline and that decision, **calculated by the engine** for the fictional store. Primary CTA "Try Live Demo" |
| Numbered chapters with a counter | "How it works": five chapters numbered `01 / 05` … `05 / 05` with a scroll-linked progress rule. Numbering is used because it is a real sequence |
| Asymmetric 6/5 and 4/7 grids, generous section padding | Hero 7fr/4fr, chapters 4fr/7fr, sections at 80–112px vertical padding |
| Near-square radii (3px) | Controls 4px, cards 6px, panels 8px; no pills |
| Large condensed display headings with tight tracking | Bricolage Grotesque at 82% width, −0.04em tracking, `clamp()` sizes |
| Hairline dividers instead of boxes | Black 1px rules above sections; feature tiles on a shared hairline grid instead of floating cards |
| FAQ accordion with plus icons | Homepage "Common questions" |
| Plain closing section with one action | Black closing band "Test the decision before you pay for it." with Try Live Demo / Open workspace |
| One long expo-out ease, restrained reveals, reduced-motion handling | `--ease-out cubic-bezier(0.16,1,0.3,1)`; one load reveal; section reveals once; all motion off under `prefers-reduced-motion` |

Not adopted: product photography and the "wall" of thumbnails (StartUp has no product images, and decorative photos would add nothing), the serif display face (StartUp keeps its own grotesk identity), and the warm brown palette (the brief asks for black and white).

### Could not be inspected or verified

- Only the **homepage** was inspected. Product, category, About and Contact pages were not opened.
- The **product wall** section fell between two key-press frames, so it was observed only through the accessibility tree and CSS, not visually.
- **Hover states** could not be captured (no pointer hover in the tool). The configurator was observed but not operated; I did not type into it or switch shapes.
- Animation timing comes from CSS declarations and frames sampled about a second apart, not frame-by-frame measurement.

### Current design system (monochrome)

Source of truth: `frontend/src/styles/tokens.css` and `app.css`.

- **Palette.** Pure white `#ffffff` and black `#000000`, with a neutral grey ramp (`#171717` … `#fafafa`, no tint). Secondary text is `#525252` (7.8:1 on white) and tertiary text `#6b6b6b` (5.3:1). Inverted black bands (`.scope-ink`) are used for the homepage close.
- **No colour coding.** Status is told by icon plus word:
  - "within limits" is an outlined chip with a check;
  - warnings use a grey fill with a triangle;
  - failures use a black fill with white text.
- **Data categories.** One `DataTag` component labels every number as *Live measurement*, *Calculated* or *Fictional example data* (dashed outline).
- **Charts.** Series differ by grey value, dash pattern (solid, 7-4, dotted, dash-dot …) and point-marker shape (circle, square, triangle, diamond, ring, cross). The same mark appears in legends, tables and range rows. Diverging bars are black (raises the value) or light grey with an outline (lowers it), and the sign is always printed.
- **Type.** Bricolage Grotesque (display, condensed, heavy) and IBM Plex Sans (UI, tabular numbers). Two families, unchanged from revision 1 to keep StartUp's identity.
- **Logo.** A black square with one white line forking into three: solid, dashed and dotted, the chart series styles.
- **Motion.** 160 ms for state changes, 240 ms for transitions, 600–900 ms for entrances, with the expo-out ease. Running work shows a pulsing dot only while the server reports activity.

---

## Revision 1 — Emergent and Higgsfield (secondary references)

The observations below are unchanged. Their navy and gold colour system (section 5 of this revision) was replaced by the monochrome system above.

Date of inspection: 2026-10-21
Method: both sites were loaded live in a headless Chromium-based browser (Microsoft Edge engine 155, via Playwright) at 1440×900 desktop and 390×844 mobile, with `prefers-reduced-motion: no-preference` and a dark colour scheme. Screenshots were captured at timed intervals after load (≈0.7 s, ≈2 s, ≈5 s) and after successive `PageDown` presses to observe load sequences and scroll behaviour. The accessibility tree of each page was captured to record structure, and each site's production CSS was downloaded and searched for font families, easing curves, durations, keyframe names and reduced-motion handling.

Everything below is limited to what those captures showed. Where something could not be observed, it is listed in section 6 rather than guessed.

---

## 1. What was observed

### 1.1 Emergent — `https://app.emergent.sh/home`

**Access.** `/home` redirected an unauthenticated browser to `https://app.emergent.sh/landing/`. The logged-in workspace (project list, task composer inside a project, agent activity view) sits behind Google/email/phone sign-in and **could not be inspected**. Observations are about the public landing/auth page only.

**Load sequence (observed across timed frames).**
- ~0.7 s: near-black canvas with a faint, monospace "character rain" field (random glyphs at low opacity) behind a centred stack: chrome-effect "e" mark, two-line headline, auth buttons. The stack is already in place; there is no large hero entrance motion on the central content.
- ~2 s: the glyph field has faded and a ring of tilted, rotated app/website screenshots (phones, browser frames) has appeared around the centre stack in an orbit, partially off-screen and dimmed toward the edges.
- ~5 s: screenshots settle. CSS keyframes confirm this: `radial-orbit-reveal`, `radial-orbit-spin`, `radial-auth-methods-reveal`, `dl-word-in`, `dl-caret`, `skeleton-shimmer`, `marquee`, `dl-model-marquee`, `dl-connectors-marquee`, `wingmanGlowA/B`, `wingman-task-slider`.

**Composition.** Everything is centred on a single action ("Describe your idea / Build websites & apps with AI"), with one high-contrast white pill button (Continue with Google) above two dark, low-contrast pill buttons. Decorative imagery lives only at the edges and is dimmed, so the centre stays focused. The second headline line uses a soft green accent on part of the phrase.

**Scroll.** Below the hero, the page shifts from the dark canvas to **light sections** (white / `#f8f8f8`-range backgrounds): a "What can Emergent do for you?" tabbed feature area (`tablist` with three tabs and an illustration panel), a pricing area with an Individual/Enterprise segmented control and an annual/monthly switch, an integrations logo row, and "How Emergent turns idea…" with a product screenshot. A sticky top bar appears on scroll with text links and a white "Get Started" pill with an arrow. Several sections render a "Loading section…" placeholder first and stream in (lazy-loaded).

**Type & colour (from CSS).** `Brockmann` for display, `Inter` for UI, some `Geist`. Most-used easing is the standard `cubic-bezier(.4,0,.2,1)` at `150ms` (24 occurrences), plus a softer `cubic-bezier(.2,.65,.25,1)` and an expo-out `cubic-bezier(.16,1,.3,1)` for larger reveals. Longer durations of `300ms`, `500ms` and `1s` appear for section-level transitions. One `prefers-reduced-motion` block exists.

**Mobile (390 px).** The orbiting screenshots are dropped. The glyph field remains as a background. Auth options reflow into one full-width white pill, a row of three icon buttons (GitHub, Apple, Facebook), an "OR" divider, then full-width dark pills. Headline wraps to three lines and keeps its accent colour.

### 1.2 Higgsfield — `https://higgsfield.ai/?fpr=glowora-810d9a`

(Loaded as `https://higgsfield.ai/`; the `fpr` parameter is an affiliate code and did not change the page.)

**Navigation.** A dense top bar: logo mark, a horizontally scrolling list of about 25 product links (Explore, Image, Video, Audio, MCP, API, then named tools with small "Top"/"New" pill badges), a "Pricing" link with a "30% OFF" badge, Enterprise, a language button, Login, and an acid-lime "Sign up" button. On scroll the bar stays fixed and compacts slightly (smaller logo). On mobile it reduces to logo, Instagram, Pricing, Sign up.

**Hero.** There is no headline hero. The first viewport is a **media carousel**: three large rounded video tiles (≈512×288 at desktop), each with an uppercase condensed title and a one-line description below. The tiles autoplay short clips; frames captured 1–2 s apart show different moments of the same videos (text animating in, motion-blur transitions). The carousel extends past the right edge, signalling horizontal scroll.

**Bento promo grid.** Below the carousel: a large rounded promo card with a full-bleed cinematic image, a big uppercase two-tone headline (white + lime), a short check-list and a lime CTA. Next to it is a 3×2 grid of small dark tiles, each with an icon, title, coloured "TOP/NEW" badge and one-line description.

**Media-led sections.** "HIGGSFIELD GENJUTSU BY COMMUNITY" is a section heading (uppercase, lime) with a sub-line and right-aligned "Start generating" (lime) and "Learn more" (white) buttons, followed by a **masonry grid of portrait and landscape video tiles** with "View all presets" floating at the bottom over a fade. This pattern repeats: "Explore the inside of every project" (landscape poster cards with creator avatars and like counts), "Seedance 2.5" (another masonry), then a full-width **"Supercomputer" panel**: dark green grid background, lime glowing border, a central wordmark, and floating UI cards (UGC Creator, Marketing, Production, "Analyzing hooks" / "Visualizing" status chips) placed around it like satellites.

**Footer.** A full-bleed **acid-lime** footer with a large "AI-NATIVE CREATIVE SUITE" statement on the left and six dense link columns, then a dark legal strip.

**Type, colour, motion (from CSS).** Primary/secondary families are `Inter Display`/`Inter`, plus a grotesk (`Space Grotesk`) and `Space Mono`/`IBM Plex Mono` for data-style text. The brand colour token is `--color-lime: #d1fe17`, with a cyan tertiary `#9ce6f3`. Default transition duration is `200ms` with `cubic-bezier(.4,0,.2,1)` (284 uses). Larger reveals use `cubic-bezier(.22,1,.36,1)` and `(.16,1,.3,1)` (expo-out), with an occasional overshoot `cubic-bezier(.34,1.36,.64,1)`. Long-running decorative keyframes of 5.9–7.3 s exist (drifting/glow). Several stylesheets contain `prefers-reduced-motion` rules.

---

## 2. Animation patterns and interactions worth adapting

| Pattern | Seen on | How StartUp adapts it |
|---|---|---|
| One orchestrated load moment, then stillness | Emergent (glyph field → orbit reveal) | The hero plays one sequence: headline lines rise in, the "twin" node appears, branches draw outward, world cards land with their computed numbers. After that, nothing loops except an optional slow drift on the fork lines. |
| Satellite cards around a central object | Emergent orbit, Higgsfield Supercomputer panel | The "digital twin" sits at the fork's root and the scenario cards are placed along branches. They are positioned by meaning (each branch is one world), not scattered decoratively. |
| Expo-out easing for reveals, standard ease for UI | Both (`.16,1,.3,1` / `.22,1,.36,1` for reveals; `.4,0,.2,1` at 150–200 ms for UI) | Two easing tokens: `--ease-out-expo` for entrances (500–700 ms) and `--ease-standard` for hover/state (150–200 ms). |
| Status chips that say what the AI is doing ("Analyzing hooks", "Visualizing") | Higgsfield | Agent steps in the workspace show real step names ("Data Analyst: checking columns", "Simulation engine: 500 runs") and change state only when the backend reports a change. |
| Lazy section loading with placeholders | Emergent ("Loading section…") | Skeleton blocks in the workspace while API data loads; never fake numbers. |
| Fixed nav that compacts on scroll | Higgsfield | Landing nav gains a backdrop and shrinks its height after the hero. |
| Tabs that swap an illustration panel | Emergent features | Used in the product showcase to switch between Lab / Stress test / Reality check views. |
| Light/dark section change on scroll | Emergent | The landing page moves from the dark night hero into a light "paper" section for How It Works and Features, then back to dark for the closing call to action. |
| Horizontal marquee | Both (`marquee` keyframes) | One slow marquee of real decision questions. It pauses on hover and stops entirely under reduced motion. |

Not adopted: autoplaying video walls (StartUp has no video library and it would hurt performance), background glyph rain (reads as "AI magic" rather than evidence), constant glows.

## 3. Visual elements that should influence StartUp's landing page

- **Scale contrast** (Higgsfield): very large display type against small, quiet captions. StartUp uses a heavy, slightly condensed grotesk for headlines and keeps body copy small and calm.
- **Media as proof** (Higgsfield): the product's output is the hero. For StartUp, the "media" is a live, engine-computed fork of futures, not stock imagery.
- **Bento of capabilities with varied sizes** (Higgsfield promo grid): the Features section uses an asymmetric grid where the flagship features (Parallel Decision Lab, Stress Testing) get large tiles with real mini visuals, and supporting features get smaller tiles.
- **Focused centre of gravity** (Emergent): every section has one obvious next action.
- **Dense, honest footer** (Higgsfield): a real site map that links to sections and app routes.

## 4. Design principles that should influence StartUp's workspace

From Emergent's public surface (the workspace itself was not inspected; see section 6):
- **Begin immediately.** The first thing in the app is a large prompt composer ("Describe your business and the decision you want to test"). Configuration is optional and progressive.
- **One primary action per view**, as a high-contrast pill. Secondary actions are quiet.
- **Calm chrome.** Thin borders, generous padding, low-contrast surfaces. Colour is reserved for data and status.
- **Visible system work.** Agent and engine steps are listed with real status. Progress bars appear only when the engine reports progress.
- **Streaming/lazy states** use skeletons, not spinners over the whole page.

## 5. Combined design system (summary) — superseded by Revision 2

Full tokens live in `frontend/src/styles/tokens.css`.

**Identity: "the fork."** StartUp's signature is a single line (your business today) that splits into several futures. It appears as the logo mark, the hero diagram, the loading indicator and the scenario-comparison charts. This replaces both references' imagery with something only this product has.

**Colour.**
- Night `#0c1322` (landing hero and closing band) with raised surface `#131c30`. This is a deliberate deep navy, not a tinted black.
- Paper `#eef1f5` for light landing sections and the light app theme.
- Horizon gold `#f2c14e` is the single brand accent, used for primary calls to action, the logo fork and focus rings. It is distinct from Higgsfield's lime and Emergent's green.
- Data colours: a validated categorical palette, in fixed order, with separate light and dark steps (blue, orange, aqua, yellow, magenta). Each scenario keeps its colour across every chart.
- Status colours (good/warning/serious/critical) are reserved and always paired with an icon and a label.

**Type.** Bricolage Grotesque (display, heavy, tight tracking) and IBM Plex Sans (UI and body, tabular figures for numbers). Two families, clearly distinct. No all-caps eyebrow labels.

**Motion.** `--ease-out-expo: cubic-bezier(.16,1,.3,1)` for entrances; `--ease-standard: cubic-bezier(.4,0,.2,1)` for UI. Durations: 150 ms (hover), 220 ms (state), 450–700 ms (entrances), with staggers of 60–90 ms. Everything nonessential is disabled under `prefers-reduced-motion`, and charts render in their final state.

**Surfaces.** The landing page is expressive: large type, the fork diagram, a light/dark rhythm. The workspace is restrained: a sidebar, a single content column, light or dark theme, and colour only for data and status.

## 6. What could not be inspected or verified

- **Emergent's authenticated workspace** (`/home` and any project view) requires an account; it redirected to the landing page. The task-composer layout inside the app, the agent activity feed, project navigation, transitions between starting a task and working inside a project, and the workspace's responsive behaviour were **not observed**. The workspace principles in section 4 come only from the public landing/auth page and the brief.
- **Hover states** were not captured on either site (the capture tool supports clicks and key presses but no pointer hover). Hover feedback in StartUp follows the measured CSS transition tokens rather than observed hover visuals.
- **Exact timing curves of the JavaScript-driven animations** (Higgsfield's video carousel, Emergent's orbit spin) were not measured frame by frame; timings come from CSS declarations and frames sampled about a second apart.
- **Video content** on Higgsfield autoplayed but was only seen as sampled frames.
- **Page transitions between routes** were not exercised on either site.
- Higgsfield's cookie banner covered part of the first viewport until it was dismissed (by rejecting analytics cookies).

No proprietary code, logos, imagery or copy from either site is used in StartUp.
