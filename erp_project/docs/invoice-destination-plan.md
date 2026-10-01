# Cheryl invoice parse + destination resolution — plan

## Context
Uploading Cheryl invoice `1752.pdf` (log: `source: local:cheryl`, 2026-09-30 12:59:58) shows "—" for both address boxes, and the Destination dropdown lands on the first Mother Warehouse. Three causes:

1. `lib/invoice/local/cheryl.ts:84,90,94,95` hard-code `destination`, `bill_to_address`, `ship_to_address` and `purchase_order` to `null`. The text is in the PDF: bill-to is lines 2–5 (`…MUMBAI - 400072`), ship-to is lines 11–14 (`…BHIWANDI - 421302`), and line 31 is `NAVI MUMBAI to BHIWANDI MCAFF/26-27/0370`.
2. `SKU_LINE` (`cheryl.ts:18`) reads `SKU CODE: HYPMUBX0046F0030` as the SKU **`CODE`**. None of the money checks can catch this.
3. `matchWarehouse` (`lib/invoice/invoice-mapping.ts:165`) finds no PIN and no label, so it falls back to `options.find(type === "MWH")`. Commit then resolves the Uniware facility from that wrong site (`invoice-inward.ts:314`).

Goal: Cheryl reads its addresses, PO and SKU, and the destination is decided from GSTIN, PIN and the warehouse master's own addresses. It is never guessed.

## Master data (read on dev + prod, identical)
`details_warehouse_entity` has `ship_to_pincode` on every live site and `ship_to_gstin` on most. Two facts shape the design:

- **GSTIN is per (entity, state), not per site.** `27AAICP2804J1ZC` (Pep, Maharashtra) sits on both **Mumbai** and **Nagpur**. GSTIN alone can only narrow the choice; PIN decides the site.
- **Several Kreative rows carry Pep's GSTIN** as `ship_to_gstin` (Ahmedabad, Bangalore, Guwahati, Hyderabad, Kolkata, Nagpur). A GSTIN match must therefore select sites, not entity rows. That is fine because `destination` stores only `w.name`.
- **Cheryl's case resolves cleanly.** Ship GSTIN `27AAJCK9697F1ZS` matches only Mumbai·KREATIVE, and PIN `421302` matches only Mumbai. Both signals agree.
- Gaps to fix on `/masters/warehouses`, outside this code change: Chennai (both entities), Bangalore·PEP and Lucknow (both) have no `ship_to_gstin`.

## Sequencing
Each step is gated on `npm test` passing before the next one starts.

### Step 1 — Parser: `lib/invoice/local/cheryl.ts`
- Add a `partyAddress(label)` helper that reuses `partyName`'s upward walk. It takes the lines **after the name line and before the label**, joined with `", "`. Result: bill-to = lines 2–5, ship-to = lines 11–14.
- Add a **`ship_to_gstin`** field, read from the Consignee block with the existing `afterLabel(/^Consignee…/, GSTIN)` call.
- Read `destination` and `purchase_order` from the dispatch line using `/\bto\s+([A-Z][A-Z ]+?)\s+([A-Z]+\/[\dA-Z-]+\/\d+)\b/`. That gives `BHIWANDI` and `MCAFF/26-27/0370`.
- Change `SKU_LINE` to `/SKU(?:\s*CODE)?\s*:?-?\s*([A-Z0-9]+)/i`, which covers both the `SKU:-` and `SKU CODE:` spellings.

### Step 2 — Types and plumbing for `ship_to_gstin`
- `types/invoice.ts`: add `ship_to_gstin: string | null` next to `ship_to_address`.
- `lib/invoice/local/header.ts`: `block()` already returns `gstin` for ship-to, so pass it through as `ship_to_gstin: shipTo.gstin`.
- `lib/invoice/local/jainam.ts`: set `ship_to_gstin` from its second GSTIN line (`gstinLines[1]`), or `null`.
- `lib/nanonets/schema.ts` + `client.ts` `normalizeParsedInvoice`: add `ship_to_gstin` ("GSTIN printed inside the Consignee (Ship to) block"). This changes the metered extraction payload. Nanonets accepts new schema keys, but prove it once on one invoice before relying on it.

### Step 3 — Warehouse options carry the master's address and GSTIN
- `lib/queries/purchase-orders.ts` `warehouseOptions`: also select `dwe.ship_to_gstin, dwe.ship_to_address, dwe.ship_to_line1, dwe.ship_to_line2, dwe.ship_to_city`.
- `app/po-tracking/po-procurement/po-types.ts` `WarehouseOption`: add the same five fields as `string | null`.

### Step 4 — Destination resolution: `lib/invoice/invoice-mapping.ts`
Replace the body of `matchWarehouse` with a ladder that works on **sites** (grouped by `name`). Each rung returns a site only when the result is **unambiguous** (exactly one site name):

| # | Signal | Rule |
|---|---|---|
| 1 | Ship GSTIN + ship PIN | Sites whose rows match both. Exact. |
| 2 | Ship PIN | Existing `matchWarehouseByPincode` logic: `extractPincode(shipTo)` vs `ship_to_pincode`, also checking the PIN inside the master's `ship_to_address`. If the ship GSTIN is present, use it to narrow rather than veto. |
| 3 | Ship-to address vs master address | Fuse over `ship_to_address`, `ship_to_line1`, `ship_to_line2` and `ship_to_city`, with the existing `MATCH_THRESHOLD`. Used only when the PIN is missing or unknown. |
| 4 | Ship GSTIN alone | Exact `ship_to_gstin` match. Accepted only when it resolves to one site; Maharashtra Pep, for example, does not. |
| 5 | Printed location label | Existing `bestMatch(destination, ["name","location","zone"])`. Now fed `BHIWANDI` from Step 1. |
| — | Nothing matched | **Return `null`.** The first-MWH default is removed, so `collectProblems`' existing "Select a destination." check blocks submit until someone picks a site. |

- Pass the new inputs from `invoice-form.ts:135`: `{ shipTo, billTo, shipToGstin: p.ship_to_gstin }`.
- Also return **which rung matched** (e.g. `{ option, by: "gstin+pin" }`), or expose it through a sibling function, so the review screen can show why a site was picked.

### Step 5 — Review screen: evidence + no-match alert (frontend; I write this part)
- `InvoiceFields.tsx:160`: extend the existing `ParsedHint` under Destination to show the evidence, e.g. "Matched by GSTIN + PIN 421302".
- **Alert when no destination is matched.** Show an amber alert on the Destination field, in the dialog's existing warning style: "No warehouse matches this invoice (PIN 421302, GSTIN 27AAJCK…). Pick the destination manually or fix it on /masters/warehouses." `collectProblems` already blocks submit on an empty destination.
- **Alert when no facility is matched.** A destination can be set, by the ladder or by hand, while that site has no active row with a `facility_code` for the billed entity. Today this surfaces only at commit, as the 400 `warehouse_facility_missing` from `invoice-inward.ts:323`. Catch it on the review screen instead:
  - Add `e.pan AS entity_pan` to the `warehouseOptions` query and `entity_pan` to `WarehouseOption`.
  - Add a pure `resolveFacility(destination, buyerGstin, options)` in `invoice-mapping.ts`. It returns the row where `name = destination` and `entity_pan = panOf(buyerGstin)`, using `panOf` from `lib/invoice/gstin.ts`, or `null`.
  - In `collectProblems` (`invoice-form.ts:352`), when the result is `null` or has no `facility_code`, push "'Mumbai' has no Uniware facility for the billed entity (PAN …). Set it on /masters/warehouses." This shows in the existing problems list and blocks submit.
  - The server-side 400 stays as the real guard.
- Neither alert adds a section; both sit on or under existing fields.

### Step 6 — Tests
- `tests/unit/invoice-local-layouts.test.ts`: add the address lines, the `SKU CODE:` spelling and the dispatch line to the `CHERYL` fixture. Assert both addresses, `ship_to_gstin`, `destination = BHIWANDI`, `purchase_order` and `sku_code`.
- `tests/unit/invoice-pincode.test.ts`: add ladder cases using the real master shape. Cheryl → Mumbai. Pep GSTIN `27AAICP2804J1ZC` without a PIN → `null` (Mumbai and Nagpur are ambiguous). Address-only → the right site.
- `resolveFacility` cases:
  - Mumbai + Kreative GSTIN → `HYP_B2B_MUM2`
  - Mumbai + Pep GSTIN → `MUM_WAREHOUSE2`
  - A site with no row for that PAN → `null`
  - A buyer GSTIN that is missing or unparseable → `null`
- **Behaviour change:** `invoice-pincode.test.ts:105-106` and `scripts/_check-invoice-mapping.ts:124-125` assert the MWH fallback. Update them to expect `null`.

## Risks
- **Removing the MWH default** means every unmatched invoice now needs a manual pick. That is intended, but the inwarding desk will notice.
- **Adding `ship_to_gstin` to the Nanonets schema** alters every metered call. Cost is unchanged, but a wording change can shift extraction of neighbouring fields. Verify on one Reve invoice.
- **Commit-side facility lookup** (`facilityByDestinationAndPan`) is unchanged. It still trusts the chosen destination plus the buyer PAN, so the fix is only as good as the Step 4 pick.

## Verification
1. `npm test` passes, with the new Cheryl and ladder cases.
2. Re-run the scratch dump on `Downloads/1752.pdf` and `Invoices/CHERYL…/1167 (1).pdf`. Expect: addresses populated, `ship_to_gstin = 27AAJCK9697F1ZS`, `destination = BHIWANDI`, `purchase_order` set, and the SKU `HYPMUBX0046F0030`.
3. Run the same dump on the other 13 samples in `Invoices/` to confirm no layout regressed: the `source` and `ok` values match what they are today.
4. `npm run dev`: upload `1752.pdf`. The address boxes are filled, Destination = **Mumbai**, and the hint reads "Matched by GSTIN + PIN 421302".
5. Clear Destination, and the no-match alert appears. Change the Buyer GSTIN to one whose PAN has no row at the chosen site (e.g. a non-Pep/Kreative PAN from `OUR_PANS`): the facility alert appears and submit stays blocked. Every live site has facility codes for both entities today, so this path is otherwise only reachable by master-data gaps.
5. `npx tsc --noEmit --incremental false` and `npm run lint:changed` are clean.
