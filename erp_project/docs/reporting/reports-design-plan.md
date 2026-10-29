# Reports landing + report shell: design plan

**Status (2026-10-27):** plan, awaiting go-ahead. No code yet.

## Subject, audience, job
- **Subject:** goods moving through one chain: a PO is **ordered**, the manufacturer **invoices**, the invoice is **inwarded** (inward PO, Uniware PO), and the warehouse **receives** it (GRN). Every report looks at one stretch of that chain.
- **Audience:** everyone who uses the ERP (procurement, inwarding, finance, ops), each limited to their own brands and manufacturers.
- **The landing page's one job:** get you to the right report quickly, and show where the chain is failing right now.
- **The shell's one job:** make every report read the same way (what it answers, how fresh it is, what's filtered, what to download) so nobody re-learns a page.

## Constraints
- **Inside the app's design system:**
  - type: Merriweather headings, Outfit body, Geist Mono figures;
  - colours: the primary blue and the existing semantic emerald / amber / red;
  - the shared components, light and dark mode.
- **No new identity, no chart library.** This is one section of an internal tool, not a microsite.
- **Your rule still applies:** improve existing screens in place. The landing and the shell are this work's own screens, so redesigning them is in scope; no other page changes.

## Tokens (all existing app tokens; nothing new is introduced)

| Role | Token | Use |
|---|---|---|
| Ink | `--foreground` oklch(0.145 0 0) | text, the track line |
| Paper | `--background` / `--card` | surfaces |
| Rule | `--border` oklch(0.922 0 0) | dividers, inactive track |
| Flow | `--primary` oklch(0.50 0.134 243) | the track, stage markers, focus |
| Signal | amber-600 | "look at it" counts |
| Fault | `--destructive` | "act on it" counts |

- **Type:**
  - *Display:* Merriweather, used sparingly: the page title, plus the stage names on the track.
  - *Body:* Outfit for questions and labels.
  - *Utility:* Geist Mono tabular for every live figure, code and timestamp.

## Signature: the chain as the catalogue's spine
The landing page is laid out on the **chain itself**: a horizontal track with four stations (Ordered → Invoiced → Inwarded → Received).
- **Placement:** each report sits under the station (or the span of stations) it covers.
- **Live figure:** each station shows its one live figure in mono, scoped to you, e.g. "12 overdue POs", "423 invoice mismatches", "27 batch problems · GRNs synced 2 days ago".
- **Status colour:** a station's marker turns amber or red when its figure says so.
- **Why the order is real:** goods actually move left to right, and the stations carry that meaning.
- **Phone layout:** the track runs vertically.

This is the one bold element. Everything around it is quiet: plain sections, hairline dividers, no gradients, no hero numbers.

```
Reports                                     (Merriweather, the only large type)
Your brands and manufacturers · live · 14:32 IST

OVERVIEW ── Exception inbox · 924 open ── Scorecard ── Trends
──────────────────────────────────────────────────────────────────────
  ORDERED ────────── INVOICED ────────── INWARDED ────────── RECEIVED
   ●                   ●                    ●                   ●(amber)
  12 overdue POs      423 mismatches       1,301 lines         27 batch problems
                                                                GRNs synced 2d ago
  Open PO book        Invoice checks       PO ↔ invoice lines  Batch ledger
  PO receipt ledger   Rate vs PO                               GRN lines
  ├──────────── Manufacturer fill rate ──────────────────────────────┤  (spans)
  ├──────────── Trace one item · SKU summary ─────────────────────────┤ (spans)
──────────────────────────────────────────────────────────────────────
Upkeep    Data quality · 8 checks, 4 failing
```

- **Report entries:** each is a link line (name plus the question it answers), not a card grid.
- **Datasets:** the six traceability datasets appear under their own stations and link straight to their tab (`?tab=t2` etc.).
- **Search:** the existing search stays and filters the entries; stations with nothing matching dim.

## Report shell (applied to every report page)

```
← Reports  /  Received                                    [CSV] [Excel] [Workbook]
Batch ledger                                              (Merriweather)
Was each billed batch received, short, or never billed?   (Outfit, muted)
Live · 14:32 IST · GRNs last synced 2 days ago · How it's calculated ▸
──────────────────────────────────────────────────────────
[Filters (3)] [Group by ▾] [Tabs …]   chips of active filters, each removable ✕
──────────────────────────────────────────────────────────
totals line (mono), e.g. 1,048 rows · 27 problems · 8,400 billed
table …
```

- **Breadcrumb:** names the station the report belongs to, so the shell and the landing share one map.
- **Freshness line, always in the same place:**
  - "Live · <IST time>" for live reports;
  - plus the GRN sync age wherever GRN data is used;
  - "Snapshot of <day>" on Trends.
- **"How it's calculated":** a disclosure holding each report's definitions, already written in `dataset-contracts.md` / `implementation-plan.md`. It answers "can I trust this number".
- **Active-filter chips:** shown under the toolbar, each removable on its own. Today you have to open the panel to see what's filtered.
- **One totals line in mono,** replacing the per-report stat cards that vary page to page.
  - **Note:** this is a change to existing report pages, so I'll list it separately for your OK. Option: keep the cards and only add chips and freshness.

## Self-critique: what I changed from the first draft
1. **Dropped a card grid with icons on the landing.** It was the template answer and said nothing about the chain. The track replaces it.
2. **Dropped big KPI numbers per category.** They were the template hero. One mono figure per station, in sentence form, says the same with less noise.
3. **Considered "01 / 02 / 03" markers for the stations and rejected them.** The stages are a real sequence, but their names carry the meaning better than numbers.
4. **Dropped a stage-colour palette** (one colour per stage). It invented colour meaning the app doesn't have. Stations stay in Flow blue and only turn amber or red on a real problem.
5. **Motion:** none except the track drawing in once on load (respecting reduced motion). Scattered hover effects would make it feel generated.

## Data cost
- **Station figures come from existing services, scoped to the viewer:**
  - open PO totals (~30 ms on prod);
  - inbox counts (~0.5 s);
  - DQ counts (~0.2 s);
  - GRN sync age.
- **Loading:** each station streams in its own Suspense boundary, so the page draws instantly and the figures fill in.
- **Access:** reports and figures you can't open are hidden, as now.

## Build steps (after go-ahead)
1. Station model: a pure module mapping each report and dataset to a station or span. Unit-tested so every catalogue entry is placed.
2. Landing redesign (track, streamed figures, search, phone layout).
3. Shell component: header, freshness line, "How it's calculated", filter chips. Applied to the report pages.
4. (Separate OK) Replace the per-report stat cards with the totals line.

## Verification
- `tsc --incremental false`, `lint:changed`, `npm test`.
- A dev click-through at desktop and phone width, in light and dark mode, with keyboard focus visible on every link.
- With prod data via your `APP_ENV=prod` server: the station figures equal the reports they link to.
