# Per-manufacturer invoice extraction profiles — Design

**Date:** 2026-08-07
**Status:** approved, not yet implemented — blocked on sample invoices

## Goal

Invoice extraction (`lib/nanonets.ts`) sends one schema and one prompt for every supplier.
Formats differ per manufacturer, so a single rule set under-serves all of them. This design
adds per-manufacturer extraction logic, selected automatically from the PDF, with a shared
base for manufacturers that need no special handling.

---

## Verified facts

Established by reading the code and the one captured extraction; not assumptions.

**Extraction fires before the manufacturer is known.** `handleFile` calls `runParse(picked)`
immediately on file pick (`AddInvoiceDialog.tsx:245`); `form.mfgId` is only derived
afterwards from the extracted `from` via `matchMfg`. Any per-manufacturer config must
therefore be chosen from the PDF itself, before the Nanonets call.

**GSTIN → manufacturer is an exact key, not a heuristic.** `details_mfg.gst_number`
(`VARCHAR(20)`) exists, and `checkDuplicateGst` (`lib/queries/manufacturers.ts:194`) already
enforces it unique across manufacturers.

**No PDF text library is installed.** `@react-pdf/renderer` only *generates* PDFs. Detection
needs a new dependency.

**On the one captured invoice, `line_items[].total_amount` / `mrp` / `discount` are null
because that invoice has no such columns** — GST is applied once in the footer. Verified:

```
pre-tax sum of line amounts   104,552.88
stated invoice total          123,372
ratio                          1.179996   ← exactly +18%
```

Null is *correct output* there, not an extraction failure. No prompt wording can populate
those fields, and instructing the model to derive them would fabricate money that
`toInwardPayload` (`invoice-form.ts:452`) persists to `supplier_invoice_items`. Whether this
holds for other manufacturers is the single most useful thing the samples will tell us.

---

## Step 0 — blocked on samples

One sample per manufacturer into `ERP Project\Invoices\`, named so the manufacturer is
unambiguous (`REVE - Sales_RP_L_26-27_482.pdf`). The folder currently holds only the REVE
invoice. **No per-manufacturer rule can be written until the documents are read** — the
machinery below is worth building regardless, but the rules are evidence-driven.

### Scope caution

A profile per manufacturer may be more structure than the problem needs. Most Indian GST
invoices are Tally/Busy-generated and differ only cosmetically. **The registry starts empty**
and gains an entry only where a sample proves the base rules fail. If the samples turn out
alike, the honest outcome is a better base prompt and two or three profiles — not eight.

---

## Module structure

```
lib/
├── nanonets.ts                    MODIFIED — wire format + base rules
│   ├── EXTRACTION_SCHEMA            + description on 6 bare fields
│   ├── BASE_INSTRUCTIONS            renamed from CUSTOM_INSTRUCTIONS
│   ├── buildExtractionConfig()      NEW — merges base + profile, asserts 8k cap
│   ├── parseInvoice(buf, name, profile?)   3rd arg optional
│   └── normalizeParsedInvoice()     unchanged
│
├── nanonets-profiles.ts           NEW — the registry
│   ├── type ExtractionProfile       narrow override, not a replacement
│   ├── PROFILES                     Record<mfgCode, ExtractionProfile>, starts empty
│   └── applyOverrides()             merge field descriptions over the base schema
│
├── invoice-detect.ts              NEW — which manufacturer is this?
│   ├── extractPdfText()             unpdf, text layer only
│   ├── GSTIN_RE                     /\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]\b/g
│   └── detectMfgFromPdf()           → DetectedMfg | null, never throws
│
├── queries/manufacturers.ts       MODIFIED — + selectByGstins
├── invoice-mapping.ts             unchanged — matchMfg stays as the fallback
└── invoice-inward.ts              unchanged

app/
├── api/purchase-orders/invoice/
│   └── parse/route.ts             MODIFIED — detect → profile → parse
└── po-tracking/po-inwarding/
    ├── AddInvoiceDialog.tsx       MODIFIED — pre-select mfg from `detected`
    └── invoice-form.ts            MODIFIED — sumLineItems gross-up (item 6, separable)

tests/
├── unit/nanonets-profiles.test.ts NEW — merge correctness, no-profile parity, 8k cap
└── db/invoice-detect.test.ts      NEW — selectByGstins, withRollback()
```

**Layering rule, same as the rest of `lib/`:** `invoice-detect.ts` knows about PDFs and the
DB but nothing about Nanonets; `nanonets-profiles.ts` knows about Nanonets but nothing about
PDFs or the DB; the route is the only place the three meet. Keeps each unit testable alone.

---

## API routes

### Modified

| Route | Change |
|---|---|
| `POST /api/purchase-orders/invoice/parse` | Detect the manufacturer from the PDF, select its profile, pass it to `parseInvoice`. Response gains `detected`. `maxDuration = 300` and `runtime = "nodejs"` stay as they are. |

Handler, inserted after the existing file validation and before `parseInvoice`:

```ts
const detected = await detectMfgFromPdf(buffer)      // null-safe, never throws
const profile  = detected ? PROFILES[detected.code] : undefined
const parsed   = await parseInvoice(buffer, filename, profile)
```

Response shape — additive, so nothing existing breaks:

```jsonc
{
  "ok": true,
  "parsed": { /* ParsedInvoice, unchanged */ },
  "detected": {                    // null when detection fails
    "mfgId": 12,
    "code": "REVE",
    "name": "Reve",
    "gstin": "27AAKFR0481L1ZT",
    "profileApplied": true         // false = matched a mfg with no profile registered
  }
}
```

`detected` must also be logged on the existing `logger.info` / `recordProcessedEvent` calls.
Without it a misfiring profile is invisible — you cannot tell from the output whether a bad
extraction used the wrong profile or no profile.

**Why `detected` matters beyond profile selection:** `from` currently gates the entire flow
(no manufacturer → no open POs → FIFO allocates nothing → submit is dead), and it is resolved
by fuzzy-matching a trade name. An exact GSTIN match is strictly better. `matchMfg` stays as
the fallback when detection returns null.

### Proposed — not required for v1

| Route | Purpose | Cost |
|---|---|---|
| `POST /api/purchase-orders/invoice/detect` | Detect-only. Returns the same `detected` object in ~200 ms with **no Nanonets call**, so the dialog can name the manufacturer and start the open-PO fetch while the 60 s parse is still running. | Posts the PDF twice (≤10 MB each). Worth it only if the serialised open-PO fetch proves slow in practice. Measure before building. |

Both would share `detectMfgFromPdf` — the detect route is a thin wrapper, not a second
implementation.

### Deliberately not proposed

- **A profiles CRUD API / admin screen.** Profiles are prompt text: they need review, diffing
  and rollback, which a deploy gives and a DB row does not. A bad prompt reaching production
  unreviewed is the failure mode an editable table invites. Revisit only if the desk needs to
  tune without engineering.
- **A re-parse-with-profile endpoint.** Costs a second metered call and another ~60 s. Detection
  up front makes it unnecessary.

---

## Implementation

### 1. Detection — `lib/invoice-detect.ts`

Server-side, in the route: the PDF is already posted there as multipart, the `master_mfgs`
lookup needs the DB, and it keeps the PDF library out of the client bundle.

- Extract the text layer with **`unpdf`** (ESM, serverless-safe, wraps pdfjs, no native build).
- Collect GSTIN candidates with `GSTIN_RE`.
- An invoice carries both seller and buyer GSTINs. Ours is the **buyer**, so resolve by
  elimination: a candidate matching a `details_mfg.gst_number` row *is* the seller, because
  our own company is not a manufacturer in that table.
- Return `null` on: no text layer (scanned image), no candidates, no match. **Never throw** —
  detection failing degrades to the base profile, it must never break the parse.

New query in `lib/queries/manufacturers.ts`, mirroring `checkDuplicateGst`:

```ts
/** Parameters: [gst_numbers[]] — needs query(), not execute(), for IN (?) expansion. */
selectByGstins: `
  SELECT mfg.id, mfg.code, mfg.name, d.gst_number
  FROM details_mfg d
  JOIN master_mfgs mfg ON mfg.id = d.mfg_id
  WHERE d.gst_number IN (?)
`,
```

One query for all candidates, matching the existing `checkDuplicateGstBatch` (`:220`) pattern.

### 2. Profile shape — `lib/nanonets-profiles.ts`

```ts
export type ExtractionProfile = {
  /** master_mfgs.code this applies to. */
  mfgCode: string
  /** Appended after the base rules. Later text wins on conflict. */
  extraInstructions?: string[]
  /** Per-field description overrides, merged over EXTRACTION_SCHEMA. */
  fieldOverrides?: {
    header?: Record<string, string>
    lineItem?: Record<string, string>
  }
}

export const PROFILES: Record<string, ExtractionProfile> = { /* filled from samples */ }
```

### 3. Composition — `lib/nanonets.ts`

No behaviour change when no profile matches.

```ts
export function buildExtractionConfig(profile?: ExtractionProfile) {
  return {
    output_format: "json",
    json_options: profile?.fieldOverrides
      ? applyOverrides(EXTRACTION_SCHEMA, profile.fieldOverrides)
      : EXTRACTION_SCHEMA,
    custom_instructions: [...BASE_INSTRUCTIONS, ...(profile?.extraInstructions ?? [])].join(" "),
    prompt_mode: "append",
  }
}
```

Keep `.join(" ")` and its comment — a comma-expression once silently dropped every rule but
the last. Assert the documented **8,000-char cap** on `custom_instructions` (base is ~590
today, so there is headroom, but a few verbose profiles could reach it).

### 4. Base prompt + schema

Every profile inherits this, so improving it reduces how much each profile must override.

- Add `description` to the six bare fields: `invoice_number`, `eway_bill_number`,
  `vehicle_number`, `batch`, `hsn`, `discount`. `invoice_number` is the worst gap — it backs
  `UNIQUE (mfg_id, invoice_no)` on `supplier_invoices`, so a misread defeats the duplicate
  guard and the same invoice can be inwarded twice.
- Tighten `from` to ask for the registered legal name with entity suffix. `matchMfg`
  (`lib/invoice-mapping.ts:87`) deliberately tries `registered_name` first and currently
  receives a trade name.
- State that `amount` is pre-tax and `total_amount` is the printed tax-inclusive figure, taken
  **only** from a printed per-row column and **never derived**.
- Add label synonyms for the bill-to / ship-to / purchase-order blocks.

### 5. Separable — the false drift warning

Independent of everything above; include or omit on its own merits.

`sumLineItems` (`invoice-form.ts:373-378`) falls back to `amount` (pre-tax) and
`InvoiceFields.tsx:96-98` compares it to the post-tax total with a ₹1 tolerance, so every 18%
invoice shows a spurious *"18,819.12 under the invoice total"*. Grossing the fallback up by
the row's own `gst_percent` moves the captured invoice's drift from **-18,819.12** to
**+0.40** — inside tolerance, warning clears. A missing `gst_percent` gives a multiplier of
1.0, identical to today.

Display only. **Do not apply the same gross-up in `toInwardPayload:452`** — that value is
persisted, and grossing it up is the fabrication objection one layer down.

---

## Verification

Free, no metered calls:

| Command | Covers |
|---|---|
| `npx tsc --noEmit` | profile types; `KNOWN_KEYS` / `LINE_KEYS` still derive from `Object.keys` correctly |
| `npx tsx scripts/_check-invoice-mapping.ts` | normalisation, `_ref` stripping, null-not-NaN, date coercion, mapping |
| `npm test` | `tests/unit/invoice-mapping.test.ts` + the new profile tests |
| `npm run test:db` | `selectByGstins` against a seeded row, rollback-wrapped |

**Detection is fully testable offline** — pure text extraction, no network:

```
npx tsx -e "detectMfgFromPdf(readFileSync('Invoices/REVE - ....pdf'))"
```

Run it over **every** sample before spending a single Nanonets call. That alone proves whether
GSTIN detection is viable across your manufacturers, and surfaces any scanned-image invoice
with no text layer.

Metered (~60 s each): one live run per manufacturer whose profile was written, plus a re-run
of the REVE invoice as a regression against `CAPTURED` (`scripts/_check-invoice-mapping.ts:16-44`).
Prompt output is non-deterministic — a clean run is evidence, not proof.

**Leave the fixture verbatim.** Its value is being a real capture including the `_ref` keys.
The `mrp === null` / `total_amount === null` assertions at `:61-62` are not encoding a defect —
they test null-vs-0, and 0 is a real price.

---

## Open until the samples are read

- Which manufacturers genuinely need a profile, and how many rules each takes.
- Whether any sample prints a per-row tax-inclusive column — that would change the
  `total_amount` conclusion for that manufacturer only.
- Whether every sample has a text layer for GSTIN detection.
- Whether any manufacturer's GSTIN is missing from `details_mfg`. Those fall back silently to
  the base profile and need the master filled in, not a code change.
