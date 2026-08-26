# Agreed Final Costing → an Actions column that opens the breakup

**Status: implemented 2026-08-26.** Follows on from
`docs/final-costing-analytics-plan.md`, which added the Analytics tab and the
SKU-click expansion this reuses.

Built as planned, including the `selectBomLineDetailByMfg` `filling` fix — so the
Detailed Breakup export's Detail sheet now agrees with its own Summary sheet.

An **Actions** column on the Agreed Final Costing table. Its button expands the
row to show, for that SKU × manufacturer:

- every RM and PM recipe line with its **agreed MRM rate** and the cost that rate
  produces, with **lines carrying no agreed rate called out** rather than shown
  as ₹0;
- the five misc costs (JW, Shrink Wrap, Shipper, RM Wastage %, PM Wastage %),
  with an absent one shown as **not set** — an absent `bom_misc` row and a
  genuine 0% are different states, and only the absent one is a gap.

The row already expands on a SKU click to show the three vendor scenarios. This
reuses that one expansion slot rather than adding a second axis: state becomes
`{ id, panel }`, the SKU click opens `"scenarios"`, the Actions button opens
`"breakup"`, and clicking the other control swaps the panel.

---

## The query already exists — and has a bug

`manufacturingSql.selectBomLineDetailByMfg` (`lib/queries/manufacturing.ts:600`)
already returns exactly what this panel needs: `recipe_id`, `mtrl_type`,
`mtrl_id`, `amount`, `filling`, `mtrl_code`, `mtrl_name`, `mrm_rate`. It is a
strict superset of `selectBomLineInputsByMfg`, which the page runs today —
**except for one column**:

```
selectBomLineInputsByMfg:  COALESCE(NULLIF(sk.filling, 0), NULLIF(ds.filling, 0))   -- SKU_FILLING
selectBomLineDetailByMfg:  sk.filling                                               -- and no details_sku join
```

`filling` is a **multiplicand** in `computeRmCost`, so for a SKU whose fill weight
lives only in `details_sku` the detail query zeroes every RM line. Its one caller
today is the "Detailed Breakup (Negotiation)" export — whose **Summary** sheet
uses `selectMaterialCostByMfg`, which *does* use `SKU_FILLING`. So that workbook
already ships two sheets disagreeing about the same SKU: a real RM cost on
Summary, ₹0 across every RM line on Detail.

Fix it at the query — which fixes the export's Detail sheet and lets one query
serve both callers:

```
  selectBomLineDetailByMfg: `
    SELECT
      mbm.recipe_id, sk.sku_code, sk.name AS sku_name,
      db.mtrl_type, db.mtrl_id, db.amount, ${SKU_FILLING} AS filling,
      ...
    LEFT  JOIN master_skus sk ON sk.id = b.sku_id
    LEFT  JOIN details_sku ds ON ds.sku_id = sk.id
    ...
```

i.e. `sk.filling` → `${SKU_FILLING}`, plus the `details_sku` join the other two
queries already have. Params unchanged (`[mfg_id, mfg_id, mfg_id]`).

**This changes the Detailed Breakup export's Detail sheet** for any SKU whose
fill weight is only in `details_sku` — ₹0 RM lines become real ones. That is the
correction, and it makes the sheet agree with its own Summary.

`selectBomLineInputsByMfg` then has no callers and goes. (The never-delete rule
covers API **routes** — a URL can have callers grep cannot see. A SQL string
exported from `lib/queries/` cannot.)

---

## New file — `app/manufacturing/[mfgId]/costing-breakup.ts`

Pure, so it carries the test. Sits beside `costing-gaps.ts`, which is there for
the same reason.

```ts
/**
 * One SKU's costing, decomposed — what the Actions column opens.
 *
 * The table's RM Cost cell is a SUM; these are the addends. It re-uses the same
 * computeRmCost/computePmCost the aggregate SQL applies, so the lines add up to
 * the row above them — which only holds because selectBomLineDetailByMfg now
 * resolves `filling` the same way selectMaterialCostByMfg does.
 */

import type { MiscCostType } from "@/types/masters"
import { computeRmCost, computePmCost } from "@/lib/costing/final-costing"
import { MISC_LABEL } from "./costing-gaps"

export type BreakupLine = {
  type: "rm" | "pm"
  code: string | null
  name: string | null
  /** RM: a formulation % of fill weight. PM: a per-unit quantity. Not money. */
  amount: number
  /** null = no agreed rate for this manufacturer — NOT a rate of zero. */
  rate: number | null
  cost: number
}

/** A null value = no bom_misc row at all, which is not the same as 0%. */
export type BreakupMisc = { type: MiscCostType; label: string; value: number | null }

export type CostingBreakup = {
  lines: BreakupLine[]
  misc: BreakupMisc[]
  /** Recipe lines with no agreed rate — the "if any one is missing" headline. */
  unpricedLines: number
}

export type BreakupLineInput = {
  mtrl_type: "rm" | "pm"
  amount: string
  filling: string | null
  mtrl_code: string | null
  mtrl_name: string | null
  mrm_rate: string | null
}

export function buildBreakup(
  lines: BreakupLineInput[],
  misc: Partial<Record<MiscCostType, number>>,
): CostingBreakup {
  const built: BreakupLine[] = lines.map((l) => {
    const amount = Number(l.amount)
    const rate = l.mrm_rate == null ? null : Number(l.mrm_rate)
    const filling = Number(l.filling ?? 0)
    return {
      type: l.mtrl_type,
      code: l.mtrl_code,
      name: l.mtrl_name,
      amount,
      rate,
      cost: rate == null ? 0
        : l.mtrl_type === "rm" ? computeRmCost(filling, amount, rate)
        : computePmCost(amount, rate),
    }
  })

  // RM before PM, and inside each: unpriced lines first, then dearest first.
  // Sorting by cost alone buries an unpriced line at the bottom on its ₹0 cost —
  // the one line someone opened this panel to find.
  built.sort((a, b) =>
    a.type === b.type
      ? (a.rate == null ? 0 : 1) - (b.rate == null ? 0 : 1) || b.cost - a.cost
      : a.type === "rm" ? -1 : 1
  )

  return {
    lines: built,
    misc: (Object.keys(MISC_LABEL) as MiscCostType[]).map((type) => ({
      type, label: MISC_LABEL[type], value: misc[type] ?? null,
    })),
    unpricedLines: built.filter((l) => l.rate == null).length,
  }
}
```

`costing-gaps.ts:41` — `const MISC_LABEL` becomes `export const MISC_LABEL`. It is
already these labels, in the order this panel wants them; a second copy is the
same drift `costing-columns.tsx` exists to prevent.

---

## New file — `app/manufacturing/[mfgId]/CostingBreakupPanel.tsx`

Presentational, no state. Its own file so `FinalCostingTable` stays a table
rather than a table plus two nested ones.

```tsx
import type { CostingBreakup } from "./costing-breakup"
import { fmtMoney } from "../mfg-utils"

const NOT_SET = <span className="text-amber-700 dark:text-amber-400">not set</span>

export default function CostingBreakupPanel({ breakup }: { breakup: CostingBreakup }) {
  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div>
        <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Recipe lines at this manufacturer&apos;s agreed rate
          {breakup.unpricedLines > 0 && (
            <span className="ml-2 font-normal normal-case tracking-normal text-amber-700 dark:text-amber-400">
              {breakup.unpricedLines} line{breakup.unpricedLines === 1 ? "" : "s"} with no agreed rate
            </span>
          )}
        </h4>
        {/* A plain table, not the shared primitives: this is nested inside a
            table cell and must not inherit the outer table's fixed layout. */}
        <table className="w-full">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="w-10 text-left font-medium">Type</th>
              <th className="text-left font-medium">Code</th>
              <th className="text-left font-medium">Material</th>
              <th className="w-16 text-right font-medium">Qty</th>
              <th className="w-20 text-right font-medium">Rate</th>
              <th className="w-20 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {breakup.lines.length === 0 ? (
              <tr><td colSpan={6} className="py-1 text-muted-foreground">This recipe has no active lines.</td></tr>
            ) : breakup.lines.map((l, i) => (
              <tr key={`${l.type}-${l.code}-${i}`} className="border-t border-border/50">
                <td className="py-0.5 uppercase text-muted-foreground">{l.type}</td>
                <td className="font-mono">{l.code ?? "—"}</td>
                <td className="max-w-48 truncate text-muted-foreground" title={l.name ?? undefined}>{l.name ?? "—"}</td>
                <td className="text-right tabular-nums text-muted-foreground">{l.amount}</td>
                <td className="text-right tabular-nums">{l.rate == null ? NOT_SET : fmtMoney(l.rate)}</td>
                <td className="text-right tabular-nums font-medium">{fmtMoney(l.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Misc. costs
        </h4>
        <table className="w-full">
          <tbody>
            {breakup.misc.map((m) => (
              <tr key={m.type} className="border-t border-border/50">
                <td className="py-0.5 text-muted-foreground">{m.label}</td>
                <td className="text-right tabular-nums">
                  {/* Wastage is a percentage; the other three are money. It goes
                      through wastageFraction because the stored value is in one
                      of two units — same rule the costing applies. */}
                  {m.value == null ? NOT_SET
                    : m.type === "rm_loss" || m.type === "pm_loss"
                      ? `${(wastageFraction(m.value) * 100).toFixed(2)}%`
                    : fmtMoney(m.value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
```

`Qty` is deliberately raw, not money: an RM line's `amount` is a formulation
percentage and a PM line's is a unit count.

---

## `costing-columns.tsx` — the Actions head, opt-in

The three Analytics tables share `HEADS` and have no per-row control, so Actions
is a flag rather than a 13th entry — otherwise all three grow a dead column.

```tsx
const W = {
  ...
  delta:   "w-[116px]",
  actions: "w-[84px]",
} as const

/** `actions` adds the trailing Actions column — Agreed Final Costing only; the
 *  Analytics comparison tables have no per-row control and would render it empty. */
export function CostingHeadRow({ actions = false }: { actions?: boolean } = {}) {
  const heads = actions
    ? [...HEADS, { label: "Actions", width: W.actions, numeric: false }]
    : HEADS
  return (
    <TableRow>
      {heads.map((h) => (
        <TableHead key={h.label} className={`${h.width} ${h.numeric ? "text-right" : ""}`}>
          {h.label}
        </TableHead>
      ))}
    </TableRow>
  )
}
```

`COSTING_COL_COUNT` stays 12 — what the Analytics tables' `TableEmpty` spans.
`FinalCostingTable` spans `COSTING_COL_COUNT + 1`.

---

## `FinalCostingTable.tsx`

- `<CostingHeadRow actions />`.
- State becomes the panel, not just the id:

```tsx
type Panel = "scenarios" | "breakup"
const [open, setOpen] = useState<{ id: number; panel: Panel } | null>(null)

function show(id: number, panel: Panel) {
  setOpen(open?.id === id && open.panel === panel ? null : { id, panel })
}
```

- `isOpen` → `const shown = open?.id === r.recipe_id ? open.panel : null`. The SKU
  button and the name cell call `show(r.recipe_id, "scenarios")`; the chevron and
  `aria-expanded` key on `shown === "scenarios"`.
- New last cell on the costing row:

```tsx
<TableCell>
  <Button
    variant="outline"
    size="xs"
    onClick={() => show(r.recipe_id, "breakup")}
    aria-expanded={shown === "breakup"}
    title="RM / PM lines with their agreed rates, and this SKU's misc costs"
  >
    Breakup
  </Button>
</TableCell>
```

- The scenario rows gain a trailing empty `<TableCell />` (2 + 7 + 3 + 1 = 13).
- The breakup row:

```tsx
{shown === "breakup" && (
  <TableRow className="bg-muted/40 hover:bg-muted/40">
    <TableCell colSpan={COSTING_COL_COUNT + 1} className="px-3 py-2">
      <CostingBreakupPanel breakup={breakups[i]} />
    </TableCell>
  </TableRow>
)}
```

- New prop, index-aligned with `rows` exactly as `scenarios` already is:
  `breakups: CostingBreakup[]`.
- `TableEmpty`'s `colSpan` and `ScenarioLabelRow`'s move to
  `COSTING_COL_COUNT + 1`, or the empty state and the label row stop spanning the
  full width.

---

## `page.tsx`

- `RecipeLineInputRow` gains `mtrl_code` / `mtrl_name` / `mrm_rate`; the query
  swaps to `selectBomLineDetailByMfg` with `[mfgId, mfgId, mfgId]`.
  `buildComparisonRows` is untouched — it reads `mtrl_type` / `mtrl_id` /
  `amount` / `filling`, all still there.
- After `scenarios`:

```tsx
  const breakups = rows.map((r) =>
    buildBreakup(linesByBom.get(r.recipe_id) ?? [], miscByBom.get(r.recipe_id) ?? {})
  )
```

- `<FinalCostingTable mfgId={mfgId} rows={rows} scenarios={scenarios} breakups={breakups} />`

No new query, no new route, no DB change, no new dependency — the columns this
panel needs are already being fetched by the export.

---

## Checks

`tests/unit/costing-columns.test.ts` — extend: the `actions` flag must add exactly
one head, so the scenario row's trailing cell keeps the count at
`COSTING_COL_COUNT + 1`.

`tests/unit/costing-breakup.test.ts` — new, pure:

- a null `mrm_rate` gives `rate: null` and `cost: 0` and counts toward
  `unpricedLines` — **not** a zero rate silently costed;
- a null `filling` zeroes an RM line's cost but not a PM line's (the multiplicand
  rule);
- ordering: RM before PM, unpriced first inside each, then dearest first;
- `misc` always returns all five types, and a type with no row is `null` while a
  genuine `0` stays `0`.

## Deferred

- No drill-through from a "not set" line to the rate master. The `!` badge's
  tooltip already names the gap; add links when someone asks to jump there.
- The panel shows the agreed MRM rate only, not each vendor's rate per line —
  that is the Analytics tab's detailed export. Add columns here if people start
  downloading the workbook to read one SKU.
