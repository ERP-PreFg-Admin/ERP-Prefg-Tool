# Email observability — plan

**Ask:** on `/observability/infra`, a metric showing how many emails went out, where each
one was initiated from, and what happened to it afterwards.

**Approach:** read AWS directly. No new table. Revised 2026-09-17 after the question
"can we do it without a new table and use AWS straight away" — the answer is yes, with the
caveats in §5.

**Status:** plan only. No code, no AWS changes. Waiting on go-ahead.

---

## 1. What exists today

Three send paths, all through `lib/mail/mailer.ts`:

| Function | Initiated by | Call site |
|---|---|---|
| `sendMfgSelectionEmail` | a user pressing Mail in PO Procurement | `app/api/v1/purchase-orders/send-mail/route.ts:79` |
| `sendSplitPoEmail` | same press, one mail per raised split | `app/api/v1/purchase-orders/send-mail/route.ts:92` |
| `sendInwardInvoiceEmail` | automatic, step 5 of invoice inward | `lib/invoice/invoice-inward.ts:529` |

What each send leaves behind:

- **Winston line** to CloudWatch Logs `/erp-app/{env}` — `"… sent successfully"` or
  `"… send failed"`, with `eventId`, `mfgId`, recipients.
- **S3 event** under `raw-events/`, `processed-events/`, `failed-events/`. Write-only in
  practice; nothing reads them back.
- **Nothing in MySQL.** `purchase_orders.email_sent_at` is a per-PO stamp, not a per-mail record.

What happens *after* the send:

- SES config set `erp-app` → SNS → `app/api/v1/webhooks/ses/route.ts`.
- Permanent bounces and complaints become rows in `email_suppressions`.
- **Every other event — deliveries, transient bounces, rendering failures — is logged to
  CloudWatch anyway** (`route.ts:157`) with `eventType`, `sesMessageId` and `destination`.
  It is dropped from the database, not from AWS.

That last point is what makes this buildable without a table. The outcome data is already in
the log group; nothing aggregates it.

### The one real gap

`getTransporter().sendMail()` returns a result carrying the SES `messageId`. All three send
sites throw it away (`mailer.ts:472`, `:591`, `:795`), so the send line and the webhook's
outcome line share **no key**. Until the send logs its `messageId`, "what happened to *this*
mail" cannot be answered from any source, table or otherwise.

---

## 2. Where each fact comes from

| Fact | Source | How |
|---|---|---|
| How many sent | `AWS/SES` CloudWatch metrics | `GetMetricData`, already wired |
| Where initiated | custom SES **message tag** on each send | becomes a metric dimension |
| What happened | same metrics — Delivery / Bounce / Complaint | same call |
| Which specific mail | CloudWatch Logs Insights over `/erp-app/{env}` | join on `sesMessageId` |

**Message tags are the trick.** SES publishes its metrics dimensioned by whatever tags the send
carries, so tagging each send `flow=po_selection` / `po_split` / `inward_invoice` turns "where
was it initiated" into a dimension AWS aggregates for us. No row, no write, no schema.

Two candidate mechanisms — **one must be proven on test before the plan hardens** (§3, Phase 0):

1. `EmailTags: [{ Name, Value }]` merged into the SESv2 `SendEmailCommand` via nodemailer's
   `ses` option — the same channel `ConfigurationSetName` already travels through
   (`mailer.ts:90`).
2. The `X-SES-MESSAGE-TAGS` MIME header, set through nodemailer's `headers`.

Assume neither works until one is observed producing a dimensioned datapoint. Tag values are
alphanumeric/dash/underscore only.

---

## 3. Sequencing and gates

**Phase 0 — prove the tag, on test.**
Before anything else. Add a CloudWatch event destination to the `erp-app` config set, send one
tagged mail from the test instance, confirm a datapoint appears under
`AWS/SES` with the `flow` dimension.
*Gate:* that datapoint exists. If neither mechanism in §2 produces one, this whole approach
fails here and §7 is the fallback — that is the point of doing it first and cheaply.
*Note:* must run from the EC2 instance, not locally.

**Phase 1 — the config set, properly.**
CloudWatch event destination on `erp-app` for `send`, `delivery`, `bounce`, `complaint`,
`reject`. AWS-side config, one CLI call, `AWS_PROFILE=erp`. Recorded in `deploy/` so it is
reproducible rather than console-only folklore.
*Gate:* `aws sesv2 get-configuration-set-event-destinations` shows both the existing SNS
destination and the new CloudWatch one. **The SNS one must be untouched** — it is what feeds
suppression.

**Phase 2 — tag the sends, log the messageId.**
Three sites in `mailer.ts`: capture `sendMail()`'s return, add `sesMessageId` to the existing
success log line, attach the `flow` tag.
*Gate:* a send from test produces a log line carrying `sesMessageId`, and the webhook's line for
the same mail carries the matching id. That match is the join; without it Phase 4 has nothing.
*Hard constraint:* a missing or malformed tag must never fail a send. Tag construction is a
constant per call site, not computed, so there is nothing to throw.

**Phase 3 — the metric panel.**
`lib/services/email-metrics.ts` reading `AWS/SES` via the existing `getMetricData`, rendered on
`app/observability/infra/page.tsx` under the `hours` toggle the page already has.
*Gate:* panel counts reconcile against the SES console for the same window.

**Phase 4 — per-message detail (optional, decide after Phase 3).**
Logs Insights query joining send lines to webhook lines on `sesMessageId`. Only worth building
if the metrics panel turns out not to answer the real questions. See §5 on why this one is not
free.

---

## 4. Governance

- **Access.** The panel sits on `/observability`, already gated by `resolveAccess`. No new
  permission.
- **Recipient data.** Metrics are counts — no addresses, so Phase 3 carries no PII at all. Phase
  4 is different: the log lines contain recipient addresses, so any per-message view shows the
  manufacturer and the outcome, not the raw address.
- **IAM.** Phase 3 needs `cloudwatch:GetMetricData` on `AWS/SES`, which the runtime credential
  already has (it reads `ERP/EC2` and `AWS/RDS` today). Phase 4 would need
  `logs:StartQuery`/`GetQueryResults` — new, and to be added as its own reviewable statement
  beside `deploy/iam-policy-erp-app-runtime-ses.json`.
- **Retention.** Metrics: 15 months, AWS-managed, nothing to prune. Log group: no retention set
  in `deploy/bootstrap-instance.sh:50`, so it is defaulting to never-expire — **confirm in the
  console and set one deliberately**, which is a standing gap this plan surfaces rather than
  creates.
- **Boundary.** `app/observability/infra/page.tsx` reads `lib/services/email-metrics.ts` only.
- **No route deletions.** The SES webhook is read from, not modified. This approach touches it
  not at all, which is its main advantage: the only unauthenticated write path in the app stays
  exactly as reviewed.

---

## 5. What this costs, honestly

| | Consequence |
|---|---|
| **No dev gate** | Dev sends over Gmail, which emits no SES events. Nothing here can be tested on dev — Phases 0–4 all prove out on test. This is the single biggest downside |
| **Aggregates, not records** | Metrics answer "3 bounced on po_selection in this hour", never "this mail to this manufacturer bounced". Phase 4 recovers that, at a price |
| **Logs Insights is not free** | `StartQuery` + poll, billed per GB scanned. `lib/aws/cloudwatch.ts:119` avoided it on purpose. Phase 4 adds async polling to a page that is currently one synchronous call |
| **Cardinality ceiling** | `flow` has three values, fine. Per-manufacturer or per-user as a dimension is not — that road ends at §7 |
| **15-month horizon** | Beyond that the history is gone. Acceptable for an ops panel; would not be for an audit record |
| **Config lives in AWS** | The tag means nothing without the event destination. A rebuilt config set silently empties the panel — hence Phase 1 recording the CLI call in `deploy/` |

---

## 6. Shape of the change

**Touched files** — four, none of them schema:

| File | Change |
|---|---|
| `lib/mail/mailer.ts` | three send sites: capture `messageId`, log it, attach the `flow` tag |
| `lib/services/email-metrics.ts` | new — `AWS/SES` panels, same result shape as `getInfraMetrics` |
| `app/observability/infra/page.tsx` | the panel |
| `deploy/` | the config-set CLI call, recorded |

**The panel** — same idiom as the page's existing sparklines, nothing new invented: sends over
the window, one line per flow; beside it delivered / bounced / complained. A bounce rate that
moves is the thing worth seeing, and SES publishes `Reputation.BounceRate` directly.

---

## 7. Fallback, if Phase 0 fails

If message tags cannot be made to produce a dimensioned metric, "where initiated" has no AWS-side
home and the choice narrows to: metrics without the flow breakdown (counts and outcomes only,
still useful), or the `email_log` table from the previous revision of this plan — recoverable
from git history rather than re-argued here.

Do not start there. Phase 0 is an afternoon and it decides the question.

---

## 8. Open questions

1. Should the panel live on **Infra** or **Business**? Asked for on Infra, and mail delivery is
   plumbing, so Infra. Flagged only because "how many POs did we mail this week" is a business
   question wearing an infra hat.
2. Is Phase 4 wanted at all, or do aggregate counts answer the real question? Cheaper to decide
   after seeing Phase 3 than before.
3. Log-group retention (§4) — a decision that is overdue independently of this work.
