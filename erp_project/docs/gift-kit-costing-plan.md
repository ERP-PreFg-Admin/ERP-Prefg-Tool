# Gift Kit Costing — Plan

> **Status (2026-09-25): Phases 1–6 built and verified. Phase 0 is outstanding and
> is not an engineering task** — until the component data is filled in, MFG-003-ARO's
> three kits correctly report `0 of 4 components have no costed recipe` and
> `MCFGKIT0087F0007_S` reports 6 of 7. The code is right; the masters are thin.

> **Related docs:** [Masters Module](./masters-module.md) · [API Information Flow](./api-information-flow.md) · [API — Manufacturing](./api/manufacturing.md)

## Context

A gift kit currently costs **wrong, not merely incomplete**, on Agreed Final Costing.

`details_recipe.mtrl_type` carries `'sku'` for a kit's component FGs, and three places
drop those lines:

| Where | Effect |
|---|---|
| `selectMaterialCostByMfg` (`lib/queries/manufacturing.ts:120`) | `CASE WHEN mtrl_type='rm' … ELSE 0` — components contribute **0** to `rm_cost` |
| `selectBomLineDetailByMfg` (`:712`) | `AND db.mtrl_type IN ('rm','pm')` — the breakup panel and Detailed Breakup export get **no lines** |
| `rateGapReasons` (`app/manufacturing/[mfgId]/costing-gaps.ts:25`) | its RM branch is gated on `rm_line_count > 0`, which is **0** for a kit |

The third is why this reads as a wrong number rather than a missing one: the kit shows
**RM ₹0 with no gap reason**, indistinguishable from a SKU whose RM genuinely is zero.
The kit's own PM — the box, the sleeve — costs correctly, so the row looks finished.

`isKitSku` is used by the recipe wizard, the detail panel and the recipe route. It is
imported **nowhere** under `lib/costing/` or `app/manufacturing/`. The costing layer has
no concept of a kit.

Intended outcome: a kit's RM column carries the rolled-up cost of its constituent FGs,
and says so honestly when it cannot.

---

## Decisions taken

| # | Decision |
|---|---|
| 1 | The component rolls up at its **full final cost** — `computeTotalCosting`, i.e. RM + PM + wastage + JW/shrink/shipper/utility/margin. The assembler receives a finished good |
| 2 | **And the component's own missing costs raise an alert on the kit** — a component costed off an incomplete recipe must not look settled |
| 3 | Components are priced at **their own manufacturer**, not the kit's |
| 4 | A kit with an uncostable component shows a **partial cost plus a named gap**, never a silent partial |
| 5 | **`rm_loss` does not apply to a gift kit at all; `pm_loss` does.** A kit has no raw material to lose. Its box and sleeve can still be damaged, so PM wastage stays |
| 6 | **Cost types become a declared registry**, not flags spread across modules — so the next shape with its own applicability rules is a table entry, not another `if` |
| 7 | A component made at **several** manufacturers is priced at the **kit's own manufacturer** when it is one of them — see the tie-break section below |

**Governing constraint: the data, not the code.** Of the **25 component lines** across the
6 kits on prod, **13 cannot be costed at all today** — 12 have a recipe but no active
`master_recipe_mfg` line, and `15SMCaf41_N1` has no recipe whatsoever. Shipping the
roll-up without closing that gap replaces "₹0, obviously wrong" with "about half the real
number, looks plausible" — a worse failure. Decision 4 is what keeps that honest, and
**Phase 0 is the critical path.**

---

## Tie-break: a component made at more than one manufacturer

**Decision 7: prefer the kit's own manufacturer.** When a component has several active
`master_recipe_mfg` lines and one of them is the manufacturer assembling the kit, use that
one. The assembler's own cost for a thing it also makes beats an outside quote.

This refines decision 3 rather than contradicting it — "the component's own manufacturer"
is still the rule; this says which one when there are several.

**Currently unreachable, and worth knowing why.** Exactly one component has more than one
manufacturer — `Mcaf396_WB`, with active lines at **MFG-002-ARC** and **MFG-014-REV** —
and it belongs to kit recipe **170**, the one kit with no manufacturer line at all (see
Phase 0). So today **zero live component lines are ambiguous**. The rule resolves 170 the
moment it is assigned, provided it is assigned to ARC or REV.

**The sub-case it does not cover:** a component at two manufacturers, *neither* of which
is the kit's. Proposed, and **flagged as an assumption rather than a decision**: take the
cheapest, and raise a named gap saying the cost was picked from an ambiguous set — so
nobody negotiates off an arbitrary pick without being told. Consistent with decision 4
(never a silent partial). Overrule if procurement would rather it read as uncosted.

---

## Phases and gates

### Phase 0 — Close the data gap · GATE, and the real critical path

Not an engineering task. Someone has to decide, per component, whether it should be
costable:

1. **12 lines: recipe exists, no active `master_recipe_mfg` line.** Either add the line
   at the manufacturer that actually makes it, or confirm the component is bought-in and
   will never have one.
2. **1 line: `15SMCaf41_N1` has no recipe at all.**
3. **Kit recipe 170 (`MCFGKIT086F0002_S`, "Floral-Fresh & Luxe Body Care Duo") has no
   manufacturer line.** It is the only kit of the six with none, so it appears on no
   manufacturer's costing screen at all — invisible rather than mis-costed, and a
   different bug from the one reported. Assigning it also decides the decision-7
   tie-break for `Mcaf396_WB`, whose two lines are ARC and REV.

**Exit:** each of the 25 component lines is either costable or explicitly marked
never-costable, with a reason; and every kit has a manufacturer.
**Owner: costing + merchandising.** Engineering can proceed to Phase 1 in parallel; it
cannot *ship* Phases 3-5 without this, because until then every kit renders as a gap.

---

### Phase 1 — The cost-type registry · a behaviour-neutral refactor, done first  ✅ DONE

Today, what the system knows about one cost type is spread across **six** declarations
that must agree:

| Where | Declares |
|---|---|
| `MISC_LABEL` (`costing-gaps.ts:40`) | label, and the breakup panel's display order |
| `OPTIONAL_MISC` (`:62`) | absence is not a gap |
| `MISC_ABSOLUTE` (`final-costing.ts:40`) | absolute money vs percentage |
| `ZERO_MISC` (`:50`) | the all-zero starting literal |
| `computeTotalCosting` (`:62`) | hardcoded named parameters |
| `isIncompleteCosting` (`:111`) | which types must be present |

`ZERO_MISC`'s own comment records the failure this causes — *"two callers kept their own
copy of this literal, so adding a cost type meant finding both. A missed one reads as a
genuine zero."* Decision 5 would add a **seventh** axis (applicability by recipe shape),
and `OPTIONAL_MISC` cannot express it: for a kit, `rm_loss` is not optional, it is
**inapplicable** — a third state the two existing booleans have no room for.

So: one declaration per cost type, everything else derived from it.

```ts
// lib/costing/cost-types.ts — sketch, not final
{
  rm_loss: {
    label: "RM Wastage %",
    basis: "percent_of_rm",          // replaces MISC_ABSOLUTE
    appliesTo: ["formulation"],      // NEW — decision 5, and the reason for this phase
    required: true,                  // replaces OPTIONAL_MISC
  },
  pm_loss: { label: "PM Wastage %", basis: "percent_of_pm", appliesTo: ["formulation", "kit"], required: true },
  margin:  { label: "Margin",       basis: "absolute",      appliesTo: ["formulation", "kit"], required: false },
  // …
}
```

`MISC_LABEL`, `OPTIONAL_MISC`, `MISC_ABSOLUTE` and `ZERO_MISC` all become derivations of
this table. A new cost type is then one entry, and a new *recipe shape* is one more value
in `appliesTo`.

**A declarative table, not a class hierarchy.** Seven numeric cost types do not each need
a class; the registry is doing the factory's job — a lookup returning the right strategy
for a type — without seven files to open when someone asks what Shipper is.

> ⚠️ **Do not lose `computeTotalCosting`'s compile-time safety.** Its comment is explicit:
> every field is required so that *"a new cost type added here must break every call site
> until it is passed through, because the failure mode of the alternative is silent"*.
> A registry-driven sum over a `Partial<Record<…>>` would reintroduce exactly that silent
> zero. Keep the input an exhaustive `Record<MiscCostType, number>` derived from the
> registry keys, so a missing key is still a compile error at all five call sites.

**Exit:** every existing costing number is **byte-identical**, `npm test` green with no
test changes. Nothing about kits is built in this phase — that is the point. It lands on
its own so a regression here is unambiguous.

---

### Phase 2 — A component-cost resolver  ✅ DONE

The shape problem: `agreedRatesByMfg(mfgId, …)` answers *"every SKU for ONE
manufacturer"*. A kit needs *"these specific SKUs, each at a DIFFERENT manufacturer"*.

Resolve, for every `(component sku, its own mfg)` pair reachable from this manufacturer's
kits, the same `AgreedRate` the component's own Final Costing row would show. One query
over the needed pairs — **not** a call to `agreedRatesByMfg` per component mfg, which
fans out per kit.

Decision 7 lives here: the resolver picks **one** manufacturer per component —
the kit's own if it is among the component's active lines, otherwise the component's
single line, otherwise the ambiguous-set fallback. Resolving it in the query keeps every
consumer from having to know the rule.

**Exit:** given a manufacturer, a `Map<sku_code, AgreedRate>` of its kits' components,
priced at one resolved manufacturer each, honouring `asOf` and brand scope exactly as the
existing path does. A unit test pins the tie-break, since today's data cannot exercise it.

---

### Phase 3 — Make the costing layer kit-aware  ✅ DONE

`AgreedRate.rate` is already `computeTotalCosting(...)` — the full final cost from
decision 1. The roll-up is therefore a sum of component `rate × units`, where `units` is
the `'sku'` line's `amount` (a unit count — see `KIT_LINE_UOM`).

Two changes of substance:

- **`AgreedRate` must carry the component's gaps, not just its rate.** Today it carries
  the four `CostingGapInput` fields but not the misc record, so `missingMiscReasons`
  cannot run on a component. Decision 2 needs both.
- **`lib/costing/final-costing.ts` stays pure and gains the roll-up**, so it is unit
  testable without a DB — the same reason `computeTotalCosting` lives there.

**Exit:** a kit's RM figure is the rolled-up component cost; a non-kit SKU's number is
byte-identical to today. That second half is the regression risk and is what the tests
pin.

---

### Phase 4 — Gaps and alerts  ✅ DONE

Extend `rateGapReasons` (or add a kit sibling beside it in `costing-gaps.ts`) so one
vocabulary still serves every screen — the reason that file exists. New reasons:

- `N of M components have no costed recipe` — decision 4
- `Component <sku_code> is costed from an incomplete recipe: <its own reasons>` — decision 2,
  the component's own `rateGapReasons` + `missingMiscReasons`, attributed to the component

Also fix the silent-zero: a kit with `rm_line_count = 0` must never reach the UI with no
reason attached.

**Exit:** every one of today's 6 kits displays either a complete cost or a specific,
actionable reason. **GATE — show the screen before wiring the export.**

---

### Phase 5 — The three surfaces  ✅ DONE

In dependency order, all reading Phase 3's output so they cannot disagree:

1. **Agreed Final Costing table** (`FinalCostingTable.tsx`, `[mfgId]/page.tsx`)
2. **The per-SKU breakup panel** — component lines need to render as lines, which means
   relaxing `selectBomLineDetailByMfg`'s `IN ('rm','pm')` **without** reintroducing the
   collision its comment warns about: a `'sku'` `mtrl_id` is a `master_skus.id`, and
   today's consumers branch `rm ? rmCost : pmCost`, so a component would take the PM
   branch and be priced at an unrelated PM's rate. Every consumer must learn the third
   type in the same commit, or the filter stays and components come from Phase 2 instead.
3. **Detailed Breakup export** — both sheets

---

### Phase 6 — Tests  ✅ DONE

`tests/unit/` for the pure roll-up: a kit with all components costed, with some
uncosted, with a component priced at another manufacturer, and the zero-component case.
`tests/db/` under `withRollback()` for the resolver query, following
`tests/db/costing-as-of.test.ts`.

**Pin the regression explicitly:** a non-kit SKU's costing is unchanged. That is the one
thing this work can break for everyone.

---

## Risk register

| Risk | Mitigation |
|---|---|
| **Half-costed kits read as settled** | Decision 4 + Phase 4. Phase 0 is what actually removes it |
| **Relaxing the `IN ('rm','pm')` filter reprices real materials.** A component's `master_skus.id` collides with an unrelated `master_pm.id` inside a SUM, silently | Phase 5.2: either teach all three consumers the third type in one commit, or never relax the filter and feed components from Phase 2. The comment at `:680` is the specification |
| **Non-kit costing regresses** | Phase 3 exit criterion + a dedicated test. Every kit path is additive |
| **`asOf` drift.** Component costs must move with the date exactly as the kit's do | Phase 2 honours `asOf` through the same `history_cost_mfg` path; a test at a past date |
| **Brand scope.** Components are often a different brand from the kit; the recipe route already asserts per-component brand scope on write | Decide on read: a scoped user seeing a kit but not its components should get a gap reason, not a wrong number. Resolve in Phase 2 |
| **Fan-out cost.** A manufacturer with many kits could trigger many component lookups | One query over distinct pairs, not per kit. Phase 2 exit |
| **Nested kits** | Already refused at `app/api/v1/masters/recipe-master/route.ts:205` (`nested_kit`). One level only — no cycle guard needed. Do not remove that check |
| **The registry refactor moves a number.** It touches the formula every price in the app runs through — PO quote-rate, the invoice drilldown, two exports | Phase 1 ships alone, behaviour-neutral, with **no test changes**. If a test needs editing, the refactor changed behaviour and is wrong |
| **The registry re-opens the silent-zero hole.** Deriving the sum from a table invites a `Partial` lookup, which is exactly what `computeTotalCosting`'s comment was written to prevent | Exhaustive `Record<MiscCostType, number>` derived from the registry keys. A missing key stays a compile error, not a quiet 0 |
| **`appliesTo` is read as "hide it" rather than "it does not exist here".** A kit showing `RM Wastage: 0%` is a claim, not a blank | Inapplicable types must be absent from the breakup list and out of the required-set — never rendered as a zero |
| **The tie-break ships untested against real data.** No live component has two manufacturers, so a wrong implementation looks fine until kit 170 is assigned | A unit test on the resolver covering all three branches — kit's mfg present, single line, neither. Cheap, and the only thing standing in for production data |
| **An unassigned kit is invisible, not flagged.** Recipe 170 has no `master_recipe_mfg` line, so it is on no costing screen at all and nothing reports it | Out of scope for the costing change — it is a masters data gap (Phase 0 item 3). Worth a separate check that lists recipes with no manufacturer line, rather than assuming someone notices |

---

## Critical files

**Read first:** `lib/queries/manufacturing.ts` (the two sibling queries and their
comments at `:103` and `:680` — they are the specification) · `lib/costing/agreed-rates.ts` ·
`lib/costing/final-costing.ts` · `lib/masters/kit-sku.ts` ·
`app/manufacturing/[mfgId]/costing-gaps.ts`

**New:** `lib/costing/cost-types.ts` — the registry, and from Phase 1 the only place a
cost type is declared.

**Change:** `lib/costing/final-costing.ts` (`MISC_ABSOLUTE` + `ZERO_MISC` become
derivations; `computeWastage` reads `basis`; pure roll-up added in Phase 3) ·
`app/manufacturing/[mfgId]/costing-gaps.ts` (`MISC_LABEL` + `OPTIONAL_MISC` become
derivations; kit gap reasons added in Phase 4) · `lib/queries/manufacturing.ts` (new
resolver) · `lib/costing/agreed-rates.ts` (carry misc + gaps) ·
`app/manufacturing/[mfgId]/{page.tsx,FinalCostingTable.tsx}` · the breakup panel ·
`app/api/v1/manufacturing/[mfgId]/final-costing/{export,detailed-export}` ·
`tests/unit/` + `tests/db/`

**Do not change:** the `nested_kit` guard · `isKitSku`'s two-column definition

---

## Verification

- **Phase 1 alone:** `npm test` green **with no test file modified**. That is the whole
  acceptance test for the refactor — an edited assertion means behaviour moved
- `npm test` green, including the new pure roll-up tests and the non-kit regression pin
- `npm run test:db` for the resolver, rollback-wrapped
- `npx tsc --noEmit --incremental false` and `npm run lint:changed` clean
- Against prod data, by hand: **MFG-014-REV** is the useful case — kit
  `MCFGKIT0087F0007_S` has 7 components spanning MFG-014-REV, MFG-008-VED and
  MFG-005-NGE, plus one with no recipe. It exercises same-mfg, cross-mfg and
  uncostable in a single row
- Confirm a non-kit SKU on the same screen shows exactly the number it shows today
