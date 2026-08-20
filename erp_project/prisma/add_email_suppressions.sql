-- Email suppression list — addresses SES told us not to send to again.
--
-- WHAT
--   New table `email_suppressions`, one row per address. Written by the SNS
--   webhook at app/api/v1/webhooks/ses/route.ts when SES reports a permanent
--   bounce or a complaint, and read by resolveRecipients() in lib/mailer.ts,
--   which drops suppressed addresses from both the To and the CC list.
--
-- WHY
--   Until now a wrong address in entity_emails failed silently: nodemailer's
--   sendMail resolving means the provider accepted the message, not that anyone
--   received it. A typo'd manufacturer contact meant the PO was never delivered
--   while the desk believed it had been. That is a business risk, not a
--   technical one, and it is the reason for the Gmail → SES migration rather
--   than a side benefit of it.
--
-- WHY A SEPARATE TABLE, not a flag on entity_emails
--   resolveRecipients() merges the entity_emails rows with a `primaryEmail`
--   taken from details_mfg.email — an address that has no entity_emails row at
--   all. A column there could not suppress it, and that is the address most
--   likely to be stale. One address can also serve several entities (a shared
--   accounts@ inbox), and it should be suppressed once, not per row.
--
-- ONLY PERMANENT FAILURES SUPPRESS
--   The webhook writes a row for bounceType='Permanent' and for complaints. A
--   transient bounce (mailbox full, greylisting) deliberately does NOT, because
--   permanently disabling a manufacturer's only contact address over a full
--   inbox is worse than the retry it replaces.
--
-- REVERSIBLE
--   Suppression is advisory, not a hard block: a row can be deleted to
--   re-enable an address once the recipient has fixed their mailbox. That is
--   why there is no ON DELETE CASCADE anywhere pointing at this — it is a
--   standalone list, not a relationship.
--
-- MySQL 8.0: no ADD COLUMN / CREATE TABLE IF NOT EXISTS idempotency games
-- beyond the one below. Run once per schema (test and prod).

CREATE TABLE IF NOT EXISTS email_suppressions (
  id              INT AUTO_INCREMENT PRIMARY KEY,

  -- Stored lowercased by the webhook. The UNIQUE index is what makes the
  -- webhook idempotent under SNS's at-least-once delivery, so the casing has to
  -- be normalised on the way in or the same address arrives twice in two cases.
  email           VARCHAR(255) NOT NULL,

  reason          ENUM('bounce','complaint','manual') NOT NULL,

  -- SES's own sub-classification: bounceSubType (e.g. 'General',
  -- 'NoEmail', 'Suppressed') or complaintFeedbackType ('abuse', 'fraud', …).
  -- Kept verbatim so the admin screen can explain WHY an address was dropped
  -- rather than just that it was.
  detail          VARCHAR(500) NULL,

  -- The SES message that triggered it, for tracing a suppression back to the
  -- exact send in CloudWatch.
  ses_message_id  VARCHAR(255) NULL,

  suppressed_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uq_email_suppression (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
