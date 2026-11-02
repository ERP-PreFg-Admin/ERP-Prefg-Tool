# Invoice extraction: Nanonets vs AWS alternatives (comparison)

Status: step 2 done 2026-11-02. The bench lives outside the repo in `Desktop\ERP Project\extraction-bench`.

**Step 2 result:**
- **Saved Nanonets answers:** only 23 of 665 October invoices have one; the cache started late October.
- **Ajay chose option A:**
  - The test set is every live October invoice whose parse went to Nanonets: **168**, taken from the prod logs and matched by file name, user and the latest parse before the save. 664 of 665 invoices matched.
  - Nanonets is scored directly on the 23. Everything is scored against the e-Way bill.
- **Mix by manufacturer:** NGE 59, Reve 46, Samrvir 27, Cimera 11, Cheryl 7, Anantam 6, others 12.
- **Why our own parser refused them:**
  - unknown layout: 95;
  - no line items: 39;
  - e-Way bill mismatch: 22;
  - scanned PDF: 12.

**e-Way truth** (`extraction-bench/src/extract-eway.mjs`; parsing copied verbatim from `lib/invoice/local/eway.ts`):
- **Coverage:** only **53 of 168** invoices print the e-Way goods table: Reve 45, Kain 4, Anantam 4. In all 53 the rows add up to the e-Way bill's own taxable total.
- **The other 115:** NGE, Samrvir, Cheryl, Cimera and the rest print only the e-Way bill *number*, and 12 are scans with no text.
- **Truth for those 115:** the desk's booked lines, with every disagreement checked against the PDF, plus the printed invoice total as an independent money check.
- **Scoring:** results are reported separately for "e-Way truth" (53) and "booked truth" (115).

## Why
- **Volume:** in October, 239 invoice reads went to Nanonets (29% of 839 uploads); our local parser read the rest.
- **The idea:** Ajay is considering a move to AWS.
- **This plan decides with numbers, not opinion:** each candidate runs on the same real invoices, is scored against what was actually booked, and the results come back as one table to decide from.
- **Nothing in production changes.** This is a read-only bench.

## Candidates
| ID | Candidate | What it is |
|---|---|---|
| N | **Nanonets** (baseline) | Today's path. Its answers are re-used from the S3 parse cache, so no new Nanonets credits are spent |
| B1 | **Bedrock, Claude Sonnet 5.5** | The PDF plus the *same* field list and instructions Nanonets gets (`lib/nanonets/builder.ts`), returning the same `ParsedInvoice` JSON |
| B2 | **Bedrock, Claude Haiku 4.5** | Same as B1 on the cheaper, faster model |
| T1 | **Textract AnalyzeExpense** | AWS's invoice API. Its generic fields are mapped into `ParsedInvoice`; batch, expiry and GSTIN only where they can be lifted from raw text |
| T2 | **Textract OCR → our local parsers** | Only for the scanned PDFs (21 in Oct): Textract supplies the missing text layer, then the existing parsers run as usual |

## Test set
- **Invoices:** every October invoice whose parse went to Nanonets.
  - Found from the prod log line "Extraction path resolved" (`source = nanonets`, with its filename), matched to `invoice_mfg.attachment_key`.
  - Only live (non-reverted) invoices are used. About 230 are expected.
- **PDFs:** read from S3, the same files the desk uploaded.
- **Two independent truths:**
  1. **e-Way bill goods rows**, printed in the PDF itself: quantity and taxable amount per item. These are independent of any parser and of the desk.
  2. **What the desk booked**, from `invoice_items_mfg`, summed per SKU and per (SKU, batch). This covers batch, expiry and rates.
     - It is human-checked but **biased towards Nanonets**: the desk started from Nanonets' answer and may have kept its mistakes (1557 and 1216 are known cases).
     - So any case where a candidate disagrees with the booking is checked against the PDF before it is scored.

## What gets scored
- **Per invoice:** invoice no., date, seller and buyer GSTIN, total — exact match.
- **Per item:** SKU found; quantity exact; rate and amount within 1%; batch exact; expiry same month.
- **Safety:** how many invoices the new quantity-vs-amount check (`lib/invoice/qty-amount-check.ts`) would block, a proxy for silent quantity errors.
- **Operations:** failures and refusals, seconds per invoice, and cost per invoice at list price.
- **The headline number:** % of invoices where **every item's quantity and amount** match the e-Way bill. That is what decides whether stock and money come out right.

## Sequencing and gates
| # | Step | Owner | Gate |
|---|---|---|---|
| 0 | Approve this plan and its budget | Ajay | Go-ahead |
| 1 | AWS access: check Textract AnalyzeExpense and both Claude models are offered in `ap-south-1`; enable model access in the Bedrock console; a **bench-only IAM user** (created 2026-11-02, after the inline policy on the app user didn't take effect), with `bedrock:InvokeModel` on the three models only and the Textract actions; delete it after step 5 | Ajay / AWS admin | One test call per service succeeds from the laptop |
| 2 | Build the test set + truths (read-only: prod DB, logs, S3) | Claude | Count reported. **Stop and report** if fewer than ~150 invoices still have a cached Nanonets answer (the cache started mid-October): Ajay decides whether to spend Nanonets credits re-running the rest or bench on fewer |
| 3 | The bench harness: `scripts/extraction-bench/` (local, untracked), one adapter per candidate, results to a local CSV | Claude | Dry run on 10 invoices; Ajay eyeballs the per-invoice report |
| 4 | Full run, all candidates | Claude | Spend stays within the approved budget |
| 5 | Check disagreements against the PDFs; publish a results page (table + worst cases) | Claude, with the desk for any unclear PDF | Ajay reads it |
| 6 | Decision: switch, keep, or mix (e.g. Bedrock for unknown layouts, T2 for scans) | Ajay | A separate build plan if anything changes |

## Cost (to confirm at step 1)
- **Textract:** about $0.01 per page for AnalyzeExpense. ~230 invoices × ~3 pages ≈ **under $10**.
- **Bedrock:** priced per token. A 3-page invoice is a few thousand tokens, so roughly a few cents per invoice on Sonnet and much less on Haiku: **about $5–20** for the run.
- **Nanonets:** zero if the cache covers the set; otherwise one credit per re-run (step 2 gate).

## Risks
- **Ground truth favours Nanonets.** This is handled by using the e-Way bill as the primary truth and checking every disagreement against the PDF.
- **The cache may not cover early October.** The step 2 gate stops the run before any credit is spent.
- **Sending invoices to AWS services.**
  - In Mumbai, every candidate model is offered only through a cross-region profile.
  - **Ajay, 2026-11-02:** Asia-Pacific (`apac.`) processing is acceptable; `global.` profiles are not used.
  - Profiles offered from Mumbai: Haiku 4.5 `in.` (India) and `global.`; Sonnet 5.5 `global.` only; Nova Lite `apac.`. So Haiku runs via `in.`, and Sonnet 5.5 can't be benched under this rule.
  - Textract runs in Mumbai itself. Bedrock does not train on inputs. Nanonets already receives the same PDFs today.
- **The bench is not production.** A winner still needs its own plan: quota, retries, timeouts, cost cap, and the review screen. Nothing here touches the parse route.
- **Prompt tuning favours whoever is tuned.** B1 and B2 get Nanonets' instructions verbatim and no extra tuning for the first run, so the comparison is fair. Tuning is a separate round if Bedrock is close.

## Out of scope
- Changing the parse route.
- Retiring Nanonets.
- Teaching the local parser new layouts (raised separately: Reve's batch layout, and the 130 calls where the supplier wasn't identified).

## Questions for Ajay
1. **AWS access (step 1):** decided, a bench-only IAM user (created 2026-11-02).
2. **Budget:** is about $30 total for the run OK, plus Nanonets credits only if you approve them at step 2?
3. **Models:** Sonnet 5.5 and Haiku 4.5, or only one?
4. **Checking against the PDF:** can someone on the desk (e.g. Yogesh) settle the few PDFs I can't read clearly?
