# Uniware sync on a schedule

Today the Uniware status and GRN sweeps only run when someone presses the button. This plan puts them on the existing hourly cron, so PO status, received qty and cancellations stay current without anyone pressing anything.

## Where things stand (prod, 2026-11-05)

- **980** live invoices have a Uniware PO. **276** of them are due for a check right now; **678** have not been checked for over a day.
- About **32** new invoices a day.
- One run checks at most **150** POs, least-recently-checked first, so a few runs a day keep everything current.

## What runs

Two jobs, added to the cron's job list in this order (status must run first, because it records how many GRNs each PO has, and the GRN job reads that):

| Job | What it does | Per run |
|---|---|---|
| `uniware-status` | The same sweep as the admin "sync everything" button: status, pending/QC qty per line, GRN count; cancels our inward POs when Uniware cancelled the PO; pulls GRNs for up to 25 POs that have them. | 150 POs |
| `uniware-grn` | Picks up the GRNs the status job had no time for. | 40 POs |

No new Uniware calls: both jobs call the same code the buttons already call. Documents sync is left out; on prod it is switched off.

## Schedule (to decide)

Recommended: **10:00, 13:00, 16:00, 19:00 IST**. That is roughly every 3 hours across the warehouse day, about 600 PO checks a day against 276 due. The 02:00, 08:00 and 23:00 slots, which other jobs use, are left free.

## Sequencing and gates

1. **Code (dev).**
   - Move the status sweep out of its route into a shared function. The button and the cron then run one copy of the logic: the cron must never call a route over HTTP.
   - Register the two jobs.
   - Checks: tsc, unit tests, lint, build.
   - ⛔ Your review.
2. **Test box.** It is pinned to the sandbox Uniware facility, so a run there touches only TEST_FACILITY. Trigger one cron run by hand over SSM and read the result in the logs. ⛔ Your go-ahead to deploy to prod.
3. **Prod.** Deploy. Nothing changes on the host: the hourly timer already exists. Watch the first scheduled run's log line ("Cron job finished", with counts).

## Risks

- **Automatic cancellations.** When Uniware says a PO is cancelled, the status sweep cancels our inward POs for it. It already does this on every button press; on a schedule it simply happens without anyone watching. Each one is logged with the PO code.
- **Load on Uniware.** About 150 sequential calls per run, at the same rate the button runs today. The warehouse uses the same tenant, so runs stay outside the busiest hour or so only if you choose the schedule that way.
- **Run length.** One run takes a few minutes. The timer allows 30 minutes in total, and a second trigger is refused while one is running, so runs cannot overlap.
- **A failure is quiet.** A failed PO is logged and skipped; the run carries on. Nobody is told unless they read the logs. A follow-up could put the counts in the 23:59 digest mail.
