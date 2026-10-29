# Scheduled jobs, phase 1: Uniware GRN sync and data checks

**Status:** plan, awaiting go-ahead. 2026-10-28.
**Scope:** two new entries in `lib/cron/jobs.ts`. The status sync, document sync, DWH SKU sync and facility catalog sync are later phases and out of scope here.

## Why these two first

- **Both are read-only toward the outside world.** GRN sync reads Uniware and writes only our mirror (`grn_uniware`, `grn_items_uniware`, `invoice_mfg.uniware_grn_count`). It never touches `purchase_orders` (see the header of `lib/uniware/grn-sync.ts`). Data checks only read the database and send a mail.
- **The work already exists.** `runGrnSync` is a `lib/` callable built for this, and the route is a thin wrapper around it. Most of the data checks are queries we already have, or ones that came out of this week's fixes.

## Sequencing and gates

| Step | What | Owner | Gate before the next step |
|---|---|---|---|
| 1 | Data checks job, registered **off** (`DATA_CHECKS_ENABLED` unset) | Claude | Unit tests for the mail body. A dry run against prod prints today's findings, and Ajay agrees which ones are real. |
| 2 | Decide the noise rules: which existing findings are accepted and which get fixed (see "Today's findings") | Ajay | Every check is either clean or has an agreed exclusion. A mail that is noisy on day one gets ignored by day three. |
| 3 | Add `data_checks` to `REPORT_CODES` and its `entity_emails` rows on **prod** | Ajay (rows), Claude (code) | Without the rows the job runs and mails nobody. This already happened once, to the daily digest (memory: prod had no report rows until 2026-10-05). |
| 4 | Release, set `DATA_CHECKS_ENABLED=1` on prod | Ajay | First mail arrives at 08:59 IST; the `{ $.module = "CRON" }` CloudWatch line shows `data-checks` ok. |
| 5 | GRN rotation fix (see below): DDL on **dev only**, then stop | Claude | Ajay's separate go-ahead for prod DDL. |
| 6 | GRN sync job, behind `GRN_SYNC_ENABLED`, prod only | Claude | One manually triggered run on prod (`systemctl start erp-cron.service` over SSM, with Ajay's OK) reports `failed` near 0 and completes within budget. |
| 7 | Enable GRN on schedule | Ajay | A week of runs with no growing `failed` count, and the 08:00 low-open-PO report reads fresh receipts. |

Steps 1–4 and 5–7 are independent. Data checks ship first because they need no DDL and no Uniware access.

## Job 1: data checks

**When:** daily, IST hour 8 (fires 08:59), after the low-open-PO report.
**Mail:** only when at least one check has findings, sent to `entity_emails` type `report`, code `data_checks`. Every run also logs its counts, and the 23:59 digest gains one line ("Data checks: N findings"), so a silent morning means "clean", not "broken".
**Shape:** one section per check. Each shows a count, the first 20 rows and the fix-it page.

| # | Check | Why it matters (evidence) | Query |
|---|---|---|---|
| 1 | SKUs whose brand is blank or names no brand | A NULL brand puts the PO on the Pep letterhead with no facility. This is the HYP-IMP-202610-001 cause. | `skus.selectUnmatchedBrands` (exists) |
| 2 | SKUs whose `brand_id` disagrees with their brand text | Catches a DWH sync that rewrites brand text, e.g. the 3 Fien SKUs the DWH still lists as mCaffeine. | new, a variant of `syncBrandIds` that SELECTs instead |
| 3 | Open POs whose destination × brand entity resolves to no facility | No facility means the wrong delivery address and no Uniware push. | new; restricted to POs **with a destination** (see findings) |
| 4 | Variant families whose recipes disagree on RM version | The invariant in CLAUDE.md; it should always be zero. | `bom.selectVariantFamiliesWithRmDrift` (exists) |
| 5 | One Uniware vendor code held by two manufacturers at a facility | The only guard is application code since `uq_wh_code` was dropped; this audits that it held. | new, `GROUP BY wh_id, un_mfg_code HAVING COUNT(DISTINCT mfg_id) > 1` |
| 6 | Facility GSTIN whose PAN differs from its legal entity's PAN | Found today: Kreative Bangalore prints Pep's GSTIN on the PO. | new, compares GSTIN chars 3–12 with `master_entity.pan` |
| 7 | Approved POs still unmailed after 2 days | They read as Draft; the manufacturer has never seen the order. | new |
| 8 | Legal entities missing bank details | The "Company Bank Details" box is blank on every PO. | new |

These are left out of phase 1 on purpose, to keep the mail short. Each can be one more row later:
- overdue open POs (13 on prod today; that's an ops list rather than a data error, and the digest is the better home);
- pending approvals older than N days (0 today);
- SES bounces.

### Today's findings on prod (read-only run, 2026-10-28)

| # | Count | What it means | Decision needed |
|---|---|---|---|
| 1 | 0 | Clean since today's brand fix. | — |
| 3 | 289 | **All 289 have no destination**: legacy POs from before the destination column. 4 of them are DND, a brand with no legal entity. | Exclude `destination IS NULL`, or close out the legacy POs. Recommend excluding. |
| 4 | 0 | — | — |
| 5 | 0 | — | — |
| 6 | 8 | Kreative's Ahmedabad, Bangalore, Chennai, Guwahati, Hyderabad (×2), Kolkata (×2) and Nagpur facilities carry **Pep's** GSTIN as the ship-to. | Ajay: is that deliberate (Kreative goods received under Pep's state registration), or wrong data? If deliberate, the check compares bill-to only. |
| 7 | 1 | `MPO-OO113493`, dated 2026-08-13. | Mail it or cancel it. |
| 8 | 2 | Pep and Kreative have no bank details. | Ajay to supply them. |

## Job 2: Uniware GRN sync

**When:** IST hours 7, 11, 15 and 19 on prod. 7 lands before the 08:00 low-open-PO report.
**Test box:** off. Its invoices are dev data and the tenant is shared; there's nothing to gain.

### The blocker: the batch never moves past the newest 40

`uniwareGrn.selectForGrnSync` is `ORDER BY si.id DESC LIMIT ?` with `MAX_PER_RUN = 40`. Prod has **692** eligible invoices. Run on a schedule as it is, it would re-sync the same newest 40 four times a day, and the other 652 would never be refreshed. That's fine for a button, which is what it was written as, but wrong for a sweep.

**Fix (recommended): rotate by last-synced time.**
1. DDL: add `invoice_mfg.uniware_grn_synced_at DATETIME NULL`. Dev first; prod on its own go-ahead. Not re-runnable (MySQL 8, no `ADD COLUMN IF NOT EXISTS`).
2. `syncGrnsForInvoice` stamps it after a successful sync. A failed PO is not stamped, so it's retried first next time.
3. The order becomes `ORDER BY si.uniware_grn_synced_at IS NOT NULL, si.uniware_grn_synced_at, si.id DESC`: never-synced first, then oldest-synced.

At 40 per run × 4 runs a day, the whole set turns over about every 4 days. Recent invoices, where receipts actually change, are the never-synced ones and so go first.

**Rejected alternative:** limit to invoices from the last N days. It needs no DDL, but a late GRN against an older invoice would never be seen, and that's exactly the disagreement the feature exists to surface.

### Other changes

- **Overlap with the button.** The cron route's `running` flag and the button route's `concurrency: 1` limit are separate, so a cron sweep and a click can run together over the same rows. Take `GET_LOCK('uniware_grn_sync', 0)` inside `runGrnSync`, and skip the run with a logged reason if it's held.
- **Enable flag** `GRN_SYNC_ENABLED`, the same pattern as `TRACE_EXTRACT_ENABLED` in `lib/env.ts`, and check `uniwareEnabled()` too.
- **Alerting.** Log the result, which already carries `failed`, `truncated` and `unmatchedLines`. Mail only if `failed` is more than half the batch: that pattern means the IP whitelist or credentials broke, not one bad PO. `unmatchedLines > 0` goes into the next morning's data checks mail as an extra section, not a mail of its own.

## Risks

1. **Uniware load.** Each run is up to 40 × (1 + receipts) calls against the tenant the warehouses work in. It's staggered off test (`:29` vs `:25`) and kept to 4 runs a day. Measure the first run's `ms` before adding more.
2. **Run time.** The timer's curl allows 1800 s for *all* jobs due that hour. GRN at hour 7 runs alone; keep it off hour 2, where trace extract and snapshots already run.
3. **Noise kills the mail.** Step 2 exists for this reason. Every check has to be clean or carry an agreed exclusion before the mail goes live.
4. **The prod cron units exist only because they were hand-installed** (2026-10-06). A replacement box gets them from bootstrap; nothing else does. No change is needed here, but it's worth knowing if a run never shows up.
5. **Release dependency.** Prod runs v0.1.26. Neither job does anything until a release carries it and the env flag is set. The flags make deploying and enabling two separate steps, on purpose.

## Verification

- `npm test`: unit tests for the data-check mail rendering (empty → no mail; findings → sections with counts and the 20-row cap).
- `npm run test:db`: rotation order (never-synced first, a failed invoice not stamped), and the lock skipping a concurrent run.
- Prod dry run of the data checks printing today's table above, run read-only before enabling.
- After enabling: the CloudWatch `{ $.module = "CRON" }` lines for `grn-sync` and `data-checks`, and `uniware_grn_synced_at` filling in across runs.
