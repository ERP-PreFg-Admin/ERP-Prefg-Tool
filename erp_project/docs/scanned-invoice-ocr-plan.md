# Scanned invoices: OCR, detection, and strategies for Anuspa & Yasharth

**Status:** proposed, not started. Needs a go-ahead before any code.
**Asked for:** "add a strategy for anuspa and yasharth".

---

## 1. Why a strategy alone cannot work

`STRATEGIES` in `lib/nanonets/strategies/index.ts` is keyed by **seller GSTIN**,
and that GSTIN is read off the PDF's text layer by `detectFromPdf`. Measured on
the two samples:

| Supplier | File size | Text extracted | GSTINs | Pages | Producer |
|---|---|---|---|---|---|
| Anuspa Heritage | 4,672 KB | **0 chars** | none | 2 | Microsoft: Print To PDF |
| Yasharth Wellness | 2,186 KB | **0 chars** | none | 2 | Microsoft: Print To PDF |
| REVE PHARMA *(control)* | 76 KB | 4,924 | 3 | — | — |

So `strategyFor([])` returns `undefined` and a registered strategy never fires.
The same emptiness makes `detected` null, so the review dialog cannot pre-select
the manufacturer either.

A second, independent gap: `ExtractionStrategy.normalize()` is declared
(`strategies/types.ts:22`) and **never called** — the v2 route uses only
`configure()` via `configFor()`. Half the interface is dead.

**Therefore the order is: get text → detection works → strategy becomes
reachable → write the strategy from observed failures.** Writing the strategy
first produces unreachable code keyed on a GSTIN we cannot read.

---

## 2. Option zero — do this regardless

Both files are *Print To PDF* of an image. Anuspa's own invoice is an **e-invoice**
(the filename is `E INVOICE-257`), which means a compliant digital PDF with a
text layer exists upstream; someone printed a picture of it instead.

**Ask both suppliers to email the original PDF.** If that lands, both drop
straight into the existing free local tier, we pay nothing, write no OCR, and
this plan ends at section 2. It costs one email and should be tried before any
engineering.

Treat sections 3–6 as what we build *because some suppliers will always send
scans*, not as the fix for these two specifically.

---

## 3. Sequencing and gates

Each gate is a stop. Do not start the next step until the prior one answers.

### Gate A — what is inside Yasharth's PDF? (free, ~30 min)
Anuspa has extractable page images; Yasharth has no text, no extractable images.
Until that is explained, the input to OCR is unknown.

- Render page 1 of both with `unpdf`'s `renderPageAsImage` and eyeball the PNG.
- **Pass:** a legible invoice image comes out → continue.
- **Fail:** blank, or `renderPageAsImage` needs a native canvas we will not add
  → stop and reconsider; a scan we cannot rasterise cannot be OCR'd either.

Also settles whether we can skip rendering for Anuspa and feed its embedded
images to OCR directly.

### Gate B — does OCR text actually read? (one metered call, ~1 hr)
Run both samples through the chosen engine **as a throwaway script**, print the
text, and check by eye for: seller GSTIN, invoice number, date, the item table.

- **Pass:** GSTIN is readable → detection is unblocked, continue.
- **Partial:** GSTIN readable, item table mangled → still worth shipping. GSTIN
  alone buys manufacturer detection, dialog pre-select and strategy keying; the
  numbers keep coming from Nanonets, which OCRs these already today.
- **Fail:** GSTIN unreadable → stop. Nothing downstream works, and we would be
  paying for an OCR call that buys nothing.

### Gate C — Nanonets evidence (two metered calls, ~2 min each)
Only now is there a basis for a strategy. The harness already exists:

```
npx tsx --env-file-if-exists=.env tests/_check-invoice-extract.ts --folder "Anuspa Heritage Products Pvt. Ltd"
npx tsx --env-file-if-exists=.env tests/_check-invoice-extract.ts --folder "Yasharth Wellness S olutions Private Limited"
```

It writes raw responses to `.invoice-samples/<folder>.json` (gitignored), so the
strategy can be written later without paying again.

- **Pass:** a field is demonstrably wrong for that supplier → write a strategy
  for exactly that.
- **Fail:** base config gets both right → **write no strategy.** The registry's
  own rule is that an entry needs a sample proving the base rules fail, and
  `tests/unit/extraction-strategies.test.ts:161` asserts the registry stays
  empty. Two suppliers extracting correctly is a good outcome, not a gap.

> ⚠️ `NANONET_API_KEY` is **not in the local `.env`** — it lives in SSM
> (`deploy/push-secrets.mjs:42`). Gate C needs the key pulled with
> `AWS_PROFILE=erp`, or the script run on the instance. Calls also count against
> `NANONETS_MONTHLY_CALLS`, enforced in `lib/nanonets/client.ts:114`.

### Gate D — build, in this order
1. OCR fallback wired into `detectFromPdf` (section 4).
2. Detection verified on both samples — `detected` non-null, correct manufacturer.
3. Strategies added *only* for what Gate C proved.
4. `normalize()` wired into the v2 route, *only* if a strategy needs it.

---

## 4. Where OCR belongs

**Inside `extractPdfText` / `detectFromPdf`, as a fallback when the text layer is
empty.** One place, so every caller benefits: the v2 route, both probe scripts
and `tests/_check-invoice-detect.ts` all go through it and none has to know OCR
exists. The local parser then gets a shot at the OCR text for free — it may well
refuse on scan noise, which is correct and costs nothing.

Non-negotiable properties, matching what `extractPdfText` already promises:

- **Never throws.** It logs and returns `""` today; OCR failure must behave the
  same or a scanned invoice stops parsing entirely instead of falling through.
- **Only runs when the text layer is empty.** Every readable invoice must keep
  its current ~100 ms free path — no added latency, no added cost, for the 10
  of 15 that work today.
- **No S3 write.** The v2 route deliberately keeps the PDF out of S3 until the
  user commits, so an abandoned review leaves no orphan. OCR must not break that.

### Engine: AWS Textract, called synchronously per page

Recommended because we are already on AWS with credentials in `.env`
(`ACCESS_KEY_ID_AWS`, `REGION_AWS`) and five `@aws-sdk/client-*` packages
installed — adding `@aws-sdk/client-textract` is the same SDK family, no native
build, no model data to ship.

**Sync `DetectDocumentText` on rendered page images, not async on an S3 object.**
Async multi-page PDF extraction requires the file in S3, which violates the
no-orphan property above. Sync takes raw bytes, so pages are rendered in memory
with `unpdf`'s `renderPageAsImage` (or, for Anuspa, its already-embedded images)
and posted one at a time. Two pages, two calls.

Rough order of cost: Textract text detection is a small fraction of a cent per
page — confirm the figure for `REGION_AWS` before committing. The point is that
it is far below a Nanonets extraction, so if OCR text turns out good enough for
the local parser, scanned invoices get **cheaper** than they are today, not
dearer.

**Alternative if we would rather not add a service:** `tesseract.js`, free and
in-process, but it needs ~15 MB of language data in the image and is weaker on
tabular invoices. Falls back to being the right answer only if Textract is
refused on procurement grounds.

**Rejected:** asking Nanonets for its own OCR text. It runs *after* the call, so
it cannot key `configure()` — which is the whole point.

---

## 5. Risks

| Risk | Mitigation |
|---|---|
| OCR misreads a digit in a quantity or rate | **The local parser's gates are the guard and they already exist** — `qty × rate = amount` per row, and Σ lines + charges landing on a statutory GST multiple within 0.5%. OCR text that fails them falls through to Nanonets exactly as today. Do not relax a gate to make a scan pass. |
| OCR latency added to the parse | Only on PDFs with no text layer, which are already going to Nanonets for 50–70 s. Two Textract calls are noise against that. |
| A wrong GSTIN read picks the wrong strategy | `strategyFor` takes the first registered GSTIN. With an empty registry this is inert; when the first entry lands, pin it with a test — the hazard is already documented at `lib/invoice/gstin.ts:42`. |
| Scope creep into "OCR everything" | The fallback triggers only on empty text. Readable invoices must never reach it. |
| Gate C shows nothing wrong | Then we ship OCR + detection and **no strategy**. That is a complete, correct outcome. |

---

## 6. Files this would touch

Listed last on purpose — the sequencing above is what matters.

| File | Change |
|---|---|
| `lib/invoice/ocr.ts` | new, the Textract call + page render. Pure-ish; isolated so `tests/unit` never imports it. |
| `lib/invoice/invoice-detect.ts` | `extractPdfText` falls back to OCR on empty text. Keep the never-throws contract. |
| `lib/env.ts` | nothing new if Textract reuses the existing AWS creds — confirm at Gate B. |
| `package.json` | `@aws-sdk/client-textract`. |
| `lib/nanonets/strategies/anuspa.ts`, `yasharth.ts` | **only if Gate C proves a failure.** |
| `lib/nanonets/strategies/index.ts` | one line per registered GSTIN. |
| `tests/unit/extraction-strategies.test.ts` | line 161 asserts the registry is empty — update only when an entry is genuinely added. |
| `app/api/v2/.../parse/route.ts` | wire `normalize()` only if a strategy needs it. |

---

## 7. Verification

```bash
npx tsx scripts/_probe-invoice.ts            # Anuspa/Yasharth must stop saying "no text layer"
npm test                                      # extraction-strategies + invoice-local suites
npx tsc --noEmit --incremental false          # not plain tsc; stale tsbuildinfo lies
npm run lint:changed
npm run build                                 # stop `npm run dev` first; Next 16 locks .next
```

End to end on `/po-tracking/po-inwarding` → Add Invoice:

1. Upload Anuspa's PDF — the dialog pre-selects Anuspa from an exact GSTIN match.
   This is the headline win and it is visible without reading a log.
2. Upload a readable invoice (REVE) — response `source` still reads
   `local:tally`, latency unchanged. **Proves OCR did not leak onto the free path.**
3. Check the parse log line: `source`, `strategy`, `detectedMfg` all populated
   for the scanned pair.
4. Re-run the full probe — the 10 currently-passing suppliers must still pass,
   with identical row counts and ratios.
