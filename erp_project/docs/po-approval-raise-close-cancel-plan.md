# Normal POs, short close and cancel go for approval

## Today

| Action | Approval today |
|---|---|
| Raise impromptu / NPD / Tech Transfer / CPR | ✅ `PO` |
| Bulk CSV (new rows, and the status column) | ✅ `PO_BULK` |
| Edit a Draft PO | ✅ `PO_EDIT` |
| **Raise a normal PO (Add PO)** | ❌ goes straight to `raised` |
| **Short close** | ❌ direct, one PO at a time |
| **Cancel** | ❌ direct; the reason typed is not even stored |

## What changes

**1. Raising a normal PO works exactly like an impromptu one.**
- The PO is saved as an unapproved draft with a `PO` approval, through the same path, handler and approval card impromptu POs already use.
- Approve makes it `raised`. It then reads Draft until someone mails it, as today.
- Reject makes it `rejected`; the raiser can edit and resubmit.
- PO numbers keep the `PO` prefix.
- **What people will notice:** like an impromptu PO today, a submitted normal PO is not in PO Tracking until it is approved. It can only be seen in Approvals. Add PO's success message will say "sent for approval".

**2. Short close and cancel become requests.** The menu actions and dialogs stay where they are.
- The button now submits a request. One new module, `PO_STATUS`, covers both, and the approval card says which: short close or cancel.
- **A reason is required for both,** and the approver sees it.
- On approval the reason is stored in the PO's history beside the status change. Today it is thrown away.
- The rules are checked twice, at submit and again at approve, on the locked PO and its splits. Example: if goods were received against a PO after its cancel was submitted, the approval is refused, and the approver rejects it or asks for a short close instead.
- **While a request is pending,** the PO shows **In Review**, the same badge a pending edit uses, and four things are refused:
  - a second close or cancel request;
  - edit;
  - discard;
  - send-mail.

  Send-mail must wait because a pending cancel mailed now would reach the manufacturer as a live order.
- **Receipts are not blocked.** Invoice inwarding still credits the PO, because a delivery that has arrived has arrived. FIFO allocation is untouched.

**Not changed:**
- **Splits:** a split of an approved PO stays direct.
- **Discard:** discarding a never-mailed PO stays direct.
- **Inward POs:** the POs made from invoices are not affected.
- **The bulk CSV:** already goes through approval.

## Decided 2026-11-05

1. **Self-approval:** allowed unless every role the person holds is an Executive one (`*_executive`). Head, Lead, admin and developer may approve their own. This applies to every `PO` approval (normal, impromptu and special) and to `PO_STATUS`. `lib/approvals/self-approval.ts`.
2. **Reason:** required for both short close and cancel.
3. **POs already in flight:** normal POs raised before the switch stay as they are. Nothing is converted.

## Sequencing and gates

1. ✅ **Code on dev (2026-11-05).** tsc, 1190 unit tests, every PO and approval DB test (5 new), lint gate and build all pass. No DDL is needed: `approvals.module` is a VARCHAR, and every status involved already exists.
   - DB tests:
     - a normal raise stages an approval;
     - approve and reject both behave;
     - a cancel is refused at approve when something was received in the meantime;
     - a pending close or cancel blocks send-mail.
   - Checks: tsc, unit tests, DB tests, lint, build.
   - ⛔ Then your click-through on dev.
2. **Prod deploy** with your go-ahead. **Tell the approvers first:** every normal PO now waits on them.

## Risks

- **Throughput.** Every normal PO now needs an approver before it can be mailed. If approvers are slow, POs reach manufacturers later. The Approvals page is the only queue.
- **Invisible while pending.** A raiser may raise the same PO twice, not seeing the first. The existing duplicate check (one live PO per mfg × SKU for special types) does not cover normal POs.
- **Approve-time refusals.** A cancel approved after a receipt fails with a clear message rather than silently short-closing. The approver has to reject it.
