# Invoice SKU matching: our code first, then name + filling, broken by history

## Context
Many invoices print only a product name with the size inside it. `matchSku` (`lib/invoice/invoice-mapping.ts:65`) runs Fuse over the whole string, so the size is just a few characters and loses. "By The Blues Perfume body lotion 300 ml" was matched to `MCFMUWB0401F0600` (600 ml) instead of `Mcaf401` ("By The Blues Perfume Body Lotion", filling 300).

Past invoices in prod (`invoice_items_mfg`: printed `parsed_sku_code` / `sku_name` vs the `sku_code` the desk settled on) show what the matcher actually faces:
- **The code column is rarely ours.** NG Electro prints its own codes (`FG002500`, `MWBWSKP00401`), and Cheryl's parser once captured the literal header `CODE`. Our code often sits **inside the name**: `MCaf401- By The Blue Body Lotion 300ml`, `600MCaf370- Sweet Escape…`.
- **Names carry noise:**
  - brand prefixes: `MCAFFEINE`, the typo `MCAFFINE`, `M CAFF.`, `Hyphen`;
  - order text: `PO No : MPO-OO113461-2`, `(NEW PM)`;
  - pack text: `1X80ML`, `X 24`;
  - missing words: `Raspberry Rush Body Wash` vs `Brightening Raspberry Rush Body Wash`;
  - typos: `By The Blue` vs `Blues`;
  - a size with no unit: `…Face Scrub 100`.
- **`master_skus.filling` is the actual fill** (INT; `filling_uom` is ml / g / pairs / units). It's close to the label size, not equal: 300 is stored as 295, 600 as 590, 80 as 82, 30 as 32. Master names include the size sometimes and sometimes not.
- **Look-alikes share name and fill** (`MCaf383_WB` 310 vs `MCaf383_WB_N1` 300, `MCaf396` vs `Mcaf396_WB`). The desk's past picks are consistent, so history is the best tie-breaker.

## Decisions (agreed with Ajay)
- **Code means OUR `sku_code`** as the manufacturer printed it, exact (case- and space-insensitive), from the code column or a leading token of the name. Supplier codes aren't learned, and fuzzy code matching is dropped.
- **Name and filling are matched separately.** The name is cleaned of noise, lowercased and stripped of blanks, compared exactly, then fuzzily, but only among SKUs whose filling is within **10%, nearest wins**. Filling is a hard filter.
- **Candidates:** the manufacturer's live SKUs first (`master_recipe_mfg` lines), falling back to all SKUs.
- **Ties:** this manufacturer's past mapping for the same printed name wins, otherwise blank. **No PO data is used in SKU matching.**
- A blank tie shows its look-alikes in the existing caption under the SKU cell.
- `X 24` is noise; qty stays in units.

## Sequencing
1. **Pure matcher** in `lib/invoice/invoice-mapping.ts`, in the `matchSku` region only. The working tree already has Ajay's uncommitted warehouse-ladder edits in this file; leave them untouched.
   - `parseFilling(text)`: the last `<num><unit>` in the text (ml, l/ltr, g/gm/gms/gram, kg; spaces allowed; l and kg scaled ×1000). It also takes `1X80ML` → 80 and a trailing bare number such as `Scrub 100`.
   - `cleanName(text)`: removes a leading code token, brand prefixes (mcaffeine / mcaffine / m caff / hyphen), `PO No …`, `(new pm)`, `NxM` and `x 24`, and the size. Then it lowercases and strips blanks plus `, ( ) _ - . :`. It keeps `% + &`.
   - `matchSkuDetailed(line, ctx)` returns `{ sku, by: "code" | "name+filling" | "fuzzy-name" | "history", candidates }`. `ctx` carries `{ allSkus, mfgSkuCodes?, history? }`.

   The ladder, stopping at the first hit:
   1. Exact our-code, from the code column or a leading token of the name.
   2. Exact cleaned name, with filling compared separately.
   3. Fuzzy cleaned name (Fuse 0.3) over fill-compatible SKUs only.

   Steps 2 and 3 run on the manufacturer's SKUs first, then on all SKUs. Several hits go to the tie-break: history, otherwise blank with `candidates`. `matchSku` stays as a thin wrapper, so existing callers and the `_check` script keep working.
2. **Data the matcher needs:**
   - `SkuOption` gets `filling?: number | null` (`app/po-tracking/po-procurement/po-types.ts:84`, optional so the "All SKUs" literal in `PoProcurementClient.tsx:197` compiles). `sk.filling` is added to `purchaseOrdersSql.skuOptions`. That list is behind `unstable_cache` (`lib/cached-reference-data.ts:129`), so the column appears on the next revalidation.
   - The manufacturer's SKUs come from the existing `GET /api/v1/purchase-orders/mfg-skus?mfg_id=`, which ImpromptuPODialog already uses.
   - **New read-only route** `GET /api/v1/purchase-orders/invoice/sku-history?mfg_id=`. It returns, from that manufacturer's past invoices, `sku_name`, `parsed_sku_code`, `sku_code`, the count and the last date, through `withGateway` with `access` `/po-tracking/po-inwarding` viewer, `scope: { type: "mfg" }`, and the brand predicate copied from `openForReceiveByMfg`. Its SQL goes in `lib/queries/supplier-invoices.ts`.
3. **Wiring in the dialog** (frontend). **The FIFO logic and its effect are not touched.** `allocateFifo` and the effect at `AddInvoiceDialog.tsx:233` stay as they are.
   - In `runParse` (`AddInvoiceDialog.tsx:274`), once `next.mfgId` is resolved (GSTIN detection or `matchMfg`, both already there), fetch that manufacturer's SKUs and its history in parallel. Then call `rowsFromParsed(parsed, skuOptions, ctx)`. All the SKU decisions are made once, before the FIFO effect ever runs.
   - If no manufacturer is resolved, or a fetch fails, `ctx` stays empty and the ladder runs on all SKUs with no tie-break.
   - Changing the manufacturer by hand later doesn't re-match SKUs. The desk fixes rows itself, as today.
   - The caption under the SKU cell (`InvoiceLineItems.tsx`) shows `✓ matched by name + 300 ml`, `✓ from past invoice` or `2 matches: MCaf41, MCaf41_WB — pick one`. It reads a new `Row.sku_by` field set by `rowsFromParsed`.
4. **Tests:**
   - `tests/unit/invoice-mapping.test.ts` (pure, CI), with fixtures taken from the real history rows above:
     - By The Blues 300 / 80 / 600;
     - `MCaf401- By The Blue Body Lotion 300ml` matched by code;
     - `MCAFFEINE BY THE BLUES PERFUME BODYLOTION 1X80ML PO No : MPO-…`;
     - `Raspberry Rush Body Wash 300 ml` → `MCaf383_WB_N1` through history;
     - a tie with no history → blank with candidates;
     - `FG002500` ignored as a code;
     - `Magnetic 20ml` against fills 100/352/50 → blank.
   - Keep `scripts/_check-invoice-mapping.ts` green.

## Gates and risk
- **No DB writes, no DDL, no Uniware or approval changes.** One new GET route, read-only and scoped. The commit route still re-validates every SKU (`resolveBrands`), and every pick stays a suggestion.
- **Gate before UI wiring: a backtest.** Replay every prod `invoice_items_mfg` line (read-only) through the old and the new matcher, against what the desk finally chose. Report hits, wrong picks and blanks for each. Ship only if wrong picks fall and the number of blanks is acceptable; I'll share the numbers first.
- **Risk:** more blank cells where the old matcher guessed. That's intended, and the tie caption keeps it fast.
- **Risk:** parsing waits for one more round of fetches (two small GETs, in parallel) after the 50–70 s extraction. That's negligible.
- After approval, copy this plan to `docs/invoice-sku-name-filling-match-plan.md` (standing rule) and update `docs/po-inwarding.md` § Fuzzy Mapping.

## Verification
- The backtest script, run from the scratchpad, read-only against prod, with the numbers reported.
- `npm test`, `npm run test:checks`, `npx tsc --noEmit --incremental false`, `npm run lint:changed`. `tests/unit/route-scope.test.ts` must pass with the new route's `scope`.
- Manual: in `npm run dev`, open Add Invoice with a past Kain By The Blues invoice and an NG Electro 80 ml one. Confirm the picks and captions. FIFO behaviour is unchanged, so it isn't part of this verification.
