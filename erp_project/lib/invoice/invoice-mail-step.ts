// What the warehouse-mail step reports. Pure, and separate from
// lib/invoice/invoice-inward.ts for the usual reason — that module reaches
// lib/db, so a unit test cannot import it, and the wording here IS the feature.
//
// Three outcomes, not two. "Sent, but without the Uniware PO" used to report as
// a clean success, which is how nobody noticed that /po/show renders only at
// GGN_WAREHOUSE and the other 17 facilities never get the attachment.

import type { StepEvent } from "./invoice-inward"

export type MailOutcome = { sent: boolean; missingPoDocument?: string }

export function describeMailStep(mailed: MailOutcome, destination: string): StepEvent {
  if (!mailed.sent) {
    return { step: "email", status: "skipped", message: `No email on file for ${destination}` }
  }
  if (mailed.missingPoDocument) {
    return {
      step: "email",
      status: "warning",
      message: `${destination} notified, but the Uniware PO was NOT attached — ${mailed.missingPoDocument}`,
    }
  }
  return { step: "email", status: "ok", message: `${destination} notified` }
}
