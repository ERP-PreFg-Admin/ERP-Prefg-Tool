# Register adds the vendor in Uniware — plan

**Status:** built on dev 2026-10-09 (uncommitted), Claude wrote all of it. Unit tests green; a
read-only sweep of all 18 facilities' real Vendors exports against prod's 213 registered
pairs found **0** wrong auto-picks and **0** missed vendors (197 auto, 13 pick-list, 3
placeholders → create). Change from the plan: only a **sole exact** match is reused
silently; loose/multiple hits always go to a pick-list with "None of these — create".
Also fixed: `pollExportJob` now keeps polling when a job reports success before its file
exists (7 facilities hit that). **Next: prod run — needs Ajay's go-ahead.**

## Why

"Register as Uniware vendor" (`facility-map` → `set-vendor-code`) writes only our
`un_code_mfg_sku_wh_map` vendor-code row, always as `master_mfgs.code`, and never calls
Uniware. The first Uniware call is the SKU push, which assumes the vendor exists — so
NG Electro @ HYP_DLGWHT (Yogesh, 2026-10-09) failed with `Invalid vendor code`.

## The fixed route

One path, every time Register is clicked. Same button, same action name; the route behind it changes.

```
Register (mfg, facility)
  1. Guards — editor on the page, mfg + facility in scope            (unchanged)
  2. PULL   — Uniware "Vendors" export for that facility             (read)
  3. MATCH  — is this manufacturer already a vendor there?
       one match   → store THAT code, done. Nothing written to Uniware.
       2+ matches  → 409, list them; user picks one, stored as-is.
       none        → step 4
  4. ADDRESS — is the manufacturer in the address registry?
       no  → 409 "No address on file for <mfg> — can't create it in Uniware."
       yes → step 5
  5. CREATE — one transaction: write our vendor-code row, POST vendor/create,
              commit only if Uniware succeeds; else roll back, cell stays grey,
              toast shows Uniware's reason.
  6. SKU mapping + push as today (vendorItemType/createOrEdit) — now has a vendor.
```

**V1 — never add twice (step 2–3).** The Vendors export (`exportJobTypeName: "Vendors"`,
columns `vendorCode, vendorName`) is the only list of a facility's vendors, including
those with zero items. Match on the vendor **name**, normalised (case, punctuation,
`pvt`/`ltd`/`private`/`limited` dropped) against `details_mfg.registered_name` and
`master_mfgs.name`, plus an exact code match on `master_mfgs.code`. Storing the code
Uniware already uses also ends the hand-typed-code drift (`NG_ELECTRO`, `_Reve_`, …)
for every future pair. The export takes 10–60 s, so the button shows
"Checking Uniware…", and the list is cached per facility for 10 minutes.

**V2 — what gets sent (step 5).** `/create` only, never `/edit`.

```json
{ "vendor": {
    "code": "<master_mfgs.code>",
    "name": "<registered_name>",
    "billingAddress":  { "addressLine1": "…", "city": "…", "pincode": "…",
                         "stateCode": "…", "countryCode": "IN", "phone": "11111111" },
    "shippingAddress": { …identical to billingAddress… },
    "partyContacts": [ { "contactType": "PRIMARY", "name": "<registered_name>",
                         "email": "ABC@gmail.com", "phone": "11111111" } ]
} }
```

Nothing else (no PAN/GST/website/flags). Gate 1 confirms which address keys are truly
mandatory; any optional one Uniware doesn't need is dropped.

## The address registry

A constant, `lib/uniware/vendor-addresses.ts`, keyed by `master_mfgs.code`, transcribed
from the supplier invoices in `Invoices\`. In code rather than a table so it ships with
**no DDL**; a DB-backed version (columns on `details_mfg`, editable on the master) is the
follow-up. GSTIN on every invoice was checked against `details_mfg.gst_number` — all match.

Sources: the `Invoices\` folder, then (2026-10-09) the invoice PDFs in S3 behind
`invoice_mfg.attachment_key` on prod for the ones the folder lacked.

| Status | Manufacturers | Count |
|---|---|---|
| **Ready** — full address + PIN | Archeesh · Aroma De France · NG Electro (MBA, Baddi) · Aelius · Vedic · All Mask (Jainam) · Ananya · Arovea · **Cimera** (Plot 52, Sector-6A, IIE SIDCUL, Haridwar 249403, UK — S3) · **Reve** (Plot 78, STICE, Musalgaon, Tal. Sinnar, Nashik 422112 — PIN from the e-way block, S3) · **Cheryl — factory** (Plot A-328/329/330, TTC Industrial Area, MIDC, Mahape, Navi Mumbai 400710, MH) · **Kain — factory** (Survey No. 63, Horale, Khopoli Pen Road, Khalapur, Raigad 410203, MH) · **Anuspa** (Plot No.-3, Industrial Area Estate Khadeen, Parwanoo, Dist. Solan, HP 173220 — Nanonets) · **Yasharth** (G 41, Additional MIDC, Via Dewoolwada, Nerur, Kudal, Sindhudurg 416520, MH — Nanonets) | 14 |
| PIN not printed anywhere | Kapco (Plot 10-11, Sec-3, Parwanoo, HP) · Zymo (Block 115, Santej, Gandhinagar, GJ) — no invoices in S3 · Samrvir (2352 Bhapoo, PO Rajakhasa, Teh. Indora, Distt. Kangra, HP — line cut off before the PIN on all 6 S3 invoices) | 3 |

Cheryl and Kain use the **factory** address (Ajay, 2026-10-09). Anuspa and Yasharth were read
with the app's own Nanonets client (`parseInvoice`, `destination` re-described for one run
as the seller address — 2 calls); both returned GSTINs match `details_mfg`.

Step 3 runs for all 17: a manufacturer outside the registry still registers fine
wherever Uniware already has it — only *creating* needs an address.

## Sequence and gates

1. **Gate 1 — RUN 2026-10-09 on TEST_FACILITY with dummy vendors** (Ajay: "use some dummy
   data"). `ERP_TEST_VENDOR_01` (V2 payload), `_02` (+`enabled`), `_03` (+GST/PAN/registeredDealer):
   - ✅ `vendor/create` accepts the V2 payload; the vendor shows in the Vendors export at once.
   - ✅ A second create answers `Vendor Code already exists` → `createVendor` treats it as success.
   - ❌ **`vendorItemType/createOrEdit` against any vendor we created fails `please fill valid
     value`**, while the same SKU pushes fine to the pre-existing `Test_Vendor`. Not fixed by
     `enabled` or GST/PAN. Same error Ananya @ HYP_DLNAG (a hand-made vendor) hit on prod.
     **Solved 2026-10-14:** it was never the vendor. A *first* create of any vendor item needs
     `vendorSkuCode` (hidden message "No content to map to Object…"); `Test_Vendor` only worked
     because `TEST_UNICOM1` already existed there (an edit). `createVendorItem` now defaults it
     to the SKU code, as every live Vendor Item Master row has it.

   Earlier note: **DEFERRED by Ajay (2026-10-09: "Leave Test Facility for now").** An exception
   to the prove-on-TEST_FACILITY rule. Consequence: the first real `vendor/create` is the
   prod one (NG Electro @ HYP_DLGWHT). A missing mandatory key just 400s it — nothing is
   written, the local row rolls back, and the error names the key. The real risk is a call
   that *succeeds* with a wrong value, since a Uniware vendor cannot be deleted — so the
   prod run sends the full V2 payload (address, PIN, state, phone, contact) rather than a
   minimal one, and is done once, by hand, watched. What Gate 1 would have taught (existing-
   code response, export visibility) is learned from that run instead.
   Original Gate 1, kept for when it is picked up: **TEST_FACILITY probe**, no code shipped. Throwaway vendor code. Prove: the
   minimal payload above is accepted (and which address keys are mandatory, `stateCode`
   format `HR`-style); what `/create` returns for an existing code; the new vendor then
   appears in the Vendors export; a `vendorItemType/createOrEdit` push against it
   succeeds. **Report before step 2.**
2. **Build on dev** — `VENDOR_CREATE_PATH` + `createVendor()` (`lib/uniware/vendors.ts`,
   mirroring `vendor-items.ts` and its sandbox guards); `pullFacilityVendors()` over
   `export-jobs.ts`; pure `matchVendor()` + payload builder; the route reworked as above;
   panel shows the found / created code and the 409 choices.
3. **Tests** — unit: `matchVendor` (NG Electro vs `NG_ELECTRO`, `N_G_Electro_Products_Pvt_Ltd`,
   no false match on `HYP_B2B_GGN_`), payload builder (only the keys above, ship = bill).
   DB: Uniware failure leaves no row. Gate: `npm test`, `tsc --incremental false`, `lint:changed`.
4. **Prod** — NG Electro @ HYP_DLGWHT first: re-Register (export has no NG Electro → create),
   then Retry the SKU push; confirm `HYPMUBX0065F0050` in Vendor Item Master. Then
   Reve @ KOL_WAREHOUSE·Kreative re-Register → export finds `REVE` → code corrected.

## Decisions (owner: Ajay)

| # | Question | Recommendation |
|---|---|---|
| A1 | Cheryl, Kain — which address | **Decided: factory address.** |
| A2 | Kapco, Zymo, Samrvir — no PIN on any invoice | Hold until you give the PINs, unless Gate 1 shows PIN optional |
| A3 | Registry in code vs table | Code now (no DDL), table as follow-up |
| A4 | Who writes it | Frontend is mine; API/helpers — you or me? |

## Risks

| Risk | Mitigation |
|---|---|
| Name match picks the wrong vendor | Exact normalised match only; 2+ → user chooses; unit-tested against real codes |
| Export slow / times out | "No file" = retry, never "not a vendor" (see vendors-export memory); 10-min cache |
| Unknown mandatory key 400s the create | Gate 1 deferred — a 400 writes nothing and names the key; fix and retry |
| Create succeeds with a wrong value (undeletable vendor) | Full V2 payload on the first prod run, one manufacturer, watched |
| Vendor created, local commit fails | Re-Register finds it in the export (step 3) — self-healing |
| Placeholder phone/email on real vendors | As instructed (V2); replaceable later via the follow-up |
