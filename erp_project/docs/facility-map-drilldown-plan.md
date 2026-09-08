# Facility-wise SKU mapping — plan

**Screen:** `/po-tracking/mfg-overview` → “SKU × Facility Mapping”
**Ask:** the matrix already drills down per **cell** (one manufacturer × one facility).
Add the **column** drilldown: click a facility header, get every manufacturer set up at
that facility, and map SKUs for several of them without closing the panel.

Today: “set up this manufacturer everywhere” is one click per facility.
Missing: “set up this facility for everyone” — the shape of *a new warehouse went live*.

---

## The way

**Nothing new on the server.** Every number the facility panel needs is already on the
page: `mfgFacilityMap.matrix` returns the full mfg × facility cross-product, `allLiveLines`
every (mfg, SKU) pair, `allMappings` every active mapping. `MfgFacilityMatrix` already
indexes all three (`rows`, `linesByMfg`, `mappingsByCell`). The facility panel is a second
reader of the same client-side maps — a different slice, not a different query.

**Nothing new on the write path either.** `POST /api/v1/manufacturing/facility-map` is
keyed on `(mfg_id, wh_id)` and is append-only. Saving a facility panel = one `set-map` POST
per manufacturer group that has additions, sent sequentially. That keeps every guard the
single-cell path has — mfg scope, warehouse scope, brand scope on the submitted SKU codes,
the `vendor_code_missing` 409, the append-only filter, the Uniware push ordered last — with
no second implementation to keep in step.

So the whole change is frontend plus one pure helper.

### Sequencing

| Phase | What | Gate before moving on |
|---|---|---|
| **0** | Extract the SKU tick-list rows out of `MfgFacilityMapPanel` into `SkuTickList.tsx`. Pure presentation + tick callback; no behaviour change. | Cell panel still behaves identically — tick, lock, “Not in Uniware” badge, filter, search. |
| **1** | `facilityGroups()` in `mapping-state.ts` — pure. One facility’s cells → per-manufacturer groups with `state`, `total`, `mapped`, `hasCode`. | New cases in `tests/unit/mfg-facility-map.test.ts` pass. |
| **2** | `FacilityMapPanel.tsx` — the column drilldown. Collapsible manufacturer groups over `SkuTickList`, one tick set spanning all groups, footer says “Map N SKUs across M manufacturers”. Save = sequential POSTs, per-group result. | Map into two manufacturers in one save; matrix refresh shows both cells move. |
| **3** | Facility column header becomes a button; `selected` becomes a union so cell and facility panels never both open. | Cell click and header click both work; column highlight unchanged. |
| **4** *(optional, decide later)* | “Register all” — one `set-vendor-code` POST per unregistered manufacturer at this facility. | — |

Phases 0–1 are reversible refactors. Phase 2 is where the new surface appears. Phase 3 is
three lines. Nothing ships half-wired: the header stays inert until Phase 2 is verified.

---

## Governance

- **No approval flow**, matching the cell path and its parent (`master_recipe_mfg`) — see the
  header comment on `app/api/v1/manufacturing/facility-map/route.ts`. Audit stays
  `activity_log` + `created_by`/`updated_by`, and a facility save now writes **one
  `activity_log` row per manufacturer**, which is the truthful record of what happened.
- **`canEdit`** is the same `access === "editor"` the cell panel gets. Read-only users can
  open the facility panel and see coverage; the checkboxes and Save are disabled.
- **Append-only holds.** Already-mapped SKUs stay locked in every group — Unicommerce has no
  un-map, and the facility panel must not become the door that forgets that.

## Risks, and what each costs

| Risk | Call |
|---|---|
| **Fan-out is slow.** Each POST ends with `pushFacilityMap`, one HTTP call to Unicommerce per SKU. Ten manufacturers × twenty SKUs is minutes. | Send sequentially with per-group progress in the panel, and only for groups with additions. Partial success is reported, not rolled back — the local rows are committed per group and unpushed ones are what Retry exists for. A batch server action is **skipped** until this is measurably too slow. |
| **A group fails mid-fan-out** (409 no vendor code, brand scope, network). | Keep going, collect per-group outcomes, one summary toast: “3 manufacturers mapped · 1 needs a vendor code”. Failing the whole save would discard work that already committed. |
| **Two panels, one truth.** Coverage arithmetic drifting between cell and facility view. | `facilityGroups()` calls the existing `cellState()`; neither panel computes state itself. That is also why Phase 1 is pure and tested rather than a `useMemo`. |
| **Wide panel.** Manufacturers × SKUs in one scroll is long. | Groups start **collapsed**, showing `name · mapped/total · state badge`. Expand to tick. Unregistered manufacturers collapse to a row with a Register button, not a SKU list. |
| **Search interaction.** The matrix search filters manufacturer rows. | The facility panel ignores it and carries its own search box, like the cell panel. A panel that silently hid manufacturers because of a box behind it is worse than one that shows all of them. |

## Out of scope

- Multi-facility targets in the cell panel (“map this manufacturer at 5 sites at once”) — the
  other reading of the ask, not this one.
- Unmapping, anywhere.
- Any change to the matrix grid itself, its colours, or the pills.

---

## Code shape (after the above, not before it)

```
app/po-tracking/mfg-overview/
  MfgFacilityMatrix.tsx      ← selected: union; facility header → button        (edit)
  MfgFacilityMapPanel.tsx    ← SKU rows lifted out                             (edit)
  SkuTickList.tsx            ← the tick rows, shared by both panels            (new)
  FacilityMapPanel.tsx       ← the column drilldown                            (new)
  mapping-state.ts           ← + facilityGroups()                              (edit)
tests/unit/mfg-facility-map.test.ts                                            (edit)
```

`facilityGroups(cells, linesByMfg, mappingsByCell)` → one row per manufacturer at the
facility: `{ mfg_id, mfg_name, mfg_code, hasCode, total, mapped, state, skus }`, ordered
attention-first (unmapped → partial → mapped → unavailable, then name) so the work is at
the top of a long panel.

Unchanged: `lib/queries/mfg-facility-map.ts`, `app/api/v1/manufacturing/facility-map/route.ts`,
`lib/mfg-facility-push.ts`, `types/masters.ts`, the schema.
