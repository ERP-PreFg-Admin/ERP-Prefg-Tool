# Invoice parsing is slow — findings and plan

**Status:** #1 and #2 built 2026-10-21, uncommitted. #3 (timeout) dropped by Ajay.
- #1: a replay of all 518 prod invoice PDFs gives 36 new local parses (Reve 29, Kain 4, Ananya 3) and 0 changed results. 35 of the 36 match the stored qty and amount totals. RP/L/26-27/1256 has a line (4,944 units, ₹1,98,402.72) that is on the PDF but not in the stored invoice.
- #2: only Nanonets answers are cached (local parses are already ~0.1 s), so a parser fix takes effect at once. A cache hit is logged as `source: nanonets:cache`. The S3 round trip on dev hit in 114 ms.

## What's slow (prod, 15–21 Oct, 145 parses, from the S3 parse events)

| Path | Parses | Median | Slowest 10% | Max | Total waiting |
|---|---|---|---|---|---|
| Local text layer | 100 (69%) | 0.1 s | 0.2 s | 0.4 s | 12 s |
| **Nanonets** | **44 (30%)** | **39 s** | **93 s** | **132 s** | **~30 min** |
| Failed | 1 | — | — | 302 s | 5 min |

**All of the waiting is Nanonets.** It used to answer in 7–9 s, and now takes 40–130 s.

The local NG Electro / Samrvir / Cimera layouts (c297d30, v0.1.22) have been live since 15 Oct, about 10:30 UTC. Before that, 14 NG and 3 Cimera parses still went to Nanonets; a replay shows all of them now parse locally.

**Since the deploy, 17 parses went to Nanonets:**

| Cause | Parses | Manufacturers |
|---|---|---|
| **The e-Way goods row is misread** — the CGST+SGST rate is glued to the amount and split at the wrong place | **13** | Reve, Kain, Ananya |
| Scanned PDF with no text layer | 4 | Archeesh, NG Electro (2) |

**The bug:**
- `lib/invoice/local/eway.ts` reads the e-Way row's value tail with `VALUE`, whose rate group takes 1–2 digits after `+`.
- `9+916,41,873.80` has rate 9+9 and amount 16,41,873.80. It is read as rate `9+91` and amount `6,41,873.80`.
- That amount pairs with no invoice line, so the gate refuses and the invoice goes to Nanonets.
- Kain (`9+973,515.20` → `3,515.20`) and Ananya (`9+944,060.40` → `4,060.40`) fail the same way.
- It refuses rather than misreads, so no wrong data came of it. It only costs time.

**Two things make it worse:**
- **The same PDF is parsed again and again.** Twelve files were parsed 2–5 times each: `1890.pdf` 5 times, `Kreative 1223` 3 times in 3 minutes. Repeats of Nanonets files cost about 12 of the 35 minutes.
- **There's no timeout on the Nanonets call** (`lib/nanonets/client.ts`). On 16 Oct, `AH/26-27/919` hung for 302 s, until `maxDuration` cut it off with "fetch failed". The user retried and waited another 132 s.

## Plan — in order of payoff, each its own commit and gate

| # | Change | Where | Gate |
|---|---|---|---|
| 1 | **Read the e-Way rate as a real GST slab** (`9+9`, `6+6`, `14+14`, `2.5+2.5`, or `5`/`12`/`18`/`28`), longest match first, instead of "1–2 digits". The amount pairing and every other check stay as they are | `lib/invoice/local/eway.ts`, plus a unit fixture per manufacturer | Replay every prod invoice for Reve, Kain, Ananya and every other tally-layout manufacturer. **Zero mismatches**, and the 13 refusals now parse |
| 2 | **Cache parse results by the PDF's SHA-256** for 24 h, so a repeat is answered in milliseconds and makes no new Nanonets call. Stored as JSON under `parse-cache/<sha256>.json` in the events bucket: it survives a restart and needs no DDL. Only successful parses are cached | `app/api/v2/purchase-orders/invoice/parse/route.ts` | Unit test of the key and lookup; parse one file twice on dev and the second is under 1 s |
| 3 | **Time out Nanonets at 150 s** (`AbortSignal.timeout` on upload and extract), with a clear message: "Nanonets didn't answer in 2½ minutes — retry or fill it in manually" | `lib/nanonets/client.ts` | Unit test with a stubbed slow fetch |

**Expected effect:** from 17 Nanonets parses in the week since the deploy down to the 4 scans. No repeat ever waits twice.

**Not in this plan:**
- **Scanned PDFs (4/week).** Nanonets is the only reader for those; `docs/scanned-invoice-ocr-plan.md` covers it.
- **Nanonets' own latency.** It's outside our control.
- **Cheryl `CLAR/2627/1890` and `1891`.** Two pre-deploy refusals ("line sum does not reconcile", "no line items"). These are a separate small layout fix.

## Gates and checks

`npm test`, `tsc --incremental false`, ESLint on the changed files, then deploy. For a week afterwards, track the local share of parses in `processed-events/PO_INVOICE_PARSE` (`source`).

## Decisions (owner: Ajay)

| # | Question | Recommendation |
|---|---|---|
| D1 | Do all three, or only #1? | **All three.** #1 is the big win, and #2 and #3 are small |
| D2 | Who writes it: snippets for you, or I edit the files? | Your call; last time it was "You write code for all" |
