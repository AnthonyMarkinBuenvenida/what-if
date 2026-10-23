# What-if visual identity

**Current theme (2026-10-23): Ascend deep-space.** At the user's request the theme, background and
motion of the "Ascend" reference were merged into What-if without changing its content:

- **Palette:** bg #04060f, ink #f3f6ff, muted #9aa6c4, mint accent #5df0a8 / #2fd38a with ink #032018,
  glass rgba(12,18,38,.55) / rgba(16,24,48,.65), radii 18 / 26 px.
- **Small text:** muted-2 #6b7796 is used for decorative and large text only (4.2:1 on glass); small text uses #7a86a6 (5.2:1).
- **Type:** Inter Variable 400–900. Headlines are weight 800 with tight tracking; eyebrows are uppercase mint, 12 px, .18em.
- **Controls:** pill buttons; the primary button is the mint gradient with glow.
- **Background:** the WebGL planet (frontend/src/whatif/backdrop/planet.ts).
  - Landing: scroll choreography and a float-up entrance.
  - App pages: a dimmed low horizon.
- **Motion:** Lenis smooth scroll and the staggered [data-reveal] fade-up (0.7 s, cubic-bezier(.22,.7,.2,1)).
- **Kept from What-if:**
  - Aurora #c2b5ff for AI-written content.
  - Severity colours with shapes.
  - Chart slots revalidated on #0b1022: #2aa877, #d2733a, #8a72e6 (CVD ΔE ≥ 8.2, normal ΔE ≥ 22.4).
  - The baseline as a dashed neutral line.
- **Not copied from Ascend:** its fictional customer logos and marketing stats, which would break What-if's
  no-fabrication rule. The hero lists the six supported industries, and the stats are verified product facts.

The previous horizon theme (Mona Sans, signal cyan) is preserved in the backups and summarised below.

---

# What-if visual identity

Supersedes the monochrome StartUp direction (docs/design-reference-audit.md) at the
request of the What-if brief: dark and atmospheric, with accents used for meaning.

**Reference studied:** tryemulate.ai/product. Borrowed structure, not look: dashed 1 px frame lines
(4 px dashes) around a wide column, light large headlines, real product UI as the hero, and
shimmer/sweep only while work runs.

**Subject and job:** a decision simulator for small-business owners. Its job is to show the fork
between the current course and a decision, and the risks of each path.

**Signature element:** the horizon. Today's line (Moon, dashed) meets the break-even line and the
decision's path (Signal) rises from it with a worst-to-best band. The landing hero shows it
live; charts across the app reuse it. Everything else stays quiet.

| Token | Hex | Role |
|---|---|---|
| Night | #060913 | base |
| Deep / Deep-2 | #0c1322 / #121b2e | surfaces |
| Moon | #d9e2f2 | text, baseline |
| Signal | #7fe0f0 | calculated projections, focus, primary accent |
| Aurora | #c2b5ff | AI-written content (text and chips only) |
| Chart slots | #2a9db5, #d2733a, #8a72e6 | validated all-pairs on #0c1322 (CVD ΔE ≥ 9.8, normal ΔE ≥ 17.4) |
| Severity | #7cc8a4 / #f2c14e / #f08a5d / #ff5c7a | always with a shape (● ▲ ◆ ⯃) and a word |

**Type:** Mona Sans Variable only. Display uses width 108–112%, weight 300–340 and tight tracking. UI text is at
width 100%. Numbers use lining proportional figures, because Mona Sans' tabular figures are a
monospace design with a slashed zero.

**Rules:** no all-caps eyebrows; numbered markers only for real sequences (How it works);
animation only reflects real state (calculating, a new result arriving, an opened panel);
reduced motion is respected; every text pair is ≥ 4.9:1 contrast; print switches to light.

**Backgrounds:** see frontend/src/whatif/backdrop/Backdrop.tsx (context × industry × scenario).
