# Local invoice layouts for NG Electro, Samrvir and Cimera — plan

**Status:** built 2026-10-14 by Claude (Ajay: "You write code for all"), uncommitted.
- **New files:** `lib/invoice/local/cimera.ts`, `samrvir.ts`, `ngelectro.ts`.
- **Gate change:** `index.ts` gains a per-layout `declaredQty`.
- **Replay on prod, read-only:**
  - Cimera: 8/8 text PDFs match.
  - NG Electro: 70/70 match.
  - Samrvir: 25/26 of the current template match. The 1 mismatch is the Nanonets batch
    error on `SB/2270`.
  - Zero regressions on the other manufacturers' October invoices.
- **Checks:** unit tests, `tsc --incremental false`, ESLint and `npm run build` pass.

## Structure check against every prod invoice (2026-10-14, read-only)

A prototype of each row pattern was run on **every** invoice these three have on prod
(114). For each invoice it checks:
- the rows read;
- qty × rate = amount on each row;
- the invoice number and date;
- the declared quantity total, where the invoice prints one;
- the grand total against the stored invoice;
- qty and amount per batch against the committed lines.

| | Invoices | Matches what was committed | No text layer | Other |
|---|---|---|---|---|
| NG Electro | 72 | **70** | 2 | — |
| Samrvir | 32 | **25** | 0 | 5 older template, 1 Nanonets error |
| Cimera | 10 | **8** | 2 | — |

- **NG Electro:** one template, used by both plants (`MBA…` and `MB2…`) since 30 Sep. Two
  things contradict the earlier assumptions:
  - **Multi-row invoices exist and parse.** `MBA2627/GIS00447` has 4 rows over 2 pages.
  - The SKU code sometimes shares a line with the rate (`MCaf370 48FG002334 66.580`)
    instead of wrapping onto its own lines. The rate is read as the 3-decimal figure after
    `FG<n>` either way.
  - The batch is everything before the `1X<pack>` suffix: `NAK6124R1X200ML` gives
    `NAK6124R`.
- **Samrvir changed its template around 1 Oct.**
  - The 5 invoices from 30 Sep (`SB/2175`–`SB/2180`) use an older layout. Their row runs
    qty, amount, rate, HSN and S.N together: `7560.00 591267.6078.21330499901 TSMC260234`.
  - Every invoice from 4 Oct onwards (`SB/2213`+) is the current one and parses 25/25.
  - Only the current template gets a layout; an old-style invoice is refused and goes to
    Nanonets.
  - `SB/2270/26-27`: Nanonets stored batch `TSMC26024`, but the PDF prints `TSMC260241`.
    The local read is the correct one.
- **Cimera:** 8/8 text PDFs match. 2 are scans (`CM001120`, `CM001123`) and stay with
  Nanonets.

## Why

Invoice parsing has slowed down because Nanonets has: 7–9 s calls became 100–230 s on bad
runs, with 502/504s, since 12 Oct. Our local parser answers in ~0.1 s, but it has no
layout for these three manufacturers, so every one of their invoices goes to Nanonets:

| Manufacturer | Invoices in Oct (to 14th) | Share of all Oct invoices | Local today |
|---|---|---|---|
| NG Electro | 45 | 18% | 0/6 — "unrecognised invoice layout" |
| Samrvir | 26 | 11% | 0/6 — "unrecognised invoice layout" |
| Cimera | 10 | 4% | 0/6 — 4 unrecognised, 2 scanned |
| **Together** | **81 of 246** | **33%** | |

They are most of today's Nanonets traffic. Each one moved local saves 7–230 s of
waiting plus one billed call.

## Sequence and gates

Easiest and least risky first. Each layout is its own commit and its own gate.

1. **Cimera** (Marg ERP). The cleanest text: one line per item, labelled header.
   - **Gate C:** replay on all 10 prod Cimera PDFs. Every text PDF parses and matches the
     stored lines. The 2 scanned ones still go to Nanonets, as they must.
2. **Samrvir.** Each item is two lines and some columns run together, but the anchors are
   reliable, and the "Total Qty." footer is a strong check.
   - **Gate S:** replay on all 31 prod Samrvir PDFs, same bar.
3. **NG Electro.** The highest volume but the hardest: the text layer comes out in
   positional order rather than reading order. Its one item line is still intact, and
   three totals cross-check it.
   - **Gate N:** replay on all 72 prod NG PDFs, same bar. Multi-row and multi-page
     invoices are covered: the structure check found them and read them correctly.
4. **Ship.** `npm test`, `tsc --incremental false`, `lint:changed`, `npm run build`, then
   deploy.
   - **Watch:** for one week, the share of parses that go local (S3
     `processed-events/PO_INVOICE_PARSE`, `source`).

**The bar at every gate is zero wrong answers.** A refusal is acceptable, because it just
falls back to Nanonets as today. A wrong quantity becomes received stock, so a layout that
gets even one replayed invoice wrong does not ship.

## What each layout reads

They all go through the existing gate in `lib/invoice/local/index.ts`. A parse is only
returned if:
- every row satisfies qty × rate = amount;
- the line sum × a GST rate = the grand total;
- the declared quantity total matches the line sum, where the invoice prints one;
- the row count matches the item numbering.

That gate is unchanged. New code only finds the numbers.

| | Cimera | Samrvir | NG Electro |
|---|---|---|---|
| Recognised by | "Marg ERP" + "C.Order No" | "AMOUNT IN VALUE" + "Total Qty." | "Net Amount Payable" + "Total Basic Amount" |
| Item row | `1. 33049930 <name> <cases> 300ML <qty> - <batch> 10/26 9/28 <mrp> <rate> <dis> 18.00% <igst> <amount>` | `<qty> <amount><hsn> <name>` then `<sn> … <mrp> 18.00 <gst amt><rate>Nos <batch>FGC-<n>` | `1 <hsn> <material> <taxable> 18.00 <gst> <freight><qty><batch>1X<pack> <gross>…`; the SKU code is wrapped over the next lines |
| SKU code | from `C.Order No : MPO-…(MCaf370)`, used only when exactly one code is printed | not printed; matched by product name in review, as with Nanonets today | printed (e.g. `DNDMUBX0002F0250`, split across two lines) |
| Extra cross-check | "Total Qty", SUB TOTAL | "Total Qty.", Taxable Amount | Total Basic Amount, the "Material Amt … Gross Value" row |
| Invoice no / date | `Invoice No : CM001133 Date : 11-10-2026` | `SB/2236/26-27`, `Invoice Date 06/10/2026` | `MBA2627/GIS00474`, first date line |

Each layout is a new file beside `cheryl.ts` and `jainam.ts`, and is added to `LAYOUTS`
ahead of `tally`, since tally's matcher is the loosest. Unit fixtures are hand-written, as
in `tests/unit/invoice-local-layouts.test.ts`; real invoices stay out of git.

## The replay check (how each gate is proven)

A scratch script, run read-only against prod. It does not ship.
1. For each of the manufacturer's invoices, read its PDF from S3 and parse it locally.
2. Compare the result with the lines that were committed (`invoice_items_mfg`), on total
   qty, rate and amount **per batch**. Per batch because reviewers sometimes split a line
   by reference PO: NG `MBA2627/GIS00475` has one printed row of 5,664 but was stored as
   5,404 + 260.
3. Report each invoice as one of:
   - **match** — correct;
   - **refused** — fine, it falls back to Nanonets;
   - **mismatch** — blocks the ship.

## Risks

| Risk | Mitigation |
|---|---|
| A column boundary is read wrong where numbers run together (Samrvir `97041.6073.250` = GST 97,041.60 + rate 73.250; NG `0.0003984.000` = freight 0.000 + qty 3,984) | Split by the decimal places each column always has (2 vs 3). Any misread fails qty × rate = amount and the total, so the result is a refusal, not a wrong number |
| The supplier changes the template | The matcher no longer fits, or a check fails, so it goes to Nanonets as today |
| Samrvir's older template (before 1 Oct) | Not supported: it fails the matcher or the row checks, so it goes to Nanonets |
| An NG pack suffix that is not `1X…` | No row is read, so the numbered-row check refuses it |
| Cimera invoice with two SKUs | The SKU is taken only when `C.Order No` names exactly one. Otherwise it is left blank for name matching, as Nanonets does |
| NG's second plant (`MB2…`) and Cimera's scanned PDFs have no text layer | Unchanged: Nanonets. Out of scope |

## Not in this plan

The other fixes from the slowness investigation are separate and come after this:
- deduplicating repeat parses of the same PDF;
- a Nanonets timeout;
- enforcing the per-user concurrency cap;
- the tally e-Way refusals (Reve, Kain, Ananya).

## Decisions (owner: Ajay)

| # | Question | Recommendation |
|---|---|---|
| D1 | Order | **Decided:** Cimera → Samrvir → NG Electro, one commit each |
| D2 | Who writes it | **Decided:** Ajay codes it from Claude's snippets. Each snippet is pre-checked by replaying all prod invoices against a scratch copy of the parser |
| D3 | Samrvir's pre-October template | Skip it: no invoice since 30 Sep uses it |
