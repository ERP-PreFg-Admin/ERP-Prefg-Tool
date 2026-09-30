# Pincode-aware price parity

## Context

Today a reading cannot say which delivery area it came from. Location is entirely
implicit — whatever address the machine's logged-in browser profile happens to have — and
the only check is a substring match of a free-text city name against the page HTML
(`background.js:76`). `reporter` is the de-facto location dimension: one teammate = one
area.

You want one machine to cycle a list of pincodes — several zones inside each tier-1 city,
plus tier-2 cities — and to view results per pincode. That breaks
the current model in a specific way: with `reporter` constant and pincode varying **within
one sweep**, the unique key `one_read (sweep_ts, reporter, sku, channel)` makes every
reading of a SKU collide and upsert over the last. Silently — it is an UPDATE, not an
error. So the data model has to change before any scraping change is worth doing.

The multiple-zones-per-city part is not a detail: quick commerce runs many dark stores per
city and prices them independently, so intra-city spread is likely the most useful thing
this will surface — and one pincode per city would average it away.

Separately, the SKU list has been reduced in the sheet. That needs **no code change** —
targets are read live, so the next sweep picks it up. It does make the cycling affordable.

Intended outcome: every reading carries the pincode it was read at; the dashboard shows
one market at a time; parity is computed within a market, never across.

---

## Phase 1 — the pincode dimension (do this first, alone)

Worth shipping on its own: it makes readings honest about where they came from, and every
later phase depends on it.

### Schema — `db/schema.sql`

```sql
pincode  CHAR(6)  NOT NULL DEFAULT ''        -- after `channel`
UNIQUE KEY one_read (sweep_ts, reporter, sku, channel, pincode)
```

`NOT NULL DEFAULT ''`, not nullable — MySQL treats NULLs as distinct in a unique key, so a
nullable pincode would disable dedup for exactly the rows that lost their pincode.

Leave the three existing indexes alone. `sku_time (sku, channel, read_ts)` still answers
one-SKU history and now returns every pincode, which is what you want. Add a pincode index
only if a filter measurably drags.

The table holds test rows only, so **do not write a migration**: edit `schema.sql`, then
`DROP TABLE Price_Parity_Data;` and paste it in Workbench. There is no migrations
directory, and an ALTER script would become a second source of truth that drifts.

Also update the five canonical queries in the comment block (`schema.sql:37-85`) to
partition/group by pincode.

### `db/api.py` — in this order

1. `COLS` (:63) — add `("pincode", "pincode")` after channel. `ALL` and `INSERT` follow.
2. `LEN` (:73) — add `"pincode": 6`. Required, or `values()` raises `KeyError` at :170.
3. `KEYED` (:81) — add `"pincode"`. Keeps `check()`'s schema.sql parse (:311) and
   `preflight()`'s `information_schema` check (:376) passing.
4. `values()` (:162) — coerce a missing pincode to `""`; `txt(None, 6)` returns `None`,
   which fails the whole `executemany` against a NOT NULL column.
5. `LATEST` (:97) — `PARTITION BY reporter, sku, channel, pincode`. Without this `/latest`
   collapses every pincode into one and `/breaches` misses most breaches.
6. `READS["/latest"]` (:103) — `ORDER BY sku, channel, pincode`.
7. `check()` (:294) and the `deploycheck()` probe (:507) — carry a pincode, so the column
   is proven end to end.

### Extension

- **`background.js` `readOne()` (:305)** — add `pincode` to the record.
- **`background.js` `addParity()` (:116)** and **`dashboard.js` `withParity()` (:44)** —
  group by `` `${r.sku}|${r.pincode}` `` instead of `r.sku`. These two are already
  duplicated logic; change them identically or the badge and the dashboard disagree.
  A cross-pincode median is wrong on the merits: quick-commerce prices are legitimately
  per-area, so pooling makes the benchmark an average of unlike markets — a channel priced
  correctly in an expensive pincode reads as a breach, and a real undercut in a cheap one
  gets masked.
- **`store.js`** — `put()` (:37), `latest()` (:146) and `history()` (:156) dedupe on
  `r.key` (= `channel:productid`), which is now 10-to-1. Add one helper,
  `const idOf = (r) => r.key + '|' + r.pincode`, and use it in those three. Do **not**
  mutate `r.key` — it is posted as `product_key`; update `history()`'s caller to pass the
  composite.

### Where the pincode list lives — the Sheet, not `config.json`

A new lookup tab (`Pincodes`), named by one new `pincode_tab` key in `config.json`:

| pincode | city | zone | tier | lat | lng | cadence |
|---|---|---|---|---|---|---|
| 400050 | Mumbai | Bandra W | metro | 19.0596 | 72.8295 | every |
| 400601 | Mumbai | Thane | metro | 19.2183 | 72.9781 | rotate |
| 560034 | Bengaluru | Koramangala | metro | 12.9352 | 77.6245 | every |
| 302020 | Jaipur | Malviya Nagar | tier2 | 26.8535 | 75.8087 | rotate |

`sheet.js` skips it as a channel exactly as `name_tabs` already does (:111) and returns the
list; `loadTargets()` (`background.js:236`) cross-products targets × **selected** pincodes
for the channels that vary.

`config.json` is bundled, so putting the list there means a rezip and a redistribution
every time a pincode changes. The sheet is already the source of truth for everything else,
and the Apps Script web app already returns any non-hidden tab — so this needs no Apps
Script change beyond *not* adding the tab to its `SKIP` list.

`lat`/`lng` are in the sheet rather than hardcoded because quick commerce resolves a dark
store from coordinates, not from a pincode — see Phase 2. Editing a coordinate to move a
reading to a different part of a city should not need a rebuild.

### Choosing which pincodes to sweep

Sweep cost is linear in the number of selected pincodes, so this must be a deliberate
choice rather than "everything in the tab".

**In the sheet:** `cadence` is the master control — `every` (swept on every sweep),
`rotate` (swept in turn, see *Sizing*), or `off`. **In the popup:** a per-install picker
over those, stored in `chrome.storage.sync` under `pincodes` (an array of codes). Empty =
follow the sheet, so a fresh install works with nothing configured.

The picker replaces the current **Your city** field, which becomes meaningless once
location is set rather than guessed — `qcMarker` and `storeOk()` are deleted in Phase 2.

With ~40 pincodes a flat checkbox list is unusable in a 320px popup, so: **collapsed by
city**, one row per city showing `Mumbai — 3 of 5`, expanding to the zones. Quick toggles
**All · Metros · Tier 2 · None**, plus per-city select-all. Under it, a live estimate:

> 33 selected · ~150 min per sweep · exceeds the 2 h interval — switch to 3 h

computed from the target count and the measured ~3.5 s/row. That line is the point of the
control: it makes the cost of adding a zone visible at the moment of adding it, rather than
as a sweep that silently overruns its window a week later — and it names the fix.

### Several pincodes per metro — and why that is the interesting part

A metro is not one market. Blinkit, Zepto and Instamart each run many dark stores per city
and price and stock them independently, so Bandra and Thane can genuinely differ on the
same day. One pincode per metro would average that away and report a single "Mumbai price"
that nobody actually pays.

So the list is **zones, not cities**: 3–5 spread across each metro, deliberately picked to
sit in different dark-store catchments (a central zone, a suburb, a satellite city), and
1–2 per tier-2 city.

Starting set to paste in and then **verify** — treat these as a first draft, not gospel.
What matters most is that the `lat`/`lng` lands in the zone you mean, because that is what
quick commerce actually resolves a store from; the pincode digits are mainly for the
marketplace channels and for labelling.

| city | zones |
|---|---|
| Mumbai | 400050 Bandra W · 400053 Andheri W · 400076 Powai · 400703 Vashi · 400601 Thane |
| Delhi NCR | 110001 CP · 110017 Saket · 110092 Mayur Vihar · 122002 Gurugram · 201301 Noida |
| Bengaluru | 560034 Koramangala · 560066 Whitefield · 560103 Bellandur · 560003 Malleshwaram · 560064 Yelahanka |
| Hyderabad | 500081 Gachibowli · 500034 Banjara Hills · 500072 Kukatpally · 500013 Secunderabad |
| Chennai | 600042 Velachery · 600020 Adyar · 600096 OMR · 600040 Anna Nagar |
| Kolkata | 700019 Ballygunge · 700091 Salt Lake · 700156 New Town |
| Pune | 411045 Baner · 411014 Viman Nagar · 411038 Kothrud |
| Tier 2 | Jaipur 302020 · Lucknow 226010 · Ahmedabad 380015 · Indore 452010 · Chandigarh 160017 · Kochi 682024 · Coimbatore 641014 · Nagpur 440010 · Surat 395007 · Bhopal 462016 · Visakhapatnam 530016 · Bhubaneswar 751024 |

That is ~29 metro zones + ~12 tier-2 ≈ **41 pincodes**, which does not fit one sweep — see
*Sizing*. The `cadence` column below is how that is handled.

Because `city` is now a real grouping and not just a label, it earns two things: the popup
picker groups by it, and the dashboard gets an intra-city spread readout — *Blinkit, Mumbai:
₹373–₹402 across 5 zones* — which is the finding this whole exercise exists to surface.

### Tier 2 breaks an assumption: "no price" is not always a failure

Blinkit, Zepto and Instamart do not serve every tier-2 city, and Flipkart Minutes serves
far fewer. Today a missing price becomes `status: 'failed'` with the note *"no price — out
of stock, not serviceable, or blocked"* (`background.js:329`) — three very different things
in one bucket. Add ~15 tier-2 pincodes and the failures table fills with rows that are not
failures, which is how people learn to ignore it.

So Phase 1 also adds a `not_serviceable` status, set when the page says the area is not
served (each QC site has a distinct "we're not here yet" state) as opposed to the product
being absent. Consequences: it is excluded from the failure count and the red badge, shown
as its own dashboard state, and — importantly — excluded from `addParity()`, which already
skips unpriced rows, so an unserved city cannot drag a median.

Worth expecting a genuinely sparse grid: a tier-2 pincode may legitimately have Amazon and
Flipkart readings and nothing else. That is a finding, not a fault.

### Dashboard — a pincode selector, not a third grid dimension

One `<select>` in the toolbar beside `sev`, grouped by city with `<optgroup>` and
defaulting to the pincode with the most rows. Labels read `Mumbai — Bandra W (400050)`, so
~41 entries stay navigable.

The grid stays SKU × channel. A third dimension puts 10 values in each cell of a table
that already needs horizontal scroll with sticky columns; one grid per pincode means 10
sticky headers and 10 `measureBar()` offsets. The selector is a filter over data already
in `ROWS`, and it enforces the rule from `withParity()`: **one screen is one market.**

- stamp `data-pin` in `row()` (:111)
- add `okPin` to **both** `applyFilter()` (:410) and `visibleRows()` (:325) — already
  duplicated predicates, and exports quietly disagree with the screen if only one changes
- add Pincode and City columns to the four header lists in `exportData()` (:351-372)

Plus one new tab, **Spread** — the payoff of sweeping multiple zones per city. Per
SKU × channel × city: min, max, range and the zone at each end.

| SKU | Product | Channel | City | Low | High | Spread | Zones |
|---|---|---|---|---|---|---|---|
| MCaf370 | Coffee Face Wash | blinkit | Mumbai | ₹373 Bandra W | ₹402 Thane | ₹29 (7.8%) | 5 |

Sorted by spread descending, it answers "where is a channel pricing inconsistently inside
one city" — which one pincode per city could never show, and which is the argument for
having done any of this. Cheap to build: it groups `ROWS` the same way the grid does, one
level up.

---

## Phase 2 — actually setting the location

This is the fragile part. Nothing in the codebase does it today.

**No manifest change needed.** `chrome.scripting.executeScript` running in a tab on the
target origin can already write `document.cookie` and `localStorage` for that origin. The
`cookies` permission only buys the worker-side `chrome.cookies` API, which we don't need.

### Per channel group

| group | mechanism | notes |
|---|---|---|
| **amazon** | drive the UI — open a PDP in a background tab, click the glow ingress, type the pincode, Apply | location is server-side against the session, cookies are opaque, so cookie-writing is a dead end. Session-scoped, so it then applies to the plain `fetch` path too |
| **flipkart + fk_mins** | drive the header pincode widget once — one host, one session | fk_mins inherits it but **must be verified separately**: Minutes is often non-serviceable where regular Flipkart is fine |
| **myntra** | don't set it | pricing is national; pincode only gates serviceability. Record once per sweep with pincode `''` |
| **zepto / blinkit / instamart** | write lat/lng state directly, then reload | **these do not take a pincode at all** — they take coordinates and resolve a dark store. Needs a hand-maintained pincode → lat/lng table (10 lines, a calibration knob). Driving the picker's autocomplete is flakier: the first suggestion is not deterministic |

### Verification — replace `store_ok`, don't extend it

Delete the `qc_marker` substring check. It is the weakest available signal and passes on
recommendation tiles elsewhere in the page. Replace with `pincode_ok`, checked twice: once
per (pincode, host) at set time on a canary URL, and once per row from HTML already in hand.

Strongest signal per channel: **amazon** — the six digits echoed in the glow ingress.
**flipkart/fk_mins** — pincode echoed in the delivery widget plus a non-empty ETA.
**zepto/instamart** — the resolved store id in page state, not the locality string.
**blinkit** — we already have the best signal and throw it away: `parse.js:67` notes
JSON-LD `price: 0` means no dark store resolved, and it currently becomes a null price and
a `status: 'failed'`. Invert it: zero is not a missing price, it is an unverified location.

**Hard rule: `pincode_ok === false` → do not store a price.** A wrong-store price looks
exactly like a right one, which is the whole reason this phase is risky.

While in `rules.json`: the `availability` pattern (:60) is read by nothing since the Python
scraper was retired. Either wire it up as a stock signal or delete it.

### Sweep ordering — a barrier, not a change to the pacing loop

Add a location phase before `sweepAll()`: set + verify on the relevant hosts sequentially
(~1 min), then run the existing `interleave()` queue **completely unchanged**. Location is
per-host session state, so it holds for the whole pincode pass — `MIN_GAP_MS` and the
host interleaving keep working as they do now. Per-row `pincode_ok` catches mid-pass drift;
on a miss, re-run the barrier for that host once and continue.

---

## Phase 3 — expand only where the data justifies it

Phase 1 records the pincode on every reading; Phase 2 only *varies* it for quick commerce.
After a week, one query answers whether the other channels need it at all:

```sql
SELECT sku, channel, COUNT(DISTINCT price) AS distinct_prices, COUNT(DISTINCT pincode) AS pins
FROM Price_Parity_Data
WHERE read_ts >= CURDATE() - INTERVAL 7 DAY
GROUP BY sku, channel HAVING pins > 1 ORDER BY distinct_prices DESC;
```

If amazon/flipkart/myntra show one distinct price across every pincode, they stay national
and the sweep stays small. Expand only what the data says varies.

---

## Sizing

Measured baseline: `sweepAll` awaits each row, so time is the **sum** — interleaving buys
politeness, not parallelism. ~3.5 s/row average today (~300 rows in 15–20 min); tab-loaded
QC rows are nearer 8 s, fetch rows nearer 2 s.

At ~65 targets with quick commerce varying (QC was 41% of the old 314):

| | |
|---|---|
| non-QC, once per sweep | ~38 rows ≈ 1.5 min |
| **per pincode** | ~27 QC rows ≈ 3.5 min + ~1 min location barrier ≈ **4.5 min** |
| 7 pincodes | ≈ 33 min — fits a 2 h interval |
| 19 pincodes | ≈ 87 min — the 2 h ceiling |
| 29 pincodes | ≈ 132 min — fits a 3 h interval |
| **41 pincodes** | **≈ 185 min — over even 3 h; the tail rotates** |

Roughly **4.5 minutes per pincode**. Two knobs now decide what fits, and they interact:

**The interval, which widens to 3 hours when 2 is not enough.** `intervalMin` already
offers 180 in the popup (`popup.html`, the `every` select) — nothing new to build there,
but it should stop being a thing you remember to change. After each sweep, compare its
duration against the interval:

- sweep > **80%** of the interval → step 120 → 180, re-arm, and log why
- one-way and manual to reverse — an interval that oscillates is worse than one that is
  slightly too long, and a person should see the reason before narrowing it again

**The budget that follows from it.** Allow ~75% of the interval for sweeping, leaving
headroom for a slow site:

| interval | budget | pincodes per sweep | firings in 08:00–18:00 |
|---|---|---|---|
| 2 h | ~90 min | ~19 | 6 (08, 10, 12, 14, 16, 18) |
| **3 h** | **~135 min** | **~29** | 4 (08, 11, 14, 17) |

At 3 hours, ~29 of the ~41 zones fit in a single sweep — so most of the list is covered
four times a day and only the tail rotates. That is a better shape than a 2-hour interval
that can only manage ~19.

**`cadence` handles whatever exceeds the budget:**

- **`every`** — one anchor zone per metro, ~7–9 pincodes, swept every time. The ones you
  watch intraday.
- **`rotate`** — the rest. A `pincodeCursor` in `chrome.storage.local` advances each firing,
  taking as many as the remaining budget allows. At 3 hours that is ~20 rotating zones per
  sweep, so a full cycle of ~41 lands in **well under a day**.

The popup estimate should name the consequence directly, e.g.
*"33 selected · ~150 min · exceeds the 2 h interval — switch to 3 h"*.

Two related details:

- The overlap guard (`background.js:207`) refuses a sweep if one has been running under
  3 hours. With a 3-hour interval and 2½-hour sweeps that is cutting it fine — raise the
  expiry to 4 h, or the first genuinely long sweep makes the next firing a silent no-op.
- The 08:00–18:00 window gates when a sweep *starts*, not when it finishes, so a 17:00
  firing running until 19:00 is fine and needs no change.

Every row carries its own `read_ts`, so a cycle spanning hours is honest data rather than
stale data — but the dashboard should show reading age per pincode, or a six-hour-old Thane
price gets compared against a fresh Bandra one without anyone noticing.

Tier-2 zones are cheaper than metros in practice: unserved QC channels fail fast rather
than loading a tab for 8 seconds each.

## Risks, honestly

1. **Location silently never took, or reverted.** Highest frequency, highest damage.
   Detected by per-row pincode echo and a per-host `pincode_ok` rate.
2. **Identical prices across all pincodes on a QC channel.** The strongest detector, and
   free: if blinkit returns the same price for all 7, the location never moved no matter
   what verification claimed. Worth a post-sweep invariant check — it catches the case
   where a site changes its storage key and our writes become no-ops.
3. **Bot escalation from the extra traffic.** Detected by `how` flipping to `'tab'` for
   amazon/flipkart, rising `short body` errors, and the red badge.

The quick-commerce group is where this breaks. Direct state writes are more stable than
autocomplete-driving, but they *will* break when any of the three changes a storage key,
and the failure is silent — which is why #2 matters more than the verification itself.

## Two things this changes elsewhere

- **The distribution work becomes optional.** If one machine covers every pincode,
  teammates don't need the extension installed — they read the dashboard or the table.
  `price-parity-extension.zip` and `INSTALL.md` stay useful for anyone who wants a local
  view, but they stop being the rollout path.
- **`bau.json` is now doubly stale** — frozen at 314 targets from 2026-09-09, and the sheet
  has since been cut. It is only the fallback when the Apps Script feed is unreachable on a
  fresh install. Either refresh it once by hand or drop it and rely on sheet + cache.

## Verification

1. `python db/api.py check` — offline; asserts `KEYED` matches `one_read` parsed from
   `schema.sql`, so a half-applied grain change fails loudly here.
2. `python db/api.py preflight` — read-only; re-checks the unique key against
   `information_schema` on the live RDS instance.
3. `python db/api.py deploycheck` — POSTs a probe row carrying a pincode and reads it back.
4. **The collision test, which is the point of Phase 1:** POST two rows with the same
   `sweep_ts`/`reporter`/`sku`/`channel` and *different* pincodes, then confirm **two** rows
   exist. Before this change that returns one.
5. In Chrome: reload the extension, **Sweep now**, watch the service worker console for
   `targets: N from sheet` and the per-pincode barrier logs. Then:
   ```sql
   SELECT pincode, channel, COUNT(*), COUNT(DISTINCT price)
   FROM Price_Parity_Data GROUP BY pincode, channel ORDER BY pincode, channel;
   ```
   Every pincode present, and for QC channels the distinct-price count > 1 across pincodes
   — if it is 1 everywhere, the location never actually moved.
6. Dashboard: the pincode selector switches markets, the Spread tab shows a real
   intra-city range, and `Export` output matches what is on screen (the
   `applyFilter`/`visibleRows` pair).
7. Scheduling: after a few sweeps, check the logged durations against the interval —
   the auto-widen should have stepped to 3 h if any sweep passed 80% of 2 h, and
   `python db/api.py preflight` plus the query in step 5 should show every selected zone
   appearing within one full cycle.

## Prerequisites from you

- A `Pincodes` tab in the sheet — columns `pincode, city, zone, tier, lat, lng, cadence`.
  Use the starter table above, **verify each row against a real deliverable address**, and
  set one anchor zone per metro to `every`.
- That tab must **not** be added to `SKIP` in `apps_script/Code.gs`, and must not be hidden
  — hidden sheets are not returned by the web app.

## Suggested order of work

1. **Phase 1 schema + api.py**, then the collision test. Half an hour, and it fails loudly
   if wrong.
2. **Phase 1 extension + dashboard selector**, sweeping one pincode. Everything is
   pincode-tagged and viewable per market, with location still set by hand — already useful
   on its own.
3. **The `Pincodes` tab and the popup picker**, still one pincode selected.
4. **Phase 2 location setting**, quick commerce first. Prove it on **two zones of one
   metro** — Bandra and Thane — because that is the smallest test that can distinguish
   "location switching works" from "we keep reading the same store", and the
   identical-price check is meaningless until it passes.
5. **Widen to the rest of one metro**, add the Spread tab, and confirm intra-city variance
   is real before investing in the rotation machinery.
6. **Add sweep-duration logging and the auto-widen to 3 h**, then `cadence` + the rotation
   cursor, then widen to the other metros. Duration logging comes first so the interval
   decision is made on a measured number rather than this plan's estimate.
7. **Widen to tier 2**, once `not_serviceable` is distinguishable from failure.
8. **Phase 3** only if the data says the marketplace channels vary by pincode at all.

Stopping after any of these leaves a working system.
